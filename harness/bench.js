'use strict';
// Reproducible benchmark over the fixture apps. Scores the deterministic hand-written scenarios and, when an
// LLM client is supplied, the AI-proposed attacks as a SEPARATE category. Ground truth is only each app's ROLE
// (control = correct by construction; has-bugs = contains seeded defects) — this answer key lives here, is
// never put in a prompt and is never reachable by the agent or attack designer (they receive only source,
// prior findings and the SKU allowlist). The seeded-bug answer key (docs/SEEDED_BUGS.md) is never read.
const { performance } = require('node:perf_hooks');
const { investigate } = require('./investigator');
const { freezeFor } = require('./ai/pipeline');
const { proposeAndRunAttacks } = require('./ai/attack-loop');
const { loadSources } = require('./ai/evidence');
const { takeSnapshot } = require('./snapshot');
const { summarizeTrace, callLog } = require('./ai/llm');

// ROLE is the only ground truth. It says nothing about WHICH bug is where — just whether the app is meant to be
// correct. A control app must produce zero violations; any violation on it is a false positive.
const ROLES = { reference: 'control', unseen2: 'control', unseen: 'has-bugs', vulnerable: 'has-bugs' };
const SOURCE = { reference: 'merchant/reference', vulnerable: 'merchant/vulnerable', unseen: 'merchant/unseen', unseen2: 'merchant/unseen2' };

async function benchApp(impl, { scenarios, startTarget, llm, repetitions, attackCount }) {
  const app = { id: impl, impl, sourceRoot: SOURCE[impl] };
  const role = ROLES[impl] ?? 'unknown';
  const report = await investigate({ app, startTarget, scenarios, repetitions });
  const handwritten = report.findings.map((f) => ({ scenario: f.scenario, targets: f.targets, outcome: f.outcome, reproduced: f.reproduced }));
  const result = {
    app: impl, role, status: report.status,
    handwritten: {
      scenarios: handwritten.length,
      violations: handwritten.filter((f) => f.outcome === 'violation').length,
      clean: handwritten.filter((f) => f.outcome === 'clean').length,
      inconclusive: handwritten.filter((f) => f.outcome === 'inconclusive').length,
      detail: handwritten,
    },
    ai: null,
    // Scoring vs role.
    falsePositives: role === 'control' ? handwritten.filter((f) => f.outcome === 'violation').length : 0,
    reproducedViolations: role === 'has-bugs' ? handwritten.filter((f) => f.outcome === 'violation').length : 0,
  };
  if (llm && report.status === 'completed') {
    const { frozen, filesRead } = await freezeFor(app, startTarget);
    const sources = loadSources(app.sourceRoot, filesRead);
    const t = await startTarget();
    const skus = Object.keys(takeSnapshot(t.reader, frozen.mapping, { label: 'c' }).stock ?? {});
    await t.teardown({ failed: false });
    const atk = await proposeAndRunAttacks({ llm, app, frozen, startTarget, sources, findings: report.findings, skus, count: attackCount, repetitions });
    const executed = atk.proposals.filter((p) => p.status === 'executed');
    result.ai = {
      ...atk.summary,
      detail: atk.proposals.map((p) => ({ status: p.status, title: p.title, targets: p.targets, outcome: p.outcome ?? null, reproduced: p.reproduced ?? null, discovered: !!p.discovered, duplicateOf: p.duplicateOf ?? null, violationKinds: p.violationKinds ?? null, errors: ['error', 'rejected', 'skipped'].includes(p.status) ? p.errors ?? [] : [] })),
    };
    // AI-category scoring vs role (separate from hand-written).
    result.aiFalsePositives = role === 'control' ? executed.filter((p) => p.outcome === 'violation').length : 0;
    result.aiReproducedViolations = role === 'has-bugs' ? executed.filter((p) => p.outcome === 'violation').length : 0;
    result.aiNovel = executed.length;
  }
  return result;
}

async function runBenchmark({ apps, scenarios, startTargetFor, llm = null, repetitions = 3, attackCount = 4, log = () => {} }) {
  const t0 = performance.now();
  const results = [];
  for (const impl of apps) {
    log(`benchmark: ${impl} (${ROLES[impl] ?? 'unknown'})…`);
    results.push(await benchApp(impl, { scenarios, startTarget: () => startTargetFor(impl), llm, repetitions, attackCount }));
  }
  const controls = results.filter((r) => r.role === 'control');
  const buggy = results.filter((r) => r.role === 'has-bugs');
  const aiSum = (rs, f) => rs.reduce((a, r) => a + (r.ai?.[f] ?? 0), 0);
  // A rate with no executed attacks behind it is unmeasured (null), never 0.
  const measured = (n, denom) => (denom > 0 ? n : null);
  const executedOnControls = aiSum(controls, 'executed');
  const executedOnBuggy = aiSum(buggy, 'executed');
  const totals = {
    apps: results.length,
    handwritten: {
      falsePositivesOnControls: controls.reduce((a, r) => a + r.falsePositives, 0),
      reproducedViolationsOnBuggy: buggy.reduce((a, r) => a + r.reproducedViolations, 0),
      controlsClean: controls.every((r) => r.falsePositives === 0),
    },
    ai: llm ? {
      requestedSlots: aiSum(results, 'requested'),
      proposals: aiSum(results, 'proposed'),
      modelCalls: aiSum(results, 'modelCalls'),
      validated: aiSum(results, 'executed') + aiSum(results, 'duplicates'),
      rejected: aiSum(results, 'rejected'),
      duplicates: aiSum(results, 'duplicates'),
      errors: aiSum(results, 'errors'),
      skipped: aiSum(results, 'skipped'),
      novelExecuted: results.reduce((a, r) => a + (r.aiNovel ?? 0), 0),
      executedOnControls,
      executedOnBuggy,
      violations: aiSum(results, 'discoveredViolations'),
      clean: aiSum(results, 'clean'),
      inconclusive: aiSum(results, 'inconclusive'),
      falsePositivesOnControls: measured(controls.reduce((a, r) => a + (r.aiFalsePositives ?? 0), 0), executedOnControls),
      reproducedViolationsOnBuggy: measured(buggy.reduce((a, r) => a + (r.aiReproducedViolations ?? 0), 0), executedOnBuggy),
    } : null,
  };
  return {
    schema: 'payprobe.benchmark/v1',
    startedAt: new Date().toISOString(),
    mode: llm ? llm.mode : 'deterministic-only',
    model: llm?.model ?? null,
    repetitions,
    results,
    totals,
    llm: llm ? summarizeTrace(llm.trace) : null,
    llmCalls: llm ? callLog(llm.trace) : null,
    circuitBreaker: llm?.breaker ? { ...llm.breaker } : null,
    durationMs: Math.round(performance.now() - t0),
  };
}

module.exports = { runBenchmark, benchApp, ROLES };
