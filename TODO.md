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
- [ ] Scenario runner: initial state → exact event sequence → invariant check → finding record
      (design approved 2026-10-14; not yet implemented)
- [ ] Scenarios: forged/replayed checkout signature (B1), amount mismatch (B2), concurrent duplicate captured (B3,
      covered by experiment 1, not yet ported to the runner), captured then late failed (B4)
- [ ] Refund scenarios (B5): blocked until the mock gateway refund contract is decided (Phase 2 open item)
- [ ] Each finding records initial state, event sequence, violated invariant, resulting DB state
- [ ] Each finding reproduced 3/3 runs before it counts
- [ ] Reference app passes every scenario (zero false positives)
- [ ] Emit a standalone regression test per finding
- [ ] Update the Demonstrated column in SEEDED_BUGS.md only for bugs actually shown

## Phase 4: prepare autonomous investigation (design first)
- [ ] Write a separate, unseen merchant app with different names and structure (D7)
- [x] Design the discovery output: mapping v2 with per-entry evidence and confidence (`harness/mapping-v2.js`)
- [x] Validation gate: negative + positive control, per-entry confirmed / contradicted / cannot_verify
      (`harness/validator.js`, D14)
- [x] Isolated per-run database: fresh SQLite file in its own temp directory, separate read-only reader
      with 5 s busy timeout, safe non-recursive cleanup, keep-on-failure (`harness/run-db.js`, D15).
      Validator tests use it; the report records the database in `report.database`
- [x] Isolated attack-run foundation: `startIsolatedMerchant` (test/helpers.js) gives each run a new database,
      ledger and app; teardown closes readers, then the app, then cleans up (D16). Validator tests use it too
- [ ] Protocol: validate on one run, freeze the mapping, run each attack via `startIsolatedMerchant`
      (no attack uses it yet; the existing scenarios stay in-memory)
- [ ] Launch validation (separate process on a run database); launch entries are evidence-checked only today
- [ ] File-backed concurrency: not validated. Concurrency scenarios still use `:memory:`; moving them needs
      re-running and new baselines
- [ ] Redaction step for local paths (`report.database.path`, `directory`) before any public benchmark output
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
