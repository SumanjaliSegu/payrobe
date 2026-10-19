# Architecture

## Phase 1 (built)

```
                 +------------------------------+
  tests  ------> | harness/mock-razorpay.js     |  builds + signs Razorpay-shaped events
 (node:test)     +------------------------------+
     |                       | HTTP (loopback)
     |                       v
     |           +------------------------------+      +----------------------+
     |           | merchant app (Express)       | ---> | gateway/mock.js      |
     |           |  reference/  or  vulnerable/ |      | fake Orders/Refunds  |
     |           +------------------------------+      +----------------------+
     |                       |
     +--- reads state -----> SQLite (orders, payments, fulfillments, refunds, products)
```

Merchant endpoints (both implementations):

| Endpoint | Purpose |
|----------|---------|
| `POST /api/orders` `{sku, quantity}` | Server computes the amount, creates a (mock) Razorpay order |
| `POST /api/payments/verify` | Checkout success callback with `razorpay_payment_id` + `razorpay_signature` |
| `POST /webhooks/razorpay` | `payment.authorized/captured/failed`, `refund.processed/failed` |
| `POST /api/orders/:id/refunds` `{amount}` | Merchant-initiated refund (no auth: local fixture) |

## Phase 2 (built): independent invariant checker

```
 simulator actions ──> harness/ledger.js        independent record: gateway orders, payment status
 (mock gateway,                                 history, refunds. Never written by the merchant app.
  genuinePaymentEvent)
 merchant DB ──read-only──> harness/snapshot.js  normalized view through an explicit mapping
                            harness/mappings/*   (hand-written for the two fixtures)
 snapshots[] + ledger ────> harness/invariants.js  pass | violation | cannot_verify per invariant
```

- **Ledger, not merchant rows, is the evidence** for "verified captured payment". A merchant's `payments`
  table is the system under test's own claim.
- **Snapshots** issue only SELECTs inside a rolled-back read transaction, refuse to read mid-transaction,
  and list every unmapped or absent field in `missing`.
- **Three result states.** Missing evidence yields `cannot_verify`, never `pass`. A pass with nothing in
  scope is marked `vacuous`.

## Business invariants

Checked against the database, never against HTTP responses.

| ID | Invariant | Evidence used | Without it |
|----|-----------|---------------|------------|
| I1 | A paid order has a captured gateway payment for that same order | last snapshot + ledger | cannot_verify |
| I2 | That payment's amount and currency equal the order's; the order amount equals what was registered with the gateway | last snapshot + ledger | cannot_verify |
| I3 | At most one fulfilment per order; fulfilment only for paid orders; stock decreases once per newly fulfilled order | last snapshot; stock part needs a baseline snapshot | stock part cannot_verify |
| I4 | A validly paid order never leaves paid; a captured payment record never regresses | ordered snapshots + ledger | cannot_verify from one snapshot |
| I5 | Non-failed refunds per payment ≤ captured amount (merchant records and simulated gateway) | last snapshot + ledger | cannot_verify |
| I6 | I1–I5 hold under verified-concurrent processing | the run's overlap evidence + the I1–I5 results | cannot_verify without proven overlap, or if any in-scope I1–I5 is cannot_verify |

Known limits: I4 sees only snapshot boundaries, so transitions inside one step are invisible. I3's stock
check assumes only fulfilment changes stock between snapshots. Simulator refund behaviour differs from
documented Razorpay behaviour: see GATEWAY_CONTRACT.md.

## Phase 4 groundwork (built): mapping v2 and validator

- `harness/mapping-v2.js`: schema (launch, routes, orders/payments/fulfillments/refunds/stock), shape check,
  projection to the v1 mapping. `harness/mappings/v2/`: hand-written v2 mappings with file:line evidence.
- `harness/validator.js`: evidence check (inside the root, line exists, mentions the identifier; denied files
  are never read), one normal purchase through the mapped routes with snapshots and raw table digests,
  per-entry status, verdict `validated` / `rejected` / `insufficient` / `malformed`, and a negative-control
  result reported separately from the verdict. See D14.

## Phase 3 (built): scenario runner

```
 validator report ──freezeValidation──> frozen mapping + routes (with validation status)
 scenario (harness/scenarios/*) ──> harness/runner.js ──per repetition──> startTarget() (fresh app, run DB, ledger)
                                     ctx.step / createOrder / genuine / webhook / post / deliverTwice
                                     snapshots per step ──> invariants.js ──> outcome ──> redacted run record
                                     teardown in finally ──> cleanup result in the record
```

See D17. Outcomes: error / inconclusive / violation / clean; inconclusive is never counted as clean.

## Phase D/E (built): autonomous investigator

```
 app source dir ──> harness/discovery.js ──> v2 mapping hypothesis (tables, columns, routes, status
   (schema + routes, general heuristics)        vocabularies) with file:line evidence; no answer key
         │
         v
 harness/investigator.js  (bounded staged pipeline; deterministic, optional LLM narration hook)
   inspect → map → validate-safety ─(harness/validator.js: +/- controls)→ stop if not validated
           → select (confirmed entries) → execute (harness/runner.js, isolated runs)
           → compare/classify (invariants.js + ledger) → regressions (artifact) → redacted report
         │
         v
 bin/payprobe-investigate.js  (CLI: pick a local app, run, export JSON/Markdown)
```

The investigator reuses the validator, runner and invariants unchanged; discovery and orchestration are the
new parts. Deterministic code enforces all safety; an LLM, if supplied, may only narrate or propose
hypotheses the validator must still confirm. Evaluated for genuine discovery on `merchant/unseen` (D20).
See D18 (discovery), D19 (investigator). Everything stays local: isolated apps, mock gateway, no network.

## Planned (not built)

- **Phase 3:** generated regression tests per reviewed finding; concurrency scenarios through the runner.
- **Phase 4:** an investigation agent that must *discover* the mapping (where orders, payments and fulfilments live,
  which routes do what) in an unseen app, validate it with a positive control, and stop when it cannot.
  The checker already runs through a mapping, so a discovered mapping can replace the hand-written ones.
