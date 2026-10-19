'use strict';
// Where the vulnerable app keeps payment state.
// Provenance: HAND-WRITTEN in Phase 2 by reading merchant/vulnerable/schema.sql and app.js.
// Not discovered. Its orders.status is unconstrained text; the code writes
// 'created', 'paid' and 'failed', and only 'paid' is treated as paid here.
module.exports = {
  name: 'vulnerable',
  provenance: 'hand-written',
  amountUnit: 'minor', // paise
  orders: {
    table: 'orders',
    columns: {
      id: 'id',
      gatewayOrderId: 'razorpay_order_id',
      amount: 'amount',
      currency: 'currency',
      status: 'status',
      paidPaymentId: 'paid_payment_id',
    },
    paidValues: ['paid'],
  },
  payments: {
    table: 'payments',
    columns: { id: 'id', gatewayOrderId: 'razorpay_order_id', amount: 'amount', currency: 'currency', status: 'status' },
    capturedValues: ['captured'],
  },
  fulfillments: {
    table: 'fulfillments',
    columns: { orderId: 'order_id', sku: 'sku', quantity: 'quantity' },
  },
  refunds: {
    table: 'refunds',
    columns: { id: 'id', paymentId: 'payment_id', amount: 'amount', status: 'status' },
    notCountedValues: ['failed'],
  },
  stock: {
    table: 'products',
    columns: { sku: 'sku', quantity: 'stock' },
  },
};
