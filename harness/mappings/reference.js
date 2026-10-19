'use strict';
// Where the reference app keeps payment state.
// Provenance: HAND-WRITTEN in Phase 2 by reading merchant/reference/schema.sql and app.js.
// Not discovered. Phase 4's agent must produce an equivalent file for an unseen app.
// A field set to null means "not available in this app"; checks that need it return cannot_verify.
module.exports = {
  name: 'reference',
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
