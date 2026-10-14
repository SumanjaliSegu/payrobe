'use strict';
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { createMockGateway } = require('../merchant/gateway/mock');
const { MOCK_KEY_SECRET, MOCK_WEBHOOK_SECRET } = require('../merchant/config');
const { createLedger } = require('../harness/ledger');
const { createRunDatabase } = require('../harness/run-db');

const IMPLS = {
  reference: require('../merchant/reference/app'),
  vulnerable: require('../merchant/vulnerable/app'),
  unseen: require('../merchant/unseen/app'),
  unseen2: require('../merchant/unseen2/app'),
};

// Starts an implementation on an ephemeral loopback port with a fresh in-memory DB, or with the
// SQLite file at `dbPath` (a fresh one from harness/run-db.js). The in-memory default keeps the
// existing scenarios, including the concurrency ones, exactly as they were.
// Returns the DB handle so tests can assert on stored state, not HTTP responses.
// Pass a harness ledger to have the mock gateway record its actions independently.
// `trace` records, at the HTTP layer, when each request arrived and when its response
// finished (performance.now(), same clock as the harness). The app itself is unchanged.
async function startMerchant(impl, { ledger, dbPath = ':memory:' } = {}) {
  const gateway = createMockGateway({ ledger });
  const { app, db } = IMPLS[impl].createApp({
    dbPath,
    keySecret: MOCK_KEY_SECRET,
    webhookSecret: MOCK_WEBHOOK_SECRET,
    gateway,
  });
  const trace = [];
  const server = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, eventId: req.headers['x-razorpay-event-id'] ?? null, arrivedMs: performance.now() };
    trace.push(entry);
    res.on('finish', () => {
      entry.finishedMs = performance.now();
      entry.status = res.statusCode;
    });
    app(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    impl,
    dbPath,
    baseUrl,
    db,
    gateway,
    trace,
    keySecret: MOCK_KEY_SECRET,
    webhookSecret: MOCK_WEBHOOK_SECRET,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

// One isolated experiment run: a fresh run database (harness/run-db.js), a fresh gateway ledger, and
// a new app instance on that database, plus one read-only reader opened after the app initialized it.
// Every call creates all three anew, so a run never shares a database or ledger with any other run,
// including the run used to validate a mapping. `role` ('validation' | 'attack') is recorded only.
//
// teardown({ failed }) closes readers, then the app, then removes the run directory. With
// failed: true and PAYPROBE_KEEP_FAILED_RUNS=1 the directory is kept for debugging. It is idempotent
// and returns the cleanup result ({ removed, kept, leftover, error }).
//
// startMerchant's in-memory default is unaffected: existing scenarios do not use this.
async function startIsolatedMerchant(impl, { role = 'attack', tmpRoot } = {}) {
  const run = createRunDatabase(tmpRoot ? { tmpRoot } : {});
  const ledger = createLedger();
  let m;
  try {
    m = await startMerchant(impl, { ledger, dbPath: run.dbPath });
  } catch (err) {
    await run.cleanup();
    throw err;
  }
  const reader = run.openReader();
  let done = null;
  return {
    impl,
    role,
    run,
    ledger,
    merchant: m,
    reader,
    baseUrl: m.baseUrl,
    webhookSecret: m.webhookSecret,
    describe: () => ({ role, impl, ...run.describe() }),
    teardown({ failed = false } = {}) {
      done ??= (async () => {
        run.closeReaders();
        await m.close();
        const keep = failed && process.env.PAYPROBE_KEEP_FAILED_RUNS === '1';
        return run.cleanup({ keep });
      })();
      return done;
    },
  };
}

// An isolated run (startIsolatedMerchant) in the target shape harness/runner.js expects. The trace is
// the live HTTP-layer trace, used for concurrency evidence. teardown is the isolated run's own.
async function startAttackTarget(impl, { role = 'attack', tmpRoot } = {}) {
  const iso = await startIsolatedMerchant(impl, { role, tmpRoot });
  return {
    impl,
    baseUrl: iso.baseUrl,
    reader: iso.reader,
    ledger: iso.ledger,
    webhookSecret: iso.webhookSecret,
    keySecret: iso.merchant.keySecret,
    trace: iso.merchant.trace,
    run: iso.run,
    describe: iso.describe,
    teardown: iso.teardown,
  };
}

async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

module.exports = { IMPLS, startMerchant, startIsolatedMerchant, startAttackTarget, postJson };
