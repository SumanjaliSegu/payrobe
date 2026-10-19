'use strict';
// Second independently-structured merchant integration (ticketing vocabulary), intended to behave
// correctly. Used to evaluate discovery and false-positive rate on unfamiliar names. No comment states
// whether it is correct; that is for the evaluation test to judge.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const RANK = { failed: 1, authorized: 2, captured: 3 };
const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');
const newRef = (p) => `${p}_${crypto.randomBytes(7).toString('hex')}`;

function eqHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function createApp({ dbPath = ':memory:', keySecret, webhookSecret, gateway }) {
  if (!keySecret || !webhookSecret) throw new Error('keySecret and webhookSecret are required');
  if (!gateway) throw new Error('gateway is required');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  const tx = (fn) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const q = {
    item: db.prepare('SELECT * FROM inventory WHERE sku = ?'),
    ticketByToken: db.prepare('SELECT * FROM tickets WHERE token = ?'),
    ticketByHandle: db.prepare('SELECT * FROM tickets WHERE pg_order_handle = ?'),
    insTicket: db.prepare(`INSERT INTO tickets (token, pg_order_handle, sku, qty, price_paise, iso_curr, phase)
                           VALUES (?, ?, ?, ?, ?, ?, 'pending')`),
    settlement: db.prepare('SELECT * FROM settlements WHERE handle = ?'),
    insSettlement: db.prepare('INSERT INTO settlements (handle, pg_order_handle, price_paise, iso_curr, phase) VALUES (?, ?, ?, ?, ?)'),
    updSettlement: db.prepare(`UPDATE settlements SET phase = ?, touched_at = datetime('now') WHERE handle = ?`),
    fulfil: db.prepare(`UPDATE tickets SET phase = 'fulfilled', winning_settlement = ?, touched_at = datetime('now')
                        WHERE token = ? AND phase <> 'fulfilled'`),
    grant: db.prepare('INSERT INTO grants (ticket_token, sku, qty) VALUES (?, ?, ?)'),
    dec: db.prepare('UPDATE inventory SET in_stock = in_stock - ? WHERE sku = ?'),
    hook: db.prepare('INSERT OR IGNORE INTO processed_hooks (hook_ref, kind) VALUES (?, ?)'),
    creditTotal: db.prepare(`SELECT COALESCE(SUM(price_paise), 0) AS total FROM credits WHERE settlement_handle = ? AND phase <> 'failed'`),
    insCredit: db.prepare(`INSERT INTO credits (ref, settlement_handle, price_paise, phase) VALUES (?, ?, ?, 'pending')`),
    setCredit: db.prepare('UPDATE credits SET pg_credit_handle = ?, phase = ? WHERE ref = ?'),
    failCredit: db.prepare(`UPDATE credits SET phase = 'failed' WHERE ref = ?`),
  };

  function upsertSettlement(p, phase) {
    const ex = q.settlement.get(p.id);
    if (!ex) return q.insSettlement.run(p.id, p.order_id, p.amount, p.currency, phase);
    const next = RANK[phase] > RANK[ex.phase] ? phase : ex.phase;
    return q.updSettlement.run(next, p.id);
  }

  function onCaptured(p) {
    const ticket = q.ticketByHandle.get(p.order_id);
    if (!ticket) return upsertSettlement(p, 'captured');
    if (p.amount !== ticket.price_paise || p.currency !== ticket.iso_curr) return upsertSettlement(p, 'captured');
    upsertSettlement(p, 'captured');
    if (q.fulfil.run(p.id, ticket.token).changes === 1) {
      q.grant.run(ticket.token, ticket.sku, ticket.qty);
      q.dec.run(ticket.qty, ticket.sku);
    }
  }

  const handlers = {
    'payment.authorized': (pl) => upsertSettlement(pl.payment.entity, 'authorized'),
    'payment.captured': (pl) => onCaptured(pl.payment.entity),
    'payment.failed': (pl) => upsertSettlement(pl.payment.entity, 'failed'),
  };

  const app = express();

  app.post('/v1/intents', express.json(), async (req, res) => {
    const { sku, quantity = 1 } = req.body ?? {};
    const item = typeof sku === 'string' ? q.item.get(sku) : undefined;
    if (!item) return res.status(400).json({ error: 'unknown sku' });
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) return res.status(400).json({ error: 'bad quantity' });
    const amount = item.unit_paise * quantity;
    const token = newRef('tkt');
    const gwOrder = await gateway.createOrder({ amount, currency: 'INR', receipt: token });
    q.insTicket.run(token, gwOrder.id, sku, quantity, amount, 'INR');
    res.status(201).json({ order_id: token, razorpay_order_id: gwOrder.id, amount, currency: 'INR' });
  });

  app.post('/v1/charge-confirm', express.json(), (req, res) => {
    const { order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
    const ticket = typeof order_id === 'string' ? q.ticketByToken.get(order_id) : undefined;
    if (!ticket || typeof razorpay_payment_id !== 'string') return res.status(400).json({ error: 'bad request' });
    const expected = hmacHex(keySecret, `${ticket.pg_order_handle}|${razorpay_payment_id}`);
    if (!eqHex(expected, razorpay_signature)) return res.status(400).json({ error: 'invalid signature' });
    res.json({ order_id: ticket.token, status: ticket.phase });
  });

  app.post('/v1/pg-hook', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!eqHex(hmacHex(webhookSecret, raw), req.get('x-razorpay-signature'))) return res.status(400).json({ error: 'invalid signature' });
    const hookRef = req.get('x-razorpay-event-id');
    if (!hookRef) return res.status(400).json({ error: 'missing event id' });
    let event;
    try { event = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
    const outcome = tx(() => {
      if (q.hook.run(hookRef, String(event.event)).changes === 0) return 'duplicate';
      const handler = handlers[event.event];
      if (!handler) return 'ignored';
      handler(event.payload);
      return 'processed';
    });
    res.json({ outcome });
  });

  app.post('/v1/intents/:token/refunds', express.json(), async (req, res) => {
    const amount = req.body?.amount;
    if (!Number.isInteger(amount) || amount <= 0) return res.status(400).json({ error: 'bad amount' });
    let creditRef;
    let settlementHandle;
    try {
      tx(() => {
        const ticket = q.ticketByToken.get(req.params.token);
        if (!ticket || ticket.phase !== 'fulfilled') throw Object.assign(new Error('not fulfilled'), { http: 409 });
        const settlement = q.settlement.get(ticket.winning_settlement);
        if (!settlement || settlement.phase !== 'captured') throw Object.assign(new Error('no captured settlement'), { http: 409 });
        const { total } = q.creditTotal.get(settlement.handle);
        if (total + amount > settlement.price_paise) throw Object.assign(new Error('exceeds captured'), { http: 409 });
        creditRef = newRef('cr');
        settlementHandle = settlement.handle;
        q.insCredit.run(creditRef, settlement.handle, amount);
      });
    } catch (e) {
      if (e.http) return res.status(e.http).json({ error: e.message });
      throw e;
    }
    try {
      const rz = await gateway.createRefund(settlementHandle, { amount });
      q.setCredit.run(rz.id, rz.status === 'processed' ? 'done' : 'pending', creditRef);
      res.status(201).json({ credit_ref: creditRef, amount });
    } catch {
      q.failCredit.run(creditRef);
      res.status(502).json({ error: 'refund failed' });
    }
  });

  return { app, db };
}

module.exports = { createApp };
