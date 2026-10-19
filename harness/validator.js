'use strict';
// Validates a v2 mapping (harness/mapping-v2.js) against a running app. It uses only the mapping's
// own evidence and what the app observably does; it knows nothing about any particular app or bug.
//
// 1. Evidence: every cited file must be inside the target root, the line must exist, and the cited
//    lines must mention the claimed identifier. Only cited files are read.
// 2. Behaviour: one normal purchase driven through the mapped routes.
//      initial -> order A -> unsigned and wrong-secret captures for A (negative control)
//              -> order B -> one genuine signed payment.captured for B (positive control)
//    with a snapshot through the proposed mapping and a raw digest of every table after each step.
//    Expected values come from the harness: the gateway ledger (order id, amount, currency), the
//    payment id it generated, and the sku and quantity it requested. Never from the app's database.
// 3. Status per entry:
//      contradicted   the live schema or observed behaviour disagrees (regardless of evidence)
//      confirmed      behaviour agrees AND evidence supports it AND the entry is not ambiguous
//      cannot_verify  anything else: no or unsupported evidence, low confidence or alternatives,
//                     or behaviour not observed
// Only confirmed entries reach the projected v1 mapping; checks needing the rest return cannot_verify.
//
// Premise: the app handles one normal purchase correctly. If it does not, entries are contradicted or
// left unobserved and the mapping does not validate; the validator cannot tell an app defect from a
// mapping error on the happy path.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { takeSnapshot } = require('./snapshot');
const { genuinePaymentEvent, paymentEvent, newPaymentId, newEventId, hmacHex } = require('./mock-razorpay');
const { REQUIRED, IDENT, listEntries, checkShape, toLegacy } = require('./mapping-v2');

const STATUS = Object.freeze({ CONFIRMED: 'confirmed', CONTRADICTED: 'contradicted', CANNOT_VERIFY: 'cannot_verify' });
const B = Object.freeze({ OK: 'consistent', BAD: 'inconsistent', NONE: 'not_observed' });

// ---------------------------------------------------------------- evidence

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text, token) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(token)}([^A-Za-z0-9_]|$)`).test(text);
const staticSegments = (p) => p.split('/').filter((s) => s && !s.startsWith(':') && !s.startsWith('{'));

// What the cited lines must mention for each kind of entry.
function evidenceTokens({ kind, route, entry }) {
  const v = entry.value;
  if (v == null) return [];
  switch (kind) {
    case 'table':
    case 'column':
      return [String(v)];
    case 'values':
      return Array.isArray(v) ? v.map(String) : [];
    case 'command': {
      const script = (v.argv ?? []).find((a) => /\.[cm]?js$/.test(a));
      return script ? [path.basename(script)] : [];
    }
    case 'launchOption':
      return v.name ? [String(v.name).replace(/^-+/, '')] : [];
    case 'route': {
      const tokens = staticSegments(v.path ?? '');
      if (route === 'createOrder') {
        tokens.push(...Object.keys(v.body ?? {}), ...Object.values(v.response ?? {}));
        if (v.sample?.sku != null) tokens.push(String(v.sample.sku));
      }
      if (route === 'webhook') tokens.push(...[v.signatureHeader, v.eventIdHeader].filter(Boolean));
      return tokens;
    }
    default:
      return [];
  }
}

// Returns { result: 'supported' | 'missing' | 'unsupported', reasons }.
function checkEvidence(item, { root, denyFiles = [], readLines }) {
  const { entry } = item;
  if (entry.value == null) return { result: 'missing', reasons: ['declared absent: nothing to support'] };
  if (!entry.evidence.length) return { result: 'missing', reasons: ['no evidence cited'] };
  const lines = [];
  const reasons = [];
  for (const { file, line } of entry.evidence) {
    const abs = path.resolve(root, file);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      reasons.push(`${file}: outside the target root`);
      continue;
    }
    if (denyFiles.some((d) => path.resolve(root, d) === abs)) {
      reasons.push(`${file}: not readable by the validator`);
      continue;
    }
    const text = readLines(abs);
    if (!text) reasons.push(`${file}: not found`);
    else if (!(line >= 1 && line <= text.length)) reasons.push(`${file}:${line}: line out of range`);
    else lines.push(text[line - 1]);
  }
  const absentTokens = evidenceTokens(item).filter((t) => !lines.some((l) => mentions(l, t)));
  if (absentTokens.length) reasons.push(`cited lines do not mention: ${absentTokens.join(', ')}`);
  return reasons.length ? { result: 'unsupported', reasons } : { result: 'supported', reasons: [] };
}

function makeLineReader(filesRead) {
  const cache = new Map();
  return (abs) => {
    if (!cache.has(abs)) {
      let lines = null;
      try {
        lines = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
        filesRead.add(abs);
      } catch {
        lines = null;
      }
      cache.set(abs, lines);
    }
    return cache.get(abs);
  };
}

// ---------------------------------------------------------------- observation

function readStructure(db) {
  const tables = {};
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all()) {
    tables[name] = db.prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`).all().map((c) => c.name);
  }
  return tables;
}

// Mapping-independent fingerprint of every table, so "nothing changed" does not depend on the mapping.
function digestAll(db) {
  if (db.isTransaction) throw new Error('validator: a transaction is open on this connection');
  const out = {};
  db.exec('BEGIN');
  try {
    for (const name of Object.keys(readStructure(db))) {
      const rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all().map((r) => JSON.stringify(r)).sort();
      out[name] = { rows: rows.length, sha256: crypto.createHash('sha256').update(rows.join('\n')).digest('hex') };
    }
  } finally {
    db.exec('ROLLBACK');
  }
  return out;
}

const changedTables = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])]
  .filter((t) => a[t]?.sha256 !== b[t]?.sha256).sort();

function fill(template, values) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{(\w+)\}$/);
    if (whole && whole[1] in values) return values[whole[1]];
    return template.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
  }
  if (Array.isArray(template)) return template.map((t) => fill(t, values));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, t]) => [k, fill(t, values)]));
  return template;
}

async function request(baseUrl, method, urlPath, { json, raw, headers = {} } = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? (json === undefined ? undefined : JSON.stringify(json)),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, json: body, text };
}

async function deliver(baseUrl, webhook, event, { secret, eventId = newEventId() }) {
  const raw = JSON.stringify(event);
  const headers = { 'x-razorpay-event-id': eventId };
  if (webhook.eventIdHeader) headers[webhook.eventIdHeader] = eventId;
  if (secret) headers[webhook.signatureHeader ?? 'x-razorpay-signature'] = hmacHex(secret, raw);
  const res = await request(baseUrl, webhook.method ?? 'POST', webhook.path, { raw, headers });
  return { status: res.status, eventId, signed: Boolean(secret) };
}

const ok2xx = (s) => s >= 200 && s < 300;

// Drives one normal purchase, with the negative control on a separate order so that an app which
// accepts forged events cannot disturb the baseline of the genuine purchase.
//   initial -> create order A -> unsigned + wrong-secret capture for A (negative control)
//           -> create order B -> genuine signed capture for B (positive control)
// target: { baseUrl, db, webhookSecret, ledger }.
async function observe(mapping, target) {
  const { baseUrl, db, webhookSecret, ledger } = target;
  const proposed = toLegacy(mapping);
  const obs = { structure: readStructure(db), steps: {}, aborted: null };
  const step = (label) => {
    obs.steps[label] = { snapshot: takeSnapshot(db, proposed, { label }), digest: digestAll(db) };
    return obs.steps[label];
  };
  step('initial');

  const co = mapping.routes.createOrder.value;
  const webhook = mapping.routes.webhook.value;
  if (!co?.path || !co.sample?.sku) {
    obs.aborted = 'routes.createOrder has no path or sample';
    return obs;
  }
  const quantity = co.sample.quantity ?? 1;
  const body = fill(co.body ?? {}, { sku: co.sample.sku, quantity });

  // Returns the attempt record; sets obs.aborted when no single new gateway order resulted.
  const createOrder = async (label) => {
    const ledgerOrdersBefore = new Set(Object.keys(ledger.view().orders));
    let res;
    try {
      res = await request(baseUrl, co.method ?? 'POST', co.path, { json: body });
    } catch (err) {
      res = { status: null, error: String(err) };
    }
    const newGatewayOrders = Object.values(ledger.view().orders).filter((o) => !ledgerOrdersBefore.has(o.id));
    const attempt = {
      request: { method: co.method ?? 'POST', path: co.path, body },
      sku: co.sample.sku,
      quantity,
      status: res.status,
      response: res.json ?? res.text ?? res.error,
      newGatewayOrders,
    };
    step(label);
    if (!ok2xx(res.status)) obs.aborted = 'order creation did not succeed';
    else if (newGatewayOrders.length !== 1) obs.aborted = `expected one new gateway order in the ledger, saw ${newGatewayOrders.length}`;
    return attempt;
  };

  // Order A: negative control only.
  obs.createOrder = await createOrder('afterNegativeOrder');
  if (obs.aborted) return obs;
  if (!webhook?.path) {
    obs.aborted = 'routes.webhook has no path';
    return obs;
  }
  const a = obs.createOrder.newGatewayOrders[0];
  // Same shape as a real capture, for a payment the gateway never processed (not in the ledger).
  const forged = paymentEvent('payment.captured', { paymentId: newPaymentId(), orderId: a.id, amount: a.amount, currency: a.currency });
  obs.negativeOrder = { attempt: obs.createOrder, gatewayOrder: a };
  obs.negative = [
    { kind: 'no_signature', ...(await deliver(baseUrl, webhook, forged, {})) },
    { kind: 'wrong_secret', ...(await deliver(baseUrl, webhook, forged, { secret: `wrong-${crypto.randomBytes(8).toString('hex')}` })) },
  ];
  step('afterUnsigned');

  // Order B: the normal purchase every entry is judged on, from the afterUnsigned baseline.
  obs.createOrder = await createOrder('afterOrder');
  if (obs.aborted) return obs;
  const gw = obs.createOrder.newGatewayOrders[0];
  obs.gatewayOrder = gw;
  const paymentId = newPaymentId();
  const event = genuinePaymentEvent(ledger, 'payment.captured', { paymentId, orderId: gw.id, amount: gw.amount, currency: gw.currency });
  obs.captured = { paymentId, ...(await deliver(baseUrl, webhook, event, { secret: webhookSecret })) };
  step('afterCaptured');
  return obs;
}

// ---------------------------------------------------------------- judgement
// Works only on the mapping and the recorded observations; it sets obs.negativeControl as a side effect.

// Collects outcomes per entry path. Final: any inconsistent -> inconsistent; any not observed ->
// not observed; otherwise consistent. An entry with no outcome at all was not observed.
function outcomeBook() {
  const book = new Map();
  const add = (p, result, reason) => {
    if (!book.has(p)) book.set(p, []);
    book.get(p).push({ result, reason });
  };
  return {
    ok: (p, reason) => add(p, B.OK, reason),
    bad: (p, reason) => add(p, B.BAD, reason),
    none: (p, reason) => add(p, B.NONE, reason),
    final(p) {
      const list = book.get(p) ?? [];
      const pick = (r) => list.filter((x) => x.result === r).map((x) => x.reason);
      if (pick(B.BAD).length) return { result: B.BAD, reasons: pick(B.BAD) };
      if (!list.length) return { result: B.NONE, reasons: ['not exercised by validation'] };
      if (pick(B.NONE).length) return { result: B.NONE, reasons: pick(B.NONE) };
      return { result: B.OK, reasons: pick(B.OK) };
    },
  };
}

// Rows present in `later` but not in `earlier`, compared on mapped fields (multiset).
function newRows(earlier, later) {
  const counts = new Map();
  for (const r of earlier ?? []) counts.set(JSON.stringify(r), (counts.get(JSON.stringify(r)) ?? 0) + 1);
  return (later ?? []).filter((r) => {
    const k = JSON.stringify(r);
    if (counts.get(k) > 0) {
      counts.set(k, counts.get(k) - 1);
      return false;
    }
    return true;
  });
}

const show = (v) => JSON.stringify(v);

function judgeBehaviour(mapping, obs) {
  const o = outcomeBook();
  const items = listEntries(mapping);
  const has = (p) => items.some((x) => x.path === p && x.entry.value != null);
  const stateEntries = items.filter((x) => ['table', 'column', 'values'].includes(x.kind));

  // Launch is not exercised here: the harness starts the app in-process.
  for (const x of items.filter((i) => i.path.startsWith('launch.'))) o.none(x.path, 'launch not exercised: app started in-process by the harness');
  for (const r of ['verify', 'refund']) o.none(`routes.${r}`, 'route not exercised by validation');
  for (const x of stateEntries.filter((i) => i.entity === 'refunds')) o.none(x.path, 'no refund is made during validation');

  // Structure of the live database.
  for (const x of stateEntries) {
    if (x.entry.value == null || x.kind === 'values') continue;
    const tableName = mapping[x.entity].table?.value;
    if (x.kind === 'table') {
      if (!IDENT.test(String(x.entry.value))) o.bad(x.path, `unsafe identifier ${show(x.entry.value)}`);
      else if (!obs.structure[x.entry.value]) o.bad(x.path, `table ${x.entry.value} does not exist`);
    } else if (!obs.structure[tableName]) {
      o.none(x.path, `table ${tableName} does not exist`);
    } else if (!IDENT.test(String(x.entry.value))) {
      o.bad(x.path, `unsafe identifier ${show(x.entry.value)}`);
    } else if (!obs.structure[tableName].includes(x.entry.value)) {
      o.bad(x.path, `column ${tableName}.${x.entry.value} does not exist`);
    }
  }

  const afterOrderStates = stateEntries.filter((x) => x.entity !== 'refunds').map((x) => x.path);
  const notReached = (paths, why) => { for (const p of paths) o.none(p, why); };

  // Order creation.
  const co = obs.createOrder;
  if (!co) {
    o.none('routes.createOrder', obs.aborted ?? 'not attempted');
    notReached(['routes.webhook', ...afterOrderStates], obs.aborted ?? 'order creation not attempted');
    return o;
  }
  if (co.status === 404 || co.status === 405) o.bad('routes.createOrder', `${co.request.method} ${co.request.path} returned ${co.status}: no such route`);
  else if (!ok2xx(co.status)) o.bad('routes.createOrder', `${co.request.method} ${co.request.path} returned ${co.status}: ${show(co.response)}`);
  if (!ok2xx(co.status) || !obs.gatewayOrder) {
    if (ok2xx(co.status)) o.none('routes.createOrder', obs.aborted);
    notReached(['routes.webhook', ...afterOrderStates], `positive control not reached: ${obs.aborted}`);
    return o;
  }
  const gw = obs.gatewayOrder;
  const responseMap = mapping.routes.createOrder.value.response ?? {};
  const resp = co.response ?? {};
  const fromResponse = (field) => (responseMap[field] && typeof resp === 'object' ? resp[responseMap[field]] : undefined);
  const truth = { gatewayOrderId: gw.id, amount: gw.amount, currency: gw.currency };
  for (const [field, key] of Object.entries(responseMap)) {
    if (!key) continue;
    if (fromResponse(field) === undefined) o.bad('routes.createOrder', `response has no field ${show(key)} (response.${field})`);
    else if (field in truth && fromResponse(field) !== truth[field]) {
      o.bad('routes.createOrder', `response.${field} (${key}) = ${show(fromResponse(field))}, gateway ledger has ${show(truth[field])}`);
    }
  }
  o.ok('routes.createOrder', `${co.status}; gateway order ${gw.id} created for ${gw.amount} ${gw.currency}`);

  const s = Object.fromEntries(Object.entries(obs.steps).map(([k, v]) => [k, v.snapshot]));
  const avail = (snap, entity, field) => Boolean(snap?.[entity]) && snap.available[entity].includes(field);

  // Order B is judged from the afterUnsigned baseline, so effects of the negative control on order A
  // (an app that accepts forged events) cannot be blamed on correct entries.
  // Orders: exactly one new row after creation, matching the gateway order; not paid yet.
  let order = null;
  if (has('orders.table') && s.afterOrder.orders) {
    const added = newRows(s.afterUnsigned.orders, s.afterOrder.orders);
    if (added.length !== 1) o.bad('orders.table', `expected one new row after order creation, saw ${added.length}`);
    else {
      order = added[0];
      o.ok('orders.table', 'one new row after order creation');
      const expect = { id: fromResponse('orderId'), gatewayOrderId: gw.id, amount: gw.amount, currency: gw.currency };
      for (const [field, want] of Object.entries(expect)) {
        const p = `orders.columns.${field}`;
        if (!avail(s.afterOrder, 'orders', field)) continue;
        if (want === undefined) o.none(p, 'no independent value to compare (response field not mapped)');
        else if (order[field] === want) o.ok(p, `= ${show(want)}`);
        else o.bad(p, `new order row has ${show(order[field])}, expected ${show(want)}`);
      }
      if (avail(s.afterOrder, 'orders', 'paidPaymentId') && order.paidPaymentId != null && order.paidPaymentId !== '') {
        o.bad('orders.columns.paidPaymentId', `already ${show(order.paidPaymentId)} before any payment`);
      }
      if (avail(s.afterOrder, 'orders', 'isPaid') && order.isPaid) {
        o.bad('orders.paidValues', `status ${show(order.status)} counts as paid before any payment`);
      }
    }
  }

  // Nothing should be captured or fulfilled for this order before payment.
  const fulfilmentsAtOrder = newRows(s.afterUnsigned.fulfillments, s.afterOrder.fulfillments);
  if (has('fulfillments.table') && s.afterOrder.fulfillments && fulfilmentsAtOrder.length) {
    o.bad('fulfillments.table', `${fulfilmentsAtOrder.length} new row(s) at order creation, before any payment`);
  }
  if (avail(s.afterOrder, 'payments', 'isCaptured') && newRows(s.afterUnsigned.payments, s.afterOrder.payments).some((p) => p.isCaptured)) {
    o.bad('payments.capturedValues', 'a captured payment row appeared at order creation, before any payment');
  }

  // Negative control (an app property, reported separately) and webhook route.
  const changedByUnsigned = changedTables(obs.steps.afterNegativeOrder.digest, obs.steps.afterUnsigned.digest);
  const cap = obs.captured;
  const changedByCapture = changedTables(obs.steps.afterOrder.digest, obs.steps.afterCaptured.digest);
  // Entries fully judged at order creation keep that judgement if the capture never arrives.
  const judgedAtOrder = new Set(['orders.table', 'orders.columns.id', 'orders.columns.gatewayOrderId', 'orders.columns.amount', 'orders.columns.currency']);
  const webhookPaths = afterOrderStates.filter((p) => !judgedAtOrder.has(p));
  if (cap.status === 404 || cap.status === 405) {
    o.bad('routes.webhook', `signed webhook to ${mapping.routes.webhook.value.path} returned ${cap.status}: no such route`);
    notReached(webhookPaths, 'positive control not delivered (webhook route rejected)');
    return o;
  }
  if (!ok2xx(cap.status)) {
    o.bad('routes.webhook', `correctly signed webhook returned ${cap.status}`);
    notReached(webhookPaths, 'positive control not accepted');
    return o;
  }
  if (!changedByCapture.length) {
    o.none('routes.webhook', 'signed webhook accepted but no table changed');
    notReached(webhookPaths, 'positive control changed nothing');
    return o;
  }
  o.ok('routes.webhook', `signed webhook ${cap.status}; tables changed: ${changedByCapture.join(', ')}`);
  obs.negativeControl = {
    result: changedByUnsigned.length ? 'state_changed' : 'held',
    changedTables: changedByUnsigned,
    mappedTablesChanged: changedByUnsigned.filter((tb) => stateEntries.some((x) => x.kind === 'table' && x.entry.value === tb)),
    deliveries: obs.negative,
  };
  const before = s.afterOrder;
  const after = s.afterCaptured;

  // Orders after capture: the same row, now paid, linked to the generated payment id.
  if (order && after.orders) {
    const same = after.orders.filter((r) => r.id === order.id);
    if (same.length !== 1) {
      o.none('orders.paidValues', 'could not find the order row again after capture');
      o.none('orders.columns.status', 'could not find the order row again after capture');
    } else {
      const now = same[0];
      const was = before.orders.find((r) => r.id === order.id) ?? order;
      if (avail(after, 'orders', 'status')) {
        if (now.status !== was.status) o.ok('orders.columns.status', `${show(was.status)} -> ${show(now.status)} on capture`);
        else o.bad('orders.columns.status', `unchanged (${show(now.status)}) after a genuine capture`);
        if (now.status === was.status) o.none('orders.paidValues', 'status column did not change; cannot judge paid values');
        else if (now.isPaid) o.ok('orders.paidValues', `${show(now.status)} counts as paid; ${show(was.status)} does not`);
        else o.bad('orders.paidValues', `status after capture is ${show(now.status)}, not in ${show(mapping.orders.paidValues?.value)}`);
      }
      if (avail(after, 'orders', 'paidPaymentId')) {
        if (now.paidPaymentId === cap.paymentId) o.ok('orders.columns.paidPaymentId', `= generated payment id ${cap.paymentId}`);
        else o.bad('orders.columns.paidPaymentId', `${show(now.paidPaymentId)} after capture, expected ${show(cap.paymentId)}`);
      }
    }
  }

  // Payments: a row for the generated payment id with the gateway's facts.
  if (has('payments.table') && after.payments) {
    const added = newRows(before.payments, after.payments);
    if (!added.length) o.bad('payments.table', 'no new or changed row after a genuine capture');
    else {
      o.ok('payments.table', `${added.length} new or changed row(s) after capture`);
      if (avail(after, 'payments', 'id')) {
        const row = added.find((r) => r.id === cap.paymentId);
        if (!row) o.bad('payments.columns.id', `no new row has the generated payment id ${cap.paymentId}`);
        else {
          o.ok('payments.columns.id', `= generated payment id ${cap.paymentId}`);
          for (const [field, want] of Object.entries(truth)) {
            const p = `payments.columns.${field}`;
            if (!avail(after, 'payments', field)) continue;
            if (row[field] === want) o.ok(p, `= ${show(want)}`);
            else o.bad(p, `payment row has ${show(row[field])}, gateway ledger has ${show(want)}`);
          }
          if (avail(after, 'payments', 'isCaptured')) {
            if (row.isCaptured) {
              o.ok('payments.capturedValues', `${show(row.status)} counts as captured`);
              o.ok('payments.columns.status', `= ${show(row.status)}`);
            } else {
              o.bad('payments.capturedValues', `payment row status ${show(row.status)} not in ${show(mapping.payments.capturedValues?.value)}`);
              o.none('payments.columns.status', 'either payments.status or capturedValues is wrong');
            }
          }
        }
      }
    }
  }

  // Fulfilments: exactly one new row for this order, with the requested sku and quantity.
  if (has('fulfillments.table') && after.fulfillments) {
    const added = newRows(before.fulfillments, after.fulfillments);
    if (!added.length) o.bad('fulfillments.table', 'no new row after a genuine capture');
    else if (order && avail(after, 'fulfillments', 'orderId')) {
      const mine = added.filter((r) => r.orderId === order.id);
      if (!mine.length) o.bad('fulfillments.columns.orderId', `new row(s) ${show(added.map((r) => r.orderId))} do not reference order ${show(order.id)}`);
      else if (mine.length > 1) o.bad('fulfillments.table', `${mine.length} rows for one order after one capture`);
      else {
        if (!fulfilmentsAtOrder.length) o.ok('fulfillments.table', 'no row before payment, one row after capture');
        o.ok('fulfillments.columns.orderId', `= order ${show(order.id)}`);
        const expect = { sku: co.sku, quantity: co.quantity };
        for (const [field, want] of Object.entries(expect)) {
          if (!avail(after, 'fulfillments', field)) continue;
          if (mine[0][field] === want) o.ok(`fulfillments.columns.${field}`, `= requested ${show(want)}`);
          else o.bad(`fulfillments.columns.${field}`, `fulfilment row has ${show(mine[0][field])}, requested ${show(want)}`);
        }
      }
    }
  }

  // Stock: the requested sku falls by the requested quantity over the purchase; nothing else moves.
  const s0 = s.afterUnsigned.stock;
  const s1 = after.stock;
  if (has('stock.table') && s0 && s1) {
    if (!(co.sku in s0)) o.bad('stock.columns.sku', `requested sku ${show(co.sku)} not found in mapped stock`);
    else {
      o.ok('stock.columns.sku', `requested sku ${show(co.sku)} found`);
      o.ok('stock.table', 'sku row found');
      const drop = s0[co.sku] - s1[co.sku];
      if (drop === co.quantity) o.ok('stock.columns.quantity', `fell by ${drop} = requested quantity`);
      else o.bad('stock.columns.quantity', `fell by ${show(drop)}, requested quantity ${co.quantity}`);
      const others = Object.keys(s0).filter((k) => k !== co.sku && s0[k] !== s1[k]);
      if (others.length) o.bad('stock.columns.quantity', `other skus changed: ${others.join(', ')}`);
    }
  }
  return o;
}

// ---------------------------------------------------------------- entry point

// target: { baseUrl, db, webhookSecret, ledger, database? }
//   db        read handle on the app's database. Use a separate read-only connection
//             (harness/run-db.js openReader), not the app's own connection.
//   database  optional metadata from harness/run-db.js describe(), copied into report.database:
//             { provided, runId, path, directory, fileName, createdAt, existedBefore, reader, provenance }
//             The validator records these claims; it does not re-check them. Its own record of the
//             starting state is observations.steps.initial (row counts per table).
//             path and directory are local absolute paths: redact them before any public-facing
//             benchmark output.
// options: root (directory evidence paths are relative to), denyFiles (never read).
async function validateMapping(mapping, { target, root, denyFiles = [] }) {
  const shapeErrors = checkShape(mapping);
  if (shapeErrors.length) return { verdict: 'malformed', errors: shapeErrors, entries: [], legacy: null };

  const filesRead = new Set();
  const readLines = makeLineReader(filesRead);
  const items = listEntries(mapping);
  const evidence = new Map(items.map((x) => [x.path, checkEvidence(x, { root, denyFiles, readLines })]));

  const obs = await observe(mapping, target);
  const book = judgeBehaviour(mapping, obs);

  const entries = items.map((x) => {
    const ev = evidence.get(x.path);
    const behaviour = book.final(x.path);
    const ambiguous = x.entry.confidence === 'low' || (x.entry.alternatives?.length ?? 0) > 0;
    let status;
    const reasons = [];
    if (behaviour.result === B.BAD) {
      status = STATUS.CONTRADICTED;
      reasons.push(...behaviour.reasons);
    } else if (behaviour.result === B.OK && ev.result === 'supported' && !ambiguous) {
      status = STATUS.CONFIRMED;
    } else {
      status = STATUS.CANNOT_VERIFY;
      if (behaviour.result === B.NONE) reasons.push(...behaviour.reasons.map((r) => `behaviour: ${r}`));
      if (ev.result !== 'supported') reasons.push(...ev.reasons.map((r) => `evidence: ${r}`));
      if (ambiguous) reasons.push(`ambiguous: confidence ${x.entry.confidence}${x.entry.alternatives?.length ? `, alternatives ${show(x.entry.alternatives)}` : ''}`);
    }
    const out = {
      path: x.path, value: x.entry.value, confidence: x.entry.confidence, status,
      behaviour: behaviour.result, observed: behaviour.result === B.OK ? behaviour.reasons : [],
      evidence: ev.result, reasons,
    };
    if (x.kind === 'values' && status === STATUS.CONFIRMED) {
      const seen = [statusValuesAt(obs, 'afterCaptured', x.entity)].flat().filter(Boolean);
      out.unobservedValues = x.entry.value.filter((v) => !seen.includes(v));
    }
    return out;
  });

  const statusOf = new Map(entries.map((e) => [e.path, e.status]));
  // The validated mapping: a copy of the input with a `validation` record on every entry. This is the
  // artifact to freeze before any probe runs.
  const validated = structuredClone(mapping);
  for (const x of listEntries(validated)) {
    const e = entries.find((y) => y.path === x.path);
    x.entry.validation = { status: e.status, behaviour: e.behaviour, evidence: e.evidence, reasons: e.reasons, observed: e.observed };
  }
  const contradicted = entries.filter((e) => e.status === STATUS.CONTRADICTED).map((e) => e.path);
  const requiredUnconfirmed = REQUIRED.filter((p) => statusOf.get(p) !== STATUS.CONFIRMED);
  let verdict = 'validated';
  if (contradicted.length) verdict = 'rejected';
  else if (requiredUnconfirmed.length) verdict = 'insufficient';

  return {
    verdict,
    contradicted,
    requiredUnconfirmed,
    entries,
    negativeControl: obs.negativeControl ?? { result: 'not_meaningful', reason: 'positive control did not change state through this route' },
    database: describeDatabase(target.database),
    observations: summarize(obs),
    filesRead: [...filesRead].map((f) => path.relative(root, f).split(path.sep).join('/')).sort(),
    mapping: validated,
    legacy: toLegacy(mapping, (p) => statusOf.get(p) === STATUS.CONFIRMED),
  };
}

// Status values observed for an entity's status column at a step (for unobservedValues).
function statusValuesAt(obs, label, entity) {
  const rows = obs.steps[label]?.snapshot?.[entity];
  return rows ? rows.map((r) => r.status) : [];
}

function describeDatabase(d) {
  if (!d) return { provided: false, provenance: 'caller supplied no database metadata' };
  return {
    provided: true,
    runId: d.runId ?? null,
    path: d.path ?? null,
    directory: d.directory ?? null,
    fileName: d.fileName ?? null,
    createdAt: d.createdAt ?? null,
    existedBefore: d.existedBefore ?? null,
    reader: d.reader ?? null,
    provenance: `caller-supplied${d.createdBy ? ` (${d.createdBy})` : ''}`,
  };
}

function summarize(obs) {
  return {
    aborted: obs.aborted,
    createOrder: obs.createOrder ?? null,
    gatewayOrder: obs.gatewayOrder ?? null,
    negativeOrder: obs.negativeOrder ? { gatewayOrder: obs.negativeOrder.gatewayOrder, response: obs.negativeOrder.attempt.response } : null,
    negativeDeliveries: obs.negative ?? null,
    captured: obs.captured ?? null,
    steps: Object.fromEntries(Object.entries(obs.steps).map(([k, v]) => [k, {
      orders: v.snapshot.orders, payments: v.snapshot.payments, fulfillments: v.snapshot.fulfillments,
      stock: v.snapshot.stock, missing: v.snapshot.missing,
      rowCounts: Object.fromEntries(Object.entries(v.digest).map(([t, d]) => [t, d.rows])),
    }])),
  };
}

module.exports = { STATUS, validateMapping, checkEvidence, evidenceTokens, makeLineReader, digestAll, changedTables };
