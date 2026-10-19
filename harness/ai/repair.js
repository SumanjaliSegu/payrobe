'use strict';
// AI fix-and-verify. For one deterministically verified violation:
//   1. reproduce the failure on the ORIGINAL app (baseline, via the runner);
//   2. ask the model for a minimal, evidence-grounded patch (strict JSON: find/replace edits);
//   3. validate the patch statically (allowlisted file, unique anchors, size limits, no forbidden constructs,
//      signature-verification code untouched, still compiles);
//   4. apply it to a DISPOSABLE copy of the app under data/ai-repairs/ (git-ignored), never the original;
//   5. re-run the same attack plus every other approved scenario against the copy, in fresh isolated apps;
//   6. let the deterministic runner + invariant checker decide: fixed means the target scenario is now clean
//      in every repetition (its liveness preconditions included) and no other scenario regressed;
//   7. on failure, feed the real results back to the model for a limited number of further attempts.
// The original source tree is hashed before and after and the result is recorded.
//
// Limitation (documented in BUILT_WITH_AI.md): the validated patch runs in-process inside the isolated copy.
// Static validation blocks new requires/imports, process/global access, network, fs, timers, loops, eval and
// escape sequences, but it is not an OS-level sandbox.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { performance } = require('node:perf_hooks');
const { runScenario } = require('../runner');
const { validate, describe } = require('./schema');
const { quote, sourcesForPrompt } = require('./evidence');
const { classify } = require('./tools');
const { findingFacts, INVARIANTS_GLOSSARY } = require('./analyst');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORK_ROOT = path.join(REPO_ROOT, 'data', 'ai-repairs');

const LIMITS = { maxEdits: 3, maxFindLines: 30, maxReplaceLines: 40, maxAddedLines: 40, maxChangedChars: 4000 };

// Constructs a patch may not ADD (counted in replace vs. the code it replaces).
const FORBIDDEN = [
  ['require()', /\brequire\s*\(/g], ['import', /\bimport\b/g], ['process', /\bprocess\b/g],
  ['eval', /\beval\s*\(/g], ['Function constructor', /\bFunction\s*\(/g], ['globalThis/global', /\bglobal(This)?\b/g],
  ['network APIs', /\b(fetch|XMLHttpRequest|WebSocket)\b/g], ['loops', /\b(while|for)\s*\(|\bdo\s*\{/g],
  ['timers', /\b(setTimeout|setInterval|setImmediate|queueMicrotask)\b/g], ['async waits', /\bawait\b|\bPromise\b/g],
  ['prototype access', /__proto__|\bprototype\b|\bconstructor\b/g], ['Reflect/Proxy', /\b(Reflect|Proxy)\b/g],
  ['file system', /\bfs\b/g], ['module system', /\bmodule\b|\bexports\b/g], ['crypto', /\bcrypto\b/g],
  ['raw SQL exec', /\bdb\.exec\s*\(/g], ['destructive SQL', /\b(DROP|DELETE|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|TRUNCATE)\b/gi],
  ['escape sequences', /\\u\{?[0-9a-fA-F]|\\x[0-9a-fA-F]{2}/g], ['debugger', /\bdebugger\b/g],
];
// Security-critical code a patch must leave exactly as it is (signature verification, secrets, exports).
const PROTECTED = ['safeEqualHex', 'hmacHex', 'timingSafeEqual', 'x-razorpay-signature', 'webhookSecret', 'keySecret', 'module.exports'];

const count = (s, re) => (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)) ?? []).length;
const countStr = (s, t) => s.split(t).length - 1;
const lineCount = (s) => (s === '' ? 0 : s.split('\n').length);

// Finds `find` in `text` exactly once; falls back to a whitespace-tolerant line match (trimmed lines).
function locate(text, find) {
  const exact = countStr(text, find);
  if (exact === 1) { const i = text.indexOf(find); return { ok: true, start: i, end: i + find.length }; }
  if (exact > 1) return { ok: false, error: `anchor matches ${exact} places; it must be unique` };
  const lines = text.split('\n');
  const want = find.split('\n').map((l) => l.trim()).filter((l, i, a) => !(l === '' && (i === 0 || i === a.length - 1)));
  if (!want.length) return { ok: false, error: 'empty anchor' };
  const hits = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (want.every((w, j) => lines[i + j].trim() === w)) hits.push(i);
  }
  if (hits.length !== 1) return { ok: false, error: hits.length ? `anchor matches ${hits.length} places; it must be unique` : 'anchor text not found in the file' };
  const offsets = []; let o = 0;
  for (const l of lines) { offsets.push(o); o += l.length + 1; }
  const last = hits[0] + want.length - 1;
  return { ok: true, start: offsets[hits[0]], end: offsets[last] + lines[last].length };
}

// Static validation + application of a patch to file contents (never touches disk).
function validatePatch(files, edits, { allowedFiles }) {
  const errors = [];
  const next = new Map(files);
  let added = 0; let changed = 0;
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > LIMITS.maxEdits) errors.push(`between 1 and ${LIMITS.maxEdits} edits required`);
  for (const [i, e] of (edits ?? []).entries()) {
    const at = `edit ${i + 1}`;
    if (!allowedFiles.includes(e.file)) { errors.push(`${at}: file "${e.file}" is not editable (allowed: ${allowedFiles.join(', ')})`); continue; }
    if (typeof e.find !== 'string' || !e.find.trim() || typeof e.replace !== 'string') { errors.push(`${at}: find/replace must be strings and find non-empty`); continue; }
    if (lineCount(e.find) > LIMITS.maxFindLines) errors.push(`${at}: find spans more than ${LIMITS.maxFindLines} lines`);
    if (lineCount(e.replace) > LIMITS.maxReplaceLines) errors.push(`${at}: replace spans more than ${LIMITS.maxReplaceLines} lines`);
    for (const t of PROTECTED) if (e.find.includes(t) || e.replace.includes(t)) errors.push(`${at}: touches protected security code (${t})`);
    for (const [label, re] of FORBIDDEN) if (count(e.replace, re) > count(e.find, re)) errors.push(`${at}: adds a forbidden construct (${label})`);
    const text = next.get(e.file);
    const loc = locate(text, e.find);
    if (!loc.ok) { errors.push(`${at}: ${loc.error}`); continue; }
    const replaced = text.slice(loc.start, loc.end);
    next.set(e.file, text.slice(0, loc.start) + e.replace + text.slice(loc.end));
    added += Math.max(0, lineCount(e.replace) - lineCount(replaced));
    changed += replaced.length + e.replace.length;
  }
  if (added > LIMITS.maxAddedLines) errors.push(`patch adds ${added} lines (limit ${LIMITS.maxAddedLines})`);
  if (changed > LIMITS.maxChangedChars) errors.push(`patch changes ${changed} characters (limit ${LIMITS.maxChangedChars})`);
  for (const [f, text] of next) {
    if (text === files.get(f)) continue;
    for (const t of PROTECTED) if (countStr(text, t) !== countStr(files.get(f), t)) errors.push(`${f}: protected token "${t}" count changed`);
    try { new vm.Script(text, { filename: f }); } catch (err) { errors.push(`${f}: does not compile: ${err.message}`); }
  }
  if (!errors.length && [...next].every(([f, t]) => t === files.get(f))) errors.push('patch makes no change');
  return { ok: errors.length === 0, errors, files: next, stats: { linesAdded: added, charsChanged: changed } };
}

function hashTree(root) {
  const out = {};
  for (const name of fs.readdirSync(root).sort()) {
    const p = path.join(root, name);
    if (fs.statSync(p).isFile()) out[name] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

// Writes the patched app to a fresh directory under data/ai-repairs and loads it. Returns { module, dispose }.
function materialize(sourceRoot, patchedFiles, label) {
  fs.mkdirSync(WORK_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(WORK_ROOT, `${label}-`));
  for (const name of fs.readdirSync(sourceRoot)) {
    const p = path.join(sourceRoot, name);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(dir, name));
  }
  for (const [f, text] of patchedFiles) fs.writeFileSync(path.join(dir, f), text);
  const entry = path.join(dir, 'app.js');
  const mod = require(entry);
  return {
    dir,
    module: mod,
    dispose() {
      for (const k of Object.keys(require.cache)) if (k.startsWith(dir)) delete require.cache[k];
      if (process.env.PAYPROBE_KEEP_REPAIRS === '1') return { removed: false, kept: true };
      const real = fs.realpathSync(dir);
      if (!real.startsWith(fs.realpathSync(WORK_ROOT) + path.sep)) throw new Error('repair: refusing to remove a directory outside data/ai-repairs');
      fs.rmSync(real, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      return { removed: true, kept: false };
    },
  };
}

const CITATION = {
  type: 'object', required: ['file', 'start_line', 'end_line'],
  properties: { file: { type: 'string', maxLength: 120 }, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } },
};

function repairSchema(allowedFiles) {
  return {
    type: 'object', required: ['rationale', 'edits', 'expected_effect', 'evidence'],
    properties: {
      rationale: { type: 'string', minLength: 20, maxLength: 900 },
      edits: {
        type: 'array', minItems: 1, maxItems: LIMITS.maxEdits,
        items: {
          type: 'object', required: ['file', 'find', 'replace'],
          properties: { file: { type: 'string', enum: allowedFiles }, find: { type: 'string', minLength: 1, maxLength: 2000 }, replace: { type: 'string', maxLength: 2600 } },
        },
      },
      expected_effect: { type: 'string', minLength: 10, maxLength: 500 },
      evidence: { type: 'array', minItems: 1, maxItems: 4, items: CITATION },
    },
  };
}

function repairPrompt({ facts, analysis, sources, allowedFiles, history }) {
  const schema = repairSchema(allowedFiles);
  const system = [
    'You are PayProbe\'s repair agent. A deterministic harness verified the payment-integrity violation below on a local fixture app.',
    'Propose the SMALLEST patch to the merchant app that makes the violated invariant hold while keeping genuine payments working',
    '(a genuine capture must still mark the order paid and fulfil it exactly once; duplicates, refunds and checkout must keep working).',
    `Invariants: ${INVARIANTS_GLOSSARY}`,
    `Patch rules (enforced by a validator; violations are rejected): only edit ${allowedFiles.join(', ')}; each edit is {file, find, replace}`,
    'where find is EXACT existing text that occurs once (copy it from the numbered source WITHOUT the line-number prefix);',
    'do not touch signature verification, secrets or module.exports; do not add require/import, process, global, network, fs, crypto,',
    `timers, loops, await/Promise, eval, raw db.exec or destructive SQL; at most ${LIMITS.maxEdits} edits and ${LIMITS.maxAddedLines} added lines.`,
    `Respond with ONE JSON object: ${describe(schema)}. evidence cites the lines that justify the fix.`,
  ].join(' ');
  const user = [
    'VERIFIED FINDING (deterministic, authoritative):', JSON.stringify(facts, null, 1),
    analysis ? `\nAI ANALYST HYPOTHESIS (unverified): root cause: ${analysis.rootCause}` : '',
    '\nSOURCE:', sourcesForPrompt(sources),
    ...history.map((h) => `\nATTEMPT ${h.attempt} RESULT: ${h.feedback}`),
    history.length ? '\nPropose a DIFFERENT patch that addresses the reasons above.' : '',
  ].join('\n');
  return { system, user, schema };
}

async function runAll(scenarios, frozen, startTarget, repetitions) {
  const out = {};
  for (const s of scenarios) {
    const mode = s.modes[0];
    const records = await runScenario(s, { ...frozen, mode, repetitions, startTarget });
    const { outcome, summary } = classify(records, mode);
    out[s.id] = { outcome, reproduced: summary.reproduced, outcomes: summary.outcomes, violationKinds: summary.violationKinds, reasons: [...new Set(records.flatMap((r) => r.reasons ?? []))].slice(0, 4) };
  }
  return out;
}

async function repairAndVerify({
  llm, appId, sourceRoot, finding, analysis = null, scenarios, frozen, startOriginal, startPatched,
  sources, baselineOutcomes, maxAttempts = 3, repetitions = 3,
}) {
  const t0 = performance.now();
  const root = path.resolve(sourceRoot);
  const target = scenarios.find((s) => s.id === finding.scenario);
  if (!target) throw new Error(`repair: scenario ${finding.scenario} is not in the approved catalogue`);
  const allowedFiles = [...sources.keys()].filter((f) => /\.js$/.test(f));
  const originalHashes = hashTree(root);
  const result = {
    target: { scenario: finding.scenario, invariants: finding.targets },
    baseline: null,
    attempts: [],
    verified: false,
    stopReason: null,
    acceptedPatch: null,
    original: { files: Object.keys(originalHashes).length, unchanged: null },
    limits: { maxAttempts, repetitions, ...LIMITS },
    durationMs: null,
  };
  try {
    // 1. Baseline: the failure must reproduce on the untouched app right now.
    const baseRecords = await runScenario(target, { ...frozen, mode: target.modes[0], repetitions, startTarget: startOriginal });
    const base = classify(baseRecords, target.modes[0]);
    result.baseline = { outcome: base.outcome, reproduced: base.summary.reproduced, violationKinds: base.summary.violationKinds };
    if (base.outcome !== 'violation') { result.stopReason = 'baseline_not_reproduced'; return result; }

    const facts = findingFacts(finding);
    const originalFiles = new Map([...sources].filter(([f]) => allowedFiles.includes(f)).map(([f, lines]) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
    const history = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const a = { attempt, callId: null, rationale: null, expectedEffect: null, edits: null, evidence: [], validation: null, results: null, regressions: [], fixed: false, verified: false, cleanup: null, error: null };
      result.attempts.push(a);
      const { system, user, schema } = repairPrompt({ facts, analysis, sources, allowedFiles, history });
      let res;
      try {
        res = await llm.chatJson({ purpose: `repair:attempt-${attempt}`, system, user, maxTokens: 3500, reasoningEffort: 'medium' });
      } catch (err) {
        a.callId = err.callId ?? null;
        a.error = `${err.code ?? 'error'}: ${err.message}`;
        result.stopReason = 'llm_error';
        break;
      }
      a.callId = res.callId;
      const shape = validate(res.json, schema);
      if (!shape.ok) {
        a.validation = { ok: false, stage: 'schema', errors: shape.errors.slice(0, 8) };
        history.push({ attempt, feedback: `rejected by schema validation: ${shape.errors.slice(0, 5).join('; ')}` });
        continue;
      }
      a.rationale = res.json.rationale;
      a.expectedEffect = res.json.expected_effect;
      a.edits = res.json.edits.map((e) => ({ file: e.file, find: e.find, replace: e.replace }));
      a.evidence = res.json.evidence.map((c) => { const q = quote(sources, c); return q.ok ? { file: q.file, startLine: q.startLine, endLine: q.endLine } : { invalid: q.error }; });
      const pv = validatePatch(originalFiles, a.edits, { allowedFiles });
      a.validation = { ok: pv.ok, stage: 'static', errors: pv.errors, stats: pv.stats };
      if (!pv.ok) {
        history.push({ attempt, feedback: `patch rejected before execution: ${pv.errors.slice(0, 5).join('; ')}` });
        continue;
      }
      // 4-6. Apply to a disposable copy and let the deterministic harness judge it.
      const changed = new Map([...pv.files].filter(([f, t]) => t !== originalFiles.get(f)));
      let copy;
      try {
        copy = materialize(root, changed, `${appId}-attempt${attempt}`);
        a.results = await runAll(scenarios, frozen, () => startPatched(copy.module), repetitions);
      } catch (err) {
        a.error = `patched app failed to load or run: ${err?.message ?? err}`;
        history.push({ attempt, feedback: a.error });
        continue;
      } finally {
        if (copy) { try { a.cleanup = copy.dispose(); } catch (err) { a.cleanup = { removed: false, error: String(err?.message ?? err) }; } }
      }
      const after = a.results[target.id];
      a.fixed = after.outcome === 'clean';
      for (const [id, r] of Object.entries(a.results)) {
        if (id === target.id) continue;
        const before = baselineOutcomes[id];
        if ((before === 'clean' && r.outcome !== 'clean') || (r.outcome === 'violation' && before !== 'violation')) a.regressions.push({ scenario: id, before: before ?? 'unknown', after: r.outcome, reasons: r.reasons });
      }
      a.verified = a.fixed && a.regressions.length === 0;
      if (a.verified) {
        result.verified = true;
        result.acceptedPatch = { attempt, edits: a.edits };
        result.stopReason = 'verified';
        break;
      }
      history.push({
        attempt,
        feedback: `patch applied and executed. Target ${target.id}: ${after.outcome} (${after.reproduced} reproduced, kinds ${JSON.stringify(after.violationKinds)}, reasons ${JSON.stringify(after.reasons)}).`
          + (a.regressions.length ? ` Regressions: ${JSON.stringify(a.regressions)}.` : ' No regressions.'),
      });
    }
    if (!result.stopReason) result.stopReason = 'attempts_exhausted';
    return result;
  } finally {
    const nowHashes = hashTree(root);
    result.original.unchanged = JSON.stringify(nowHashes) === JSON.stringify(originalHashes);
    result.durationMs = Math.round(performance.now() - t0);
  }
}

module.exports = { repairAndVerify, validatePatch, locate, hashTree, materialize, repairSchema, LIMITS, FORBIDDEN, PROTECTED, WORK_ROOT };
