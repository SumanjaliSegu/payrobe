'use strict';
// LLM clients for PayProbe's AI layer: a Groq client (OpenAI-compatible chat completions, JSON mode) and a
// scripted mock with the same interface for tests and offline runs.
//
// Guardrails enforced here:
//   - The ONLY network egress of the AI layer is GROQ_BASE_URL (fixed; not configurable from model output).
//   - The API key is read from the environment (GROQ_API_KEY, loaded from the git-ignored .env) and is never
//     logged, returned, or written into a trace; error messages are scrubbed of it.
//   - Every call is bounded: request timeout, a small retry budget for 429/5xx, and token-aware pacing that
//     follows Groq's x-ratelimit-* headers so the free tier's per-minute token limit is respected.
//   - Every call is recorded in `trace` with purpose, provider, model, latency, token usage and a SANITIZED
//     summary of input/output (lengths, sha256, short previews) so a report can show what the AI did.
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
// Preference order, checked against the live model list at runtime (verified 2026-10-16 on the free tier).
const PREFERRED_MODELS = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
const PREVIEW_CHARS = 280;

class LlmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'LlmError';
    this.code = code; // missing_key | timeout | rate_limited | http_error | network | malformed_response | invalid_json | no_model
    Object.assign(this, extra);
  }
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const preview = (s) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > PREVIEW_CHARS ? `${t.slice(0, PREVIEW_CHARS)}…` : t; };
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Parses Groq's "1m26.4s" / "3.179s" / "250ms" durations into milliseconds.
function parseDuration(v) {
  if (v === null || v === undefined || v === '') return null;
  if (/^\d+(\.\d+)?$/.test(String(v))) return Math.round(Number(v) * 1000); // retry-after: seconds
  let ms = 0;
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let m; let matched = false;
  while ((m = re.exec(String(v)))) {
    matched = true;
    const n = Number(m[1]);
    ms += m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.round(ms) : null;
}

// Extracts the first JSON object from model text (JSON mode normally returns exactly one).
function parseJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) throw new LlmError('invalid_json', 'model returned empty content');
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch { /* fall through to a fenced/embedded object */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const v = JSON.parse(text.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* invalid */ }
  }
  throw new LlmError('invalid_json', 'model content is not a JSON object');
}

function newTraceEntry(provider, purpose, system, user) {
  return {
    id: `call-${crypto.randomBytes(4).toString('hex')}`,
    purpose,
    provider,
    model: null,
    startedAt: new Date().toISOString(),
    latencyMs: null,
    status: 'pending',
    retries: 0,
    pacedMs: 0,
    usage: null,
    input: { systemChars: system.length, userChars: user.length, sha256: sha256(`${system}\n${user}`), preview: preview(user) },
    output: null,
    error: null,
    httpStatus: null,
    httpEvents: [], // one per non-2xx response: status + rate-limit headers only (never request data)
  };
}

// ---------------------------------------------------------------------------------------------- Groq

function createGroqClient({
  apiKey = process.env.GROQ_API_KEY,
  model = process.env.GROQ_MODEL || null,
  fetchImpl = globalThis.fetch,
  timeoutMs = 90_000,
  maxRetries = 3,
  maxPaceMs = 65_000,
  sleep = realSleep,
  clock = () => performance.now(),
  trace = [],
} = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const scrub = (s) => (key && String(s).includes(key) ? String(s).split(key).join('<redacted>') : String(s));
  let resolvedModel = model;
  // Rate-limit state from the most recent response headers.
  const limits = { remainingTokens: null, resetTokensAt: null, remainingRequests: null, resetRequestsAt: null };

  function requireKey() {
    if (!key) throw new LlmError('missing_key', 'GROQ_API_KEY is not set (add it to the local .env; see BUILT_WITH_AI.md)');
  }

  async function request(path, init) {
    let res;
    try {
      res = await fetchImpl(`${GROQ_BASE_URL}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new LlmError('timeout', `Groq request timed out after ${timeoutMs} ms`);
      throw new LlmError('network', scrub(`Groq request failed: ${err?.message ?? err}`));
    }
    return res;
  }

  function readLimits(res) {
    const h = (n) => res.headers?.get?.(n) ?? null;
    const now = clock();
    const rt = h('x-ratelimit-remaining-tokens');
    const rr = h('x-ratelimit-remaining-requests');
    if (rt !== null && rt !== '') { limits.remainingTokens = Number(rt); limits.resetTokensAt = now + (parseDuration(h('x-ratelimit-reset-tokens')) ?? 60_000); }
    if (rr !== null && rr !== '') { limits.remainingRequests = Number(rr); limits.resetRequestsAt = now + (parseDuration(h('x-ratelimit-reset-requests')) ?? 60_000); }
  }

  async function resolveModel() {
    if (resolvedModel) return resolvedModel;
    requireKey();
    const res = await request('/models', { method: 'GET' });
    if (!res.ok) throw new LlmError(res.status === 401 ? 'http_error' : 'http_error', `Groq model list failed: HTTP ${res.status}`, { status: res.status });
    let body;
    try { body = await res.json(); } catch { throw new LlmError('malformed_response', 'Groq model list is not JSON'); }
    const available = new Set((body?.data ?? []).filter((m) => m?.active !== false).map((m) => m.id));
    resolvedModel = PREFERRED_MODELS.find((m) => available.has(m)) ?? null;
    if (!resolvedModel) throw new LlmError('no_model', `none of the preferred models is available: ${PREFERRED_MODELS.join(', ')}`);
    return resolvedModel;
  }

  // Waits when the estimated cost of the next call exceeds the remaining per-minute token budget.
  async function pace(estimatedTokens) {
    const now = clock();
    let wait = 0;
    if (limits.remainingTokens !== null && limits.resetTokensAt !== null && estimatedTokens > limits.remainingTokens && limits.resetTokensAt > now) wait = limits.resetTokensAt - now;
    if (limits.remainingRequests !== null && limits.remainingRequests < 1 && limits.resetRequestsAt > now) wait = Math.max(wait, limits.resetRequestsAt - now);
    wait = Math.min(Math.ceil(wait), maxPaceMs);
    if (wait > 0) await sleep(wait);
    return wait;
  }

  // Diagnostics for a non-2xx response: status, a short scrubbed provider message and the rate-limit headers.
  function httpEvent(res, attempt, message) {
    const h = (n) => res.headers?.get?.(n) ?? null;
    return {
      attempt: attempt + 1,
      status: res.status,
      message: message ? preview(scrub(message)) : null,
      retryAfter: h('retry-after'),
      remainingTokens: h('x-ratelimit-remaining-tokens'),
      resetTokens: h('x-ratelimit-reset-tokens'),
      remainingRequests: h('x-ratelimit-remaining-requests'),
      resetRequests: h('x-ratelimit-reset-requests'),
      requestId: h('x-request-id'),
    };
  }

  async function chatJson({ purpose, system, user, maxTokens = 1500, reasoningEffort = 'low', temperature = 0.2 }) {
    const entry = newTraceEntry('groq', purpose, system, user);
    trace.push(entry);
    const t0 = clock();
    try {
      requireKey();
      const useModel = await resolveModel();
      entry.model = useModel;
      const estimated = Math.ceil((system.length + user.length) / 3.5) + maxTokens;
      const body = {
        model: useModel,
        temperature,
        max_completion_tokens: maxTokens,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
      if (/gpt-oss/.test(useModel)) body.reasoning_effort = reasoningEffort;
      for (let attempt = 0; ; attempt++) {
        entry.pacedMs += await pace(estimated);
        const res = await request('/chat/completions', { method: 'POST', body: JSON.stringify(body) });
        readLimits(res);
        entry.httpStatus = res.status;
        if (res.status === 429 || res.status >= 500) {
          let errBody = null;
          try { errBody = await res.json(); } catch { errBody = null; }
          entry.httpEvents.push(httpEvent(res, attempt, errBody?.error?.message));
          if (attempt >= maxRetries) {
            throw new LlmError(res.status === 429 ? 'rate_limited' : 'http_error', `Groq returned HTTP ${res.status} after ${attempt + 1} attempt(s) (retry-after: ${res.headers?.get?.('retry-after') ?? 'none'}, reset-tokens: ${res.headers?.get?.('x-ratelimit-reset-tokens') ?? 'none'})`, { status: res.status });
          }
          entry.retries++;
          const retryAfter = parseDuration(res.headers?.get?.('retry-after')) ?? parseDuration(res.headers?.get?.('x-ratelimit-reset-tokens')) ?? 2000 * (attempt + 1);
          await sleep(Math.min(retryAfter + 250, maxPaceMs));
          continue;
        }
        let payload;
        try { payload = await res.json(); } catch { throw new LlmError('malformed_response', `Groq returned non-JSON (HTTP ${res.status})`); }
        // JSON mode refused the model's output ("json_validate_failed"). Recover the object from the returned
        // failed_generation text when it parses; otherwise retry the call within the retry budget.
        if (!res.ok) entry.httpEvents.push(httpEvent(res, attempt, payload?.error?.message));
        if (res.status === 400 && /json/i.test(`${payload?.error?.code ?? ''} ${payload?.error?.message ?? ''}`)) {
          const failed = payload?.error?.failed_generation;
          let recovered = null;
          try { recovered = parseJsonObject(failed); } catch { recovered = null; }
          if (recovered) {
            entry.model = useModel;
            entry.output = { chars: String(failed).length, sha256: sha256(failed), preview: preview(failed), finishReason: 'recovered_failed_generation' };
            entry.status = 'ok';
            entry.recovered = true;
            return { json: recovered, model: useModel, usage: null, callId: entry.id };
          }
          // Retry once more WITHOUT JSON mode and parse the object ourselves; schema validation still applies upstream.
          if (attempt < maxRetries && body.response_format) { entry.retries++; entry.jsonModeFallback = true; delete body.response_format; continue; }
          throw new LlmError('invalid_json', `Groq JSON mode rejected the model output ${attempt + 1} time(s)`, { status: 400 });
        }
        if (!res.ok) throw new LlmError('http_error', scrub(`Groq returned HTTP ${res.status}: ${payload?.error?.message ?? 'error'}`), { status: res.status });
        const choice = payload?.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content !== 'string') throw new LlmError('malformed_response', 'Groq response has no message content');
        entry.model = payload.model ?? useModel;
        entry.usage = payload.usage ? {
          promptTokens: payload.usage.prompt_tokens ?? null,
          completionTokens: payload.usage.completion_tokens ?? null,
          reasoningTokens: payload.usage.completion_tokens_details?.reasoning_tokens ?? null,
          totalTokens: payload.usage.total_tokens ?? null,
        } : null;
        entry.output = { chars: content.length, sha256: sha256(content), preview: preview(content), finishReason: choice.finish_reason ?? null };
        if (choice.finish_reason === 'length') throw new LlmError('invalid_json', 'model output was truncated (max tokens reached)');
        const json = parseJsonObject(content);
        entry.status = 'ok';
        return { json, model: entry.model, usage: entry.usage, callId: entry.id };
      }
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError('network', scrub(err?.message ?? err));
      e.message = scrub(e.message);
      entry.status = e.code;
      entry.error = e.message;
      e.callId = entry.id;
      throw e;
    } finally {
      entry.latencyMs = Math.round(clock() - t0);
    }
  }

  return { provider: 'groq', mode: 'real', chatJson, resolveModel, trace, get model() { return resolvedModel; }, secrets: key ? [key] : [] };
}

// ---------------------------------------------------------------------------------------------- mock

// responder({ purpose, system, user, callIndex }) returns an object (the parsed JSON), a string (raw content,
// parsed like a real response), or throws / returns an Error (e.g. new LlmError('rate_limited', ...)).
function createMockClient({ responder, model = 'mock-model', trace = [] } = {}) {
  if (typeof responder !== 'function') throw new Error('createMockClient: responder is required');
  let callIndex = 0;
  async function chatJson({ purpose, system, user }) {
    const entry = newTraceEntry('mock', purpose, system, user);
    entry.model = model;
    trace.push(entry);
    const t0 = performance.now();
    try {
      const out = await responder({ purpose, system, user, callIndex: callIndex++ });
      if (out instanceof Error) throw out;
      const content = typeof out === 'string' ? out : JSON.stringify(out);
      entry.output = { chars: content.length, sha256: sha256(content), preview: preview(content), finishReason: 'stop' };
      const json = parseJsonObject(content);
      entry.usage = { promptTokens: null, completionTokens: null, reasoningTokens: null, totalTokens: null };
      entry.status = 'ok';
      return { json, model, usage: entry.usage, callId: entry.id };
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError('malformed_response', String(err?.message ?? err));
      entry.status = e.code;
      entry.error = e.message;
      e.callId = entry.id;
      throw e;
    } finally {
      entry.latencyMs = Math.round(performance.now() - t0);
    }
  }
  return { provider: 'mock', mode: 'mock', chatJson, resolveModel: async () => model, trace, model, secrets: [] };
}

// Sums a trace into the numbers the report shows.
function summarizeTrace(trace) {
  const sum = (f) => trace.reduce((a, e) => a + (e.usage?.[f] ?? 0), 0);
  return {
    calls: trace.length,
    ok: trace.filter((e) => e.status === 'ok').length,
    failed: trace.filter((e) => e.status !== 'ok').length,
    failuresByCode: trace.filter((e) => e.status !== 'ok').reduce((a, e) => ({ ...a, [e.status]: (a[e.status] ?? 0) + 1 }), {}),
    retries: trace.reduce((a, e) => a + e.retries, 0),
    pacedMs: trace.reduce((a, e) => a + e.pacedMs, 0),
    latencyMs: trace.reduce((a, e) => a + (e.latencyMs ?? 0), 0),
    promptTokens: sum('promptTokens'),
    completionTokens: sum('completionTokens'),
    reasoningTokens: sum('reasoningTokens'),
    totalTokens: sum('totalTokens'),
  };
}

// Per-call diagnostics for a report: status, failure code, HTTP events and usage. Leaves out the input/output
// previews so no prompt or source text is copied into the report.
function callLog(trace) {
  return trace.map((e) => ({
    id: e.id, purpose: e.purpose, provider: e.provider, model: e.model, startedAt: e.startedAt,
    status: e.status, error: e.error, httpStatus: e.httpStatus ?? null, httpEvents: e.httpEvents ?? [],
    retries: e.retries, pacedMs: e.pacedMs, latencyMs: e.latencyMs, usage: e.usage,
    finishReason: e.output?.finishReason ?? null, outputChars: e.output?.chars ?? null,
    recovered: !!e.recovered, jsonModeFallback: !!e.jsonModeFallback,
  }));
}

// Wraps a client so that after `maxConsecutiveFailures` failed calls in a row every further call fails fast
// with `circuit_open` and makes no request. Lets a run stop on repeated 429/5xx/invalid JSON and still write
// its report; callers treat circuit_open as "skipped", not as a model failure.
function withCircuitBreaker(llm, { maxConsecutiveFailures = 4 } = {}) {
  const state = { maxConsecutiveFailures, consecutiveFailures: 0, open: false, openedAt: null, openedAfterCallId: null, lastFailureCodes: [] };
  async function chatJson(args) {
    if (state.open) throw new LlmError('circuit_open', `skipped: ${state.consecutiveFailures} consecutive model-call failures (${state.lastFailureCodes.join(', ')})`);
    try {
      const r = await llm.chatJson(args);
      state.consecutiveFailures = 0; state.lastFailureCodes = [];
      return r;
    } catch (err) {
      state.consecutiveFailures++;
      state.lastFailureCodes = [...state.lastFailureCodes, err.code ?? 'error'].slice(-maxConsecutiveFailures);
      if (state.consecutiveFailures >= maxConsecutiveFailures) { state.open = true; state.openedAt = new Date().toISOString(); state.openedAfterCallId = err.callId ?? null; }
      throw err;
    }
  }
  return { ...llm, chatJson, breaker: state, get model() { return llm.model; } };
}

module.exports = { createGroqClient, createMockClient, summarizeTrace, callLog, withCircuitBreaker, parseJsonObject, parseDuration, LlmError, GROQ_BASE_URL, PREFERRED_MODELS };
