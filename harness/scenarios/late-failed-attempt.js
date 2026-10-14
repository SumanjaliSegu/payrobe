'use strict';
// One order, two payment attempts with different payment ids: the first fails, the second is captured.
// The first attempt's payment.failed is delivered after the second attempt's payment.captured.
// Every event is genuine and correctly signed; only the delivery order is adversarial.
//
// The same payment going from captured to failed is deliberately not modelled: that is not documented
// gateway behaviour.
//
// Contract labels (docs/GATEWAY_CONTRACT.md, "Payment attempts and event order"): several attempts per order
// and out-of-order webhook delivery are documented [V]. The exact sequence sent here is an inference from those
// facts, and modelling both attempts on one gateway order rests on an unresolved conflict in the docs.
// Not the same thing: the docs also describe payment.failed followed by payment.captured for the *same*
// payment (late authorisation). This scenario does not model that; its failure belongs to a different
// payment attempt (different payment id).
// Label convention: `status` stays V/U/A as the runner requires; `basis` carries the finer class used in
// GATEWAY_CONTRACT.md ('documented', 'inference', 'unresolved').
const { requireStock } = require('../runner');

module.exports = {
  id: 'late-failed-attempt',
  title: 'Failure of an earlier payment attempt delivered after a later capture',
  modes: ['sequential'],
  targets: ['I4'],
  contract: [
    {
      status: 'V',
      basis: 'documented',
      claim: 'An order can have several payment attempts, successful and failed, and stays attempted until one payment associated with it is captured',
      ref: 'docs/GATEWAY_CONTRACT.md "Payment attempts and event order"; https://razorpay.com/docs/api/orders/entity/ (attempts, status); https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/best-practices/ ("Integrate Orders API")',
    },
    {
      status: 'V',
      basis: 'documented',
      claim: 'Webhooks may not be received in order, and failed deliveries are retried with exponential backoff for 24 hours',
      ref: 'docs/GATEWAY_CONTRACT.md "Payment attempts and event order"; https://razorpay.com/docs/webhooks/best-practices/',
    },
    {
      status: 'A',
      basis: 'unresolved',
      claim: 'Unresolved: both attempts share one gateway order (the Checkout-retry case); the create-order docs say an order maps 1:1 to a payment attempt and that a merchant-initiated retry needs a new order',
      ref: 'docs/GATEWAY_CONTRACT.md "Conflicting guidance"; https://razorpay.com/docs/api/orders/create/ ("Watch Out: Create a new order for every payment attempt")',
    },
    {
      status: 'A',
      basis: 'inference',
      claim: 'Inference: the earlier attempt\'s payment.failed (a different payment id) can be delivered after the later attempt\'s payment.captured; the docs do not describe this specific sequence',
      ref: 'docs/GATEWAY_CONTRACT.md "Payment attempts and event order" (inference row)',
    },
  ],

  requires: ['routes.webhook', 'orders.paidValues', 'payments.capturedValues'],

  // The products the attack buys must exist with stock; the runner also requires no prior orders.
  initialState: (snapshot) => requireStock(snapshot, { TSHIRT: 1 }),

  async play(ctx) {
    const order = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT', quantity: 1 }));
    ctx.fact('order', order);
    const firstAttempt = ctx.fact('failedPaymentId', ctx.newPaymentId());
    const secondAttempt = ctx.fact('capturedPaymentId', ctx.newPaymentId());
    const fields = { orderId: order.gatewayOrderId, amount: order.amount, currency: order.currency };
    // Gateway order of events: the first attempt fails, then the second is captured.
    const failed = ctx.genuine('payment.failed', { paymentId: firstAttempt, ...fields });
    const captured = ctx.genuine('payment.captured', { paymentId: secondAttempt, ...fields });

    await ctx.step('deliver capture of the second attempt', () => ctx.webhook(captured));
    await ctx.step('deliver late failure of the first attempt', () => ctx.webhook(failed));
  },

  preconditions({ record, facts, ledger }) {
    const f = [];
    const p1 = ledger.payments[facts.failedPaymentId];
    const p2 = ledger.payments[facts.capturedPaymentId];
    if (facts.failedPaymentId === facts.capturedPaymentId) f.push('attempts must have different payment ids');
    if (p1?.history.join() !== 'failed') f.push('ledger: first attempt must have failed and never been captured');
    if (p2?.history.join() !== 'captured') f.push('ledger: second attempt must be captured');
    if (p1?.orderId !== facts.order.gatewayOrderId || p2?.orderId !== facts.order.gatewayOrderId) f.push('ledger: both attempts must belong to the order');
    const afterCapture = record.snapshots.find((s) => s.label === 'deliver capture of the second attempt');
    if (!afterCapture?.orders?.find((o) => o.id === facts.order.orderId)?.isPaid) f.push('order is not paid after the capture, so there is no paid state to protect');
    return f;
  },
};
