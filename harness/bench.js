'use strict';
// Reproducible benchmark over the fixture apps. Scores the deterministic hand-written scenarios and, when an
// LLM client is supplied, the AI-proposed attacks as a SEPARATE category. Ground truth is only each app's ROLE
// (control = correct by construction; has-bugs = contains seeded defects) — this answer key lives here, is
// never put in a prompt and is never reachable by the agent or attack designer (they receive only source,
// prior findings and the SKU allowlist). The seeded-bug answer key (docs/SEEDED_BUGS.md) is never read.
const fs = require('node:fs');
const path = require('node:path');
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

// blind: the attack designer is given no deterministic findings and no known-scenario list (see attack-loop.js),
// so an AI-reproduced violation measures autonomous discovery. Rebuilds of hand-written scenarios are scored as
// rediscoveries, separately from novel sequences.
async function benchApp(impl, { scenarios, startTarget, llm, repetitions, attackCount, blind = false }) {
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
    const atk = await proposeAndRunAttacks({ llm, app, frozen, startTarget, sources, findings: blind ? [] : report.findings, skus, count: attackCount, repetitions, blind });
    const executed = atk.proposals.filter((p) => p.status === 'executed');
    result.ai = {
      ...atk.summary,
      detail: atk.proposals.map((p) => ({ slot: p.slot, attempt: p.attempt, callId: p.callId ?? null, status: p.status, title: p.title, targets: p.targets, plan: p.plan ?? null, fingerprint: p.fingerprint ?? null, novel: !!p.novel, rediscovery: !!p.rediscovery, outcome: p.outcome ?? null, reproduced: p.reproduced ?? null, discovered: !!p.discovered, duplicateOf: p.duplicateOf ?? null, violationKinds: p.violationKinds ?? null, errors: ['error', 'rejected', 'skipped'].includes(p.status) ? p.errors ?? [] : [] })),
    };
    // AI-category scoring vs role (separate from hand-written). Any AI-executed violation on a control app is a
    // false positive, whether the sequence was novel or a rediscovery.
    const violated = executed.filter((p) => p.outcome === 'violation');
    result.aiFalsePositives = role === 'control' ? violated.length : 0;
    result.aiReproducedViolations = role === 'has-bugs' ? violated.length : 0;
    result.aiNovelViolations = role === 'has-bugs' ? violated.filter((p) => p.novel).length : 0;
    result.aiRediscoveredViolations = role === 'has-bugs' ? violated.filter((p) => p.rediscovery).length : 0;
    result.aiViolatedInvariants = role === 'has-bugs' ? [...new Set(violated.flatMap((p) => Object.keys(p.violationKinds ?? {})))].sort() : [];
    result.aiNovel = atk.summary.novel;
  }
  return result;
}

// Report status: 'running' (no app finished yet), 'partial' (some apps finished; the run is still going or was
// interrupted before the next save), 'completed', 'failed' (an app threw; `error` says which) or
// 'interrupted' (set by the CLI on SIGINT). `onProgress(report)` is awaited at the start and after every app,
// so completed apps survive a later crash or kill. `benchAppImpl` is a test seam.
async function runBenchmark({ apps, scenarios, startTargetFor, llm = null, repetitions = 3, attackCount = 4, blind = false, log = () => {}, onProgress = () => {}, benchAppImpl = benchApp }) {
  const t0 = performance.now();
  const startedAt = new Date().toISOString();
  const results = [];
  const snapshot = (status, extra = {}) => buildReport({ status, startedAt, t0, apps, results, llm, repetitions, blind, ...extra });
  await onProgress(snapshot('running'));
  for (const impl of apps) {
    log(`benchmark: ${impl} (${ROLES[impl] ?? 'unknown'})…`);
    try {
      results.push(await benchAppImpl(impl, { scenarios, startTarget: () => startTargetFor(impl), llm, repetitions, attackCount, blind }));
    } catch (err) {
      const failed = snapshot('failed', { error: { app: impl, message: String(err?.message ?? err) } });
      await onProgress(failed);
      throw Object.assign(err, { report: failed });
    }
    if (results.length < apps.length) await onProgress(snapshot('partial'));
  }
  const report = snapshot('completed');
  await onProgress(report);
  return report;
}

function buildReport({ status, startedAt, t0, apps, results, llm, repetitions, blind, error = null }) {
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
      blind,
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
      rediscoveriesExecuted: aiSum(results, 'rediscoveries'),
      novelViolationsOnBuggy: measured(buggy.reduce((a, r) => a + (r.aiNovelViolations ?? 0), 0), executedOnBuggy),
      rediscoveredViolationsOnBuggy: measured(buggy.reduce((a, r) => a + (r.aiRediscoveredViolations ?? 0), 0), executedOnBuggy),
      violatedInvariantsOnBuggy: Object.fromEntries(buggy.map((r) => [r.app, r.aiViolatedInvariants ?? []])),
    } : null,
  };
  const now = new Date().toISOString();
  return {
    schema: 'payprobe.benchmark/v1',
    status,
    startedAt,
    updatedAt: now,
    completedAt: status === 'completed' ? now : null,
    appsRequested: [...apps],
    appsCompleted: results.map((r) => r.app),
    error,
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

// Persists one run's report to a single file reserved at the first write with an exclusive create, so it can
// never replace another run's evidence (a name clash gets a -1, -2 … suffix). Each later write of this run
// goes to a temp file and is renamed over the reserved file, so a crash mid-write leaves the previous save.
function createReportWriter(dir, { prefix = 'benchmark' } = {}) {
  let file = null;
  return {
    get file() { return file; },
    write(report) {
      if (!file) {
        fs.mkdirSync(dir, { recursive: true });
        file = reserveFile(dir, `${prefix}-${report.startedAt.replace(/[:.]/g, '-')}`);
      }
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(report, null, 2));
      fs.renameSync(tmp, file);
      return file;
    },
  };
}

function reserveFile(dir, base) {
  for (let i = 0; ; i++) {
    const file = path.join(dir, `${base}${i ? `-${i}` : ''}.json`);
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      return file;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

module.exports = { runBenchmark, benchApp, createReportWriter, ROLES };
