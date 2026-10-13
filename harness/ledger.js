'use strict';
// Independent record of what the simulated Razorpay actually did.
// Written only by the simulator (mock gateway and genuine event emitter), never by a
// merchant app, so invariant checks do not depend on the system under test's own records.
const PAYMENT_STATUSES = new Set(['created', 'authorized', 'captured', 'failed']);
const REFUND_STATUSES = new Set(['pending', 'processed', 'failed']);

function createLedger() {
  const orders = new Map();
  const payments = new Map();
  const refunds = new Map();
  const log = [];
  let seq = 0;
  const append = (kind, data) => log.push({ seq: ++seq, kind, ...data });

  return {
    recordOrder({ id, amount, currency, receipt }) {
      if (orders.has(id)) throw new Error(`ledger: duplicate gateway order ${id}`);
      orders.set(id, { id, amount, currency, receipt });
      append('order.created', { id, amount, currency });
    },

    // A payment's identity (order, amount, currency) is fixed; only its status moves.
    // Every status is kept in history, so "was ever captured" survives later events.
    recordPayment({ id, orderId, amount, currency, status }) {
      if (!PAYMENT_STATUSES.has(status)) throw new Error(`ledger: unknown payment status ${status}`);
      const prev = payments.get(id);
      if (prev && (prev.orderId !== orderId || prev.amount !== amount || prev.currency !== currency)) {
        throw new Error(`ledger: payment ${id} cannot change order, amount or currency`);
      }
      payments.set(id, { id, orderId, amount, currency, status, history: [...(prev?.history ?? []), status] });
      append(`payment.${status}`, { id, orderId, amount, currency });
    },

    recordRefund({ id, paymentId, amount, status }) {
      if (!REFUND_STATUSES.has(status)) throw new Error(`ledger: unknown refund status ${status}`);
      refunds.set(id, { id, paymentId, amount, status });
      append(`refund.${status}`, { id, paymentId, amount });
    },

    // Plain deep copy for the checker; mutating it cannot change the ledger.
    view() {
      return structuredClone({
        orders: Object.fromEntries(orders),
        payments: Object.fromEntries(payments),
        refunds: [...refunds.values()],
        log,
      });
    },
  };
}

module.exports = { createLedger };
