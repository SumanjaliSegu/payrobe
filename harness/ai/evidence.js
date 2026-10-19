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

module.exports = { loadSources, numbered, quote, sourcesForPrompt };
