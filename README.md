# PayProbe

PayProbe looks for business-state bugs in payment integrations: orders marked paid without a real payment,
wrong amounts accepted, double fulfilment, paid orders reversed by late events, and over-refunds. It does
this by sending adversarial sequences of payment events and then checking the merchant's **database**,
not its HTTP responses.

## Status (honest)

| Capability | State |
|------------|-------|
| Reference (correct) and vulnerable merchant apps | Built, smoke-tested |
| Independent invariant checker (ledger, mappings, snapshots, I1-I6) | Built, unit-tested. I6 aggregates I1-I5 under verified-concurrent delivery: violation if any I1-I5 breaks under proven overlap, else cannot_verify unless all of I1-I5 are established (informational, never a scenario target) |
| Bug detection | **Four hand-written scenarios on two fixture apps** (see below). The vulnerable-app results are recorded only, not yet asserted or reviewed as findings. No claim of general detection accuracy |
| Scenario runner (`harness/runner.js`) | Built: fresh isolated app, database and ledger per repetition, structured run records, inconclusive never counted as clean. Generated regression tests: not built |
| Mapping v2 + validator (evidence + one normal purchase) | Built, tested on both apps with correct and wrong mappings |
| Isolated per-run database and app (`harness/run-db.js`, `startIsolatedMerchant`) | Built; used by the validator, isolated-run, runner and investigator tests. The duplicate-captured scenario stays in-memory |
| Mapping discovery from source (`harness/discovery.js`) | Built: deterministic, evidence-backed, general heuristics; no answer key. Confirmed by the validator on reference, vulnerable and an independently-named **unseen** app |
| Autonomous investigator (`harness/investigator.js`, `bin/payprobe-investigate.js`) | Built: bounded staged pipeline (discover → validate → select → execute → classify → report), deterministic offline mode, optional LLM narration hook, redacted JSON/Markdown reports. See below |
| Real Razorpay integration / test-mode payments | **None.** Everything uses local isolated apps and the mock gateway; no network, no real keys |

### Evidence so far: duplicate `payment.captured` (`test/scenarios/duplicate-captured.test.js`)

One genuine capture is delivered twice with identical bytes, event id and signature, in three modes:
`sequential`, `simultaneous` (both sent at once) and `barrier` (both held inside the server, then released
together; counted as concurrent only when the server confirms both were in flight).

- **Asserted by the test suite:** the reference app shows no I1–I5 violation in any mode, and its barrier
  runs must be verified concurrent. On the vulnerable app, `simultaneous` runs that overlapped at the server
  must show an I3 duplicate-fulfilment violation. The vulnerable `barrier` and `sequential` results are recorded
  but not asserted.
- **Local run records** (`results/`, git-ignored, 34 suite runs between 2026-10-13 and 2026-10-14, made while the
  code was still changing; not a benchmark): vulnerable app duplicated fulfilment in 102/102 `simultaneous` and
  84/84 `barrier` runs, and in 0/102 `sequential` runs. Reference app: 0 duplicate fulfilments in 288 runs.
- **Limits:** reference `simultaneous` runs never overlapped at the server (0/102), so only `barrier` runs
  exercise the reference app's concurrency safety. Everything runs in one Node process against the mock
  gateway with in-memory databases. Multiple app processes sharing a database are not covered.

### Runner scenarios (`test/scenarios/phase3-runner.test.js`, sequential, isolated file-backed runs)

The hand-written v2 mapping is validated on a separate run and frozen; every attack run then uses it.
Both apps receive the same request sequence.

| Scenario | Target | Gateway assumptions |
|----------|--------|---------------------|
| `cross-order-checkout-signature`: a genuine checkout signature for a cheap order is sent to the checkout callback for an expensive order | I1 | [V] checkout fields, signed value and verify-against-stored-order rule; the callback route and body are fixture-specific and **not confirmed** by validation; the replay itself is an inference |
| `captured-amount-mismatch`: a genuine capture whose amount differs from the order | I2 | **[U]**: not established, and documented capture rules point against it for our (non-partial-payment) orders; any result is conditional; to be redesigned or retired |
| `late-failed-attempt`: an earlier attempt's `payment.failed` delivered after a later attempt's capture | I4 | [V] several attempts per order; out-of-order delivery. Sharing one order between attempts is unresolved in the docs; the exact sequence is an inference |

- **Asserted:** on the reference app every run has valid preconditions, a clean outcome with the target
  invariant actually checking something, and a scenario-specific liveness check. On both apps, preconditions
  hold and cleanup succeeds.
- **Recorded only** (local `results/`, git-ignored; snapshot of 13 suite invocations on 2026-10-14, 8 of them
  after the audit fixes): the vulnerable app's target invariant was violated in 39/39 runs of each scenario;
  the reference app was clean in 39/39. No run was inconclusive, errored or failed cleanup. These are not yet reviewed
  findings, and the [U] and inference/fixture qualifications above still apply.

## Autonomous investigator

Given a local merchant app, the investigator discovers its payment flow, validates the discovery against the
running app, runs adversarial scenarios in isolation, and reports reproducible invariant violations:

```powershell
npm run investigate:unseen            # investigate merchant/unseen, write a redacted JSON report
npm run investigate -- --app reference --format md    # Markdown report
npm run investigate -- --app vulnerable --regressions out/regressions   # also emit regression artifacts
```

Pipeline (`harness/investigator.js`), each stage recorded in the report:

1. **inspect** — parse the app's SQLite schema and Express routes from source (`harness/discovery.js`).
2. **map** — propose a v2 mapping with file:line evidence, using general field-name heuristics only. No
   answer key is read; discovery cites only files under the app's own source directory.
3. **validate-safety** — confirm or reject every mapping entry against the running app plus the cited source,
   with a negative control (unsigned/wrong-secret events) and a positive control (`harness/validator.js`).
   If the mapping does not validate, the investigation **stops safely** and runs no attack.
4. **select/plan** — choose scenarios whose required entries the validator confirmed; others are skipped with
   the unmet entries listed.
5. **execute** — run each scenario 3× in a fresh isolated app, database and gateway ledger (`harness/runner.js`).
6. **compare/classify** — the independent ledger and read-only snapshots decide each outcome:
   **violation** (target invariant broken in every repetition with clean cleanup), **clean**, or
   **inconclusive** (preconditions/validation/reproducibility not met). Inconclusive is never counted as clean.
7. **regressions** — for each reproducible violation, emit a standalone regression test **outside** `test/`
   (an artifact to review, not auto-added to the suite).
8. **report** — a redacted JSON or Markdown report with evidence, reproduction instructions and limitations.

Scenarios run through this path: `cross-order-checkout-signature` (I1), `captured-amount-mismatch` (I2, [U]),
`late-failed-attempt` (I4), `duplicate-capture` (I3) and `cumulative-refund-over-capture` (I5). Most run
sequentially; `duplicate-capture` runs in **barrier** mode — the investigator holds both deliveries in the
server and releases them together, and counts a concurrency violation only when every repetition both proves
overlap and breaks I3 (so a non-overlapping run can never be a finding). Each scenario runs in a mode it
declares. I6 is reported (not targeted): on a barrier run it is a violation if any I1–I5 breaks under proven
overlap, else cannot_verify unless every I1–I5 is established.

The refund scenario (`cumulative-refund-over-capture`, I5) issues two refunds each equal to the captured
amount; a correct app rejects the second, a buggy one accepts both. The mock gateway is unchanged
(Option A); detection uses the independent gateway ledger, and findings are conditional ([U] cumulative cap,
[A] mock accepts cumulative refunds) — never reported as proven real-world money loss. On a correct app this
reads **inconclusive** (no violation; I5 is cannot_verify because refund DB rows are not in the validated
mapping), which is honest, not a false negative. The correct controls (`reference`, `unseen`, `unseen2`)
reject the second refund (409) and keep the ledger refund total within captured. On the **vulnerable** app
both refunds are accepted and the independent ledger shows the refund total exceeding captured in 3/3 runs
(I5 `gateway_refunds_exceed_captured`); this is now an asserted test finding, still carrying its [U]/[A]
conditional labels and **not** a claim of proven real-world money loss.

**Genuine-discovery result (local, honest).** Two independently-named apps the discoverer was not tuned to:
- `merchant/unseen` (one planted flaw): discovery validated the mapping from source alone (reading only its
  `app.js`/`schema.sql`); the investigator reproduced the flaw (late `payment.failed` reversing a settled
  order → I4, 3/3) and was clean on every other scenario, including the concurrency one — **zero false
  positives** on its correct behaviours.
- `merchant/unseen2` (independently written, correct; tickets/settlements/grants vocabulary): discovery
  validated, and **all four scenarios were clean**, the concurrency one with proven overlap.

Reproducing the hand-written scenarios on the known vulnerable fixture is **not** used as the discovery
measure. Two small local apps are a sanity check, **not** a generalization claim.

**Models.** The pipeline runs fully deterministically with no model or API key. An optional `llm` adapter may
add narration or propose mapping hypotheses, but deterministic code enforces every safety constraint, executes
the attacks, and decides whether evidence supports a violation — a model can never widen what runs or relax a
check. API keys are never hardcoded; configure them via environment only if you supply an adapter.

**Limitations.** Local isolated apps and the mock gateway only — no real Razorpay, no network, no real money.
Discovery's request/response field names follow a convention the validator confirms (D18); an app that departs
from it leaves those entries `cannot_verify`, not wrong. A clean or inconclusive result is not proof an app is
correct — it is the outcome of the scenarios actually run under their stated contracts. Success on this small
local benchmark does not prove universal detection or real-world exploitability.

## Setup on Windows

1. Install Node.js 22.13 or newer (LTS from https://nodejs.org). Check in PowerShell:
   ```powershell
   node --version
   ```
2. Install dependencies:
   ```powershell
   cd path\to\payprobe    # wherever you cloned or copied the repository
   npm install
   ```
3. Run the tests:
   ```powershell
   npm test
   ```
4. Run a merchant app (each in its own terminal):
   ```powershell
   npm run start:reference    # http://127.0.0.1:3001, data\reference.db
   npm run start:vulnerable   # http://127.0.0.1:3002, data\vulnerable.db
   ```
5. Create an order:
   ```powershell
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3001/api/orders -ContentType 'application/json' -Body '{"sku":"HOODIE","quantity":1}'
   ```

No credentials are needed. Without a `.env`, the apps use built-in dummy secrets and a mock gateway, and
make no network calls. The apps refuse `rzp_live_` keys and listen on `127.0.0.1` only. To reset local
data, stop the servers and delete `data\*.db*`.

## Layout

```
merchant/
  config.js            secrets loading, live-key refusal
  server.js            CLI: start one implementation
  gateway/mock.js      fake Razorpay Orders/Refunds API
  reference/           correct implementation + schema
  vulnerable/          seeded-bug implementation + schema
harness/
  mock-razorpay.js     builds and signs Razorpay-shaped events
  delivery.js          byte-identical repeated webhook delivery: sequential, simultaneous, barrier
  ledger.js            independent record of what the simulated gateway did
  snapshot.js          read-only normalized view of a merchant DB via a mapping
  invariants.js        I1-I6 checks: pass / violation / cannot_verify
  mappings/            hand-written mappings for the two fixture apps (v1; v2 with evidence in mappings/v2/)
  mapping-v2.js        mapping v2 schema, shape check, projection to v1
  validator.js         validates a v2 mapping: cited evidence + one normal purchase
  run-db.js            one fresh SQLite file per run, read-only readers, safe cleanup
  runner.js            scenario runner: isolated runs, run records, outcomes, path redaction
  concurrency.js       classifies whether two deliveries really overlapped at the server
  scenarios/           attack definitions used by the runner
test/                  node:test suites (helpers.js: startMerchant, startIsolatedMerchant, startAttackTarget)
  scenarios/           attack experiments (duplicate-captured; phase3-runner)
results/               local experiment records (git-ignored)
docs/
  ARCHITECTURE.md      components and invariants I1–I6
  DECISIONS.md         design decisions and their costs
  GATEWAY_CONTRACT.md  simulator behaviour vs Razorpay docs (with citations)
  SEEDED_BUGS.md       answer key for the vulnerable app (keep away from the agent)
TODO.md
```

## Warning

`merchant/vulnerable` is deliberately insecure. It exists only as a test target. Do not deploy it.
