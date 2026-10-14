'use strict';
// Mapping v2 for the reference app, with source evidence for every entry.
// Provenance: HAND-WRITTEN by reading merchant/reference/{schema.sql,app.js}, merchant/server.js and
// merchant/config.js. It is the baseline a discovered mapping is compared against; not discovered.
// Evidence paths are relative to the repository root.
const { SCHEMA_ID, entry: e } = require('../../mapping-v2');

const APP = 'merchant/reference/app.js';
const SQL = 'merchant/reference/schema.sql';

module.exports = {
  schema: SCHEMA_ID,
  name: 'reference',
  provenance: 'hand-written',
  launch: {
    command: e({ argv: ['node', 'merchant/server.js', '--impl', 'reference'], cwd: '.' }, ['merchant/server.js:3', 'package.json:11']),
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
    }, [`${APP}:117`, `${APP}:118`, `${APP}:128`, `${SQL}:64`]),
    webhook: e({
      method: 'POST',
      path: '/webhooks/razorpay',
      signatureHeader: 'x-razorpay-signature',
      eventIdHeader: 'x-razorpay-event-id',
    }, [`${APP}:143`, `${APP}:145`, `${APP}:148`]),
    verify: e({ method: 'POST', path: '/api/payments/verify' }, [`${APP}:133`]),
    refund: e({ method: 'POST', path: '/api/orders/{orderId}/refunds' }, [`${APP}:171`]),
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
    paidValues: e(['paid'], [`${SQL}:15`, `${APP}:60`]),
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
    capturedValues: e(['captured'], [`${SQL}:26`]),
  },
  fulfillments: {
    table: e('fulfillments', [`${SQL}:38`]),
    columns: {
      orderId: e('order_id', [`${SQL}:40`]),
      sku: e('sku', [`${SQL}:41`]),
      quantity: e('quantity', [`${SQL}:42`]),
    },
  },
  refunds: {
    table: e('refunds', [`${SQL}:46`]),
    columns: {
      id: e('id', [`${SQL}:47`]),
      paymentId: e('payment_id', [`${SQL}:50`]),
      amount: e('amount', [`${SQL}:51`]),
      status: e('status', [`${SQL}:52`]),
    },
    notCountedValues: e(['failed'], [`${SQL}:52`]),
  },
  stock: {
    table: e('products', [`${SQL}:1`]),
    columns: {
      sku: e('sku', [`${SQL}:2`]),
      quantity: e('stock', [`${SQL}:5`]),
    },
  },
};
