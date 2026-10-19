'use strict';
// A genuine, correctly signed payment.captured whose amount differs from the order's amount.
//
// CONDITIONAL [U], TEMPORARY: docs/GATEWAY_CONTRACT.md ("Captured amount vs order amount") does not
// establish that a real captured payment can carry an amount different from its gateway order, and the
// documented capture rules point against it: the capture amount "should be equal to the order amount".
// Partial payments exist (order-level `partial_payment`), but our fixtures never create such orders, so
// they do not apply here. This is not documented Razorpay behaviour and not a confirmed real-world
// vulnerability. Any violation found holds only if the gateway can produce such an event, and must be
// reported with that condition, never as established money loss.
// If the required behaviour cannot be established, this experiment must be redesigned (for example
// against a fixture that creates `partial_payment` orders) or retired.
//
// A control order paid with the correct amount keeps I2 non-vacuous on an app that rightly refuses
// to mark the mismatched order paid.
const { requireStock } = require('../runner');
const MISMATCH_AMOUNT = 100; // paise

module.exports = {
  id: 'captured-amount-mismatch',
  title: 'Genuine capture with an amount different from the order amount [U]',
  modes: ['sequential'],
  targets: ['I2'],
  contract: [
    {
      status: 'U',
      basis: 'not-established',
      claim: 'A genuine payment.captured can carry an amount different from the amount of the gateway order it belongs to (not established; documented capture rules point against it for orders without partial_payment, which is all our fixtures create)',
      ref: 'docs/GATEWAY_CONTRACT.md "Captured amount vs order amount"; https://razorpay.com/docs/api/payments/capture/ (amount "should be equal to the order amount"); redesign or retire if the behaviour cannot be established',
    },
  ],

  requires: ['payments.table', 'payments.columns.amount', 'payments.capturedValues', 'orders.paidValues'],

  // The products the attack buys must exist with stock; the runner also requires no prior orders.
  initialState: (snapshot) => requireStock(snapshot, { TSHIRT: 1, HOODIE: 1 }),

  async play(ctx) {
    const { control, target } = await ctx.step('create orders', async () => ({
      control: await ctx.createOrder({ sku: 'TSHIRT', quantity: 1 }),
      target: await ctx.createOrder({ sku: 'HOODIE', quantity: 1 }),
    }));
    ctx.fact('controlOrder', control);
    ctx.fact('targetOrder', target);

    const controlPayment = ctx.fact('controlPaymentId', ctx.newPaymentId());
    await ctx.step('genuine capture for the control order (order amount)', () =>
      ctx.webhook(ctx.genuine('payment.captured', { paymentId: controlPayment, orderId: control.gatewayOrderId, amount: control.amount, currency: control.currency })));

    const targetPayment = ctx.fact('targetPaymentId', ctx.newPaymentId());
    ctx.fact('capturedAmount', MISMATCH_AMOUNT);
    await ctx.step('genuine capture for the target order with a different amount', () =>
      ctx.webhook(ctx.genuine('payment.captured', { paymentId: targetPayment, orderId: target.gatewayOrderId, amount: MISMATCH_AMOUNT, currency: target.currency })));
  },

  preconditions({ facts, ledger, final }) {
    const f = [];
    const { controlOrder: control, targetOrder: target } = facts;
    const gwTarget = ledger.orders[target.gatewayOrderId];
    const p = ledger.payments[facts.targetPaymentId];
    if (!gwTarget || !p) f.push('ledger must hold the target order and its captured payment');
    else if (p.amount === gwTarget.amount) f.push('the captured amount must differ from the gateway order amount');
    if (!final.orders?.find((o) => o.id === control.orderId)?.isPaid) f.push('control order is not paid after its genuine capture');
    return f;
  },
};
