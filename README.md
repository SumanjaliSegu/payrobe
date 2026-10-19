# PayProbe

**The problem.** A payment integration can answer every webhook with `200 OK` and still corrupt business state:
an order marked paid by a forged or mismatched event, a settled order reopened by a late failure, goods shipped
twice, refunds exceeding what was captured. HTTP-level tests do not see this; the damage is in the database.

**Payment Security Intelligence.** PayProbe finds business-state bugs in payment integrations — orders marked
paid without a real payment, wrong amounts accepted, double fulfilment, paid orders reversed by late events,
over-refunds — by replaying adversarial payment-webhook sequences and checking the merchant's **database**
against an independent gateway ledger, not its HTTP responses.

It has an **AI layer** (Groq) that goes further: it explains each verified finding against the real source,
**proposes a fix** and lets the deterministic harness prove whether the fix works, and it can also **design new
attack sequences** of its own (**experimental, not yet validated**; it has not found a verified bug, see the
results below). The rule throughout is **AI proposes, deterministic code verifies** — a model can never set or
change an invariant verdict, and nothing is called a bug, novel, or fixed without execution evidence.
See [BUILT_WITH_AI.md](BUILT_WITH_AI.md).

> **Scope:** everything runs locally against fixture merchant apps and a **mock Razorpay gateway**. There is no
> live Razorpay integration, no test-mode payments, no payment network traffic and no real money.

```
 Discover ─ Understand ─ Investigate ─ Explain ─ Fix ─ Verify
 (deterministic: discover the payment flow, validate it, attack isolated copies, check I1–I6 vs an
  independent ledger)      ·      (AI: explain findings, propose a patch; design new attacks:
                                   experimental, not yet validated)
 Every AI output is a hypothesis until the harness re-runs it and the invariant checker decides.
```

### Results: verified vs. unverified (local fixtures)

| Claim | Status | Evidence |
|---|---|---|
| **Deterministic benchmark**: the 5 hand-written scenarios reproduce **6 violations** on the two buggy fixtures (`unseen` 1, `vulnerable` 5) and give **0 false positives** on the two correct controls (`reference`, `unseen2`), 3 repetitions each | **Verified, reproducible**, no API key | `npm run bench`; [`benchmark-2026-10-17T05-16-45-636Z.json`](evidence/benchmarks/benchmark-2026-10-17T05-16-45-636Z.json) |
| **AI fix-and-verify** on the `unseen` I4 bug: **10/10** real repair attempts verified by the harness (target 3/3 violated → 0/3, no other scenario changed, original app byte-identical) | **Verified**, for one bug in one fixture | 4 repair runs + 2 × 3 evaluation trials, [`evidence/investigations/`](evidence/MANIFEST.md#ai-investigations-on-merchantunseen-evidenceinvestigations) |
| **AI-designed attack discovery** (`npm run bench:ai`) | **Experimental, not validated** | see below |
| Live Razorpay integration | **Not built** | mock gateway only |

The reports behind these claims are in [`evidence/`](evidence/MANIFEST.md): byte-identical copies of the
originals, which the tools write to the git-ignored `results/` folder. The manifest lists what each file supports.

**AI-designed attacks: not validated.** The model is given only the app's source and an allowlist of mock
events (never the answer key) and proposes new webhook sequences; the deterministic harness validates and runs
them. Three real-Groq benchmark runs exist, and none validates the feature:
- [`benchmark-2026-10-17T05-48-06-963Z.json`](evidence/benchmarks/benchmark-2026-10-17T05-48-06-963Z.json): failed,
  0/24 model calls succeeded; no error detail was recorded.
- [`benchmark-2026-10-17T14-10-50-758Z.json`](evidence/benchmarks/benchmark-2026-10-17T14-10-50-758Z.json): failed,
  0/32 model calls succeeded (86 retries; 8,990 of 9,000 completion tokens were reasoning).
- [`benchmark-2026-10-18T14-16-05-730Z.json`](evidence/benchmarks/benchmark-2026-10-18T14-16-05-730Z.json): 23/24 model calls succeeded, but only 2 of 24 proposals passed
  validation (21 rejected, 1 unparseable). Both ran on buggy apps: 0 violations (1 clean, 1 inconclusive).
  None ran on a control app, so the false-positive rate is **unmeasured**. Rejection reasons were not recorded
  (recording was added afterwards and has not yet been demonstrated by a real run; see
  [benchmark diagnostics](BUILT_WITH_AI.md#benchmark-diagnostics-added-after-the-two-failed-ai-runs)).

No AI-discovered bug is claimed.

### Quick start

```powershell
npm install
npm test                      # full suite; AI tests use mocked model responses only
npm run bench                 # deterministic benchmark, no API key
npm run investigate:unseen    # deterministic investigation of merchant/unseen
npm run ai:mock               # AI pipeline with a scripted mock model, offline, clearly labelled
npm run ai:demo               # optional, real Groq calls: needs GROQ_API_KEY in .env (see BUILT_WITH_AI.md)
```

**Report viewer.** Open `tools\report-viewer.html` in a browser (it is a single local file and makes no network
requests) and load a report JSON: one of the files in `evidence\`, or a report you generated yourself under
`results\`. It labels each report Real AI / Mock AI / Deterministic only.

## Status (honest)

| Capability | State |
|------------|-------|
| Reference (correct) and vulnerable merchant apps | Built, smoke-tested |
| Independent invariant checker (ledger, mappings, snapshots, I1-I6) | Built, unit-tested. I6 aggregates I1-I5 under verified-concurrent delivery: violation if any I1-I5 breaks under proven overlap, else cannot_verify unless all of I1-I5 are established (informational, never a scenario target) |
| Bug detection | **Five hand-written scenarios (I1–I5) on four local fixture apps** (two correct controls, two with seeded flaws; see the results table above). Some vulnerable-app results below are recorded only, not asserted. No claim of general detection accuracy |
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

**Models.** `npm run investigate*` runs fully deterministically with no model or API key. The AI layer
(`npm run ai:demo`, Groq free tier, `harness/ai/`) adds an evidence-grounded analyst, a bounded tool-using
investigation agent, and AI fix-and-verify: a model-proposed patch is applied to a disposable copy and the
deterministic harness re-runs every scenario to decide whether it works. Deterministic code enforces every safety
constraint and decides every verdict; a model can never widen what runs or relax a check. The key lives only in
the git-ignored `.env`. See [BUILT_WITH_AI.md](BUILT_WITH_AI.md).

**Limitations.** Local isolated apps and the mock gateway only — no real Razorpay, no network, no real money.
Discovery's request/response field names follow a convention the validator confirms (D18); an app that departs
from it leaves those entries `cannot_verify`, not wrong. A clean or inconclusive result is not proof an app is
correct — it is the outcome of the scenarios actually run under their stated contracts. Success on this small
local benchmark does not prove universal detection or real-world exploitability.

## Development timeline

The table lists this repository's commits as recorded by Git (author and committer dates are identical; times
are IST, UTC+05:30).

| Commit date | Commit | Milestone |
|---|---|---|
| 2026-10-13 19:41 | `09ae8a7` | Foundation: reference and vulnerable merchant apps, mock gateway, signed event builder, smoke tests |
| 2026-10-13 20:01 | `8744a4b` | Independent invariant checker |
| 2026-10-13 20:56 | `ece4461` | Duplicate-payment concurrency test |
| 2026-10-14 13:36 | `4df3071` | Mapping v2, mapping validator, isolated run databases |
| 2026-10-14 14:19 | `b133c52` | README/TODO reconciled with evidence |
| 2026-10-14 23:56 | `8eb5075` | Autonomous investigator |
| 2026-10-16 21:52 | `436c6ea` | Report viewer UI |
| 2026-10-18 19:11 | `3b96b4a` | AI layer (analyst, agent, AI fix-and-verify, AI attacks), benchmark, report viewer AI section |

What these dates do and do not show:
- **Commit dates are not independent proof** of when the work was done or how many hours it took. They are set
  by the developer's machine, and this repository does not record working hours.
- Work is not always committed the day it is done. The reports in [`evidence/`](evidence/MANIFEST.md) dated
  2026-10-16 (AI repair runs) and 2026-10-17 (AI benchmark runs) show the AI layer already running on those days;
  it was committed in one commit on 2026-10-18. Their timestamps were written by the local machine, so they are
  consistent with these dates but not independent proof of them.
- There are no commits dated 2026-10-15 or 2026-10-17.
- This GitHub repository was created on 2026-10-18 and the existing history was pushed to it then. According
  to the local Git push log, an earlier repository at the same address received the pushes of 2026-10-13 to
  2026-10-16.

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
  unseen/              independently-named app with one planted flaw (discovery evaluation)
  unseen2/             independently-written app intended to be correct (control for discovery/benchmark)
bin/
  payprobe-investigate.js   CLI: deterministic investigation (npm run investigate*)
  payprobe-ai.js            CLI: AI-assisted investigation (npm run ai*)
  payprobe-bench.js         CLI: benchmark (npm run bench, bench:mock, bench:ai)
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
  scenarios/           attack definitions used by the runner (5 hand-written scenarios)
  discovery.js         discovers a payment-flow mapping from source, with file:line evidence
  investigator.js      staged pipeline: discover, validate, select, execute, classify, report
  bench.js             benchmark scoring against app roles (control / has-bugs)
  ai/                  AI layer (see BUILT_WITH_AI.md):
    llm.js             Groq + mock clients, pacing, per-call trace, HTTP diagnostics, circuit breaker
    analyst.js         explains verified findings with checked source citations
    agent.js           bounded tool-using investigation agent
    tools.js           the agent's only actions (approved scenario runs, approved source reads)
    attacks.js         AI attack plans: schema, validator, duplicate fingerprint, compiler (experimental)
    attack-loop.js     proposes, validates and runs AI attack plans (experimental)
    repair.js          AI patch proposal, validation, disposable-copy apply, re-run and judge
    pipeline.js        Discover → Understand → Investigate → Explain → Fix → Verify orchestration
    evidence.js        approved-source loading and citation checks
    schema.js          strict validator for model output
tools/
  report-viewer.html   single-file offline viewer for report JSON (no network requests)
test/                  node:test suites (helpers.js: startMerchant, startIsolatedMerchant, startAttackTarget)
  scenarios/           attack experiments (duplicate-captured; phase3-runner)
results/               local experiment records (git-ignored)
evidence/              copies of the reports behind the README claims (MANIFEST.md lists what each supports)
docs/
  ARCHITECTURE.md      components and invariants I1–I6
  DECISIONS.md         design decisions and their costs
  GATEWAY_CONTRACT.md  simulator behaviour vs Razorpay docs (with citations)
  SEEDED_BUGS.md       answer key for the vulnerable app (keep away from the agent)
TODO.md
```

## Warning

`merchant/vulnerable` is deliberately insecure. It exists only as a test target. Do not deploy it.
