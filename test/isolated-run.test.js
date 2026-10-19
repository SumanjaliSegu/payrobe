'use strict';
// Isolated experiment runs (startIsolatedMerchant): each run has its own database, gateway ledger and
// app instance, and teardown releases them in order. Runs use a test-owned temp root.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startMerchant, startIsolatedMerchant, postJson } = require('./helpers');
const { takeSnapshot } = require('../harness/snapshot');
const { genuinePaymentEvent, newPaymentId } = require('../harness/mock-razorpay');
const { prepareDelivery, deliverTwice } = require('../harness/delivery');
const { validateMapping } = require('../harness/validator');
const v1 = require('../harness/mappings/reference');
const v2 = require('../harness/mappings/v2/reference');

let tmpRoot;
before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'payprobe-isolated-test-'));
});
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const start = (opts = {}) => startIsolatedMerchant('reference', { tmpRoot, ...opts });

// Order + genuine capture delivered twice (sequential), as an attack run would.
async function purchase(run) {
  const order = (await postJson(run.baseUrl, '/api/orders', { sku: 'TSHIRT', quantity: 2 })).json;
  const event = genuinePaymentEvent(run.ledger, 'payment.captured', { paymentId: newPaymentId(), orderId: order.razorpay_order_id, amount: order.amount });
  await deliverTwice(run.baseUrl, prepareDelivery(event, { secret: run.webhookSecret }), { mode: 'sequential' });
  return order;
}

function assertUntouched(run) {
  const s = takeSnapshot(run.reader, v1);
  assert.deepEqual(s.orders, []);
  assert.deepEqual(s.payments, []);
  assert.deepEqual(s.fulfillments, []);
  assert.equal(s.stock.TSHIRT, 100);
  const view = run.ledger.view();
  assert.deepEqual(view.orders, {});
  assert.deepEqual(view.payments, {});
  assert.deepEqual(view.log, []);
}

describe('isolated runs: separate database, ledger and app per run', () => {
  it('existing scenarios are unaffected: startMerchant still defaults to an in-memory database', async () => {
    const m = await startMerchant('reference');
    try {
      assert.equal(m.dbPath, ':memory:');
    } finally {
      await m.close();
    }
  });

  it('two attack runs cannot see each other\'s database state or ledger events', async () => {
    const a = await start();
    const b = await start();
    try {
      assert.notEqual(a.run.dbPath, b.run.dbPath);
      assert.notEqual(a.run.runId, b.run.runId);
      assert.notEqual(a.ledger, b.ledger);
      assertUntouched(a);
      assertUntouched(b);

      const order = await purchase(a);
      const sa = takeSnapshot(a.reader, v1);
      assert.equal(sa.orders.length, 1);
      assert.equal(sa.fulfillments.length, 1);
      assert.equal(sa.stock.TSHIRT, 98);
      assert.ok(a.ledger.view().orders[order.razorpay_order_id]);
      assertUntouched(b); // nothing from run A reached run B

      await purchase(b);
      assert.equal(takeSnapshot(a.reader, v1).orders.length, 1, 'run B\'s activity does not reach run A');
      assert.equal(Object.keys(a.ledger.view().orders).length, 1);
    } finally {
      await a.teardown();
      await b.teardown();
    }
  });

  it('an attack run never reuses the validation run\'s database or ledger', async () => {
    const val = await start({ role: 'validation' });
    let report;
    try {
      report = await validateMapping(v2, {
        target: { baseUrl: val.baseUrl, db: val.reader, webhookSecret: val.webhookSecret, ledger: val.ledger, database: val.run.describe() },
        root: path.join(__dirname, '..'),
        denyFiles: ['docs/SEEDED_BUGS.md'],
      });
      assert.equal(report.verdict, 'validated');
      assert.equal(takeSnapshot(val.reader, v1).orders.length, 2, 'validation leaves its orders behind');
    } finally {
      assert.equal((await val.teardown()).removed, true);
    }
    const validationLedgerEvents = val.ledger.view().log.length;

    const atk = await start();
    try {
      assert.equal(atk.describe().role, 'attack');
      assert.notEqual(atk.run.dbPath, report.database.path);
      assert.notEqual(atk.run.runId, report.database.runId);
      assert.notEqual(atk.ledger, val.ledger);
      assertUntouched(atk);
      await purchase(atk);
      assert.equal(val.ledger.view().log.length, validationLedgerEvents, 'attack events never enter the validation ledger');
    } finally {
      await atk.teardown();
    }
  });
});

describe('isolated runs: teardown', () => {
  it('closes readers, then the app, then removes the run directory; idempotent', async () => {
    const r = await start();
    const extra = r.run.openReader();
    await purchase(r);
    const res = await r.teardown();
    assert.deepEqual(res, { removed: true, kept: null, leftover: [], error: null });
    assert.equal(r.reader.isOpen, false);
    assert.equal(extra.isOpen, false);
    assert.equal(r.merchant.db.isOpen, false);
    await assert.rejects(fetch(`${r.baseUrl}/api/orders`, { method: 'POST' }), 'the app no longer accepts connections');
    assert.equal(fs.existsSync(r.run.dir), false);
    assert.equal(await r.teardown(), res, 'a second teardown returns the same result');
  });

  it('a failed run is kept only when PAYPROBE_KEEP_FAILED_RUNS=1', async () => {
    const saved = process.env.PAYPROBE_KEEP_FAILED_RUNS;
    try {
      delete process.env.PAYPROBE_KEEP_FAILED_RUNS;
      const dropped = await start();
      assert.equal((await dropped.teardown({ failed: true })).removed, true);
      assert.equal(fs.existsSync(dropped.run.dir), false);

      process.env.PAYPROBE_KEEP_FAILED_RUNS = '1';
      const kept = await start();
      await purchase(kept);
      const res = await kept.teardown({ failed: true });
      assert.equal(res.kept, kept.run.dir);
      assert.ok(fs.existsSync(kept.run.dbPath), 'database kept for debugging');
      assert.equal(kept.reader.isOpen, false, 'readers are closed even when the run is kept');
      assert.equal(kept.merchant.db.isOpen, false);

      const passed = await start();
      assert.equal((await passed.teardown({ failed: false })).removed, true, 'passing runs are never kept');
    } finally {
      if (saved === undefined) delete process.env.PAYPROBE_KEEP_FAILED_RUNS;
      else process.env.PAYPROBE_KEEP_FAILED_RUNS = saved;
    }
  });
});
