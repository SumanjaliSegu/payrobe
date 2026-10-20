# PayProbe

**Finds the payment bugs that `200 OK` hides.** A merchant's webhook handler can return `200 OK` to every
Razorpay event and still record the wrong business outcome: an order marked paid by a forged or mismatched
event, a settled order reopened, goods shipped twice, refunds above what was captured. PayProbe replays
adversarial Razorpay-style event sequences against a merchant app and checks the merchant's **database**
against an independent ledger of what the gateway actually did, not its HTTP responses.

How the parts fit together:
1. **Deterministic harness** discovers the app's payment flow, validates it, and attacks isolated copies 3× each.
2. **AI investigation** explains each verified finding with checked source citations and chooses follow-up runs
   from an allowlist of tools.
3. **AI-assisted repair** proposes a patch, which is applied only to a disposable copy.
4. **Independent verification**: the harness re-runs every scenario and the invariant checker, reading the
   independent ledger and the database, decides whether the bug is gone and nothing else broke.

**AI proposes, deterministic code verifies.** A model can never set or change a verdict; nothing is called a
bug, novel, or fixed without execution evidence.

> **Scope:** everything runs locally against fixture merchant apps and a **mock Razorpay gateway**. There is no
> live Razorpay integration, no test-mode payments, no payment network traffic and no real money.

## In 30 seconds

| | |
|---|---|
| **Problem** | A payment integration can answer every webhook with `200 OK` and still corrupt business state: an order marked paid by a forged or mismatched event, a settled order reopened by a late failure, goods shipped twice, refunds exceeding what was captured. HTTP-level tests do not see this; the damage is in the database. |
| **Approach** | Discover the app's payment flow from source → validate that map against the running app → attack isolated copies 3× each → check six business invariants (I1–I6) against an independent ledger → AI explains and proposes a patch → harness re-runs every scenario to judge it. |
| **Verified result 1** | Deterministic benchmark (saved report): **6 violations** reproduced on the two buggy fixtures, **0 false positives** on the two correct controls (3 repetitions each, no API key). Each control had 4 clean scenarios and 1 inconclusive one (the refund scenario, which cannot be fully verified on a correct app; see below). |
| **Verified result 2** | AI fix-and-verify: **10/10** real repair attempts verified by the harness (4 repair loops whose reports record the target going from 3/3 violated to 0/3, plus 6 evaluation trials recorded as verified with the original app unchanged), **for one bug (I4, late `payment.failed`) in one fixture (`merchant/unseen`)**. Not a claim about other bugs or codebases. |
| **Blind AI attack result** | With no findings, known scenarios or app identity in its prompt, the model proposed the **same** refund-over-capture sequence as the existing hand-written scenario; the harness confirmed the I5 violation (refunds above captured) in **3/3** repetitions. This is a **rediscovery**, not a novel attack or a new bug. |
| **Not validated** | No novel AI-discovered violation. The AI false-positive rate is **unmeasured**: the only AI attack that ran on a control app was inconclusive. Blind sample: 2 attack slots on one buggy app, 1 executed plan on one control. |

```
 Discover ─ Understand ─ Investigate ─ Explain ─ Fix ─ Verify
 (deterministic: discover the payment flow, validate it, attack isolated copies, check I1–I6 vs an
  independent ledger)      ·      (AI: explain findings, propose a patch; design new attacks:
                                   experimental, one blind rediscovery so far)
 Every AI output is a hypothesis until the harness re-runs it and the invariant checker decides.
```

## Try it (no API key needed)

Requires Node.js 22.13 or newer.

```powershell
npm install
npm run bench                 # deterministic benchmark: 5 scenarios × 4 fixture apps, scored vs controls
npm run investigate:unseen    # investigate an app the discoverer was not tuned to; writes a redacted report
npm run ai:mock               # full AI pipeline with a scripted mock model, offline, clearly labelled
npm test                      # full suite; AI tests use mocked model responses only
npm run ai:demo               # optional, real Groq calls: needs GROQ_API_KEY in .env (see BUILT_WITH_AI.md)
npm run bench:ai:blind -- --apps vulnerable --attack-count 2   # optional, real Groq: blind attack evaluation
```

**Report viewer.** Open `tools\report-viewer.html` in a browser (it is a single local file and makes no network
requests) and load a report JSON: one of the files in `evidence\`, or a report you generated yourself under
`results\`. It labels each report Real AI / Mock AI / Deterministic only.

### Results: verified vs. unverified (local fixtures)

| Claim | Status | Evidence |
|---|---|---|
| **Deterministic benchmark**: the 5 hand-written scenarios reproduce **6 violations** on the two buggy fixtures (`unseen` 1, `vulnerable` 5) and give **0 false positives** on the two correct controls (`reference`, `unseen2`), 3 repetitions each | **Verified, reproducible**, no API key | `npm run bench`; [`benchmark-2026-10-17T05-16-45-636Z.json`](evidence/benchmarks/benchmark-2026-10-17T05-16-45-636Z.json) |
| **AI fix-and-verify** on the `unseen` I4 bug: **10/10** real repair attempts verified by the harness. The 4 repair loops record the target going from 3/3 violated to 0/3, no other scenario changed, and the original app byte-identical; the 6 evaluation trials record only that each was verified on its first attempt with the original app unchanged | **Verified**, for one bug in one fixture | 4 repair runs + 2 × 3 evaluation trials, [`evidence/investigations/`](evidence/MANIFEST.md#ai-investigations-on-merchantunseen-evidenceinvestigations) |
| **Blind AI attack design** (`npm run bench:ai:blind`) rediscovered the hand-written refund-over-capture attack on `vulnerable`; I5 violated 3/3 | **Verified rediscovery only.** No novel AI attack or new bug; AI false-positive rate unmeasured | 2 reports in `evidence/benchmarks/`, see [below](#blind-ai-attack-evaluation-2026-10-19) |
| Live Razorpay integration | **Not built** | mock gateway only |

The reports behind these claims are in [`evidence/`](evidence/MANIFEST.md): copies of the originals, which the
tools write to the git-ignored `results/` folder. All are byte-identical except one blind-evaluation report in
which a Groq account identifier was redacted. The manifest lists what each file supports, with hashes.

#### Blind AI attack evaluation (2026-10-19)

In blind mode (`--blind`) the attack designer gets only the general event and refund vocabulary, the SKU list
and the app's source with every comment removed. It is not given the app's name (every app is shown as
`target`), the deterministic findings, or the list of hand-written scenarios. Each plan is validated, run 3× in
isolation, and judged by the invariant checker. A plan whose fingerprint matches a hand-written scenario is
still run but is scored as a **rediscovery**, never as novel. What the prompt contains is checked by automated
tests (`test/ai-blind-prompt.test.js`); the reports record per-call metadata, not prompt text.

| Report | App | What happened |
|---|---|---|
| [`benchmark-2026-10-19T11-56-22-048Z.json`](evidence/benchmarks/benchmark-2026-10-19T11-56-22-048Z.json) | `vulnerable` (has bugs) | 4 model calls, 2 rejected by the validator, 2 executed. **Rediscovery:** create order → genuine full capture → full refund → full refund, the same sequence as `cumulative-refund-over-capture`; I5 `gateway_refunds_exceed_captured` in 3/3. **Novel:** a forged wrong-secret double-amount capture, then the genuine capture: clean in 3/3 |
| [`benchmark-2026-10-19T12-21-38-114Z.redacted.json`](evidence/benchmarks/benchmark-2026-10-19T12-21-38-114Z.redacted.json) (Groq organization ID redacted) | `reference` (control) | 1 plan executed (a forged unsigned double-amount capture): **inconclusive**, because the app rejected the forged event and the targeted checks had nothing to check. The other 2 calls hit Groq's daily token limit |

Both reports have `status: "completed"`. That means the benchmark finished processing the app and saved its
report; it does **not** mean every AI attack slot succeeded (in the reference run, 2 of 3 model calls failed).

The I5 verdict comes from the independent gateway ledger, not the merchant's records. The saved report records
the verdict (`gateway_refunds_exceed_captured`, 3/3) but **no amounts or HTTP responses**. The following values
come from a **later local re-execution** of the recorded plan (no model involved), not from the saved report:
both refunds accepted (`201`, `201`) and ₹998 refunded against ₹499 captured on `vulnerable`; `201` then `409` on
`reference`, staying within the capture. The original reports are unchanged.

Inconclusive is neither clean nor a false positive, so these runs give **no** AI false-positive rate. Two earlier
blind runs that day (`09-10-06-439Z`, `10-04-18-988Z`) gave the model the app's name and source comments, which
hint at whether an app is meant to be correct. That leak was found and fixed before the two runs above. Those
earlier runs are not counted (they produced no violation and were cut short by rate limits), and their reports
are kept locally, not published.

**Earlier AI attack runs (before the blind mode).** The model was given the app's source, the deterministic
findings and an allowlist of mock events (never the answer key). Three real-Groq benchmark runs exist, and
none validates the feature:
- [`benchmark-2026-10-17T05-48-06-963Z.json`](evidence/benchmarks/benchmark-2026-10-17T05-48-06-963Z.json): failed,
  0/24 model calls succeeded; no error detail was recorded.
- [`benchmark-2026-10-17T14-10-50-758Z.json`](evidence/benchmarks/benchmark-2026-10-17T14-10-50-758Z.json): failed,
  0/32 model calls succeeded (86 retries; 8,990 of 9,000 completion tokens were reasoning).
- [`benchmark-2026-10-18T14-16-05-730Z.json`](evidence/benchmarks/benchmark-2026-10-18T14-16-05-730Z.json): 23/24 model calls succeeded, but only 2 of 24 proposals passed
  validation (21 rejected, 1 unparseable). Both ran on buggy apps: 0 violations (1 clean, 1 inconclusive).
  None ran on a control app, so the false-positive rate is **unmeasured**. Rejection reasons were not recorded
  in that run (recording was added afterwards; the 2026-10-19 runs record them, see
  [benchmark diagnostics](BUILT_WITH_AI.md#benchmark-diagnostics-added-after-the-two-failed-ai-runs)).

No novel AI-discovered bug is claimed.

## Why this matters for Razorpay merchants

Every scenario below targets a failure where the merchant's HTTP layer can look healthy while its database
records the wrong business outcome. Each one is checked against an independent ledger of what the (mock)
gateway actually did, never against the merchant's own `payments` table, which is the system under test's
own claim. Invariants are defined in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#business-invariants); the
gateway behaviour each scenario relies on, with Razorpay doc citations, is in
[docs/GATEWAY_CONTRACT.md](docs/GATEWAY_CONTRACT.md).

| Merchant risk | Invariant | Scenario (`harness/scenarios/`) | What PayProbe has shown on local fixtures |
|---|---|---|---|
| **Order marked paid with someone else's payment.** A genuine checkout signature for a cheap order is replayed against an expensive one. | I1 | `cross-order-checkout-signature` | Violated on the vulnerable fixture, clean on the reference app (recorded runs, see [Runner scenarios](#runner-scenarios-testscenariosphase3-runnertestjs-sequential-isolated-file-backed-runs)). The callback route is fixture-specific and the replay is an inference |
| **Goods shipped twice.** The same `payment.captured` webhook is delivered twice, at the same moment. | I3 (and I6 under proven overlap) | `duplicate-capture` | The test suite asserts the duplicate fulfilment on the vulnerable fixture when deliveries overlap at the server, and no violation on the reference app ([details](#evidence-so-far-duplicate-paymentcaptured-testscenariosduplicate-capturedtestjs)) |
| **A paid order reopened.** An earlier attempt's `payment.failed` arrives after a later attempt's capture (out-of-order webhooks). | I4 | `late-failed-attempt` | The one planted flaw in `merchant/unseen`: its payment flow was discovered from source alone, the flaw reproduced 3/3, and every other scenario was clean on that app; also the bug behind the 10/10 verified AI repair attempts |
| **Refunds exceed what was captured.** Two refunds, each equal to the captured amount. | I5 | `cumulative-refund-over-capture` | The independent ledger shows refunds exceeding captured on the vulnerable fixture (3/3, asserted); correct controls reject the second refund. In a blind run the AI attack designer rebuilt this same sequence (a rediscovery). Carries [U]/[A] labels: **not** a claim of proven real-world money loss |
| **Wrong amount accepted.** A genuine capture whose amount differs from the order. | I2 | `captured-amount-mismatch` | Marked **[U]**: Razorpay's documented capture rules point against this for non-partial-payment orders, so any result is conditional; to be redesigned or retired |

Why the design fits payments work:
- **Business state, not status codes.** Tests assert on the database (D4 in [DECISIONS.md](docs/DECISIONS.md)).
- **Missing evidence is never a pass.** Each invariant returns `pass`, `violation` or `cannot_verify`;
  inconclusive runs are never counted as clean.
- **Concurrency is proven, not assumed.** A duplicate-delivery violation counts only when the server confirms
  both deliveries were in flight together.
- **Controls catch false positives.** Two correct apps run every scenario; a violation there is scored as a
  false positive. This caught one in an early AI attack vocabulary (see below).
- **Safe by default.** No credentials needed; the apps refuse `rzp_live_` keys and listen on `127.0.0.1` only.

## How I built PayProbe with AI

I built PayProbe with **Claude Code** as my coding agent, and the product itself uses an LLM (Groq) at runtime.
The same rule governs both: **AI proposes, deterministic code verifies.** Full detail, including every model
call recorded in the reports, is in [BUILT_WITH_AI.md](BUILT_WITH_AI.md).

**Working with Claude Code.** While developing, the agent worked in the repository under rules I set: never read
the seeded-bug answer key (`docs/SEEDED_BUGS.md`), preserve existing behaviour and assertions, leave Git and
publishing to me, and report results honestly. Examples:
- **Evidence-first debugging.** A flaky runner test was not fixed by guessing: the failure was reproduced under
  parallel load (5/20), the cause proved with a dose-response experiment (delay 0/250/400 ms → 1/3, 2/3, 3/3
  failures), then a one-line test-only change was verified with 20 parallel runs and three full-suite runs.
- **Verified UI.** The report viewer was checked in headless Chrome against the source JSON (219 checks), plus
  injection probes, zero network requests and zero console errors.
- **Guardrails tested alongside features.** The AI layer was built mock-first, then against real Groq calls,
  with tests for each guardrail (`test/ai-llm.test.js`, `test/ai-guardrails.test.js`, `test/ai-repair.test.js`).
- **Auditing the evaluation before trusting it.** Before counting any blind result, the agent audited the prompt
  and found that the app's name and source comments revealed whether it was meant to be correct; that was fixed
  and covered by leak tests before the counted runs.

**Runtime AI, and what stops it from lying.**

| AI role | Code | What deterministic code enforces |
|---|---|---|
| Explain a finding | `harness/ai/analyst.js` | Strict output schema; every cited line range must exist in an approved file and is quoted from it; the verdict is copied from the harness, never from the model |
| Investigate | `harness/ai/agent.js`, `tools.js` | Tool allowlist (approved scenario runs and source reads only: no shell, network, writes or code execution); step and run limits; a hypothesis without run evidence is downgraded to "unresolved" |
| Propose a fix | `harness/ai/repair.js` | Patch may edit only `app.js`, cannot touch signature verification or secrets, and cannot add imports, network, fs, eval and similar constructs; applied only to a disposable copy |
| Verify the fix | `harness/ai/repair.js` + `runner.js` | Baseline reproduced first; **fixed** = target scenario clean in every repetition **and** no other scenario regressed; original source hashed before and after |
| Design new attacks (experimental) | `harness/ai/attacks.js`, `attack-loop.js` | Model fills a declarative plan, never code; validator checks every field and the gateway-ledger rules (a refund only after a genuine full capture); outside blind mode, duplicates of hand-written scenarios are rejected; in blind mode they run but are scored as rediscoveries |

**Measured results** (real Groq calls, `openai/gpt-oss-120b`, free tier):
- **10/10** real repair attempts verified (4 repair loops + 6 evaluation trials), **for the I4 late-failure bug
  in `merchant/unseen` only**. Each of the 4 repair loops records the target going from 3/3 violated to 0/3, no
  other scenario changed, and the original app byte-identical. The 6 evaluation trials record only that each
  was verified on its first attempt with the original app unchanged. The accepted patch is in
  [BUILT_WITH_AI.md](BUILT_WITH_AI.md#recorded-results-local-fixture-merchantunseen-real-groq-calls).
- Final demo run: 7 model calls, 26,815 tokens, 0 failures; about 161 s of it was free-tier rate-limit pacing.
- AI-designed attacks: in the counted blind runs, one rediscovery of the hand-written refund attack (I5, 3/3),
  no novel violation, and no conclusive control result (see [blind evaluation](#blind-ai-attack-evaluation-2026-10-19)).

**What went wrong, and what I changed.** The control apps caught a false positive in an early attack
vocabulary: a "forged" event with a *valid* signature is indistinguishable from a genuine one, so it flagged
every app. The fix was to strengthen the guardrail (a forged event must be unsigned or wrong-secret), not to
relax the check. Groq's JSON mode rejected some agent output, so recovery and retry were added. The agent once
concluded from source reading alone, so an evidence gate now sends unevidenced conclusions back. Two AI
benchmark runs failed without recording why, so per-call diagnostics and a circuit breaker were added. A blind
benchmark run was stopped for low memory and lost everything, so reports are now saved after each app.

**Current limitations.**
- The repair loop has one real target. Success there is not a claim about arbitrary codebases.
- AI attack discovery has produced one rediscovery and no novel violation. The blind sample is tiny (2 attack
  slots on one buggy app, 1 executed plan on one control), and Groq's free-tier daily token limit cut runs short.
- The attack vocabulary is small and the prompt defines each invariant, so two full refunds after one capture
  is close to the most obvious I5 test; rebuilding it is weak evidence of attack-design ability.
- On a correct app the refund invariant can only be inconclusive, because the merchant's refund rows are not in
  the validated mapping; a refund attack on a control can show a violation but never a clean result.
- The validated patch runs in-process inside the disposable copy; static validation is not an OS-level sandbox.
- Mock gateway only; event shapes are not validated against real Razorpay deliveries.

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
| AI layer (`harness/ai/`) | Analyst, agent and fix-and-verify built; real-Groq repair evidence is for `merchant/unseen` only. AI-designed attacks experimental: one blind rediscovery, no novel violation |
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
mapping), which is honest, not a false negative. The correct controls (`reference`, `unseen2`) and `unseen`
(whose planted flaw is elsewhere) reject the second refund (409) and keep the ledger refund total within captured. On the **vulnerable** app
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
  payprobe-bench.js         CLI: benchmark (npm run bench, bench:mock, bench:ai, bench:ai:blind)
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
