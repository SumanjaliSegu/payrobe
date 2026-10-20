'use strict';
// Blind evaluation must not tell the attack designer which app it is attacking or whether that app is meant
// to be correct: the prompt carries a neutral label, comment-free source (line numbers unchanged), no
// deterministic findings and no known-scenario list. Non-blind prompts are unchanged.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { proposeAndRunAttacks, BLIND_APP_LABEL } = require('../harness/ai/attack-loop');
const { freezeFor } = require('../harness/ai/pipeline');
const { loadSources, redactComments, redactSources } = require('../harness/ai/evidence');
const { createMockClient } = require('../harness/ai/llm');
const { startAttackTarget } = require('./helpers');

const APPS = ['reference', 'unseen2', 'unseen', 'vulnerable'];
const FILES = ['app.js', 'schema.sql'];
const SKUS = ['STICKER', 'TSHIRT', 'HOODIE'];
const SCENARIOS = ['cross-order-checkout-signature', 'captured-amount-mismatch', 'late-failed-attempt', 'duplicate-capture', 'cumulative-refund-over-capture'];
// Words that would label an app's role or point at an answer key.
const ROLE_WORDS = /vulnerab|seeded|SEEDED_BUGS|answer key|has-bugs|believe is correct|intended to behave|what is wrong|defect|false-positive|autonomous discovery/i;

const plan = (over = {}) => ({
  title: 'forged unsigned capture', targets: ['I1'], rationale: 'a forged unsigned capture that a correct app rejects',
  orders: [{ ref: 'o1', sku: 'TSHIRT', quantity: 1 }], payments: [{ ref: 'p1' }],
  steps: [{ action: 'create_order', order: 'o1' }, { action: 'deliver_webhook', authenticity: 'forged', signing: 'unsigned', event: 'payment.captured', payment: 'p1', order: 'o1', amount: 'order' }],
  ...over,
});
// First attempt fails validation (so the corrective prompt, which echoes the plan, is covered too).
const INVALID = plan({ orders: [{ ref: 'O1', sku: 'TSHIRT', quantity: 1 }] });

// Every comment line's text in the original source (what redaction must remove).
function commentTexts(sources) {
  const out = [];
  for (const [file, lines] of sources) {
    const marker = file.endsWith('.sql') ? '--' : '//';
    for (const l of lines) {
      const at = l.indexOf(marker);
      const text = at >= 0 ? l.slice(at + marker.length).trim() : '';
      if (text.length >= 12 && !/['"`]/.test(l.slice(0, at))) out.push(text);
    }
  }
  return out;
}

async function promptsFor(impl, { blind }) {
  const app = { id: impl, impl, sourceRoot: `merchant/${impl}` };
  const { frozen } = await freezeFor(app, () => startAttackTarget(impl));
  const sources = loadSources(app.sourceRoot, FILES);
  const findings = SCENARIOS.map((s) => ({ scenario: s, outcome: 'violation', targets: ['I5'], reproduced: 3 }));
  const prompts = [];
  const scripted = [INVALID, plan()];
  const llm = createMockClient({ responder: ({ system, user, callIndex }) => { prompts.push({ system, user }); return scripted[callIndex] ?? plan(); } });
  const r = await proposeAndRunAttacks({ llm, app, frozen, startTarget: () => startAttackTarget(impl), sources, findings, skus: SKUS, count: 1, repetitions: 1, maxAttemptsPerSlot: 2, blind });
  return { prompts, sources, r };
}

describe('blind attack prompts leak no target identity', () => {
  const blind = {};
  before(async () => { for (const impl of APPS) blind[impl] = await promptsFor(impl, { blind: true }); });

  it('both attempts were prompted, including the corrective retry that echoes the plan', () => {
    for (const impl of APPS) {
      assert.equal(blind[impl].prompts.length, 2, impl);
      assert.match(blind[impl].prompts[1].user, /YOUR PREVIOUS PROPOSAL \(for correction\)/, impl);
    }
  });

  it('app identity: every blind prompt uses the neutral label and never the app name', () => {
    for (const impl of APPS) {
      for (const { system, user } of blind[impl].prompts) {
        assert.match(user, new RegExp(`^App: ${BLIND_APP_LABEL}\\.`), impl);
        // Case-sensitive: SQL keywords such as REFERENCES are not app names.
        for (const name of APPS) assert.doesNotMatch(system + user, new RegExp(`\\b${name}\\b`), `${impl} prompt names "${name}"`);
      }
    }
  });

  it('vulnerability labels: no role or answer-key wording reaches a blind prompt', () => {
    for (const impl of APPS) for (const { system, user } of blind[impl].prompts) assert.doesNotMatch(system + user, ROLE_WORDS, impl);
  });

  it('seeded findings and known scenario names: none in a blind prompt', () => {
    for (const impl of APPS) {
      for (const { system, user } of blind[impl].prompts) {
        for (const s of SCENARIOS) assert.ok(!(system + user).includes(s), `${impl} prompt names scenario ${s}`);
        assert.match(user, /KNOWN DETERMINISTIC FINDINGS so far:\n\[\]/, impl);
        assert.match(system, /known baseline scenarios: none\./, impl);
      }
    }
  });

  it('target-specific comments: no source comment survives, and line numbers are unchanged', () => {
    for (const impl of APPS) {
      const { prompts, sources } = blind[impl];
      const comments = commentTexts(sources);
      assert.ok(comments.length > 0, `${impl} has comments to redact`);
      for (const { user } of prompts) {
        for (const c of comments) assert.ok(!user.includes(c), `${impl} prompt still contains comment "${c}"`);
        for (const [file, lines] of sources) assert.ok(user.includes(`=== ${file} (${lines.length} lines) ===`), `${impl} ${file} keeps its line count`);
        assert.match(user, /comments have been removed, line numbers are unchanged/);
      }
    }
  });

  it('the blind system prompt is identical for every app, so it cannot carry a per-app hint', () => {
    const systems = new Set(APPS.map((impl) => blind[impl].prompts[0].system));
    assert.equal(systems.size, 1);
  });

  it('non-blind prompts are unchanged: real app name, findings and original comments', async () => {
    const { prompts, sources } = await promptsFor('vulnerable', { blind: false });
    assert.match(prompts[0].user, /^App: vulnerable\./);
    assert.ok(prompts[0].user.includes('cumulative-refund-over-capture'), 'findings shown outside blind mode');
    assert.ok(prompts[0].user.includes(sources.get('app.js')[1]), 'original header comment shown outside blind mode');
    assert.doesNotMatch(prompts[0].user, /comments have been removed/);
  });
});

describe('comment redaction', () => {
  it('blanks // /* */ and -- comments but keeps strings that look like comments', () => {
    const js = [
      "const a = '//not a comment'; // gone",
      'const t = `x ${b /* gone */ + "/*"} //kept`;',
      '/* multi',
      '   line */ const c = express.raw({ type: \'*/*\' });',
      'const d = "it\\"s // kept";',
    ].join('\n');
    const out = redactComments(js, 'js').split('\n');
    assert.equal(out.length, 5, 'newlines preserved');
    assert.equal(out[0].trimEnd(), "const a = '//not a comment';");
    assert.equal(out[1], 'const t = `x ${b  + "/*"} //kept`;');
    assert.equal(out[2], '');
    assert.equal(out[3].trim(), "const c = express.raw({ type: '*/*' });");
    assert.equal(out[4], 'const d = "it\\"s // kept";');
    const sql = "price INTEGER, -- paise\nnote TEXT DEFAULT '--x' /* gone */";
    assert.deepEqual(redactComments(sql, 'sql').split('\n').map((l) => l.trimEnd()), ['price INTEGER,', "note TEXT DEFAULT '--x'"]);
  });

  it('every fixture keeps its line count, still compiles, and changes only comment lines', () => {
    for (const impl of APPS) {
      const sources = loadSources(`merchant/${impl}`, FILES);
      const redacted = redactSources(sources);
      for (const [file, lines] of sources) {
        const r = redacted.get(file);
        assert.equal(r.length, lines.length, `${impl}/${file}`);
        r.forEach((l, i) => { if (l !== lines[i]) assert.ok(lines[i].startsWith(l.trimEnd()) || l.trim() === '', `${impl}/${file}:${i + 1} code changed`); });
        if (file.endsWith('.js')) assert.doesNotThrow(() => new vm.Script(`(function (require, module, exports) {\n${r.join('\n')}\n})`), `${impl}/${file} compiles`);
      }
    }
  });
});
