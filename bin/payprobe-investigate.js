'use strict';
// CLI: run an autonomous investigation against a LOCAL fixture app and write a redacted report.
//
//   node bin/payprobe-investigate.js --app <impl> --source <dir> [--out <dir>] [--repetitions N]
//                                     [--scenarios a,b,c] [--regressions <dir>] [--json]
//
// --app is the implementation key test/helpers.js knows how to start in isolation (reference | vulnerable |
// unseen). This tool starts only local apps against the mock gateway; it makes no network calls and uses no
// real keys. It lives in bin/ (not harness/) because it starts the fixture apps in-process via test/helpers.
const path = require('node:path');
const { parseArgs } = require('node:util');
const { investigate, writeReport } = require('../harness/investigator');
const { startAttackTarget } = require('../test/helpers');

const ALL_SCENARIOS = {
  'cross-order-checkout-signature': require('../harness/scenarios/cross-order-checkout-signature'),
  'captured-amount-mismatch': require('../harness/scenarios/captured-amount-mismatch'),
  'late-failed-attempt': require('../harness/scenarios/late-failed-attempt'),
  'duplicate-capture': require('../harness/scenarios/duplicate-capture'),
  'cumulative-refund-over-capture': require('../harness/scenarios/cumulative-refund-over-capture'),
};

const DEFAULT_SOURCE = { reference: 'merchant/reference', vulnerable: 'merchant/vulnerable', unseen: 'merchant/unseen', unseen2: 'merchant/unseen2' };

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      source: { type: 'string' },
      out: { type: 'string' },
      repetitions: { type: 'string', default: '3' },
      scenarios: { type: 'string' },
      regressions: { type: 'string' },
      json: { type: 'boolean', default: false },
      format: { type: 'string', default: 'json' },
    },
  });
  const impl = values.app;
  if (!impl) throw new Error('usage: --app <reference|vulnerable|unseen> [--source <dir>]');
  const sourceRoot = values.source ?? DEFAULT_SOURCE[impl];
  if (!sourceRoot) throw new Error(`no default source for --app ${impl}; pass --source <dir>`);
  const chosen = values.scenarios ? values.scenarios.split(',').map((s) => s.trim()) : Object.keys(ALL_SCENARIOS);
  const scenarios = chosen.map((id) => {
    if (!ALL_SCENARIOS[id]) throw new Error(`unknown scenario ${id}; known: ${Object.keys(ALL_SCENARIOS).join(', ')}`);
    return ALL_SCENARIOS[id];
  });

  const report = await investigate({
    app: { id: impl, impl, sourceRoot },
    startTarget: () => startAttackTarget(impl),
    scenarios,
    repetitions: Number(values.repetitions) || 3,
    regressionDir: values.regressions ? path.resolve(values.regressions) : null,
  });

  const out = values.out ?? path.join('results', 'investigations');
  const file = writeReport(report, { dir: path.resolve(out), format: values.format === 'md' ? 'md' : 'json' });

  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(`PayProbe investigation: ${report.app.id} (${report.app.sourceRoot})`);
    console.log(`status: ${report.status}${report.stopReason ? ` — ${report.stopReason}` : ''}`);
    if (report.validation) console.log(`mapping: ${report.validation.verdict} (confirmed ${report.validation.confirmed}, contradicted ${report.validation.contradicted.length}); read ${JSON.stringify(report.validation.filesRead)}`);
    for (const f of report.findings) {
      console.log(`  [${f.outcome.toUpperCase()}] ${f.scenario} → target ${f.targets.join(',')} reproduced ${f.reproduced}${f.conditionalOn.length ? ` (conditional on ${f.conditionalOn.length} assumption(s))` : ''}`);
    }
    console.log(report.narrative ?? '');
    console.log(`report written to ${path.relative(process.cwd(), file)}`);
    console.log('note: local fixtures + mock gateway only; a clean/inconclusive result is not proof of correctness. See report.limitations.');
  }
  // Exit non-zero only on an internal error, not on findings (findings are a normal result).
  process.exitCode = report.status === 'error' ? 1 : 0;
}

main().catch((err) => { console.error(`investigation failed: ${err?.message ?? err}`); process.exit(1); });
