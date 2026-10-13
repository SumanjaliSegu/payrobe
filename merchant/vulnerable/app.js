'use strict';
// Merchant integration fixture. See docs/SEEDED_BUGS.md for what is wrong with it.
// Do not add comments here that describe the bugs: this file is a test target.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const newId = (prefix) => `${prefix}_${crypto.randomBytes(7).toString('hex')}`;

// Lets the warehouse know an order is ready to ship.
async function notifyWarehouse(order) {
  await new Promise((resolve) => setImmediate(resolve));
  return { ok: true, order_id: order.id };
}

function createApp({ dbPath = ':memory:', keySecret, webhookSecret, gateway }) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const app = express();
  app.use(express.json());

  async function fulfil(order, paymentId) {
    await notifyWarehouse(order);
    db.prepare(`UPDATE orders SET status = 'paid', paid_payment_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(paymentId, order.id);
    db.prepare('INSERT INTO fulfillments (order_id, sku, quantity) VALUES (?, ?, ?)').run(order.id, order.sku, order.quantity);
    db.prepare('UPDATE products SET stock = stock - ? WHERE sku = ?').run(order.quantity, order.sku);
  }

  function savePayment(p, status) {
    db.prepare(`INSERT INTO payments (id, razorpay_order_id, amount, currency, status) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = datetime('now')`)
      .run(p.id, p.order_id, p.amount, p.currency, status);
  }

  app.post('/api/orders', async (req, res) => {
    const { sku, quantity = 1 } = req.body;
    const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
    if (!product) return res.status(400).json({ error: 'unknown sku' });
    const amount = product.price * quantity;
    const id = newId('ord');
    const rzpOrder = await gateway.createOrder({ amount, currency: 'INR', receipt: id });
    db.prepare(`INSERT INTO orders (id, razorpay_order_id, sku, quantity, amount, currency, status)
                VALUES (?, ?, ?, ?, ?, 'INR', 'created')`).run(id, rzpOrder.id, sku, quantity, amount);
    res.status(201).json({ order_id: id, razorpay_order_id: rzpOrder.id, amount, currency: 'INR' });
  });

  app.post('/api/payments/verify', async (req, res) => {
    const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = hmacHex(keySecret, `${razorpay_order_id}|${razorpay_payment_id}`);
    if (expected !== razorpay_signature) return res.status(400).json({ error: 'invalid signature' });
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(order_id);
    if (!order) return res.status(404).json({ error: 'order not found' });
    if (order.status !== 'paid') await fulfil(order, razorpay_payment_id);
    res.json({ order_id, status: 'paid' });
  });

  app.post('/webhooks/razorpay', async (req, res) => {
    const expected = hmacHex(webhookSecret, JSON.stringify(req.body));
    if (expected !== req.get('x-razorpay-signature')) return res.status(400).json({ error: 'invalid signature' });

    const { event, payload } = req.body;
    if (event === 'payment.captured') {
      const p = payload.payment.entity;
      savePayment(p, 'captured');
      const order = db.prepare('SELECT * FROM orders WHERE razorpay_order_id = ?').get(p.order_id);
      if (order && order.status !== 'paid') await fulfil(order, p.id);
    } else if (event === 'payment.authorized') {
      savePayment(payload.payment.entity, 'authorized');
    } else if (event === 'payment.failed') {
      const p = payload.payment.entity;
      savePayment(p, 'failed');
      db.prepare(`UPDATE orders SET status = 'failed', updated_at = datetime('now') WHERE razorpay_order_id = ?`).run(p.order_id);
    } else if (event === 'refund.processed') {
      const r = payload.refund.entity;
      db.prepare(`UPDATE refunds SET status = 'processed' WHERE razorpay_refund_id = ?`).run(r.id);
    }
    res.json({ ok: true });
  });

  app.post('/api/orders/:id/refunds', async (req, res) => {
    const { amount } = req.body;
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order || order.status !== 'paid') return res.status(409).json({ error: 'order not paid' });
    if (!(amount > 0) || amount > order.amount) return res.status(400).json({ error: 'invalid amount' });
    const rz = await gateway.createRefund(order.paid_payment_id, { amount });
    db.prepare(`INSERT INTO refunds (id, razorpay_refund_id, order_id, payment_id, amount, status)
                VALUES (?, ?, ?, ?, ?, ?)`).run(newId('rf'), rz.id, order.id, order.paid_payment_id, amount, rz.status);
    res.status(201).json({ razorpay_refund_id: rz.id, amount });
  });

  return { app, db };
}

module.exports = { createApp };
