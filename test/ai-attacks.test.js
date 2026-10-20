'use strict';
// AI-proposed attacks (harness/ai/attacks.js, attack-loop.js) with mocked model responses and REAL execution.
// Deterministic validation rejects malformed/malicious plans; duplicates of the hand-written scenarios and of
// earlier proposals are detected; accepted plans compile to ordinary scenarios run through the isolated harness,
// and the independent invariant checker — never the model — decides the outcome. The original apps are untouched.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validatePlan, fingerprint, resemblesKnown, compileAttack, plannerPrompt, LIMITS, STEP_FIELDS, PLAN_SCHEMA, REF_MAX_LENGTH } = require('../harness/ai/attacks');
const { proposeAndRunAttacks } = require('../harness/ai/attack-loop');
const { freezeFor } = require('../harness/ai/pipeline');
const { runScenario } = require('../harness/runner');
const { classify } = require('../harness/ai/tools');
const { loadSources } = require('../harness/ai/evidence');
const { createMockClient, withCircuitBreaker } = require('../harness/ai/llm');
const { hashTree } = require('../harness/ai/repair');
const { startAttackTarget } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const SKUS = ['STICKER', 'TSHIRT', 'HOODIE'];
const step = (o) => ({ action: 'deliver_webhook', authenticity: 'genuine', signing: 'valid', event: 'payment.captured', payment: 'p1', order: 'o1', amount: 'order', ...o });
const plan = (over = {}) => ({
  title: 'test sequence', targets: ['I2'], rationale: 'a deliberately crafted sequence for testing validation',
  orders: [{ ref: 'o1', sku: 'TSHIRT', quantity: 1 }], payments: [{ ref: 'p1' }],
  steps: [{ action: 'create_order', order: 'o1' }, step()], ...over,
});
const ZERO = plan({ title: 'genuine capture, zero amount', targets: ['I2'], steps: [{ action: 'create_order', order: 'o1' }, step({ amount: 'zero' })] });
const FORGED = plan({ title: 'forged unsigned capture', targets: ['I1'], rationale: 'a forged unsigned capture that a correct app rejects', steps: [{ action: 'create_order', order: 'o1' }, step({ authenticity: 'forged', signing: 'unsigned' })] });
const DUP_KNOWN = plan({ title: 'capture amount double', steps: [{ action: 'create_order', order: 'o1' }, step({ amount: 'double' })] });

describe('ai attack plan validation', () => {
  it('accepts a well-formed plan', () => {
    assert.equal(validatePlan(plan(), { skus: SKUS }).ok, true);
  });
  it('rejects unknown actions, events, amounts and signing (enum) and unknown fields', () => {
    assert.equal(validatePlan(plan({ steps: [{ action: 'run_shell', cmd: 'rm -rf /' }] }), { skus: SKUS }).ok, false);
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ event: 'payment.refunded' })] }), { skus: SKUS }).errors.join(), /must be one of/);
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ amount: 'triple' })] }), { skus: SKUS }).errors.join(), /must be one of/);
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ signing: 'forge_it' })] }), { skus: SKUS }).errors.join(), /must be one of/);
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1', evil: 1 }, step()] }), { skus: SKUS }).errors.join(), /unexpected property "evil"/);
  });
  it('rejects unknown sku, bad refs, use-before-create, and over-limit sizes', () => {
    assert.match(validatePlan(plan({ orders: [{ ref: 'o1', sku: 'LAPTOP', quantity: 1 }] }), { skus: SKUS }).errors.join(), /not in the catalogue/);
    assert.match(validatePlan(plan({ orders: [{ ref: 'O1!', sku: 'TSHIRT', quantity: 1 }] }), { skus: SKUS }).errors.join(), /does not match|unknown order/);
    assert.match(validatePlan(plan({ steps: [step()] }), { skus: SKUS }).errors.join(), /used before it is created/);
    assert.match(validatePlan(plan({ steps: Array.from({ length: LIMITS.maxSteps + 2 }, () => step()) }), { skus: SKUS }).errors.join(), /at most/);
    assert.match(validatePlan(plan({ orders: [{ ref: 'o1', sku: 'TSHIRT', quantity: 99 }] }), { skus: SKUS }).errors.join(), /above maximum/);
  });
  it('enforces gateway-ledger rules: a genuine event must be validly signed and keep one order/amount', () => {
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ signing: 'unsigned' })] }), { skus: SKUS }).errors.join(), /genuine event must be delivered with valid signing/);
    const twoAmounts = plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ amount: 'order' }), step({ amount: 'double' })] });
    assert.match(validatePlan(twoAmounts, { skus: SKUS }).errors.join(), /cannot change its order\/amount/);
  });
  it('rejects a forged event carrying a valid signature (it would be a false positive on every app)', () => {
    const forgedValid = plan({ targets: ['I1'], steps: [{ action: 'create_order', order: 'o1' }, step({ authenticity: 'forged', signing: 'valid' })] });
    assert.match(validatePlan(forgedValid, { skus: SKUS }).errors.join(), /forged event cannot carry a valid signature/);
    assert.equal(validatePlan(plan({ targets: ['I1'], steps: [{ action: 'create_order', order: 'o1' }, step({ authenticity: 'forged', signing: 'unsigned' })] }), { skus: SKUS }).ok, true);
  });
  it('requires at least one webhook delivery', () => {
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }] }), { skus: SKUS }).errors.join(), /delivers no webhook/);
  });
});

describe('ai attack duplicate detection', () => {
  it('flags rebuilds of the hand-written scenarios, ignoring sku/quantity', () => {
    assert.equal(resemblesKnown(fingerprint(DUP_KNOWN)), 'captured-amount-mismatch');
    assert.equal(resemblesKnown(fingerprint(plan({ steps: [{ action: 'create_order', order: 'o1' }, step(), step()] }))), 'duplicate-capture');
    assert.equal(resemblesKnown(fingerprint(plan({ orders: [{ ref: 'o1', sku: 'HOODIE', quantity: 2 }], steps: [{ action: 'create_order', order: 'o1' }, step({ amount: 'double' })] }))), 'captured-amount-mismatch');
  });
  it('does not flag a genuinely different structure', () => {
    assert.equal(resemblesKnown(fingerprint(ZERO)), null);
    assert.equal(resemblesKnown(fingerprint(FORGED)), null);
  });
  it('two plans differing only in names share a fingerprint', () => {
    const a = fingerprint(ZERO);
    const b = fingerprint(plan({ title: 'different name', orders: [{ ref: 'basket', sku: 'TSHIRT', quantity: 1 }], payments: [{ ref: 'pay' }], steps: [{ action: 'create_order', order: 'basket' }, step({ payment: 'pay', order: 'basket', amount: 'zero' })] }));
    assert.equal(a, b);
  });
});

describe('ai attack compile + real execution (verdict from the harness, not the model)', () => {
  let frozenVuln; let frozenRef;
  before(async () => {
    frozenVuln = (await freezeFor({ id: 'vulnerable', impl: 'vulnerable', sourceRoot: 'merchant/vulnerable' }, () => startAttackTarget('vulnerable'))).frozen;
    frozenRef = (await freezeFor({ id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' }, () => startAttackTarget('reference'))).frozen;
  });
  const run = async (p, frozen, impl) => classify(await runScenario(compileAttack(p, { id: `test-${impl}` }), { ...frozen, mode: 'sequential', repetitions: 2, startTarget: () => startAttackTarget(impl) }), 'sequential');

  it('a novel zero-amount capture reproduces I2 on the vulnerable app and not on the correct app', async () => {
    const vuln = await run(ZERO, frozenVuln, 'vulnerable');
    assert.equal(vuln.outcome, 'violation');
    assert.deepEqual(vuln.summary.violationKinds, { I2: ['captured_amount_mismatch'] });
    const ref = await run(ZERO, frozenRef, 'reference');
    assert.notEqual(ref.outcome, 'violation', 'the correct app is not flagged');
  });
  it('the model cannot set the verdict: a mislabelled target is not counted as a discovery, and a harmless plan cannot claim one', async () => {
    // Claims I4 but really breaks I2: NOT counted as a reproduced (target) violation, yet the real I2 break is
    // still reported by the harness — the model can neither invent an I4 finding nor hide the real I2 one.
    const mislabelled = { ...ZERO, targets: ['I4'] };
    const r = await run(mislabelled, frozenVuln, 'vulnerable');
    assert.notEqual(r.outcome, 'violation', 'a non-target invariant break is not a reproduced-target discovery');
    assert.deepEqual(r.summary.violationKinds, { I2: ['captured_amount_mismatch'] }, 'the harness still reports the real invariant that broke');
    // Claims every invariant but breaks nothing → never a violation.
    const harmless = { ...FORGED, targets: ['I1', 'I2', 'I3', 'I4', 'I5'] };
    assert.notEqual((await run(harmless, frozenVuln, 'vulnerable')).outcome, 'violation');
  });
});

// Refund steps: the attacker can ask the merchant's own refund route to refund an order, after a genuine
// full-amount capture. What the gateway refunded is judged from the independent ledger (I5).
const refund = (o) => ({ action: 'request_refund', order: 'o1', amount: 'order', ...o });
const CAPTURE = [{ action: 'create_order', order: 'o1' }, step()];
const HALF_THEN_FULL = plan({ title: 'half refund then full refund', targets: ['I5'], rationale: 'two refunds whose sum exceeds the single capture', steps: [...CAPTURE, refund({ amount: 'half' }), refund()] });
const KNOWN_REFUND = plan({ title: 'two full refunds', targets: ['I5'], steps: [...CAPTURE, refund(), refund()] });
const ledgerTotals = (rec) => {
  const captured = Object.values(rec.ledger.payments).filter((p) => p.history.includes('captured')).reduce((a, p) => a + p.amount, 0);
  const refunded = rec.ledger.refunds.filter((r) => r.status !== 'failed').reduce((a, r) => a + r.amount, 0);
  return { captured, refunded };
};

describe('ai refund plans: validation and fingerprint', () => {
  it('accepts refunds after a genuine, validly-signed full-amount capture', () => {
    assert.equal(validatePlan(HALF_THEN_FULL, { skus: SKUS }).ok, true);
    assert.equal(validatePlan(plan({ steps: [...CAPTURE, refund({ repeat: 2 })] }), { skus: SKUS }).ok, true);
  });
  it('rejects a refund with no full genuine capture before it (before capture, forged/unsigned capture, partial capture)', () => {
    const need = /needs an earlier genuine, validly-signed payment.captured of the full order amount/;
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, refund(), step()] }), { skus: SKUS }).errors.join(), need);
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ authenticity: 'forged', signing: 'unsigned' }), refund()] }), { skus: SKUS }).errors.join(), need);
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ amount: 'half' }), refund()] }), { skus: SKUS }).errors.join(), need);
    assert.match(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, step({ event: 'payment.authorized' }), refund()] }), { skus: SKUS }).errors.join(), need);
  });
  it('rejects out-of-bounds refund amounts (a single refund above captured would be a simulator artefact)', () => {
    for (const amount of ['double', 'plus_one', 'zero']) {
      assert.match(validatePlan(plan({ steps: [...CAPTURE, refund({ amount })] }), { skus: SKUS }).errors.join(), /refund amount must be one of order, half/);
    }
  });
  it('rejects malformed refund steps and too many refunds', () => {
    assert.match(validatePlan(plan({ steps: [...CAPTURE, { action: 'request_refund', order: 'o1' }] }), { skus: SKUS }).errors.join(), /needs "amount"/);
    assert.match(validatePlan(plan({ steps: [...CAPTURE, refund({ signing: 'valid' })] }), { skus: SKUS }).errors.join(), /"signing" is not used by a refund step/);
    assert.match(validatePlan(plan({ steps: [...CAPTURE, refund({ order: 'nope' })] }), { skus: SKUS }).errors.join(), /unknown order ref/);
    assert.match(validatePlan(plan({ steps: [...CAPTURE, refund({ repeat: 2 }), refund({ repeat: 2 })] }), { skus: SKUS }).errors.join(), /too many refund requests \(4, at most 3\)/);
    assert.match(validatePlan(plan({ steps: [...CAPTURE, refund({ evil: 1 })] }), { skus: SKUS }).errors.join(), /unexpected property "evil"/);
  });
  it('fingerprints repeat as repeated steps, and flags a rebuild of the hand-written refund scenario', () => {
    assert.equal(fingerprint(KNOWN_REFUND), fingerprint(plan({ steps: [...CAPTURE, refund({ repeat: 2 })] })));
    assert.equal(resemblesKnown(fingerprint(KNOWN_REFUND)), 'cumulative-refund-over-capture');
    assert.equal(resemblesKnown(fingerprint(plan({ orders: [{ ref: 'o1', sku: 'HOODIE', quantity: 2 }], steps: [...CAPTURE, refund({ repeat: 2 })] }))), 'cumulative-refund-over-capture');
    assert.equal(resemblesKnown(fingerprint(HALF_THEN_FULL)), null, 'a different refund structure is not a duplicate');
  });
  it('the planner prompt documents refunds generically and requires their fields', () => {
    const { system } = plannerPrompt({ app: { id: 'x' }, skus: SKUS, sources: [], findings: [], feedback: null, avoid: [] });
    assert.match(system, /"request_refund" step asks the merchant's own refund endpoint/);
    assert.match(system, /"request_refund" step needs "action", "order", "amount"/);
    assert.match(system, /refund an order only after a genuine, validly-signed payment.captured of its full amount/);
  });
});

describe('ai refund plans: real execution and ledger reconciliation (verdict from the harness)', () => {
  const frozen = {};
  before(async () => {
    for (const impl of ['vulnerable', 'reference', 'unseen2']) frozen[impl] = (await freezeFor({ id: impl, impl, sourceRoot: `merchant/${impl}` }, () => startAttackTarget(impl))).frozen;
  });
  const exec = async (p, impl) => {
    const records = await runScenario(compileAttack(p, { id: `test-refund-${impl}` }), { ...frozen[impl], mode: 'sequential', repetitions: 2, startTarget: () => startAttackTarget(impl) });
    return { records, ...classify(records, 'sequential') };
  };

  it('vulnerable: both refunds accepted; the independent ledger shows refunds above captured and I5 is violated', async () => {
    const r = await exec(HALF_THEN_FULL, 'vulnerable');
    assert.equal(r.outcome, 'violation');
    assert.deepEqual(r.summary.violationKinds, { I5: ['gateway_refunds_exceed_captured'] });
    for (const rec of r.records) {
      assert.deepEqual(rec.facts.refundStatuses.map((s) => s >= 200 && s < 300), [true, true]);
      const { captured, refunded } = ledgerTotals(rec);
      assert.ok(refunded > captured, `ledger: refunded ${refunded} > captured ${captured}`);
    }
  });
  for (const impl of ['reference', 'unseen2']) {
    it(`${impl} (control): the second refund is rejected, the ledger stays within captured, no violation`, async () => {
      const r = await exec(HALF_THEN_FULL, impl);
      assert.notEqual(r.outcome, 'violation');
      assert.deepEqual(r.summary.violationKinds, {});
      for (const rec of r.records) {
        const [first, second] = rec.facts.refundStatuses;
        assert.ok(first >= 200 && first < 300, 'the first within-cap refund is accepted (route is live)');
        assert.ok(second >= 400, 'the over-cumulative refund is rejected');
        const { captured, refunded } = ledgerTotals(rec);
        assert.ok(refunded <= captured, `ledger: refunded ${refunded} <= captured ${captured}`);
      }
    });
  }
  it('a refund plan the model mislabels as I4 is not a target discovery, but the harness still reports the I5 break', async () => {
    const r = await exec({ ...HALF_THEN_FULL, targets: ['I4'] }, 'vulnerable');
    assert.notEqual(r.outcome, 'violation');
    assert.deepEqual(r.summary.violationKinds, { I5: ['gateway_refunds_exceed_captured'] });
  });
});

describe('ai attack loop (mock model) + original-app immutability', () => {
  it('classifies rejected / duplicate / executed, marks discovered only on a real violation, and never touches the app', async () => {
    const hashes = hashTree(path.join(ROOT, 'merchant', 'vulnerable'));
    const app = { id: 'vulnerable', impl: 'vulnerable', sourceRoot: 'merchant/vulnerable' };
    const { frozen } = await freezeFor(app, () => startAttackTarget('vulnerable'));
    const sources = loadSources('merchant/vulnerable', ['app.js']);
    // Scripted proposals: invalid → novel violating → duplicate-of-known → novel clean.
    const scripted = [plan({ orders: [{ ref: 'o1', sku: 'LAPTOP', quantity: 1 }] }), ZERO, DUP_KNOWN, FORGED];
    const llm = createMockClient({ responder: ({ callIndex }) => scripted[callIndex] ?? FORGED });
    const r = await proposeAndRunAttacks({ llm, app, frozen, startTarget: () => startAttackTarget('vulnerable'), sources, findings: [], skus: SKUS, count: 2, repetitions: 2, maxAttemptsPerSlot: 2 });

    assert.deepEqual(r.proposals.map((p) => p.status), ['rejected', 'executed', 'duplicate', 'executed']);
    assert.match(r.proposals[0].errors.join(), /not in the catalogue/);
    assert.equal(r.proposals[1].outcome, 'violation');
    assert.equal(r.proposals[1].discovered, true);
    assert.equal(r.proposals[1].novel, true);
    assert.deepEqual(r.proposals[1].violationKinds, { I2: ['captured_amount_mismatch'] });
    assert.equal(r.proposals[2].duplicateOf, 'captured-amount-mismatch');
    assert.equal(r.proposals[3].outcome !== 'violation', true);
    assert.equal(r.proposals[3].discovered, false, 'a clean execution is never "discovered"');

    assert.equal(r.summary.executed, 2);
    assert.equal(r.summary.discoveredViolations, 1);
    assert.equal(r.summary.duplicates, 1);
    assert.equal(r.summary.rejected, 1);
    assert.deepEqual(hashTree(path.join(ROOT, 'merchant', 'vulnerable')), hashes, 'the original app is byte-identical afterwards');
  });

  it('a rejected plan gets one corrective retry that echoes the errors and the plan; a duplicate asks for a different one', async () => {
    const app = { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' };
    const { frozen } = await freezeFor(app, () => startAttackTarget('reference'));
    const sources = loadSources('merchant/reference', ['app.js']);
    // The failure seen in real runs: webhook steps without "order".
    const { order: _omit, ...noOrder } = step({ amount: 'zero' });
    const missingOrder = { ...ZERO, steps: [{ action: 'create_order', order: 'o1' }, noOrder] };
    const users = [];
    const scripted = [missingOrder, ZERO, DUP_KNOWN, FORGED];
    const llm = createMockClient({ responder: ({ user, callIndex }) => { users.push(user); return scripted[callIndex] ?? FORGED; } });
    const r = await proposeAndRunAttacks({ llm, app, frozen, startTarget: () => startAttackTarget('reference'), sources, skus: SKUS, count: 2, repetitions: 1, maxAttemptsPerSlot: 2 });

    assert.deepEqual(r.proposals.map((p) => p.status), ['rejected', 'executed', 'duplicate', 'executed']);
    assert.match(r.proposals[0].errors.join(), /needs "order"/);
    // Corrective retry: validator errors + the rejected plan, and an instruction to fix rather than replace.
    assert.match(users[1], /FAILED VALIDATION/);
    assert.match(users[1], /needs \\?"order\\?"/);
    assert.match(users[1], /YOUR PREVIOUS PROPOSAL \(for correction\)/);
    assert.match(users[1], /"title":"genuine capture, zero amount"/);
    assert.match(users[1], /fix exactly these problems/);
    // A duplicate is not a format problem: the next attempt is asked for a different sequence, without the plan.
    assert.match(users[3], /Propose a different, valid, non-duplicate sequence/);
    assert.doesNotMatch(users[3], /FAILED VALIDATION|for correction/);
    // The verdict still comes from execution, not from the correction.
    assert.equal(r.proposals[1].discovered, r.proposals[1].outcome === 'violation');
  });

  it('the planner prompt states the per-action required step fields and the rationale limit', () => {
    const { system } = plannerPrompt({ app: { id: 'x' }, skus: SKUS, sources: [], findings: [], feedback: null, avoid: [] });
    for (const f of STEP_FIELDS.deliver_webhook) assert.ok(system.includes(`"${f}"`), `mentions ${f}`);
    assert.match(system, /"deliver_webhook" step needs ALL of/);
    assert.match(system, /at most 600 characters/);
    // The example step in the prompt must itself pass validation.
    const example = JSON.parse(system.match(/Example webhook step: (\{.*?\})\./)[1]);
    assert.equal(validatePlan(plan({ steps: [{ action: 'create_order', order: 'o1' }, example] }), { skus: SKUS }).ok, true);
  });

  it('the planner prompt states the exact ref format, and its valid and invalid examples behave as stated', () => {
    const { system } = plannerPrompt({ app: { id: 'x' }, skus: SKUS, sources: [], findings: [], feedback: null, avoid: [] });
    assert.ok(system.includes(PLAN_SCHEMA.properties.orders.items.properties.ref.pattern), 'states the schema pattern itself');
    assert.match(system, new RegExp(`at most ${REF_MAX_LENGTH - 1} lowercase letters`));
    const withRef = (r) => plan({ orders: [{ ref: r, sku: 'TSHIRT', quantity: 1 }], payments: [{ ref: 'p1' }], steps: [{ action: 'create_order', order: r }, step({ order: r })] });
    const valid = ['o1', 'p1', 'order_2', 'a', 'x'.repeat(REF_MAX_LENGTH)];
    const invalid = ['O1', 'order-1', '1o', 'o 1', '_o1', '', 'x'.repeat(REF_MAX_LENGTH + 1)];
    for (const r of valid) assert.equal(validatePlan(withRef(r), { skus: SKUS }).ok, true, `"${r}" is valid`);
    for (const r of invalid) {
      const v = validatePlan(withRef(r), { skus: SKUS });
      assert.equal(v.ok, false, `"${r}" is rejected`);
      assert.match(v.errors.join(), /does not match/);
    }
    // Payment refs follow the same rule.
    assert.equal(validatePlan(plan({ payments: [{ ref: 'P1' }], steps: [{ action: 'create_order', order: 'o1' }, step({ payment: 'P1' })] }), { skus: SKUS }).ok, false);
    // Every example the prompt calls valid passes, every one it calls rejected fails.
    for (const r of system.match(/e\.g\. ([^.]*)\./)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1))) assert.equal(validatePlan(withRef(r), { skus: SKUS }).ok, true, r);
    for (const r of system.match(/are rejected \(([^)]*)\)/)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1))) assert.equal(validatePlan(withRef(r), { skus: SKUS }).ok, false, r);
  });

  it('blind mode: no findings or known scenarios reach the prompt; a hand-written rebuild runs as a rediscovery, never novel', async () => {
    const hashes = hashTree(path.join(ROOT, 'merchant', 'vulnerable'));
    const app = { id: 'vulnerable', impl: 'vulnerable', sourceRoot: 'merchant/vulnerable' };
    const { frozen } = await freezeFor(app, () => startAttackTarget('vulnerable'));
    const sources = loadSources('merchant/vulnerable', ['app.js']);
    const findings = [{ scenario: 'cumulative-refund-over-capture', outcome: 'violation', targets: ['I5'], reproduced: 3 }];
    const prompts = [];
    const scripted = [KNOWN_REFUND, KNOWN_REFUND, HALF_THEN_FULL];
    const llm = createMockClient({ responder: ({ system, user, callIndex }) => { prompts.push(system + user); return scripted[callIndex] ?? FORGED; } });
    const r = await proposeAndRunAttacks({ llm, app, frozen, startTarget: () => startAttackTarget('vulnerable'), sources, findings, skus: SKUS, count: 2, repetitions: 2, maxAttemptsPerSlot: 2, blind: true });

    for (const p of prompts) {
      assert.doesNotMatch(p, /cumulative-refund-over-capture|duplicate-capture|late-failed-attempt|captured-amount-mismatch/, 'no scenario names or findings in a blind prompt');
      assert.match(p, /known baseline scenarios: none/);
    }
    assert.deepEqual(r.proposals.map((p) => p.status), ['executed', 'duplicate', 'executed']);
    assert.equal(r.proposals[0].rediscovery, true);
    assert.equal(r.proposals[0].novel, false, 'a rebuild of a hand-written scenario is never novel');
    assert.equal(r.proposals[0].duplicateOf, 'cumulative-refund-over-capture');
    assert.equal(r.proposals[1].duplicateOf, 'proposal #1', 'repeating its own proposal is still a duplicate, not re-run');
    assert.equal(r.proposals[2].novel, true);
    assert.equal(r.proposals[2].discovered, true, 'the harness confirmed the novel refund sequence');
    assert.equal(r.summary.blind, true);
    assert.equal(r.summary.rediscoveredViolations, 1);
    assert.equal(r.summary.novelViolations, 1);
    assert.deepEqual(hashTree(path.join(ROOT, 'merchant', 'vulnerable')), hashes, 'the original app is byte-identical afterwards');
  });

  it('non-blind mode: a rebuild of the hand-written refund scenario is a duplicate and is not executed', async () => {
    const app = { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' };
    const { frozen } = await freezeFor(app, () => startAttackTarget('reference'));
    const sources = loadSources('merchant/reference', ['app.js']);
    const llm = createMockClient({ responder: () => KNOWN_REFUND });
    const r = await proposeAndRunAttacks({ llm, app, frozen, startTarget: () => startAttackTarget('reference'), sources, skus: SKUS, count: 1, repetitions: 1, maxAttemptsPerSlot: 1 });
    assert.deepEqual(r.proposals.map((p) => [p.status, p.duplicateOf]), [['duplicate', 'cumulative-refund-over-capture']]);
    assert.equal(r.summary.executed, 0);
  });

  it('a refund plan is rejected before execution when the app has no mapped refund route', async () => {
    const app = { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' };
    const { frozen } = await freezeFor(app, () => startAttackTarget('reference'));
    const { refund: _drop, ...routes } = frozen.routes;
    const llm = createMockClient({ responder: () => HALF_THEN_FULL });
    const r = await proposeAndRunAttacks({ llm, app, frozen: { ...frozen, routes }, startTarget: () => startAttackTarget('reference'), sources: loadSources('merchant/reference', ['app.js']), skus: SKUS, count: 1, repetitions: 1, maxAttemptsPerSlot: 1 });
    assert.equal(r.proposals[0].status, 'rejected');
    assert.match(r.proposals[0].errors.join(), /no refund route/);
  });

  it('a model failure or malformed proposal is recorded, not fatal', async () => {
    const app = { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' };
    const { frozen } = await freezeFor(app, () => startAttackTarget('reference'));
    const sources = loadSources('merchant/reference', ['app.js']);
    const llm = createMockClient({ responder: () => 'this is not json' });
    const r = await proposeAndRunAttacks({ llm, app, frozen, startTarget: () => startAttackTarget('reference'), sources, skus: SKUS, count: 1, repetitions: 1, maxAttemptsPerSlot: 1 });
    assert.equal(r.proposals.length, 1);
    assert.equal(r.proposals[0].status, 'error');
    assert.equal(r.summary.executed, 0);
  });

  it('an open circuit breaker skips the remaining slots instead of calling the model', async () => {
    const app = { id: 'reference', impl: 'reference', sourceRoot: 'merchant/reference' };
    const { frozen } = await freezeFor(app, () => startAttackTarget('reference'));
    const sources = loadSources('merchant/reference', ['app.js']);
    const llm = withCircuitBreaker(createMockClient({ responder: () => 'this is not json' }), { maxConsecutiveFailures: 2 });
    const r = await proposeAndRunAttacks({ llm, app, frozen, startTarget: () => startAttackTarget('reference'), sources, skus: SKUS, count: 3, repetitions: 1, maxAttemptsPerSlot: 2 });
    assert.deepEqual(r.proposals.map((p) => p.status), ['error', 'error', 'skipped', 'skipped']);
    assert.equal(llm.trace.length, 2);
    assert.equal(r.summary.errors, 2);
    assert.equal(r.summary.skipped, 2);
    assert.equal(r.summary.modelCalls, 2);
    assert.equal(r.summary.executed, 0);
  });
});
