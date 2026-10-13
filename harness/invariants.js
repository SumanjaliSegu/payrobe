'use strict';
// Business invariant checks over normalized snapshots (harness/snapshot.js) and the
// independent gateway ledger (harness/ledger.js). Pure functions: no I/O, no merchant code.
//
// Each check returns { id, title, status, checked, violations, unverifiable, notes }.
//   status = 'violation'      if any violation was found,
//          = 'cannot_verify'  else if any required evidence was missing,
//          = 'pass'           otherwise (`vacuous: true` when nothing was in scope).
// Missing evidence never counts as a pass.

const STATUS = Object.freeze({ PASS: 'pass', VIOLATION: 'violation', CANNOT_VERIFY: 'cannot_verify' });

function newResult(id, title) {
  return { id, title, status: null, checked: 0, violations: [], unverifiable: [], notes: [] };
}

function finalize(r) {
  if (r.violations.length) r.status = STATUS.VIOLATION;
  else if (r.unverifiable.length) r.status = STATUS.CANNOT_VERIFY;
  else r.status = STATUS.PASS;
  if (r.status === STATUS.PASS && r.checked === 0) r.vacuous = true;
  return r;
}

// Returns the reasons evidence is missing (empty when all fields are available).
function lacks(snapshot, entity, fields) {
  if (!snapshot) return ['snapshot not provided'];
  if (!snapshot[entity]) return [`${entity} not available in snapshot ${snapshot.label ?? ''}`.trim()];
  const have = snapshot.available?.[entity] ?? [];
  return fields.filter((f) => !have.includes(f)).map((f) => `${entity}.${f} not available`);
}

const has = (snapshot, entity, field) => Boolean(snapshot?.[entity]) && (snapshot.available?.[entity] ?? []).includes(field);
const everCaptured = (p) => Boolean(p) && p.history.includes('captured');
const capturesForOrder = (ledger, gatewayOrderId) =>
  Object.values(ledger.payments).filter((p) => p.orderId === gatewayOrderId && everCaptured(p));
const NO_LEDGER = 'no gateway ledger: merchant records alone are not independent evidence';

// Is this paid order backed by a captured gateway payment for the same order and amount?
// Returns { ok: true } | { ok: false, kind, evidence } | { ok: null, reason }.
function paidOrderBacking(order, ledger, linkAvailable) {
  if (linkAvailable) {
    const p = order.paidPaymentId ? ledger.payments[order.paidPaymentId] : undefined;
    if (!p) return { ok: false, kind: 'paid_payment_unknown_to_gateway', evidence: { paidPaymentId: order.paidPaymentId ?? null } };
    if (p.orderId !== order.gatewayOrderId) return { ok: false, kind: 'paid_with_payment_for_other_order', evidence: { gatewayPayment: p } };
    if (!everCaptured(p)) return { ok: false, kind: 'paid_payment_not_captured', evidence: { gatewayPayment: p } };
    return { ok: true, payment: p };
  }
  const captures = capturesForOrder(ledger, order.gatewayOrderId);
  if (captures.length === 0) return { ok: false, kind: 'no_captured_payment_for_order', evidence: {} };
  return { ok: true, candidates: captures };
}

// I1: an order marked paid has matching, gateway-verified captured payment evidence.
function checkPaidHasCapture(after, ledger) {
  const r = newResult('I1', 'A paid order has a captured gateway payment for that same order');
  const missing = lacks(after, 'orders', ['id', 'gatewayOrderId', 'isPaid']);
  if (!ledger) missing.push(NO_LEDGER);
  if (missing.length) {
    r.unverifiable.push({ reason: missing });
    return finalize(r);
  }
  const link = has(after, 'orders', 'paidPaymentId');
  if (!link) r.notes.push('orders.paidPaymentId not mapped: matched by gateway order id only');
  for (const order of after.orders.filter((o) => o.isPaid)) {
    r.checked++;
    const b = paidOrderBacking(order, ledger, link);
    if (b.ok === false) r.violations.push({ kind: b.kind, order, ...b.evidence });
  }
  return finalize(r);
}

// I2: the payment that made an order paid has the server-side order amount and currency,
// and the order amount equals what the merchant registered with the gateway.
function checkAmountMatches(after, ledger) {
  const r = newResult('I2', 'Captured amount and currency equal the server-side order amount');
  const missing = lacks(after, 'orders', ['id', 'gatewayOrderId', 'isPaid', 'amount', 'currency']);
  if (!ledger) missing.push(NO_LEDGER);
  if (missing.length) {
    r.unverifiable.push({ reason: missing });
    return finalize(r);
  }
  const link = has(after, 'orders', 'paidPaymentId');
  for (const order of after.orders.filter((o) => o.isPaid)) {
    r.checked++;
    const gwOrder = ledger.orders[order.gatewayOrderId];
    if (!gwOrder) {
      r.unverifiable.push({ orderId: order.id, reason: ['gateway has no record of this order'] });
    } else if (gwOrder.amount !== order.amount || gwOrder.currency !== order.currency) {
      r.violations.push({ kind: 'order_amount_differs_from_gateway_order', order, gatewayOrder: gwOrder });
    }
    const b = paidOrderBacking(order, ledger, link);
    if (b.ok !== true) {
      r.unverifiable.push({ orderId: order.id, reason: ['no captured gateway payment to compare (see I1)'] });
      continue;
    }
    const matches = (p) => p.amount === order.amount && p.currency === order.currency;
    if (b.payment && !matches(b.payment)) {
      r.violations.push({ kind: 'captured_amount_mismatch', order, gatewayPayment: b.payment });
    } else if (b.candidates && !b.candidates.some(matches)) {
      r.violations.push({ kind: 'no_captured_payment_with_order_amount', order, gatewayPayments: b.candidates });
    }
  }
  return finalize(r);
}

// I3: each order is fulfilled at most once, only while paid, and stock moves once per fulfilled order.
function checkFulfilledOnce(before, after) {
  const r = newResult('I3', 'Each order is fulfilled at most once, only when paid, with one stock movement');
  const missing = lacks(after, 'fulfillments', ['orderId']);
  if (missing.length) {
    r.unverifiable.push({ reason: missing });
    return finalize(r);
  }
  const countBy = (snap) => {
    const m = new Map();
    for (const f of snap.fulfillments) m.set(f.orderId, [...(m.get(f.orderId) ?? []), f]);
    return m;
  };
  const afterByOrder = countBy(after);

  for (const [orderId, rows] of afterByOrder) {
    r.checked++;
    if (rows.length > 1) r.violations.push({ kind: 'duplicate_fulfilment', orderId, count: rows.length, fulfilments: rows });
  }

  // Fulfilment must belong to a paid order.
  const orderMissing = lacks(after, 'orders', ['id', 'isPaid']);
  if (orderMissing.length) {
    r.unverifiable.push({ check: 'fulfilment_requires_paid_order', reason: orderMissing });
  } else {
    const orders = new Map(after.orders.map((o) => [o.id, o]));
    for (const orderId of afterByOrder.keys()) {
      const order = orders.get(orderId);
      if (!order) r.violations.push({ kind: 'fulfilment_for_unknown_order', orderId });
      else if (!order.isPaid) r.violations.push({ kind: 'fulfilled_order_not_paid', order });
    }
  }

  // Stock: decrease per sku must equal the quantities of orders newly fulfilled between snapshots.
  const stockMissing = [
    ...(before ? [] : ['no baseline snapshot: stock movement cannot be measured']),
    ...lacks(after, 'fulfillments', ['sku', 'quantity']),
    ...(after.stock ? [] : ['stock not available']),
    ...(before && !before.stock ? ['stock not available in baseline'] : []),
    ...(before ? lacks(before, 'fulfillments', ['orderId']) : []),
  ];
  if (stockMissing.length) {
    r.unverifiable.push({ check: 'stock_moves_once', reason: stockMissing });
  } else {
    r.notes.push('stock check assumes nothing but fulfilment changes stock between snapshots');
    const beforeByOrder = countBy(before);
    const expected = {};
    for (const [orderId, rows] of afterByOrder) {
      if ((beforeByOrder.get(orderId)?.length ?? 0) > 0) continue;
      expected[rows[0].sku] = (expected[rows[0].sku] ?? 0) + rows[0].quantity;
    }
    for (const sku of new Set([...Object.keys(before.stock), ...Object.keys(after.stock)])) {
      const actual = (before.stock[sku] ?? 0) - (after.stock[sku] ?? 0);
      if (actual !== (expected[sku] ?? 0)) {
        r.violations.push({ kind: 'stock_delta_mismatch', sku, expectedDecrease: expected[sku] ?? 0, actualDecrease: actual });
      }
    }
  }
  return finalize(r);
}

// I4: once an order is validly paid, it stays paid; a captured payment record never regresses.
// Needs ordered snapshots: one end-state cannot tell a reversal from an event not yet delivered.
function checkPaidNotReversed(history, ledger) {
  const r = newResult('I4', 'A validly paid order never leaves paid; a captured payment never regresses');
  if (!Array.isArray(history) || history.length < 2) {
    r.unverifiable.push({ reason: ['needs at least two ordered snapshots; a single snapshot cannot distinguish a reversal from an undelivered event'] });
    return finalize(r);
  }
  const orderMissing = history.flatMap((s) => lacks(s, 'orders', ['id', 'gatewayOrderId', 'isPaid', 'amount', 'currency']));
  if (!ledger) orderMissing.push(NO_LEDGER);
  r.notes.push('observed only at snapshot boundaries; transitions inside one step are not seen');

  if (orderMissing.length) {
    r.unverifiable.push({ check: 'order_stays_paid', reason: [...new Set(orderMissing)] });
  } else {
    const link = history.every((s) => has(s, 'orders', 'paidPaymentId'));
    const validSince = new Map(); // orderId -> label of first snapshot where it was validly paid
    const reported = new Set();
    history.forEach((snap, step) => {
      const byId = new Map(snap.orders.map((o) => [o.id, o]));
      for (const [orderId, since] of validSince) {
        const now = byId.get(orderId);
        if ((!now || !now.isPaid) && !reported.has(orderId)) {
          reported.add(orderId);
          r.violations.push({
            kind: 'paid_order_reversed', orderId, paidSince: since,
            reversedAt: snap.label ?? step, statusNow: now ? now.status : '(row missing)',
          });
        }
      }
      for (const o of snap.orders) {
        if (!o.isPaid || validSince.has(o.id)) continue;
        const b = paidOrderBacking(o, ledger, link);
        const amountOk = b.ok && (b.payment ? b.payment.amount === o.amount && b.payment.currency === o.currency
          : b.candidates.some((p) => p.amount === o.amount && p.currency === o.currency));
        // Orders paid without gateway backing are I1/I2 violations; their later reversal is not flagged here.
        if (amountOk) {
          validSince.set(o.id, snap.label ?? step);
          r.checked++;
        }
      }
    });
  }

  const paymentMissing = history.flatMap((s) => lacks(s, 'payments', ['id', 'isCaptured']));
  if (paymentMissing.length) {
    r.unverifiable.push({ check: 'captured_payment_stays_captured', reason: [...new Set(paymentMissing)] });
  } else {
    const capturedSince = new Map();
    const reported = new Set();
    history.forEach((snap, step) => {
      const byId = new Map(snap.payments.map((p) => [p.id, p]));
      for (const [paymentId, since] of capturedSince) {
        const now = byId.get(paymentId);
        if ((!now || !now.isCaptured) && !reported.has(paymentId)) {
          reported.add(paymentId);
          r.violations.push({
            kind: 'captured_payment_regressed', paymentId, capturedSince: since,
            regressedAt: snap.label ?? step, statusNow: now ? now.status : '(row missing)',
          });
        }
      }
      for (const p of snap.payments) if (p.isCaptured && !capturedSince.has(p.id)) capturedSince.set(p.id, snap.label ?? step);
    });
  }
  return finalize(r);
}

// I5: total non-failed refunds per payment never exceed the amount the gateway captured.
function checkRefundsWithinCaptured(after, ledger) {
  const r = newResult('I5', 'Refunds per payment never exceed the captured amount');
  if (!ledger) {
    r.unverifiable.push({ reason: [NO_LEDGER] });
    return finalize(r);
  }
  const capturedAmount = (paymentId) => {
    const p = ledger.payments[paymentId];
    return everCaptured(p) ? p.amount : 0;
  };
  const sumBy = (rows) => {
    const m = new Map();
    for (const row of rows) m.set(row.paymentId, (m.get(row.paymentId) ?? 0) + row.amount);
    return m;
  };

  // Merchant's own refund records.
  const missing = lacks(after, 'refunds', ['paymentId', 'amount', 'counted']);
  if (missing.length) {
    r.unverifiable.push({ check: 'merchant_refunds', reason: missing });
  } else {
    for (const [paymentId, total] of sumBy(after.refunds.filter((x) => x.counted))) {
      r.checked++;
      const cap = capturedAmount(paymentId);
      if (total > cap) {
        r.violations.push({
          kind: cap === 0 ? 'refund_against_uncaptured_payment' : 'merchant_refunds_exceed_captured',
          paymentId, refundedTotal: total, capturedAmount: cap,
        });
      }
    }
  }

  // Refunds the simulated gateway accepted.
  for (const [paymentId, total] of sumBy(ledger.refunds.filter((x) => x.status !== 'failed'))) {
    const cap = capturedAmount(paymentId);
    if (total > cap) {
      r.violations.push({
        kind: 'gateway_refunds_exceed_captured', paymentId, refundedTotal: total, capturedAmount: cap,
        note: 'The simulator accepted these refunds. Real-gateway behaviour for this case may differ: see docs/GATEWAY_CONTRACT.md.',
      });
    }
  }
  return finalize(r);
}

// I6 is a test mode, not a state predicate: run I1-I5 after concurrent delivery batches.
function checkConcurrency() {
  const r = newResult('I6', 'I1-I5 hold under concurrent event processing');
  r.unverifiable.push({ reason: ['not a snapshot property: requires running I1-I5 after concurrent delivery batches, repeated (Phase 3)'] });
  return finalize(r);
}

// snapshots: ordered oldest -> newest. The first is the baseline when there are two or more.
function checkAll({ snapshots, ledger }) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) throw new Error('checkAll: at least one snapshot is required');
  const names = new Set(snapshots.map((s) => s.mapping));
  if (names.size > 1) throw new Error('checkAll: snapshots come from different mappings');
  const after = snapshots[snapshots.length - 1];
  const before = snapshots.length > 1 ? snapshots[0] : null;
  return [
    checkPaidHasCapture(after, ledger),
    checkAmountMatches(after, ledger),
    checkFulfilledOnce(before, after),
    checkPaidNotReversed(snapshots, ledger),
    checkRefundsWithinCaptured(after, ledger),
    checkConcurrency(),
  ];
}

module.exports = {
  STATUS,
  checkAll,
  checkPaidHasCapture,
  checkAmountMatches,
  checkFulfilledOnce,
  checkPaidNotReversed,
  checkRefundsWithinCaptured,
  checkConcurrency,
};
