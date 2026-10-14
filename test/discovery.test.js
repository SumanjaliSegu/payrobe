'use strict';
// Unit tests for harness/discovery.js: schema and route parsing, and that the deterministic mapping it
// proposes from source alone (a) matches the hand-written v1 projection on the known fixtures, (b) cites
// evidence lines that actually contain their value, and (c) only ever cites files under the app source
// (so an answer key outside the source can never be read).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { discoverMapping, parseSchema, parseRoutes, classifyRoute, listSourceFiles } = require('../harness/discovery');
const { toLegacy, checkShape, listEntries } = require('../harness/mapping-v2');

const V1 = {
  reference: require('../harness/mappings/reference'),
  vulnerable: require('../harness/mappings/vulnerable'),
};

describe('discovery: schema parsing', () => {
  it('parses tables and columns with accurate line numbers, ignoring comments with commas', () => {
    const tables = parseSchema([path.join('merchant', 'reference', 'schema.sql')], 'merchant/reference');
    const orders = tables.find((t) => t.table === 'orders');
    assert.ok(orders, 'orders table found');
    const names = orders.columns.map((c) => c.name);
    assert.deepEqual(names, ['id', 'razorpay_order_id', 'sku', 'quantity', 'amount', 'currency', 'status', 'paid_payment_id', 'created_at', 'updated_at']);
    const status = orders.columns.find((c) => c.name === 'status');
    assert.deepEqual(status.checkValues, ['created', 'paid']);
    const src = fs.readFileSync('merchant/reference/schema.sql', 'utf8').split(/\r?\n/);
    for (const c of orders.columns) assert.ok(src[c.line - 1].includes(c.name), `line ${c.line} contains ${c.name}`);
    assert.equal(orders.columns.find((c) => c.name === 'id').pk, true);
  });
});

describe('discovery: route parsing and classification', () => {
  it('parses Express routes and classifies them by general vocabulary', () => {
    const routes = parseRoutes([path.join('merchant', 'reference', 'app.js')], 'merchant/reference');
    const byRole = {};
    for (const r of routes) { const role = classifyRoute(r); if (role) byRole[role] = r.path; }
    assert.equal(byRole.createOrder, '/api/orders');
    assert.equal(byRole.webhook, '/webhooks/razorpay');
    assert.equal(byRole.verify, '/api/payments/verify');
    assert.equal(byRole.refund, '/api/orders/:id/refunds');
  });

  it('classifies unfamiliar but conventional names (basket, hook, callback, reversal)', () => {
    assert.equal(classifyRoute({ method: 'POST', path: '/api/v2/baskets' }), 'createOrder');
    assert.equal(classifyRoute({ method: 'POST', path: '/hooks/pg' }), 'webhook');
    assert.equal(classifyRoute({ method: 'POST', path: '/api/v2/charge-callback' }), 'verify');
    assert.equal(classifyRoute({ method: 'POST', path: '/api/v2/baskets/:ref/reversals' }), 'refund');
    assert.equal(classifyRoute({ method: 'GET', path: '/api/orders' }), null, 'GET is not order creation');
    assert.equal(classifyRoute({ method: 'POST', path: '/api/orders/:id/items' }), null, 'a sub-resource POST is not order creation');
  });
});

describe('discovery: proposed mapping on the known fixtures', () => {
  for (const impl of ['reference', 'vulnerable']) {
    it(`${impl}: well-formed and matches the hand-written v1 projection (structural)`, () => {
      const { mapping } = discoverMapping({ root: `merchant/${impl}`, name: impl });
      assert.deepEqual(checkShape(mapping), [], 'discovered mapping is well-formed');
      const leg = toLegacy(mapping);
      for (const e of ['orders', 'payments', 'fulfillments', 'refunds', 'stock']) {
        assert.deepEqual(leg[e], V1[impl][e], `${impl}.${e}`);
      }
    });

    it(`${impl}: every cited evidence line contains its claimed value`, () => {
      const { mapping } = discoverMapping({ root: `merchant/${impl}`, name: impl });
      for (const { entry } of listEntries(mapping)) {
        if (entry.value == null || !entry.evidence.length) continue;
        const values = Array.isArray(entry.value) ? entry.value.map(String) : typeof entry.value === 'object' ? [] : [String(entry.value)];
        if (!values.length) continue;
        for (const { file, line } of entry.evidence) {
          const src = fs.readFileSync(path.join('merchant', impl, file), 'utf8').split(/\r?\n/);
          assert.ok(values.some((v) => (src[line - 1] ?? '').includes(v)), `${impl} ${file}:${line} should contain one of ${JSON.stringify(values)}`);
        }
      }
    });

    it(`${impl}: cites only files under the app source (an answer key outside it cannot be read)`, () => {
      const { mapping } = discoverMapping({ root: `merchant/${impl}`, name: impl });
      for (const { entry } of listEntries(mapping)) {
        for (const { file } of entry.evidence ?? []) {
          assert.ok(!file.includes('..') && !path.isAbsolute(file), `evidence ${file} must be inside the source`);
          assert.ok(!/SEEDED_BUGS/i.test(file), 'never cites the answer key');
        }
      }
    });
  }
});

describe('discovery: unfamiliar (unseen) app', () => {
  it('maps differently-named tables, columns, routes and status vocabulary', () => {
    const { mapping, inspected } = discoverMapping({ root: 'merchant/unseen', name: 'unseen' });
    assert.deepEqual(checkShape(mapping), []);
    assert.equal(mapping.orders.table.value, 'baskets');
    assert.equal(mapping.orders.columns.gatewayOrderId.value, 'gw_order_ref');
    assert.equal(mapping.orders.columns.status.value, 'state');
    assert.deepEqual(mapping.orders.paidValues.value, ['settled']);
    assert.equal(mapping.payments.table.value, 'charges');
    assert.deepEqual(mapping.payments.capturedValues.value, ['captured']);
    assert.equal(mapping.fulfillments.table.value, 'shipments');
    assert.equal(mapping.fulfillments.columns.quantity.value, 'units');
    assert.equal(mapping.refunds.table.value, 'reversals');
    assert.equal(mapping.refunds.columns.paymentId.value, 'charge_ref', 'refund->payment resolved via REFERENCES charges');
    assert.equal(mapping.stock.table.value, 'catalog');
    assert.equal(mapping.stock.columns.quantity.value, 'available_units');
    assert.equal(mapping.routes.createOrder.value.path, '/api/v2/baskets');
    assert.equal(mapping.routes.webhook.value.path, '/hooks/pg');
    assert.ok(inspected.tables.length >= 6);
  });

  it('maps a second app whose columns use different words (phase, iso_curr, fulfilled)', () => {
    const { mapping } = discoverMapping({ root: 'merchant/unseen2', name: 'unseen2' });
    assert.deepEqual(checkShape(mapping), []);
    assert.equal(mapping.orders.table.value, 'tickets');
    assert.equal(mapping.orders.columns.status.value, 'phase', 'status column named "phase"');
    assert.equal(mapping.orders.columns.currency.value, 'iso_curr', 'currency column named "iso_curr"');
    assert.deepEqual(mapping.orders.paidValues.value, ['fulfilled'], 'paid state named "fulfilled"');
    assert.equal(mapping.orders.columns.gatewayOrderId.value, 'pg_order_handle');
    assert.equal(mapping.payments.table.value, 'settlements');
    assert.deepEqual(mapping.payments.capturedValues.value, ['captured']);
    assert.equal(mapping.stock.columns.quantity.value, 'in_stock');
    assert.equal(mapping.routes.createOrder.value.path, '/v1/intents');
    assert.equal(mapping.routes.verify.value.path, '/v1/charge-confirm');
  });
});
