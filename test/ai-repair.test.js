'use strict';
// AI fix-and-verify (harness/ai/repair.js) with mocked model responses and REAL deterministic verification:
// every patch is applied to a disposable copy under data/ai-repairs and judged by the runner + invariant
// checker against fresh isolated apps. The original merchant/unseen tree must be byte-identical afterwards.
// The "good" patch below is test data written by hand to exercise the success path; the real repair comes
// from the model (see BUILT_WITH_AI.md for the recorded Groq run).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repairAndVerify, hashTree, WORK_ROOT } = require('../harness/ai/repair');
const { runAiInvestigation, freezeFor } = require('../harness/ai/pipeline');
const { loadSources } = require('../harness/ai/evidence');
const { createMockClient } = require('../harness/ai/llm');
const { startAttackTarget } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const SCENARIOS = ['cross-order-checkout-signature', 'captured-amount-mismatch', 'late-failed-attempt', 'duplicate-capture', 'cumulative-refund-over-capture']
  .map((s) => require(`../harness/scenarios/${s}`));
const unseen = { id: 'unseen', impl: 'unseen', sourceRoot: path.join(ROOT, 'merchant', 'unseen') };
const unseen2 = { id: 'unseen2', impl: 'unseen2', sourceRoot: path.join(ROOT, 'merchant', 'unseen2') };
const FINDING = {
  scenario: 'late-failed-attempt', outcome: 'violation', targets: ['I4'], reproduced: '3/3', mode: 'sequential',
  violationKinds: { I3: ['fulfilled_order_not_paid'], I4: ['paid_order_reversed'] }, conditionalOn: [],
  evidence: { firstRun: { steps: ['create order', 'deliver capture of the second attempt', 'deliver late failure of the first attempt'] } }, records: [],
};
const BASELINE = { 'cross-order-checkout-signature': 'clean', 'captured-amount-mismatch': 'clean', 'late-failed-attempt': 'violation', 'duplicate-capture': 'clean', 'cumulative-refund-over-capture': 'inconclusive' };

const RESET = "q.setState.run('open', p.order_id);";
const patch = (find, replace) => ({ rationale: 'Guard the reopen so a late failure cannot reverse a settled basket.', edits: [{ file: 'app.js', find, replace }], expected_effect: 'Settled baskets stay settled.', evidence: [{ file: 'app.js', start_line: 1, end_line: 2 }] });
const GOOD = patch(RESET, "const basket = q.basketByGw.get(p.order_id);\n    if (!basket || basket.state !== 'settled') q.setState.run('open', p.order_id);");
const NOOP = patch("'use strict';", "'use strict';\n// comment only");
const UNSAFE = patch(RESET, `${RESET}\n    require('child_process');`);

let frozen; let sources; let frozen2; let before0;
const leftoverRepairs = () => (fs.existsSync(WORK_ROOT) ? fs.readdirSync(WORK_ROOT) : []);
before(async () => {
  frozen = (await freezeFor(unseen, () => startAttackTarget('unseen'))).frozen;
  frozen2 = (await freezeFor(unseen2, () => startAttackTarget('unseen2'))).frozen;
  sources = loadSources(unseen.sourceRoot, ['app.js', 'schema.sql']);
  before0 = leftoverRepairs();
});
after(() => {
  assert.deepEqual(leftoverRepairs(), before0, 'every disposable copy was removed');
});

const repair = (llm, over = {}) => repairAndVerify({
  llm, appId: 'unseen', sourceRoot: unseen.sourceRoot, finding: FINDING, scenarios: SCENARIOS, frozen,
  startOriginal: () => startAttackTarget('unseen'), startPatched: (m) => startAttackTarget('unseen', { appModule: m }),
  sources, baselineOutcomes: BASELINE, maxAttempts: 2, repetitions: 1, ...over,
});

describe('ai repair: fix and verify', () => {
  it('a correct patch is verified by the deterministic re-run; the original app is untouched', async () => {
    const hashes = hashTree(unseen.sourceRoot);
    const r = await repair(createMockClient({ responder: () => GOOD }));
    assert.equal(r.baseline.outcome, 'violation', 'the failure reproduced on the original first');
    assert.equal(r.verified, true);
    assert.equal(r.stopReason, 'verified');
    assert.equal(r.attempts.length, 1);
    const a = r.attempts[0];
    assert.equal(a.validation.ok, true);
    assert.equal(a.results['late-failed-attempt'].outcome, 'clean');
    assert.deepEqual(a.regressions, []);
    assert.equal(a.cleanup.removed, true);
    assert.equal(r.original.unchanged, true);
    assert.deepEqual(hashTree(unseen.sourceRoot), hashes);
  });

  it('an ineffective patch is executed, judged not fixed, and reported honestly after the attempt budget', async () => {
    const r = await repair(createMockClient({ responder: () => NOOP }));
    assert.equal(r.verified, false);
    assert.equal(r.stopReason, 'attempts_exhausted');
    assert.equal(r.attempts.length, 2);
    for (const a of r.attempts) {
      assert.equal(a.validation.ok, true);
      assert.equal(a.fixed, false);
      assert.equal(a.results['late-failed-attempt'].outcome, 'violation');
    }
    assert.equal(r.acceptedPatch, null);
    assert.equal(r.original.unchanged, true);
  });

  it('an unsafe patch is rejected before execution; the agent sees why and its next patch is verified', async () => {
    const prompts = [];
    const r = await repair(createMockClient({ responder: ({ callIndex, user }) => { prompts.push(user); return callIndex === 0 ? UNSAFE : GOOD; } }));
    assert.equal(r.attempts[0].validation.ok, false);
    assert.equal(r.attempts[0].results, null, 'nothing ran for the rejected patch');
    assert.match(r.attempts[0].validation.errors.join(), /forbidden construct \(require\(\)\)/);
    assert.match(prompts[1], /ATTEMPT 1 RESULT: patch rejected before execution/);
    assert.equal(r.verified, true);
    assert.equal(r.acceptedPatch.attempt, 2);
  });

  it('a patch that breaks genuine payments is not counted as a fix (liveness preconditions)', async () => {
    // Ignoring every capture "removes" the reversal but breaks payment: the target becomes inconclusive, not clean.
    const breaker = patch("'payment.captured': (pl) => onCaptured(pl.payment.entity),", "'payment.captured': (pl) => upsertCharge(pl.payment.entity, 'captured'),");
    const r = await repair(createMockClient({ responder: () => breaker }), { maxAttempts: 1 });
    assert.equal(r.attempts[0].validation.ok, true);
    assert.notEqual(r.attempts[0].results['late-failed-attempt'].outcome, 'clean');
    assert.equal(r.verified, false);
  });

  it('stops honestly when the failure does not reproduce on the original', async () => {
    const llm = createMockClient({ responder: () => { throw new Error('the model must not be called'); } });
    const r = await repairAndVerify({
      llm, appId: 'unseen2', sourceRoot: unseen2.sourceRoot, finding: FINDING, scenarios: SCENARIOS, frozen: frozen2,
      startOriginal: () => startAttackTarget('unseen2'), startPatched: (m) => startAttackTarget('unseen2', { appModule: m }),
      sources: loadSources(unseen2.sourceRoot, ['app.js']), baselineOutcomes: {}, repetitions: 1,
    });
    assert.equal(r.stopReason, 'baseline_not_reproduced');
    assert.equal(r.attempts.length, 0);
    assert.equal(llm.trace.length, 0);
  });
});

describe('ai pipeline (mock model, end to end)', () => {
  it('produces a report whose verdicts are deterministic, with a labelled mock AI section', async () => {
    const llm = createMockClient({
      model: 'mock',
      responder: ({ purpose }) => {
        if (purpose.startsWith('analyze:')) return { what_happened: 'MOCK analysis text for testing only.', impact: 'MOCK impact text for testing only.', root_cause: 'MOCK root cause text for testing only.', evidence: [{ file: 'app.js', start_line: 1, end_line: 1, why: 'mock' }], uncertainty: 'mock uncertainty', confidence: 'low', remediation: 'MOCK remediation text for testing.' };
        if (purpose.startsWith('agent:')) return { thought: 'Finish now.', action: { tool: 'finish', args: { summary: 'mock summary text', hypotheses: [{ statement: 'mock hypothesis text', status: 'supported', evidence_refs: [] }] } } };
        return GOOD;
      },
    });
    const report = await runAiInvestigation({
      app: unseen, scenarios: SCENARIOS, llm, repetitions: 1,
      startTarget: () => startAttackTarget('unseen'), startPatched: (m) => startAttackTarget('unseen', { appModule: m }),
    });
    const lfa = report.findings.find((f) => f.scenario === 'late-failed-attempt');
    assert.equal(lfa.outcome, 'violation', 'deterministic verdict unchanged by the AI stages');
    assert.equal(report.ai.mode, 'mock');
    assert.equal(report.ai.status, 'completed');
    assert.equal(report.ai.analyses[0].status, 'accepted');
    assert.equal(report.ai.agent.conclusion.hypotheses[0].status, 'unresolved', 'no execution evidence → downgraded');
    assert.equal(report.ai.repair.verified, true);
    assert.equal(report.ai.repair.original.unchanged, true);
    assert.equal(report.ai.totals.calls, report.ai.calls.length);
    assert.ok(!JSON.stringify(report).includes(ROOT), 'local paths are redacted');
  });
});
