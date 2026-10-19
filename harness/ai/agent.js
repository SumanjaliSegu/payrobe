'use strict';
// Bounded investigation agent. Each step the model sees the deterministic findings, the approved tools and the
// observations so far, and returns ONE JSON action: a tool call (run_scenario / read_source) or finish. The
// toolbox validates and executes it and the real result becomes the next observation, so the model's next
// choice depends on actual evidence rather than a fixed script.
//
// Limits: maxSteps model turns, the toolbox's run/read budgets, a wall-clock budget, and a cap on consecutive
// invalid outputs. The agent's conclusions are hypotheses: a hypothesis may be marked supported/refuted only
// if it cites at least one scenario-run observation; otherwise it is downgraded to unresolved by code.
const { performance } = require('node:perf_hooks');
const { validate, describe } = require('./schema');
const { quote } = require('./evidence');
const { INVARIANTS_GLOSSARY } = require('./analyst');

const STEP_SCHEMA = {
  type: 'object', required: ['thought', 'action'],
  properties: {
    thought: { type: 'string', minLength: 5, maxLength: 1200 },
    action: {
      type: 'object', required: ['tool', 'args'],
      properties: { tool: { type: 'string', enum: ['run_scenario', 'read_source', 'finish'] }, args: { type: 'object', additionalProperties: true } },
    },
  },
};

const FINISH_ARGS = {
  type: 'object', required: ['summary', 'hypotheses'],
  properties: {
    summary: { type: 'string', minLength: 10, maxLength: 900 },
    hypotheses: {
      type: 'array', minItems: 1, maxItems: 5,
      items: {
        type: 'object', required: ['statement', 'status', 'evidence_refs'],
        properties: {
          statement: { type: 'string', minLength: 10, maxLength: 400 },
          status: { type: 'string', enum: ['supported', 'refuted', 'unresolved'] },
          evidence_refs: { type: 'array', minItems: 0, maxItems: 6, items: { type: 'string', maxLength: 40 } },
        },
      },
    },
  },
};

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function findingsBrief(findings) {
  return findings.map((f) => ({
    scenario: f.scenario,
    outcome: f.outcome,
    targets: f.targets,
    reproduced: f.reproduced,
    violationKinds: f.violationKinds,
    reasons: [...new Set((f.records ?? []).flatMap((r) => r.reasons ?? []))].slice(0, 3),
  }));
}

function agentPrompt({ appId, findings, toolbox, sources, history, stepsLeft }) {
  const toolLines = Object.entries(toolbox.tools).map(([n, t]) => `- ${n}: ${t.description} args ${describe(t.args)}`);
  toolLines.push(`- finish: conclude the investigation. args ${describe(FINISH_ARGS)}. evidence_refs are observation ids like "O2" or source ranges like "app.js:10-20".`);
  const system = [
    'You are PayProbe\'s autonomous payment-security investigator, working on a LOCAL fixture merchant app with a mock gateway.',
    'Goal: go beyond the baseline results. Decide which approved scenario to re-run or which source lines to read to confirm,',
    'characterise or rule out root causes, then finish with evidence-backed hypotheses. Each run costs budget; do not repeat a',
    'run that cannot change your conclusion. You cannot change any verdict: the deterministic harness is the authority.',
    'Evidence rule (enforced by code): a hypothesis can be "supported" or "refuted" only if it cites at least one run_scenario',
    'observation id; hypotheses backed only by source reading are recorded as "unresolved". Use runs to test what you read.',
    `Invariants: ${INVARIANTS_GLOSSARY}`,
    'Tools (the only actions available):', ...toolLines,
    `Respond with ONE JSON object: ${describe(STEP_SCHEMA)}. Keep "thought" to 1-3 sentences. Put tool arguments in action.args.`,
  ].join('\n');
  const user = [
    `App: ${appId}. Approved files: ${[...sources.entries()].map(([f, l]) => `${f} (${l.length} lines)`).join(', ')}.`,
    `Budget left: ${stepsLeft} step(s), ${toolbox.limits.maxScenarioRuns - toolbox.used.scenarioRuns} scenario run(s).`,
    'BASELINE DETERMINISTIC FINDINGS:',
    JSON.stringify(findingsBrief(findings)),
    history.length ? '\nHISTORY (your previous actions and the real observations):' : '\nNo actions yet.',
    ...history.map((h) => `Step ${h.step}: thought=${JSON.stringify(clip(h.thought, 300))} action=${h.tool} ${JSON.stringify(h.args)}\n  ${h.observationId}: ${h.observationText}`),
    stepsLeft === 1 ? '\nThis is your LAST step: you must call finish.' : '',
  ].join('\n');
  return { system, user };
}

// Deterministic post-check of the agent's conclusions.
function checkHypotheses(hypotheses, steps, sources) {
  const runIds = new Set(steps.filter((s) => s.tool === 'run_scenario' && s.ok).map((s) => s.observationId));
  const allIds = new Set(steps.map((s) => s.observationId));
  return hypotheses.map((h) => {
    const refs = [];
    const dropped = [];
    for (const r of h.evidence_refs) {
      if (allIds.has(r)) { refs.push({ ref: r, kind: runIds.has(r) ? 'execution' : 'observation' }); continue; }
      const m = /^([\w./-]+):(\d+)-(\d+)$/.exec(r);
      const q = m && quote(sources, { file: m[1], start_line: Number(m[2]), end_line: Number(m[3]) });
      if (q?.ok) refs.push({ ref: r, kind: 'source', excerpt: q.excerpt });
      else dropped.push(r);
    }
    const hasExecution = refs.some((x) => x.kind === 'execution');
    const downgraded = h.status !== 'unresolved' && !hasExecution;
    return {
      statement: h.statement,
      proposedStatus: h.status,
      status: downgraded ? 'unresolved' : h.status,
      note: downgraded ? 'downgraded: no scenario-run evidence cited' : null,
      evidence: refs,
      droppedRefs: dropped,
    };
  });
}

async function runAgent({ llm, appId, findings, toolbox, sources, maxSteps = 6, maxInvalid = 3, maxWallMs = 8 * 60_000 }) {
  const t0 = performance.now();
  const steps = [];
  const history = [];
  let invalidInARow = 0;
  let gateUsed = false;
  let stopReason = null;
  let conclusion = null;
  for (let step = 1; step <= maxSteps; step++) {
    if (performance.now() - t0 > maxWallMs) { stopReason = 'wall_clock_budget_exhausted'; break; }
    const { system, user } = agentPrompt({ appId, findings, toolbox, sources, history, stepsLeft: maxSteps - step + 1 });
    let res;
    try {
      res = await llm.chatJson({ purpose: `agent:step-${step}`, system, user, maxTokens: 1400, reasoningEffort: 'low' });
    } catch (err) {
      steps.push({ step, callId: err.callId ?? null, ok: false, observationId: `O${step}`, error: `${err.code ?? 'error'}: ${err.message}` });
      // Unparseable output counts as an invalid step; transport/limit failures end the loop.
      if (err.code === 'invalid_json' || err.code === 'malformed_response') {
        invalidInARow++;
        history.push({ step, thought: '', tool: '?', args: {}, observationId: `O${step}`, observationText: 'REJECTED: your output was not a single valid JSON object. Reply with exactly one JSON object.' });
        if (invalidInARow >= maxInvalid) { stopReason = 'invalid_output_limit'; break; }
        continue;
      }
      stopReason = 'llm_error';
      break;
    }
    const v = validate(res.json, STEP_SCHEMA);
    const tool = res.json?.action?.tool;
    const args = res.json?.action?.args;
    if (!v.ok || (tool === 'finish' && !validate(args, FINISH_ARGS).ok)) {
      const errors = v.ok ? validate(args, FINISH_ARGS).errors : v.errors;
      invalidInARow++;
      const observationId = `O${step}`;
      steps.push({ step, callId: res.callId, ok: false, thought: typeof res.json?.thought === 'string' ? res.json.thought : null, tool: tool ?? null, args: args ?? null, observationId, error: `invalid output: ${errors.slice(0, 4).join('; ')}` });
      history.push({ step, thought: String(res.json?.thought ?? ''), tool: tool ?? '?', args: args ?? {}, observationId, observationText: `REJECTED by validator: ${errors.slice(0, 4).join('; ')}` });
      if (invalidInARow >= maxInvalid) { stopReason = 'invalid_output_limit'; break; }
      continue;
    }
    invalidInARow = 0;
    const observationId = `O${step}`;
    // Policy gate (once): claims of supported/refuted with no executed test are sent back while the agent still
    // has run budget and at least one more step, so it can test them. Which test to run is the model's choice.
    const ranAny = steps.some((s) => s.tool === 'run_scenario' && s.ok);
    const claims = tool === 'finish' && args.hypotheses.some((hy) => hy.status !== 'unresolved');
    const canRun = toolbox.used.scenarioRuns < toolbox.limits.maxScenarioRuns && step < maxSteps;
    if (claims && !ranAny && canRun && !gateUsed) {
      gateUsed = true;
      const reason = 'finish rejected by evidence policy: you claim supported/refuted hypotheses but have not run any scenario. Run an approved scenario that tests your main hypothesis, then finish citing its observation id.';
      steps.push({ step, callId: res.callId, ok: false, thought: res.json.thought, tool, args: { hypotheses: args.hypotheses.length }, observationId, error: reason, policy: 'evidence_gate' });
      history.push({ step, thought: res.json.thought, tool, args: { hypotheses: args.hypotheses.length }, observationId, observationText: reason });
      continue;
    }
    if (tool === 'finish') {
      conclusion = { summary: args.summary, hypotheses: checkHypotheses(args.hypotheses, steps, sources) };
      steps.push({ step, callId: res.callId, ok: true, thought: res.json.thought, tool, args: { hypotheses: args.hypotheses.length }, observationId });
      stopReason = 'finished';
      break;
    }
    const exec = await toolbox.execute(tool, args);
    const observation = exec.ok ? exec.result : { error: exec.error };
    steps.push({ step, callId: res.callId, ok: exec.ok, thought: res.json.thought, tool, args, observationId, observation, durationMs: exec.durationMs, error: exec.ok ? null : exec.error });
    history.push({ step, thought: res.json.thought, tool, args, observationId, observationText: clip(tool === 'read_source' && exec.ok ? exec.result.text : JSON.stringify(observation), tool === 'read_source' ? 6000 : 900) });
  }
  if (!stopReason) stopReason = 'step_budget_exhausted';
  // Step budget spent without a conclusion: exactly one extra, finish-only turn so the evidence gathered so far
  // is summarised. Any other action is refused (not executed).
  if (stopReason === 'step_budget_exhausted' && !conclusion) {
    const step = maxSteps + 1;
    const { system, user } = agentPrompt({ appId, findings, toolbox, sources, history, stepsLeft: 1 });
    try {
      const res = await llm.chatJson({ purpose: 'agent:finish-only', system, user: `${user}\nThe action budget is spent: only "finish" is accepted now.`, maxTokens: 1400, reasoningEffort: 'low' });
      const ok = validate(res.json, STEP_SCHEMA).ok && res.json.action.tool === 'finish' && validate(res.json.action.args, FINISH_ARGS).ok;
      if (ok) {
        const args = res.json.action.args;
        conclusion = { summary: args.summary, hypotheses: checkHypotheses(args.hypotheses, steps, sources) };
        steps.push({ step, callId: res.callId, ok: true, thought: res.json.thought, tool: 'finish', args: { hypotheses: args.hypotheses.length }, observationId: `O${step}`, finishOnly: true });
        stopReason = 'finished_at_budget';
      } else {
        steps.push({ step, callId: res.callId, ok: false, thought: typeof res.json?.thought === 'string' ? res.json.thought : null, tool: res.json?.action?.tool ?? null, observationId: `O${step}`, finishOnly: true, error: 'finish-only turn: output was not a valid finish; nothing executed' });
      }
    } catch (err) {
      steps.push({ step, callId: err.callId ?? null, ok: false, observationId: `O${step}`, finishOnly: true, error: `${err.code ?? 'error'}: ${err.message}` });
    }
  }
  return {
    stopReason,
    steps,
    conclusion,
    budget: { maxSteps, usedSteps: steps.length, ...toolbox.limits, scenarioRunsUsed: toolbox.used.scenarioRuns, readsUsed: toolbox.used.reads },
    durationMs: Math.round(performance.now() - t0),
  };
}

module.exports = { runAgent, checkHypotheses, STEP_SCHEMA, FINISH_ARGS };
