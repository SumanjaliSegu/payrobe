'use strict';
// Builds and signs Razorpay-shaped webhook events and checkout signatures.
// Shapes follow https://razorpay.com/docs/webhooks/ ; signing follows
// https://razorpay.com/docs/webhooks/validate-test/ (HMAC-SHA256 of the raw body)
// and the Standard Checkout docs (HMAC-SHA256 of "order_id|payment_id").
const crypto = require('node:crypto');

const rand = () => crypto.randomBytes(7).toString('hex');
const newPaymentId = () => `pay_${rand()}`;
const newEventId = () => `evt_${rand()}`;

function hmacHex(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

function checkoutSignature(razorpayOrderId, paymentId, keySecret) {
  return hmacHex(keySecret, `${razorpayOrderId}|${paymentId}`);
}

// type: payment.authorized | payment.captured | payment.failed
function paymentEvent(type, { paymentId, orderId, amount, currency = 'INR', createdAt }) {
  const status = type.split('.')[1];
  return {
    entity: 'event',
    account_id: 'acc_mock',
    event: type,
    contains: ['payment'],
    payload: {
      payment: {
        entity: { id: paymentId, entity: 'payment', amount, currency, status, order_id: orderId, method: 'upi', captured: status === 'captured' },
      },
    },
    created_at: createdAt ?? Math.floor(Date.now() / 1000),
  };
}

function refundEvent(type, { refundId, paymentId, amount, currency = 'INR', status = 'processed' }) {
  return {
    entity: 'event',
    account_id: 'acc_mock',
    event: type,
    contains: ['refund'],
    payload: { refund: { entity: { id: refundId, entity: 'refund', payment_id: paymentId, amount, currency, status } } },
    created_at: Math.floor(Date.now() / 1000),
  };
}

// Sends one webhook delivery. rawBody can be overridden to test byte-level handling.
// A wrong or missing secret produces an invalid or absent signature.
async function deliverWebhook(baseUrl, event, { secret, eventId = newEventId(), rawBody, signature } = {}) {
  const body = rawBody ?? JSON.stringify(event);
  const headers = { 'content-type': 'application/json', 'x-razorpay-event-id': eventId };
  const sig = signature ?? (secret ? hmacHex(secret, body) : undefined);
  if (sig) headers['x-razorpay-signature'] = sig;
  const res = await fetch(`${baseUrl}/webhooks/razorpay`, { method: 'POST', headers, body });
  return { status: res.status, eventId, body: await res.text() };
}

module.exports = { newPaymentId, newEventId, hmacHex, checkoutSignature, paymentEvent, refundEvent, deliverWebhook };
