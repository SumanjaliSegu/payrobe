'use strict';
// Groq client (harness/ai/llm.js) against a fake fetch: no network, no real key. Covers missing credentials,
// success parsing, malformed responses, JSON-mode recovery, rate limits, timeouts, pacing and secret hygiene.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createGroqClient, createMockClient, parseDuration, parseJsonObject, summarizeTrace, callLog, withCircuitBreaker, GROQ_BASE_URL } = require('../harness/ai/llm');

const KEY = 'gsk_test_key_value_that_must_never_leak_0123456789';

function response(status, body, headers = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n) => h.get(n.toLowerCase()) ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}
const completion = (content, extra = {}) => ({ model: 'openai/gpt-oss-120b', choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, completion_tokens_details: { reasoning_tokens: 2 } }, ...extra });

// A fake fetch that serves /models then scripted chat responses, recording every request.
function fakeFetch(chatResponses, { models = ['openai/gpt-oss-120b'] } = {}) {
  const calls = [];
  const queue = [...chatResponses];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/models')) return response(200, { data: models.map((id) => ({ id, active: true })) });
    const next = queue.shift();
    if (typeof next === 'function') return next();
    if (!next) throw new Error('fake fetch: no more responses');
    return next;
  };
  fn.calls = calls;
  return fn;
}
const ask = (llm) => llm.chatJson({ purpose: 'test', system: 'sys', user: 'user' });

describe('ai llm client: credentials and success', () => {
  it('missing key: fails with missing_key and makes no request', async () => {
    const f = fakeFetch([]);
    const llm = createGroqClient({ apiKey: '', fetchImpl: f });
    await assert.rejects(ask(llm), (e) => e.code === 'missing_key');
    assert.equal(f.calls.length, 0);
    assert.equal(llm.trace[0].status, 'missing_key');
  });

  it('parses a JSON-mode completion, records usage, and talks only to the Groq base URL', async () => {
    const f = fakeFetch([response(200, completion('{"ok":true}'), { 'x-ratelimit-remaining-tokens': '7000', 'x-ratelimit-reset-tokens': '2s' })]);
    const llm = createGroqClient({ apiKey: KEY, fetchImpl: f, model: null });
    const r = await ask(llm);
    assert.deepEqual(r.json, { ok: true });
    assert.equal(r.model, 'openai/gpt-oss-120b');
    assert.deepEqual(r.usage, { promptTokens: 10, completionTokens: 5, reasoningTokens: 2, totalTokens: 15 });
    for (const c of f.calls) assert.ok(c.url.startsWith(GROQ_BASE_URL), c.url);
    const body = JSON.parse(f.calls.at(-1).init.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(f.calls.at(-1).init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(llm.trace[0].status, 'ok');
    assert.ok(!JSON.stringify(llm.trace).includes(KEY), 'the key never appears in the trace');
    assert.equal(summarizeTrace(llm.trace).totalTokens, 15);
  });

  it('picks the first preferred model that the live list offers', async () => {
    const f = fakeFetch([response(200, completion('{}'))], { models: ['openai/gpt-oss-20b', 'whisper-large-v3'] });
    const llm = createGroqClient({ apiKey: KEY, fetchImpl: f });
    assert.equal(await llm.resolveModel(), 'openai/gpt-oss-20b');
    const none = createGroqClient({ apiKey: KEY, fetchImpl: fakeFetch([], { models: ['whisper-large-v3'] }) });
    await assert.rejects(none.resolveModel(), (e) => e.code === 'no_model');
  });
});

describe('ai llm client: malformed responses', () => {
  it('content that is not a JSON object → invalid_json', async () => {
    const llm = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: fakeFetch([response(200, completion('sure! here you go'))]) });
    await assert.rejects(ask(llm), (e) => e.code === 'invalid_json');
  });
  it('a body that is not JSON → malformed_response', async () => {
    const bad = { status: 200, ok: true, headers: { get: () => null }, json: async () => { throw new SyntaxError('x'); } };
    const llm = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: fakeFetch([bad]) });
    await assert.rejects(ask(llm), (e) => e.code === 'malformed_response');
  });
  it('no choices → malformed_response; truncated output → invalid_json', async () => {
    const a = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: fakeFetch([response(200, { choices: [] })]) });
    await assert.rejects(ask(a), (e) => e.code === 'malformed_response');
    const b = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: fakeFetch([response(200, { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] })]) });
    await assert.rejects(ask(b), (e) => e.code === 'invalid_json');
  });
  it('JSON mode rejection: recovers a parseable failed_generation, otherwise retries then fails', async () => {
    const rejected = (gen) => response(400, { error: { code: 'json_validate_failed', message: 'Failed to validate JSON', failed_generation: gen } });
    const ok = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: fakeFetch([rejected('{"tool":"x"}')]) });
    assert.deepEqual((await ask(ok)).json, { tool: 'x' });
    assert.equal(ok.trace[0].recovered, true);
    // Unrecoverable: one retry without JSON mode (body has no response_format), parsed by the client.
    const f = fakeFetch([rejected('nope'), response(200, completion('Here: {"tool":"y"}'))]);
    const fb = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: f, maxRetries: 2, sleep: async () => {} });
    assert.deepEqual((await ask(fb)).json, { tool: 'y' });
    assert.equal(JSON.parse(f.calls[1].init.body).response_format, undefined);
    assert.equal(fb.trace[0].jsonModeFallback, true);
    // Still rejected after the fallback → invalid_json, bounded.
    const g = fakeFetch([rejected('nope'), rejected('nope'), rejected('nope')]);
    const bad = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: g, maxRetries: 2, sleep: async () => {} });
    await assert.rejects(ask(bad), (e) => e.code === 'invalid_json');
    assert.equal(g.calls.length, 2);
  });
  it('extracts an object embedded in text', () => {
    assert.deepEqual(parseJsonObject('```json\n{"a":1}\n```'), { a: 1 });
    assert.throws(() => parseJsonObject('[1,2]'), (e) => e.code === 'invalid_json');
  });
});

describe('ai llm client: rate limits, timeouts, pacing, secrets', () => {
  it('429 waits retry-after then succeeds; persistent 429 → rate_limited after the retry budget', async () => {
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const llm = createGroqClient({ apiKey: KEY, model: 'm', sleep, fetchImpl: fakeFetch([response(429, {}, { 'retry-after': '3' }), response(200, completion('{"ok":1}'))]) });
    assert.deepEqual((await ask(llm)).json, { ok: 1 });
    assert.equal(llm.trace[0].retries, 1);
    assert.ok(waits.includes(3250), `waited ${waits}`);
    const f = fakeFetch([0, 1, 2, 3].map(() => response(429, {}, { 'retry-after': '1' })));
    const limited = createGroqClient({ apiKey: KEY, model: 'm', sleep, maxRetries: 3, fetchImpl: f });
    await assert.rejects(ask(limited), (e) => e.code === 'rate_limited' && /HTTP 429 after 4 attempt\(s\) \(retry-after: 1,/.test(e.message));
    assert.equal(f.calls.length, 4);
    assert.deepEqual(summarizeTrace(limited.trace).failuresByCode, { rate_limited: 1 });
    assert.deepEqual(summarizeTrace(llm.trace).failuresByCode, {});
  });
  it('timeout → timeout error', async () => {
    const llm = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
    await assert.rejects(ask(llm), (e) => e.code === 'timeout');
  });
  it('paces the next call when the token budget is spent', async () => {
    const waits = [];
    let now = 0;
    const llm = createGroqClient({
      apiKey: KEY, model: 'm', clock: () => now, sleep: async (ms) => { waits.push(ms); now += ms; },
      fetchImpl: fakeFetch([response(200, completion('{}'), { 'x-ratelimit-remaining-tokens': '10', 'x-ratelimit-reset-tokens': '5s' }), response(200, completion('{}'))]),
    });
    await ask(llm);
    await ask(llm);
    assert.deepEqual(waits, [5000]);
    assert.equal(llm.trace[1].pacedMs, 5000);
  });
  it('scrubs the key from error messages', async () => {
    const llm = createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: async () => { throw new Error(`boom ${KEY}`); } });
    await assert.rejects(ask(llm), (e) => e.code === 'network' && !e.message.includes(KEY) && e.message.includes('<redacted>'));
    assert.ok(!JSON.stringify(llm.trace).includes(KEY));
  });
  it('records each 429/5xx attempt with rate-limit headers in httpEvents; callLog omits prompt previews', async () => {
    const limited = (status) => response(status, { error: { message: `Rate limit reached for key ${KEY}` } }, { 'retry-after': '2', 'x-ratelimit-remaining-tokens': '0', 'x-ratelimit-reset-tokens': '7.5s', 'x-request-id': 'req_1', 'set-cookie': 'secret' });
    const llm = createGroqClient({ apiKey: KEY, model: 'm', sleep: async () => {}, maxRetries: 2, fetchImpl: fakeFetch([limited(429), limited(503), response(200, completion('{"ok":1}'))]) });
    await ask(llm);
    const ev = llm.trace[0].httpEvents;
    assert.deepEqual(ev.map((e) => [e.attempt, e.status, e.retryAfter, e.resetTokens, e.remainingTokens, e.requestId]), [[1, 429, '2', '7.5s', '0', 'req_1'], [2, 503, '2', '7.5s', '0', 'req_1']]);
    assert.match(ev[0].message, /Rate limit reached for key <redacted>/);
    const log = callLog(llm.trace);
    assert.equal(log[0].status, 'ok');
    assert.equal(log[0].httpStatus, 200);
    assert.equal(log[0].retries, 2);
    const s = JSON.stringify(log);
    assert.ok(!s.includes(KEY) && !s.includes('secret') && !s.includes('preview'), s);
  });
  it('circuit breaker: opens after N consecutive failures, then fails fast without a request', async () => {
    const f = fakeFetch([response(200, completion('{}')), ...[0, 1, 2].map(() => response(200, completion('not json')))]);
    const llm = withCircuitBreaker(createGroqClient({ apiKey: KEY, model: 'm', fetchImpl: f }), { maxConsecutiveFailures: 2 });
    await ask(llm);
    await assert.rejects(ask(llm), (e) => e.code === 'invalid_json');
    assert.equal(llm.breaker.open, false, 'one failure after a success does not open it');
    await assert.rejects(ask(llm), (e) => e.code === 'invalid_json');
    assert.equal(llm.breaker.open, true);
    const requests = f.calls.length;
    await assert.rejects(ask(llm), (e) => e.code === 'circuit_open' && /2 consecutive/.test(e.message));
    assert.equal(f.calls.length, requests, 'no request once open');
    assert.equal(llm.trace.length, 3, 'skipped calls are not model calls');
    assert.deepEqual(llm.breaker.lastFailureCodes, ['invalid_json', 'invalid_json']);
  });
  it('parses Groq durations', () => {
    assert.equal(parseDuration('1m26.4s'), 86_400);
    assert.equal(parseDuration('3.179s'), 3179);
    assert.equal(parseDuration('250ms'), 250);
    assert.equal(parseDuration('7'), 7000);
    assert.equal(parseDuration(null), null);
  });
});

describe('ai mock client', () => {
  it('has the same interface and records a mock trace', async () => {
    const llm = createMockClient({ responder: ({ callIndex }) => ({ n: callIndex }) });
    assert.deepEqual((await ask(llm)).json, { n: 0 });
    assert.equal(llm.trace[0].provider, 'mock');
    const failing = createMockClient({ responder: () => 'not json' });
    await assert.rejects(ask(failing), (e) => e.code === 'invalid_json');
  });
});
