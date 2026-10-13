'use strict';
// Phase 1 smoke tests: both implementations must handle the happy path.
// These are not invariant tests; they show the fixtures work before we attack them.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMerchant, postJson } = require('./helpers');
const { paymentEvent, deliverWebhook, newPaymentId } = require('../harness/mock-razorpay');
const { loadConfig } = require('../merchant/config');

for (const impl of ['reference', 'vulnerable']) {
  describe(`smoke: ${impl}`, () => {
    let m;
    before(async () => {
      m = await startMerchant(impl);
    });
    after(async () => {
      await m.close();
    });

    it('creates an order with a server-computed amount', async () => {
      const res = await postJson(m.baseUrl, '/api/orders', { sku: 'HOODIE', quantity: 2 });
      assert.equal(res.status, 201);
      const row = m.db.prepare('SELECT * FROM orders WHERE id = ?').get(res.json.order_id);
      assert.equal(row.amount, 999800);
      assert.equal(row.status, 'created');
      assert.equal(row.razorpay_order_id, res.json.razorpay_order_id);
    });

    it('rejects a webhook with no signature and leaves state unchanged', async () => {
      const order = (await postJson(m.baseUrl, '/api/orders', { sku: 'TSHIRT' })).json;
      const event = paymentEvent('payment.captured', {
        paymentId: newPaymentId(), orderId: order.razorpay_order_id, amount: order.amount,
      });
      const res = await deliverWebhook(m.baseUrl, event, {});
      assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
      const row = m.db.prepare('SELECT status FROM orders WHERE id = ?').get(order.order_id);
      assert.equal(row.status, 'created');
      const n = m.db.prepare('SELECT COUNT(*) AS n FROM fulfillments WHERE order_id = ?').get(order.order_id).n;
      assert.equal(n, 0);
    });

    it('a signed payment.captured marks the order paid and fulfils it exactly once', async () => {
      const order = (await postJson(m.baseUrl, '/api/orders', { sku: 'TSHIRT', quantity: 3 })).json;
      const stockBefore = m.db.prepare(`SELECT stock FROM products WHERE sku = 'TSHIRT'`).get().stock;
      const paymentId = newPaymentId();
      const event = paymentEvent('payment.captured', { paymentId, orderId: order.razorpay_order_id, amount: order.amount });
      const res = await deliverWebhook(m.baseUrl, event, { secret: m.webhookSecret });
      assert.equal(res.status, 200);

      const row = m.db.prepare('SELECT * FROM orders WHERE id = ?').get(order.order_id);
      assert.equal(row.status, 'paid');
      assert.equal(row.paid_payment_id, paymentId);
      const n = m.db.prepare('SELECT COUNT(*) AS n FROM fulfillments WHERE order_id = ?').get(order.order_id).n;
      assert.equal(n, 1);
      const stockAfter = m.db.prepare(`SELECT stock FROM products WHERE sku = 'TSHIRT'`).get().stock;
      assert.equal(stockBefore - stockAfter, 3);
    });
  });
}

describe('config guard', () => {
  it('refuses live Razorpay keys', () => {
    assert.throws(() => loadConfig({ RZP_KEY_ID: 'rzp_live_abc', RZP_KEY_SECRET: 'x' }), /live Razorpay key/);
  });
  it('falls back to mock secrets when no env is set', () => {
    const c = loadConfig({});
    assert.equal(c.mock, true);
    assert.match(c.keyId, /^rzp_test_/);
  });
});
