'use strict';
// CLI: reproducible benchmark over the fixture apps.
//   node bin/payprobe-bench.js                      deterministic hand-written scenarios only (no key needed)
//   node bin/payprobe-bench.js --mock               adds AI attacks with a scripted mock model (labelled)
//   node --env-file-if-exists=.env bin/payprobe-bench.js --ai    adds real Groq AI attacks
//   ... --ai --blind                                 discovery evaluation: the attack designer sees no findings
//                                                    and no known-scenario list; rebuilds of hand-written
//                                                    scenarios are scored as rediscoveries, not novel
// Scores reproduced violations on buggy apps and false positives on control apps; AI attacks are a separate
// category. Honest counts only — no target success rate is assumed and no trial is hidden.
const path = require('node:path');
const { parseArgs } = require('node:util');
const { runBenchmark, createReportWriter, ROLES } = require('../harness/bench');
const { createGroqClient, createMockClient, withCircuitBreaker } = require('../harness/ai/llm');
const { startAttackTarget } = require('../test/helpers');

const ALL_SCENARIOS = ['cross-order-checkout-signature', 'captured-amount-mismatch', 'late-failed-attempt', 'duplicate-capture', 'cumulative-refund-over-capture']
  .map((s) => require(`../harness/scenarios/${s}`));
const DEFAULT_APPS = ['reference', 'unseen2', 'unseen', 'vulnerable'];

// Mock attack designer: one valid, novel sequence (zero-amount genuine capture) that the harness judges on its
// own — a real violation on buggy apps, no violation on controls. Clearly labelled, no model is called.
function mockResponder({ callIndex }) {
  const amounts = ['zero', 'half', 'plus_one', 'order'];
  return {
    title: `MOCK sequence ${callIndex + 1} (genuine capture, amount=${amounts[callIndex % amounts.length]})`,
    targets: ['I2'], rationale: 'MOCK OUTPUT: no model called; a genuine capture whose amount is manipulated.',
    orders: [{ ref: 'o1', sku: 'TSHIRT', quantity: 1 }], payments: [{ ref: 'p1' }],
    steps: [{ action: 'create_order', order: 'o1' }, { action: 'deliver_webhook', authenticity: 'genuine', signing: 'valid', event: 'payment.captured', payment: 'p1', order: 'o1', amount: amounts[callIndex % amounts.length] }],
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    apps: { type: 'string' }, ai: { type: 'boolean', default: false }, mock: { type: 'boolean', default: false }, blind: { type: 'boolean', default: false },
    repetitions: { type: 'string', default: '3' }, 'attack-count': { type: 'string', default: '4' }, out: { type: 'string' },
  } });
  const apps = values.apps ? values.apps.split(',').map((s) => s.trim()) : DEFAULT_APPS;
  let llm = null;
  if (values.mock) llm = createMockClient({ responder: mockResponder, model: 'mock (no model called)' });
  else if (values.ai) {
    if (!(process.env.GROQ_API_KEY ?? '').trim()) throw new Error('--ai needs GROQ_API_KEY in .env; or use --mock');
    // Stop calling the model after repeated failures (429/5xx/invalid JSON) so the report is still written.
    llm = withCircuitBreaker(createGroqClient(), { maxConsecutiveFailures: 4 });
  }

  const unknown = apps.filter((a) => !ROLES[a]);
  if (unknown.length) throw new Error(`unknown app(s): ${unknown.join(', ')} (known: ${Object.keys(ROLES).join(', ')})`);

  // The report is saved at the start and after every app, so a crash or kill keeps the completed apps.
  const writer = createReportWriter(path.resolve(values.out ?? path.join('results', 'benchmarks')));
  let last = null;
  process.once('SIGINT', () => {
    if (last) writer.write({ ...last, status: 'interrupted', updatedAt: new Date().toISOString() });
    console.error(`\ninterrupted; ${last?.appsCompleted.length ?? 0} completed app(s) kept in ${writer.file ? path.relative(process.cwd(), writer.file) : '(no report yet)'}`);
    process.exit(130);
  });
  let report;
  try {
    report = await runBenchmark({
      apps, scenarios: ALL_SCENARIOS, startTargetFor: (impl) => startAttackTarget(impl),
      llm, repetitions: Number(values.repetitions) || 3, attackCount: Number(values['attack-count']) || 4, blind: values.blind,
      log: (m) => console.log(`· ${m}`),
      onProgress: (r) => { last = r; writer.write(r); },
    });
  } catch (err) {
    if (writer.file) console.error(`report with ${last?.appsCompleted.length ?? 0} completed app(s) saved to ${path.relative(process.cwd(), writer.file)}`);
    throw err;
  }
  const file = writer.file;

  console.log(`\nPayProbe benchmark — ${report.mode}${report.model ? ` (${report.model})` : ''}, ${report.repetitions} repetitions/scenario${report.totals.ai?.blind ? ', BLIND attack designer (no findings or known scenarios shown)' : ''}`);
  console.log('app'.padEnd(12), 'role'.padEnd(10), 'hand-written'.padEnd(26), llm ? 'AI attacks' : '');
  for (const r of report.results) {
    const hw = `${r.handwritten.violations} viol / ${r.handwritten.clean} clean / ${r.handwritten.inconclusive} inconc`;
    const ai = r.ai ? `${r.ai.executed} run (${r.ai.novel} novel, ${r.ai.rediscoveries} rediscovery), ${r.ai.discoveredViolations} violation, ${r.ai.rejected} rej, ${r.ai.duplicates} dup` : '';
    console.log(r.app.padEnd(12), r.role.padEnd(10), hw.padEnd(26), ai);
  }
  const T = report.totals;
  console.log(`\nHand-written: ${T.handwritten.reproducedViolationsOnBuggy} violation(s) reproduced on buggy apps, ${T.handwritten.falsePositivesOnControls} false positive(s) on controls (${T.handwritten.controlsClean ? 'all controls clean' : 'CONTROL FAILED'}).`);
  const m = (n, d) => (n === null ? 'unmeasured' : `${n}/${d}`);
  if (T.ai) {
    console.log(`AI attacks: ${T.ai.novelExecuted} novel + ${T.ai.rediscoveriesExecuted} rediscovery sequence(s) executed of ${T.ai.proposals} proposal(s); violations on buggy apps ${m(T.ai.reproducedViolationsOnBuggy, T.ai.executedOnBuggy)} (novel ${m(T.ai.novelViolationsOnBuggy, T.ai.executedOnBuggy)}, rediscovered ${m(T.ai.rediscoveredViolationsOnBuggy, T.ai.executedOnBuggy)}), false positives on controls ${m(T.ai.falsePositivesOnControls, T.ai.executedOnControls)}; ${T.ai.rejected} rejected, ${T.ai.duplicates} duplicate, ${T.ai.errors} error, ${T.ai.skipped} skipped.`);
    console.log(`AI-violated invariants on buggy apps (decided by the harness): ${Object.entries(T.ai.violatedInvariantsOnBuggy).map(([a, ids]) => `${a} [${ids.join(', ') || 'none'}]`).join('; ')}`);
  }
  if (report.circuitBreaker?.open) console.log(`Circuit breaker OPEN: stopped calling the model after ${report.circuitBreaker.consecutiveFailures} consecutive failures (${report.circuitBreaker.lastFailureCodes.join(', ')}).`);
  if (report.llm) console.log(`Model: ${report.llm.ok}/${report.llm.calls} call(s) ok, ${report.llm.failed} failed ${JSON.stringify(report.llm.failuresByCode)}, ${report.llm.retries} retries, ${report.llm.totalTokens} tokens.`);
  console.log(`\nreport written to ${path.relative(process.cwd(), file)}`);
  console.log('note: local fixtures + mock gateway only; controls are correct by construction, not a production guarantee.');
}

main().catch((err) => { console.error(`benchmark failed: ${err?.message ?? err}`); process.exit(1); });
