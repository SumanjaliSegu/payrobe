'use strict';
// Mapping v2 schema, v1 projection and source-evidence checks. No app is started here.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { checkShape, listEntries, toLegacy, entry } = require('../harness/mapping-v2');
const { checkEvidence, makeLineReader } = require('../harness/validator');

const ROOT = path.join(__dirname, '..');
const V2 = {
  reference: require('../harness/mappings/v2/reference'),
  vulnerable: require('../harness/mappings/v2/vulnerable'),
};
const V1 = {
  reference: require('../harness/mappings/reference'),
  vulnerable: require('../harness/mappings/vulnerable'),
};

const evidenceFor = (mapping, p, opts = {}) => {
  const item = listEntries(mapping).find((x) => x.path === p);
  return checkEvidence(item, { root: ROOT, readLines: makeLineReader(new Set()), ...opts });
};

describe('mapping v2: hand-written mappings', () => {
  for (const impl of ['reference', 'vulnerable']) {
    it(`${impl}: well formed`, () => {
      assert.deepEqual(checkShape(V2[impl]), []);
    });

    it(`${impl}: projects to the same state mapping as the v1 hand mapping`, () => {
      const legacy = toLegacy(V2[impl]);
      for (const entity of ['orders', 'payments', 'fulfillments', 'refunds', 'stock']) {
        assert.deepEqual(legacy[entity], V1[impl][entity], entity);
      }
    });

    it(`${impl}: every cited line mentions what it supports`, () => {
      const results = listEntries(V2[impl]).map((x) => [x.path, evidenceFor(V2[impl], x.path)]);
      const unsupported = results.filter(([p, r]) => r.result !== 'supported' && p !== 'refunds.notCountedValues');
      assert.deepEqual(unsupported, []);
    });
  }

  it('the vulnerable mapping\'s uncited refund values are reported as missing evidence', () => {
    assert.equal(evidenceFor(V2.vulnerable, 'refunds.notCountedValues').result, 'missing');
  });
});

describe('mapping v2: shape and projection rules', () => {
  it('rejects a mapping without the schema id, a bad confidence, or a required entry', () => {
    const m = structuredClone(V2.reference);
    delete m.schema;
    m.orders.columns.amount.confidence = 'certain';
    delete m.routes.webhook;
    const errors = checkShape(m);
    assert.ok(errors.some((e) => e.startsWith('schema must be')));
    assert.ok(errors.some((e) => e.startsWith('orders.columns.amount: confidence')));
    assert.ok(errors.includes('routes.webhook: required entry missing'));
  });

  it('drops entries the filter does not keep: columns become null, value lists disappear', () => {
    const legacy = toLegacy(V2.reference, (p) => p !== 'orders.columns.status' && p !== 'orders.paidValues' && p !== 'stock.table');
    assert.equal(legacy.orders.columns.status, null);
    assert.equal(legacy.orders.paidValues, undefined);
    assert.equal(legacy.stock, null);
    assert.equal(legacy.orders.columns.amount, 'amount');
  });

  it('never projects an unsafe identifier', () => {
    const m = structuredClone(V2.reference);
    m.orders.columns.amount = entry('amount; DROP TABLE orders', []);
    assert.equal(toLegacy(m).orders.columns.amount, null);
  });
});

describe('mapping v2: evidence checks', () => {
  it('a cited line must mention the identifier as a whole word', () => {
    const m = structuredClone(V2.reference);
    // schema.sql:16 is "paid_payment_id TEXT": contains "id" only inside a longer word.
    m.orders.columns.id = entry('id', ['merchant/reference/schema.sql:16']);
    const r = evidenceFor(m, 'orders.columns.id');
    assert.equal(r.result, 'unsupported');
    assert.match(r.reasons.join(), /do not mention: id/);
  });

  it('rejects files outside the root, missing files, out-of-range lines and denied files', () => {
    const m = structuredClone(V2.reference);
    m.orders.columns.amount = entry('amount', ['../outside.sql:1', 'merchant/nope.sql:1', 'merchant/reference/schema.sql:9999']);
    const r = evidenceFor(m, 'orders.columns.amount');
    assert.equal(r.result, 'unsupported');
    assert.match(r.reasons[0], /outside the target root/);
    assert.match(r.reasons[1], /not found/);
    assert.match(r.reasons[2], /line out of range/);

    const filesRead = new Set();
    const denied = checkEvidence(listEntries(V2.reference).find((x) => x.path === 'orders.table'), {
      root: ROOT, denyFiles: ['merchant/reference/schema.sql'], readLines: makeLineReader(filesRead),
    });
    assert.equal(denied.result, 'unsupported');
    assert.match(denied.reasons[0], /not readable by the validator/);
    assert.equal(filesRead.size, 0, 'a denied file must not be read');
  });

  it('an entry with no evidence, or declared absent, is missing evidence', () => {
    const m = structuredClone(V2.reference);
    m.orders.columns.amount = entry('amount', []);
    m.orders.columns.paidPaymentId = entry(null, []);
    assert.equal(evidenceFor(m, 'orders.columns.amount').result, 'missing');
    assert.equal(evidenceFor(m, 'orders.columns.paidPaymentId').result, 'missing');
  });
});
