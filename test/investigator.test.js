'use strict';
// End-to-end tests for the autonomous investigator (harness/investigator.js).
//
// Honesty of the evaluation: the investigator is given only { id, impl, sourceRoot } and the scenario
// catalogue. It is never told what is wrong with any app. The UNSEEN app (merchant/unseen) is an
// independently-structured fixture; its one expected finding (a late payment.failed reversing a settled
// basket → I4) is asserted ONLY here, in the test, and is never provided to the investigator. Reproducing
// scenarios on the known vulnerable fixture is deliberately NOT used as the discovery measure.
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startAttackTarget } = require('./helpers');
const { investigate, writeReport } = require('../harness/investigator');
const { requireStock } = require('../harness/runner');

const scratch = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); scratch.push(d); return d; };
after(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

const SCENARIOS = ['cross-order-checkout-signature', 'captured-amount-mismatch', 'late-failed-attempt']
  .map((s) => require(`../harness/scenarios/${s}`));
const findingOf = (r, id) => r.findings.find((f) => f.scenario === id);

const run = (impl, extra = {}) => investigate({
  app: { id: impl, impl, sourceRoot: `merchant/${impl}` },
  startTarget: () => startAttackTarget(impl),
  scenarios: SCENARIOS,
  repetitions: 3,
  ...extra,
});

describe('investigator: clean control (reference app)', () => {
  it('discovers and validates from source, runs every scenario, finds no violation', async () => {
    const r = await run('reference');
    assert.equal(r.status, 'completed');
    assert.equal(r.validation.verdict, 'validated');
    assert.deepEqual(r.validation.contradicted, []);
    assert.deepEqual(r.validation.filesRead.sort(), ['app.js', 'schema.sql'], 'reads only files under the app source');
    assert.equal(r.scenariosRun, 3);
    for (const f of r.findings) {
      assert.equal(f.outcome, 'clean', `${f.scenario}: ${JSON.stringify(f.violationKinds)}`);
      assert.equal(f.reproducedCount, 0);
    }
    assert.ok(r.stages.map((s) => s.stage).includes('classify'));
    assert.ok(r.limitations.length >= 3);
  });
});

describe('investigator: genuine discovery on the unseen app', () => {
  it('finds the one planted flaw (I4) and reports zero false positives on the correct behaviours', async () => {
    const r = await run('unseen', { regressionDir: tmpDir('payprobe-reg-') });
    assert.equal(r.status, 'completed');
    // Discovery/validation worked on unfamiliar names, reading only the app's own source.
    assert.equal(r.validation.verdict, 'validated');
    assert.deepEqual(r.validation.contradicted, []);
    assert.deepEqual(r.validation.filesRead.sort(), ['app.js', 'schema.sql']);

    // The hidden expected finding (asserted only here): late failure reverses a settled basket → I4.
    const late = findingOf(r, 'late-failed-attempt');
    assert.equal(late.outcome, 'violation', JSON.stringify(late.violationKinds));
    assert.equal(late.reproducedCount, 3);
    assert.ok(late.targets.includes('I4'));
    assert.ok(late.violationKinds.I4?.includes('paid_order_reversed'));

    // No false positives on the two behaviours the unseen app handles correctly.
    assert.equal(findingOf(r, 'cross-order-checkout-signature').outcome, 'clean');
    assert.equal(findingOf(r, 'captured-amount-mismatch').outcome, 'clean');

    // A regression artifact was generated for the confirmed finding, outside test/.
    assert.equal(r.regressionArtifacts.length, 1);
    assert.equal(r.regressionArtifacts[0].scenario, 'late-failed-attempt');
    assert.ok(late.reproInstructions.length >= 3);
    assert.ok(late.evidence.ledgerIndependent);
  });
});

describe('investigator: second unseen app (independent naming) has no false positives', () => {
  // merchant/unseen2 is an independently-written, correctly-behaving app with its own vocabulary
  // (tickets/settlements/grants/credits/inventory; routes /v1/intents, /v1/pg-hook, /v1/charge-confirm).
  // Expectation, asserted only here: discovery validates from its source, and every scenario — including
  // the concurrency one — is clean. Two correct apps are not a generalization claim (D20).
  const allScenarios = [...SCENARIOS, require('../harness/scenarios/duplicate-capture')];
  it('validates the discovered mapping and reports zero violations across all scenarios', async () => {
    const r = await investigate({
      app: { id: 'unseen2', impl: 'unseen2', sourceRoot: 'merchant/unseen2' },
      startTarget: () => startAttackTarget('unseen2'),
      scenarios: allScenarios,
      repetitions: 3,
    });
    assert.equal(r.status, 'completed');
    assert.equal(r.validation.verdict, 'validated');
    assert.deepEqual(r.validation.contradicted, []);
    assert.deepEqual(r.validation.filesRead.sort(), ['app.js', 'schema.sql']);
    assert.equal(r.scenariosRun, 4);
    const violations = r.findings.filter((f) => f.outcome === 'violation');
    assert.deepEqual(violations, [], `unexpected violations: ${violations.map((f) => f.scenario)}`);
    // The concurrency scenario proved overlap and was still clean (correct atomic handler).
    const dup = findingOf(r, 'duplicate-capture');
    assert.equal(dup.concurrency, 'verified');
    assert.equal(dup.verifiedConcurrent, 3);
    assert.equal(dup.outcome, 'clean');
  });
});

describe('investigator: inconclusive finding', () => {
  // A scenario whose target invariant cannot be verified under a validated mapping (refunds are never
  // confirmed by the positive control, so I5 stays cannot_verify) must be reported inconclusive, not clean.
  const i5Scenario = {
    id: 'test-i5-inconclusive',
    title: 'normal purchase, targets I5 (not verifiable without a refund)',
    modes: ['sequential'],
    targets: ['I5'],
    contract: [],
    requires: ['orders.paidValues', 'payments.capturedValues'],
    initialState: (s) => requireStock(s, { TSHIRT: 1 }),
    async play(ctx) {
      const o = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT', quantity: 1 }));
      await ctx.step('genuine capture', () => ctx.webhook(ctx.genuine('payment.captured', { paymentId: ctx.newPaymentId(), orderId: o.gatewayOrderId, amount: o.amount })));
    },
  };

  it('classifies a cannot_verify target as inconclusive', async () => {
    const r = await investigate({
      app: { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' },
      startTarget: () => startAttackTarget('reference'),
      scenarios: [i5Scenario],
      repetitions: 2,
    });
    assert.equal(r.status, 'completed');
    const f = findingOf(r, 'test-i5-inconclusive');
    assert.equal(f.outcome, 'inconclusive');
    assert.equal(f.reproducedCount, 0);
    assert.equal(r.regressionArtifacts.length, 0, 'no regression artifact for a non-violation');
  });
});

describe('investigator: safe stop and selection', () => {
  it('stops safely when the mapping does not validate against the running app', async () => {
    // Discover from the unseen source (baskets/charges/...) but run it against the reference app
    // (orders/payments/...): the structure contradicts, so the mapping cannot validate and no attack runs.
    const r = await investigate({
      app: { id: 'mismatch', impl: 'reference', sourceRoot: 'merchant/unseen' },
      startTarget: () => startAttackTarget('reference'),
      scenarios: SCENARIOS,
      repetitions: 3,
    });
    assert.equal(r.status, 'stopped');
    assert.notEqual(r.validation.verdict, 'validated');
    assert.equal(r.scenariosRun, 0, 'no scenario is executed on an unvalidated mapping');
    assert.match(r.stopReason, /did not validate/);
  });

  it('skips a scenario whose required entries are not confirmed, with the unmet entries listed', async () => {
    const needsRefundConfirmed = { ...SCENARIOS[0], id: 'test-needs-refund', requires: ['refunds.columns.amount'] };
    const r = await investigate({
      app: { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' },
      startTarget: () => startAttackTarget('reference'),
      scenarios: [needsRefundConfirmed],
      repetitions: 2,
    });
    assert.equal(r.status, 'completed');
    const sel = r.selection.find((s) => s.scenario === 'test-needs-refund');
    assert.equal(sel.selected, false);
    assert.ok(sel.unmet.includes('refunds.columns.amount'));
    assert.equal(r.scenariosRun, 0);
  });
});

describe('investigator: concurrency scenario', () => {
  const dup = require('../harness/scenarios/duplicate-capture');
  const runDup = (impl) => investigate({
    app: { id: impl, impl, sourceRoot: `merchant/${impl}` },
    startTarget: () => startAttackTarget(impl),
    scenarios: [dup],
    repetitions: 3,
  });

  it('runs duplicate-capture in barrier mode with proven overlap; reference stays clean', async () => {
    const r = await runDup('reference');
    assert.equal(r.status, 'completed');
    const f = r.findings[0];
    assert.equal(f.mode, 'barrier');
    assert.equal(f.concurrency, 'verified');
    assert.equal(f.verifiedConcurrent, 3, 'every repetition proved overlap');
    assert.equal(f.outcome, 'clean');
    assert.ok(f.records.every((x) => x.cleanup.ok));
  });

  it('detects the vulnerable concurrent duplicate fulfilment (I3) only with verified overlap', async () => {
    const r = await runDup('vulnerable');
    const f = r.findings[0];
    assert.equal(f.outcome, 'violation');
    assert.equal(f.mode, 'barrier');
    assert.equal(f.concurrency, 'verified');
    assert.equal(f.verifiedConcurrent, 3);
    assert.equal(f.reproducedCount, 3);
    assert.ok(f.targets.includes('I3'));
    assert.ok(f.violationKinds.I3?.includes('duplicate_fulfilment'));
    // A violation finding implies all repetitions were verified-concurrent (overlap proven, not assumed).
    assert.ok(f.records.every((x) => x.concurrency.status === 'verified'));
    assert.ok(f.records.every((x) => x.cleanup.ok));
  });

  it('does not apply to the original in-memory baseline test, which stays unchanged', () => {
    // Guard: the baseline scenario test does not import the runner-driven module.
    const src = fs.readFileSync(path.join(__dirname, 'scenarios', 'duplicate-captured.test.js'), 'utf8');
    assert.ok(!src.includes("scenarios/duplicate-capture'"), 'baseline must not depend on the new module');
  });
});

describe('investigator: I6 under verified concurrency', () => {
  const dup = require('../harness/scenarios/duplicate-capture');
  const i6Of = (finding) => finding.records[0].verdicts.find((v) => v.id === 'I6');

  it('I6 is a violation (naming I3) on the vulnerable app under verified overlap', async () => {
    const r = await investigate({ app: { id: 'vulnerable', impl: 'vulnerable', sourceRoot: 'merchant/vulnerable' }, startTarget: () => startAttackTarget('vulnerable'), scenarios: [dup], repetitions: 2 });
    const f = r.findings[0];
    assert.equal(f.concurrency, 'verified');
    const i6 = i6Of(f);
    assert.equal(i6.status, 'violation');
    assert.equal(i6.violations[0].invariant, 'I3');
  });

  it('I6 is cannot_verify on a clean concurrent run (I5/refunds out of scope) and on sequential scenarios', async () => {
    const cr = await investigate({ app: { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' }, startTarget: () => startAttackTarget('reference'), scenarios: [dup], repetitions: 2 });
    const i6 = i6Of(cr.findings[0]);
    assert.equal(cr.findings[0].concurrency, 'verified');
    assert.equal(i6.status, 'cannot_verify', 'verified overlap but I5 cannot_verify ⇒ I6 cannot_verify');

    const seq = await investigate({ app: { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' }, startTarget: () => startAttackTarget('reference'), scenarios: [SCENARIOS[0]], repetitions: 1 });
    assert.equal(seq.findings[0].records[0].verdicts.find((v) => v.id === 'I6').status, 'cannot_verify');
  });
});

describe('investigator: cumulative refund over capture (I5)', () => {
  const refund = require('../harness/scenarios/cumulative-refund-over-capture');
  const i5Violated = (f) => f.records[0].verdicts.find((v) => v.id === 'I5').status === 'violation';
  const runRefund = (impl) => investigate({ app: { id: impl, impl, sourceRoot: `merchant/${impl}` }, startTarget: () => startAttackTarget(impl), scenarios: [refund], repetitions: 3 });

  // Controls: correct apps reject the second refund (409) and never report an I5 violation. `unseen` is
  // included after its cumulative-cap fix — this is the regression proving the second refund is rejected and
  // the recorded/ledger refund total cannot exceed the captured amount.
  for (const impl of ['reference', 'unseen', 'unseen2']) {
    it(`${impl}: correct cumulative cap → no I5 violation (control)`, async () => {
      const r = await runRefund(impl);
      const f = r.findings[0];
      assert.equal(f.outcome !== 'violation', true, `control must not be a violation: ${f.outcome}`);
      assert.equal(i5Violated(f), false);
      for (const run of f.records) {
        assert.equal(run.facts.refund1Status, 201, 'first within-cap refund accepted');
        assert.equal(run.facts.refund2Status, 409, 'second full refund rejected (cumulative cap enforced)');
        assert.equal(run.cleanup.ok, true);
        // Independent evidence: the gateway ledger shows at most the captured amount refunded.
        const pid = run.facts.paymentId;
        const captured = run.ledger.payments[pid].amount;
        const refundSum = run.ledger.refunds.filter((x) => x.status !== 'failed' && x.paymentId === pid).reduce((a, x) => a + x.amount, 0);
        assert.ok(refundSum <= captured, `ledger refund sum ${refundSum} must not exceed captured ${captured}`);
      }
    });
  }

  // Vulnerable: detection assertion approved after review of the independent gateway-ledger evidence
  // (both refunds accepted, ledger refund sum > captured, I5 gateway_refunds_exceed_captured, 3/3).
  // The [U]/[A] conditional labels are preserved; this is NOT a claim of proven real-world money loss.
  it('vulnerable: cumulative refunds exceed captured, proven by the independent ledger (3/3)', async () => {
    const r = await runRefund('vulnerable');
    const f = r.findings[0];
    assert.equal(f.outcome, 'violation');
    assert.equal(f.reproducedCount, 3);
    assert.ok(f.violationKinds.I5?.includes('gateway_refunds_exceed_captured'));
    // Conditional labels must remain: cumulative cap [U], mock accepts cumulative refunds [A].
    assert.ok(f.contract.some((c) => c.status === 'U'));
    assert.ok(f.contract.some((c) => c.status === 'A' && c.basis === 'mock-gateway'));
    assert.ok(f.conditionalOn.length >= 2);
    for (const run of f.records) {
      assert.equal(run.facts.refund1Status, 201);
      assert.equal(run.facts.refund2Status, 201);
      assert.equal(run.preconditions.failures.length, 0);
      assert.equal(run.cleanup.ok, true);
      // Evidence from the independent gateway ledger, not the merchant's own records.
      const pid = run.facts.paymentId;
      const captured = run.ledger.payments[pid].amount;
      const refundSum = run.ledger.refunds.filter((x) => x.status !== 'failed' && x.paymentId === pid).reduce((a, x) => a + x.amount, 0);
      assert.ok(refundSum > captured, `ledger refund sum ${refundSum} must exceed captured ${captured}`);
    }
  });
});

describe('investigator: report safety', () => {
  it('a written report contains no secrets or absolute local paths', async () => {
    const r = await run('unseen');
    const dir = tmpDir('payprobe-inv-');
    const file = writeReport(r, { dir });
    const text = fs.readFileSync(file, 'utf8');
    for (const needle of [os.homedir(), os.tmpdir(), process.cwd()]) {
      for (const v of [needle, needle.split(path.sep).join('/')]) assert.ok(!text.includes(v), `report leaks path ${v}`);
    }
    assert.ok(!/mock_key_secret_not_real|mock_webhook_secret_not_real/.test(text), 'report leaks a secret');
    assert.equal(JSON.parse(text).app.id, 'unseen');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
