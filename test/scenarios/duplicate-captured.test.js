'use strict';
// Phase 3, experiment 1: duplicate delivery of one genuine payment.captured webhook.
//
// Matrix: {reference, vulnerable} x {sequential, simultaneous, barrier} x 3 fresh runs.
// 'barrier' holds both requests inside the server (arrived, body incomplete) and releases
// them together; only runs where the server confirms both were in flight count as concurrent.
// Every run starts a new app, in-memory DB and ledger. The same body bytes, event id
// and signature are delivered twice. State is judged only through the mapping,
// snapshots, ledger and invariant checker.
//
// Reference: asserted to have no violations. Vulnerable: observed and recorded only;
// no outcome is assumed. Structured records go to results/ (git-ignored).
const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startMerchant, postJson } = require('../helpers');
const { createLedger } = require('../../harness/ledger');
const { takeSnapshot } = require('../../harness/snapshot');
const { checkAll, STATUS } = require('../../harness/invariants');
const { genuinePaymentEvent, newPaymentId } = require('../../harness/mock-razorpay');
const { prepareDelivery, signatureMatches, deliverTwice, intervalsOverlap } = require('../../harness/delivery');

const SCENARIO = 'duplicate-captured';
const MAPPINGS = {
  reference: require('../../harness/mappings/reference'),
  vulnerable: require('../../harness/mappings/vulnerable'),
};
const IMPLS = ['reference', 'vulnerable'];
const MODES = ['sequential', 'simultaneous', 'barrier'];
const REPETITIONS = 3;
const SKU = 'TSHIRT';
const QUANTITY = 2;
const SIMULTANEOUS_INVARIANTS = ['I1', 'I2', 'I3', 'I4', 'I5'];

const LIMITATIONS = [
  'Harness and app share one Node process and event loop; scheduling differs from a deployed app behind a network.',
  'Server overlap is measured at the HTTP layer (arrival to response finish), not at individual statements inside the handler.',
  'A redelivery is modelled as the same x-razorpay-event-id, body and signature, per Razorpay webhook docs; not observed against real Razorpay.',
  'Gateway is the local mock; no Razorpay API or test-mode account was used.',
  'Two copies only; more copies or other timings are not explored.',
  'Barrier mode holds the last body byte, so both requests wait in the body parser; after release, ordering inside the handlers is left to the event loop and is not controlled.',
];

const runs = [];

function verdictSummary(results) {
  return results.map((r) => ({
    id: r.id,
    status: r.status,
    checked: r.checked,
    vacuous: Boolean(r.vacuous),
    violationKinds: r.violations.map((v) => v.kind),
    violations: r.violations,
    unverifiable: r.unverifiable,
  }));
}

async function runOnce(impl, mode, repetition) {
  const ledger = createLedger();
  const m = await startMerchant(impl, { ledger });
  try {
    const mapping = MAPPINGS[impl];
    const snapshots = [takeSnapshot(m.db, mapping, { label: 'initial' })];

    const orderRes = await postJson(m.baseUrl, '/api/orders', { sku: SKU, quantity: QUANTITY });
    assert.equal(orderRes.status, 201, `order creation failed: ${orderRes.text}`);
    const order = orderRes.json;
    snapshots.push(takeSnapshot(m.db, mapping, { label: 'order created' }));

    const paymentId = newPaymentId();
    const event = genuinePaymentEvent(ledger, 'payment.captured', {
      paymentId, orderId: order.razorpay_order_id, amount: order.amount,
    });
    const prepared = prepareDelivery(event, { secret: m.webhookSecret });

    const firstTrace = m.trace.length;
    const webhookTrace = () => m.trace.slice(firstTrace).filter((t) => t.url === '/webhooks/razorpay');
    const delivery = await deliverTwice(m.baseUrl, prepared, {
      mode,
      between: () => snapshots.push(takeSnapshot(m.db, mapping, { label: 'after first delivery' })),
      observe: () => {
        const w = webhookTrace();
        return { arrived: w.length, finished: w.filter((t) => t.finishedMs !== undefined).length };
      },
    });
    const final = takeSnapshot(m.db, mapping, { label: 'final' });
    snapshots.push(final);

    const server = webhookTrace();
    const serverOverlap = server.length === 2 && server.every((t) => t.finishedMs !== undefined)
      && intervalsOverlap({ start: server[0].arrivedMs, end: server[0].finishedMs }, { start: server[1].arrivedMs, end: server[1].finishedMs });
    let classification = 'sequential';
    if (mode === 'simultaneous') classification = serverOverlap ? 'concurrent' : 'simultaneous_but_not_overlapping';
    if (mode === 'barrier') {
      const b = delivery.barrier;
      const releasedBeforeFinish = server.every((t) => t.finishedMs > b.releasedAtMs);
      const verified = b.reached && b.arrivedAtRelease === 2 && b.finishedAtRelease === 0 && releasedBeforeFinish && serverOverlap;
      classification = verified ? 'concurrent' : 'barrier_not_verified';
    }

    const results = checkAll({ snapshots, ledger: ledger.view() });
    const fulfilments = final.fulfillments.filter((f) => f.orderId === order.order_id);
    const stockDelta = { sku: SKU, expectedDecrease: QUANTITY, observedDecrease: snapshots[0].stock[SKU] - final.stock[SKU] };

    return {
      scenario: SCENARIO,
      impl,
      mode,
      repetition,
      classification,
      initialSnapshot: snapshots[0],
      order: { request: { sku: SKU, quantity: QUANTITY }, status: orderRes.status, response: order },
      event: {
        type: 'payment.captured',
        paymentId,
        eventId: prepared.eventId,
        bodySha256: prepared.bodySha256,
        bodyBytes: prepared.body.length,
        signature: prepared.signature,
        harnessSignatureValid: signatureMatches(prepared, m.webhookSecret),
        identicalAcrossDeliveries: delivery.identical,
      },
      requests: delivery.requests.map((r) => ({
        ...r, appAcceptedSignature: r.status !== 400 && r.status !== 401 && r.status !== 403,
      })),
      timing: { clientOverlap: delivery.clientOverlap, serverOverlap, server, barrier: delivery.barrier },
      finalState: {
        order: final.orders.find((o) => o.id === order.order_id) ?? null,
        payments: final.payments.filter((p) => p.gatewayOrderId === order.razorpay_order_id),
        fulfilments,
        stock: { [SKU]: final.stock[SKU] },
      },
      fulfilmentCount: fulfilments.length,
      stockDelta,
      snapshotLabels: snapshots.map((s) => s.label),
      verdicts: verdictSummary(results),
      ledger: ledger.view(),
      limitations: LIMITATIONS,
    };
  } finally {
    await m.close();
  }
}

for (const impl of IMPLS) {
  for (const mode of MODES) {
    describe(`${SCENARIO}: ${impl}, ${mode}`, () => {
      for (let rep = 1; rep <= REPETITIONS; rep++) {
        it(`run ${rep}/${REPETITIONS}`, async (t) => {
          const record = await runOnce(impl, mode, rep);
          runs.push(record);

          // Preconditions of the experiment itself, for both apps.
          assert.equal(record.event.identicalAcrossDeliveries, true, 'deliveries were not byte-identical');
          assert.equal(record.event.harnessSignatureValid, true);
          assert.equal(record.requests.length, 2);
          assert.equal(record.ledger.payments[record.event.paymentId].history.length, 1, 'ledger must hold one genuine capture');
          assert.equal(Object.keys(record.ledger.payments).length, 1, 'ledger must hold exactly one payment');

          if (impl === 'reference') {
            const violated = record.verdicts.filter((v) => SIMULTANEOUS_INVARIANTS.includes(v.id) && v.status === STATUS.VIOLATION);
            assert.deepEqual(violated, [], 'reference app must not violate I1-I5');
            assert.equal(record.fulfilmentCount, 1);
            assert.equal(record.stockDelta.observedDecrease, QUANTITY);
          }
          // Barrier mode exists to make the reference concurrency claim meaningful: a run that did
          // not achieve verified overlap fails rather than passing as a concurrency result.
          if (impl === 'reference' && mode === 'barrier') {
            assert.equal(record.classification, 'concurrent',
              `barrier overlap not verified: ${JSON.stringify(record.timing.barrier)}`);
          }

          if (impl === 'reference' && mode === 'simultaneous' && record.classification !== 'concurrent') {
            t.diagnostic('requests did not overlap at the server: reference concurrency safety NOT exercised by this run');
          }

          // Regression, added only after observation: vulnerable + simultaneous reproduced duplicate
          // fulfilment in 12/12 overlapping runs over 4 invocations on 2026-10-13. Evaluated only when
          // the two requests actually overlapped at the server; otherwise reported, not asserted.
          if (impl === 'vulnerable' && mode === 'simultaneous') {
            if (record.classification !== 'concurrent') {
              t.diagnostic('requests did not overlap at the server: regression not evaluated in this run');
            } else {
              const i3 = record.verdicts.find((v) => v.id === 'I3');
              assert.equal(i3.status, STATUS.VIOLATION);
              assert.ok(i3.violationKinds.includes('duplicate_fulfilment'));
              assert.ok(i3.violationKinds.includes('stock_delta_mismatch'));
              assert.ok(record.fulfilmentCount > 1);
              assert.ok(record.stockDelta.observedDecrease > QUANTITY);
            }
          }
          // Vulnerable + sequential, vulnerable + barrier: observation only.
        });
      }
    });
  }
}

after(() => {
  const combos = [];
  for (const impl of IMPLS) {
    for (const mode of MODES) {
      const rs = runs.filter((r) => r.impl === impl && r.mode === mode);
      combos.push({
        impl,
        mode,
        runs: rs.length,
        duplicateFulfilment: rs.filter((r) => r.fulfilmentCount > 1).length,
        excessStockDecrease: rs.filter((r) => r.stockDelta.observedDecrease > QUANTITY).length,
        checkerFlaggedI3: rs.filter((r) => r.verdicts.find((v) => v.id === 'I3').status === STATUS.VIOLATION).length,
        serverOverlap: rs.filter((r) => r.timing.serverOverlap).length,
        verifiedConcurrent: rs.filter((r) => r.classification === 'concurrent').length,
        statuses: rs.map((r) => r.requests.map((q) => q.status).join('/')),
        perRun: rs.map((r) => ({
          repetition: r.repetition,
          classification: r.classification,
          fulfilmentCount: r.fulfilmentCount,
          stockDecrease: r.stockDelta.observedDecrease,
          verdicts: Object.fromEntries(r.verdicts.map((v) => [v.id, v.violationKinds.length ? `${v.status}: ${v.violationKinds.join(',')}` : v.status])),
        })),
      });
    }
  }
  const dir = path.join(__dirname, '..', '..', 'results');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${SCENARIO}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({ scenario: SCENARIO, node: process.version, summary: combos, runs }, null, 2));
  console.log(`[${SCENARIO}] results written to ${path.relative(process.cwd(), file)}`);
  for (const c of combos) {
    console.log(`[${SCENARIO}] ${c.impl}/${c.mode}: dupFulfil ${c.duplicateFulfilment}/${c.runs}, excessStock ${c.excessStockDecrease}/${c.runs}, I3 flagged ${c.checkerFlaggedI3}/${c.runs}, serverOverlap ${c.serverOverlap}/${c.runs}, verifiedConcurrent ${c.verifiedConcurrent}/${c.runs}, statuses ${c.statuses.join(' ')}`);
  }
});
