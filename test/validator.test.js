'use strict';
// Mapping v2 validator against the two real fixture apps, with correct and deliberately wrong mappings.
// Every mutant asserts which entry is contradicted and that unrelated entries stay confirmed.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { startIsolatedMerchant, postJson } = require('./helpers');
const { takeSnapshot } = require('../harness/snapshot');
const { checkAll, STATUS: CHECK } = require('../harness/invariants');
const { genuinePaymentEvent, deliverWebhook, newPaymentId, hmacHex } = require('../harness/mock-razorpay');
const { entry } = require('../harness/mapping-v2');
const { validateMapping, STATUS } = require('../harness/validator');

const ROOT = path.join(__dirname, '..');
const DENY = ['docs/SEEDED_BUGS.md'];
const IMPLS = ['reference', 'vulnerable'];
const V2 = {
  reference: require('../harness/mappings/v2/reference'),
  vulnerable: require('../harness/mappings/v2/vulnerable'),
};
const V1 = {
  reference: require('../harness/mappings/reference'),
  vulnerable: require('../harness/mappings/vulnerable'),
};

// Entries the validation purchase cannot exercise: never confirmed, always cannot_verify.
const NOT_EXERCISED = (p) => p.startsWith('launch.') || p === 'routes.verify' || p === 'routes.refund' || p.startsWith('refunds.');

// Each validation is an isolated run (startIsolatedMerchant): its own file-backed database, ledger
// and app. The validator reads only through the run's read-only reader, opened after the app
// initialized the database. Teardown order: proxy, then readers, app and run directory. Set
// PAYPROBE_KEEP_FAILED_RUNS=1 to keep a failed run's directory for debugging.
// Validates a (possibly mutated) copy of the app's hand mapping, then runs `fn` while the app is
// still up. `wrap` may put a proxy in front of the app.
async function withValidation(impl, mutate, fn = () => {}, { wrap } = {}) {
  const iso = await startIsolatedMerchant(impl, { role: 'validation' });
  const { merchant: m, ledger, reader } = iso;
  let proxy;
  let passed = false;
  try {
    assert.notEqual(reader, m.db, 'the validator must not read through the app connection');
    const mapping = structuredClone(V2[impl]);
    mutate?.(mapping);
    proxy = wrap ? await wrap(m) : null;
    const baseUrl = proxy?.baseUrl ?? m.baseUrl;
    const report = await validateMapping(mapping, {
      target: { baseUrl, db: reader, webhookSecret: m.webhookSecret, ledger, database: iso.run.describe() }, root: ROOT, denyFiles: DENY,
    });
    await fn(report, m, ledger, reader);
    passed = true;
    return report;
  } finally {
    await proxy?.close();
    const cleaned = await iso.teardown({ failed: !passed });
    if (cleaned.kept) console.log(`[validator.test] kept failed run directory ${cleaned.kept}`);
    else if (passed && !cleaned.removed) assert.fail(`run directory not cleaned up: ${cleaned.error}`);
  }
}

const statusOf = (report, p) => report.entries.find((e) => e.path === p)?.status;
const entryOf = (report, p) => report.entries.find((e) => e.path === p);

function assertOthersConfirmed(report, except) {
  const wrong = report.entries.filter((e) => !NOT_EXERCISED(e.path) && !except.includes(e.path) && e.status !== STATUS.CONFIRMED);
  assert.deepEqual(wrong.map((e) => [e.path, e.status, e.reasons]), [], 'unrelated entries should stay confirmed');
}

// A second purchase through `legacy`, checked by the invariant checker.
async function purchaseAndCheck(m, ledger, legacy, reader) {
  const snapshots = [takeSnapshot(reader, legacy, { label: 'before' })];
  const order = (await postJson(m.baseUrl, '/api/orders', { sku: 'HOODIE', quantity: 1 })).json;
  snapshots.push(takeSnapshot(reader, legacy, { label: 'order' }));
  const event = genuinePaymentEvent(ledger, 'payment.captured', { paymentId: newPaymentId(), orderId: order.razorpay_order_id, amount: order.amount });
  assert.equal((await deliverWebhook(m.baseUrl, event, { secret: m.webhookSecret })).status, 200);
  snapshots.push(takeSnapshot(reader, legacy, { label: 'captured' }));
  return Object.fromEntries(checkAll({ snapshots, ledger: ledger.view() }).map((r) => [r.id, r]));
}

for (const impl of IMPLS) {
  describe(`validator, correct hand mapping: ${impl}`, () => {
    it('validates; every exercised entry is confirmed; the rest are cannot_verify, never confirmed', async () => {
      await withValidation(impl, null, (r) => {
        assert.equal(r.verdict, 'validated', JSON.stringify(r.entries.filter((e) => e.status !== STATUS.CONFIRMED), null, 2));
        assert.deepEqual(r.contradicted, []);
        assertOthersConfirmed(r, []);
        for (const e of r.entries.filter((x) => NOT_EXERCISED(x.path))) {
          assert.equal(e.status, STATUS.CANNOT_VERIFY, e.path);
          assert.equal(e.behaviour, 'not_observed', e.path);
        }
        assert.ok(!r.filesRead.some((f) => f.startsWith('docs/')), `read ${r.filesRead}`);
        assert.equal(entryOf(r, 'orders.paidValues').unobservedValues.length, 0);
        // The validated copy of the v2 mapping carries confidence and validation status on each entry.
        assert.equal(r.mapping.orders.columns.status.confidence, 'high');
        assert.equal(r.mapping.orders.columns.status.validation.status, STATUS.CONFIRMED);
        assert.equal(r.mapping.launch.command.validation.status, STATUS.CANNOT_VERIFY);
        assert.equal(r.mapping.launch.command.validation.evidence, 'supported');
        // The report records which isolated database the run used and how it was read.
        assert.equal(r.database.provided, true);
        assert.equal(r.database.existedBefore, false);
        assert.equal(r.database.fileName, 'target.db');
        assert.ok(path.isAbsolute(r.database.path));
        assert.deepEqual(r.database.reader, { separateConnection: true, readOnly: true, busyTimeoutMs: 5000 });
        assert.match(r.database.provenance, /run-db/);
      });
    });

    it('a normal purchase is checked against actual database state', async () => {
      await withValidation(impl, null, (r) => {
        const { steps, createOrder, gatewayOrder, captured } = r.observations;
        assert.equal(createOrder.quantity, 2, 'quantity 2 keeps amount, quantity and row ids distinguishable');
        const orderId = createOrder.response.order_id;
        const order = (step) => steps[step].orders.find((o) => o.id === orderId);
        assert.equal(order('afterOrder').isPaid, false);
        assert.equal(order('afterOrder').gatewayOrderId, gatewayOrder.id);
        assert.equal(order('afterCaptured').isPaid, true);
        assert.equal(order('afterCaptured').paidPaymentId, captured.paymentId);
        assert.notEqual(r.observations.negativeOrder.gatewayOrder.id, gatewayOrder.id, 'negative control uses a separate order');
        const fulfilments = (step) => steps[step].fulfillments.filter((f) => f.orderId === orderId);
        assert.equal(fulfilments('afterOrder').length, 0);
        assert.equal(fulfilments('afterCaptured').length, 1);
        assert.equal(steps.afterUnsigned.stock.TSHIRT - steps.afterCaptured.stock.TSHIRT, 2);
        const payment = steps.afterCaptured.payments.find((p) => p.id === captured.paymentId);
        assert.equal(payment.isCaptured, true);
        assert.equal(payment.amount, gatewayOrder.amount);
      });
    });

    it('an unsigned or wrongly signed webhook does not change database state', async () => {
      await withValidation(impl, null, (r) => {
        assert.equal(r.negativeControl.result, 'held');
        assert.deepEqual(r.negativeControl.changedTables, []);
        assert.deepEqual(r.negativeControl.deliveries.map((d) => [d.kind, d.signed]), [['no_signature', false], ['wrong_secret', true]]);
        // The negative control runs on its own order, before the order used for the positive control.
        const { afterNegativeOrder, afterUnsigned } = r.observations.steps;
        for (const entity of ['orders', 'payments', 'fulfillments', 'stock']) {
          assert.deepEqual(afterUnsigned[entity], afterNegativeOrder[entity], entity);
        }
        assert.deepEqual(r.negativeControl.mappedTablesChanged, []);
      });
    });

    it('the validated projection matches the v1 hand mapping and drives the checker; refunds stay cannot_verify', async () => {
      await withValidation(impl, null, async (r, m, ledger, reader) => {
        for (const entity of ['orders', 'payments', 'fulfillments', 'stock']) assert.deepEqual(r.legacy[entity], V1[impl][entity], entity);
        assert.equal(r.legacy.refunds, null);
        const byId = await purchaseAndCheck(m, ledger, r.legacy, reader);
        for (const id of ['I1', 'I2', 'I3', 'I4']) assert.equal(byId[id].status, CHECK.PASS, `${id}: ${JSON.stringify(byId[id])}`);
        assert.equal(byId.I5.status, CHECK.CANNOT_VERIFY);
      });
    });
  });

  describe(`validator, wrong mappings are rejected: ${impl}`, () => {
    const rejects = (title, mutate, contradicted, extra) => it(title, async () => {
      await withValidation(impl, mutate, async (r, m, ledger, reader) => {
        assert.equal(r.verdict, 'rejected');
        for (const p of contradicted) assert.equal(statusOf(r, p), STATUS.CONTRADICTED, `${p}: ${JSON.stringify(entryOf(r, p))}`);
        await extra?.(r, m, ledger, reader);
      });
    });

    rejects('existing but wrong column (orders.amount -> quantity)',
      (m) => { m.orders.columns.amount.value = 'quantity'; },
      ['orders.columns.amount'],
      (r) => assertOthersConfirmed(r, ['orders.columns.amount']));

    rejects('existing but wrong column (orders.gatewayOrderId -> id)',
      (m) => { m.orders.columns.gatewayOrderId.value = 'id'; },
      ['orders.columns.gatewayOrderId'],
      (r) => assertOthersConfirmed(r, ['orders.columns.gatewayOrderId']));

    rejects('column that does not exist (payments.amount -> amount_paise)',
      (m) => { m.payments.columns.amount.value = 'amount_paise'; },
      ['payments.columns.amount'],
      (r) => {
        assert.match(entryOf(r, 'payments.columns.amount').reasons.join(), /does not exist/);
        assertOthersConfirmed(r, ['payments.columns.amount']);
      });

    rejects('fulfilment quantity mapped to the row id',
      (m) => { m.fulfillments.columns.quantity.value = 'id'; },
      ['fulfillments.columns.quantity'],
      (r) => assertOthersConfirmed(r, ['fulfillments.columns.quantity']));

    for (const values of [['created'], ['created', 'paid'], ['PAID']]) {
      rejects(`incorrect paid values ${JSON.stringify(values)}`,
        (m) => { m.orders.paidValues.value = values; },
        ['orders.paidValues'],
        (r) => {
          assert.equal(statusOf(r, 'orders.columns.status'), STATUS.CONFIRMED);
          assertOthersConfirmed(r, ['orders.paidValues']);
          assert.equal(r.legacy.orders.paidValues, undefined, 'a rejected value list never reaches the checker');
        });
    }

    rejects('fulfilment mapping pointing at the orders table',
      (m) => {
        m.fulfillments.table.value = 'orders';
        m.fulfillments.columns = { orderId: entry('id', []), sku: entry('sku', []), quantity: entry('quantity', []) };
      },
      ['fulfillments.table'],
      (r) => {
        assert.match(entryOf(r, 'fulfillments.table').reasons.join(), /at order creation, before any payment/);
        assert.equal(r.legacy.fulfillments, null);
      });

    rejects('incorrect webhook route',
      (m) => { m.routes.webhook.value.path = '/webhooks/stripe'; },
      ['routes.webhook'],
      async (r, m, ledger, reader) => {
        const hits = m.trace.filter((t) => t.url === '/webhooks/stripe');
        assert.equal(hits.length, 3, 'two negative-control and one positive delivery went to the wrong route');
        assert.ok(hits.every((t) => t.status === 404));
        assert.ok(!m.trace.some((t) => t.url === '/webhooks/razorpay'));
        // Order creation still confirms what it can; everything that needed the capture is unobserved.
        assert.equal(statusOf(r, 'orders.table'), STATUS.CONFIRMED);
        assert.equal(statusOf(r, 'orders.columns.amount'), STATUS.CONFIRMED);
        for (const p of ['orders.paidValues', 'orders.columns.status', 'payments.table', 'fulfillments.columns.orderId', 'stock.columns.quantity']) {
          assert.equal(statusOf(r, p), STATUS.CANNOT_VERIFY, p);
        }
        assert.equal(r.negativeControl.result, 'not_meaningful');
        const byId = await purchaseAndCheck(m, ledger, r.legacy, reader);
        assert.equal(byId.I1.status, CHECK.CANNOT_VERIFY, 'without confirmed paid values I1 cannot pass');
      });

    rejects('incorrect order-creation route',
      (m) => { m.routes.createOrder.value.path = '/api/order'; },
      ['routes.createOrder'],
      (r) => {
        assert.equal(r.observations.aborted, 'order creation did not succeed');
        assert.equal(statusOf(r, 'orders.paidValues'), STATUS.CANNOT_VERIFY);
      });

    rejects('a contradiction wins over missing evidence',
      (m) => { m.orders.columns.amount = entry('quantity', []); },
      ['orders.columns.amount']);
  });

  describe(`validator, missing or ambiguous evidence gives cannot_verify: ${impl}`, () => {
    it('required entry without evidence: cannot_verify, mapping insufficient (not validated)', async () => {
      await withValidation(impl, (m) => { m.orders.columns.status.evidence = []; }, (r) => {
        const e = entryOf(r, 'orders.columns.status');
        assert.equal(e.status, STATUS.CANNOT_VERIFY);
        assert.equal(e.behaviour, 'consistent', 'behaviour alone is not enough');
        assert.equal(e.evidence, 'missing');
        assert.equal(r.verdict, 'insufficient');
        assert.deepEqual(r.requiredUnconfirmed, ['orders.columns.status']);
      });
    });

    it('evidence that does not mention the column: cannot_verify, and I3 becomes cannot_verify, not pass', async () => {
      await withValidation(impl, (m) => { m.fulfillments.columns.orderId.evidence = [{ file: `merchant/${impl}/schema.sql`, line: 1 }]; }, async (r, m, ledger, reader) => {
        const e = entryOf(r, 'fulfillments.columns.orderId');
        assert.equal(e.status, STATUS.CANNOT_VERIFY);
        assert.equal(e.evidence, 'unsupported');
        assert.equal(r.verdict, 'validated', 'not a required entry');
        assert.equal(r.legacy.fulfillments.columns.orderId, null);
        const byId = await purchaseAndCheck(m, ledger, r.legacy, reader);
        assert.equal(byId.I3.status, CHECK.CANNOT_VERIFY);
      });
    });

    it('low confidence or listed alternatives: cannot_verify even when behaviour agrees', async () => {
      await withValidation(impl, (m) => {
        m.orders.columns.amount.confidence = 'low';
        m.stock.columns.quantity.alternatives = ['price'];
      }, (r) => {
        for (const p of ['orders.columns.amount', 'stock.columns.quantity']) {
          const e = entryOf(r, p);
          assert.equal(e.status, STATUS.CANNOT_VERIFY, p);
          assert.equal(e.behaviour, 'consistent', p);
          assert.match(e.reasons.join(), /ambiguous/);
        }
        assert.equal(r.legacy.orders.columns.amount, null);
        assert.equal(r.legacy.stock.columns.quantity, null);
      });
    });

    it('evidence outside the target root is not read and gives cannot_verify', async () => {
      await withValidation(impl, (m) => { m.orders.table.evidence = [{ file: '../outside.sql', line: 1 }]; }, (r) => {
        assert.equal(statusOf(r, 'orders.table'), STATUS.CANNOT_VERIFY);
        assert.equal(r.verdict, 'insufficient');
        assert.ok(!r.filesRead.some((f) => f.startsWith('..')));
      });
    });
  });
}

describe('validator: malformed input and detection of a failing negative control', () => {
  it('a malformed mapping is reported, not run', async () => {
    const m = structuredClone(V2.reference);
    delete m.schema;
    const r = await validateMapping(m, { target: null, root: ROOT });
    assert.equal(r.verdict, 'malformed');
    assert.ok(r.errors.length > 0);
  });

  // A proxy in front of the reference app simulates a target whose negative control fails.
  // onUnsigned(m, req, body) runs for webhook deliveries without a valid signature and may return
  // replacement headers for forwarding.
  const proxyWith = (onUnsigned) => async (m) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      let headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'content-length', 'connection'].includes(k)));
      const validlySigned = req.headers['x-razorpay-signature'] === hmacHex(m.webhookSecret, body);
      if (req.url === '/webhooks/razorpay' && !validlySigned) headers = onUnsigned(m, headers, body) ?? headers;
      const upstream = await fetch(`${m.baseUrl}${req.url}`, { method: req.method, headers, body: chunks.length ? body : undefined });
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
  };

  it('reports state_changed when an unsigned webhook changes an unmapped table; the mapping still validates', async () => {
    const wrap = proxyWith((m) => {
      m.db.prepare(`INSERT INTO webhook_events (event_id, event_type) VALUES (?, 'unsigned')`).run(crypto.randomUUID());
    });
    await withValidation('reference', null, (r) => {
      assert.equal(r.negativeControl.result, 'state_changed');
      assert.deepEqual(r.negativeControl.changedTables, ['webhook_events']);
      assert.deepEqual(r.negativeControl.mappedTablesChanged, []);
      assert.equal(r.verdict, 'validated');
    }, { wrap });
  });

  // The app behaves as if it skipped signature checks: forged captures are processed in full
  // (order paid with a forged payment id, fulfilled, stock taken). Correct entries must not be
  // blamed for that; the failure is reported as an app property.
  it('a target that accepts forged captures: negative control fails, correct mapping still validates', async () => {
    const wrap = proxyWith((m, headers, body) => ({ ...headers, 'x-razorpay-signature': hmacHex(m.webhookSecret, body) }));
    await withValidation('reference', null, (r) => {
      assert.equal(r.negativeControl.result, 'state_changed');
      for (const t of ['orders', 'payments', 'fulfillments', 'products']) assert.ok(r.negativeControl.mappedTablesChanged.includes(t), t);
      const forgedOrder = r.observations.steps.afterUnsigned.orders.find((o) => o.gatewayOrderId === r.observations.negativeOrder.gatewayOrder.id);
      assert.equal(forgedOrder.isPaid, true, 'the forged capture really took effect on order A');
      assert.deepEqual(r.contradicted, []);
      assert.equal(r.verdict, 'validated');
      assertOthersConfirmed(r, []);
    }, { wrap });
  });
});
