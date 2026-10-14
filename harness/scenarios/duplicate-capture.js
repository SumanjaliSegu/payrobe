'use strict';
// One genuine payment.captured webhook delivered twice, byte-identical (same event id, body and
// signature), under concurrent delivery. A correct merchant deduplicates by event id inside one atomic
// transaction; a check-then-act across an await lets both deliveries fulfil the order and decrement stock
// twice. Target invariant: I3 (at most one fulfilment per order; stock moves once).
//
// This is the runner-driven, isolated, file-backed counterpart of the original in-memory experiment in
// test/scenarios/duplicate-captured.test.js, which is left unchanged as the baseline. Concurrency evidence
// comes from the runner/concurrency classifier: a run only counts as a violation when both requests are
// proven to overlap at the server AND I3 is violated, so a non-overlapping run can never be a finding.
//
// Contract: duplicate webhook delivery is documented ([V], see docs/GATEWAY_CONTRACT.md "Webhook delivery,
// payload and signature": deliveries may arrive more than once; dedupe by x-razorpay-event-id). The
// concurrency of two in-flight deliveries is a property of the test harness, proven per run, not an
// assumption about the gateway.
const { requireStock } = require('../runner');

module.exports = {
  id: 'duplicate-capture',
  title: 'Duplicate delivery of one genuine payment.captured, delivered concurrently',
  // Barrier first: it gives the strongest overlap proof (both requests held in the server, released
  // together). 'simultaneous' is a fallback; both require verified overlap to count.
  modes: ['barrier', 'simultaneous'],
  targets: ['I3'],
  contract: [
    {
      status: 'V',
      basis: 'documented',
      claim: 'A webhook may be delivered more than once with the same x-razorpay-event-id; the merchant must process it idempotently',
      ref: 'docs/GATEWAY_CONTRACT.md "Webhook delivery, payload and signature"; https://razorpay.com/docs/webhooks/best-practices/',
    },
  ],
  requires: ['routes.webhook', 'orders.paidValues', 'payments.capturedValues', 'fulfillments.table', 'fulfillments.columns.orderId', 'stock.columns.quantity'],

  // Needs stock to fall by the ordered quantity; quantity 2 keeps a double-decrement visible.
  initialState: (snapshot) => requireStock(snapshot, { TSHIRT: 2 }),

  async play(ctx) {
    const order = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT', quantity: 2 }));
    ctx.fact('order', order);
    const paymentId = ctx.fact('paymentId', ctx.newPaymentId());
    const event = ctx.genuine('payment.captured', { paymentId, orderId: order.gatewayOrderId, amount: order.amount, currency: order.currency });
    await ctx.step('duplicate capture (concurrent)', () => ctx.deliverTwice(event));
  },

  preconditions({ record, facts, ledger }) {
    const f = [];
    const p = ledger.payments[facts.paymentId];
    if (!p || !p.history.includes('captured')) f.push('ledger must hold exactly the one genuine captured payment');
    if (Object.keys(ledger.payments).length !== 1) f.push(`ledger must hold one payment, has ${Object.keys(ledger.payments).length}`);
    const d = record.concurrency.deliveries[0];
    if (!d) f.push('no concurrent delivery was recorded');
    return f;
  },
};
