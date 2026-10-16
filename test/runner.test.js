'use strict';
// Unit tests for harness/runner.js and harness/concurrency.js, against the reference app only.
// None of these is an attack on the vulnerable app: they check the runner's record shape, isolation,
// freshness enforcement, timeouts, teardown, redaction and how it classifies and counts outcomes.
// Runs use a test-owned temp root.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { startAttackTarget } = require('./helpers');
const { MOCK_KEY_SECRET, MOCK_WEBHOOK_SECRET } = require('../merchant/config');
const { hmacHex, checkoutSignature } = require('../harness/mock-razorpay');
const { sha256 } = require('../harness/delivery');
const { validateMapping } = require('../harness/validator');
const { runScenario, summarize, freezeValidation, redact, writeResults, judge, requireStock, OUTCOME, CLEANUP_FAILED } = require('../harness/runner');
const { classifyDelivery } = require('../harness/concurrency');

const ROOT = path.join(__dirname, '..');
const V2 = require('../harness/mappings/v2/reference');
const masked = (s) => `<redacted:${crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)}>`;

let tmpRoot;
let frozen;
before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'payprobe-runner-test-'));
  const val = await startAttackTarget('reference', { role: 'validation', tmpRoot });
  try {
    const report = await validateMapping(V2, {
      target: { baseUrl: val.baseUrl, db: val.reader, webhookSecret: val.webhookSecret, ledger: val.ledger, database: val.describe() },
      root: ROOT,
      denyFiles: ['docs/SEEDED_BUGS.md'],
    });
    frozen = freezeValidation(report);
  } finally {
    await val.teardown();
  }
});
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// Wraps startAttackTarget so a test can see or alter the target (it stays the real thing otherwise).
const targetFactory = (tweak = () => {}, seen = []) => async () => {
  const t = await startAttackTarget('reference', { tmpRoot });
  await tweak(t, seen.length);
  seen.push(t);
  return t;
};
const run = (scenario, opts = {}) => runScenario(scenario, { repetitions: 1, startTarget: targetFactory(), ...frozen, ...opts });

const base = { modes: ['sequential', 'simultaneous', 'barrier'], targets: ['I1'], contract: [] };
const createOnly = async (ctx) => { await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT' })); };

// Creates an order and delivers one genuine capture: I1 has a paid order to check.
const purchase = {
  ...base,
  id: 'test-purchase',
  async play(ctx) {
    const o = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT', quantity: 1 }));
    ctx.fact('order', o);
    const paymentId = ctx.fact('paymentId', ctx.newPaymentId());
    await ctx.step('genuine capture', () => ctx.webhook(ctx.genuine('payment.captured', { paymentId, orderId: o.gatewayOrderId, amount: o.amount })));
  },
};

// A server that accepts connections and never answers.
async function stallServer() {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

describe('runner: record shape', () => {
  it('records identity, provenance, steps, exchanges, snapshots, verdicts, contract, concurrency and cleanup', async () => {
    const [r] = await run({ ...purchase, contract: [{ status: 'U', claim: 'example', ref: 'none' }] });
    assert.equal(r.schema, 'payprobe.run/v2');
    assert.equal(r.scenario, 'test-purchase');
    assert.equal(r.impl, 'reference');
    assert.equal(r.mode, 'sequential');
    assert.equal(r.repetition, 1);
    assert.deepEqual(r.steps.map((s) => s.label), ['create order', 'genuine capture']);
    assert.deepEqual(r.snapshots.map((s) => s.label), ['initial', 'create order', 'genuine capture', 'final']);
    const [create] = r.steps[0].exchanges;
    assert.equal(create.kind, 'createOrder');
    assert.equal(create.status, 201);
    assert.equal(create.routeValidation, 'confirmed');
    assert.equal(create.newGatewayOrders, 1);
    assert.deepEqual(create.request, { sku: 'TSHIRT', quantity: 1 });
    const [hook] = r.steps[1].exchanges;
    assert.equal(hook.kind, 'webhook');
    assert.equal(hook.genuine, true);
    assert.equal(hook.signatureValid, true);
    assert.equal(hook.signedWith, 'target_webhook_secret');
    assert.equal(hook.status, 200);
    assert.equal(hook.event.type, 'payment.captured');
    assert.deepEqual(r.verdicts.map((v) => v.id), ['I1', 'I2', 'I3', 'I4', 'I5', 'I6']);
    assert.deepEqual(r.contract, [{ status: 'U', claim: 'example', ref: 'none' }]);
    assert.deepEqual(r.conditionalOn, ['[U] example']);
    assert.equal(r.routes.verify.validation, 'cannot_verify', 'a route the validator did not exercise stays unconfirmed');
    assert.deepEqual(r.concurrency, { requested: false, status: 'not_applicable', deliveries: [] });
    assert.deepEqual(r.freshness, { passed: true, problems: [] });
    assert.deepEqual(r.initialState, { passed: true, failures: [] });
    assert.deepEqual(r.preconditions, { passed: true, failures: [] });
    assert.equal(r.outcome, OUTCOME.CLEAN);
    assert.equal(r.countedAs, OUTCOME.CLEAN);
    assert.deepEqual(r.cleanup, { ok: true, removed: true, kept: null, leftover: [], error: null });
    assert.equal(typeof r.database.runId, 'string');
    assert.equal(r.database.existedBefore, false);
    assert.ok(!('path' in r.database) && !('directory' in r.database));
    assert.equal(r.error, null);
  });

  it('contains no absolute local paths', async () => {
    const [r] = await run(purchase);
    const text = JSON.stringify(r);
    for (const p of [ROOT, os.tmpdir(), os.homedir(), tmpRoot]) {
      for (const v of [p, p.split(path.sep).join('/'), JSON.stringify(p).slice(1, -1)]) assert.ok(!text.toLowerCase().includes(v.toLowerCase()), `record contains ${v}`);
    }
  });

  it('writeResults redacts and refuses unsafe scenario ids', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'results-'));
    const file = writeResults('test-purchase', { note: path.join(os.tmpdir(), 'x'), razorpay_signature: 'abc123' }, { dir });
    assert.ok(path.basename(file).startsWith('test-purchase-'));
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /<tmp>/);
    assert.ok(!text.includes('abc123'));
    assert.throws(() => writeResults('../x', {}, { dir }), /unsafe scenario id/);
  });

  it('rejects invalid scenarios and unsupported modes', async () => {
    await assert.rejects(run({ ...purchase, targets: ['I9'] }), /targets must be I1-I5/);
    await assert.rejects(run({ ...purchase, contract: [{ status: 'X', claim: 'c' }] }), /contract status/);
    await assert.rejects(run({ ...purchase, modes: ['sequential'] }, { mode: 'barrier' }), /does not support mode barrier/);
    await assert.rejects(run({ ...purchase, initialState: 'yes' }), /initialState must be a function/);
  });
});

describe('runner: scenarios must declare target invariants', () => {
  it('a scenario with an empty or missing target list is rejected before any run', async () => {
    let started = 0;
    const startTarget = async () => { started++; return startAttackTarget('reference', { tmpRoot }); };
    await assert.rejects(runScenario({ ...purchase, targets: [] }, { ...frozen, startTarget }), /targets must name at least one invariant/);
    const { targets, ...noTargets } = purchase;
    await assert.rejects(runScenario(noTargets, { ...frozen, startTarget }), /targets must name at least one invariant/);
    assert.equal(started, 0, 'no target was started');
  });

  it('judge() never returns clean for an empty target list, even when every invariant passes', () => {
    const verdicts = ['I1', 'I2', 'I3', 'I4', 'I5'].map((id) => ({ id, status: 'pass', checked: 1, vacuous: false, violationKinds: [] }));
    const record = { preconditions: { failures: [] }, concurrency: { requested: false, deliveries: [] }, mode: 'sequential', verdicts };
    const j = judge(record, { targets: [] });
    assert.equal(j.outcome, OUTCOME.INCONCLUSIVE);
    assert.match(j.reasons.join(), /declares no target invariant/);
    assert.equal(judge(record, { targets: ['I1'] }).outcome, OUTCOME.CLEAN, 'control: the same verdicts with a target are clean');
  });
});

describe('runner: fresh run per repetition', () => {
  it('every repetition has its own database, ledger and app', async () => {
    const seen = [];
    const records = await runScenario(purchase, { repetitions: 3, startTarget: targetFactory(() => {}, seen), ...frozen });
    assert.equal(records.length, 3);
    assert.equal(new Set(records.map((r) => r.database.runId)).size, 3);
    assert.equal(new Set(seen.map((t) => t.ledger)).size, 3);
    assert.equal(new Set(seen.map((t) => t.baseUrl)).size, 3);
    for (const r of records) {
      const initial = r.snapshots[0];
      assert.deepEqual(initial.orders, [], 'no state carried over from an earlier repetition');
      assert.equal(initial.stock.TSHIRT, 100);
      assert.equal(Object.keys(r.ledger.orders).length, 1);
      assert.equal(r.outcome, OUTCOME.CLEAN);
      assert.equal(r.cleanup.ok, true);
    }
    for (const t of seen) assert.equal(fs.existsSync(t.run.dir), false);
    assert.deepEqual(summarize(records)[0].outcomes, { violation: 0, clean: 3, inconclusive: 0, error: 0, cleanup_failed: 0 });
  });

  it('a reused run id is a contaminated run: error, not clean, and the target is still torn down', async () => {
    const fixed = `fixed-${crypto.randomBytes(6).toString('hex')}`;
    const seen = [];
    const records = await runScenario(purchase, {
      ...frozen,
      repetitions: 2,
      startTarget: targetFactory((t) => { const d = t.describe; t.describe = () => ({ ...d(), runId: fixed }); }, seen),
    });
    assert.equal(records[0].outcome, OUTCOME.CLEAN);
    assert.equal(records[1].outcome, OUTCOME.ERROR);
    assert.equal(records[1].error.stage, 'freshness');
    assert.match(records[1].freshness.problems.join(), /already used by an earlier run/);
    assert.equal(records[1].steps.length, 0, 'the attack is not played on a contaminated target');
    assert.equal(records[1].cleanup.ok, true);
    assert.equal(fs.existsSync(seen[1].run.dir), false);
  });

  it('a reused ledger object is a contaminated run', async () => {
    let first;
    const records = await runScenario({ ...purchase, play: async () => {} }, {
      ...frozen,
      repetitions: 2,
      startTarget: targetFactory((t, i) => { if (i === 0) first = t.ledger; else t.ledger = first; }),
    });
    assert.notEqual(records[0].outcome, OUTCOME.ERROR);
    assert.equal(records[1].outcome, OUTCOME.ERROR);
    assert.match(records[1].freshness.problems.join(), /ledger object was already used/);
  });

  it('a ledger that is not empty at start is a contaminated run', async () => {
    const [r] = await run(purchase, { startTarget: targetFactory((t) => t.ledger.recordOrder({ id: 'order_leftover', amount: 1, currency: 'INR' })) });
    assert.equal(r.outcome, OUTCOME.ERROR);
    assert.match(r.freshness.problems.join(), /ledger is not empty at start/);
    assert.equal(r.cleanup.ok, true);
  });

  it('rows already in the database make the run inconclusive and the attack is not played', async () => {
    const plant = (t) => {
      const w = new DatabaseSync(t.run.dbPath);
      try {
        w.exec(`PRAGMA busy_timeout = 5000; INSERT INTO orders (id, razorpay_order_id, sku, quantity, amount, currency, status)
                VALUES ('ord_leftover', 'order_leftover', 'TSHIRT', 1, 49900, 'INR', 'created')`);
      } finally {
        w.close();
      }
    };
    const [r] = await run(purchase, { startTarget: targetFactory(plant) });
    assert.equal(r.outcome, OUTCOME.INCONCLUSIVE);
    assert.equal(r.countedAs, OUTCOME.INCONCLUSIVE);
    assert.match(r.reasons.join(), /initial state: orders: 1 row\(s\) before the attack/);
    assert.equal(r.steps.length, 0);
    assert.equal(r.cleanup.ok, true);
  });

  it('a failed scenario initialState declaration makes the run inconclusive', async () => {
    const [r] = await run({ ...purchase, initialState: (s) => requireStock(s, { TSHIRT: 1, NOSUCHSKU: 1 }) });
    assert.equal(r.outcome, OUTCOME.INCONCLUSIVE);
    assert.deepEqual(r.initialState.failures, ['stock NOSUCHSKU is absent, needs at least 1']);
    assert.equal(r.steps.length, 0);
  });
});

describe('runner: teardown and timeouts', () => {
  it('an exception in the scenario is recorded and the run is still torn down', async () => {
    const seen = [];
    const [r] = await run({ ...base, id: 'test-throws', async play(ctx) { await createOnly(ctx); throw new Error('boom'); } },
      { startTarget: targetFactory(() => {}, seen) });
    assert.equal(r.outcome, OUTCOME.ERROR);
    assert.deepEqual(r.error, { stage: 'play', message: 'boom', timedOut: false });
    assert.equal(r.cleanup.ok, true);
    assert.equal(seen[0].reader.isOpen, false);
    assert.equal(fs.existsSync(seen[0].run.dir), false);
  });

  it('a request outside a step is an error, not silently unrecorded', async () => {
    const [r] = await run({ ...base, id: 'test-no-step', async play(ctx) { await ctx.createOrder({ sku: 'TSHIRT' }); } });
    assert.equal(r.outcome, OUTCOME.ERROR);
    assert.match(r.error.message, /inside ctx.step/);
    assert.equal(r.cleanup.ok, true);
  });

  it('a target that fails to start is an error with nothing to tear down', async () => {
    const [r] = await run(purchase, { startTarget: async () => { throw new Error('cannot start'); } });
    assert.equal(r.outcome, OUTCOME.ERROR);
    assert.equal(r.error.stage, 'start');
    assert.equal(r.cleanup.note, 'no target was started');
  });

  it('a stalled request times out, is recorded, ends the run as an error, and teardown still runs', async () => {
    const stall = await stallServer();
    const seen = [];
    try {
      const t0 = Date.now();
      const [r] = await run(purchase, {
        requestTimeoutMs: 300,
        startTarget: targetFactory((t) => { t.baseUrl = stall.baseUrl; }, seen),
      });
      assert.ok(Date.now() - t0 < 5000, 'bounded by the timeout');
      assert.equal(r.outcome, OUTCOME.ERROR);
      assert.equal(r.error.timedOut, true);
      assert.match(r.error.message, /timed out after 300 ms/);
      const [x] = r.steps[0].exchanges;
      assert.equal(x.timedOut, true);
      assert.equal(x.status, null);
      assert.equal(x.error, 'timed out after 300 ms');
      assert.equal(r.cleanup.ok, true);
      assert.equal(seen[0].reader.isOpen, false);
      assert.equal(fs.existsSync(seen[0].run.dir), false);
    } finally {
      await stall.close();
    }
  });

  it('a stalled duplicate delivery is bounded too', async () => {
    const stall = await stallServer();
    const dup = {
      ...purchase,
      id: 'test-stalled-duplicate',
      async play(ctx) {
        const o = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT' }));
        stallNext();
        await ctx.step('duplicate capture', () => ctx.deliverTwice(ctx.genuine('payment.captured', { paymentId: ctx.newPaymentId(), orderId: o.gatewayOrderId, amount: o.amount })));
      },
    };
    let target;
    const stallNext = () => { target.baseUrl = stall.baseUrl; }; // order creation reaches the app; the deliveries stall
    try {
      const [r] = await run(dup, { mode: 'simultaneous', requestTimeoutMs: 1000, startTarget: targetFactory((t) => { target = t; }) });
      assert.equal(r.outcome, OUTCOME.ERROR);
      assert.equal(r.error.timedOut, true);
      assert.equal(r.concurrency.deliveries[0].classification, 'timed_out_or_failed');
      assert.equal(r.cleanup.ok, true);
    } finally {
      await stall.close();
    }
  });

  it('a teardown that never finishes is bounded and recorded as a cleanup failure', async () => {
    const seen = [];
    try {
      const [r] = await run(purchase, {
        teardownTimeoutMs: 200,
        startTarget: targetFactory((t) => { t.realTeardown = t.teardown; t.teardown = () => new Promise(() => {}); }, seen),
      });
      assert.equal(r.outcome, OUTCOME.CLEAN);
      assert.equal(r.countedAs, CLEANUP_FAILED);
      assert.equal(r.cleanup.ok, false);
      assert.match(r.cleanup.error, /teardown timed out after 200 ms/);
    } finally {
      await seen[0].realTeardown();
    }
  });

  it('a cleanup failure is recorded as not ok, with the leftover file, and counted as cleanup_failed', async () => {
    const seen = [];
    const [r] = await run({ ...purchase, id: 'test-stray-file', async play(ctx) { await purchase.play(ctx); fs.writeFileSync(path.join(seen[0].run.dir, 'stray.txt'), 'x'); } },
      { startTarget: targetFactory(() => {}, seen) });
    assert.equal(r.outcome, OUTCOME.CLEAN, 'the attack outcome itself is kept');
    assert.equal(r.countedAs, CLEANUP_FAILED);
    assert.equal(r.cleanup.ok, false);
    assert.deepEqual(r.cleanup.leftover, ['stray.txt']);
    assert.match(r.cleanup.error, /did not create/);
    const s = summarize([r])[0];
    assert.equal(s.cleanupFailures, 1);
    assert.equal(s.outcomes.clean, 0, 'a cleanup-failed run is not counted as clean');
    assert.equal(s.outcomes.cleanup_failed, 1);
  });
});

describe('runner: reproduction accounting', () => {
  const rec = (outcome, { targetsViolated = [], cleanupOk = true } = {}) => ({
    scenario: 's', impl: 'x', mode: 'sequential', outcome, countedAs: cleanupOk ? outcome : CLEANUP_FAILED, targetsViolated,
    verdicts: [], concurrency: { status: 'not_applicable' }, freshness: { passed: true }, initialState: { passed: true },
    preconditions: { failures: outcome === OUTCOME.INCONCLUSIVE ? ['p'] : [] }, cleanup: { ok: cleanupOk }, conditionalOn: [],
  });

  it('only violation outcomes with a target violation and successful cleanup count as reproduced', () => {
    const s = summarize([
      rec(OUTCOME.VIOLATION, { targetsViolated: ['I1'] }), // reproduced
      rec(OUTCOME.VIOLATION, { targetsViolated: [] }), // non-target violation only
      rec(OUTCOME.INCONCLUSIVE, { targetsViolated: ['I1'] }), // e.g. failed precondition or unverified concurrency
      rec(OUTCOME.VIOLATION, { targetsViolated: ['I1'], cleanupOk: false }),
      rec(OUTCOME.CLEAN),
      rec(OUTCOME.CLEAN, { cleanupOk: false }),
      rec(OUTCOME.ERROR),
    ])[0];
    assert.equal(s.runs, 7);
    assert.equal(s.reproducedCount, 1);
    assert.equal(s.reproduced, '1/7');
    assert.equal(s.targetViolatedButInconclusive, 1);
    assert.equal(s.targetViolatedButCleanupFailed, 1);
    assert.deepEqual(s.outcomes, { violation: 2, clean: 1, inconclusive: 1, error: 1, cleanup_failed: 2 });
  });

  it('a live run with a failed precondition and a target violation is inconclusive and not reproduced', async () => {
    const mapping = structuredClone(frozen.mapping);
    mapping.orders.paidValues = ['created', 'paid']; // makes I1 report a violation
    const [r] = await run({ ...base, id: 'test-p-and-v', play: createOnly, preconditions: () => ['setup did not hold'] }, { mapping });
    assert.equal(r.outcome, OUTCOME.INCONCLUSIVE);
    assert.deepEqual(r.targetsViolated, ['I1'], 'the violation is still recorded');
    const s = summarize([r])[0];
    assert.equal(s.reproducedCount, 0);
    assert.equal(s.targetViolatedButInconclusive, 1);
  });

  it('a live run with unverified concurrency and a target violation is inconclusive and not reproduced', async () => {
    const mapping = structuredClone(frozen.mapping);
    mapping.orders.paidValues = ['created', 'paid'];
    const dup = {
      ...base,
      id: 'test-c-and-v',
      async play(ctx) {
        const o = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT' }));
        await ctx.step('duplicate capture', () => ctx.deliverTwice(ctx.genuine('payment.captured', { paymentId: ctx.newPaymentId(), orderId: 'order_other', amount: o.amount })));
      },
    };
    const [r] = await run(dup, { mapping, mode: 'simultaneous', startTarget: targetFactory((t) => { t.trace = []; }) });
    assert.equal(r.outcome, OUTCOME.INCONCLUSIVE);
    assert.ok(r.targetsViolated.includes('I1'));
    assert.equal(summarize([r])[0].reproducedCount, 0);
  });
});

describe('runner: inconclusive is never clean', () => {
  const expectInconclusive = (r, pattern) => {
    assert.equal(r.outcome, OUTCOME.INCONCLUSIVE, JSON.stringify(r.reasons));
    assert.ok(r.reasons.some((x) => pattern.test(x)), JSON.stringify(r.reasons));
    assert.equal(r.cleanup.ok, true);
    assert.equal(summarize([r])[0].outcomes.clean, 0);
  };

  it('vacuous target invariant (nothing paid, so I1 checked nothing)', async () => {
    const [r] = await run({ ...base, id: 'test-vacuous', play: createOnly });
    expectInconclusive(r, /I1: vacuous/);
  });

  it('cannot_verify target invariant (mapping without paid values)', async () => {
    const mapping = structuredClone(frozen.mapping);
    delete mapping.orders.paidValues;
    const [r] = await run(purchase, { mapping });
    expectInconclusive(r, /I1: cannot_verify/);
  });

  it('generic precondition: the app rejected a genuine event (sent with the wrong secret)', async () => {
    const [r] = await run({
      ...purchase,
      id: 'test-bad-secret',
      async play(ctx) {
        const o = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT' }));
        await ctx.step('genuine capture, wrong secret', () => ctx.webhook(ctx.genuine('payment.captured', { paymentId: ctx.newPaymentId(), orderId: o.gatewayOrderId, amount: o.amount }), { secret: 'wrong' }));
      },
    });
    expectInconclusive(r, /genuine event sent without a valid signature/);
    assert.equal(r.steps[1].exchanges[0].signedWith, 'other_secret');
    assert.equal(r.preconditions.passed, false);
  });

  it('generic precondition: route not reached', async () => {
    const routes = structuredClone(frozen.routes);
    routes.createOrder.path = '/api/no-such-route';
    const [r] = await run({ ...base, id: 'test-no-route', play: createOnly }, { routes });
    expectInconclusive(r, /route not reached \(404\)/);
    assert.ok(r.reasons.some((x) => /order creation returned 404/.test(x)));
  });

  it('scenario precondition failure', async () => {
    const [r] = await run({ ...purchase, id: 'test-precondition', preconditions: () => ['the attack setup did not hold'] });
    expectInconclusive(r, /precondition: the attack setup did not hold/);
  });

  it('concurrency requested but not verified at the server', async () => {
    const dup = {
      ...purchase,
      id: 'test-duplicate',
      async play(ctx) {
        const o = await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT' }));
        await ctx.step('duplicate capture', () => ctx.deliverTwice(ctx.genuine('payment.captured', { paymentId: ctx.newPaymentId(), orderId: o.gatewayOrderId, amount: o.amount })));
      },
    };
    // Hide the server trace: the runner then has no evidence that the requests overlapped.
    const [r] = await run(dup, { mode: 'simultaneous', startTarget: targetFactory((t) => { t.trace = []; }) });
    expectInconclusive(r, /concurrency: simultaneous_but_not_overlapping/);
    assert.equal(r.concurrency.status, 'not_verified');
    assert.equal(r.concurrency.deliveries[0].verified, false);
    assert.equal(r.steps[1].exchanges.length, 2, 'both deliveries are recorded');
  });

  it('concurrency mode requested but the scenario made no concurrent delivery', async () => {
    const [r] = await run(purchase, { mode: 'simultaneous' });
    expectInconclusive(r, /no concurrent delivery was made/);
  });

  it('a violation is reported as violation (mapping that counts created orders as paid)', async () => {
    const mapping = structuredClone(frozen.mapping);
    mapping.orders.paidValues = ['created', 'paid'];
    const [r] = await run({ ...base, id: 'test-violation', play: createOnly }, { mapping });
    assert.equal(r.outcome, OUTCOME.VIOLATION);
    assert.deepEqual(r.targetsViolated, ['I1']);
    assert.ok(r.violatedInvariants.includes('I1'));
    assert.equal(summarize([r])[0].reproducedCount, 1);
  });
});

describe('runner: result safety', () => {
  it('redact() masks values under sensitive keys and listed secrets, keeps header names, and is idempotent', () => {
    const input = {
      razorpay_signature: 'abc123',
      headers: { 'x-razorpay-signature': 'deadbeef', authorization: 'Bearer t0ken', 'content-type': 'application/json' },
      signatureHeader: 'x-razorpay-signature',
      signatureValid: true,
      password: 'pw',
      apiKey: 'k1',
      client_secret: 's1',
      refreshToken: 'r1',
      note: 'the value supersecret123 appears in free text',
      list: ['supersecret123', 'ok'],
      path: path.join(os.tmpdir(), 'x'),
      route: '/api/orders/{orderId}/refunds',
    };
    const out = redact(input, { secrets: ['supersecret123'] });
    assert.equal(out.razorpay_signature, masked('abc123'));
    assert.equal(out.headers['x-razorpay-signature'], masked('deadbeef'));
    assert.equal(out.headers.authorization, masked('Bearer t0ken'));
    assert.equal(out.headers['content-type'], 'application/json');
    assert.equal(out.signatureHeader, 'x-razorpay-signature', 'a header name is not a secret');
    assert.equal(out.signatureValid, true);
    for (const k of ['password', 'apiKey', 'client_secret', 'refreshToken']) assert.match(out[k], /^<redacted:[0-9a-f]{12}>$/, k);
    assert.equal(out.note, `the value ${masked('supersecret123')} appears in free text`);
    assert.deepEqual(out.list, [masked('supersecret123'), 'ok']);
    assert.match(out.path, /^<tmp>/);
    assert.equal(out.route, '/api/orders/{orderId}/refunds');
    assert.deepEqual(redact(out, { secrets: ['supersecret123'] }), out, 'idempotent');
    assert.ok(!JSON.stringify(out).includes('supersecret123'));
  });

  it('a run that sends a checkout signature never writes the raw signature or the secrets', async () => {
    const checkout = {
      ...purchase,
      id: 'test-checkout-signature',
      async play(ctx) {
        const o = ctx.fact('order', await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT' })));
        const paymentId = ctx.fact('paymentId', ctx.newPaymentId());
        await ctx.step('genuine capture', () => ctx.webhook(ctx.genuine('payment.captured', { paymentId, orderId: o.gatewayOrderId, amount: o.amount })));
        const sig = ctx.checkoutSignature(o.gatewayOrderId, paymentId);
        await ctx.step('checkout callback', () => ctx.post('verify', {
          order_id: o.orderId, razorpay_order_id: o.gatewayOrderId, razorpay_payment_id: paymentId, razorpay_signature: sig,
        }));
      },
    };
    const [r] = await run(checkout);
    assert.equal(r.outcome, OUTCOME.CLEAN);
    const raw = checkoutSignature(r.facts.order.gatewayOrderId, r.facts.paymentId, MOCK_KEY_SECRET);
    const hookBody = r.steps[1].exchanges[0].body;
    const hookSig = hmacHex(MOCK_WEBHOOK_SECRET, hookBody);
    const text = JSON.stringify(r);
    for (const secret of [raw, hookSig, MOCK_KEY_SECRET, MOCK_WEBHOOK_SECRET]) assert.ok(!text.includes(secret), 'raw value written to record');
    const verify = r.steps[2].exchanges[0];
    assert.equal(verify.request.razorpay_signature, masked(raw));
    assert.equal(verify.body, null, 'JSON requests are kept as objects only');
    assert.deepEqual(r.derivedSignatures, [{ masked: masked(raw), kind: 'checkout', message: `${r.facts.order.gatewayOrderId}|${r.facts.paymentId}`, keyedWith: 'target_key_secret' }]);
  });
});

describe('runner: replayability and provenance', () => {
  it('records webhook body and headers, so the delivery can be re-signed and re-sent; signatures stay masked', async () => {
    const [r] = await run(purchase);
    const hook = r.steps[1].exchanges[0];
    assert.equal(typeof hook.body, 'string');
    assert.equal(sha256(Buffer.from(hook.body)), hook.requestBodySha256, 'body is exactly what was sent');
    assert.equal(JSON.parse(hook.body).payload.payment.entity.id, r.facts.paymentId);
    assert.equal(hook.headers['x-razorpay-event-id'], hook.eventId);
    assert.equal(hook.headers['content-type'], 'application/json');
    assert.equal(hook.signatureHeader, 'x-razorpay-signature');
    assert.equal(hook.headers['x-razorpay-signature'], masked(hmacHex(MOCK_WEBHOOK_SECRET, hook.body)), 're-signing the body with the target secret reproduces the masked value');
  });

  it('provenance holds the frozen mapping projection, its verdict, the code commit and dirty flag', async () => {
    const mapping = structuredClone(frozen.mapping);
    const [r] = await run(purchase, { mapping });
    const p = r.provenance;
    assert.deepEqual(p.mapping.projection, redact(mapping));
    assert.equal(p.mapping.verdict, 'validated');
    assert.equal(p.mapping.name, 'reference');
    assert.equal(typeof p.mapping.validationRunId, 'string');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: ROOT, encoding: 'utf8' }).trim() !== '';
    assert.equal(p.code.commit, head);
    assert.equal(p.code.dirty, dirty);
    if (dirty) assert.match(p.code.uncommittedSha256, /^[0-9a-f]{64}$/);
    assert.ok(p.code.changedFiles.every((f) => !path.isAbsolute(f)), 'repository-relative file names only');
    assert.equal(p.node, process.version);
  });
});

describe('runner: live barrier concurrency on the reference app', () => {
  it('barrier duplicate delivery through the runner is verified concurrent, and the reference app fulfils once', async () => {
    const dup = {
      id: 'test-barrier-duplicate',
      modes: ['barrier'],
      targets: ['I3'],
      contract: [],
      async play(ctx) {
        const o = ctx.fact('order', await ctx.step('create order', () => ctx.createOrder({ sku: 'TSHIRT', quantity: 2 })));
        await ctx.step('duplicate capture', () => ctx.deliverTwice(ctx.genuine('payment.captured', { paymentId: ctx.newPaymentId(), orderId: o.gatewayOrderId, amount: o.amount })));
      },
    };
    const records = await runScenario(dup, { ...frozen, mode: 'barrier', repetitions: 3, startTarget: targetFactory() });
    for (const r of records) {
      assert.equal(r.concurrency.status, 'verified', JSON.stringify(r.concurrency.deliveries));
      const d = r.concurrency.deliveries[0];
      assert.equal(d.classification, 'concurrent');
      assert.equal(d.barrier.reached, true);
      assert.equal(d.barrier.arrivedAtRelease, 2);
      assert.equal(d.barrier.finishedAtRelease, 0);
      assert.equal(d.identical, true);
      assert.equal(r.outcome, OUTCOME.CLEAN, JSON.stringify(r.reasons));
      const final = r.snapshots.at(-1);
      assert.equal(final.fulfillments.filter((f) => f.orderId === r.facts.order.orderId).length, 1);
      assert.equal(r.snapshots[0].stock.TSHIRT - final.stock.TSHIRT, 2);
      assert.equal(r.cleanup.ok, true);
    }
    assert.equal(summarize(records)[0].verifiedConcurrent, 3);
  });
});

describe('concurrency classification', () => {
  const server = (a, b) => [{ arrivedMs: a[0], finishedMs: a[1] }, { arrivedMs: b[0], finishedMs: b[1] }];
  it('sequential stays sequential', () => {
    assert.equal(classifyDelivery('sequential', { clientOverlap: false }, server([0, 1], [2, 3])).classification, 'sequential');
  });
  it('simultaneous counts only with server overlap', () => {
    assert.equal(classifyDelivery('simultaneous', { clientOverlap: true }, server([0, 5], [1, 6])).verified, true);
    assert.equal(classifyDelivery('simultaneous', { clientOverlap: true }, server([0, 1], [2, 3])).classification, 'simultaneous_but_not_overlapping');
    assert.equal(classifyDelivery('simultaneous', { clientOverlap: true }, []).verified, false);
  });
  it('barrier counts only when reached with both in flight and released before either finished', () => {
    const barrier = { reached: true, arrivedAtRelease: 2, finishedAtRelease: 0, releasedAtMs: 4 };
    assert.equal(classifyDelivery('barrier', { barrier }, server([0, 6], [1, 7])).verified, true);
    assert.equal(classifyDelivery('barrier', { barrier: { ...barrier, reached: false } }, server([0, 6], [1, 7])).classification, 'barrier_not_verified');
    assert.equal(classifyDelivery('barrier', { barrier: { ...barrier, finishedAtRelease: 1 } }, server([0, 6], [1, 7])).verified, false);
    assert.equal(classifyDelivery('barrier', { barrier }, server([0, 3], [1, 7])).verified, false, 'finished before release');
  });
});
