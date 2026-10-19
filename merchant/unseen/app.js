'use strict';
// Independently-structured merchant integration (different names and routes from the other fixtures),
// used to evaluate autonomous discovery. Do not add comments describing any defect: the investigator and
// readers must not be handed an answer key. Correctness is for the evaluation test to judge, not to state.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const RANK = { failed: 1, authorized: 2, captured: 3 };
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const newRef = (p) => `${p}_${crypto.randomBytes(7).toString('hex')}`;

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createApp({ dbPath = ':memory:', keySecret, webhookSecret, gateway }) {
  if (!keySecret || !webhookSecret) throw new Error('keySecret and webhookSecret are required');
  if (!gateway) throw new Error('gateway is required');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const q = {
    item: db.prepare('SELECT * FROM catalog WHERE sku = ?'),
    basketByRef: db.prepare('SELECT * FROM baskets WHERE ref = ?'),
    basketByGw: db.prepare('SELECT * FROM baskets WHERE gw_order_ref = ?'),
    insBasket: db.prepare(`INSERT INTO baskets (ref, gw_order_ref, sku, units, amount_minor, curr, state)
                           VALUES (?, ?, ?, ?, ?, ?, 'open')`),
    charge: db.prepare('SELECT * FROM charges WHERE ref = ?'),
    insCharge: db.prepare('INSERT INTO charges (ref, gw_order_ref, amount_minor, curr, state) VALUES (?, ?, ?, ?, ?)'),
    updCharge: db.prepare(`UPDATE charges SET state = ?, updated_at = datetime('now') WHERE ref = ?`),
    settle: db.prepare(`UPDATE baskets SET state = 'settled', settled_charge = ?, updated_at = datetime('now')
                        WHERE ref = ? AND state <> 'settled'`),
    setState: db.prepare(`UPDATE baskets SET state = ?, updated_at = datetime('now') WHERE gw_order_ref = ?`),
    insShip: db.prepare('INSERT INTO shipments (basket_ref, sku, units) VALUES (?, ?, ?)'),
    dec: db.prepare('UPDATE catalog SET available_units = available_units - ? WHERE sku = ?'),
    seen: db.prepare('INSERT OR IGNORE INTO seen_events (event_ref, kind) VALUES (?, ?)'),
    reversalTotal: db.prepare(`SELECT COALESCE(SUM(amount_minor), 0) AS total FROM reversals WHERE charge_ref = ? AND state <> 'failed'`),
  };

  function upsertCharge(p, state) {
    const existing = q.charge.get(p.id);
    if (!existing) return q.insCharge.run(p.id, p.order_id, p.amount, p.currency, state);
    const next = RANK[state] > RANK[existing.state] ? state : existing.state;
    return q.updCharge.run(next, p.id);
  }

  function onCaptured(p) {
    const basket = q.basketByGw.get(p.order_id);
    if (!basket) return upsertCharge(p, 'captured');
    if (p.amount !== basket.amount_minor || p.currency !== basket.curr) return upsertCharge(p, 'captured');
    upsertCharge(p, 'captured');
    if (q.settle.run(p.id, basket.ref).changes === 1) {
      q.insShip.run(basket.ref, basket.sku, basket.units);
      q.dec.run(basket.units, basket.sku);
    }
  }

  function onFailed(p) {
    upsertCharge(p, 'failed');
    q.setState.run('open', p.order_id);
  }

  const handlers = {
    'payment.authorized': (pl) => upsertCharge(pl.payment.entity, 'authorized'),
    'payment.captured': (pl) => onCaptured(pl.payment.entity),
    'payment.failed': (pl) => onFailed(pl.payment.entity),
  };

  const app = express();

  app.post('/api/v2/baskets', express.json(), async (req, res) => {
    const { sku, quantity = 1 } = req.body ?? {};
    const item = typeof sku === 'string' ? q.item.get(sku) : undefined;
    if (!item) return res.status(400).json({ error: 'unknown sku' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return res.status(400).json({ error: 'bad quantity' });
    const amount = item.unit_price_minor * quantity;
    const ref = newRef('bsk');
    const gwOrder = await gateway.createOrder({ amount, currency: 'INR', receipt: ref });
    q.insBasket.run(ref, gwOrder.id, sku, quantity, amount, 'INR');
    res.status(201).json({ order_id: ref, razorpay_order_id: gwOrder.id, amount, currency: 'INR' });
  });

  app.post('/api/v2/charge-callback', express.json(), (req, res) => {
    const { order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
    const basket = typeof order_id === 'string' ? q.basketByRef.get(order_id) : undefined;
    if (!basket || typeof razorpay_payment_id !== 'string') return res.status(400).json({ error: 'bad request' });
    const expected = hmacHex(keySecret, `${basket.gw_order_ref}|${razorpay_payment_id}`);
    if (!safeEqualHex(expected, razorpay_signature)) return res.status(400).json({ error: 'invalid signature' });
    res.json({ order_id: basket.ref, status: basket.state });
  });

  app.post('/hooks/pg', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!safeEqualHex(hmacHex(webhookSecret, raw), req.get('x-razorpay-signature'))) {
      return res.status(400).json({ error: 'invalid signature' });
    }
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
    const outcome = tx(() => {
      const handler = handlers[event.event];
      if (!handler) return 'ignored';
      handler(event.payload);
      return 'processed';
    });
    res.json({ outcome });
  });

  app.post('/api/v2/baskets/:ref/reversals', express.json(), async (req, res) => {
    const amount = req.body?.amount;
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'bad amount' });
    let reversalRef;
    let chargeRef;
    try {
      tx(() => {
        const basket = q.basketByRef.get(req.params.ref);
        if (!basket || basket.state !== 'settled') throw Object.assign(new Error('not settled'), { http: 409 });
        const charge = q.charge.get(basket.settled_charge);
        if (!charge || charge.state !== 'captured') throw Object.assign(new Error('no captured charge'), { http: 409 });
        const { total } = q.reversalTotal.get(charge.ref);
        if (total + amount > charge.amount_minor) throw Object.assign(new Error('exceeds captured'), { http: 409 });
        reversalRef = newRef('rev');
        chargeRef = charge.ref;
        db.prepare(`INSERT INTO reversals (ref, charge_ref, amount_minor, state) VALUES (?, ?, ?, 'pending')`).run(reversalRef, charge.ref, amount);
      });
    } catch (e) {
      if (e.http) return res.status(e.http).json({ error: e.message });
      throw e;
    }
    const rz = await gateway.createRefund(chargeRef, { amount });
    db.prepare('UPDATE reversals SET gateway_ref = ?, state = ? WHERE ref = ?').run(rz.id, 'done', reversalRef);
    res.status(201).json({ reversal_id: reversalRef, amount });
  });

  return { app, db };
}

module.exports = { createApp };
