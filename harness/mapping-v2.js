'use strict';
// Mapping v2: where an app keeps payment state, how to drive it, and why we think so.
//
// Every claim is an *entry*: { value, evidence: [{ file, line }], confidence, alternatives? }.
//   value        what is claimed (a table name, a column, a route, a list of status values...).
//                null means "this app has no such thing"; checks that need it return cannot_verify.
//   evidence     source locations (relative to the target root) whose text mentions the value.
//   confidence   'high' | 'medium' | 'low'. 'low', or any listed alternatives, marks the entry ambiguous.
// Validation status is never taken from the input: harness/validator.js returns a validated copy in which
// every entry also has validation: { status, behaviour, evidence, reasons, observed }.
//
// Shape:
//   launch:  command { argv, cwd }, port / dbPath / webhookSecret / keySecret { via: 'arg'|'env', name }
//   routes:  createOrder { method, path, body, sample, response }, webhook { method, path, signatureHeader,
//            eventIdHeader }, verify? { method, path }, refund? { method, path }
//   orders / payments / fulfillments / refunds / stock: { table, columns: { field: entry }, <values list> }
// The state fields are the ones harness/snapshot.js reads (ENTITIES).
const { ENTITIES } = require('./snapshot');

const SCHEMA_ID = 'payprobe.mapping/v2';
const CONFIDENCE = ['high', 'medium', 'low'];
const LAUNCH_KEYS = ['command', 'port', 'dbPath', 'webhookSecret', 'keySecret'];
const ROUTE_KEYS = ['createOrder', 'webhook', 'verify', 'refund'];
const VALUE_LISTS = { orders: 'paidValues', payments: 'capturedValues', refunds: 'notCountedValues' };

// Without these, a positive control cannot show anything about the app.
const REQUIRED = [
  'routes.createOrder', 'routes.webhook',
  'orders.table', 'orders.columns.id', 'orders.columns.gatewayOrderId', 'orders.columns.status', 'orders.paidValues',
];

function parseEvidence(ev) {
  if (typeof ev === 'string') {
    const at = ev.lastIndexOf(':');
    return { file: ev.slice(0, at), line: Number(ev.slice(at + 1)) };
  }
  return { file: ev?.file, line: ev?.line };
}

// entry(value, ['merchant/app.js:12', ...], { confidence, alternatives })
function entry(value, evidence = [], { confidence = 'high', alternatives } = {}) {
  return { value, evidence: evidence.map(parseEvidence), confidence, ...(alternatives ? { alternatives } : {}) };
}

// Flat list of every entry with its dotted path and kind. Absent entities and sections are skipped.
function listEntries(mapping) {
  const out = [];
  const add = (path, kind, e, extra = {}) => { if (e !== undefined) out.push({ path, kind, entry: e, ...extra }); };
  for (const key of LAUNCH_KEYS) add(`launch.${key}`, key === 'command' ? 'command' : 'launchOption', mapping.launch?.[key]);
  for (const key of ROUTE_KEYS) add(`routes.${key}`, 'route', mapping.routes?.[key], { route: key });
  for (const entity of Object.keys(ENTITIES)) {
    const spec = mapping[entity];
    if (!spec) continue;
    add(`${entity}.table`, 'table', spec.table, { entity });
    for (const field of ENTITIES[entity]) {
      add(`${entity}.columns.${field}`, 'column', spec.columns?.[field], { entity, field });
    }
    if (VALUE_LISTS[entity]) add(`${entity}.${VALUE_LISTS[entity]}`, 'values', spec[VALUE_LISTS[entity]], { entity });
  }
  return out;
}

const isEntry = (e) => e && typeof e === 'object' && 'value' in e && Array.isArray(e.evidence);

// Structural problems that make a mapping unusable. Empty array when well formed.
function checkShape(mapping) {
  const errors = [];
  if (!mapping || typeof mapping !== 'object') return ['mapping is not an object'];
  if (mapping.schema !== SCHEMA_ID) errors.push(`schema must be ${SCHEMA_ID}`);
  for (const { path, entry: e } of listEntries(mapping)) {
    if (!isEntry(e)) {
      errors.push(`${path}: not an entry { value, evidence[], confidence }`);
      continue;
    }
    if (!CONFIDENCE.includes(e.confidence)) errors.push(`${path}: confidence must be one of ${CONFIDENCE.join(', ')}`);
    for (const ev of e.evidence) {
      if (typeof ev.file !== 'string' || !ev.file || !Number.isInteger(ev.line)) errors.push(`${path}: evidence needs file and integer line`);
    }
  }
  for (const path of REQUIRED) {
    if (!listEntries(mapping).some((x) => x.path === path)) errors.push(`${path}: required entry missing`);
  }
  return errors;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Projects to the v1 shape used by harness/snapshot.js and harness/invariants.js.
// keep(path) decides which entries survive; dropped entries become null (columns, tables) or
// undefined (value lists), so every check that needs them returns cannot_verify.
// A kept value list is kept whole: values never observed are not removed, because dropping
// a real paid value would make later checks report reversals that did not happen.
function toLegacy(mapping, keep = () => true) {
  const legacy = { name: mapping.name, provenance: `${mapping.provenance ?? 'unknown'} (v2 projection)` };
  const usable = (path, e) => isEntry(e) && keep(path) && e.value != null;
  for (const entity of Object.keys(ENTITIES)) {
    const spec = mapping[entity];
    const tablePath = `${entity}.table`;
    if (!spec || !usable(tablePath, spec.table) || !IDENT.test(spec.table.value)) {
      legacy[entity] = null;
      continue;
    }
    const columns = {};
    for (const field of ENTITIES[entity]) {
      const path = `${entity}.columns.${field}`;
      const e = spec.columns?.[field];
      columns[field] = usable(path, e) && IDENT.test(e.value) ? e.value : null;
    }
    legacy[entity] = { table: spec.table.value, columns };
    const listKey = VALUE_LISTS[entity];
    if (listKey && usable(`${entity}.${listKey}`, spec[listKey]) && Array.isArray(spec[listKey].value)) {
      legacy[entity][listKey] = [...spec[listKey].value];
    }
  }
  return legacy;
}

module.exports = {
  SCHEMA_ID, CONFIDENCE, LAUNCH_KEYS, ROUTE_KEYS, VALUE_LISTS, REQUIRED, IDENT,
  entry, parseEvidence, listEntries, checkShape, toLegacy,
};
