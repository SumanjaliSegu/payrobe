# TODO

## Phase 1: plan and initialise (done 2026-10-13)
- [x] New folder `payprobe/`; nothing outside it touched
- [x] Express + built-in SQLite; no native deps (D1)
- [x] Reference merchant app (webhook-authoritative, atomic transactions)
- [x] Vulnerable merchant app with seeded bugs B1–B6 (answer key: docs/SEEDED_BUGS.md)
- [x] Mock gateway + Razorpay-shaped event builder and signer
- [x] Smoke tests for both apps (8 passing), live-key guard
- [x] README, DECISIONS, ARCHITECTURE

## Phase 2: independent invariant checker (done 2026-10-13, commit 8744a4b)
- [x] Refund docs checked; findings and simulator contract in docs/GATEWAY_CONTRACT.md
- [x] `harness/ledger.js`: independent gateway record; mock gateway writes to it; refund behaviour unchanged
- [x] `harness/mappings/`: hand-written mappings for both fixtures
- [x] `harness/snapshot.js`: read-only normalized snapshots with explicit `missing`
- [x] `harness/invariants.js`: I1-I5 checks, I6 placeholder, pass / violation / cannot_verify
- [x] Unit tests on hand-built fixtures; snapshot and ledger tests; happy-path integration on both apps
- [ ] Decide: make mock `createRefund` follow documented rejections (GATEWAY_CONTRACT.md, "Proposed change")

## Phase 3: prove the core idea (in progress)
- [x] Experiment 1: duplicate genuine `payment.captured`, sequential + simultaneous + barrier, 3 runs each,
      both apps (`test/scenarios/duplicate-captured.test.js`, records in `results/`, git-ignored)
- [x] Barrier delivery mode (`harness/delivery.js`): both requests held in the server's body parser, released
      together; a run counts as concurrent only if the server confirms both arrived and neither finished.
      Local records up to 2026-10-14 (34 suite runs): reference 0/84 barrier runs with duplicate fulfilment, all
      verified concurrent; vulnerable 84/84 barrier and 102/102 simultaneous runs with duplicate fulfilment
- [x] Regression assertion: vulnerable + simultaneous must show I3 duplicate fulfilment when the server confirms overlap
- [ ] Optional: regression assertion for vulnerable + barrier (currently observation only)
- [ ] Reference + simultaneous never overlaps at the server (0/102); only barrier exercises reference concurrency
- [ ] Not covered: two app processes sharing one DB file (D3)
- [ ] Run I1-I5 after concurrent delivery batches, repeated N times (this is I6; checker still returns cannot_verify)
- [x] Scenario runner (`harness/runner.js`, D17): fresh isolated run per repetition, run records with steps, HTTP
      exchanges, snapshots, verdicts, contract labels, concurrency evidence and cleanup; paths redacted
- [x] Runner scenarios (sequential): cross-order checkout signature (B1), captured amount mismatch (B2, [U]),
      late failure of an earlier attempt (B4). Reference asserted clean with liveness checks; vulnerable recorded only
- [x] Runner audit fixes (D17): reproduction accounting, mandatory targets, freshness enforcement, request and
      teardown timeouts, cleanup-aware summaries, signature redaction, replay metadata and provenance, live barrier test
- [ ] Runner audit, not yet addressed: request-equivalence check is structural only; no per-scenario evidence hook
- [ ] Review the vulnerable-app runner results (39/39 per scenario as of 2026-10-14) before adding any regression assertion
- [x] Quote the Standard Checkout, multiple-attempt and webhook-ordering docs in GATEWAY_CONTRACT.md (2026-10-14)
- [x] Update scenario contract labels to match GATEWAY_CONTRACT.md (2026-10-14; `basis` field added, status stays V/U/A):
      checkout fields and signature → [V]; verify route body stays an assumption (fixture-specific);
      several attempts per order and out-of-order delivery → [V]; amount mismatch stays [U]
- [ ] Amount mismatch (B2) is unsupported for the fixtures: documented capture rules point against it for orders
      without `partial_payment`. Decide whether to keep it as a conditional experiment or retire it
- [ ] Candidate, documented: one payment's `payment.failed` followed by its `payment.captured` (late authorisation)
- [ ] Candidate, needs a new fixture: `partial_payment` orders (marked paid while `amount_due` > 0?)
- [ ] Open docs questions (see GATEWAY_CONTRACT.md): amounts under automatic capture; `partial_payment` rules;
      the create-order "maps 1:1 to a payment attempt" note vs `attempts`; real delivery shapes
- [ ] Port duplicate captured (B3) to the runner only after a side-by-side parity run (file-backed concurrency unvalidated)
- [ ] Not modelled: the same payment going from captured to failed (not documented gateway behaviour)
- [ ] Refund scenarios (B5): blocked until the mock gateway refund contract is decided (Phase 2 open item)
- [ ] Each finding records initial state, event sequence, violated invariant, resulting DB state
- [ ] Each finding reproduced 3/3 runs before it counts
- [ ] Reference app passes every scenario (zero false positives)
- [ ] Emit a standalone regression test per finding
- [ ] Update the Demonstrated column in SEEDED_BUGS.md only for bugs actually shown

## Phase 4: autonomous investigation (built 2026-10-14)
- [x] Mapping discovery from source: `harness/discovery.js`, evidence-backed, general heuristics, no answer key (D18)
- [x] Investigator pipeline: `harness/investigator.js` discover→validate→select→execute→classify→report; deterministic,
      bounded, redacted JSON/Markdown reports, optional LLM narration hook, regression artifacts outside test/ (D19)
- [x] CLI: `bin/payprobe-investigate.js` (+ npm run investigate*) selects a local app, runs, exports a report
- [x] Unseen fixture `merchant/unseen/` for genuine-discovery evaluation; hidden finding only in the test (D20)
- [x] Tests: discovery unit tests; investigator e2e (clean control, unseen violation, inconclusive, safe-stop, redaction)
- [x] Define "stop safely": mapping fails to validate → investigation stops, no attack run (D19)
- [x] Concurrency through the investigator: `harness/scenarios/duplicate-capture.js` (barrier), delivery.js gained an
      optional webhookPath so overlap works on any app; violation requires proven overlap + I3 broken (D21)
- [x] Second unseen app `merchant/unseen2/` (independent ticketing vocabulary, correct): validates, zero false
      positives across all four scenarios including concurrency (D20, D22)
- [x] I6 is now a real predicate: I1-I5 under verified-concurrent delivery, informational, never a target (D23)
- [x] B5 refund scenario `cumulative-refund-over-capture` (I5) via the independent ledger; mock unchanged, Option A
      recorded in GATEWAY_CONTRACT (D24). Controls: reference/unseen2 no violation; vulnerable recorded-only
- [x] Vulnerable-app refund detection assertion added after reviewing the independent ledger evidence (both refunds
      accepted, ledger refund sum > captured, I5 gateway_refunds_exceed_captured, 3/3); [U]/[A] labels preserved
- [x] Fixed merchant/unseen's cumulative-refund defect: reversal handler now sums prior non-failed reversals and
      rejects the second (409); it is now a clean refund control alongside reference and unseen2
- [ ] Deferred: concurrent-refund variant; request/response field-name discovery is convention-based (D18);
      a larger/more varied app corpus; Option B (mock enforces documented refund rejections) if a scenario needs it
- [ ] Write a separate, unseen merchant app with different names and structure (D7) — done as merchant/unseen (D20)
- [x] Design the discovery output: mapping v2 with per-entry evidence and confidence (`harness/mapping-v2.js`)
- [x] Validation gate: negative + positive control, per-entry confirmed / contradicted / cannot_verify
      (`harness/validator.js`, D14)
- [x] Isolated per-run database: fresh SQLite file in its own temp directory, separate read-only reader
      with 5 s busy timeout, safe non-recursive cleanup, keep-on-failure (`harness/run-db.js`, D15).
      Validator tests use it; the report records the database in `report.database`
- [x] Isolated attack-run foundation: `startIsolatedMerchant` (test/helpers.js) gives each run a new database,
      ledger and app; teardown closes readers, then the app, then cleans up (D16). Validator tests use it too
- [x] Protocol: validate on one run, freeze the mapping, run each attack via `startIsolatedMerchant`
      (runner scenarios use it; duplicate captured stays in-memory)
- [ ] Launch validation (separate process on a run database); launch entries are evidence-checked only today
- [ ] File-backed concurrency: not validated. Concurrency scenarios still use `:memory:`; moving them needs
      re-running and new baselines
- [ ] Redaction step for local paths before any public benchmark output: done for runner records
      (`redact()` in `harness/runner.js`); validator reports and duplicate-captured records are not redacted
- [ ] Sweep for leftover `payprobe-run-*` directories after a crash (none are swept today)
- [ ] Second fulfilment shape (flag or timestamp column instead of rows)
- [ ] Verify and refund routes: exercised by no validation step yet, so never confirmed
- [ ] Define "stop safely" outcomes (cannot find state, ambiguous mapping, app won't start)

## Later / open
- [ ] Liveness check for B6 (genuine event with non-canonical bytes must still fulfil)
- [ ] Refund idempotency key; ambiguous gateway timeout reconciliation in the reference app
- [ ] Multi-process concurrency mode (D3)
- [ ] Validate event shapes against real Razorpay test-mode deliveries (needs a test account)
- [ ] Rotate the Groq API keys stored in plaintext local `.env` files of other projects (outside this repo;
      owner's action). Checked 2026-10-14: the one project under git has no key in its history, and its remote
      tips match that history. Whether the other, non-git copies were ever shared is not verifiable from here
