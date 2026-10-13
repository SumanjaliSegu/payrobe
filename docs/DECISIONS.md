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
