'use strict';
// CLI: AI-assisted PayProbe investigation against a LOCAL fixture app.
//
//   node --env-file-if-exists=.env bin/payprobe-ai.js --app unseen            real Groq run (needs GROQ_API_KEY)
//   node bin/payprobe-ai.js --app unseen --mock                               offline, scripted mock model (labelled)
//   node --env-file-if-exists=.env bin/payprobe-ai.js --check                 verify key + model, prints no secret
//   options: --no-agent --no-repair --repetitions N --attempts N --steps N --eval-trials N --out <dir>
//
// The only network call is to Groq (real mode). Merchant apps run locally against the mock gateway.
const path = require('node:path');
const { parseArgs } = require('node:util');
const { writeReport } = require('../harness/investigator');
const { runAiInvestigation } = require('../harness/ai/pipeline');
const { createGroqClient, createMockClient } = require('../harness/ai/llm');
const { startAttackTarget } = require('../test/helpers');

const ALL_SCENARIOS = {
  'cross-order-checkout-signature': require('../harness/scenarios/cross-order-checkout-signature'),
  'captured-amount-mismatch': require('../harness/scenarios/captured-amount-mismatch'),
  'late-failed-attempt': require('../harness/scenarios/late-failed-attempt'),
  'duplicate-capture': require('../harness/scenarios/duplicate-capture'),
  'cumulative-refund-over-capture': require('../harness/scenarios/cumulative-refund-over-capture'),
};
const DEFAULT_SOURCE = { reference: 'merchant/reference', vulnerable: 'merchant/vulnerable', unseen: 'merchant/unseen', unseen2: 'merchant/unseen2' };

// Offline stand-in. It never claims to be a model: every text says MOCK, and its "patch" is a no-op comment,
// so the deterministic verifier is expected to reject it (attempts_exhausted).
function mockResponder({ purpose, user }) {
  if (purpose.startsWith('analyze:')) {
    return {
      what_happened: 'MOCK OUTPUT: no language model was called. This placeholder shows where the AI explanation appears.',
      impact: 'MOCK OUTPUT: impact analysis is produced only in a real Groq run.',
      root_cause: 'MOCK OUTPUT: root-cause hypotheses are produced only in a real Groq run.',
      evidence: [{ file: 'app.js', start_line: 1, end_line: 1, why: 'MOCK citation of the first line' }],
      uncertainty: 'MOCK OUTPUT: not an analysis.',
      confidence: 'low',
      remediation: 'MOCK OUTPUT: run without --mock for a real remediation.',
    };
  }
  if (purpose.startsWith('attack:')) {
    // MOCK: a valid, non-duplicate genuine capture with a manipulated amount. The harness judges it: a real
    // I2 violation on a buggy app, no violation on a correct one. No model is called.
    const m = /slot-(\d+)/.exec(purpose);
    const n = Number(m ? m[1] : 1);
    const amounts = ['zero', 'half', 'plus_one', 'order'];
    const amount = amounts[(n - 1) % amounts.length];
    return {
      title: `MOCK genuine capture, amount=${amount} (slot ${n})`,
      targets: ['I2'], rationale: 'MOCK OUTPUT: no model was called. A genuine capture whose amount is manipulated relative to the order.',
      orders: [{ ref: 'o1', sku: 'TSHIRT', quantity: 1 }], payments: [{ ref: 'p1' }],
      steps: [{ action: 'create_order', order: 'o1' }, { action: 'deliver_webhook', authenticity: 'genuine', signing: 'valid', event: 'payment.captured', payment: 'p1', order: 'o1', amount }],
    };
  }
  if (purpose.startsWith('agent:')) {
    const ran = /Step \d+: .*action=run_scenario/.test(user);
    const m = /"scenario":"([a-z0-9-]+)","outcome":"violation"/.exec(user);
    if (!ran && m) return { thought: 'MOCK: re-run the first violated scenario once.', action: { tool: 'run_scenario', args: { scenario: m[1], repetitions: 1 } } };
    return { thought: 'MOCK: finish.', action: { tool: 'finish', args: { summary: 'MOCK OUTPUT: scripted agent, not a model.', hypotheses: [{ statement: 'MOCK hypothesis: placeholder only.', status: 'unresolved', evidence_refs: ran ? ['O1'] : [] }] } } };
  }
  return {
    rationale: 'MOCK OUTPUT: no-op patch (adds a comment) so the verifier demonstrates rejecting an ineffective fix.',
    edits: [{ file: 'app.js', find: "'use strict';", replace: "'use strict';\n// mock patch: no behavioural change" }],
    expected_effect: 'MOCK: none expected.',
    evidence: [{ file: 'app.js', start_line: 1, end_line: 1 }],
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      source: { type: 'string' },
      mock: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      'no-agent': { type: 'boolean', default: false },
      'no-repair': { type: 'boolean', default: false },
      'no-attacks': { type: 'boolean', default: false },
      'attack-count': { type: 'string', default: '3' },
      repetitions: { type: 'string', default: '3' },
      attempts: { type: 'string', default: '3' },
      steps: { type: 'string', default: '6' },
      'eval-trials': { type: 'string', default: '0' },
      out: { type: 'string' },
    },
  });

  if (values.check) {
    const llm = createGroqClient();
    try {
      const model = await llm.resolveModel();
      const r = await llm.chatJson({ purpose: 'check', system: 'Reply with a JSON object only.', user: 'Return {"ok": true}', maxTokens: 200 });
      console.log(`Groq OK: model ${model}, test call ${r.json.ok === true ? 'returned valid JSON' : 'returned unexpected JSON'} in ${llm.trace.at(-1).latencyMs} ms (${r.usage?.totalTokens ?? '?'} tokens).`);
    } catch (err) {
      console.error(`Groq check failed: ${err.code ?? 'error'}: ${err.message}`);
      process.exitCode = 1;
    }
    return;
  }

  const impl = values.app;
  if (!impl) throw new Error('usage: --app <unseen|unseen2|reference|vulnerable> [--mock] (or --check)');
  const sourceRoot = values.source ?? DEFAULT_SOURCE[impl];
  if (!sourceRoot) throw new Error(`no default source for --app ${impl}; pass --source <dir>`);
  const llm = values.mock ? createMockClient({ responder: mockResponder, model: 'mock (no model called)' }) : createGroqClient();
  if (!values.mock && !(process.env.GROQ_API_KEY ?? '').trim()) {
    throw new Error('GROQ_API_KEY is not set. Add it to .env (see BUILT_WITH_AI.md) and run via `npm run ai -- --app ...`, or pass --mock for an offline run.');
  }

  const report = await runAiInvestigation({
    app: { id: impl, impl, sourceRoot },
    scenarios: Object.values(ALL_SCENARIOS),
    startTarget: () => startAttackTarget(impl),
    startPatched: (appModule) => startAttackTarget(impl, { appModule }),
    llm,
    repetitions: Number(values.repetitions) || 3,
    agent: !values['no-agent'],
    repair: !values['no-repair'],
    attacks: !values['no-attacks'],
    attackCount: Number(values['attack-count']) || 3,
    agentSteps: Number(values.steps) || 6,
    repairAttempts: Number(values.attempts) || 3,
    evalTrials: Number(values['eval-trials']) || 0,
    log: (m) => console.log(`· ${m}`),
  });

  const file = writeReport(report, { dir: path.resolve(values.out ?? path.join('results', 'investigations')) });
  const ai = report.ai;
  console.log('');
  console.log(`PayProbe AI investigation: ${report.app.id} — ${ai.mode === 'real' ? `REAL ${ai.provider} run, model ${ai.model}` : 'MOCK run (no model called)'}`);
  for (const f of report.findings) console.log(`  [${f.outcome.toUpperCase()}] ${f.scenario} → ${f.targets.join(',')} reproduced ${f.reproduced}  (deterministic verdict)`);
  for (const a of ai.analyses) console.log(`  analyst ${a.scenario}: ${a.status}${a.analysis ? ` (confidence ${a.analysis.confidence}, ${a.analysis.evidence.length} cited range(s))` : ''}`);
  if (ai.agent) console.log(`  agent: ${ai.agent.steps.length} step(s), stop: ${ai.agent.stopReason}, scenario runs used ${ai.agent.budget.scenarioRunsUsed}`);
  if (ai.attacks) { const s = ai.attacks.summary; console.log(`  AI attacks: ${s.executed} executed (${s.novel} novel), ${s.discoveredViolations} reproduced a violation, ${s.clean} clean, ${s.inconclusive} inconclusive; ${s.rejected} rejected, ${s.duplicates} duplicate`); }
  if (ai.repair) console.log(`  repair: ${ai.repair.verified ? 'VERIFIED by deterministic re-run' : 'not verified'} — ${ai.repair.stopReason}; attempts ${ai.repair.attempts?.length ?? 0}; original app unchanged: ${ai.repair.original?.unchanged}`);
  if (ai.evals) console.log(`  eval: repair success ${ai.evals.successRate} (mean attempts to success ${ai.evals.meanAttemptsToSuccess ?? 'n/a'})`);
  console.log(`  model calls ${ai.totals.calls} (${ai.totals.failed} failed), tokens ${ai.totals.totalTokens}, AI status ${ai.status}${ai.error ? ` — ${ai.error}` : ''}`);
  console.log(`report written to ${path.relative(process.cwd(), file)}`);
  console.log('note: local fixtures + mock gateway only; AI output is hypothesis unless verified by the deterministic harness.');
  process.exitCode = report.status === 'error' || ai.status === 'error' ? 1 : 0;
}

main().catch((err) => { console.error(`AI investigation failed: ${err?.message ?? err}`); process.exit(1); });
