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

## D14. Mapping v2 with per-entry evidence, and a validator that trusts behaviour plus citations (2026-10-13)
- `harness/mapping-v2.js` adds launch, routes and state entries; every entry carries `value`, `evidence`
  (file:line) and `confidence`. `harness/validator.js` assigns each entry `confirmed`, `contradicted` or
  `cannot_verify` from one normal purchase and a textual check of the cited lines. The negative control
  (unsigned and wrong-secret captures) runs on a separate order first, so an app that accepts forged events
  is reported as `state_changed` without its effects being blamed on correct entries. Expected values come from the ledger and the harness's own request, not from the app.
- Only confirmed entries reach the v1 projection used by the checker; everything else is null, so checks that
  need it return cannot_verify. A confirmed status-value list is kept whole, never trimmed to observed values.
- The validator drives the apps in-process, so launch entries are evidence-checked only and never confirmed.
  No refund is made, so refund entries are never confirmed and I5 is cannot_verify under a validated mapping.
- **Cost:** the happy path is a premise. An app whose normal purchase is broken cannot be told apart from a
  wrong mapping; it is rejected or left insufficient. Evidence checks are textual: they show a cited line
  mentions the identifier, not that it means what is claimed.

## D15. One run, one fresh SQLite file, read through a separate read-only connection (2026-10-13)
- `harness/run-db.js` creates a unique directory under the OS temp directory per run, and refuses if the
  database file (or its -wal/-shm/-journal side files) already exists. The app creates and initializes the
  file. The harness reads only through readers opened afterwards: read-only, 5 s busy timeout, tracked so
  they can be closed before the app stops.
- Cleanup is never recursive. It deletes the database file and SQLite side files (with retries, for
  Windows locks), then removes the directory only if it is empty. An unexpected file, or a path that is no
  longer the directory the run created, stops cleanup and is reported; nothing unrelated is deleted.
  `cleanup({ keep: true })` keeps a failed run's directory for debugging (the validator tests use it when
  `PAYPROBE_KEEP_FAILED_RUNS=1`).
- The validator report gains `database`: caller-supplied metadata (run id, path, directory, file name,
  creation time, `existedBefore: false`, reader settings). The validator does not re-check it. The path is
  local and absolute and must be redacted before any public-facing output.
- `startMerchant` takes an optional `dbPath`; the default stays `:memory:`. The concurrency scenarios are
  unchanged and still in-memory; file-backed concurrency behaviour has not been validated.
- **Cost:** readers depend on the app keeping the database open (WAL side files). A read must not hold a
  transaction open, or it sees stale data; `takeSnapshot` and the validator's digest each use one short
  transaction. A crashed process leaves its run directory behind; nothing sweeps them yet.

## D16. Isolated attack runs share one lifecycle helper with validation runs (2026-10-13)
- `startIsolatedMerchant(impl, { role })` in `test/helpers.js` creates, per call, a run database
  (D15), a new gateway ledger and a new app instance, and opens one read-only reader after the app has
  initialized the database. Nothing is reused between calls, so an attack run can never see the database or
  ledger the mapping was validated on. `role` ('validation' | 'attack') is recorded, not enforced.
- `teardown({ failed })` closes readers, then the app, then cleans up; it is idempotent. A failed run is kept
  only when `PAYPROBE_KEEP_FAILED_RUNS=1`.
- It lives in `test/helpers.js` because it starts the fixture apps in-process; harness modules do not import
  `merchant/`. The separate-process runner will need its own equivalent.
- The existing scenarios, including the concurrency ones, still call `startMerchant` with its `:memory:`
  default and are unchanged. No attack uses isolated runs yet. (Superseded for runner scenarios by D17,
  which use isolated runs; duplicate-captured is still in-memory.)
- **Cost:** file-backed runs are slower than in-memory ones and depend on disk speed (see D15).

## D17. Scenario runner: one attack, fresh isolated run per repetition, inconclusive never clean (2026-10-14)
- `harness/runner.js` runs a scenario `{ id, modes, targets, contract, play(ctx), preconditions? }` N times.
  Each repetition gets its own app, run database and ledger from a caller-supplied `startTarget`
  (`startAttackTarget` in `test/helpers.js`); the harness still never imports `merchant/`. Teardown runs in
  `finally`, and its result is recorded; tests fail a run whose cleanup did not succeed.
- Mapping and routes come from a validator report (`freezeValidation`). A route the validator never exercised
  keeps `cannot_verify` in every record, even when the scenario's requests reach it.
- Scenarios never see which app they attack, so both apps receive the same request sequence (asserted).
- Outcome: `error`, else `inconclusive` (generic or scenario precondition failed, requested concurrency not
  verified, or a target invariant `cannot_verify` / vacuous), else `violation` (any of I1-I5), else `clean`.
- Every scenario carries gateway-contract labels, copied into each record: `status` [V]/[U]/[A] (the only values
  the runner accepts) plus a `basis` ('documented', 'fixture-specific', 'inference', 'unresolved',
  'not-established') matching the classes in docs/GATEWAY_CONTRACT.md. `conditionalOn` lists the non-[V] ones. Records hold no absolute local paths (`redact()`), only the run id and file name.
- `harness/concurrency.js` copies the classification inlined in `duplicate-captured.test.js`, which is left
  unchanged so its baseline does not move. The two must be kept in step until that scenario is ported.
- Vulnerable-app outcomes are recorded, not asserted, until reproduced results are reviewed.
- Audit fixes (2026-10-14, record schema `payprobe.run/v2`):
  - Scenarios must name at least one target invariant; `judge()` also refuses `clean` without one.
  - Freshness is enforced: a run id or ledger object already seen in this process, or a non-empty ledger, is
    an `error` (stage `freshness`); mapped orders, payments, fulfilments or refunds already in the database,
    or a failed scenario `initialState()`, make the run `inconclusive` and the attack is not played. The
    runner still tears down every target it was given.
  - HTTP requests time out (default 10 s); a timeout is recorded on the exchange and ends the run as `error`.
    Duplicate deliveries and teardown are bounded too; a teardown timeout is a cleanup failure.
  - `countedAs` is the outcome, or `cleanup_failed` when teardown did not succeed. Summaries count by it:
    `reproduced` counts only `violation` runs that hit a target; inconclusive or cleanup-failed runs that also
    hit a target are reported separately.
  - Records mask values under keys naming signatures, secrets, tokens, authorization or passwords, and mask the
    target's secrets and every signature the runner computed wherever they appear. JSON request bodies are kept
    as objects; webhook bodies are kept as text, so a delivery can be re-signed and re-sent.
    `derivedSignatures` says how each masked checkout signature was computed.
  - `provenance` holds the frozen mapping projection and its verdict, the git commit, a dirty flag, the
    repository-relative changed files and a SHA-256 of the uncommitted content.
- **Cost:** scenarios are hand-written by someone who knows the fixtures, so they test the harness, not
  discovery (D7). Contract claims were checked against the Razorpay docs on 2026-10-14 (GATEWAY_CONTRACT.md), not
  against real deliveries; inference, fixture-specific, unresolved and [U] claims remain. Only sequential runner
  scenarios exist.
  The generic initial-state check assumes a target starts with no orders; an app with seeded orders would
  always be inconclusive. Timed-out duplicate deliveries leave their requests to teardown, because
  `delivery.js` (unchanged) has no timeout for sequential or simultaneous sends.

## D18. Deterministic mapping discovery from source (2026-10-14)
- `harness/discovery.js` proposes a v2 mapping for an app from its SOURCE alone: it parses `CREATE TABLE`
  statements (SQLite columns, with comments stripped so comma-in-comment does not corrupt parsing) and
  Express `app.<method>('<path>')` routes, then maps normalized entities/fields by general heuristics
  (a status column, a gateway-order reference, a stock column, a reference to the payments table, standard
  e-commerce route nouns) — never by fixed fixture names and never by reading an answer key.
- Every entry carries file:line evidence. Status vocabularies come from a CHECK constraint when present,
  else a priority-ordered scan of quoted JS literals (so `captured` wins over `paid` for payments although
  both tables name the column `status`); such values are 'medium' confidence so the validator can confirm
  them by behaviour rather than treat them as ambiguous.
- Request/response field names (the create-order body and response keys) are a CONVENTION the discoverer
  assumes and the validator then confirms; they are not parsed from source. An app that departs from the
  convention leaves those entries `cannot_verify`, never wrong. This is the main discovery limitation.
- Whatever discovery proposes is only a hypothesis: `harness/validator.js` confirms or rejects each entry
  against behaviour + cited source, and only confirmed entries drive the checker, so a wrong guess yields
  `cannot_verify`, never a false finding. On reference and vulnerable the discovered mapping matches the
  hand-written v1 projection; on the unseen app it validates with zero contradictions.
- **Cost:** heuristics can miss a column (e.g. a paid-payment link named without "paid"/"payment"); the
  checker tolerates this where it can (I1 falls back to gateway-order-id) or returns `cannot_verify`.

## D19. Autonomous investigator: bounded staged pipeline, deterministic safety (2026-10-14)
- `harness/investigator.js` orchestrates discover → map → validate-safety → select → plan → execute →
  compare → classify → regressions → report. It reuses the validator, runner and invariants unchanged.
- It is given only `{ id, impl, sourceRoot }` and the scenario catalogue — never a list of an app's bugs.
  Scenario SELECTION is driven solely by which entries the validator confirmed (`scenario.requires`), not
  by any knowledge of what is wrong. The validator's `root` is the app's own source dir, so it structurally
  cannot cite or read anything outside it (the answer key included), and the deny-list names it anyway.
- Safety is deterministic: timeouts, freshness, isolation and the violation decision all live in code
  (runner/validator). An optional `llm` adapter may only narrate findings or propose hypotheses; it cannot
  widen what runs, relax validation, or decide a violation. Default is a deterministic null-object LLM, so
  the pipeline runs with no model and no API key; keys are never hardcoded.
- A finding is a `violation` only when the target invariant is reproduced in every repetition with clean
  cleanup; otherwise `clean` or `inconclusive`, with reasons. If the mapping does not validate, the
  investigation stops and runs no attack. Reports are redacted (reuse `runner.redact`) to JSON or Markdown.
- Generated regression tests are written OUTSIDE `test/` (an artifact), so they are not added to the suite
  until a human reviews them — consistent with the rule that vulnerable-app detection assertions wait for
  review.
- **Cost:** only sequential scenarios run through it today; concurrency scenarios stay in their own test.
  The discovery limitation in D18 applies.

## D20. Unseen fixture for genuine-discovery evaluation (2026-10-14)
- `merchant/unseen/` is an independently-structured merchant app with different table names (`baskets`,
  `charges`, `shipments`, `reversals`, `catalog`), column names (`gw_order_ref`, `amount_minor`, `state`,
  `settled_charge`, `available_units`), status vocabularies (`open`/`settled`, `captured`) and route paths
  (`/api/v2/baskets`, `/hooks/pg`, `/api/v2/charge-callback`). It carries no comment describing its
  behaviour, and its one expected finding is asserted only in `test/investigator.test.js`, never in the
  source and never given to the investigator.
- It exists to measure discovery on names the heuristics were not tuned to: the investigator validates a
  mapping from its source alone, finds its single planted flaw (a late `payment.failed` reversing a settled
  basket → I4) 3/3, and is clean on the two behaviours it implements correctly (cross-order signature and
  amount mismatch). This is the discovery measure; reproducing scenarios on the known vulnerable fixture is
  not.
- **Cost:** one small local benchmark. It demonstrates the method end to end; it does not prove universal
  detection or real-world exploitability. It still follows the request/response convention (D18).

## D21. Concurrency scenarios through the investigator (2026-10-14)
- `harness/scenarios/duplicate-capture.js` is the runner-driven counterpart of the original in-memory
  experiment in `test/scenarios/duplicate-captured.test.js`, which is left unchanged as the baseline. It
  declares `modes: ['barrier', 'simultaneous']` and target I3; the investigator runs each scenario in a mode
  it declares (sequential scenarios stay sequential), so one catalogue mixes sequential and concurrent attacks.
- `harness/delivery.js` gained an optional `webhookPath` (default `/webhooks/razorpay`), threaded through
  `sendPrepared`/`openHeldRequest`/`deliverTwiceWithBarrier`/`deliverTwice`, so concurrency can target an
  app whose webhook path differs (e.g. the unseen apps). The default keeps the original test byte-for-byte.
  The runner's `ctx.deliverTwice` now uses the mapped webhook path instead of a hardcoded one.
- A concurrency result is a violation only when every repetition is verified-concurrent (both requests proven
  to overlap at the server) AND the target invariant is broken with clean cleanup; otherwise it is
  inconclusive. The investigator records `finding.concurrency` = verified | not_verified | not_applicable.
- Verified on reference (clean), vulnerable (I3 duplicate_fulfilment, 3/3) and both unseen apps (clean), all
  with barrier overlap proven 3/3.

## D22. Discovery heuristics broadened for a second unseen app (2026-10-14)
- Adding `merchant/unseen2` (D20) surfaced general vocabulary the heuristics had missed: a status column named
  `phase` (now `isStatus` also matches phase/stage/lifecycle), a paid state named `fulfilled` (added to the
  paid vocabulary), and a currency column named `iso_curr` (currency now matches any `curr` substring).
  These are general payment/e-commerce words, not fixture-specific names. All four apps still validate with
  zero contradictions, and the correct apps read as clean rather than inconclusive.
- This is the expected shape of heuristic discovery: each genuinely new app may reveal a naming the rules did
  not cover; the validator keeps every such gap safe (cannot_verify, never a false finding) until the rule is
  generalised. It is not evidence of broad generalization from a handful of apps (D20).

## D23. I6 made a real predicate: I1-I5 under verified concurrency (2026-10-14)
- `checkConcurrency(concurrency, results)` in `harness/invariants.js` is no longer a permanent cannot_verify.
  It aggregates the already-computed I1-I5 `results` under the run's `concurrency` evidence (from the runner /
  `harness/concurrency.js`). `checkAll({ snapshots, ledger, concurrency })` takes `concurrency` optionally and
  passes the I1-I5 results into I6; omitted (every non-concurrent caller and unit test) keeps I6 cannot_verify.
- Result: `cannot_verify` when there is no concurrency evidence, the run was not concurrent, overlap was not
  verified, or any in-scope I1-I5 is itself cannot_verify (so we never claim they hold on missing evidence);
  `violation` when overlap is verified and some I1-I5 is violated (I6 names the underlying invariant and
  kinds); `pass` only when overlap is verified and every I1-I5 passed.
- I6 is informational, never a scenario target: `STATE_INVARIANTS` stays I1-I5, the runner still rejects
  non-I1-I5 targets, and the deterministic violation / reproduced-count decisions are unchanged. I6 only adds
  a line to `verdicts`.
- **Cost / honest consequence:** on a clean concurrent run I6 reads cannot_verify (not pass), because I5
  (refunds) is cannot_verify under a validated mapping when nothing was refunded — we genuinely cannot assert
  all of I1-I5 hold under concurrency without exercising refunds. The pass path is covered by a unit test with
  all-pass results; in practice a barrier run shows I6 violation (vulnerable) or cannot_verify (correct apps).

## D24. B5 refund scenario via the independent ledger; mock unchanged (Option A) (2026-10-14)
- `harness/scenarios/cumulative-refund-over-capture.js` issues two refunds through the merchant refund route,
  each equal to the captured amount (each within the single-refund cap; cumulatively double). Target I5.
- The mock gateway is unchanged (GATEWAY_CONTRACT "Decision (2026-10-14): Option A"). Detection rests on
  `gateway_refunds_exceed_captured` from `harness/ledger.js` (independent evidence), because the validator
  never refunds, so refund DB-mapping entries are never behaviour-confirmed and the frozen mapping has
  `refunds === null` (verified empirically before finalising). The merchant-records branch is therefore not
  the detector here.
- Each individual refund equals (not exceeds) the captured amount, so the single-over-cap simulator artefact
  the contract warns about is avoided; the cumulative sum is the defect. Findings are labelled [V] (single
  over-cap rejected), [U] (cumulative cap undocumented), [A] (mock accepts cumulative refunds) and are not
  reported as proven real-world money loss.
- Controls: a correct app rejects the second refund (409), its ledger sum stays within captured, and I5 is
  not a violation; because refunds are unmapped, the correct-app outcome is `inconclusive` (I5 cannot_verify),
  never a false violation. `reference`, `unseen` and `unseen2` are the correct controls.
- **Update (2026-10-14, after review):** the vulnerable-app finding is now an **asserted** regression. The
  evidence was reviewed independently of the merchant's own records: both refunds accepted (201/201), the
  gateway ledger (`harness/ledger.js`) records a refund total of 2x the captured amount for the payment, and
  I5 reports `gateway_refunds_exceed_captured` in 3/3 runs with clean cleanup and passing preconditions. The
  [U]/[A] labels are preserved and it is not presented as proven real-world money loss.
- **Fixture correction (2026-10-14):** `merchant/unseen` originally had an unplanned cumulative-refund defect
  (its reversal handler capped each refund individually but did not track the cumulative total). The
  investigator found it — a real defect, not a false positive. It is now fixed with the smallest change: the
  handler sums prior non-failed reversals for the charge and rejects when the cumulative total would exceed
  the captured amount (the reference app's pattern), inside the existing transaction. `merchant/unseen` is now
  a clean refund control, and its I4 behaviour and everything else are unchanged.
- Concurrent refunds (the vulnerable cap also spans an await) are deferred to a later scenario.
