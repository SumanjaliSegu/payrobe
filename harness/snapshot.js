'use strict';
// Read-only, normalized view of a merchant database, taken through an explicit mapping.
//
// - Only SELECT statements are issued, inside a read transaction that is rolled back.
// - Identifiers come from the mapping, are validated, and are quoted.
// - Anything the mapping does not provide, or the database does not contain, is listed in
//   `missing` and left out of `available`, so checks can return cannot_verify instead of guessing.
const { DatabaseSync } = require('node:sqlite');

const ENTITIES = {
  orders: ['id', 'gatewayOrderId', 'amount', 'currency', 'status', 'paidPaymentId'],
  payments: ['id', 'gatewayOrderId', 'amount', 'currency', 'status'],
  fulfillments: ['orderId', 'sku', 'quantity'],
  refunds: ['id', 'paymentId', 'amount', 'status'],
  stock: ['sku', 'quantity'],
};

// Derived boolean fields: [entity, field, source column field, mapping list, meaning of list]
const DERIVED = [
  ['orders', 'isPaid', 'status', 'paidValues', 'in'],
  ['payments', 'isCaptured', 'status', 'capturedValues', 'in'],
  ['refunds', 'counted', 'status', 'notCountedValues', 'notIn'],
];

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (name) => {
  if (!IDENT.test(name)) throw new Error(`snapshot: unsafe identifier ${JSON.stringify(name)}`);
  return `"${name}"`;
};

function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

function readEntity(db, entity, spec, missing) {
  if (!spec?.table) {
    missing.push(`${entity}: not mapped`);
    return { rows: null, available: [] };
  }
  const exists = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(spec.table);
  if (!exists) {
    missing.push(`${entity}: table ${spec.table} not found`);
    return { rows: null, available: [] };
  }
  const present = new Set(db.prepare(`PRAGMA table_info(${quote(spec.table)})`).all().map((c) => c.name));
  const selected = [];
  for (const field of ENTITIES[entity]) {
    const column = spec.columns?.[field];
    if (column == null) missing.push(`${entity}.${field}: not mapped`);
    else if (!present.has(column)) missing.push(`${entity}.${field}: column ${spec.table}.${column} not found`);
    else selected.push([field, column]);
  }
  if (selected.length === 0) {
    missing.push(`${entity}: no mapped columns found`);
    return { rows: null, available: [] };
  }
  const sql = `SELECT ${selected.map(([f, c]) => `${quote(c)} AS ${quote(f)}`).join(', ')} FROM ${quote(spec.table)}`;
  const rows = db.prepare(sql).all().map((r) => ({ ...r }));
  return { rows, available: selected.map(([f]) => f) };
}

function takeSnapshot(db, mapping, { label } = {}) {
  if (db.isTransaction) throw new Error('snapshot: a transaction is open on this connection; refusing to read mid-transaction');
  const snapshot = { label: label ?? null, mapping: mapping.name, available: {}, missing: [] };

  db.exec('BEGIN');
  try {
    for (const entity of Object.keys(ENTITIES)) {
      const { rows, available } = readEntity(db, entity, mapping[entity], snapshot.missing);
      snapshot[entity] = rows;
      snapshot.available[entity] = available;
    }
  } finally {
    db.exec('ROLLBACK');
  }

  for (const [entity, field, source, listKey, mode] of DERIVED) {
    const values = mapping[entity]?.[listKey];
    if (!snapshot[entity] || !snapshot.available[entity].includes(source) || !Array.isArray(values)) {
      if (snapshot[entity]) snapshot.missing.push(`${entity}.${field}: needs ${source} and mapping.${entity}.${listKey}`);
      continue;
    }
    for (const row of snapshot[entity]) {
      const hit = values.includes(row[source]);
      row[field] = mode === 'in' ? hit : !hit;
    }
    snapshot.available[entity].push(field);
  }

  // Stock is easier to use keyed by sku.
  if (snapshot.stock && snapshot.available.stock.includes('sku') && snapshot.available.stock.includes('quantity')) {
    snapshot.stock = Object.fromEntries(snapshot.stock.map((r) => [r.sku, r.quantity]));
  } else if (snapshot.stock) {
    snapshot.stock = null;
    snapshot.available.stock = [];
  }
  return snapshot;
}

module.exports = { takeSnapshot, openReadOnly, ENTITIES };
