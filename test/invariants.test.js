'use strict';
// Unit tests for the invariant checker on hand-built valid and invalid snapshots.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const inv = require('../harness/invariants');
const { snap, order, paidOrder, ledger, gwOrder, gwPayment } = require('./fixtures');

const { PASS, VIOLATION, CANNOT_VERIFY } = inv.STATUS;
const kinds = (r) => r.violations.map((v) => v.kind).sort();

describe('I1 paid order has a captured gateway payment', () => {
  const L = ledger({ orders: [gwOrder('A'), gwOrder('B')], payments: [gwPayment('pay_A', 'A')] });

  it('passes when the paid order links to a payment the gateway captured for it', () => {
    const r = inv.checkPaidHasCapture(snap('s', { orders: [paidOrder('A', 'pay_A'), order('B')] }), L);
    assert.equal(r.status, PASS);
    assert.equal(r.checked, 1);
  });

  it('flags a paid order whose payment the gateway never saw', () => {
    const r = inv.checkPaidHasCapture(snap('s', { orders: [paidOrder('B', 'pay_forged')] }), L);
    assert.equal(r.status, VIOLATION);
    assert.deepEqual(kinds(r), ['paid_payment_unknown_to_gateway']);
  });

  it('flags a paid order backed by a capture for a different order', () => {
    const r = inv.checkPaidHasCapture(snap('s', { orders: [paidOrder('B', 'pay_A')] }), L);
    assert.deepEqual(kinds(r), ['paid_with_payment_for_other_order']);
  });

  it('flags a paid order whose payment was only authorized', () => {
    const L2 = ledger({ orders: [gwOrder('A')], payments: [gwPayment('pay_A', 'A', { status: 'authorized' })] });
    const r = inv.checkPaidHasCapture(snap('s', { orders: [paidOrder('A', 'pay_A')] }), L2);
    assert.deepEqual(kinds(r), ['paid_payment_not_captured']);
  });

  it('accepts a capture that followed an earlier failure (late authorisation)', () => {
    const L2 = ledger({ orders: [gwOrder('A')], payments: [gwPayment('pay_A', 'A', { history: ['failed', 'captured'] })] });
    assert.equal(inv.checkPaidHasCapture(snap('s', { orders: [paidOrder('A', 'pay_A')] }), L2).status, PASS);
  });

  it('falls back to gateway order id when the payment link is not mapped, and says so', () => {
    const s = snap('s', { orders: [paidOrder('A', null), paidOrder('B', null)] }, { omit: { orders: ['paidPaymentId'] } });
    const r = inv.checkPaidHasCapture(s, L);
    assert.deepEqual(kinds(r), ['no_captured_payment_for_order']);
    assert.match(r.notes.join(' '), /not mapped/);
  });

  it('cannot verify without a ledger, even if merchant records look fine', () => {
    const r = inv.checkPaidHasCapture(snap('s', { orders: [paidOrder('A', 'pay_A')] }), null);
    assert.equal(r.status, CANNOT_VERIFY);
  });

  it('cannot verify when the paid status is not mapped', () => {
    const r = inv.checkPaidHasCapture(snap('s', { orders: [paidOrder('A', 'pay_A')] }, { omit: { orders: ['isPaid'] } }), L);
    assert.equal(r.status, CANNOT_VERIFY);
  });

  it('is a vacuous pass when nothing is paid', () => {
    const r = inv.checkPaidHasCapture(snap('s', { orders: [order('A')] }), L);
    assert.equal(r.status, PASS);
    assert.equal(r.vacuous, true);
  });
});

describe('I2 captured amount equals server-side order amount', () => {
  it('passes when amounts and currencies agree', () => {
    const L = ledger({ orders: [gwOrder('A')], payments: [gwPayment('pay_A', 'A')] });
    assert.equal(inv.checkAmountMatches(snap('s', { orders: [paidOrder('A', 'pay_A')] }), L).status, PASS);
  });

  it('flags a capture for less than the order amount', () => {
    const L = ledger({ orders: [gwOrder('A', 499900)], payments: [gwPayment('pay_A', 'A', { amount: 100 })] });
    const r = inv.checkAmountMatches(snap('s', { orders: [paidOrder('A', 'pay_A', { amount: 499900 })] }), L);
    assert.deepEqual(kinds(r), ['captured_amount_mismatch']);
  });

  it('flags a currency mismatch', () => {
    const L = ledger({ orders: [gwOrder('A')], payments: [gwPayment('pay_A', 'A', { currency: 'USD' })] });
    assert.deepEqual(kinds(inv.checkAmountMatches(snap('s', { orders: [paidOrder('A', 'pay_A')] }), L)), ['captured_amount_mismatch']);
  });

  it('flags an order amount that differs from the amount registered with the gateway', () => {
    // Merchant row says 100, the merchant registered 49900 with the gateway, and 100 was captured.
    const L = ledger({ orders: [gwOrder('A', 49900)], payments: [gwPayment('pay_A', 'A', { amount: 100 })] });
    const r = inv.checkAmountMatches(snap('s', { orders: [paidOrder('A', 'pay_A', { amount: 100 })] }), L);
    assert.deepEqual(kinds(r), ['order_amount_differs_from_gateway_order']);
  });

  it('cannot verify when no gateway payment backs the order', () => {
    const L = ledger({ orders: [gwOrder('A')] });
    assert.equal(inv.checkAmountMatches(snap('s', { orders: [paidOrder('A', 'pay_x')] }), L).status, CANNOT_VERIFY);
  });

  it('cannot verify when the amount column is not mapped', () => {
    const L = ledger({ orders: [gwOrder('A')], payments: [gwPayment('pay_A', 'A')] });
    const s = snap('s', { orders: [paidOrder('A', 'pay_A')] }, { omit: { orders: ['amount'] } });
    assert.equal(inv.checkAmountMatches(s, L).status, CANNOT_VERIFY);
  });
});

describe('I3 fulfilled at most once, only when paid, stock moves once', () => {
  const ful = (orderId, quantity = 1, sku = 'TSHIRT') => ({ orderId, sku, quantity });
  const before = snap('before', { orders: [order('A')], fulfillments: [], stock: { TSHIRT: 10 } });

  it('passes for one fulfilment and a matching stock decrease', () => {
    const after = snap('after', { orders: [paidOrder('A', 'p')], fulfillments: [ful('A', 3)], stock: { TSHIRT: 7 } });
    const r = inv.checkFulfilledOnce(before, after);
    assert.equal(r.status, PASS, JSON.stringify(r.violations));
  });

  it('flags duplicate fulfilment and the extra stock decrease', () => {
    const after = snap('after', { orders: [paidOrder('A', 'p')], fulfillments: [ful('A', 3), ful('A', 3)], stock: { TSHIRT: 4 } });
    assert.deepEqual(kinds(inv.checkFulfilledOnce(before, after)), ['duplicate_fulfilment', 'stock_delta_mismatch']);
  });

  it('flags fulfilment of an order that is not paid', () => {
    const after = snap('after', { orders: [order('A', { status: 'failed' })], fulfillments: [ful('A')], stock: { TSHIRT: 9 } });
    assert.deepEqual(kinds(inv.checkFulfilledOnce(before, after)), ['fulfilled_order_not_paid']);
  });

  it('flags a stock decrease with no fulfilment', () => {
    const after = snap('after', { orders: [order('A')], fulfillments: [], stock: { TSHIRT: 8 } });
    assert.deepEqual(kinds(inv.checkFulfilledOnce(before, after)), ['stock_delta_mismatch']);
  });

  it('cannot verify stock movement without a baseline, but still reports what it can', () => {
    const ok = snap('after', { orders: [paidOrder('A', 'p')], fulfillments: [ful('A')], stock: { TSHIRT: 9 } });
    assert.equal(inv.checkFulfilledOnce(null, ok).status, CANNOT_VERIFY);
    const dup = snap('after', { orders: [paidOrder('A', 'p')], fulfillments: [ful('A'), ful('A')], stock: { TSHIRT: 8 } });
    assert.equal(inv.checkFulfilledOnce(null, dup).status, VIOLATION);
  });

  it('cannot verify when fulfilments are not mapped', () => {
    assert.equal(inv.checkFulfilledOnce(before, snap('after', { fulfillments: null })).status, CANNOT_VERIFY);
  });
});

describe('I4 validly paid orders are never reversed', () => {
  const L = ledger({ orders: [gwOrder('A')], payments: [gwPayment('pay_A', 'A')] });
  const pay = (status) => [{ id: 'pay_A', gatewayOrderId: 'order_A', amount: 49900, currency: 'INR', status, isCaptured: status === 'captured' }];

  it('passes when a paid order stays paid', () => {
    const h = [
      snap('s0', { orders: [order('A')], payments: [] }),
      snap('s1', { orders: [paidOrder('A', 'pay_A')], payments: pay('captured') }),
      snap('s2', { orders: [paidOrder('A', 'pay_A')], payments: pay('captured') }),
    ];
    const r = inv.checkPaidNotReversed(h, L);
    assert.equal(r.status, PASS);
    assert.equal(r.checked, 1);
  });

  it('flags a paid order that later leaves paid, with both snapshot labels', () => {
    const h = [
      snap('s1', { orders: [paidOrder('A', 'pay_A')], payments: pay('captured') }),
      snap('s2', { orders: [order('A', { status: 'failed', paidPaymentId: 'pay_A' })], payments: pay('captured') }),
    ];
    const r = inv.checkPaidNotReversed(h, L);
    assert.deepEqual(kinds(r), ['paid_order_reversed']);
    assert.equal(r.violations[0].paidSince, 's1');
    assert.equal(r.violations[0].reversedAt, 's2');
    assert.equal(r.violations[0].statusNow, 'failed');
  });

  it('flags a captured payment record that regresses', () => {
    const h = [
      snap('s1', { orders: [paidOrder('A', 'pay_A')], payments: pay('captured') }),
      snap('s2', { orders: [paidOrder('A', 'pay_A')], payments: pay('failed') }),
    ];
    assert.deepEqual(kinds(inv.checkPaidNotReversed(h, L)), ['captured_payment_regressed']);
  });

  it('does not flag reversal of a paid state the gateway never backed (that is I1)', () => {
    const h = [
      snap('s1', { orders: [paidOrder('A', 'pay_forged')], payments: [] }),
      snap('s2', { orders: [order('A')], payments: [] }),
    ];
    assert.equal(inv.checkPaidNotReversed(h, L).violations.length, 0);
  });

  it('cannot verify from a single snapshot', () => {
    const r = inv.checkPaidNotReversed([snap('s', { orders: [order('A', { status: 'failed' })] })], L);
    assert.equal(r.status, CANNOT_VERIFY);
  });

  it('cannot verify the payment part when payments are not mapped', () => {
    const h = [snap('s1', { orders: [paidOrder('A', 'pay_A')], payments: null }), snap('s2', { orders: [paidOrder('A', 'pay_A')], payments: null })];
    assert.equal(inv.checkPaidNotReversed(h, L).status, CANNOT_VERIFY);
  });
});

describe('I5 refunds never exceed captured', () => {
  const L = (refunds = []) => ledger({ orders: [gwOrder('A')], payments: [gwPayment('pay_A', 'A')], refunds });
  const rf = (amount, status = 'processed') => ({ id: `rf_${amount}_${status}`, paymentId: 'pay_A', amount, status, counted: status !== 'failed' });

  it('passes for partial refunds within the captured amount', () => {
    assert.equal(inv.checkRefundsWithinCaptured(snap('s', { refunds: [rf(20000), rf(29900)] }), L()).status, PASS);
  });

  it('flags cumulative refunds above the captured amount', () => {
    const r = inv.checkRefundsWithinCaptured(snap('s', { refunds: [rf(30000), rf(30000)] }), L());
    assert.deepEqual(kinds(r), ['merchant_refunds_exceed_captured']);
    assert.equal(r.violations[0].refundedTotal, 60000);
  });

  it('does not count failed refunds', () => {
    assert.equal(inv.checkRefundsWithinCaptured(snap('s', { refunds: [rf(49900), rf(49900, 'failed')] }), L()).status, PASS);
  });

  it('flags a refund against a payment the gateway never captured', () => {
    const s = snap('s', { refunds: [{ id: 'r', paymentId: 'pay_nope', amount: 100, status: 'processed', counted: true }] });
    assert.deepEqual(kinds(inv.checkRefundsWithinCaptured(s, L())), ['refund_against_uncaptured_payment']);
  });

  it('flags refunds the simulated gateway accepted beyond the captured amount, with a realism note', () => {
    const r = inv.checkRefundsWithinCaptured(snap('s', { refunds: [] }), L([
      { id: 'g1', paymentId: 'pay_A', amount: 40000, status: 'processed' },
      { id: 'g2', paymentId: 'pay_A', amount: 40000, status: 'processed' },
    ]));
    assert.deepEqual(kinds(r), ['gateway_refunds_exceed_captured']);
    assert.match(r.violations[0].note, /GATEWAY_CONTRACT/);
  });

  it('cannot verify when the refund status is not mapped', () => {
    const s = snap('s', { refunds: [rf(100)] }, { omit: { refunds: ['counted'] } });
    assert.equal(inv.checkRefundsWithinCaptured(s, L()).status, CANNOT_VERIFY);
  });
});

describe('I6 and checkAll', () => {
  it('I6 is always cannot_verify: it is a test mode, not a snapshot property', () => {
    assert.equal(inv.checkConcurrency().status, CANNOT_VERIFY);
  });

  it('checkAll returns I1-I6 in order and rejects mixed mappings', () => {
    const s = snap('s', { orders: [order('A')] });
    assert.deepEqual(inv.checkAll({ snapshots: [s], ledger: ledger() }).map((r) => r.id), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6']);
    assert.throws(() => inv.checkAll({ snapshots: [s, { ...s, mapping: 'other' }], ledger: ledger() }), /different mappings/);
  });
});
