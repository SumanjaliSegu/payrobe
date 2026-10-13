'use strict';
// Tests for the delivery helper itself, so a failed barrier can never look like a concurrent run.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startMerchant } = require('./helpers');
const { prepareDelivery, signatureMatches, deliverTwice } = require('../harness/delivery');
const { paymentEvent, newPaymentId } = require('../harness/mock-razorpay');

describe('delivery helper', () => {
  let m;
  before(async () => {
    m = await startMerchant('reference');
  });
  after(async () => {
    await m.close();
  });

  // An event for an order the app does not know: processed without fulfilling anything.
  const prepared = () => prepareDelivery(
    paymentEvent('payment.captured', { paymentId: newPaymentId(), orderId: 'order_unknown', amount: 100 }),
    { secret: m.webhookSecret },
  );

  it('prepares one signed body and reuses the exact bytes', async () => {
    const p = prepared();
    assert.equal(signatureMatches(p, m.webhookSecret), true);
    assert.equal(signatureMatches(p, 'wrong secret'), false);
    const d = await deliverTwice(m.baseUrl, p, { mode: 'sequential' });
    assert.equal(d.identical, true);
    assert.deepEqual(d.requests.map((r) => r.bodySha256), [p.bodySha256, p.bodySha256]);
  });

  it('reports a barrier that was never reached instead of treating the run as concurrent', async () => {
    const d = await deliverTwice(m.baseUrl, prepared(), {
      mode: 'barrier',
      observe: () => ({ arrived: 0, finished: 0 }), // pretends the server never saw the requests
      barrierTimeoutMs: 50,
    });
    assert.equal(d.barrier.reached, false);
    assert.equal(d.barrier.arrivedAtRelease, 0);
    assert.deepEqual(d.requests.map((r) => r.status), [200, 200], 'requests must still complete after release');
  });

  it('reaches the barrier when the server reports both requests in flight', async () => {
    const start = m.trace.length;
    const d = await deliverTwice(m.baseUrl, prepared(), {
      mode: 'barrier',
      observe: () => {
        const w = m.trace.slice(start).filter((t) => t.url === '/webhooks/razorpay');
        return { arrived: w.length, finished: w.filter((t) => t.finishedMs !== undefined).length };
      },
    });
    assert.equal(d.barrier.reached, true);
    assert.equal(d.barrier.arrivedAtRelease, 2);
    assert.equal(d.barrier.finishedAtRelease, 0);
  });
});
