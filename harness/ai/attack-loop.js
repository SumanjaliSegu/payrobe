'use strict';
// Drives AI attack generation: ask the model for a plan, validate it deterministically, reject duplicates of
// the hand-written scenarios or of earlier accepted proposals, compile accepted plans and execute them through
// the normal isolated runner. The independent ledger + invariant checker decide each outcome. A proposal is
// "novel" only if it passed the duplicate check, and a bug is "discovered" only if execution reproduced a
// target-invariant violation in every repetition.
//
// blind: the evaluation mode. The model sees no deterministic findings and no list of known scenarios, only
// the source, the SKU allowlist and the general vocabulary. A proposal that rebuilds a hand-written scenario
// is then still executed (the model could not have copied it) but recorded as a "rediscovery", never as
// novel; duplicates of the model's own earlier proposals are still not executed.
const { performance } = require('node:perf_hooks');
const { runScenario } = require('../runner');
const { classify } = require('./tools');
const { validatePlan, fingerprint, resemblesKnown, compileAttack, plannerPrompt } = require('./attacks');
const { redactSources } = require('./evidence');

const BLIND_APP_LABEL = 'target';

function sanitizePlan(plan) {
  return { title: plan.title, targets: plan.targets, orders: plan.orders, payments: plan.payments, steps: plan.steps };
}

async function proposeAndRunAttacks({ llm, app, frozen, startTarget, sources, findings = [], skus, count = 3, repetitions = 3, maxAttemptsPerSlot = 2, blind = false }) {
  const t0 = performance.now();
  const proposals = [];
  const acceptedFingerprints = new Map(); // fingerprint -> proposal index
  const knownAvoided = blind ? new Set() : new Set(['a duplicate genuine payment.captured (duplicate-capture)', 'a genuine capture whose amount differs from the order (captured-amount-mismatch)', 'a late payment.failed of an earlier attempt after a later capture (late-failed-attempt)', 'two full-amount refunds after one capture (cumulative-refund-over-capture)']);
  const promptFindings = blind ? [] : findings;
  // Blind: the model also must not learn which app it is attacking (fixture names and header comments say
  // whether an app is meant to be correct), so it sees a neutral label and comment-free source.
  const promptApp = blind ? { id: BLIND_APP_LABEL } : app;
  const promptSources = blind ? redactSources(sources) : sources;
  let slot = 1;
  let stopped = null; // set when the client's circuit breaker is open: remaining slots are skipped, not failed
  for (; slot <= count; slot++) {
    if (stopped) { proposals.push({ slot, attempt: 0, status: 'skipped', callId: null, title: null, targets: null, errors: [stopped], duplicateOf: null, novel: false, discovered: false }); continue; }
    let feedback = null;
    let revise = false; // true after a validation/parse failure: the next attempt corrects rather than replaces
    let previous = null;
    let placed = false;
    for (let attempt = 1; attempt <= maxAttemptsPerSlot && !placed && !stopped; attempt++) {
      const { system, user } = plannerPrompt({ app: promptApp, skus, sources: promptSources, findings: promptFindings, feedback, avoid: [...knownAvoided], revise, previous, commentsRedacted: blind });
      revise = false; previous = null;
      const rec = { slot, attempt, status: 'proposed', callId: null, title: null, targets: null, rationale: null, fingerprint: null, plan: null, errors: [], duplicateOf: null, novel: false, rediscovery: false, discovered: false };
      let res;
      try {
        res = await llm.chatJson({ purpose: `attack:slot-${slot}-try-${attempt}`, system, user, maxTokens: 1800, reasoningEffort: 'low' });
      } catch (err) {
        if (err.code === 'circuit_open') { stopped = err.message; rec.status = 'skipped'; rec.errors = [err.message]; proposals.push(rec); continue; }
        rec.status = 'error'; rec.callId = err.callId ?? null; rec.errors = [`${err.code ?? 'error'}: ${err.message}`];
        proposals.push(rec); feedback = rec.errors; revise = err.code === 'invalid_json'; continue;
      }
      rec.callId = res.callId;
      const plan = res.json;
      rec.title = typeof plan.title === 'string' ? plan.title : null;
      rec.targets = Array.isArray(plan.targets) ? plan.targets : null;
      rec.rationale = typeof plan.rationale === 'string' ? plan.rationale : null;
      const v = validatePlan(plan, { skus });
      // The refund route comes from the app's frozen (discovered) mapping; an app without one cannot run it.
      if (v.ok && plan.steps.some((s) => s.action === 'request_refund') && !frozen.routes?.refund?.path) { v.ok = false; v.errors.push('this app\'s mapping has no refund route, so request_refund cannot be used'); }
      if (!v.ok) { rec.status = 'rejected'; rec.errors = v.errors.slice(0, 8); proposals.push(rec); feedback = v.errors.slice(0, 6); revise = true; previous = plan; continue; }
      rec.plan = sanitizePlan(plan);
      rec.fingerprint = fingerprint(plan);
      if (acceptedFingerprints.has(rec.fingerprint)) { rec.status = 'duplicate'; rec.duplicateOf = `proposal #${acceptedFingerprints.get(rec.fingerprint) + 1}`; proposals.push(rec); feedback = ['that duplicates one of your earlier accepted proposals; try a different structure']; continue; }
      const known = resemblesKnown(rec.fingerprint);
      if (known && !blind) { rec.status = 'duplicate'; rec.duplicateOf = known; proposals.push(rec); feedback = [`that reproduces the existing "${known}" scenario; design something structurally different`]; continue; }

      // Accepted: compile and execute through the isolated harness. In blind mode a rebuild of a hand-written
      // scenario runs too, but as a rediscovery, never as novel.
      if (known) { rec.rediscovery = true; rec.duplicateOf = known; } else rec.novel = true;
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
      novel: executed.filter((p) => p.novel).length,
      rediscoveries: executed.filter((p) => p.rediscovery).length,
      discoveredViolations: executed.filter((p) => p.discovered).length,
      novelViolations: executed.filter((p) => p.discovered && p.novel).length,
      rediscoveredViolations: executed.filter((p) => p.discovered && p.rediscovery).length,
      blind,
      clean: executed.filter((p) => p.outcome === 'clean').length,
      inconclusive: executed.filter((p) => p.outcome === 'inconclusive').length,
    },
    durationMs: Math.round(performance.now() - t0),
  };
}

module.exports = { proposeAndRunAttacks, sanitizePlan, BLIND_APP_LABEL };
