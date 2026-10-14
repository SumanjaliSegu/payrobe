'use strict';
// A genuine checkout signature for a cheap order is presented to the checkout callback for an
// expensive order. Derived from the Standard Checkout protocol: the browser receives
// razorpay_order_id, razorpay_payment_id and razorpay_signature = HMAC(key secret, "order_id|payment_id"),
// and the merchant must check that signature against its *own* gateway order id for the order.
//
// The verify route is taken from the frozen mapping, where it carries method and path only and is never
// exercised by the validator, so it stays unconfirmed in every record. A control step (the genuine
// callback for the cheap order's own fields) must be accepted before the attack step is interpreted.
//
// Contract labels (docs/GATEWAY_CONTRACT.md, "Standard Checkout signature"): the checkout fields, the signed
// value and the merchant's duty to verify against its stored order id are documented [V]. The route and its
// body are specific to our fixtures. That a signature for one order can be replayed against another is an
// inference: the docs do not describe it as an attack, and they do not show that any real merchant app is
// exploitable. A result here says only how one fixture app handled the replay.
// Label convention: `status` stays V/U/A as the runner requires; `basis` carries the finer class used in
// GATEWAY_CONTRACT.md ('documented', 'fixture-specific' = [F], 'inference').
const { requireStock } = require('../runner');
const ok2xx = (s) => s >= 200 && s < 300;

module.exports = {
  id: 'cross-order-checkout-signature',
  title: 'Checkout signature for one order presented for another order',
  modes: ['sequential'],
  targets: ['I1'],
  contract: [
    {
      status: 'V',
      basis: 'documented',
      claim: 'Standard Checkout gives the browser razorpay_order_id, razorpay_payment_id and razorpay_signature = HMAC-SHA256(key_secret, order_id + "|" + razorpay_payment_id), and the merchant must verify it against the order_id stored on its server, not the razorpay_order_id returned by Checkout',
      ref: 'docs/GATEWAY_CONTRACT.md "Standard Checkout signature"; https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/ ("3 Handle Payment Success and Failure", "5 Verify Payment Signature")',
    },
    {
      status: 'A',
      basis: 'fixture-specific',
      claim: 'Fixture-specific: the checkout callback route accepts those three fields plus the merchant order id returned at order creation; route and body are not confirmed by validation',
      ref: 'docs/GATEWAY_CONTRACT.md [F]; mapping v2 routes.verify (method and path only; validator never exercises it)',
    },
    {
      status: 'A',
      basis: 'inference',
      claim: 'Inference: a customer who pays a cheap order holds a valid signature for it and can present it in the callback for another order; not described by the docs as an attack, and not shown to apply to any real merchant app',
      ref: 'docs/GATEWAY_CONTRACT.md "Standard Checkout signature" (inference row)',
    },
  ],

  // Entries that must be validator-confirmed for this scenario to be selected by the investigator.
  requires: ['orders.table', 'orders.columns.id', 'orders.columns.gatewayOrderId', 'orders.paidValues'],

  // The products the attack buys must exist with stock; the runner also requires no prior orders.
  initialState: (snapshot) => requireStock(snapshot, { STICKER: 1, HOODIE: 1 }),

  async play(ctx) {
    const orderKey = ctx.routeSpec('createOrder').response?.orderId ?? 'order_id';
    const { cheap, target } = await ctx.step('create orders', async () => ({
      cheap: await ctx.createOrder({ sku: 'STICKER', quantity: 1 }),
      target: await ctx.createOrder({ sku: 'HOODIE', quantity: 1 }),
    }));
    ctx.fact('cheapOrder', cheap);
    ctx.fact('targetOrder', target);

    const paymentId = ctx.fact('paymentId', ctx.newPaymentId());
    await ctx.step('genuine capture for the cheap order', () =>
      ctx.webhook(ctx.genuine('payment.captured', { paymentId, orderId: cheap.gatewayOrderId, amount: cheap.amount, currency: cheap.currency })));

    const signature = ctx.checkoutSignature(cheap.gatewayOrderId, paymentId);
    const callback = (orderId) => ({
      [orderKey]: orderId,
      razorpay_order_id: cheap.gatewayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature,
    });
    const control = await ctx.step('control: genuine checkout callback for the cheap order', () =>
      ctx.post('verify', callback(cheap.orderId), { meta: { control: true } }));
    ctx.fact('controlStatus', control.status);

    const attack = await ctx.step('attack: cheap order signature presented for the target order', () =>
      ctx.post('verify', callback(target.orderId)));
    ctx.fact('attackStatus', attack.status);
  },

  preconditions({ facts, ledger, final }) {
    const f = [];
    const { cheapOrder: cheap, targetOrder: target, paymentId } = facts;
    if (!(cheap?.amount < target?.amount)) f.push('the cheap order must cost less than the target order');
    const p = ledger.payments[paymentId];
    if (!p || p.orderId !== cheap.gatewayOrderId || !p.history.includes('captured')) f.push('ledger must hold one captured payment for the cheap order');
    if (Object.values(ledger.payments).some((x) => x.orderId === target.gatewayOrderId)) f.push('the gateway must hold no payment for the target order');
    if (!ok2xx(facts.controlStatus)) f.push(`control: checkout callback route did not accept the genuine callback for its own order (${facts.controlStatus})`);
    if (!final.orders?.find((o) => o.id === cheap.orderId)?.isPaid) f.push('the cheap order is not paid after its genuine capture');
    return f;
  },
};
