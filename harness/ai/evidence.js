'use strict';
// Approved source evidence for the AI layer. Only files the deterministic validator already read for this app
// (report.validation.filesRead, relative to the app's source root) can be shown to the model, and every line
// range the model cites is checked here and quoted from the real file, so a citation can never point at
// invented code. Answer keys are denied outright.
const fs = require('node:fs');
const path = require('node:path');

const DENY = [/SEEDED_BUGS/i, /(^|[\\/])\.env/i, /node_modules/i];
const ALLOWED_EXT = /\.(js|sql)$/i;
const MAX_FILE_BYTES = 60_000;

// Loads the approved files. Rejects anything outside `root`, symlink escapes, denied names and other types.
function loadSources(root, files) {
  const base = fs.realpathSync(path.resolve(root));
  const sources = new Map();
  for (const rel of files) {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`evidence: refused path ${rel}`);
    if (DENY.some((re) => re.test(rel)) || !ALLOWED_EXT.test(rel)) throw new Error(`evidence: refused file ${rel}`);
    const real = fs.realpathSync(path.join(base, rel));
    if (real !== base && !real.startsWith(base + path.sep)) throw new Error(`evidence: ${rel} resolves outside the app root`);
    const text = fs.readFileSync(real, 'utf8');
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new Error(`evidence: ${rel} is too large`);
    sources.set(rel.split(path.sep).join('/'), text.split(/\r?\n/));
  }
  return sources;
}

function numbered(lines, start = 1, end = lines.length) {
  const out = [];
  for (let i = Math.max(1, start); i <= Math.min(end, lines.length); i++) out.push(`${String(i).padStart(4)}| ${lines[i - 1]}`);
  return out.join('\n');
}

// Checks a citation { file, start_line, end_line } and returns the real excerpt, or an error string.
function quote(sources, { file, start_line: start, end_line: end }, { maxLines = 40 } = {}) {
  const lines = sources.get(file);
  if (!lines) return { ok: false, error: `unknown file "${file}" (allowed: ${[...sources.keys()].join(', ')})` };
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > lines.length) return { ok: false, error: `invalid line range ${file}:${start}-${end} (file has ${lines.length} lines)` };
  if (end - start + 1 > maxLines) return { ok: false, error: `range ${file}:${start}-${end} is longer than ${maxLines} lines` };
  return { ok: true, file, startLine: start, endLine: end, excerpt: lines.slice(start - 1, end).join('\n') };
}

// Approved files as one numbered block for a prompt.
function sourcesForPrompt(sources) {
  return [...sources.entries()].map(([f, lines]) => `=== ${f} (${lines.length} lines) ===\n${numbered(lines)}`).join('\n\n');
}

// Blanks every comment in .js or .sql text, keeping code, string literals and every newline, so line numbers
// are unchanged. Used for blind evaluation, where a fixture's comments may say whether it is meant to be
// correct. JS regex literals are not recognised; the tests check the redacted fixtures still compile.
function redactComments(text, kind) {
  const js = kind === 'js';
  const stack = []; // JS template nesting: '`' while in template text, '{' for each brace inside ${...}
  let quote = null;
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (stack[stack.length - 1] === '`') {
      if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
      if (c === '`') stack.pop();
      else if (c === '$' && n === '{') { stack.push('{'); out += '${'; i += 2; continue; }
      out += c; i++; continue;
    }
    if (quote) {
      if (js && c === '\\') { out += c + (n ?? ''); i += 2; continue; }
      if (c === quote) quote = null;
      out += c; i++; continue;
    }
    if ((js && c === '/' && n === '/') || (!js && c === '-' && n === '-')) {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, '');
      i = stop; continue;
    }
    if (c === '\'' || c === '"') quote = c;
    else if (js && c === '`') stack.push('`');
    else if (js && c === '{' && stack.length) stack.push('{');
    else if (js && c === '}' && stack[stack.length - 1] === '{') stack.pop();
    out += c; i++;
  }
  return out;
}

// A copy of loaded sources with comments blanked (see redactComments); line counts are preserved.
function redactSources(sources) {
  const out = new Map();
  for (const [file, lines] of sources) {
    const kind = /\.sql$/i.test(file) ? 'sql' : 'js';
    const redacted = redactComments(lines.join('\n'), kind).split('\n');
    out.set(file, redacted.map((l, i) => (l === lines[i] ? l : l.trimEnd())));
  }
  return out;
}

module.exports = { loadSources, numbered, quote, sourcesForPrompt, redactComments, redactSources };
