'use strict';
// Tests for the read-only snapshot and the gateway ledger.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { takeSnapshot } = require('../harness/snapshot');
const { createLedger } = require('../harness/ledger');

// Deliberately unlike the fixture apps, so nothing depends on their names.
function shopDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE purchase (pk TEXT PRIMARY KEY, rzp TEXT, total INTEGER, cur TEXT, state TEXT);
    CREATE TABLE shipment (purchase_pk TEXT, item TEXT, n INTEGER);
    CREATE TABLE inventory (item TEXT PRIMARY KEY, on_hand INTEGER);
    INSERT INTO purchase VALUES ('p1', 'order_1', 500, 'INR', 'PAID'), ('p2', 'order_2', 900, 'INR', 'NEW');
    INSERT INTO shipment VALUES ('p1', 'mug', 1);
    INSERT INTO inventory VALUES ('mug', 4);
  `);
  return db;
}

const mapping = {
  name: 'shop',
  orders: {
    table: 'purchase',
    columns: { id: 'pk', gatewayOrderId: 'rzp', amount: 'total', currency: 'cur', status: 'state', paidPaymentId: null },
    paidValues: ['PAID'],
  },
  payments: null,
  fulfillments: { table: 'shipment', columns: { orderId: 'purchase_pk', sku: 'item', quantity: 'n' } },
  refunds: { table: 'refund_log', columns: { id: 'id', paymentId: 'pid', amount: 'amt', status: 'st' } },
  stock: { table: 'inventory', columns: { sku: 'item', quantity: 'on_hand' } },
};

describe('snapshot', () => {
  it('normalizes rows through the mapping and derives isPaid', () => {
    const s = takeSnapshot(shopDb(), mapping, { label: 't0' });
    assert.equal(s.label, 't0');
    assert.deepEqual(s.orders.map((o) => [o.id, o.isPaid]), [['p1', true], ['p2', false]]);
    assert.deepEqual(s.fulfillments, [{ orderId: 'p1', sku: 'mug', quantity: 1 }]);
    assert.deepEqual(s.stock, { mug: 4 });
  });

  it('lists unmapped fields, missing tables and unmapped entities instead of guessing', () => {
    const s = takeSnapshot(shopDb(), mapping);
    assert.ok(s.missing.includes('orders.paidPaymentId: not mapped'));
    assert.ok(s.missing.includes('payments: not mapped'));
    assert.ok(s.missing.includes('refunds: table refund_log not found'));
    assert.equal(s.payments, null);
    assert.equal(s.refunds, null);
    assert.ok(!s.available.orders.includes('paidPaymentId'));
  });

  it('reports a mapped column that does not exist', () => {
    const m = { ...mapping, orders: { ...mapping.orders, columns: { ...mapping.orders.columns, amount: 'amount_paise' } } };
    const s = takeSnapshot(shopDb(), m);
    assert.ok(s.missing.includes('orders.amount: column purchase.amount_paise not found'));
    assert.ok(!s.available.orders.includes('amount'));
  });

  it('does not write to the database', () => {
    const db = shopDb();
    const changes = () => db.prepare('SELECT total_changes() AS n').get().n;
    const n = changes();
    takeSnapshot(db, mapping);
    assert.equal(changes(), n);
    assert.equal(db.isTransaction, false);
  });

  it('never interpolates mapping identifiers that are not real tables or columns', () => {
    const bad = { ...mapping, stock: { table: 'inventory', columns: { sku: 'item; DROP TABLE inventory', quantity: 'on_hand' } } };
    // The column is absent, so it is reported missing, never interpolated.
    const s = takeSnapshot(shopDb(), bad);
    assert.ok(s.missing.some((m) => m.startsWith('stock.sku')));
    const badTable = { ...mapping, stock: { table: 'x"y', columns: { sku: 'item', quantity: 'on_hand' } } };
    assert.ok(takeSnapshot(shopDb(), badTable).missing.includes('stock: table x"y not found'));
  });

  it('refuses to read while a transaction is open', () => {
    const db = shopDb();
    db.exec('BEGIN');
    assert.throws(() => takeSnapshot(db, mapping), /transaction is open/);
    db.exec('ROLLBACK');
  });
});

describe('ledger', () => {
  it('records orders, payment status history and refunds', () => {
    const l = createLedger();
    l.recordOrder({ id: 'order_1', amount: 500, currency: 'INR', receipt: 'r' });
    l.recordPayment({ id: 'pay_1', orderId: 'order_1', amount: 500, currency: 'INR', status: 'failed' });
    l.recordPayment({ id: 'pay_1', orderId: 'order_1', amount: 500, currency: 'INR', status: 'captured' });
    l.recordRefund({ id: 'rfnd_1', paymentId: 'pay_1', amount: 100, status: 'processed' });
    const v = l.view();
    assert.deepEqual(v.payments.pay_1.history, ['failed', 'captured']);
    assert.equal(v.refunds.length, 1);
    assert.deepEqual(v.log.map((e) => e.kind), ['order.created', 'payment.failed', 'payment.captured', 'refund.processed']);
  });

  it('refuses to change a payment identity or record unknown statuses', () => {
    const l = createLedger();
    l.recordPayment({ id: 'pay_1', orderId: 'order_1', amount: 500, currency: 'INR', status: 'captured' });
    assert.throws(() => l.recordPayment({ id: 'pay_1', orderId: 'order_1', amount: 1, currency: 'INR', status: 'captured' }), /cannot change/);
    assert.throws(() => l.recordPayment({ id: 'pay_2', orderId: 'o', amount: 1, currency: 'INR', status: 'paid' }), /unknown payment status/);
  });

  it('returns a copy that callers cannot use to alter the ledger', () => {
    const l = createLedger();
    l.recordOrder({ id: 'order_1', amount: 500, currency: 'INR' });
    l.view().orders.order_1.amount = 1;
    assert.equal(l.view().orders.order_1.amount, 500);
  });
});
