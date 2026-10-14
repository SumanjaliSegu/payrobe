'use strict';
// Mapping v2 for the vulnerable app, with source evidence for every entry.
// Provenance: HAND-WRITTEN by reading merchant/vulnerable/{schema.sql,app.js}, merchant/server.js and
// merchant/config.js. Its schema has no CHECK constraints, so status values are cited from the code.
// Evidence paths are relative to the repository root.
const { SCHEMA_ID, entry: e } = require('../../mapping-v2');

const APP = 'merchant/vulnerable/app.js';
const SQL = 'merchant/vulnerable/schema.sql';

module.exports = {
  schema: SCHEMA_ID,
  name: 'vulnerable',
  provenance: 'hand-written',
  launch: {
    command: e({ argv: ['node', 'merchant/server.js', '--impl', 'vulnerable'], cwd: '.' }, ['merchant/server.js:3', 'package.json:12']),
    port: e({ via: 'arg', name: '--port' }, ['merchant/server.js:19']),
    dbPath: e({ via: 'arg', name: '--db' }, ['merchant/server.js:20']),
    webhookSecret: e({ via: 'env', name: 'RZP_WEBHOOK_SECRET' }, ['merchant/config.js:17']),
    keySecret: e({ via: 'env', name: 'RZP_KEY_SECRET' }, ['merchant/config.js:16']),
  },
  routes: {
    createOrder: e({
      method: 'POST',
      path: '/api/orders',
      body: { sku: '{sku}', quantity: '{quantity}' },
      sample: { sku: 'TSHIRT', quantity: 2 },
      response: { orderId: 'order_id', gatewayOrderId: 'razorpay_order_id', amount: 'amount', currency: 'currency' },
    }, [`${APP}:43`, `${APP}:44`, `${APP}:52`, `${SQL}:50`]),
    webhook: e({
      method: 'POST',
      path: '/webhooks/razorpay',
      signatureHeader: 'x-razorpay-signature',
      eventIdHeader: null, // the handler does not read an event id
    }, [`${APP}:65`, `${APP}:67`]),
    verify: e({ method: 'POST', path: '/api/payments/verify' }, [`${APP}:55`]),
    refund: e({ method: 'POST', path: '/api/orders/{orderId}/refunds' }, [`${APP}:88`]),
  },
  orders: {
    table: e('orders', [`${SQL}:8`]),
    columns: {
      id: e('id', [`${SQL}:9`]),
      gatewayOrderId: e('razorpay_order_id', [`${SQL}:10`]),
      amount: e('amount', [`${SQL}:13`]),
      currency: e('currency', [`${SQL}:14`]),
      status: e('status', [`${SQL}:15`]),
      paidPaymentId: e('paid_payment_id', [`${SQL}:16`]),
    },
    paidValues: e(['paid'], [`${APP}:31`]),
  },
  payments: {
    table: e('payments', [`${SQL}:21`]),
    columns: {
      id: e('id', [`${SQL}:22`]),
      gatewayOrderId: e('razorpay_order_id', [`${SQL}:23`]),
      amount: e('amount', [`${SQL}:24`]),
      currency: e('currency', [`${SQL}:25`]),
      status: e('status', [`${SQL}:26`]),
    },
    capturedValues: e(['captured'], [`${APP}:72`]),
  },
  fulfillments: {
    table: e('fulfillments', [`${SQL}:30`]),
    columns: {
      orderId: e('order_id', [`${SQL}:32`]),
      sku: e('sku', [`${SQL}:33`]),
      quantity: e('quantity', [`${SQL}:34`]),
    },
  },
  refunds: {
    table: e('refunds', [`${SQL}:38`]),
    columns: {
      id: e('id', [`${SQL}:39`]),
      paymentId: e('payment_id', [`${SQL}:42`]),
      amount: e('amount', [`${SQL}:43`]),
      status: e('status', [`${SQL}:44`]),
    },
    // The code never writes a failed refund; carried over from v1 without source evidence.
    notCountedValues: e(['failed'], [], { confidence: 'medium' }),
  },
  stock: {
    table: e('products', [`${SQL}:1`]),
    columns: {
      sku: e('sku', [`${SQL}:2`]),
      quantity: e('stock', [`${SQL}:5`]),
    },
  },
};
