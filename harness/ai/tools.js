'use strict';
// The ONLY actions the AI agent can take. Each tool has a strict argument schema, an allowlist and a budget;
// none of them runs shell commands, evaluates code, touches the network, or writes files. Scenario runs go
// through the existing deterministic runner against fresh isolated apps (test/helpers.js), with the frozen,
// validated mapping, so every observation the agent sees is real execution evidence.
const { performance } = require('node:perf_hooks');
const { runScenario, summarize } = require('../runner');
const { validate } = require('./schema');
const { quote, numbered } = require('./evidence');

// Same classification rule the investigator uses (harness/investigator.js), so the agent cannot "see" a
// different verdict than the deterministic pipeline would produce.
function classify(records, mode) {
  const s = summarize(records)[0];
  const concurrent = mode !== 'sequential';
  const allVerified = !concurrent || s.verifiedConcurrent === records.length;
  const outcome = s.reproducedCount === records.length && records.length > 0 && allVerified ? 'violation'
    : s.outcomes.clean === records.length && allVerified ? 'clean' : 'inconclusive';
  return { outcome, summary: s };
}

// Compact, model-facing view of a scenario run (kept small for the free-tier token budget).
function observeRun(scenario, mode, records) {
  const { outcome, summary } = classify(records, mode);
  const first = records[0];
  return {
    scenario: scenario.id,
    mode,
    repetitions: records.length,
    outcome,
    reproduced: summary.reproduced,
    outcomes: summary.outcomes,
    violationKinds: summary.violationKinds,
    eventSequence: first?.steps?.map((s) => s.label) ?? [],
    verdicts: (first?.verdicts ?? []).map((v) => ({ id: v.id, status: v.status, kinds: v.violationKinds })),
    reasons: [...new Set(records.flatMap((r) => r.reasons ?? []))].slice(0, 4),
    concurrencyVerified: mode === 'sequential' ? null : summary.verifiedConcurrent,
  };
}

function createToolbox({ scenarios, frozen, startTarget, sources, limits = {} }) {
  const maxScenarioRuns = limits.maxScenarioRuns ?? 3;
  const maxRepetitions = limits.maxRepetitions ?? 3;
  const maxReadLines = limits.maxReadLines ?? 80;
  const allowed = new Map(scenarios.map((s) => [s.id, s]));
  const used = { scenarioRuns: 0, reads: 0 };
  const files = [...sources.keys()];

  const tools = {
    run_scenario: {
      description: `Run one approved attack scenario against a fresh isolated copy of the app and get the deterministic result. Budget: ${maxScenarioRuns} runs total.`,
      args: {
        type: 'object', required: ['scenario', 'repetitions'],
        properties: {
          scenario: { type: 'string', enum: [...allowed.keys()] },
          repetitions: { type: 'integer', minimum: 1, maximum: maxRepetitions },
        },
      },
      async run(args) {
        if (used.scenarioRuns >= maxScenarioRuns) return { error: `budget exhausted: ${maxScenarioRuns} scenario runs already used` };
        used.scenarioRuns++;
        const scenario = allowed.get(args.scenario);
        const mode = scenario.modes[0];
        const records = await runScenario(scenario, { ...frozen, mode, repetitions: args.repetitions, startTarget });
        return { result: observeRun(scenario, mode, records) };
      },
    },
    read_source: {
      description: `Read numbered lines of an approved source file (${files.join(', ')}), at most ${maxReadLines} lines per call.`,
      args: {
        type: 'object', required: ['file', 'start_line', 'end_line'],
        properties: {
          file: { type: 'string', enum: files },
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
      },
      async run(args) {
        // A range running past the end of the file is clamped (and reported), not refused.
        const total = sources.get(args.file)?.length ?? 0;
        const clamped = args.end_line > total && args.start_line <= total;
        const q = quote(sources, clamped ? { ...args, end_line: total } : args, { maxLines: maxReadLines });
        if (!q.ok) return { error: q.error };
        used.reads++;
        return { result: { file: q.file, lines: `${q.startLine}-${q.endLine}`, note: clamped ? `clamped to end of file (${total} lines)` : undefined, text: numbered(sources.get(q.file), q.startLine, q.endLine) } };
      },
    },
  };

  // Validates and executes one action. Never throws for bad model input: returns an error observation.
  async function execute(name, args) {
    const t0 = performance.now();
    const tool = tools[name];
    if (!tool) return { ok: false, error: `unknown tool "${name}" (allowed: ${Object.keys(tools).join(', ')})`, durationMs: 0 };
    const v = validate(args, tool.args);
    if (!v.ok) return { ok: false, error: `invalid arguments: ${v.errors.join('; ')}`, durationMs: 0 };
    try {
      const out = await tool.run(args);
      return { ok: !out.error, ...out, durationMs: Math.round(performance.now() - t0) };
    } catch (err) {
      return { ok: false, error: `tool failed: ${err?.message ?? err}`, durationMs: Math.round(performance.now() - t0) };
    }
  }

  return { tools, execute, used, limits: { maxScenarioRuns, maxRepetitions, maxReadLines } };
}

module.exports = { createToolbox, classify, observeRun };
