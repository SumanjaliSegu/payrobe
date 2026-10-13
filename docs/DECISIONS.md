# Design decisions

Each entry: the decision, why, and what it costs.

## D1. Built-in `node:sqlite` instead of `better-sqlite3` (2026-10-13)
- **Why:** no native compilation, so `npm install` works on Windows without build tools. Express is the only dependency.
- **Cost:** `node:sqlite` is marked experimental and prints a warning; the npm scripts pass
  `--disable-warning=ExperimentalWarning`. Requires Node ≥ 22.13 (developed on 24.11).

## D2. In the reference app, the signed `payment.captured` webhook is the source of truth for "paid"
- **Why:** the checkout callback comes through the customer's browser, and its signature does not cover the amount.
  The webhook carries the captured amount, so the amount can be checked against the server-side order.
- **Cost:** the order shows `created` until the webhook arrives. A production app would also poll the
  Payments API if the webhook is late. Not modelled yet.

## D3. Concurrency model: one Node process, races at `await` points
- Node runs handlers on one thread, so two requests can interleave only where a handler awaits.
  The vulnerable app has realistic awaits (warehouse call, gateway refund call) between check and write.
  The reference app does every check-and-write inside one synchronous SQLite transaction with no await.
- Tests create real concurrency by firing simultaneous HTTP requests at a live server.
- **Cost:** this does not model several app processes sharing one database. Add a multi-process mode later
  if a target app is deployed that way.

## D4. Tests assert on database state, never on HTTP status alone
- A 200 response proves nothing about orders, payments, fulfilments or stock. Every test reads the DB.

## D5. No credentials and no network in Phase 1
- `merchant/gateway/mock.js` stands in for the Razorpay Orders/Refunds APIs; `harness/mock-razorpay.js` builds and
  signs Razorpay-shaped events. Built-in dummy secrets are used when no `.env` exists.
- The config refuses `rzp_live_*` keys. Servers bind to `127.0.0.1` only.
- **Nothing in this repo has talked to Razorpay.** Event shapes follow the public docs but are not validated
  against real test-mode deliveries yet.

## D6. The vulnerable fixture carries no comments describing its bugs
- The answer key is `docs/SEEDED_BUGS.md`. This keeps the code realistic and avoids leaking answers to an LLM later.

## D7. The two fixtures share a schema shape; the agent must be evaluated on a different app
- Reference and vulnerable use the same table names, which makes Phase 2–3 invariant checks simple.
- **Consequence:** these two apps can validate the *harness*, but cannot validate *autonomous discovery*.
  Phase 4 needs a separately written merchant app (different names, structure and ideally a different author or
  coding agent) that the agent has never seen. Any claim of autonomy must come from that app.

## D8. Python deferred
- Nothing so far needs it. Revisit in Phase 4 only if the agent tooling is materially better in Python.

## D9. A harness-side gateway ledger is the evidence for payment facts (Phase 2)
- **Why:** the merchant database is the system under test. Its `payments` rows are the app's own claims and can be
  written from forged or unverified input. "Verified captured payment" must come from what the gateway did.
- **How:** `harness/ledger.js` is written only by the mock gateway (orders, refunds) and by `genuinePaymentEvent`
  (payments). Forged events are built with `paymentEvent` and never enter the ledger.
- **Cost:** tests must declare which events are genuine. Getting that wrong would corrupt the evidence.

## D10. Explicit mappings, written by hand for now
- `harness/mappings/{reference,vulnerable}.js` map normalized fields to tables and columns, plus the status
  values meaning paid, captured, and not-counted refunds. Both are labelled `provenance: 'hand-written'`.
- They validate the checker, not discovery. Phase 4 must produce this file for an unseen app.

## D11. Three result states; missing evidence is never a pass
- `pass`, `violation`, `cannot_verify`. Violations dominate: a check reports what it found even if another part
  could not be verified. A pass with nothing in scope is marked `vacuous`.

## D12. History by snapshots, not database triggers
- I4 needs history. Ordered snapshots provide it without changing the target database.
- **Cost:** a transition that happens and reverts inside one step is invisible. Triggers that log transitions
  would see it but modify the target; reconsider in Phase 3 if snapshots prove too coarse.

## D13. Refund behaviour of the mock gateway left unchanged pending a decision
- The docs establish that a single refund above the captured amount, and a refund on a fully refunded payment,
  are rejected; they do not establish a cumulative cap. The mock still accepts every refund. Details and the
  proposed change: docs/GATEWAY_CONTRACT.md.
