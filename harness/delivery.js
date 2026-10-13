'use strict';
// Delivers one prepared webhook several times with byte-identical body, the same
// x-razorpay-event-id and the same signature, recording client-side timings.
const crypto = require('node:crypto');
const http = require('node:http');
const { performance } = require('node:perf_hooks');
const { hmacHex, newEventId } = require('./mock-razorpay');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Serializes and signs once. Every later send reuses these exact bytes.
function prepareDelivery(event, { secret, eventId = newEventId() }) {
  if (!secret) throw new Error('prepareDelivery: secret is required');
  const body = Buffer.from(JSON.stringify(event), 'utf8');
  return Object.freeze({ eventId, body, bodySha256: sha256(body), signature: hmacHex(secret, body) });
}

// Independent check that the signature matches the body under the given secret.
function signatureMatches(prepared, secret) {
  const expected = Buffer.from(hmacHex(secret, prepared.body));
  const actual = Buffer.from(prepared.signature);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function sendPrepared(baseUrl, prepared, index, clock) {
  const body = Buffer.from(prepared.body); // fresh copy; hashed again below to prove what was sent
  const record = {
    index,
    eventId: prepared.eventId,
    signature: prepared.signature,
    bodySha256: sha256(body),
    startMs: clock(),
  };
  const res = await fetch(`${baseUrl}/webhooks/razorpay`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-event-id': prepared.eventId,
      'x-razorpay-signature': prepared.signature,
    },
    body,
  });
  record.status = res.status;
  record.responseBody = await res.text();
  record.endMs = clock();
  return record;
}

const intervalsOverlap = (a, b) => a.start < b.end && b.start < a.end;

// Opens a real HTTP request (own connection, Content-Length set) and sends everything
// except the last `holdBytes` of the body. The server sees the request and starts its
// body parser, which then waits for the remaining bytes until release() is called.
function openHeldRequest(baseUrl, prepared, index, holdBytes, clock) {
  const url = new URL('/webhooks/razorpay', baseUrl);
  const body = Buffer.from(prepared.body);
  const record = {
    index,
    eventId: prepared.eventId,
    signature: prepared.signature,
    bodySha256: sha256(body),
    startMs: clock(),
  };
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    agent: false,
    headers: {
      'content-type': 'application/json',
      'content-length': body.length,
      'x-razorpay-event-id': prepared.eventId,
      'x-razorpay-signature': prepared.signature,
    },
  });
  const done = new Promise((resolve, reject) => {
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        record.status = res.statusCode;
        record.responseBody = Buffer.concat(chunks).toString('utf8');
        record.endMs = clock();
        resolve(record);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
  done.catch(() => {}); // surfaced through Promise.all below
  req.write(body.subarray(0, body.length - holdBytes));
  return {
    record,
    done,
    release() {
      record.releasedMs = clock();
      req.end(body.subarray(body.length - holdBytes));
    },
    abort(err) {
      req.destroy(err);
    },
  };
}

async function waitUntil(predicate, timeoutMs, clock) {
  const deadline = clock() + timeoutMs;
  while (!predicate()) {
    if (clock() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return true;
}

// Barrier delivery: both requests are held inside the server (arrived, not finished)
// before either body is completed. `observe()` must report, from server-side
// instrumentation, how many of these requests have arrived and how many have finished.
// If the barrier is not reached in time, both are released anyway so the app can finish,
// and `barrier.reached` is false: such a run must not be counted as concurrent.
async function deliverTwiceWithBarrier(baseUrl, prepared, {
  observe, clock, holdBytes = 1, barrierTimeoutMs = 2000, responseTimeoutMs = 5000,
}) {
  if (typeof observe !== 'function') throw new Error('barrier delivery: observe() is required');
  if (!(holdBytes >= 1 && holdBytes < prepared.body.length)) throw new Error('barrier delivery: invalid holdBytes');
  const held = [0, 1].map((i) => openHeldRequest(baseUrl, prepared, i, holdBytes, clock));

  const reached = await waitUntil(() => observe().arrived >= 2, barrierTimeoutMs, clock);
  const atRelease = observe();
  const releasedAtMs = clock();
  for (const h of held) h.release(); // same tick

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`barrier delivery: no response within ${responseTimeoutMs} ms`)), responseTimeoutMs);
  });
  let requests;
  try {
    requests = await Promise.race([Promise.all(held.map((h) => h.done)), timeout]);
  } catch (err) {
    for (const h of held) h.abort(err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
  return {
    requests,
    barrier: {
      holdBytes,
      reached,
      arrivedAtRelease: atRelease.arrived,
      finishedAtRelease: atRelease.finished,
      releasedAtMs,
    },
  };
}

// mode: 'sequential' (second send starts after the first response, with an optional
// `between` hook), 'simultaneous' (both sends started together), or 'barrier'
// (both held inside the server before release; needs `observe`, see above).
async function deliverTwice(baseUrl, prepared, { mode, between, observe, clock = () => performance.now(), ...barrierOptions }) {
  let requests;
  let barrier = null;
  if (mode === 'barrier') {
    ({ requests, barrier } = await deliverTwiceWithBarrier(baseUrl, prepared, { observe, clock, ...barrierOptions }));
  } else if (mode === 'sequential') {
    const first = await sendPrepared(baseUrl, prepared, 0, clock);
    if (between) await between();
    requests = [first, await sendPrepared(baseUrl, prepared, 1, clock)];
  } else if (mode === 'simultaneous') {
    requests = await Promise.all([0, 1].map((i) => sendPrepared(baseUrl, prepared, i, clock)));
  } else {
    throw new Error(`deliverTwice: unknown mode ${mode}`);
  }
  const identical = requests.every((r) =>
    r.eventId === prepared.eventId && r.signature === prepared.signature && r.bodySha256 === prepared.bodySha256);
  const [a, b] = requests;
  return {
    mode,
    requests,
    identical,
    clientOverlap: intervalsOverlap({ start: a.startMs, end: a.endMs }, { start: b.startMs, end: b.endMs }),
    barrier,
  };
}

module.exports = { prepareDelivery, signatureMatches, deliverTwice, intervalsOverlap, sha256 };
