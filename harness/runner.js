'use strict';
// Scenario runner: one attack, N repetitions, each against a fresh app, database and gateway ledger.
//
//   const frozen = freezeValidation(report);              // mapping + routes from a validator report
//   const records = await runScenario(scenario, {
//     mode: 'sequential', repetitions: 3,
//     startTarget: () => startAttackTarget('reference'),   // supplied by the caller (harness never imports merchant/)
//     ...frozen,
//   });
//   const summary = summarize(records);
//   writeResults(scenario.id, { summary, records });       // results/<id>-<stamp>.json, redacted
//
// A scenario is { id, title, modes, targets, contract, play(ctx), initialState?(snapshot), preconditions?(view) }
// and never sees which app it attacks: both apps receive the same sequence of requests. `targets` must
// name at least one of I1-I5. `contract` lists the gateway behaviour the attack relies on, each labelled
// 'V' (documented), 'U' (not established) or 'A' (modelling assumption); see docs/GATEWAY_CONTRACT.md.
// An optional `basis` refines the class ('documented', 'fixture-specific', 'inference', 'unresolved',
// 'not-established'); the runner copies it into records but does not interpret it.
//
// A target is { baseUrl, reader, ledger, webhookSecret, keySecret, trace?, describe(), teardown({ failed }) }.
// The runner owns the target it is given and always tears it down. Freshness is enforced, not assumed:
// a run id or ledger object seen before (in this process), or a non-empty ledger, is an error; mapped
// orders, payments, fulfilments or refunds already present, or a failed scenario initialState(), make the
// run inconclusive and the attack is not played.
//
// Outcome per run (state invariants are I1-I5; I6 is not a snapshot property):
//   error         the run threw (start, freshness, play, timeout or check)
//   inconclusive  initial state or a precondition failed, requested concurrency was not verified, or a
//                 target invariant was cannot_verify or vacuous. Never counted as clean or reproduced.
//   violation     any of I1-I5 reported a violation (targetsViolated says whether it was a target)
//   clean         none of the above, and every target invariant passed with something checked
// `countedAs` is the outcome, or 'cleanup_failed' when teardown did not succeed; summaries count by it.
// HTTP requests time out (requestTimeoutMs) and teardown is bounded (teardownTimeoutMs).
//
// Records are safe to keep: absolute local paths are redacted, values under keys that indicate
// signatures, secrets, tokens, authorization or passwords are replaced by a short hash, and the target's
// secrets and every signature the runner computed are masked wherever they appear. Webhook bodies are
// kept (they carry no signature): a run can be replayed by re-signing each body with the target's secret.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const { takeSnapshot } = require('./snapshot');
const { checkAll, STATUS } = require('./invariants');
const { genuinePaymentEvent, paymentEvent, newPaymentId, newEventId, hmacHex, checkoutSignature } = require('./mock-razorpay');
const { prepareDelivery, signatureMatches, deliverTwice, sha256 } = require('./delivery');
const { classifyDelivery } = require('./concurrency');

const RECORD_SCHEMA = 'payprobe.run/v2';
const MODES = ['sequential', 'simultaneous', 'barrier'];
const STATE_INVARIANTS = ['I1', 'I2', 'I3', 'I4', 'I5'];
const CONTRACT_LABELS = ['V', 'U', 'A'];
const OUTCOME = Object.freeze({ VIOLATION: 'violation', CLEAN: 'clean', INCONCLUSIVE: 'inconclusive', ERROR: 'error' });
const CLEANUP_FAILED = 'cleanup_failed';
const COUNTED = [...Object.values(OUTCOME), CLEANUP_FAILED];
const BODY_LIMIT = 2048;
const REQUEST_TIMEOUT_MS = 10_000;
const TEARDOWN_TIMEOUT_MS = 15_000;
const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_WEBHOOK_PATH = '/webhooks/razorpay'; // the only path harness/delivery.js sends to
const FRESH_ENTITIES = ['orders', 'payments', 'fulfillments', 'refunds'];

// Run ids and ledgers already handed to the runner in this process: reuse means a contaminated run.
const USED = { runIds: new Set(), ledgers: new WeakSet() };

const ok2xx = (s) => s >= 200 && s < 300;
const tryJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const clip = (text) => (text == null ? null : text.length > BODY_LIMIT ? `${text.slice(0, BODY_LIMIT)}…(${text.length} bytes)` : text);

function withTimeout(promise, ms, what) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`runner: ${what} timed out after ${ms} ms`), { timedOut: true })), ms);
  });
  promise.catch(() => {}); // a late rejection after the guard fired is not unhandled
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------- redaction

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SENSITIVE_KEY = /(signature|secret|token|authori[sz]ation|password|passwd|api[-_]?key|cookie)/i;
const NAME_KEY = /(Header|Name|Valid)$/; // e.g. signatureHeader holds a header name, not a value
const MASKED = /^<redacted:[0-9a-f]{12}>$/;
const mask = (s) => (MASKED.test(s) ? s : `<redacted:${crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12)}>`);
const isSensitiveKey = (k) => typeof k === 'string' && SENSITIVE_KEY.test(k) && !NAME_KEY.test(k);

function knownPrefixes() {
  const out = [];
  for (const [label, p] of [['<repo>', REPO_ROOT], ['<tmp>', os.tmpdir()], ['<home>', os.homedir()]]) {
    const variants = new Set([p]);
    for (const resolve of [fs.realpathSync, fs.realpathSync.native]) {
      try {
        variants.add(resolve(p));
      } catch {
        // path may not exist
      }
    }
    for (const v of [...variants]) {
      variants.add(v.split(path.sep).join('/'));
      variants.add(v.split(path.sep).join('\\\\')); // as it appears inside JSON-escaped text
    }
    for (const v of variants) if (v && v.length > 3) out.push([v, label]);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

const PREFIXES = knownPrefixes();
const WIN_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)[^\s"'<>|]*/g;
const POSIX_PATH = /(?<![\w.<>-])\/(?:home|Users|tmp|var|private|root)\/[^\s"'<>]*/g;
const flags = process.platform === 'win32' ? 'gi' : 'g';

function redactString(s, secrets) {
  let out = s;
  for (const secret of secrets) if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join(mask(secret));
  for (const [prefix, label] of PREFIXES) out = out.replace(new RegExp(escapeRe(prefix), flags), label);
  return out.replace(WIN_PATH, '<path>').replace(POSIX_PATH, '<path>');
}

// Deep copy: strings under sensitive keys are masked; every other string has the given secret values
// masked and local absolute paths scrubbed. Idempotent.
function redact(value, { secrets = [] } = {}, key = null) {
  const list = [...secrets].filter((s) => typeof s === 'string' && s);
  const walk = (v, k) => {
    if (typeof v === 'string') return isSensitiveKey(k) ? mask(v) : redactString(v, list);
    if (Array.isArray(v)) return v.map((x) => walk(x, k));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]));
    return v;
  };
  return walk(value, key);
}

// ---------------------------------------------------------------- provenance

// Commit, dirty flag and a fingerprint of uncommitted content (tracked diff plus untracked files), so a
// record can be tied to the exact code that produced it. File names are repository-relative.
function codeVersion() {
  const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  try {
    const commit = git(['rev-parse', 'HEAD']).trim();
    const changed = git(['status', '--porcelain', '--untracked-files=all']).split(/\r?\n/).filter(Boolean).map((l) => l.slice(3));
    const untracked = git(['ls-files', '--others', '--exclude-standard']).split(/\r?\n/).filter(Boolean).sort();
    const h = crypto.createHash('sha256').update(git(['diff', 'HEAD', '--binary']));
    for (const f of untracked) h.update(`\0${f}\0`).update(fs.readFileSync(path.join(REPO_ROOT, f)));
    return {
      commit,
      dirty: changed.length > 0,
      changedFiles: changed.slice(0, 100),
      changedFilesTotal: changed.length,
      uncommittedSha256: changed.length ? h.digest('hex') : null,
    };
  } catch (err) {
    return { commit: null, dirty: null, changedFiles: [], changedFilesTotal: null, uncommittedSha256: null, error: `git unavailable: ${err?.code ?? err?.message}` };
  }
}

// ---------------------------------------------------------------- frozen mapping

// From a validator report (harness/validator.js): the projected v1 mapping (confirmed entries only)
// and the routes with their validation status. A route the validator never exercised keeps its
// status (cannot_verify): issuing requests to it later does not make it validated.
function freezeValidation(report) {
  if (report?.verdict !== 'validated') throw new Error(`runner: mapping not validated (verdict ${report?.verdict})`);
  const routes = {};
  for (const [name, e] of Object.entries(report.mapping.routes ?? {})) {
    if (e?.value) routes[name] = { ...e.value, validation: e.validation?.status ?? 'unknown' };
  }
  return {
    mapping: report.legacy,
    routes,
    mappingInfo: {
      name: report.mapping.name,
      provenance: report.mapping.provenance,
      verdict: report.verdict,
      negativeControl: report.negativeControl?.result ?? null,
      validationRunId: report.database?.runId ?? null,
    },
  };
}

// ---------------------------------------------------------------- scenario helpers

// For scenario.initialState: every listed sku must be in mapped stock with at least this quantity.
function requireStock(snapshot, needs) {
  if (!snapshot.stock) return ['stock is not available through the mapping'];
  return Object.entries(needs)
    .filter(([sku, qty]) => !(snapshot.stock[sku] >= qty))
    .map(([sku, qty]) => `stock ${sku} is ${snapshot.stock[sku] ?? 'absent'}, needs at least ${qty}`);
}

function genericInitialState(snapshot) {
  return FRESH_ENTITIES.filter((e) => Array.isArray(snapshot[e]) && snapshot[e].length > 0)
    .map((e) => `${e}: ${snapshot[e].length} row(s) before the attack; the database is not fresh`);
}

// ---------------------------------------------------------------- context

function fillPath(template, params) {
  return template.replace(/\{(\w+)\}/g, (m, k) => {
    if (!(k in params)) throw new Error(`runner: path parameter ${k} missing for ${template}`);
    return encodeURIComponent(params[k]);
  });
}

function fillBody(template, values) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{(\w+)\}$/);
    if (whole && whole[1] in values) return values[whole[1]];
    return template;
  }
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, t]) => [k, fillBody(t, values)]));
  return template;
}

const eventSummary = (event) => {
  const p = event?.payload?.payment?.entity;
  return { type: event?.event ?? null, paymentId: p?.id ?? null, gatewayOrderId: p?.order_id ?? null, amount: p?.amount ?? null, currency: p?.currency ?? null };
};

// secrets: a Set the context adds every signature it computes to, so they can be masked in the record.
function createContext({ target, mapping, routes, mode, record, clock, secrets, requestTimeoutMs }) {
  const genuineEvents = new WeakSet();
  let current = null;

  const snapshot = (label) => {
    const s = takeSnapshot(target.reader, mapping, { label });
    record.snapshots.push(s);
    return s;
  };

  const route = (name) => {
    const r = routes[name];
    if (!r?.path) throw new Error(`runner: route ${name} is not in the frozen mapping`);
    return r;
  };

  function push(x) {
    if (!current) throw new Error('runner: requests must be made inside ctx.step(label, fn)');
    current.exchanges.push(x);
    return x;
  }

  const signedWith = (secret) => {
    if (!secret) return 'none';
    return secret === target.webhookSecret ? 'target_webhook_secret' : 'other_secret';
  };

  // Records the request (method, path, headers, body) and response. A timeout is recorded and then
  // thrown, so the run ends as an error and teardown runs; other transport errors are recorded and
  // become a failed precondition.
  async function send(name, { json, raw, headers = {}, params = {}, meta = {} }) {
    const r = route(name);
    const method = r.method ?? 'POST';
    const urlPath = fillPath(r.path, params);
    const body = raw ?? (json === undefined ? undefined : JSON.stringify(json));
    const allHeaders = { 'content-type': 'application/json', ...headers };
    if (!current) throw new Error('runner: requests must be made inside ctx.step(label, fn)');
    const x = {
      route: name,
      routeValidation: r.validation ?? 'unknown',
      method,
      path: urlPath,
      headers: allHeaders,
      // JSON requests are kept as objects (sensitive keys masked); only raw bodies (webhooks) are kept as text.
      request: raw === undefined ? json ?? null : undefined,
      body: raw ?? null,
      requestBodySha256: body === undefined ? null : sha256(Buffer.from(body)),
      ...meta,
      status: null,
      response: null,
      error: null,
      timedOut: false,
      startMs: clock(),
    };
    let text = null;
    try {
      const res = await fetch(`${target.baseUrl}${urlPath}`, { method, headers: allHeaders, body, signal: AbortSignal.timeout(requestTimeoutMs) });
      x.status = res.status;
      text = await res.text();
    } catch (err) {
      x.timedOut = err?.name === 'TimeoutError';
      x.error = x.timedOut ? `timed out after ${requestTimeoutMs} ms` : String(err?.message ?? err);
    }
    x.endMs = clock();
    const parsed = tryJson(text);
    x.response = parsed !== undefined ? parsed : clip(text);
    push(x);
    if (x.timedOut) throw Object.assign(new Error(`runner: ${method} ${urlPath} timed out after ${requestTimeoutMs} ms`), { timedOut: true });
    return { status: x.status, json: parsed, exchange: x };
  }

  return {
    newPaymentId,

    // A copy of a frozen route (path, body template, response field names, validation status).
    routeSpec: (name) => structuredClone(route(name)),

    async step(label, fn) {
      if (current) throw new Error('runner: steps cannot be nested');
      current = { label, exchanges: [], snapshot: label };
      record.steps.push(current);
      try {
        return await fn();
      } finally {
        current = null;
        snapshot(label);
      }
    },

    // Creates an order through the mapped order-creation route; returns the merchant and gateway ids.
    async createOrder({ sku, quantity = 1 }) {
      const r = route('createOrder');
      const before = new Set(Object.keys(target.ledger.view().orders));
      const res = await send('createOrder', { json: fillBody(r.body ?? { sku: '{sku}', quantity: '{quantity}' }, { sku, quantity }), meta: { kind: 'createOrder' } });
      const created = Object.values(target.ledger.view().orders).filter((o) => !before.has(o.id));
      res.exchange.newGatewayOrders = created.length;
      const pick = (field) => (r.response?.[field] && res.json ? res.json[r.response[field]] : undefined);
      return {
        status: res.status,
        orderId: pick('orderId'),
        gatewayOrderId: pick('gatewayOrderId'),
        amount: pick('amount'),
        currency: pick('currency'),
        gatewayOrder: created.length === 1 ? created[0] : null,
      };
    },

    // An event the simulated gateway really produced: recorded in the ledger first.
    genuine(type, fields) {
      const event = genuinePaymentEvent(target.ledger, type, fields);
      genuineEvents.add(event);
      record.genuinePayments.push({ type, paymentId: fields.paymentId });
      return event;
    },

    // Same shape, never in the ledger.
    forged(type, fields) {
      return paymentEvent(type, fields);
    },

    // One webhook delivery. secret: defaults to the app's webhook secret; null sends it unsigned.
    // The body is recorded; the signature header value is not (it is masked, see redact()).
    async webhook(event, { secret = target.webhookSecret, eventId = newEventId() } = {}) {
      const r = route('webhook');
      const signatureHeader = r.signatureHeader ?? 'x-razorpay-signature';
      const raw = JSON.stringify(event);
      const headers = { 'x-razorpay-event-id': eventId };
      if (r.eventIdHeader) headers[r.eventIdHeader] = eventId;
      let signature = null;
      if (secret) {
        signature = hmacHex(secret, raw);
        secrets.add(signature);
        headers[signatureHeader] = signature;
      }
      const genuine = genuineEvents.has(event);
      return send('webhook', {
        raw,
        headers,
        meta: {
          kind: 'webhook',
          event: eventSummary(event),
          eventId,
          genuine,
          signed: Boolean(secret),
          signedWith: signedWith(secret),
          signatureHeader,
          signatureValid: signature !== null && hmacHex(target.webhookSecret, raw) === signature,
        },
      });
    },

    // Two byte-identical deliveries in the runner's mode, through harness/delivery.js unchanged.
    // Bounded: delivery.js times out barrier responses itself; the whole call is also raced against a
    // timeout, after which the run is an error (the pending requests are left to teardown).
    async deliverTwice(event) {
      if (!current) throw new Error('runner: requests must be made inside ctx.step(label, fn)');
      const webhookPath = route('webhook').path; // the mapped path, so concurrency works on any app
      const prepared = prepareDelivery(event, { secret: target.webhookSecret });
      secrets.add(prepared.signature);
      const trace = target.trace ?? [];
      const first = trace.length;
      const serverTrace = () => trace.slice(first).filter((t) => t.url === webhookPath);
      const limitMs = 2 * requestTimeoutMs + 2000;
      let delivery;
      try {
        delivery = await withTimeout(deliverTwice(target.baseUrl, prepared, {
          mode,
          webhookPath,
          responseTimeoutMs: requestTimeoutMs,
          observe: () => {
            const w = serverTrace();
            return { arrived: w.length, finished: w.filter((t) => t.finishedMs !== undefined).length };
          },
        }), limitMs, `duplicate delivery (${mode})`);
      } catch (err) {
        record.concurrency.deliveries.push({ step: current.label, mode, classification: 'timed_out_or_failed', verified: false, error: String(err?.message ?? err) });
        throw err;
      }
      const server = serverTrace().map((t) => ({ arrivedMs: t.arrivedMs, finishedMs: t.finishedMs, status: t.status }));
      const evidence = classifyDelivery(mode, delivery, server);
      record.concurrency.deliveries.push({ step: current.label, identical: delivery.identical, ...evidence });
      const genuine = genuineEvents.has(event);
      const body = prepared.body.toString('utf8');
      for (const q of delivery.requests) {
        push({
          route: 'webhook',
          routeValidation: route('webhook').validation ?? 'unknown',
          method: 'POST',
          path: webhookPath,
          headers: { 'content-type': 'application/json', 'x-razorpay-event-id': prepared.eventId, 'x-razorpay-signature': prepared.signature },
          body,
          kind: 'webhook',
          event: eventSummary(event),
          eventId: prepared.eventId,
          genuine,
          signed: true,
          signedWith: 'target_webhook_secret',
          signatureHeader: 'x-razorpay-signature',
          signatureValid: signatureMatches(prepared, target.webhookSecret),
          requestBodySha256: q.bodySha256,
          status: q.status,
          response: tryJson(q.responseBody) ?? clip(q.responseBody),
          error: null,
          timedOut: false,
          startMs: q.startMs,
          endMs: q.endMs,
          deliveryIndex: q.index,
        });
      }
      return evidence;
    },

    // The checkout signature Razorpay returns to the browser: HMAC(key secret, "order_id|payment_id").
    // Usable by the scenario; never written raw to the record.
    checkoutSignature(gatewayOrderId, paymentId) {
      const signature = checkoutSignature(gatewayOrderId, paymentId, target.keySecret);
      secrets.add(signature);
      // For replay: which masked value this is and how to recompute it.
      record.derivedSignatures.push({ masked: mask(signature), kind: 'checkout', message: `${gatewayOrderId}|${paymentId}`, keyedWith: 'target_key_secret' });
      return signature;
    },

    // Any other mapped route (e.g. 'verify').
    post(name, json, { params, meta } = {}) {
      return send(name, { json, params, meta: { kind: name, ...meta } });
    },

    // Scenario facts for preconditions and for the caller's liveness checks (ids, amounts).
    fact(key, value) {
      record.facts[key] = value;
      return value;
    },

    snapshot,
  };
}

// ---------------------------------------------------------------- judgement

function genericPreconditions(record) {
  const failures = [];
  const exchanges = record.steps.flatMap((s) => s.exchanges.map((x) => ({ ...x, step: s.label })));
  for (const x of exchanges) {
    const where = `${x.step}: ${x.method} ${x.path}`;
    if (x.error) failures.push(`${where}: request failed (${x.error})`);
    else if (x.status === 404 || x.status === 405) failures.push(`${where}: route not reached (${x.status})`);
    if (x.kind === 'createOrder') {
      if (!ok2xx(x.status)) failures.push(`${where}: order creation returned ${x.status}`);
      else if (x.newGatewayOrders !== 1) failures.push(`${where}: expected one new gateway order, ledger has ${x.newGatewayOrders}`);
    }
    if (x.kind === 'webhook' && x.genuine) {
      if (!x.signatureValid) failures.push(`${where}: genuine event sent without a valid signature`);
      else if (!ok2xx(x.status)) failures.push(`${where}: app did not accept a genuine signed event (${x.status})`);
    }
  }
  const ledger = record.ledger ?? { payments: {} };
  for (const g of record.genuinePayments) {
    if (!ledger.payments[g.paymentId]) failures.push(`ledger has no record of genuine payment ${g.paymentId}`);
  }
  return failures;
}

// Pure: decides the outcome from a record's preconditions, concurrency evidence and verdicts.
function judge(record, scenario) {
  const reasons = [...record.preconditions.failures.map((f) => `precondition: ${f}`)];
  if (!scenario.targets?.length) reasons.push('scenario declares no target invariant; nothing it claims was checked');
  const c = record.concurrency;
  if (c.requested) {
    if (!c.deliveries.length) reasons.push(`concurrency: mode ${record.mode} requested but no concurrent delivery was made`);
    for (const d of c.deliveries) if (!d.verified) reasons.push(`concurrency: ${d.classification}`);
  }
  const byId = Object.fromEntries(record.verdicts.map((v) => [v.id, v]));
  const violatedInvariants = STATE_INVARIANTS.filter((id) => byId[id]?.status === STATUS.VIOLATION);
  const targetsViolated = (scenario.targets ?? []).filter((id) => violatedInvariants.includes(id));
  const result = (outcome, why) => ({ outcome, reasons: why, violatedInvariants, targetsViolated });
  if (reasons.length) return result(OUTCOME.INCONCLUSIVE, reasons);
  if (violatedInvariants.length) return result(OUTCOME.VIOLATION, violatedInvariants.map((id) => `${id}: ${byId[id].violationKinds.join(', ')}`));
  for (const id of scenario.targets) {
    const v = byId[id];
    if (!v) reasons.push(`${id}: no verdict`);
    else if (v.status === STATUS.CANNOT_VERIFY) reasons.push(`${id}: cannot_verify`);
    else if (v.vacuous || v.checked === 0) reasons.push(`${id}: vacuous (nothing in scope was checked)`);
  }
  return reasons.length ? result(OUTCOME.INCONCLUSIVE, reasons) : result(OUTCOME.CLEAN, []);
}

const verdictSummary = (results) => results.map((r) => ({
  id: r.id,
  status: r.status,
  checked: r.checked,
  vacuous: Boolean(r.vacuous),
  violationKinds: r.violations.map((v) => v.kind),
  violations: r.violations,
  unverifiable: r.unverifiable,
}));

function checkScenario(scenario) {
  const problems = [];
  if (!scenario?.id || typeof scenario.play !== 'function') problems.push('scenario needs id and play()');
  if (!Array.isArray(scenario?.modes) || !scenario.modes.length || !scenario.modes.every((m) => MODES.includes(m))) problems.push(`modes must be a non-empty subset of ${MODES.join(', ')}`);
  if (!Array.isArray(scenario?.targets) || !scenario.targets.length) problems.push('targets must name at least one invariant');
  else if (!scenario.targets.every((t) => STATE_INVARIANTS.includes(t))) problems.push('targets must be I1-I5 ids');
  for (const c of scenario?.contract ?? []) if (!CONTRACT_LABELS.includes(c.status)) problems.push(`contract status must be one of ${CONTRACT_LABELS.join(', ')}`);
  for (const hook of ['initialState', 'preconditions']) if (scenario?.[hook] !== undefined && typeof scenario[hook] !== 'function') problems.push(`${hook} must be a function`);
  if (problems.length) throw new Error(`runner: invalid scenario: ${problems.join('; ')}`);
}

// Problems that make a target unusable as a fresh run. Registers the run id and ledger as used.
function freshnessProblems(target, d) {
  const problems = [];
  if (typeof d.runId !== 'string' || !d.runId) problems.push('target has no run id; freshness cannot be checked');
  else if (USED.runIds.has(d.runId)) problems.push(`run id ${d.runId} was already used by an earlier run`);
  else USED.runIds.add(d.runId);
  if (!target.ledger || typeof target.ledger.view !== 'function') {
    problems.push('target has no gateway ledger');
  } else {
    if (USED.ledgers.has(target.ledger)) problems.push('gateway ledger object was already used by an earlier run');
    USED.ledgers.add(target.ledger);
    const v = target.ledger.view();
    const held = v.log.length + Object.keys(v.orders).length + Object.keys(v.payments).length + v.refunds.length;
    if (held) problems.push(`gateway ledger is not empty at start (${v.log.length} log entries)`);
  }
  return problems;
}

// ---------------------------------------------------------------- entry points

async function runOnce(scenario, { mode, repetition, startTarget, mapping, routes, mappingInfo, clock, code, requestTimeoutMs, teardownTimeoutMs }) {
  const t0 = clock();
  const secrets = new Set();
  const record = {
    schema: RECORD_SCHEMA,
    scenario: scenario.id,
    title: scenario.title ?? null,
    impl: null,
    mode,
    repetition,
    startedAt: new Date().toISOString(),
    durationMs: null,
    targets: [...scenario.targets],
    contract: structuredClone(scenario.contract ?? []),
    conditionalOn: (scenario.contract ?? []).filter((c) => c.status !== 'V').map((c) => `[${c.status}] ${c.claim}`),
    provenance: {
      mapping: { ...(mappingInfo ?? { name: mapping?.name ?? null, provenance: mapping?.provenance ?? null, verdict: null }), projection: structuredClone(mapping) },
      code,
      node: process.version,
      requestTimeoutMs,
    },
    routes: Object.fromEntries(Object.entries(routes).map(([k, r]) => [k, { method: r.method ?? 'POST', path: r.path, validation: r.validation ?? 'unknown' }])),
    database: null,
    freshness: null,
    initialState: null,
    steps: [],
    snapshots: [],
    facts: {},
    genuinePayments: [],
    derivedSignatures: [], // checkout signatures: masked value + inputs; webhook ones are recomputed from body + signedWith
    concurrency: { requested: mode !== 'sequential', status: null, deliveries: [] },
    ledger: null,
    verdicts: [],
    preconditions: { passed: false, failures: [] },
    outcome: null,
    countedAs: null,
    reasons: [],
    violatedInvariants: [],
    targetsViolated: [],
    cleanup: null,
    error: null,
  };
  let target = null;
  let stage = 'start';
  try {
    target = await startTarget();
    for (const s of [target.webhookSecret, target.keySecret]) if (s) secrets.add(s);
    const d = target.describe?.() ?? {};
    record.impl = d.impl ?? target.impl ?? null;
    record.database = { runId: d.runId ?? null, fileName: d.fileName ?? null, existedBefore: d.existedBefore ?? null, createdAt: d.createdAt ?? null, role: d.role ?? null };

    stage = 'freshness';
    const stale = freshnessProblems(target, d);
    record.freshness = { passed: stale.length === 0, problems: stale };
    if (stale.length) throw new Error(`contaminated run: ${stale.join('; ')}`);

    stage = 'initial';
    const ctx = createContext({ target, mapping, routes, mode, record, clock, secrets, requestTimeoutMs });
    const initial = ctx.snapshot('initial');
    const initialFailures = [...genericInitialState(initial), ...(scenario.initialState?.(initial) ?? [])];
    record.initialState = { passed: initialFailures.length === 0, failures: initialFailures };
    if (initialFailures.length) {
      record.outcome = OUTCOME.INCONCLUSIVE;
      record.reasons = initialFailures.map((f) => `initial state: ${f}`);
    } else {
      stage = 'play';
      await scenario.play(ctx);
      stage = 'check';
      ctx.snapshot('final');
      record.ledger = target.ledger.view();
      // Concurrency status is set before the checks so I6 can aggregate I1-I5 under verified overlap.
      const c = record.concurrency;
      c.status = !c.requested ? 'not_applicable' : c.deliveries.length && c.deliveries.every((x) => x.verified) ? 'verified' : 'not_verified';
      record.verdicts = verdictSummary(checkAll({ snapshots: record.snapshots, ledger: record.ledger, concurrency: c }));
      const failures = [...genericPreconditions(record), ...(scenario.preconditions?.({ record, facts: record.facts, ledger: record.ledger, final: record.snapshots.at(-1) }) ?? [])];
      record.preconditions = { passed: failures.length === 0, failures };
      Object.assign(record, judge(record, scenario));
    }
  } catch (err) {
    record.error = { stage, message: String(err?.message ?? err), timedOut: Boolean(err?.timedOut) };
    record.outcome = OUTCOME.ERROR;
    record.reasons = [`error during ${stage}: ${record.error.message}`];
  } finally {
    if (target) {
      try {
        const failed = record.outcome !== OUTCOME.CLEAN && record.outcome !== OUTCOME.VIOLATION;
        const c = await withTimeout(Promise.resolve().then(() => target.teardown({ failed })), teardownTimeoutMs, 'teardown');
        record.cleanup = { ok: c?.removed === true || Boolean(c?.kept), removed: Boolean(c?.removed), kept: c?.kept ?? null, leftover: c?.leftover ?? [], error: c?.error ?? null };
      } catch (err) {
        record.cleanup = { ok: false, removed: false, kept: null, leftover: [], error: String(err?.message ?? err) };
      }
    } else {
      record.cleanup = { ok: true, removed: false, kept: null, leftover: [], error: null, note: 'no target was started' };
    }
    record.countedAs = record.cleanup.ok ? record.outcome : CLEANUP_FAILED;
    record.durationMs = Math.round(clock() - t0);
  }
  return redact(record, { secrets });
}

async function runScenario(scenario, {
  mode = 'sequential', repetitions = 3, startTarget, mapping, routes, mappingInfo, clock = () => performance.now(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS, teardownTimeoutMs = TEARDOWN_TIMEOUT_MS,
} = {}) {
  checkScenario(scenario);
  if (!scenario.modes.includes(mode)) throw new Error(`runner: scenario ${scenario.id} does not support mode ${mode}`);
  if (typeof startTarget !== 'function') throw new Error('runner: startTarget() is required');
  if (!mapping) throw new Error('runner: a mapping is required');
  if (!routes?.createOrder || !routes?.webhook) throw new Error('runner: routes.createOrder and routes.webhook are required');
  if (!(requestTimeoutMs > 0) || !(teardownTimeoutMs > 0)) throw new Error('runner: timeouts must be positive');
  const code = codeVersion();
  const records = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    records.push(await runOnce(scenario, { mode, repetition, startTarget, mapping, routes, mappingInfo, clock, code, requestTimeoutMs, teardownTimeoutMs }));
  }
  return records;
}

// Per (scenario, impl, mode), counted by `countedAs`, so a run whose cleanup failed is never counted as
// clean or reproduced. `reproduced` counts only runs whose outcome is violation of a target invariant;
// inconclusive or cleanup-failed runs that also showed a target violation are reported separately.
// A description of what was observed, not a pass/fail judgement.
function summarize(records) {
  const groups = new Map();
  for (const r of records) {
    const key = `${r.scenario}|${r.impl}|${r.mode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.values()].map((rs) => {
    const count = (fn) => rs.filter(fn).length;
    const hitTarget = (r) => r.targetsViolated.length > 0;
    const reproduced = count((r) => r.countedAs === OUTCOME.VIOLATION && hitTarget(r));
    const violationKinds = {};
    for (const r of rs) for (const v of r.verdicts) if (v.violationKinds.length) violationKinds[v.id] = [...new Set([...(violationKinds[v.id] ?? []), ...v.violationKinds])];
    return {
      scenario: rs[0].scenario,
      impl: rs[0].impl,
      mode: rs[0].mode,
      runs: rs.length,
      outcomes: Object.fromEntries(COUNTED.map((o) => [o, count((r) => r.countedAs === o)])),
      reproducedCount: reproduced,
      reproduced: `${reproduced}/${rs.length}`,
      targetViolatedButInconclusive: count((r) => r.countedAs === OUTCOME.INCONCLUSIVE && hitTarget(r)),
      targetViolatedButCleanupFailed: count((r) => r.countedAs === CLEANUP_FAILED && hitTarget(r)),
      verifiedConcurrent: count((r) => r.concurrency.status === 'verified'),
      freshnessFailures: count((r) => r.freshness && !r.freshness.passed),
      initialStateFailures: count((r) => r.initialState && !r.initialState.passed),
      preconditionFailures: count((r) => r.preconditions.failures.length > 0),
      cleanupFailures: count((r) => !r.cleanup?.ok),
      violationKinds,
      conditionalOn: rs[0].conditionalOn,
    };
  });
}

function writeResults(scenarioId, payload, { dir = path.join(REPO_ROOT, 'results') } = {}) {
  if (!/^[a-z0-9-]+$/.test(scenarioId)) throw new Error(`runner: unsafe scenario id ${scenarioId}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${scenarioId}-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(redact({ schema: RECORD_SCHEMA, scenario: scenarioId, node: process.version, ...payload }), null, 2));
  return file;
}

module.exports = {
  RECORD_SCHEMA, MODES, OUTCOME, CLEANUP_FAILED, STATE_INVARIANTS, REQUEST_TIMEOUT_MS,
  runScenario, summarize, writeResults, freezeValidation, redact, requireStock, judge, codeVersion,
};
