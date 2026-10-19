'use strict';
// Drives AI attack generation: ask the model for a plan, validate it deterministically, reject duplicates of
// the hand-written scenarios or of earlier accepted proposals, compile accepted plans and execute them through
// the normal isolated runner. The independent ledger + invariant checker decide each outcome. A proposal is
// "novel" only if it passed the duplicate check, and a bug is "discovered" only if execution reproduced a
// target-invariant violation in every repetition.
const { performance } = require('node:perf_hooks');
const { runScenario } = require('../runner');
const { classify } = require('./tools');
const { validatePlan, fingerprint, resemblesKnown, compileAttack, plannerPrompt } = require('./attacks');

function sanitizePlan(plan) {
  return { title: plan.title, targets: plan.targets, orders: plan.orders, payments: plan.payments, steps: plan.steps };
}

async function proposeAndRunAttacks({ llm, app, frozen, startTarget, sources, findings = [], skus, count = 3, repetitions = 3, maxAttemptsPerSlot = 2 }) {
  const t0 = performance.now();
  const proposals = [];
  const acceptedFingerprints = new Map(); // fingerprint -> proposal index
  const knownAvoided = new Set(['a duplicate genuine payment.captured (duplicate-capture)', 'a genuine capture whose amount differs from the order (captured-amount-mismatch)', 'a late payment.failed of an earlier attempt after a later capture (late-failed-attempt)']);
  let slot = 1;
  let stopped = null; // set when the client's circuit breaker is open: remaining slots are skipped, not failed
  for (; slot <= count; slot++) {
    if (stopped) { proposals.push({ slot, attempt: 0, status: 'skipped', callId: null, title: null, targets: null, errors: [stopped], duplicateOf: null, novel: false, discovered: false }); continue; }
    let feedback = null;
    let placed = false;
    for (let attempt = 1; attempt <= maxAttemptsPerSlot && !placed && !stopped; attempt++) {
      const { system, user } = plannerPrompt({ app, skus, sources, findings, feedback, avoid: [...knownAvoided] });
      const rec = { slot, attempt, status: 'proposed', callId: null, title: null, targets: null, rationale: null, fingerprint: null, plan: null, errors: [], duplicateOf: null, novel: false, discovered: false };
      let res;
      try {
        res = await llm.chatJson({ purpose: `attack:slot-${slot}-try-${attempt}`, system, user, maxTokens: 1800, reasoningEffort: 'low' });
      } catch (err) {
        if (err.code === 'circuit_open') { stopped = err.message; rec.status = 'skipped'; rec.errors = [err.message]; proposals.push(rec); continue; }
        rec.status = 'error'; rec.callId = err.callId ?? null; rec.errors = [`${err.code ?? 'error'}: ${err.message}`];
        proposals.push(rec); feedback = rec.errors; continue;
      }
      rec.callId = res.callId;
      const plan = res.json;
      rec.title = typeof plan.title === 'string' ? plan.title : null;
      rec.targets = Array.isArray(plan.targets) ? plan.targets : null;
      rec.rationale = typeof plan.rationale === 'string' ? plan.rationale : null;
      const v = validatePlan(plan, { skus });
      if (!v.ok) { rec.status = 'rejected'; rec.errors = v.errors.slice(0, 8); proposals.push(rec); feedback = v.errors.slice(0, 6); continue; }
      rec.plan = sanitizePlan(plan);
      rec.fingerprint = fingerprint(plan);
      const known = resemblesKnown(rec.fingerprint);
      if (known) { rec.status = 'duplicate'; rec.duplicateOf = known; proposals.push(rec); feedback = [`that reproduces the existing "${known}" scenario; design something structurally different`]; continue; }
      if (acceptedFingerprints.has(rec.fingerprint)) { rec.status = 'duplicate'; rec.duplicateOf = `proposal #${acceptedFingerprints.get(rec.fingerprint) + 1}`; proposals.push(rec); feedback = ['that duplicates one of your earlier accepted proposals; try a different structure']; continue; }

      // Accepted: compile and execute through the isolated harness.
      rec.novel = true;
      const scenario = compileAttack(plan, { id: `ai-attack-${app.id}-${slot}` });
      rec.status = 'executed';
      try {
        const records = await runScenario(scenario, { ...frozen, mode: 'sequential', repetitions, startTarget });
        const { outcome, summary } = classify(records, 'sequential');
        const first = records[0];
        rec.outcome = outcome;
        rec.reproduced = summary.reproduced;
        rec.violationKinds = summary.violationKinds;
        rec.discovered = outcome === 'violation';
        rec.evidence = {
          outcomeBasis: outcome === 'violation' ? 'target invariant violated in every repetition with clean cleanup'
            : outcome === 'clean' ? 'no invariant violation in any repetition' : 'not reproducible or preconditions not met',
          ledgerIndependent: true,
          steps: first?.steps?.map((s) => s.label) ?? [],
          verdicts: (first?.verdicts ?? []).map((v) => ({ id: v.id, status: v.status, kinds: v.violationKinds })),
          reasons: [...new Set(records.flatMap((r) => r.reasons ?? []))].slice(0, 4),
          cleanupOk: records.every((r) => r.cleanup?.ok),
        };
      } catch (err) {
        rec.status = 'error'; rec.errors = [`execution failed: ${err?.message ?? err}`];
        proposals.push(rec); feedback = rec.errors; continue;
      }
      acceptedFingerprints.set(rec.fingerprint, proposals.length);
      proposals.push(rec);
      placed = true;
    }
  }
  const executed = proposals.filter((p) => p.status === 'executed');
  return {
    proposals,
    summary: {
      requested: count,
      proposed: proposals.length,
      rejected: proposals.filter((p) => p.status === 'rejected').length,
      duplicates: proposals.filter((p) => p.status === 'duplicate').length,
      errors: proposals.filter((p) => p.status === 'error').length,
      skipped: proposals.filter((p) => p.status === 'skipped').length,
      modelCalls: proposals.filter((p) => p.status !== 'skipped').length,
      executed: executed.length,
      novel: executed.length,
      discoveredViolations: executed.filter((p) => p.discovered).length,
      clean: executed.filter((p) => p.outcome === 'clean').length,
      inconclusive: executed.filter((p) => p.outcome === 'inconclusive').length,
    },
    durationMs: Math.round(performance.now() - t0),
  };
}

module.exports = { proposeAndRunAttacks, sanitizePlan };
