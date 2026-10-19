'use strict';
// Guardrails of the AI layer, with mocked model responses: strict schemas, approved evidence only, analyst
// separation from verdicts, tool permissions and budgets, adaptive agent decisions driven by REAL tool results
// (scenario runs execute against isolated fixture apps), hypothesis downgrading, and static patch validation.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validate } = require('../harness/ai/schema');
const { loadSources, quote } = require('../harness/ai/evidence');
const { analyzeFinding } = require('../harness/ai/analyst');
const { createToolbox } = require('../harness/ai/tools');
const { runAgent } = require('../harness/ai/agent');
const { validatePatch, locate } = require('../harness/ai/repair');
const { freezeFor } = require('../harness/ai/pipeline');
const { createMockClient } = require('../harness/ai/llm');
const { startAttackTarget } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const SCENARIOS = ['cross-order-checkout-signature', 'captured-amount-mismatch', 'late-failed-attempt', 'duplicate-capture', 'cumulative-refund-over-capture']
  .map((s) => require(`../harness/scenarios/${s}`));
const unseen = { id: 'unseen', impl: 'unseen', sourceRoot: path.join(ROOT, 'merchant', 'unseen') };
const unseen2 = { id: 'unseen2', impl: 'unseen2', sourceRoot: path.join(ROOT, 'merchant', 'unseen2') };
const APP_JS = fs.readFileSync(path.join(unseen.sourceRoot, 'app.js'), 'utf8');
const onFailedLine = APP_JS.split('\n').findIndex((l) => l.includes('function onFailed')) + 1;

// A verified finding in the shape the investigator produces (only the fields the AI layer reads).
const FINDING = {
  scenario: 'late-failed-attempt', outcome: 'violation', targets: ['I4'], reproduced: '3/3', mode: 'sequential',
  violationKinds: { I3: ['fulfilled_order_not_paid'], I4: ['paid_order_reversed'] },
  conditionalOn: [], evidence: { firstRun: { steps: ['create order', 'deliver capture of the second attempt', 'deliver late failure of the first attempt'] } },
  records: [{ title: 'late failure', verdicts: [{ id: 'I4', status: 'violation', violationKinds: ['paid_order_reversed'], violations: [{ kind: 'paid_order_reversed' }] }], reasons: [] }],
};
const goodAnalysis = (over = {}) => ({
  what_happened: 'A late payment.failed for an earlier attempt reopened a settled basket.',
  impact: 'Goods ship while the order is recorded as unpaid; revenue reconciliation breaks.',
  root_cause: 'onFailed resets the basket state to open without checking whether it is settled.',
  evidence: [{ file: 'app.js', start_line: onFailedLine, end_line: onFailedLine + 3, why: 'unconditional reset' }],
  uncertainty: 'Assumes both attempts share one gateway order.',
  confidence: 'high',
  remediation: 'Only reopen baskets that are not settled.',
  ...over,
});

describe('ai schema and evidence', () => {
  it('strict schemas reject unknown keys, wrong types, enums and lengths', () => {
    const s = { type: 'object', required: ['a'], properties: { a: { type: 'string', maxLength: 3, enum: ['x', 'yy'] } } };
    assert.equal(validate({ a: 'x' }, s).ok, true);
    assert.match(validate({ a: 'x', b: 1 }, s).errors.join(), /unexpected property "b"/);
    assert.match(validate({ a: 'zz' }, s).errors.join(), /must be one of/);
    assert.match(validate({}, s).errors.join(), /missing required/);
    assert.match(validate({ a: 3 }, s).errors.join(), /expected string/);
  });
  it('approved evidence: refuses traversal, answer keys, secrets and other file types; checks ranges', () => {
    assert.throws(() => loadSources(unseen.sourceRoot, ['../reference/app.js']), /refused path/);
    assert.throws(() => loadSources(ROOT, ['docs/SEEDED_BUGS.md']), /refused file/);
    assert.throws(() => loadSources(ROOT, ['.env']), /refused file/);
    assert.throws(() => loadSources(unseen.sourceRoot, [path.join(unseen.sourceRoot, 'app.js')]), /refused path/);
    const src = loadSources(unseen.sourceRoot, ['app.js', 'schema.sql']);
    assert.equal(quote(src, { file: 'app.js', start_line: 1, end_line: 2 }).ok, true);
    assert.match(quote(src, { file: 'app.js', start_line: 5, end_line: 99999 }).error, /invalid line range/);
    assert.match(quote(src, { file: 'nope.js', start_line: 1, end_line: 1 }).error, /unknown file/);
  });
});

describe('ai analyst', () => {
  const sources = loadSources(unseen.sourceRoot, ['app.js', 'schema.sql']);
  it('accepts a valid, grounded answer; excerpts come from the real file; verdict is copied, not taken from the model', async () => {
    const llm = createMockClient({ responder: () => goodAnalysis() });
    const r = await analyzeFinding({ llm, finding: FINDING, sources });
    assert.equal(r.status, 'accepted');
    assert.equal(r.kind, 'ai_hypothesis');
    assert.deepEqual(r.verified, { outcome: 'violation', targets: ['I4'], reproduced: '3/3', violationKinds: FINDING.violationKinds });
    assert.ok(r.analysis.evidence[0].excerpt.includes('function onFailed'));
  });
  it('an answer that tries to set a verdict (extra key) is rejected; the corrective retry is accepted', async () => {
    const llm = createMockClient({ responder: ({ callIndex, user }) => (callIndex === 0 ? goodAnalysis({ outcome: 'clean' }) : (assert.match(user, /REJECTED/), goodAnalysis())) });
    const r = await analyzeFinding({ llm, finding: FINDING, sources });
    assert.equal(r.status, 'accepted');
    assert.equal(r.attempts.length, 2);
    assert.match(r.attempts[0].errors.join(), /unexpected property "outcome"/);
    assert.equal(r.verified.outcome, 'violation');
  });
  it('invented evidence is rejected (unknown file / impossible lines) and reported honestly', async () => {
    const llm = createMockClient({ responder: () => goodAnalysis({ evidence: [{ file: 'payments.js', start_line: 1, end_line: 2, why: 'invented' }] }) });
    const r = await analyzeFinding({ llm, finding: FINDING, sources });
    assert.equal(r.status, 'rejected');
    assert.equal(r.analysis, null);
    assert.match(r.attempts.at(-1).errors.join(), /unknown file "payments.js"/);
  });
  it('model failure → status error, no analysis', async () => {
    const llm = createMockClient({ responder: () => 'not json' });
    const r = await analyzeFinding({ llm, finding: FINDING, sources });
    assert.equal(r.status, 'error');
  });
});

describe('ai tools and agent (real scenario execution, mocked model)', () => {
  let frozenUnseen; let frozenUnseen2;
  const sources = loadSources(unseen.sourceRoot, ['app.js', 'schema.sql']);
  before(async () => {
    frozenUnseen = (await freezeFor(unseen, () => startAttackTarget('unseen'))).frozen;
    frozenUnseen2 = (await freezeFor(unseen2, () => startAttackTarget('unseen2'))).frozen;
  });
  const box = (frozen, impl, limits) => createToolbox({ scenarios: SCENARIOS, frozen, startTarget: () => startAttackTarget(impl), sources, limits });

  it('tool permissions: unknown tools, unapproved scenarios, oversized arguments and out-of-range reads are refused', async () => {
    const t = box(frozenUnseen, 'unseen', { maxScenarioRuns: 1, maxRepetitions: 2 });
    assert.match((await t.execute('shell', { cmd: 'whoami' })).error, /unknown tool/);
    assert.match((await t.execute('run_scenario', { scenario: 'drop-tables', repetitions: 1 })).error, /must be one of/);
    assert.match((await t.execute('run_scenario', { scenario: 'late-failed-attempt', repetitions: 50 })).error, /above maximum/);
    assert.match((await t.execute('run_scenario', { scenario: 'late-failed-attempt', repetitions: 1, cmd: 'x' })).error, /unexpected property "cmd"/);
    assert.match((await t.execute('read_source', { file: '../../.env', start_line: 1, end_line: 2 })).error, /must be one of/);
    assert.match((await t.execute('read_source', { file: 'app.js', start_line: 1, end_line: 140 })).error, /longer than 80 lines/);
    assert.equal(t.used.scenarioRuns, 0, 'refused calls do not consume budget');
  });

  it('execution budget: the second run is refused once the budget is spent', async () => {
    const t = box(frozenUnseen, 'unseen', { maxScenarioRuns: 1 });
    const first = await t.execute('run_scenario', { scenario: 'late-failed-attempt', repetitions: 1 });
    assert.equal(first.ok, true);
    assert.equal(first.result.outcome, 'violation');
    assert.match((await t.execute('run_scenario', { scenario: 'late-failed-attempt', repetitions: 1 })).error, /budget exhausted/);
  });

  // The responder only decides from what the observation actually says, so the two apps lead to different
  // action sequences: that is the adaptivity under test.
  const adaptive = ({ user }) => {
    const ran = /action=run_scenario/.test(user);
    if (!ran) return { thought: 'Re-run the scenario under suspicion.', action: { tool: 'run_scenario', args: { scenario: 'late-failed-attempt', repetitions: 1 } } };
    if (/"outcome":"violation"/.test(user.split('HISTORY')[1] ?? '') && !/action=read_source/.test(user)) {
      return { thought: 'It reproduced; read the failure handler.', action: { tool: 'read_source', args: { file: 'app.js', start_line: onFailedLine, end_line: onFailedLine + 3 } } };
    }
    const violated = /"outcome":"violation"/.test(user.split('HISTORY')[1] ?? '');
    return { thought: 'Conclude.', action: { tool: 'finish', args: { summary: violated ? 'Late failure reopens settled baskets.' : 'Late failure is handled safely.', hypotheses: [{ statement: violated ? 'onFailed reopens a settled basket' : 'late failures do not reopen settled baskets', status: 'supported', evidence_refs: ['O1', `app.js:${onFailedLine}-${onFailedLine + 1}`] }] } } };
  };

  it('adaptive decisions: a reproduced violation leads to reading source; a clean result leads straight to finish', async () => {
    const a = await runAgent({ llm: createMockClient({ responder: adaptive }), appId: 'unseen', findings: [FINDING], toolbox: box(frozenUnseen, 'unseen'), sources });
    assert.deepEqual(a.steps.map((s) => s.tool), ['run_scenario', 'read_source', 'finish']);
    assert.equal(a.steps[0].observation.outcome, 'violation');
    assert.equal(a.stopReason, 'finished');
    assert.equal(a.conclusion.hypotheses[0].status, 'supported');
    assert.deepEqual(a.conclusion.hypotheses[0].evidence.map((e) => e.kind), ['execution', 'source']);

    const b = await runAgent({ llm: createMockClient({ responder: adaptive }), appId: 'unseen2', findings: [], toolbox: box(frozenUnseen2, 'unseen2'), sources });
    assert.deepEqual(b.steps.map((s) => s.tool), ['run_scenario', 'finish']);
    assert.equal(b.steps[0].observation.outcome, 'clean');
    assert.match(b.conclusion.summary, /handled safely/);
  });

  it('finish-only turn: when the step budget runs out, one extra turn may only conclude', async () => {
    const llm = createMockClient({ responder: ({ purpose }) => (purpose === 'agent:finish-only'
      ? { thought: 'Summarise.', action: { tool: 'finish', args: { summary: 'Reproduced the violation once.', hypotheses: [{ statement: 'late failure reopens settled basket', status: 'supported', evidence_refs: ['O1'] }] } } }
      : { thought: 'Run it.', action: { tool: 'run_scenario', args: { scenario: 'late-failed-attempt', repetitions: 1 } } }) });
    const a = await runAgent({ llm, appId: 'unseen', findings: [FINDING], toolbox: box(frozenUnseen, 'unseen', { maxScenarioRuns: 1 }), sources, maxSteps: 2 });
    assert.equal(a.stopReason, 'finished_at_budget');
    assert.match(a.steps[1].error, /budget exhausted/, 'the second run was refused by the budget');
    assert.equal(a.conclusion.hypotheses[0].status, 'supported');
    assert.equal(a.conclusion.hypotheses[0].evidence[0].kind, 'execution');
  });

  it('read_source clamps a range that runs past the end of the file', async () => {
    const t = box(frozenUnseen, 'unseen');
    const total = sources.get('app.js').length;
    const r = await t.execute('read_source', { file: 'app.js', start_line: total - 5, end_line: total + 30 });
    assert.equal(r.ok, true);
    assert.equal(r.result.lines, `${total - 5}-${total}`);
    assert.match(r.result.note, /clamped/);
  });

  it('a "supported" claim without execution evidence is sent back once, then downgraded; unknown refs are dropped', async () => {
    const llm = createMockClient({ responder: () => ({ thought: 'Done.', action: { tool: 'finish', args: { summary: 'Claim without running anything.', hypotheses: [{ statement: 'the app is fully secure', status: 'supported', evidence_refs: ['O9', 'app.js:1-2'] }] } } }) });
    const a = await runAgent({ llm, appId: 'unseen', findings: [FINDING], toolbox: box(frozenUnseen, 'unseen'), sources });
    assert.equal(a.steps[0].policy, 'evidence_gate', 'the first unevidenced finish is rejected by policy');
    assert.equal(llm.trace.length, 2);
    assert.equal(a.steps.length, 2);
    const h = a.conclusion.hypotheses[0];
    assert.equal(h.proposedStatus, 'supported');
    assert.equal(h.status, 'unresolved');
    assert.match(h.note, /no scenario-run evidence/);
    assert.deepEqual(h.droppedRefs, ['O9']);
  });

  it('limits: step budget, invalid-output cap and model errors stop the loop', async () => {
    const reader = createMockClient({ responder: () => ({ thought: 'Read again.', action: { tool: 'read_source', args: { file: 'app.js', start_line: 1, end_line: 2 } } }) });
    const a = await runAgent({ llm: reader, appId: 'unseen', findings: [], toolbox: box(frozenUnseen, 'unseen'), sources, maxSteps: 3 });
    assert.equal(a.stopReason, 'step_budget_exhausted');
    assert.equal(a.steps.length, 4, '3 budgeted steps + 1 finish-only turn');
    assert.equal(a.steps[3].finishOnly, true);
    assert.equal(a.steps[3].ok, false, 'a non-finish action in the finish-only turn is refused, not executed');
    assert.equal(a.budget.readsUsed, 3);
    const junk = createMockClient({ responder: () => ({ action: 'rm -rf /' }) });
    const b = await runAgent({ llm: junk, appId: 'unseen', findings: [], toolbox: box(frozenUnseen, 'unseen'), sources, maxInvalid: 2 });
    assert.equal(b.stopReason, 'invalid_output_limit');
    assert.equal(b.steps.length, 2);
    const down = createMockClient({ responder: () => { const { LlmError } = require('../harness/ai/llm'); return new LlmError('rate_limited', 'limited'); } });
    const c = await runAgent({ llm: down, appId: 'unseen', findings: [], toolbox: box(frozenUnseen, 'unseen'), sources });
    assert.equal(c.stopReason, 'llm_error');
  });
});

describe('ai patch validation (static, before anything runs)', () => {
  const files = new Map([['app.js', APP_JS]]);
  const opts = { allowedFiles: ['app.js'] };
  const reset = "    q.setState.run('open', p.order_id);";
  const guard = "    const basket = q.basketByGw.get(p.order_id);\n    if (!basket || basket.state !== 'settled') q.setState.run('open', p.order_id);";
  const check = (edits) => validatePatch(files, edits, opts);

  it('accepts a minimal guard and does not modify the input', () => {
    const r = check([{ file: 'app.js', find: reset, replace: guard }]);
    assert.equal(r.ok, true, r.errors.join());
    assert.notEqual(r.files.get('app.js'), APP_JS);
    assert.equal(files.get('app.js'), APP_JS);
  });
  for (const [name, replace] of [
    ['require', `${reset}\n    require('child_process').execSync('calc');`],
    ['process', `${reset}\n    process.exit(0);`],
    ['network', `${reset}\n    fetch('https://evil.example');`],
    ['loop', `${reset}\n    while (true) {}`],
    ['timer', `${reset}\n    setTimeout(() => {}, 1);`],
    ['eval', `${reset}\n    eval('1');`],
    ['destructive SQL', `${reset}\n    q.x = db.prepare('DELETE FROM baskets');`],
    ['escape sequence', `${reset}\n    const s = '\\u0072equire';`],
  ]) {
    it(`rejects a patch that adds ${name}`, () => {
      const r = check([{ file: 'app.js', find: reset, replace }]);
      assert.equal(r.ok, false);
      assert.match(r.errors.join(), /forbidden construct/);
    });
  }
  it('rejects edits to signature verification, other files, ambiguous or missing anchors, and code that does not compile', () => {
    assert.match(check([{ file: 'app.js', find: 'if (!safeEqualHex(hmacHex(webhookSecret, raw), req.get(\'x-razorpay-signature\'))) {', replace: 'if (false) {' }]).errors.join(), /protected security code/);
    assert.match(check([{ file: '../reference/app.js', find: 'x', replace: 'y' }]).errors.join(), /not editable/);
    assert.match(check([{ file: 'app.js', find: 'const ', replace: 'let ' }]).errors.join(), /must be unique/);
    assert.match(check([{ file: 'app.js', find: 'function doesNotExist() {}', replace: '' }]).errors.join(), /not found/);
    assert.match(check([{ file: 'app.js', find: reset, replace: '    q.setState.run(;' }]).errors.join(), /does not compile/);
    assert.match(check([]).errors.join(), /between 1 and 3 edits/);
  });
  it('tolerates indentation differences in the anchor but still requires a unique match', () => {
    assert.equal(locate(APP_JS, "q.setState.run('open', p.order_id);").ok, true);
    assert.equal(check([{ file: 'app.js', find: "q.setState.run('open', p.order_id);", replace: guard.trim() }]).ok, true);
  });
});
