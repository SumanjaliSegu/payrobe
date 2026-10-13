# TODO

## Phase 1: plan and initialise (done 2026-10-13)
- [x] New folder `payprobe/`; nothing outside it touched
- [x] Express + built-in SQLite; no native deps (D1)
- [x] Reference merchant app (webhook-authoritative, atomic transactions)
- [x] Vulnerable merchant app with seeded bugs B1–B6 (answer key: docs/SEEDED_BUGS.md)
- [x] Mock gateway + Razorpay-shaped event builder and signer
- [x] Smoke tests for both apps (8 passing), live-key guard
- [x] README, DECISIONS, ARCHITECTURE

## Phase 2: executable invariants (next)
- [ ] `harness/invariants.js`: I1–I5 as pure functions over a DB snapshot, returning violations with evidence rows
- [ ] Unit tests for the checker itself on hand-built bad DB states (does it catch violations, and stay quiet on good states?)
- [ ] Snapshot helper: capture orders/payments/fulfilments/refunds/stock before and after a sequence

## Phase 3: prove the core idea
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
