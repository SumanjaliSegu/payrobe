'use strict';
// Two refunds, each equal to the captured amount, issued through the merchant's own refund route against
// one paid order. Neither request alone exceeds the captured amount, but their sum does. A correct merchant
// tracks refunds already made and rejects the second; a merchant that caps only each individual refund
// lets both through, refunding twice what was captured. Target invariant: I5 (refunds per payment never
// exceed the captured amount).
//
// Evidence and detection (verified 2026-10-14): the validator never makes a refund, so refund DB-mapping
// entries are cannot_verify and absent from the frozen mapping (frozen.refunds === null). I5's merchant-
// records branch therefore has nothing mapped to read, so detection here rests on the INDEPENDENT GATEWAY
// LEDGER: harness/ledger.js records every refund the mock gateway processed, and I5 reports
// `gateway_refunds_exceed_captured` when the non-failed refunds for a captured payment sum above the amount
// the gateway captured. A correct app rejects the second refund (no gateway call), so its ledger sum stays
// within captured and I5 reports no violation (it is cannot_verify there, never a false violation).
//
// Contract (docs/GATEWAY_CONTRACT.md "Refunds"):
//   [V]  a single refund greater than the captured amount is documented-rejected — so each refund here is
//        kept equal to (not above) the captured amount, avoiding the single-over-cap simulator artefact.
//   [U]  whether the cumulative sum of several refunds exceeding captured is rejected is NOT documented.
//   [A]  the mock gateway accepts every refund (unchanged, Option A); detection uses the independent ledger.
// The finding is a merchant cumulative-cap defect, conditional on [U]/[A]; it is NOT proven real-world money
// loss, because real-gateway cumulative-refund behaviour is undocumented.
const { requireStock } = require('../runner');

const ok2xx = (s) => s >= 200 && s < 300;

module.exports = {
  id: 'cumulative-refund-over-capture',
  title: 'Two refunds each equal to captured; cumulative sum exceeds captured',
  modes: ['sequential'],
  targets: ['I5'],
  contract: [
    {
      status: 'V',
      basis: 'documented',
      claim: 'A single refund greater than the captured amount is rejected, so each refund issued here is kept equal to the captured amount',
      ref: 'docs/GATEWAY_CONTRACT.md "Refunds: what the official docs establish"; https://razorpay.com/docs/api/refunds/create-normal/',
    },
    {
      status: 'U',
      basis: 'not-established',
      claim: 'Whether the cumulative sum of several refunds exceeding the captured amount is rejected is not documented',
      ref: 'docs/GATEWAY_CONTRACT.md "Refunds: what the docs do NOT establish" ([U] cumulative cap)',
    },
    {
      status: 'A',
      basis: 'mock-gateway',
      claim: 'The mock gateway accepts every refund (unchanged); detection uses the independent gateway ledger, not merchant DB rows (refund mapping is never behaviour-confirmed by the validator)',
      ref: 'docs/GATEWAY_CONTRACT.md "Current simulator contract"; harness/ledger.js',
    },
  ],
  // The refund route is present in the mapping but the validator never exercises it (like the verify route),
  // so it stays unconfirmed; selection requires only what a paid order and I5 need.
  requires: ['orders.paidValues', 'payments.capturedValues'],

  initialState: (snapshot) => requireStock(snapshot, { TSHIRT: 1 }),

  async play(ctx) {
    const order = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT', quantity: 1 }));
    ctx.fact('order', order);
    const paymentId = ctx.fact('paymentId', ctx.newPaymentId());
    await ctx.step('genuine capture', () => ctx.webhook(ctx.genuine('payment.captured', { paymentId, orderId: order.gatewayOrderId, amount: order.amount, currency: order.currency })));

    // Two refunds, each equal to the full captured amount (each individually within cap; cumulatively 2x).
    const r1 = await ctx.step('refund attempt 1 (full amount)', () => ctx.post('refund', { amount: order.amount }, { params: { orderId: order.orderId } }));
    ctx.fact('refund1Status', r1.status);
    const r2 = await ctx.step('refund attempt 2 (full amount again)', () => ctx.post('refund', { amount: order.amount }, { params: { orderId: order.orderId } }));
    ctx.fact('refund2Status', r2.status);
  },

  preconditions({ facts, ledger }) {
    const f = [];
    const p = ledger.payments[facts.paymentId];
    if (!p || !p.history.includes('captured')) f.push('ledger must hold the one genuine captured payment for the order');
    // The route must be real and reachable: the first refund must be accepted. The second refund's fate is
    // the behaviour under test, not a precondition (a correct app rejects it).
    if (!ok2xx(facts.refund1Status)) f.push(`refund route did not accept an initial within-cap refund (status ${facts.refund1Status})`);
    return f;
  },
};
