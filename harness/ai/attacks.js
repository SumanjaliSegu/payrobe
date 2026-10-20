'use strict';
// AI-proposed payment attacks. The model fills a strict, declarative plan from an allowlisted vocabulary of
// mock webhook events; it never writes code. A deterministic validator checks every field, a fingerprint
// marks duplicates of the hand-written scenarios and of other proposals, and a compiler turns an accepted
// plan into an ordinary runner scenario (its play() only calls existing ctx methods). Execution goes through
// the normal isolated harness and the independent ledger + invariant checker decide the outcome — the model
// never sets a verdict, and nothing is "novel" or "discovered" without execution evidence.
const { validate, describe } = require('./schema');
const { sourcesForPrompt } = require('./evidence');

const EVENTS = ['payment.authorized', 'payment.captured', 'payment.failed'];
const AMOUNTS = ['order', 'double', 'half', 'zero', 'plus_one']; // relative to the referenced order's amount
// A single refund above the captured amount is documented-rejected by Razorpay but accepted by the mock
// gateway (docs/GATEWAY_CONTRACT.md "Refunds"), so it would be a simulator artefact, not a merchant bug:
// refund amounts stay within one full capture.
const REFUND_AMOUNTS = ['order', 'half'];
const SIGNING = ['valid', 'unsigned', 'wrong_secret'];
const AUTH = ['genuine', 'forged']; // genuine = recorded in the gateway ledger; forged = never processed
const LIMITS = { maxOrders: 2, maxPayments: 3, maxSteps: 6, maxQuantity: 3, maxRepeat: 2, maxRefunds: 3 };
const WRONG_SECRET = 'not_the_webhook_secret';

const refRe = '^[a-z][a-z0-9_]{0,15}$';
const REF_MAX_LENGTH = 16; // what refRe allows; stated to the model in plannerPrompt

const PLAN_SCHEMA = {
  type: 'object',
  required: ['title', 'targets', 'rationale', 'orders', 'payments', 'steps'],
  properties: {
    title: { type: 'string', minLength: 6, maxLength: 120 },
    targets: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: ['I1', 'I2', 'I3', 'I4', 'I5'] } },
    rationale: { type: 'string', minLength: 15, maxLength: 600 },
    orders: {
      type: 'array', minItems: 1, maxItems: LIMITS.maxOrders,
      items: { type: 'object', required: ['ref', 'sku', 'quantity'], properties: { ref: { type: 'string', pattern: refRe }, sku: { type: 'string', maxLength: 40 }, quantity: { type: 'integer', minimum: 1, maximum: LIMITS.maxQuantity } } },
    },
    payments: {
      type: 'array', minItems: 1, maxItems: LIMITS.maxPayments,
      items: { type: 'object', required: ['ref'], properties: { ref: { type: 'string', pattern: refRe } } },
    },
    steps: {
      type: 'array', minItems: 1, maxItems: LIMITS.maxSteps,
      items: {
        type: 'object', required: ['action'],
        properties: {
          action: { type: 'string', enum: ['create_order', 'deliver_webhook', 'request_refund'] },
          order: { type: 'string', pattern: refRe },
          payment: { type: 'string', pattern: refRe },
          authenticity: { type: 'string', enum: AUTH },
          signing: { type: 'string', enum: SIGNING },
          event: { type: 'string', enum: EVENTS },
          amount: { type: 'string', enum: AMOUNTS },
          repeat: { type: 'integer', minimum: 1, maximum: LIMITS.maxRepeat },
        },
      },
    },
  },
};

// Cross-field validation the JSON schema can't express: ref uniqueness/resolution, create-before-use ordering,
// per-step required fields, the gateway-ledger rule that a genuine payment's (order, amount) is fixed, and
// refunds only against an earlier genuine full-amount capture of the same order.
function validatePlan(plan, { skus }) {
  const base = validate(plan, PLAN_SCHEMA);
  const errors = [...base.errors];
  if (!base.ok) return { ok: false, errors };
  const orderRefs = new Map();
  for (const o of plan.orders) {
    if (orderRefs.has(o.ref)) errors.push(`duplicate order ref "${o.ref}"`);
    if (!skus.includes(o.sku)) errors.push(`order "${o.ref}": sku "${o.sku}" is not in the catalogue (${skus.join(', ')})`);
    orderRefs.set(o.ref, o);
  }
  const paymentRefs = new Set();
  for (const p of plan.payments) { if (paymentRefs.has(p.ref)) errors.push(`duplicate payment ref "${p.ref}"`); paymentRefs.add(p.ref); }

  const created = new Set();
  const genuineBinding = new Map(); // payment ref -> `${order}|${amount}` fixed on first genuine use
  const fullyCaptured = new Set(); // orders with an earlier genuine, validly-signed full-amount capture
  let deliveries = 0;
  let refunds = 0;
  plan.steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s.action})`;
    if (s.action === 'create_order') {
      if (!s.order) return errors.push(`${at}: needs "order"`);
      if (!orderRefs.has(s.order)) return errors.push(`${at}: unknown order ref "${s.order}"`);
      if (created.has(s.order)) errors.push(`${at}: order "${s.order}" already created`);
      created.add(s.order);
    } else if (s.action === 'request_refund') {
      for (const f of ['order', 'amount']) if (s[f] === undefined) errors.push(`${at}: needs "${f}"`);
      for (const f of ['payment', 'authenticity', 'signing', 'event']) if (s[f] !== undefined) errors.push(`${at}: "${f}" is not used by a refund step`);
      if (s.amount !== undefined && !REFUND_AMOUNTS.includes(s.amount)) errors.push(`${at}: refund amount must be one of ${REFUND_AMOUNTS.join(', ')} (a single refund cannot exceed the captured amount)`);
      if (s.order && !orderRefs.has(s.order)) errors.push(`${at}: unknown order ref "${s.order}"`);
      else if (s.order && !fullyCaptured.has(s.order)) errors.push(`${at}: a refund needs an earlier genuine, validly-signed payment.captured of the full order amount for order "${s.order}"`);
      refunds += s.repeat ?? 1;
    } else {
      for (const f of ['authenticity', 'signing', 'event', 'payment', 'order', 'amount']) if (s[f] === undefined) errors.push(`${at}: needs "${f}"`);
      if (s.order && !orderRefs.has(s.order)) errors.push(`${at}: unknown order ref "${s.order}"`);
      else if (s.order && !created.has(s.order)) errors.push(`${at}: order "${s.order}" is used before it is created`);
      if (s.payment && !paymentRefs.has(s.payment)) errors.push(`${at}: unknown payment ref "${s.payment}"`);
      deliveries += s.repeat ?? 1;
      // A valid signature attests the gateway produced the event, so a forged (never-processed) event cannot
      // carry one: a validly-signed "forged" event is indistinguishable from genuine to any correct app and
      // would flag every app alike (a false positive, not a merchant bug). Forged events test signature
      // verification, so they must be unsigned or wrong-secret.
      if (s.authenticity === 'forged' && s.signing === 'valid') errors.push(`${at}: a forged event cannot carry a valid signature; use signing "unsigned" or "wrong_secret"`);
      if (s.authenticity === 'genuine') {
        if (s.signing !== 'valid') errors.push(`${at}: a genuine event must be delivered with valid signing`);
        const key = `${s.order}|${s.amount}`;
        const prior = genuineBinding.get(s.payment);
        if (prior && prior !== key) errors.push(`${at}: genuine payment "${s.payment}" cannot change its order/amount (gateway ledger forbids it)`);
        else genuineBinding.set(s.payment, key);
        if (s.signing === 'valid' && s.event === 'payment.captured' && s.amount === 'order' && created.has(s.order)) fullyCaptured.add(s.order);
      }
    }
  });
  if (deliveries > LIMITS.maxSteps + 1) errors.push(`too many webhook deliveries (${deliveries})`);
  if (refunds > LIMITS.maxRefunds) errors.push(`too many refund requests (${refunds}, at most ${LIMITS.maxRefunds})`);
  if (!plan.steps.some((s) => s.action === 'deliver_webhook')) errors.push('plan delivers no webhook');
  return { ok: errors.length === 0, errors };
}

// Canonical fingerprint: step structure with refs normalised to first-appearance order, so two plans that
// differ only in names/titles share a fingerprint. Amount mode and signing/authenticity are kept. A step with
// repeat N is expanded into N identical tokens, so "repeat: 2" and two identical steps fingerprint alike.
function fingerprint(plan) {
  const orderIdx = new Map();
  const payIdx = new Map();
  const norm = (map, ref) => { if (ref === undefined) return '-'; if (!map.has(ref)) map.set(ref, map.size); return map.get(ref); };
  const skuByRef = Object.fromEntries(plan.orders.map((o) => [o.ref, `${o.sku}x${o.quantity}`]));
  return plan.steps.flatMap((s) => {
    let token;
    if (s.action === 'create_order') token = `C(o${norm(orderIdx, s.order)}:${skuByRef[s.order] ?? '?'})`;
    else if (s.action === 'request_refund') token = `R(o${norm(orderIdx, s.order)},${s.amount})`;
    else token = `W(${s.authenticity[0]}${s.signing === 'valid' ? '' : s.signing === 'unsigned' ? 'u' : 'x'},${s.event.split('.')[1]},o${norm(orderIdx, s.order)},p${norm(payIdx, s.payment)},${s.amount})`;
    return Array(s.action === 'create_order' ? 1 : s.repeat ?? 1).fill(token);
  }).join(' ');
}

// Canonical fingerprints of the hand-written scenarios that this vocabulary can express, so a proposal that
// merely rebuilds one is flagged (not counted as novel). The scenario needing the verify route
// (cross-order-checkout-signature) is not expressible here.
const KNOWN_FINGERPRINTS = {
  'C(o0:TSHIRTx1) W(g,captured,o0,p0,order) W(g,captured,o0,p0,order)': 'duplicate-capture',
  'C(o0:TSHIRTx1) W(g,captured,o0,p0,double) ': 'captured-amount-mismatch',
  'C(o0:TSHIRTx1) W(g,captured,o0,p0,order) W(g,failed,o0,p1,order)': 'late-failed-attempt',
  'C(o0:TSHIRTx1) W(g,captured,o0,p0,order) R(o0,order) R(o0,order)': 'cumulative-refund-over-capture',
};
function resemblesKnown(fp) {
  // match ignoring sku/quantity specifics and trailing spaces
  const shape = (s) => s.replace(/:[A-Z]+x\d+/g, '').replace(/\s+/g, ' ').trim();
  const want = shape(fp);
  for (const [k, name] of Object.entries(KNOWN_FINGERPRINTS)) if (shape(k) === want) return name;
  return null;
}

// Compiles a VALIDATED plan into a runner scenario. play() only calls existing ctx methods.
function compileAttack(plan, { id }) {
  const amountOf = (orderAmount, mode) => ({ order: orderAmount, double: orderAmount * 2, half: Math.floor(orderAmount / 2), zero: 0, plus_one: orderAmount + 1 }[mode]);
  const orderNeeds = {};
  for (const o of plan.orders) orderNeeds[o.sku] = (orderNeeds[o.sku] ?? 0) + o.quantity;
  const refunds = plan.steps.some((s) => s.action === 'request_refund');
  return {
    id,
    title: plan.title,
    modes: ['sequential'],
    targets: [...plan.targets],
    origin: 'ai_generated',
    contract: [
      { status: 'A', basis: 'ai-proposed', claim: `AI-proposed sequence: ${plan.rationale}`, ref: 'harness/ai/attacks.js (model proposal, deterministically validated and executed)' },
      { status: 'V', basis: 'documented', claim: 'Signed webhooks and out-of-order/duplicate delivery are documented Razorpay behaviour', ref: 'docs/GATEWAY_CONTRACT.md; https://razorpay.com/docs/webhooks/' },
      ...(refunds ? [
        { status: 'U', basis: 'not-established', claim: 'Whether the cumulative sum of several refunds exceeding the captured amount is rejected is not documented', ref: 'docs/GATEWAY_CONTRACT.md "Refunds: what the docs do NOT establish"' },
        { status: 'A', basis: 'mock-gateway', claim: 'The mock gateway accepts every refund; refunded amounts are judged from the independent gateway ledger', ref: 'docs/GATEWAY_CONTRACT.md "Current simulator contract"; harness/ledger.js' },
      ] : []),
    ],
    requires: ['routes.webhook', 'orders.paidValues', 'payments.capturedValues', ...(refunds ? ['routes.refund'] : [])],
    initialState: (snapshot) => {
      const out = [];
      for (const [sku, qty] of Object.entries(orderNeeds)) {
        if (!snapshot.stock || snapshot.stock[sku] === undefined) out.push(`stock for ${sku} is not readable`);
        else if (snapshot.stock[sku] < qty) out.push(`need ${qty} ${sku}, have ${snapshot.stock[sku]}`);
      }
      return out;
    },
    async play(ctx) {
      const orders = {};
      const payments = {};
      const payId = (ref) => (payments[ref] ??= ctx.newPaymentId());
      const refundStatuses = refunds ? ctx.fact('refundStatuses', []) : [];
      let n = 0;
      for (const step of plan.steps) {
        n++;
        if (step.action === 'create_order') {
          const spec = plan.orders.find((o) => o.ref === step.order);
          orders[step.order] = ctx.fact(`order_${step.order}`, await ctx.step(`create order ${step.order} (${spec.sku}x${spec.quantity})`, () => ctx.createOrder({ sku: spec.sku, quantity: spec.quantity })));
          continue;
        }
        if (step.action === 'request_refund') {
          // Through the merchant's own mapped refund route, sequentially; the mock gateway records each refund
          // it processes in the independent ledger, which is what I5 judges.
          const o = orders[step.order];
          const amount = amountOf(o.amount, step.amount);
          await ctx.step(`step ${n}: refund order ${step.order} (amount=${step.amount})${(step.repeat ?? 1) > 1 ? ` x${step.repeat}` : ''}`, async () => {
            for (let r = 0; r < (step.repeat ?? 1); r++) {
              const res = await ctx.post('refund', { amount }, { params: { orderId: o.orderId } });
              refundStatuses.push(res.status);
            }
          });
          continue;
        }
        const o = orders[step.order];
        const fields = { paymentId: payId(step.payment), orderId: o.gatewayOrderId, amount: amountOf(o.amount, step.amount), currency: o.currency };
        const label = `${step.authenticity} ${step.event.split('.')[1]} (${step.signing}, amount=${step.amount})${(step.repeat ?? 1) > 1 ? ` x${step.repeat}` : ''}`;
        await ctx.step(`step ${n}: ${label}`, async () => {
          for (let r = 0; r < (step.repeat ?? 1); r++) {
            const event = step.authenticity === 'genuine' ? ctx.genuine(step.event, fields) : ctx.forged(step.event, fields);
            const secret = step.signing === 'valid' ? undefined : step.signing === 'unsigned' ? null : WRONG_SECRET;
            await ctx.webhook(event, { secret });
          }
        });
      }
    },
    // A genuine capture whose amount equals the order and is correctly signed must still be accepted:
    // the attack is only interesting if the app processed the legitimate part of the sequence.
    preconditions({ record, facts }) {
      const f = [];
      const anyGenuineValid = plan.steps.some((s) => s.action === 'deliver_webhook' && s.authenticity === 'genuine');
      if (anyGenuineValid) {
        const accepted = record.steps.some((st) => st.exchanges.some((x) => x.kind === 'webhook' && x.genuine && x.status >= 200 && x.status < 300));
        if (!accepted) f.push('no genuine signed webhook was accepted by the app, so the sequence did not exercise a real payment');
      }
      // As in the hand-written refund scenario: the refund route must be real and reachable, so the first
      // (within-cap) refund must be accepted. Later refunds are the behaviour under test.
      if (refunds) {
        const first = facts?.refundStatuses?.[0];
        if (!(first >= 200 && first < 300)) f.push(`refund route did not accept the first within-cap refund (status ${first ?? 'none'})`);
      }
      return f;
    },
  };
}

// Per-action required step fields. PLAN_SCHEMA marks them optional (it cannot express "required when
// action is X"), so the prompt states them explicitly; validatePlan enforces them either way.
const STEP_FIELDS = {
  create_order: ['action', 'order'],
  deliver_webhook: ['action', 'order', 'payment', 'authenticity', 'signing', 'event', 'amount'],
  request_refund: ['action', 'order', 'amount'],
};
const MAX_REVISION_CHARS = 2500; // bound on the rejected plan echoed back for correction

// `revise` (set after a validation or parse failure) asks the model to correct its previous plan rather than
// abandon the idea; without it (duplicates, execution errors) the model is asked for a different sequence.
// `commentsRedacted` (blind mode) tells the model the source comments were removed.
function plannerPrompt({ app, skus, sources, findings, feedback, avoid, revise = false, previous = null, commentsRedacted = false }) {
  const system = [
    'You are PayProbe\'s payment-attack designer for a LOCAL fixture merchant app with a mock gateway (no real money).',
    'Design ONE adversarial sequence of Razorpay-shaped webhook deliveries that might break a payment-integrity invariant',
    '(I1 paid only by a genuine capture for that order; I2 amount/currency match; I3 fulfil only paid orders, once; I4 a',
    'paid order is never reversed; I5 refunds never exceed captured). You may only use the declarative vocabulary below;',
    'you cannot write code, call networks, or run shell commands. Ground the design in the source and the known findings.',
    'Vocabulary: orders have {ref, sku, quantity}; webhooks are {authenticity: genuine|forged, signing: valid|unsigned|wrong_secret,',
    'event: payment.authorized|captured|failed, payment ref, order ref, amount: order|double|half|zero|plus_one, repeat: 1-2}.',
    `Refunds: a "request_refund" step asks the merchant's own refund endpoint to refund an order {order ref, amount: ${REFUND_AMOUNTS.join('|')} (of the order amount), repeat: 1-2}; refund requests are sent one at a time, at most ${LIMITS.maxRefunds} per plan. What the gateway actually refunded is recorded independently.`,
    'Rules: a genuine event must be validly signed and a genuine payment keeps one order and amount; a forged event (never processed by the gateway) must be unsigned or wrong_secret (a valid signature would make it genuine); create an order before using it; refund an order only after a genuine, validly-signed payment.captured of its full amount (amount "order").',
    `Every step MUST include these fields: a "create_order" step needs ${STEP_FIELDS.create_order.map((f) => `"${f}"`).join(', ')}; a "deliver_webhook" step needs ALL of ${STEP_FIELDS.deliver_webhook.map((f) => `"${f}"`).join(', ')}; a "request_refund" step needs ${STEP_FIELDS.request_refund.map((f) => `"${f}"`).join(', ')} and no webhook fields ("repeat" is optional). Example webhook step: {"action":"deliver_webhook","order":"o1","payment":"p1","authenticity":"genuine","signing":"valid","event":"payment.captured","amount":"order"}.`,
    `Every ref (orders[].ref, payments[].ref, and the "order" and "payment" fields of steps) must match ${refRe}: a lowercase letter followed by at most ${REF_MAX_LENGTH - 1} lowercase letters, digits or underscores, e.g. "o1", "p1", "order_2". Capitals, hyphens, spaces and leading digits are rejected ("O1", "order-1", "1o").`,
    `Keep "rationale" to at most ${PLAN_SCHEMA.properties.rationale.maxLength} characters (two or three sentences).`,
    `Catalogue SKUs you may buy: ${skus.join(', ')}. Design something that is NOT one of these known baseline scenarios: ${avoid.join('; ') || 'none'}.`,
    `Respond with ONE JSON object: ${describe(PLAN_SCHEMA)}.`,
  ].join('\n');
  let retry = '';
  if (feedback && revise) {
    const prior = previous ? JSON.stringify(previous).slice(0, MAX_REVISION_CHARS) : null;
    retry = [
      '\nYOUR PREVIOUS PROPOSAL FAILED VALIDATION:', `- ${feedback.join('\n- ')}`,
      prior ? `YOUR PREVIOUS PROPOSAL (for correction):\n${prior}` : '',
      'Keep the same attack idea if it is sound: fix exactly these problems and return the corrected JSON object.',
    ].filter(Boolean).join('\n');
  } else if (feedback) {
    retry = `\nYOUR PREVIOUS PROPOSAL WAS NOT ACCEPTED:\n- ${feedback.join('\n- ')}\nPropose a different, valid, non-duplicate sequence.`;
  }
  const user = [
    `App: ${app.id}.`,
    'KNOWN DETERMINISTIC FINDINGS so far:', JSON.stringify((findings ?? []).map((f) => ({ scenario: f.scenario, outcome: f.outcome, targets: f.targets, reproduced: f.reproduced }))),
    `\nSOURCE (for grounding, cite nothing — just design a realistic sequence${commentsRedacted ? '; comments have been removed, line numbers are unchanged' : ''}):`, sourcesForPrompt(sources),
    retry,
  ].join('\n');
  return { system, user };
}

module.exports = { PLAN_SCHEMA, LIMITS, STEP_FIELDS, REF_MAX_LENGTH, REFUND_AMOUNTS, validatePlan, fingerprint, resemblesKnown, compileAttack, plannerPrompt, EVENTS, AMOUNTS, SIGNING };
