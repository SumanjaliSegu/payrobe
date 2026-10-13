'use strict';
// Hand-built normalized snapshots and ledgers for checker unit tests.
// These never touch a merchant app: they test the checker's logic in isolation.
const { ENTITIES } = require('../harness/snapshot');

const DERIVED = { orders: 'isPaid', payments: 'isCaptured', refunds: 'counted' };

// data: { orders, payments, fulfillments, refunds, stock } — pass null to mark an entity unavailable.
// omit: { orders: ['paidPaymentId'], ... } — fields to mark unavailable.
function snap(label, data, { omit = {} } = {}) {
  const s = { label, mapping: 'fixture', available: {}, missing: [] };
  for (const entity of Object.keys(ENTITIES)) {
    const value = data[entity] === undefined ? (entity === 'stock' ? {} : []) : data[entity];
    s[entity] = value;
    if (value === null) {
      s.available[entity] = [];
      continue;
    }
    const fields = [...ENTITIES[entity], ...(DERIVED[entity] ? [DERIVED[entity]] : [])];
    s.available[entity] = fields.filter((f) => !(omit[entity] ?? []).includes(f));
  }
  return s;
}

const order = (id, o = {}) => ({
  id, gatewayOrderId: `order_${id}`, amount: 49900, currency: 'INR', status: 'created', isPaid: false, paidPaymentId: null, ...o,
});
const paidOrder = (id, paymentId, o = {}) => order(id, { status: 'paid', isPaid: true, paidPaymentId: paymentId, ...o });

function ledger({ orders = [], payments = [], refunds = [] } = {}) {
  return {
    orders: Object.fromEntries(orders.map((o) => [o.id, o])),
    payments: Object.fromEntries(payments.map((p) => [p.id, { history: [p.status], ...p }])),
    refunds,
    log: [],
  };
}
const gwOrder = (id, amount = 49900, currency = 'INR') => ({ id: `order_${id}`, amount, currency });
const gwPayment = (id, orderLocalId, o = {}) => ({
  id, orderId: `order_${orderLocalId}`, amount: 49900, currency: 'INR', status: 'captured', ...o,
});

module.exports = { snap, order, paidOrder, ledger, gwOrder, gwPayment };
