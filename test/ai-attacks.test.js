'use strict';
// AI-proposed attacks (harness/ai/attacks.js, attack-loop.js) with mocked model responses and REAL execution.
// Deterministic validation rejects malformed/malicious plans; duplicates of the hand-written scenarios and of
// earlier proposals are detected; accepted plans compile to ordinary scenarios run through the isolated harness,
// and the independent invariant checker — never the model — decides the outcome. The original apps are untouched.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validatePlan, fingerprint, resemblesKnown, compileAttack, LIMITS } = require('../harness/ai/attacks');
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
