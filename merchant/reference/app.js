'use strict';
// Reference merchant integration: the behaviour we believe is correct.
//
// Design: the signed payment.captured webhook is the source of truth for "paid".
// The checkout callback only verifies the signature and records it; it never fulfils.
// State changes that must be atomic run in one synchronous SQLite transaction with
// no await inside, so concurrent requests cannot interleave between check and write.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const PAYMENT_RANK = { failed: 1, authorized: 2, captured: 3 };

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const newId = (prefix) => `${prefix}_${crypto.randomBytes(7).toString('hex')}`;

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function httpError(status, message) {
  return Object.assign(new Error(message), { http: status });
}

function createApp({ dbPath = ':memory:', keySecret, webhookSecret, gateway }) {
  if (!keySecret || !webhookSecret) throw new Error('keySecret and webhookSecret are required');
  if (!gateway) throw new Error('gateway is required');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const q = {
    product: db.prepare('SELECT * FROM products WHERE sku = ?'),
    orderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
    orderByRzpId: db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?'),
    insertOrder: db.prepare(`INSERT INTO orders (id, razorpay_order_id, sku, quantity, amount, currency, status)
                             VALUES (?, ?, ?, ?, ?, ?, 'created')`),
    payment: db.prepare('SELECT * FROM payments WHERE id = ?'),
    insertPayment: db.prepare(`INSERT INTO payments (id, razorpay_order_id, amount, currency, status, flag)
                               VALUES (?, ?, ?, ?, ?, ?)`),
    updatePayment: db.prepare(`UPDATE payments SET status = ?, flag = COALESCE(?, flag), updated_at = datetime('now')
                               WHERE id = ?`),
    markPaid: db.prepare(`UPDATE orders SET status = 'paid', paid_payment_id = ?, updated_at = datetime('now')
                          WHERE id = ? AND status <> 'paid'`),
    insertFulfillment: db.prepare('INSERT INTO fulfillments (order_id, sku, quantity) VALUES (?, ?, ?)'),
    decrementStock: db.prepare('UPDATE products SET stock = stock - ? WHERE sku = ?'),
    insertVerification: db.prepare('INSERT OR IGNORE INTO checkout_verifications (order_id, payment_id) VALUES (?, ?)'),
    recordEvent: db.prepare('INSERT OR IGNORE INTO webhook_events (event_id, event_type) VALUES (?, ?)'),
    refundedTotal: db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM refunds
                               WHERE payment_id = ? AND status <> 'failed'`),
    insertRefund: db.prepare(`INSERT INTO refunds (id, order_id, payment_id, amount, status) VALUES (?, ?, ?, ?, 'pending')`),
    settleRefund: db.prepare('UPDATE refunds SET razorpay_refund_id = ?, status = ? WHERE id = ?'),
    refundByRzpId: db.prepare('SELECT * FROM refunds WHERE razorpay_refund_id = ?'),
    setRefundStatus: db.prepare('UPDATE refunds SET status = ? WHERE id = ?'),
  };

  // Payment status only moves forward: failed -> authorized -> captured.
  // failed -> authorized/captured is allowed (late authorisation); captured never regresses.
  function upsertPayment(p, status, flag = null) {
    const existing = q.payment.get(p.id);
    if (!existing) {
      q.insertPayment.run(p.id, p.order_id, p.amount, p.currency, status, flag);
      return;
    }
    const next = PAYMENT_RANK[status] > PAYMENT_RANK[existing.status] ? status : existing.status;
    q.updatePayment.run(next, flag, p.id);
  }

  function onPaymentCaptured(p) {
    const order = q.orderByRzpId.get(p.order_id);
    if (!order) return upsertPayment(p, 'captured', 'unknown_order');
    if (p.amount !== order.amount || p.currency !== order.currency) {
      return upsertPayment(p, 'captured', 'amount_mismatch');
    }
    if (order.status === 'paid' && order.paid_payment_id !== p.id) {
      return upsertPayment(p, 'captured', 'extra_payment');
    }
    upsertPayment(p, 'captured');
    if (q.markPaid.run(p.id, order.id).changes === 1) {
      q.insertFulfillment.run(order.id, order.sku, order.quantity);
      q.decrementStock.run(order.quantity, order.sku);
    }
  }

  function setRefundStatusByRzpId(rzpRefundId, status) {
    const local = q.refundByRzpId.get(rzpRefundId);
    if (local) q.setRefundStatus.run(status, local.id);
  }

  const handlers = {
    'payment.authorized': (payload) => upsertPayment(payload.payment.entity, 'authorized'),
    'payment.failed': (payload) => upsertPayment(payload.payment.entity, 'failed'),
    'payment.captured': (payload) => onPaymentCaptured(payload.payment.entity),
    'refund.processed': (payload) => setRefundStatusByRzpId(payload.refund.entity.id, 'processed'),
    'refund.failed': (payload) => setRefundStatusByRzpId(payload.refund.entity.id, 'failed'),
  };

  const app = express();

  app.post('/api/orders', express.json(), async (req, res) => {
    const { sku, quantity = 1 } = req.body ?? {};
    const product = typeof sku === 'string' ? q.product.get(sku) : undefined;
    if (!product) return res.status(400).json({ error: 'unknown sku' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      return res.status(400).json({ error: 'quantity must be an integer from 1 to 10' });
    }
    const amount = product.price * quantity;
    const id = newId('ord');
    const rzpOrder = await gateway.createOrder({ amount, currency: 'INR', receipt: id });
    q.insertOrder.run(id, rzpOrder.id, sku, quantity, amount, 'INR');
    res.status(201).json({ order_id: id, razorpay_order_id: rzpOrder.id, amount, currency: 'INR' });
  });

  // Checkout success callback. Verifies the signature against the server's stored
  // razorpay_order_id, never one supplied by the client. Does not mark the order paid.
  app.post('/api/payments/verify', express.json(), (req, res) => {
    const { order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
    const order = typeof order_id === 'string' ? q.orderById.get(order_id) : undefined;
    if (!order || typeof razorpay_payment_id !== 'string') return res.status(400).json({ error: 'bad request' });
    const expected = hmacHex(keySecret, `${order.razorpay_order_id}|${razorpay_payment_id}`);
    if (!safeEqualHex(expected, razorpay_signature)) return res.status(400).json({ error: 'invalid signature' });
    q.insertVerification.run(order.id, razorpay_payment_id);
    res.json({ order_id: order.id, status: order.status, note: 'awaiting payment.captured webhook' });
  });

  app.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!safeEqualHex(hmacHex(webhookSecret, raw), req.get('x-razorpay-signature'))) {
      return res.status(400).json({ error: 'invalid signature' });
    }
    const eventId = req.get('x-razorpay-event-id');
    if (!eventId) return res.status(400).json({ error: 'missing event id' });
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'invalid json' });
    }
    // Recording the event id and applying its effects share one transaction:
    // if processing throws, the event is not marked seen and Razorpay's retry is processed.
    const outcome = tx(() => {
      if (q.recordEvent.run(eventId, String(event.event)).changes === 0) return 'duplicate';
      const handler = handlers[event.event];
      if (!handler) return 'ignored';
      handler(event.payload);
      return 'processed';
    });
    res.json({ outcome });
  });

  // Merchant-initiated refund. The cap check and the reservation happen in one
  // transaction before the gateway call, so concurrent requests cannot both pass.
  // No authentication: this is a local test fixture, not a deployable app.
  app.post('/api/orders/:id/refunds', express.json(), async (req, res) => {
    const amount = req.body?.amount;
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive integer' });
    let refundId;
    let paymentId;
    try {
      tx(() => {
        const order = q.orderById.get(req.params.id);
        if (!order || order.status !== 'paid') throw httpError(409, 'order not paid');
        const payment = q.payment.get(order.paid_payment_id);
        if (!payment || payment.status !== 'captured') throw httpError(409, 'no captured payment');
        const { total } = q.refundedTotal.get(payment.id);
        if (total + amount > payment.amount) throw httpError(409, 'refund exceeds captured amount');
        refundId = newId('rf');
        paymentId = payment.id;
        q.insertRefund.run(refundId, order.id, payment.id, amount);
      });
    } catch (err) {
      if (err.http) return res.status(err.http).json({ error: err.message });
      throw err;
    }
    try {
      const rz = await gateway.createRefund(paymentId, { amount });
      q.settleRefund.run(rz.id, rz.status === 'processed' || rz.status === 'failed' ? rz.status : 'pending', refundId);
      res.status(201).json({ refund_id: refundId, razorpay_refund_id: rz.id, amount });
    } catch {
      // Gateway outcome unknown or failed. Marking failed releases the reservation.
      // TODO(recovery): an ambiguous timeout should be reconciled, not assumed failed.
      q.setRefundStatus.run('failed', refundId);
      res.status(502).json({ error: 'gateway refund failed' });
    }
  });

  return { app, db };
}

module.exports = { createApp };
