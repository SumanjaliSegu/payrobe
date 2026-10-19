'use strict';
// PayProbe AI pipeline: Discover → Understand → Investigate → Explain → Fix → Verify.
//
//   1. Discover + Verify (deterministic): the existing investigator discovers the payment flow, validates it
//      and runs every approved scenario; its findings are the only verdicts in the report.
//   2. Explain (AI): the analyst explains each verified violation, grounded in approved source lines.
//   3. Investigate (AI agent): a bounded tool-using loop chooses further approved runs/reads and concludes
//      with hypotheses whose status is checked by code.
//   4. Fix → Verify (AI + deterministic): the repair agent patches a disposable copy; the runner and invariant
//      checker decide whether the fix works and whether anything regressed.
//   5. Evaluate: optional repeated repair trials give a measured success rate.
// Everything the AI did is recorded in report.ai (calls, tokens, latency, actions, patches, outcomes).
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { investigate } = require('../investigator');
const { discoverMapping } = require('../discovery');
const { validateMapping } = require('../validator');
const { freezeValidation, redact } = require('../runner');
const { loadSources } = require('./evidence');
const { analyzeFinding } = require('./analyst');
const { createToolbox } = require('./tools');
const { runAgent } = require('./agent');
const { repairAndVerify } = require('./repair');
const { proposeAndRunAttacks } = require('./attack-loop');
const { summarizeTrace } = require('./llm');
const { takeSnapshot } = require('../snapshot');

const AI_SCHEMA = 'payprobe.ai/v1';
const DENY = ['docs/SEEDED_BUGS.md'];

async function freezeFor(app, startTarget) {
  const d = discoverMapping({ root: app.sourceRoot, name: app.id });
  const target = await startTarget();
  try {
    const v = await validateMapping(d.mapping, {
      target: { baseUrl: target.baseUrl, db: target.reader, webhookSecret: target.webhookSecret, ledger: target.ledger, database: target.describe?.() },
      root: path.resolve(app.sourceRoot),
      denyFiles: DENY,
    });
    return { frozen: freezeValidation(v), filesRead: v.filesRead };
  } finally {
    await target.teardown({ failed: false });
  }
}

// The catalogue SKUs the AI attacker may buy, read once from a fresh app's initial stock (empty list if the
// mapping does not expose stock). Deterministic, and the attacker is confined to exactly these.
async function catalogueSkus(frozen, startTarget) {
  const target = await startTarget();
  try {
    const snap = takeSnapshot(target.reader, frozen.mapping, { label: 'catalogue' });
    return snap.stock && typeof snap.stock === 'object' ? Object.keys(snap.stock) : [];
  } finally {
    await target.teardown({ failed: false });
  }
}

async function runAiInvestigation({
  app, scenarios, startTarget, startPatched, llm, repetitions = 3,
  agent = true, repair = true, attacks = true, attackCount = 3, agentSteps = 6, repairAttempts = 3, evalTrials = 0, log = () => {},
}) {
  const t0 = performance.now();
  log('deterministic investigation (discover, validate, attack, classify)…');
  const report = await investigate({ app, startTarget, scenarios, repetitions });
  const ai = {
    schema: AI_SCHEMA,
    mode: llm.mode, // 'real' | 'mock'
    provider: llm.provider,
    model: null,
    authority: 'Deterministic runner + invariant checker decide every verdict. AI output is labelled hypothesis unless verified by execution.',
    analyses: [],
    agent: null,
    attacks: null,
    repair: null,
    evals: null,
    calls: llm.trace,
    totals: null,
    status: 'running',
    error: null,
    durationMs: null,
  };
  report.ai = ai;
  if (report.status !== 'completed') {
    ai.status = 'skipped';
    ai.error = `deterministic investigation ${report.status}; AI stages need a completed, validated investigation`;
    return finalize(report, llm, t0);
  }
  try {
    try { ai.model = await llm.resolveModel(); } catch (err) { ai.model = null; ai.error = `model unavailable: ${err.code ?? ''} ${err.message}`.trim(); }
    const { frozen, filesRead } = await freezeFor(app, startTarget);
    const sources = loadSources(app.sourceRoot, filesRead);
    const violations = report.findings.filter((f) => f.outcome === 'violation');
    const selected = scenarios.filter((s) => report.selection.find((x) => x.scenario === s.id)?.selected);

    // Explain
    for (const f of violations) {
      log(`AI analyst: explaining ${f.scenario}…`);
      ai.analyses.push(await analyzeFinding({ llm, finding: f, sources }));
    }

    // Investigate
    if (agent) {
      log('AI agent: bounded investigation loop…');
      const toolbox = createToolbox({ scenarios: selected, frozen, startTarget, sources, limits: { maxScenarioRuns: 3, maxRepetitions: repetitions } });
      ai.agent = await runAgent({ llm, appId: app.id, findings: report.findings, toolbox, sources, maxSteps: agentSteps });
    }

    // Investigate further: AI-proposed attacks (new sequences, not copies of the hand-written scenarios).
    if (attacks) {
      log('AI attack designer: proposing and executing new sequences…');
      const skus = await catalogueSkus(frozen, startTarget);
      ai.attacks = await proposeAndRunAttacks({ llm, app, frozen, startTarget, sources, findings: report.findings, skus, count: attackCount, repetitions });
      ai.attacks.catalogueSkus = skus;
      log(`AI attacks: ${ai.attacks.summary.executed} executed, ${ai.attacks.summary.discoveredViolations} reproduced a violation, ${ai.attacks.summary.rejected} rejected, ${ai.attacks.summary.duplicates} duplicate`);
    }

    // Fix → Verify
    const baselineOutcomes = Object.fromEntries(report.findings.map((f) => [f.scenario, f.outcome]));
    const repairTarget = violations[0] ?? null;
    const doRepair = async (label) => repairAndVerify({
      llm, appId: app.id, sourceRoot: app.sourceRoot, finding: repairTarget,
      analysis: ai.analyses.find((x) => x.scenario === repairTarget.scenario)?.analysis ?? null,
      scenarios: selected, frozen, startOriginal: startTarget, startPatched, sources, baselineOutcomes,
      maxAttempts: repairAttempts, repetitions,
    }).then((r) => { log(`AI repair (${label}): ${r.stopReason}${r.verified ? ' ✓ verified' : ''}`); return r; });
    if (repair && repairTarget) {
      log(`AI repair: ${repairTarget.scenario}…`);
      ai.repair = await doRepair('main run');
    } else if (repair) {
      ai.repair = { stopReason: 'no_verified_violation', verified: false, attempts: [] };
    }

    // Evaluate: independent repeated trials of the full repair loop.
    if (evalTrials > 0 && repairTarget) {
      const trials = [];
      for (let i = 1; i <= evalTrials; i++) {
        const r = await doRepair(`eval trial ${i}/${evalTrials}`);
        trials.push({ trial: i, verified: r.verified, attemptsUsed: r.attempts.length, stopReason: r.stopReason, originalUnchanged: r.original.unchanged, durationMs: r.durationMs });
      }
      const ok = trials.filter((t) => t.verified);
      ai.evals = {
        task: `repair ${repairTarget.scenario} (${repairTarget.targets.join(', ')}) on ${app.id}`,
        trials,
        successRate: `${ok.length}/${trials.length}`,
        meanAttemptsToSuccess: ok.length ? +(ok.reduce((a, t) => a + t.attemptsUsed, 0) / ok.length).toFixed(2) : null,
        originalUnchangedInAllTrials: trials.every((t) => t.originalUnchanged === true),
      };
    }
    ai.status = 'completed';
  } catch (err) {
    ai.status = 'error';
    ai.error = String(err?.message ?? err);
  }
  return finalize(report, llm, t0);
}

function finalize(report, llm, t0) {
  report.ai.totals = summarizeTrace(llm.trace);
  report.ai.model = report.ai.model ?? llm.model ?? null;
  report.ai.durationMs = Math.round(performance.now() - t0);
  return redact(report, { secrets: llm.secrets ?? [] });
}

module.exports = { runAiInvestigation, freezeFor, AI_SCHEMA };
