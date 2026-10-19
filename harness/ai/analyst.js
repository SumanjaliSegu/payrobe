'use strict';
// AI analyst: for each deterministically VERIFIED finding, asks the model to explain what happened, the
// payment/business impact and the likely root cause, citing approved source lines.
//
// Separation of authority:
//   - The finding (outcome, invariant, reproduction count) comes from the deterministic runner and is copied
//     into the result unchanged; the model never sees a field it could set, and nothing it returns is read
//     back into a verdict.
//   - The model's answer is a HYPOTHESIS: it must match ANALYSIS_SCHEMA exactly, and every cited line range
//     must exist in an approved file. Excerpts are quoted from the real file by evidence.js, not taken from
//     the model. An answer that fails validation gets one corrective retry, then is reported as rejected.
const { validate, describe } = require('./schema');
const { quote, sourcesForPrompt } = require('./evidence');

const CITATION = {
  type: 'object',
  required: ['file', 'start_line', 'end_line', 'why'],
  properties: {
    file: { type: 'string', maxLength: 120 },
    start_line: { type: 'integer', minimum: 1 },
    end_line: { type: 'integer', minimum: 1 },
    why: { type: 'string', minLength: 3, maxLength: 240 },
  },
};

const ANALYSIS_SCHEMA = {
  type: 'object',
  required: ['what_happened', 'impact', 'root_cause', 'evidence', 'uncertainty', 'confidence', 'remediation'],
  properties: {
    what_happened: { type: 'string', minLength: 20, maxLength: 700 },
    impact: { type: 'string', minLength: 20, maxLength: 600 },
    root_cause: { type: 'string', minLength: 20, maxLength: 700 },
    evidence: { type: 'array', minItems: 1, maxItems: 4, items: CITATION },
    uncertainty: { type: 'string', minLength: 10, maxLength: 500 },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    remediation: { type: 'string', minLength: 20, maxLength: 700 },
  },
};

// The deterministic facts a model may see about one finding (no secrets, no paths, no record internals).
function findingFacts(f) {
  const rec = f.records?.[0];
  const violated = (rec?.verdicts ?? []).filter((v) => v.status === 'violation').map((v) => ({
    invariant: v.id,
    isTarget: f.targets.includes(v.id),
    kinds: v.violationKinds,
    details: v.violations?.slice(0, 2),
  }));
  return {
    scenario: f.scenario,
    title: rec?.title ?? null,
    outcome: f.outcome,
    targetInvariants: f.targets,
    reproduced: f.reproduced,
    mode: f.mode,
    eventSequence: f.evidence?.firstRun?.steps ?? [],
    violatedInvariants: violated,
    assumptions: f.conditionalOn ?? [],
  };
}

const INVARIANTS_GLOSSARY = 'I1 an order is paid only by a genuine capture for that order; I2 amounts/currency match; I3 fulfilment only for paid orders and at most once; I4 a paid order is never reversed by a later event; I5 refunds never exceed the captured amount.';

function analystPrompt(facts, sources, feedback) {
  const system = [
    'You are PayProbe\'s payment-security analyst. A deterministic test harness has ALREADY verified the finding below',
    'by replaying genuine, correctly-signed payment webhooks against an isolated copy of a merchant app and checking its',
    'database against an independent gateway ledger. You do not decide whether it is a bug; you explain it.',
    'Rules: cite only line ranges that exist in the numbered source files provided; never invent code, files or facts;',
    'state uncertainty honestly; the environment is a local fixture with a mock gateway, so do not claim real money was lost.',
    `Invariants: ${INVARIANTS_GLOSSARY}`,
    `Respond with ONE JSON object exactly matching: ${describe(ANALYSIS_SCHEMA)}`,
  ].join(' ');
  const user = [
    'VERIFIED FINDING (deterministic, authoritative):',
    JSON.stringify(facts, null, 1),
    '',
    'APPROVED SOURCE FILES (cite as {"file","start_line","end_line","why"}; ranges up to 40 lines):',
    sourcesForPrompt(sources),
    feedback ? `\nYOUR PREVIOUS ANSWER WAS REJECTED BY THE VALIDATOR:\n- ${feedback.join('\n- ')}\nReturn a corrected JSON object.` : '',
  ].join('\n');
  return { system, user };
}

// Validates a model answer: schema, then every citation against the approved sources.
function checkAnalysis(json, sources) {
  const s = validate(json, ANALYSIS_SCHEMA);
  if (!s.ok) return { ok: false, errors: s.errors };
  const quoted = [];
  const errors = [];
  for (const c of json.evidence) {
    const q = quote(sources, c);
    if (q.ok) quoted.push({ file: q.file, startLine: q.startLine, endLine: q.endLine, why: c.why, excerpt: q.excerpt });
    else errors.push(`evidence: ${q.error}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, evidence: quoted };
}

async function analyzeFinding({ llm, finding, sources, maxAttempts = 2 }) {
  const facts = findingFacts(finding);
  const result = {
    scenario: finding.scenario,
    // Copied from the deterministic finding; never derived from model output.
    verified: { outcome: finding.outcome, targets: finding.targets, reproduced: finding.reproduced, violationKinds: finding.violationKinds },
    kind: 'ai_hypothesis',
    status: 'pending',
    attempts: [],
    analysis: null,
  };
  let feedback = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { system, user } = analystPrompt(facts, sources, feedback);
    let res;
    try {
      res = await llm.chatJson({ purpose: `analyze:${finding.scenario}`, system, user, maxTokens: 2200, reasoningEffort: 'medium' });
    } catch (err) {
      result.attempts.push({ attempt, callId: err.callId ?? null, ok: false, errors: [`${err.code ?? 'error'}: ${err.message}`] });
      result.status = 'error';
      return result;
    }
    const check = checkAnalysis(res.json, sources);
    result.attempts.push({ attempt, callId: res.callId, ok: check.ok, errors: check.ok ? [] : check.errors });
    if (check.ok) {
      const j = res.json;
      result.analysis = {
        whatHappened: j.what_happened,
        impact: j.impact,
        rootCause: j.root_cause,
        evidence: check.evidence,
        uncertainty: j.uncertainty,
        confidence: j.confidence,
        remediation: j.remediation,
      };
      result.status = 'accepted';
      return result;
    }
    feedback = check.errors.slice(0, 8);
  }
  result.status = 'rejected';
  return result;
}

module.exports = { analyzeFinding, checkAnalysis, findingFacts, ANALYSIS_SCHEMA, INVARIANTS_GLOSSARY };
