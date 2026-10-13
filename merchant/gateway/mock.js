'use strict';
// In-memory stand-in for the Razorpay Orders and Refunds APIs.
// It never talks to the network. Calls are recorded so tests can inspect them.
// If a harness ledger is passed, every gateway action is also recorded there.
// Refund contract: see docs/GATEWAY_CONTRACT.md. createRefund currently accepts every
// request, which is a known modelling gap, not documented Razorpay behaviour.
const crypto = require('node:crypto');

const rand = () => crypto.randomBytes(7).toString('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function createMockGateway({ ledger } = {}) {
  const calls = [];
  return {
    calls,
    async createOrder({ amount, currency, receipt }) {
      await tick();
      const order = { id: `order_${rand()}`, amount, currency, receipt, status: 'created' };
      calls.push({ op: 'createOrder', ...order });
      ledger?.recordOrder({ id: order.id, amount, currency, receipt });
      return order;
    },
    async createRefund(paymentId, { amount }) {
      await tick();
      const refund = { id: `rfnd_${rand()}`, payment_id: paymentId, amount, status: 'processed' };
      calls.push({ op: 'createRefund', ...refund });
      ledger?.recordRefund({ id: refund.id, paymentId, amount, status: refund.status });
      return refund;
    },
  };
}

module.exports = { createMockGateway };
