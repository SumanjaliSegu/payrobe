# Built with AI

PayProbe uses AI in two ways: **at runtime**, a language model explains findings, runs a bounded
investigation with approved tools, and proposes fixes; and **during development**, the project was built with
an AI coding agent. In both, the same rule applies: **AI proposes, deterministic code verifies.** A model can
never set or change a verdict, and nothing is reported as fixed unless the existing harness re-ran the attack
and its invariant checker says so.

Everything here runs against local fixture apps and a mock Razorpay gateway. No real Razorpay account,
no real payments, no real money. A clean result on a fixture is not proof of production security.

## Runtime: Discover → Understand → Investigate → Explain → Fix → Verify

```
                deterministic (authoritative)                         AI (hypotheses, bounded)
 ┌──────────────────────────────────────────────────┐     ┌──────────────────────────────────────────┐
 │ discovery.js   map the app's payment flow        │     │                                          │
 │ validator.js   confirm the map (neg/pos control) │     │                                          │
 │ runner.js      attack isolated copies, 3x each   │────▶│ analyst.js  explain verified findings,   │
 │ invariants.js  I1–I6 over DB + independent ledger│     │             cite approved source lines    │
 │                                                  │◀────│ agent.js    choose next run/read via      │
 │ tools.js       run_scenario / read_source only   │     │             allowlisted tools, conclude   │
 │                                                  │◀────│ repair.js   propose a patch (find/replace)│
 │ repair.js      validate patch, apply to a        │     │                                          │
 │                disposable copy, re-run ALL       │     │                                          │
 │                scenarios, judge, compare         │     │                                          │
 └──────────────────────────────────────────────────┘     └──────────────────────────────────────────┘
```

| Stage | Code | What the AI does | What code enforces |
|---|---|---|---|
| Discover / Understand | `harness/discovery.js`, `validator.js`, `runner.js` (existing) | nothing | mapping validated before any attack; every scenario 3× in fresh isolated apps |
| Explain | `harness/ai/analyst.js` | what happened, payment/business impact, root cause, remediation, uncertainty, confidence | strict JSON schema (unknown keys rejected); every cited line range must exist in an approved file and is quoted from the real file; verdict copied from the deterministic finding, never from the model; one corrective retry, then "rejected" |
| Investigate | `harness/ai/agent.js`, `tools.js` | picks the next action each step from real observations: re-run an approved scenario, read approved source, or finish with hypotheses | tool allowlist (no shell, no network, no file writes, no code execution); argument schemas; scenario allowlist; 3 runs, 6 steps, wall-clock and invalid-output limits; a hypothesis can be "supported/refuted" only if it cites a scenario-run observation, otherwise code downgrades it to "unresolved" |
| Design attacks (**experimental**: one blind rediscovery, no novel violation; see the benchmark below) | `harness/ai/attacks.js`, `attack-loop.js` | proposes webhook and refund sequences as a declarative plan: orders + a step list from an allowlisted vocabulary (`create_order`, `deliver_webhook`, `request_refund`) | the model fills a strict schema, never writes code; a deterministic validator checks every field, the ref name format, the SKU allowlist, ordering, sizes and the gateway-ledger rules (a genuine event must be validly signed and keep one order/amount; a forged event must be unsigned or wrong-secret; a refund needs an earlier genuine full capture and never exceeds one capture on its own); a fingerprint marks rebuilds of the hand-written scenarios and of earlier proposals; accepted plans compile to ordinary scenarios run in isolation; the independent checker decides the outcome; "novel" needs a plan that matches no hand-written scenario, and "discovered" needs a violation reproduced in every repetition |
| Fix | `harness/ai/repair.js` | minimal patch as find/replace edits, with rationale and cited evidence | edits only `app.js`; unique anchors; size limits; may not touch signature verification, secrets or exports; may not add require/import, process, global, network, fs, crypto, timers, loops, await, eval, raw `db.exec`, destructive SQL or escape sequences; must compile |
| Verify | `harness/ai/repair.js` + `runner.js` | nothing | baseline reproduced on the original first; patch applied only to a disposable copy under `data/ai-repairs/` (git-ignored, removed afterwards); every approved scenario re-run; **fixed** = target scenario clean in every repetition (its payment-liveness preconditions included) **and** no other scenario regressed; original source tree hashed before/after |
| Evaluate | `harness/ai/pipeline.js` | — | `--eval-trials N` repeats the full repair loop independently and reports the success rate |

### Provider and model

- Groq free tier, OpenAI-compatible chat completions with JSON mode (`harness/ai/llm.js`). The model is chosen at
  runtime from the live model list (`openai/gpt-oss-120b`, falling back to `qwen/qwen3.8-27b`, `openai/gpt-oss-20b`);
  `GROQ_MODEL` overrides it.
- The free tier allows 8,000 tokens per minute. The client reads Groq's `x-ratelimit-*` headers and waits before a
  call that would exceed the remaining budget; 429/5xx are retried with `retry-after`; every call has a timeout.
  When JSON mode rejects an output (`json_validate_failed`), the client recovers the object from Groq's
  `failed_generation` if it parses, otherwise retries; the agent counts unparseable output as an invalid step.
- The only network egress of the AI layer is `https://api.groq.com/openai/v1`. Merchant apps stay local.
- The key lives only in the git-ignored `.env` (`GROQ_API_KEY=...`). It is never printed, logged or written to a
  report; error messages are scrubbed of it and reports pass through the existing redaction.

### What a report records (`report.ai`, schema `payprobe.ai/v1`)

Mode (`real` / `mock`; reports without `ai` are deterministic-only), provider, model, every model call (purpose,
status, latency, rate-limit pacing, retries, prompt/completion/reasoning tokens, input size + sha256 + short
sanitized previews), analyst results with quoted evidence, every agent step (thought, tool, arguments, real
observation, errors) and its checked conclusion, every repair attempt (rationale, patch, static validation,
re-run results for each scenario, regressions, cleanup), the stop reason, whether the original app was
unchanged, and evaluation trials. `tools/report-viewer.html` shows all of this in the **AI Investigator** section
and labels each report Real AI / Mock AI / Deterministic only.

## Recorded results (local fixture `merchant/unseen`, real Groq calls)

All numbers below come from the JSON reports in `results/investigations/` (git-ignored, local), produced on
2026-10-16 with `openai/gpt-oss-120b` on Groq's free tier. Copies of the four repair-loop reports (including both
evaluation runs and the final demo run) are in [`evidence/investigations/`](evidence/MANIFEST.md); the analyst
count also includes one real run without a repair (`unseen-2026-10-16T17-40-36-205Z.json`) that is kept local.

| Measure | Result |
|---|---|
| Deterministic baseline | `late-failed-attempt` violates **I4** (paid order reversed) in 3/3 runs, with I3 (fulfilled but not paid) as a side effect; 3 other scenarios clean, refund scenario inconclusive |
| AI analyst | accepted in 5/5 real runs; root cause located in `onFailed`, which reopens the basket without checking whether it is settled; every citation verified against the real file |
| AI repair loops | **4 real repair loops, 4 verified, each on the first attempt**: each report records the target going from 3/3 violated to 0/3, no other scenario changed, and the original app byte-identical afterwards |
| Evaluation runs | two runs with `--eval-trials 3`: **3/3** and **3/3** independent repair trials verified. Each trial records `verified`, `attemptsUsed: 1` and `originalUnchanged: true`; the per-scenario 3/3 → 0/3 detail is not recorded for trials |
| Total | **10/10** real repair attempts verified (4 loops + 6 trials), for this one bug in this one fixture |
| Agent (final demo run, [`unseen-2026-10-16T18-16-41-085Z.json`](evidence/investigations/unseen-2026-10-16T18-16-41-085Z.json)) | read source → ran `late-failed-attempt` (violation reproduced) → ran `captured-amount-mismatch` as a control (clean) → finished; 2 hypotheses "supported" with its own execution evidence, 2 claims downgraded by code to "unresolved" for lacking run evidence, 1 left unresolved |
| Cost of the final demo run | 7 model calls, 26,815 tokens, 0 failures; 161 s of the run was rate-limit pacing on the free tier |

The accepted patch (model-written; applied only to the disposable copy):

```diff
   function onFailed(p) {
     upsertCharge(p, 'failed');
-    q.setState.run('open', p.order_id);
+    const basket = q.basketByGw.get(p.order_id);
+    if (!basket || basket.state !== 'settled') {
+      q.setState.run('open', p.order_id);
+    }
   }
```

What went wrong along the way, and what was changed (all visible in earlier reports): Groq's JSON mode rejected an
agent step (`json_validate_failed`) → recovery from `failed_generation` and a non-JSON-mode retry were added; the
agent first concluded from source reading alone → its "supported" claims were downgraded by code, and an evidence
gate now sends an unevidenced conclusion back once; the agent once ran out of steps before concluding → one
finish-only turn was added; a read past the end of the file wasted a step → reads are now clamped.

## Reproducible benchmark (`harness/bench.js`, `npm run bench`)

The benchmark runs the fixtures and scores them. The only ground truth is each app's **role** — `reference` and
`unseen2` are correct by construction (controls), `unseen` and `vulnerable` contain seeded defects. That role
table lives in `harness/bench.js`, is never put in a prompt, and is never reachable by the agent or the attack
designer (they receive only source, prior findings and the SKU allowlist). The seeded-bug answer key
(`docs/SEEDED_BUGS.md`) is never read. Scoring: a violation on a control app is a false positive; a violation on
a buggy app is a reproduction. AI-designed attacks are scored as a **separate category** from the hand-written
scenarios. Counts are reported as-is, with rejected and duplicate proposals shown and no target rate assumed.

- **Deterministic** (`npm run bench`, no key, 3 repetitions/scenario): across the 4 fixtures, the hand-written
  scenarios reproduced **6 violations on the two buggy apps** (`unseen` 1, `vulnerable` 5) and produced
  **0 false positives on the two control apps** (`reference`, `unseen2`: 4 clean and 1 inconclusive each; the
  inconclusive one is the refund scenario, see below). Fully reproducible.
  Report: [`benchmark-2026-10-17T05-16-45-636Z.json`](evidence/benchmarks/benchmark-2026-10-17T05-16-45-636Z.json).
- **AI-designed attacks, non-blind** (`npm run bench:ai`, real Groq): three runs in
  [`evidence/benchmarks/`](evidence/MANIFEST.md#benchmarks-evidencebenchmarks). Two failed with no successful
  model call; the third completed its model calls, but only 2 of 24 proposals passed validation, neither
  reproduced a violation, and none ran on a control app, so false positives are unmeasured.
- **AI-designed attacks, blind** (`npm run bench:ai:blind`, real Groq): one **rediscovery** of the hand-written
  refund-over-capture attack, no novel violation, no conclusive control result. Details below.

### Blind attack-discovery evaluation

**Why blind.** In the non-blind mode the attack designer is shown the deterministic findings and a list of the
hand-written scenarios to avoid. That is useful for finding new sequences, but it cannot measure whether the
model can find a bug on its own. In blind mode (`--blind`):
- every app is presented as `target`, so the model is not told which app it is attacking;
- the source is shown with every comment removed, keeping line numbers;
- the findings list is empty and the known-scenario list is `none`;
- the planning instructions are identical for every app.

Automated tests (`test/ai-blind-prompt.test.js`) build the blind prompts for all four fixtures, including the
corrective-retry prompt, and check that none of them contains an app name, role or answer-key wording, a
scenario name, a finding, or any original source comment. The benchmark reports record per-call metadata
(tokens, status, latency), not prompt text or prompt hashes, so what each real run sent is established by the
code version and these tests, not by a prompt log.

**Scoring.** A plan whose fingerprint matches a hand-written scenario still runs, because the model could not
have copied it, but it counts as a **rediscovery**, never as novel. Repeating its own earlier plan is a duplicate
and does not run. The verdict comes only from execution: the target invariant must be violated in every
repetition with clean cleanup.

**Results** (real Groq, `openai/gpt-oss-120b`, 3 repetitions; copies in `evidence/benchmarks/`, listed with hashes
in the [manifest](evidence/MANIFEST.md#benchmarks-evidencebenchmarks)):

| Report | App | Model calls | Outcome |
|---|---|---|---|
| [`benchmark-2026-10-19T11-56-22-048Z.json`](evidence/benchmarks/benchmark-2026-10-19T11-56-22-048Z.json) | `vulnerable` | 4 ok | 2 rejected by the validator (`steps[0].order: expected string`), then corrected. **Rediscovery:** genuine full capture followed by two full refunds, the same fingerprint as `cumulative-refund-over-capture`; **I5 violated 3/3** (`gateway_refunds_exceed_captured`). **Novel:** forged wrong-secret double-amount capture, then the genuine capture: **clean 3/3** |
| [`benchmark-2026-10-19T12-21-38-114Z.redacted.json`](evidence/benchmarks/benchmark-2026-10-19T12-21-38-114Z.redacted.json) (Groq organization ID redacted) | `reference` | 1 ok, 2 rate-limited | 1 plan executed (forged unsigned double-amount capture): **inconclusive**, because the app rejected the forged event and the targeted checks had nothing to check |

Both reports have `status: "completed"`: the benchmark finished processing the app and saved its report. That
status does not mean every attack slot succeeded; the reference run's second slot failed on both attempts.

The I5 verdict is decided from the independent gateway ledger. The saved report keeps the verdict and the
violation kind, but **no amounts or HTTP responses**. The figures that follow come from a **later local
re-execution** of the recorded plan (no model call), not from the saved report: refunds answered `201`, `201` and
₹998 refunded against ₹499 captured on `vulnerable`; `201`, `409` on `reference`. The original reports are
unchanged.

**What this shows and what it does not.**
- Shows: without being given the attack, the findings or the app's identity, the model produced a valid plan
  that the harness confirmed as an I5 violation.
- Does not show: a novel attack, a new bug, a false-positive rate (no conclusive AI result on a control), or a
  success rate (one buggy-app run with 2 slots).
- Caveat: the vocabulary is small and the prompt defines I5 as "refunds never exceed captured", so two full
  refunds after one capture is close to the most obvious test of it.

**What went wrong on the way.**
- Until a **refund action** was added to the plan vocabulary, the model could not issue refunds, so I5 was
  unreachable and plans targeting it came back inconclusive.
- A leak audit before counting any result found that the prompt still said `App: vulnerable` and included
  source comments that say whether a fixture is meant to be correct. Two blind runs made before the fix
  (`2026-10-19T09-10-06-439Z`, `10-04-18-988Z`; no violations, cut short by rate limits) are **not counted**,
  and their reports are kept locally, not published.
- 3 of the 4 rejections in those two earlier runs were refs that did not match the required pattern; the prompt
  now states the exact format with valid and invalid examples. The validator was not relaxed.
- Groq's free tier allows this model 200,000 tokens per day. Runs hit that limit (HTTP 429, `retry-after` up to
  2,250 s, about 37 minutes), so the counted runs were done one app at a time with 2 attack slots each.
- A run was killed for low memory and saved nothing, because the report was written only at the end. Reports are
  now saved at the start and after each app; `startedAt` is the real start time, and `completedAt` is separate.

An important honest note from building this: the control apps caught a false positive in an early version of the
attack vocabulary — a "forged" event delivered with a *valid* signature is indistinguishable from a genuine one
and flagged every app alike. The fix was to make the guardrail stronger (a forged event must be unsigned or
wrong-secret), not to relax the check. This is exactly what the control apps are for.

### Benchmark diagnostics (added after the two failed AI runs)

The first two real `bench:ai` runs failed without recording the reason for each failed call. The changes below were added to
`harness/ai/llm.js`, `harness/ai/attack-loop.js`, `harness/bench.js` and `bin/payprobe-bench.js` so that a run
reports its failures instead of hiding them. They change what is recorded and when the run stops calling the
model; they do not change how proposals are validated or how outcomes are judged. The report schema stays
`payprobe.benchmark/v1`; reports from before 2026-10-18 do not have these fields.

| Behaviour | What it does | Unit tests | Seen in a real run |
|---|---|---|---|
| Circuit breaker | `npm run bench:ai` stops calling the model after 4 consecutive failed calls, whatever the cause (e.g. 429/5xx after retries, invalid JSON, timeouts); the run continues without the model and still writes its report, with the state in `circuitBreaker` | Yes, with a fake transport and a mock model (`test/ai-llm.test.js`, `test/ai-attacks.test.js`) | Never opened in the 2026-10-18 run. **Opened** after 4 rate-limited calls in the blind run `2026-10-19T09-10-06-439Z` (kept locally, not published), which skipped its remaining slots and still wrote its report |
| Per-call log `llmCalls` | one entry per model call: purpose, model, status / failure code, HTTP status, retries, pacing, latency, token usage, finish reason, JSON-mode recovery flags; no prompt or output text | Yes (`test/ai-llm.test.js`: no prompt previews, no key) | Yes: 24 entries in the 2026-10-18 report |
| `httpEvents` | per call, every non-2xx response: status, a short provider message with the key redacted, `retry-after`, `x-ratelimit-*` remaining/reset values and the request id; nothing from the request | Yes, for HTTP 429 and 503 with a fake transport | One HTTP 400 (`json_validate_failed`) event in the 2026-10-18 run. HTTP 429 events (Groq's daily token limit) were recorded in the 2026-10-19 blind runs, including the published reference report (organization ID redacted); **no 5xx has occurred** in a real run |
| Unmeasured = `null` | `totals.ai.falsePositivesOnControls` and `reproducedViolationsOnBuggy` are `null` when no attack ran on those apps (the CLI prints "unmeasured"), with denominators alongside: `executedOnControls`, `executedOnBuggy`, `validated`, `errors`, `skipped`, `modelCalls` | **No automated test** | Yes: `falsePositivesOnControls` is `null` in the 2026-10-18 report |
| Skipped slots | once the breaker is open, remaining attack slots are recorded as `skipped` (counted separately, not as model failures or as clean) | Yes, with a mock model (`test/ai-attacks.test.js`) | Not in the 2026-10-18 run; 4 slots skipped in the blind run `2026-10-19T09-10-06-439Z` (kept locally, not published) |
| Rejection reasons | the validator's messages for `rejected` proposals (and the breaker's reason for `skipped` ones) are kept in the report's `detail[].errors`; before this, only `error` proposals kept them | **No automated test** of the report field | Recorded in the published blind report `2026-10-19T11-56-22-048Z` (`steps[0].order: expected string`). Added after the 2026-10-18 run, which is why that run has none |
| Per-app saving | the report file is written at the start and after each app (`status`: `running` → `partial` → `completed`, or `failed` / `interrupted`), never replacing another run's file. `completed` means every requested app was processed and saved, not that every AI attack slot succeeded | Yes (`test/bench-report.test.js`; the Ctrl+C path is not tested) | Used by the published blind runs `11-56-22-048Z` and `12-21-38-114Z` |

## How to run (Windows, PowerShell, from the `payprobe` folder)

```powershell
npm install
# one-time: put your Groq key in .env without printing it (copy the key first)
$k = (Get-Clipboard -Raw); if ($k) { $k = $k.Trim() }; if ($k -match '^gsk_\S{20,}$') { Add-Content -Path .env -Value "GROQ_API_KEY=$k" -Encoding ascii; Set-Clipboard -Value ' '; "Saved Groq key to .env ($($k.Length) chars)" } else { "Clipboard does not look like a Groq key; nothing written" }; Remove-Variable k -ErrorAction SilentlyContinue

npm run ai:check                               # verifies key + model with one tiny call (prints no secret)
npm run ai:demo                                # real run on merchant/unseen: analyst + agent + fix & verify
npm run ai -- --app unseen --eval-trials 3     # plus 3 independent repair trials (success rate)
npm run ai -- --app unseen2                    # correct app: no violation, so nothing to repair
npm run ai:mock                                # offline, scripted mock model, clearly labelled
npm run bench                                   # reproducible benchmark, deterministic (no key)
npm run bench:ai                               # plus real AI-designed attacks (experimental)
npm run bench:ai:blind -- --apps vulnerable --attack-count 2   # blind evaluation, one app per run (experimental)
npm test                                       # full suite; AI tests use mocked model responses only
```

Open `tools\report-viewer.html` in a browser and load the newest `results\investigations\unseen-*.json`, or one of
the published reports in `evidence\investigations\`.

## Development: how an AI coding agent was used

PayProbe was built with an AI coding agent (Claude Code) working in the repository under explicit rules from the
developer: Git operations and publishing stay with the developer (the agent ran Git commands only when explicitly
asked), never read the seeded-bug answer key, preserve existing behaviour and assertions, and report results
honestly. The agent wrote and edited code and tests, ran the suite and benchmarks,
and reported the results; the developer reviewed the changes and decided what to commit. Its claims were treated
like model output at runtime: a change counted only when the tests and the harness confirmed it. Concrete
examples from this project:

- **Evidence-first debugging.** A flaky runner test was not "fixed" by guessing: the agent traced the two coupled
  timeouts, injected diagnostics from outside the repo, reproduced the failure under parallel load (5/20), proved
  the cause with a dose-response experiment (delay 0/250/400 ms → 1/3, 2/3, 3/3 failures), and only then made a
  one-line, test-only change, verified with 20 parallel runs and three full-suite runs.
- **Verified UI work.** The report viewer was checked in headless Chrome over the DevTools protocol: every count,
  outcome, invariant and reproduction number was diffed against the source JSON (219 checks), plus injection
  probes, zero network requests and zero console errors.
- **This AI layer.** Built incrementally (mock vertical slice first, then a real Groq run), with tests for every
  guardrail written alongside: `test/ai-llm.test.js`, `test/ai-guardrails.test.js`, `test/ai-repair.test.js`.
- **Real calls, recorded.** Model choice, JSON-mode quirks (`failed_generation` recovery) and free-tier pacing were
  discovered from real Groq responses during development and are covered by tests with a fake transport.
- **Auditing an evaluation before believing it.** Before counting any blind attack result, the agent checked what
  the prompt actually contained, found the app-identity leak described above, fixed it, and added leak tests.
  After the counted runs it compared the violating plan's fingerprint with the hand-written scenario and
  reported it as a rediscovery rather than a discovery.
- **Agent mistakes, corrected.** The agent once stated that the attack loop had no retry when it already had one
  (the real problem was that the retry asked for a different plan instead of a corrected one); this was
  corrected after reading the code, and the retry was changed to echo the validator's errors and the rejected
  plan back to the model.

## Limitations

- Local fixtures and a mock gateway only; event shapes are not validated against real Razorpay deliveries.
- The analyst, agent and repair outputs are model hypotheses; only execution through the deterministic harness
  counts as verification, and only for the scenarios that exist.
- The validated patch runs in-process inside the disposable copy. Static validation blocks the dangerous
  constructs listed above, but it is not an OS-level sandbox.
- The repair loop has been exercised on one real target (the I4 late-failure bug in `merchant/unseen`). Success
  there is not a claim about arbitrary codebases.
- Free-tier rate limits make a full run take minutes (pacing is recorded in each report), and the daily token
  limit can stop a benchmark partway. Model availability on Groq can change; the client picks from a preference
  list at runtime.
- AI attack design remains experimental: one blind rediscovery, no novel violation, no measured false-positive
  rate. Refund plans are sequential only, with amounts limited to the full or half order amount. On a correct app
  the refund invariant can only be inconclusive, because merchant refund rows are not in the validated mapping.
- Benchmark reports do not store prompt text or hashes, or per-plan ledger amounts; those have to be
  re-established from the code version and a local re-run.
