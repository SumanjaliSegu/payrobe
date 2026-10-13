'use strict';
// Happy path through each real fixture app, checked through its hand-written mapping.
// Expectation: no violations on either app. This shows the mappings, snapshot and checker
// work end to end; it does not show that anything detects bugs (that is Phase 3).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMerchant, postJson } = require('./helpers');
const { createLedger } = require('../harness/ledger');
const { takeSnapshot } = require('../harness/snapshot');
const { checkAll, STATUS } = require('../harness/invariants');
const { genuinePaymentEvent, deliverWebhook, newPaymentId } = require('../harness/mock-razorpay');

const MAPPINGS = {
  reference: require('../harness/mappings/reference'),
  vulnerable: require('../harness/mappings/vulnerable'),
};

for (const impl of ['reference', 'vulnerable']) {
  describe(`integration happy path: ${impl}`, () => {
    let m;
    let ledger;
    before(async () => {
      ledger = createLedger();
      m = await startMerchant(impl, { ledger });
    });
    after(async () => {
      await m.close();
    });

    it('order, genuine capture, partial refund: I1-I5 pass, I6 cannot_verify', async () => {
      const mapping = MAPPINGS[impl];
      const snapshots = [takeSnapshot(m.db, mapping, { label: 'start' })];

      const order = (await postJson(m.baseUrl, '/api/orders', { sku: 'HOODIE', quantity: 1 })).json;
      snapshots.push(takeSnapshot(m.db, mapping, { label: 'order created' }));

      const paymentId = newPaymentId();
      const event = genuinePaymentEvent(ledger, 'payment.captured', {
        paymentId, orderId: order.razorpay_order_id, amount: order.amount,
      });
      const delivered = await deliverWebhook(m.baseUrl, event, { secret: m.webhookSecret });
      assert.equal(delivered.status, 200);
      snapshots.push(takeSnapshot(m.db, mapping, { label: 'captured delivered' }));

      const refund = await postJson(m.baseUrl, `/api/orders/${order.order_id}/refunds`, { amount: 100000 });
      assert.equal(refund.status, 201);
      snapshots.push(takeSnapshot(m.db, mapping, { label: 'partial refund' }));

      assert.deepEqual(snapshots.at(-1).missing, [], 'hand-written mapping should cover every field');

      const results = checkAll({ snapshots, ledger: ledger.view() });
      const byId = Object.fromEntries(results.map((r) => [r.id, r]));
      for (const id of ['I1', 'I2', 'I3', 'I4', 'I5']) {
        assert.equal(byId[id].status, STATUS.PASS, `${id}: ${JSON.stringify(byId[id], null, 2)}`);
        assert.ok(!byId[id].vacuous, `${id} should have checked something`);
      }
      assert.equal(byId.I6.status, STATUS.CANNOT_VERIFY);

      // The ledger, not the merchant DB, is the evidence: it holds the order, capture and refund.
      const view = ledger.view();
      assert.equal(view.orders[order.razorpay_order_id].amount, 499900);
      assert.deepEqual(view.payments[paymentId].history, ['captured']);
      assert.equal(view.refunds.length, 1);
    });
  });
}
