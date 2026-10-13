# TODO

## Phase 1: plan and initialise (done 2026-10-13)
- [x] New folder `payprobe/`; nothing outside it touched
- [x] Express + built-in SQLite; no native deps (D1)
- [x] Reference merchant app (webhook-authoritative, atomic transactions)
- [x] Vulnerable merchant app with seeded bugs B1–B6 (answer key: docs/SEEDED_BUGS.md)
- [x] Mock gateway + Razorpay-shaped event builder and signer
- [x] Smoke tests for both apps (8 passing), live-key guard
- [x] README, DECISIONS, ARCHITECTURE

## Phase 2: independent invariant checker (done 2026-10-13, not committed)
- [x] Refund docs checked; findings and simulator contract in docs/GATEWAY_CONTRACT.md
- [x] `harness/ledger.js`: independent gateway record; mock gateway writes to it; refund behaviour unchanged
- [x] `harness/mappings/`: hand-written mappings for both fixtures
- [x] `harness/snapshot.js`: read-only normalized snapshots with explicit `missing`
- [x] `harness/invariants.js`: I1-I5 checks, I6 placeholder, pass / violation / cannot_verify
- [x] Unit tests on hand-built fixtures; snapshot and ledger tests; happy-path integration on both apps
- [ ] Decide: make mock `createRefund` follow documented rejections (GATEWAY_CONTRACT.md, "Proposed change")

## Phase 3: prove the core idea (in progress)
- [x] Experiment 1: duplicate genuine `payment.captured`, sequential + simultaneous, 3 runs each, both apps
      (`test/scenarios/duplicate-captured.test.js`, records in `results/`)
- [x] Barrier delivery mode (`harness/delivery.js`): both requests held in the server's body parser, released
      together; a run counts as concurrent only if the server confirms both arrived and neither finished.
      Reference: 12/12 verified-concurrent runs clean. Vulnerable: 12/12 duplicate fulfilment (4 invocations)
- [ ] Optional: regression assertion for vulnerable + barrier (currently observation only)
- [ ] Not covered: two app processes sharing one DB file (D3)
- [ ] Run I1-I5 after concurrent delivery batches, repeated N times (this is I6)
- [ ] Scenario runner: initial state → exact event sequence → invariant check → finding record
- [ ] Scenarios: forged/replayed checkout signature (B1), amount mismatch (B2), concurrent duplicate captured (B3),
      captured then late failed (B4), cumulative and concurrent refunds (B5)
- [ ] Each finding records initial state, event sequence, violated invariant, resulting DB state
- [ ] Each finding reproduced 3/3 runs before it counts
- [ ] Reference app passes every scenario (zero false positives)
- [ ] Emit a standalone regression test per finding
- [ ] Update the Demonstrated column in SEEDED_BUGS.md only for bugs actually shown

## Phase 4: prepare autonomous investigation (design first)
- [ ] Write a separate, unseen merchant app with different names and structure (D7)
- [ ] Design the discovery output: a mapping with per-field confidence and the evidence for each
- [ ] Validation gate: a positive control must be observed as paid through the mapping, else stop
- [ ] Define "stop safely" outcomes (cannot find state, ambiguous mapping, app won't start)

## Later / open
- [ ] Liveness check for B6 (genuine event with non-canonical bytes must still fulfil)
- [ ] Refund idempotency key; ambiguous gateway timeout reconciliation in the reference app
- [ ] Multi-process concurrency mode (D3)
- [ ] Validate event shapes against real Razorpay test-mode deliveries (needs a test account)
- [ ] Rotate the Groq key in `ripple-complete/.env` (outside this repo)
