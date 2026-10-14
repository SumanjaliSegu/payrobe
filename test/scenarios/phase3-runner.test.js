'use strict';
// Phase 3 scenarios through harness/runner.js: each repetition is an isolated run (own file-backed
// database, ledger and app). Protocol: validate the hand-written v2 mapping on a separate validation run,
// freeze it, then run every attack with the frozen mapping and routes.
//
// Reference app: asserted. Preconditions hold, the outcome is clean (no I1-I5 violation, every target
// invariant checked something), and a scenario-specific liveness check passes.
// Vulnerable app: preconditions and cleanup are asserted so the experiment is meaningful; the outcome
// is RECORDED ONLY. No detection assertion is made until findings reproduce and are separately reviewed.
// Both apps receive the same request sequence; that is asserted too. Records go to results/ (git-ignored).
//
// The duplicate payment.captured experiment stays in duplicate-captured.test.js, unchanged and in-memory.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startAttackTarget } = require('../helpers');
const { validateMapping } = require('../../harness/validator');
const { runScenario, summarize, writeResults, freezeValidation, OUTCOME } = require('../../harness/runner');
const { checkoutSignature } = require('../../harness/mock-razorpay');
const { MOCK_KEY_SECRET } = require('../../merchant/config');

const ROOT = path.join(__dirname, '..', '..');
const IMPLS = ['reference', 'vulnerable'];
const REPETITIONS = 3;
const V2 = {
  reference: require('../../harness/mappings/v2/reference'),
  vulnerable: require('../../harness/mappings/v2/vulnerable'),
};
const SCENARIOS = [
  require('../../harness/scenarios/cross-order-checkout-signature'),
  require('../../harness/scenarios/captured-amount-mismatch'),
  require('../../harness/scenarios/late-failed-attempt'),
];

const orderIn = (snap, id) => snap.orders.find((o) => o.id === id);
const fulfilmentsOf = (snap, id) => snap.fulfillments.filter((f) => f.orderId === id);

// Reference-only liveness: the genuine path still works and the attacked state is what a correct app keeps.
const LIVENESS = {
  'cross-order-checkout-signature'(r) {
    const final = r.snapshots.at(-1);
    const { cheapOrder, targetOrder } = r.facts;
    assert.equal(orderIn(final, cheapOrder.orderId).isPaid, true, 'cheap order paid by its genuine capture');
    assert.equal(fulfilmentsOf(final, cheapOrder.orderId).length, 1);
    assert.equal(orderIn(final, targetOrder.orderId).isPaid, false, 'target order not paid by a signature for another order');
    assert.equal(fulfilmentsOf(final, targetOrder.orderId).length, 0);
    assert.equal(final.stock.HOODIE, r.snapshots[0].stock.HOODIE);
  },
  'captured-amount-mismatch'(r) {
    const final = r.snapshots.at(-1);
    const { controlOrder, targetOrder } = r.facts;
    assert.equal(orderIn(final, controlOrder.orderId).isPaid, true, 'control order paid');
    assert.equal(fulfilmentsOf(final, controlOrder.orderId).length, 1);
    assert.equal(orderIn(final, targetOrder.orderId).isPaid, false, 'mismatched capture does not pay the order');
    assert.equal(fulfilmentsOf(final, targetOrder.orderId).length, 0);
    assert.ok(final.payments.some((p) => p.id === r.facts.targetPaymentId), 'the mismatched payment is still recorded');
  },
  'late-failed-attempt'(r) {
    const final = r.snapshots.at(-1);
    const o = orderIn(final, r.facts.order.orderId);
    assert.equal(o.isPaid, true, 'order stays paid after a late failure of another attempt');
    assert.equal(o.paidPaymentId, r.facts.capturedPaymentId);
    assert.equal(fulfilmentsOf(final, o.id).length, 1);
    assert.equal(final.payments.find((p) => p.id === r.facts.capturedPaymentId).isCaptured, true);
  },
};

// What was sent, without run-specific ids: must be identical for both apps.
const requestShape = (r) => r.steps.map((s) => ({
  step: s.label,
  exchanges: s.exchanges.map((x) => ({
    route: x.route, method: x.method, kind: x.kind, genuine: x.genuine ?? null, signed: x.signed ?? null,
    event: x.event ? { type: x.event.type, amount: x.event.amount, currency: x.event.currency } : null,
    requestKeys: x.request ? Object.keys(x.request).sort() : null,
    request: x.request && 'sku' in x.request ? x.request : undefined,
  })),
}));

const frozen = {};
const records = {}; // scenario id -> all records

before(async () => {
  for (const impl of IMPLS) {
    const val = await startAttackTarget(impl, { role: 'validation' });
    try {
      const report = await validateMapping(V2[impl], {
        target: { baseUrl: val.baseUrl, db: val.reader, webhookSecret: val.webhookSecret, ledger: val.ledger, database: val.describe() },
        root: ROOT,
        denyFiles: ['docs/SEEDED_BUGS.md'],
      });
      frozen[impl] = freezeValidation(report);
    } finally {
      const c = await val.teardown();
      assert.equal(c.removed, true, `validation run not cleaned up: ${c.error}`);
    }
  }
});

for (const scenario of SCENARIOS) {
  describe(`runner scenario ${scenario.id}`, () => {
    const byImpl = {};
    for (const impl of IMPLS) {
      it(`${impl}: ${REPETITIONS} isolated runs`, async (t) => {
        const rs = await runScenario(scenario, {
          mode: 'sequential',
          repetitions: REPETITIONS,
          startTarget: () => startAttackTarget(impl),
          ...frozen[impl],
        });
        byImpl[impl] = rs;
        (records[scenario.id] ??= []).push(...rs);

        for (const r of rs) {
          const where = `${impl} run ${r.repetition}`;
          assert.equal(r.cleanup.ok, true, `${where}: cleanup failed: ${r.cleanup.error}`);
          assert.equal(r.countedAs, r.outcome);
          assert.deepEqual(r.freshness, { passed: true, problems: [] }, `${where}: freshness`);
          assert.deepEqual(r.initialState, { passed: true, failures: [] }, `${where}: initial state`);
          assert.notEqual(r.outcome, OUTCOME.ERROR, `${where}: ${JSON.stringify(r.error)}`);
          assert.deepEqual(r.preconditions.failures, [], `${where}: preconditions`);
          assert.equal(r.impl, impl);
          assert.deepEqual(r.contract, scenario.contract, 'contract labels are carried into every record');
          assert.equal(r.concurrency.status, 'not_applicable');
          if (impl === 'reference') {
            assert.equal(r.outcome, OUTCOME.CLEAN, `${where}: ${JSON.stringify(r.reasons)}`);
            for (const id of scenario.targets) {
              const v = r.verdicts.find((x) => x.id === id);
              assert.ok(v.checked > 0 && !v.vacuous, `${where}: ${id} must check something`);
            }
            LIVENESS[scenario.id](r);
          }
        }
        if (impl === 'vulnerable') {
          // Observation only: no detection assertion until findings reproduce and are reviewed.
          const s = summarize(rs)[0];
          t.diagnostic(`observed: counted ${JSON.stringify(s.outcomes)}, reproduced ${s.reproduced}, target violated but inconclusive ${s.targetViolatedButInconclusive}, kinds ${JSON.stringify(s.violationKinds)}`);
        }
      });
    }

    it('both apps received the same request sequence', () => {
      assert.ok(byImpl.reference && byImpl.vulnerable, 'both apps must have run');
      const ref = requestShape(byImpl.reference[0]);
      for (const r of [...byImpl.reference, ...byImpl.vulnerable]) assert.deepEqual(requestShape(r), ref, `${r.impl} run ${r.repetition}`);
    });

    if (scenario.id === 'cross-order-checkout-signature') {
      it('no raw checkout signature is written; the masked value can be recomputed from the record', () => {
        for (const r of [...byImpl.reference, ...byImpl.vulnerable]) {
          const raw = checkoutSignature(r.facts.cheapOrder.gatewayOrderId, r.facts.paymentId, MOCK_KEY_SECRET);
          assert.ok(!JSON.stringify(r).includes(raw), `${r.impl} run ${r.repetition}`);
          assert.equal(r.derivedSignatures.length, 1);
          const sent = r.steps.flatMap((s) => s.exchanges).filter((x) => x.route === 'verify').map((x) => x.request.razorpay_signature);
          assert.deepEqual(sent, [r.derivedSignatures[0].masked, r.derivedSignatures[0].masked]);
        }
      });

      it('the checkout callback route is recorded as unconfirmed, though requests reached it', () => {
        for (const r of [...byImpl.reference, ...byImpl.vulnerable]) {
          assert.equal(r.routes.verify.validation, 'cannot_verify');
          const verifyCalls = r.steps.flatMap((s) => s.exchanges).filter((x) => x.route === 'verify');
          assert.equal(verifyCalls.length, 2);
          assert.ok(verifyCalls.every((x) => x.routeValidation === 'cannot_verify'));
        }
      });
    }
    if (scenario.id === 'captured-amount-mismatch') {
      it('every record keeps the [U] contract label', () => {
        for (const r of [...byImpl.reference, ...byImpl.vulnerable]) {
          assert.ok(r.contract.some((c) => c.status === 'U'));
          assert.ok(r.conditionalOn.some((c) => c.startsWith('[U]')));
        }
      });
    }
  });
}

after(() => {
  for (const scenario of SCENARIOS) {
    const rs = records[scenario.id];
    if (!rs?.length) continue;
    const summary = summarize(rs);
    const file = writeResults(scenario.id, { summary, records: rs });
    console.log(`[runner] ${scenario.id}: results written to ${path.relative(process.cwd(), file)}`);
    for (const s of summary) {
      console.log(`[runner] ${s.scenario} ${s.impl}/${s.mode}: counted ${JSON.stringify(s.outcomes)}, reproduced ${s.reproduced}, target violated but inconclusive ${s.targetViolatedButInconclusive}, kinds ${JSON.stringify(s.violationKinds)}${s.conditionalOn.length ? `, conditional on ${s.conditionalOn.length} assumption(s)` : ''}`);
    }
  }
});
