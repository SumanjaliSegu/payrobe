'use strict';
// Autonomous payment-integration investigator: a bounded, staged pipeline that, given an unfamiliar
// local merchant app, discovers its payment flow, validates the discovery against the running app,
// selects and runs adversarial scenarios in isolation, and classifies reproducible invariant violations.
//
// It reuses the existing deterministic machinery and adds the orchestration and discovery on top:
//   discovery.js   proposes an evidence-backed v2 mapping from source (no answer key, no hand mapping)
//   validator.js   confirms or rejects each mapping entry against the running app + cited source
//   runner.js      runs each scenario in a fresh isolated app/db/ledger and classifies the outcome
//   invariants.js  the independent I1-I5 checks the runner applies
//
// Honesty constraints (see docs/DECISIONS.md D18):
//   - The investigator never reads a seeded-bug answer key and is given no list of an app's planted bugs.
//     Scenario SELECTION is driven only by which mapping entries the validator confirmed, not by any
//     knowledge of what is wrong with the app.
//   - A finding is reported as a violation only when the runner reproduces a TARGET-invariant violation
//     in every repetition with clean cleanup; anything else is clean or inconclusive, with reasons.
//   - Reproducing hand-written scenarios on the known fixtures is NOT claimed as autonomous discovery;
//     genuine discovery is measured on a separately authored, unseen app (see test/evaluation).
//
// Safety: deterministic code enforces every safety constraint. An optional `llm` adapter may only add
// narration/hypotheses; it can never widen what runs, relax validation, or decide a violation. No
// network, no real gateway, no real keys: everything runs against local isolated apps and the mock
// gateway, exactly as the rest of PayProbe does.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { discoverMapping } = require('./discovery');
const { validateMapping } = require('./validator');
const { runScenario, summarize, freezeValidation, redact, OUTCOME, codeVersion } = require('./runner');
const { listEntries } = require('./mapping-v2');

const REPORT_SCHEMA = 'payprobe.investigation/v1';
const STAGES = [
  'inspect', 'map', 'select', 'plan', 'validate-safety',
  'execute', 'compare', 'classify', 'regressions', 'report',
];

const confirmedPaths = (validationReport) =>
  new Set(validationReport.entries.filter((e) => e.status === 'confirmed').map((e) => e.path));

// A null-object LLM: deterministic narration. A real adapter implements the same methods and may call a
// model; it is given only non-sensitive summaries and must return plain strings. It cannot change control.
const DETERMINISTIC_LLM = {
  async narrateFinding(f) {
    return `${f.scenario}: target ${f.targets.join(', ')} violated in ${f.reproduced} repetitions on ${f.impl}; kinds ${JSON.stringify(f.violationKinds)}.`;
  },
  async narrateSummary(report) {
    const v = report.findings.filter((f) => f.outcome === 'violation').length;
    return `Investigated ${report.app.id}: ${report.scenariosRun} scenario(s) run, ${v} reproducible violation(s), ${report.findings.filter((f) => f.outcome === 'inconclusive').length} inconclusive.`;
  },
};

function stageRecord(name) {
  return { stage: name, startedAt: new Date().toISOString(), ok: null, durationMs: null, detail: null };
}

// Generates a standalone regression test (as source text) that re-runs one scenario via the runner and
// asserts the target invariant is reproducibly violated on this app. It is an ARTIFACT, written outside
// test/ so it is not part of the suite until a human reviews and moves it (D18, and the user's rule that
// vulnerable-app detection assertions are added only after review).
function regressionTestSource(finding, app) {
  const targets = JSON.stringify(finding.targets);
  return `'use strict';
// GENERATED regression test (harness/investigator.js) — NOT part of the suite until reviewed and moved
// into test/. Reproduces a finding from an investigation of app '${app.id}'.
// Finding: scenario '${finding.scenario}', target invariant(s) ${targets}, reproduced ${finding.reproduced}.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startAttackTarget } = require(${JSON.stringify(path.resolve('test/helpers.js'))});
const { validateMapping } = require(${JSON.stringify(path.resolve('harness/validator.js'))});
const { runScenario, summarize, freezeValidation, OUTCOME } = require(${JSON.stringify(path.resolve('harness/runner.js'))});
const { discoverMapping } = require(${JSON.stringify(path.resolve('harness/discovery.js'))});
const scenario = require(${JSON.stringify(path.resolve(`harness/scenarios/${finding.scenario}.js`))});

describe('regression: ${finding.scenario} on ${app.id}', () => {
  it('reproduces the target-invariant violation ${finding.reproduced}', async () => {
    const { mapping } = discoverMapping({ root: ${JSON.stringify(app.sourceRoot)}, name: ${JSON.stringify(app.id)} });
    const v = await startAttackTarget(${JSON.stringify(app.impl)}, { role: 'validation' });
    let frozen;
    try {
      const report = await validateMapping(mapping, { target: { baseUrl: v.baseUrl, db: v.reader, webhookSecret: v.webhookSecret, ledger: v.ledger, database: v.describe() }, root: ${JSON.stringify(path.resolve(app.sourceRoot))} });
      frozen = freezeValidation(report);
    } finally { await v.teardown(); }
    const records = await runScenario(scenario, { ...frozen, repetitions: 3, startTarget: () => startAttackTarget(${JSON.stringify(app.impl)}) });
    const s = summarize(records)[0];
    assert.equal(s.reproducedCount, 3, JSON.stringify(s));
  });
});
`;
}

// options:
//   app: { id, impl, sourceRoot }      what to investigate (impl is the key startTarget understands)
//   startTarget: () => freshTarget     same contract as the runner (fresh isolated app/db/ledger each call)
//   scenarios: [scenarioModule]        the catalogue of adversarial scenarios to consider
//   repetitions, mode                  forwarded to the runner (default 3, 'sequential')
//   denyFiles                          files the validator must never read (always includes the answer key)
//   llm                                optional narration adapter; deterministic by default
//   regressionDir                      where to write generated regression artifacts (default none)
//   now                                injectable clock for tests
async function investigate({
  app, startTarget, scenarios, repetitions = 3, mode = 'sequential',
  denyFiles = [], llm = DETERMINISTIC_LLM, regressionDir = null, clock = () => performance.now(),
} = {}) {
  if (!app?.id || !app.impl || !app.sourceRoot) throw new Error('investigate: app { id, impl, sourceRoot } is required');
  if (typeof startTarget !== 'function') throw new Error('investigate: startTarget() is required');
  if (!Array.isArray(scenarios) || !scenarios.length) throw new Error('investigate: a non-empty scenarios catalogue is required');
  const deny = [...new Set(['docs/SEEDED_BUGS.md', ...denyFiles])]; // never read an answer key

  const report = {
    schema: REPORT_SCHEMA,
    app: { id: app.id, impl: app.impl, sourceRoot: app.sourceRoot },
    startedAt: new Date().toISOString(),
    code: codeVersion(),
    status: 'running',
    stages: [],
    mapping: null,
    validation: null,
    selection: [],
    scenariosRun: 0,
    findings: [],
    regressionArtifacts: [],
    limitations: [
      'Local isolated apps and the mock gateway only; no real Razorpay account, no network, no real keys.',
      'Deterministic discovery uses general heuristics; request/response field names follow a convention the validator confirms (D18). An app that departs from it leaves those entries cannot_verify, not wrong.',
      'A clean or inconclusive result is not proof an app is correct; it is the outcome of the scenarios actually run under their stated contracts.',
      'Contract assumptions behind scenarios ([U]/[A]/inference) are labelled, not proven against real deliveries (docs/GATEWAY_CONTRACT.md).',
      'Reproducing scenarios on a known fixture is not autonomous discovery; see test/evaluation for the unseen-app measure.',
    ],
    narrative: null,
    error: null,
  };
  const t0 = clock();
  const runStage = async (name, fn) => {
    const rec = stageRecord(name);
    const s = clock();
    try {
      rec.detail = await fn();
      rec.ok = true;
    } catch (err) {
      rec.ok = false;
      rec.detail = { error: String(err?.message ?? err) };
      throw Object.assign(err, { stage: name });
    } finally {
      rec.durationMs = Math.round(clock() - s);
      report.stages.push(rec);
    }
    return rec.detail;
  };

  try {
    // 1-2. Inspect source and generate an evidence-backed mapping hypothesis.
    const discovery = await runStage('inspect', async () => {
      const d = discoverMapping({ root: app.sourceRoot, name: app.id });
      return { tables: d.inspected.tables.map((t) => t.table), routes: d.inspected.routes.map((r) => `${r.method} ${r.path}`), mapping: d.mapping };
    });
    report.mapping = await runStage('map', async () => ({
      name: discovery.mapping.name,
      provenance: discovery.mapping.provenance,
      entries: listEntries(discovery.mapping).length,
    }));

    // 5 (first half). Validate the mapping against the running app, with negative + positive controls.
    const validation = await runStage('validate-safety', async () => {
      const target = await startTarget();
      try {
        const r = await validateMapping(discovery.mapping, {
          target: { baseUrl: target.baseUrl, db: target.reader, webhookSecret: target.webhookSecret, ledger: target.ledger, database: target.describe?.() },
          root: path.resolve(app.sourceRoot),
          denyFiles: deny,
        });
        return r;
      } finally {
        await target.teardown({ failed: false });
      }
    });
    report.validation = {
      verdict: validation.verdict,
      confirmed: validation.entries.filter((e) => e.status === 'confirmed').length,
      cannotVerify: validation.entries.filter((e) => e.status === 'cannot_verify').length,
      contradicted: validation.contradicted,
      requiredUnconfirmed: validation.requiredUnconfirmed,
      negativeControl: validation.negativeControl?.result ?? null,
      filesRead: validation.filesRead,
    };
    if (validation.verdict !== 'validated') {
      report.status = 'stopped';
      report.stopReason = `mapping did not validate (verdict ${validation.verdict}); cannot run scenarios safely`;
      report.narrative = await llm.narrateSummary(report).catch(() => null);
      return finish(report, clock, t0);
    }
    const frozen = freezeValidation(validation);
    const confirmed = confirmedPaths(validation);

    // 3-4. Select scenarios whose required entries are all confirmed; plan the rest as skipped.
    report.selection = await runStage('select', async () => scenarios.map((s) => {
      const requires = s.requires ?? [];
      const unmet = requires.filter((p) => !confirmed.has(p));
      return { scenario: s.id, targets: s.targets, selected: unmet.length === 0, requires, unmet, contract: s.contract ?? [] };
    }));
    await runStage('plan', async () => report.selection.filter((s) => s.selected).map((s) => ({ scenario: s.scenario, targets: s.targets })));
    const chosen = scenarios.filter((s) => report.selection.find((x) => x.scenario === s.id)?.selected);

    // 6-8. Execute each chosen scenario in isolation; the runner does the snapshot/ledger comparison and
    // classification per repetition. We aggregate into findings.
    const execDetail = [];
    for (const scenario of chosen) {
      // Run each scenario in a mode it declares: the requested global mode when supported, else its first
      // (concurrency scenarios declare ['barrier', ...] so they run under barrier, not sequentially).
      const scenarioMode = scenario.modes.includes(mode) ? mode : scenario.modes[0];
      const concurrencyScenario = scenarioMode !== 'sequential';
      const records = await runStage('execute', async () => runScenario(scenario, {
        ...frozen, mode: scenarioMode, repetitions, startTarget,
      }));
      report.scenariosRun++;
      const s = summarize(records)[0];
      execDetail.push({ scenario: scenario.id, summary: s });
      // A concurrency violation additionally requires every repetition to be verified-concurrent, so a
      // finding can never claim overlap it did not prove.
      const allVerifiedConcurrent = !concurrencyScenario || s.verifiedConcurrent === records.length;
      const outcome = s.reproducedCount === records.length && records.length > 0 && allVerifiedConcurrent ? 'violation'
        : s.outcomes.clean === records.length && allVerifiedConcurrent ? 'clean'
          : 'inconclusive';
      const finding = {
        scenario: scenario.id,
        impl: app.impl,
        targets: scenario.targets,
        mode: scenarioMode,
        concurrency: concurrencyScenario ? (allVerifiedConcurrent ? 'verified' : 'not_verified') : 'not_applicable',
        outcome,
        reproduced: s.reproduced,
        reproducedCount: s.reproducedCount,
        violationKinds: s.violationKinds,
        counted: s.outcomes,
        verifiedConcurrent: s.verifiedConcurrent,
        contract: scenario.contract ?? [],
        conditionalOn: records[0]?.conditionalOn ?? [],
        evidence: evidenceFor(records, outcome),
        reproInstructions: reproInstructions(scenario, app),
        records,
      };
      report.findings.push(finding);
    }
    await runStage('compare', async () => execDetail.map((e) => ({ scenario: e.scenario, outcomes: e.summary.outcomes, reproduced: e.summary.reproduced })));
    await runStage('classify', async () => report.findings.map((f) => ({ scenario: f.scenario, outcome: f.outcome, reproduced: f.reproduced })));

    // 9. Regression artifacts for reproducible violations (written outside test/, not added to the suite).
    await runStage('regressions', async () => {
      const out = [];
      for (const f of report.findings.filter((x) => x.outcome === 'violation')) {
        const source = regressionTestSource(f, app);
        let written = null;
        if (regressionDir) {
          fs.mkdirSync(regressionDir, { recursive: true });
          written = path.join(regressionDir, `${f.scenario}.${app.id}.regression.test.js`);
          fs.writeFileSync(written, source);
        }
        out.push({ scenario: f.scenario, path: written ? path.relative(process.cwd(), written).split(path.sep).join('/') : null, bytes: source.length });
      }
      report.regressionArtifacts = out;
      return out;
    });

    // 10. Narrative (deterministic unless an llm adapter was supplied).
    for (const f of report.findings) f.narrative = await llm.narrateFinding(f).catch(() => null);
    report.narrative = await llm.narrateSummary(report).catch(() => null);
    report.status = 'completed';
    await runStage('report', async () => ({ status: report.status, findings: report.findings.length }));
  } catch (err) {
    report.status = report.status === 'running' ? 'error' : report.status;
    report.error = { stage: err?.stage ?? null, message: String(err?.message ?? err) };
  }
  return finish(report, clock, t0);
}

function evidenceFor(records, outcome) {
  const r = records[0];
  if (!r) return null;
  const violatedVerdicts = r.verdicts?.filter((v) => v.status === 'violation') ?? [];
  return {
    outcomeBasis: outcome === 'violation' ? 'target invariant violated in every repetition with clean cleanup'
      : outcome === 'clean' ? 'no invariant violation in any repetition'
        : 'not reproducible or preconditions/validation not met',
    ledgerIndependent: true,
    firstRun: {
      steps: r.steps?.map((s) => s.label) ?? [],
      violations: violatedVerdicts.map((v) => ({ id: v.id, kinds: v.violationKinds })),
      preconditions: r.preconditions,
      concurrency: r.concurrency?.status,
    },
  };
}

function reproInstructions(scenario, app) {
  return [
    `Start an isolated instance of '${app.impl}' with a fresh database and gateway ledger (test/helpers.js startAttackTarget).`,
    `Discover and validate the mapping: harness/discovery.js discoverMapping({ root: '${app.sourceRoot}' }) then harness/validator.js validateMapping(...).`,
    `Freeze the validated mapping and run scenario '${scenario.id}' 3x via harness/runner.js runScenario(...).`,
    'A finding requires the target invariant to be violated in all 3 repetitions with successful cleanup.',
  ];
}

function finish(report, clock, t0) {
  report.durationMs = Math.round(clock() - t0);
  return redact(report);
}

// Human-readable report for export (reproduction instructions and limitations included). Pure function.
function renderMarkdown(report) {
  const L = [];
  L.push(`# PayProbe investigation — ${report.app.id}`, '');
  L.push(`- Source: \`${report.app.sourceRoot}\` (impl \`${report.app.impl}\`)`);
  L.push(`- Status: **${report.status}**${report.stopReason ? ` — ${report.stopReason}` : ''}`);
  if (report.code?.commit) L.push(`- Code: ${report.code.commit}${report.code.dirty ? ' (working tree dirty)' : ''}`);
  if (report.validation) {
    L.push(`- Mapping: **${report.validation.verdict}** (confirmed ${report.validation.confirmed}, cannot_verify ${report.validation.cannotVerify}, contradicted ${report.validation.contradicted.length}); negative control ${report.validation.negativeControl}`);
    L.push(`- Source files read during validation: ${report.validation.filesRead.map((f) => `\`${f}\``).join(', ')}`);
  }
  L.push('', '## Findings', '');
  if (!report.findings.length) L.push('_No scenarios were executed._');
  for (const f of report.findings) {
    L.push(`### ${f.outcome.toUpperCase()} — ${f.scenario} (target ${f.targets.join(', ')})`);
    L.push(`- Reproduced: ${f.reproduced}`);
    if (Object.keys(f.violationKinds).length) L.push(`- Violation kinds: ${JSON.stringify(f.violationKinds)}`);
    if (f.conditionalOn?.length) L.push(`- Conditional on: ${f.conditionalOn.map((c) => `\n  - ${c}`).join('')}`);
    if (f.narrative) L.push(`- ${f.narrative}`);
    if (f.outcome === 'violation') {
      L.push('- Reproduction:');
      for (const step of f.reproInstructions) L.push(`  1. ${step}`);
    }
    L.push('');
  }
  L.push('## Scenario selection', '');
  for (const s of report.selection) L.push(`- ${s.selected ? 'run' : 'skipped'}: \`${s.scenario}\`${s.unmet?.length ? ` (unmet: ${s.unmet.join(', ')})` : ''}`);
  L.push('', '## Limitations', '');
  for (const lim of report.limitations) L.push(`- ${lim}`);
  L.push('');
  return L.join('\n');
}

// Writes a report (already redacted by investigate()) to <dir>/<appId>-<stamp>.json. Re-redacts defensively.
function writeReport(report, { dir = path.join(path.resolve(__dirname, '..'), 'results', 'investigations'), format = 'json' } = {}) {
  if (!/^[a-z0-9._-]+$/i.test(report.app.id)) throw new Error(`investigator: unsafe app id ${report.app.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = report.startedAt.replace(/[:.]/g, '-');
  const safe = redact(report);
  const ext = format === 'md' ? 'md' : 'json';
  const file = path.join(dir, `${report.app.id}-${stamp}.${ext}`);
  fs.writeFileSync(file, format === 'md' ? renderMarkdown(safe) : JSON.stringify(safe, null, 2));
  return file;
}

module.exports = { investigate, writeReport, renderMarkdown, REPORT_SCHEMA, STAGES, regressionTestSource, DETERMINISTIC_LLM };
