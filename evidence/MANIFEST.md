# Evidence manifest

Copies of the local PayProbe reports (byte-identical, except one clearly marked `.redacted.json` file) that support the claims in [README.md](../README.md) and
[BUILT_WITH_AI.md](../BUILT_WITH_AI.md). The originals stay in the git-ignored `results/` folder. Each file can be
opened in `tools/report-viewer.html`.

Everything was produced against local fixture apps and a **mock Razorpay gateway**: no live Razorpay, no real
payments. Timestamps inside the reports and in their file names (UTC) were written by the developer's machine;
they are consistent with the development timeline, not independent proof of it.

## Benchmarks (`evidence/benchmarks/`)

| File | Bytes | Kind | Supports |
|---|---|---|---|
| [`benchmark-2026-10-17T05-16-45-636Z.json`](benchmarks/benchmark-2026-10-17T05-16-45-636Z.json) | 5,741 | Deterministic, no model | **Verified:** 5 hand-written scenarios × 4 apps, 3 repetitions; 6 violations on the buggy apps (`unseen` 1, `vulnerable` 5); 0 false positives on the controls (`reference`, `unseen2`) |
| [`benchmark-2026-10-17T05-48-06-963Z.json`](benchmarks/benchmark-2026-10-17T05-48-06-963Z.json) | 14,113 | Real Groq, AI attacks | **Failed run:** 0/24 model calls succeeded; no error detail was recorded |
| [`benchmark-2026-10-17T14-10-50-758Z.json`](benchmarks/benchmark-2026-10-17T14-10-50-758Z.json) | 16,327 | Real Groq, AI attacks | **Failed run:** 0/32 model calls succeeded; 86 retries; 8,990 of 9,000 completion tokens were reasoning |
| [`benchmark-2026-10-18T14-16-05-730Z.json`](benchmarks/benchmark-2026-10-18T14-16-05-730Z.json) | 32,949 | Real Groq, AI attacks | **Unvalidated:** 23/24 calls ok; 2 of 24 proposals validated (21 rejected, 1 unparseable); 0 violations (1 clean, 1 inconclusive); nothing executed on a control app, so false positives are unmeasured; per-call diagnostics in `llmCalls` |
| [`benchmark-2026-10-19T11-56-22-048Z.json`](benchmarks/benchmark-2026-10-19T11-56-22-048Z.json) | 11,495 | Real Groq, AI attacks, **blind**, `vulnerable` only | **Rediscovery, not a novel finding:** 4/4 calls ok; 2 proposals rejected, 2 executed. One plan has the same fingerprint as the hand-written `cumulative-refund-over-capture` scenario (scored `rediscovery`) and violated I5 (`gateway_refunds_exceed_captured`) in 3/3; the one novel plan was clean in 3/3. The report records verdicts and violation kinds only, not ledger amounts or HTTP responses. Byte-identical copy |
| [`benchmark-2026-10-19T12-21-38-114Z.redacted.json`](benchmarks/benchmark-2026-10-19T12-21-38-114Z.redacted.json) | 13,106 | Real Groq, AI attacks, **blind**, `reference` (control) only | **REDACTED copy** (see below). 1/3 calls ok, 2 failed with HTTP 429 (Groq daily token limit). 1 plan executed: **inconclusive**, so no AI false-positive rate can be derived from it. Hand-written baseline: 4 clean, 1 inconclusive (the refund scenario) |

Both 2026-10-19 reports have `status: "completed"`. That means the benchmark finished processing the requested
app and saved its report; it does **not** mean every AI attack slot succeeded (2 of 3 model calls failed in the
reference run).

AI-designed attack discovery has produced **one rediscovery** of a known attack and no novel AI-discovered
violation in these runs; no new bug is claimed.

## AI investigations on `merchant/unseen` (`evidence/investigations/`)

| File | Bytes | Supports |
|---|---|---|
| [`unseen-2026-10-16T17-38-19-747Z.json`](investigations/unseen-2026-10-16T17-38-19-747Z.json) | 942,154 | 1 real repair loop: baseline I4 violation 3/3 → 0/3 clean after the patch, no regressions, original app unchanged, first attempt |
| [`unseen-2026-10-16T17-49-52-414Z.json`](investigations/unseen-2026-10-16T17-49-52-414Z.json) | 967,439 | 1 real repair loop (as above) + evaluation run, 3/3 independent repair trials verified |
| [`unseen-2026-10-16T18-07-18-572Z.json`](investigations/unseen-2026-10-16T18-07-18-572Z.json) | 976,431 | 1 real repair loop (as above) + evaluation run, 3/3 independent repair trials verified |
| [`unseen-2026-10-16T18-16-41-085Z.json`](investigations/unseen-2026-10-16T18-16-41-085Z.json) | 973,030 | 1 real repair loop (as above); final demo run: 7 model calls, 26,815 tokens, 0 failures, ~161 s of rate-limit pacing; agent trace |

Together: **10/10** real repair attempts verified (4 repair loops + 6 evaluation trials), for one bug in one
fixture. The evaluation trials record the verified flag and "original unchanged"; the per-scenario 3/3 → 0/3
detail is recorded for the 4 repair loops.

Not included: the analyst count "accepted in 5/5 real runs" in BUILT_WITH_AI.md also counts one real run without a
repair (`unseen-2026-10-16T17-40-36-205Z.json`), which is kept local.

## Integrity and privacy

SHA-256 of the files as copied (LF line endings, as stored in Git; a Windows checkout with `core.autocrlf=true`
may show CRLF and different local hashes):

```
2d91da59b76af3ad84cb83cccceb2115741bcf452db9af1a7da8ed815a96b27d  benchmarks/benchmark-2026-10-17T05-16-45-636Z.json
739ba7036d83bf161f5f7e3bf17d5059b42461bd24e560140845556722ad36b3  benchmarks/benchmark-2026-10-17T05-48-06-963Z.json
6254940a20fc2cd7894161501c5bd7fc7d9af4e5ecb5b20233f48b179d919c3b  benchmarks/benchmark-2026-10-17T14-10-50-758Z.json
7000e5d68c04e4674f2aa3d685d76de5efdfd062c86365bdf5cf7863a862914a  benchmarks/benchmark-2026-10-18T14-16-05-730Z.json
0d1834a167b5dbfbff580363ee1eafb53a9f8e352a13bfb287e95aa0720376f8  investigations/unseen-2026-10-16T17-38-19-747Z.json
359959f5464027a7871afaf4792fe3262f2578b51722d8f7b0670f0f88386225  investigations/unseen-2026-10-16T17-49-52-414Z.json
e255ba52f3e44a5716d5c335023dce0ed99723433fede74644e0403299221ed0  investigations/unseen-2026-10-16T18-07-18-572Z.json
d76a5f62bb99b6b2a453d301a75d931d464df36c349de5acf36e7adb01efdb63  investigations/unseen-2026-10-16T18-16-41-085Z.json
abe2f1991bf6b3f2b53c533b0a5f7f3ee78891d5f107d9f632182f1f2c30fbff  benchmarks/benchmark-2026-10-19T11-56-22-048Z.json
2211b5afdef380f7de772a8fd8caba283886cc70ae190c52a46459894c1030c2  benchmarks/benchmark-2026-10-19T12-21-38-114Z.redacted.json
```

The 2026-10-19 originals, which stay in the local `results/benchmarks/` and are not published:

```
abe2f1991bf6b3f2b53c533b0a5f7f3ee78891d5f107d9f632182f1f2c30fbff  results/benchmarks/benchmark-2026-10-19T11-56-22-048Z.json   (identical to the copy)
85f709e04bead35be421d2624bf9f386cb5b1ad9d697dcdcc48bd52101feb6a6  results/benchmarks/benchmark-2026-10-19T12-21-38-114Z.json   (original of the redacted copy)
```

**Redaction of `benchmark-2026-10-19T12-21-38-114Z.redacted.json`.** Groq's HTTP 429 error messages in
`llmCalls[].httpEvents[].message` name the account's organization ID. All 8 occurrences were replaced with
`[REDACTED]`; nothing else was changed. The copy is valid JSON, and parsing it gives exactly the original with
that one substitution, so `results`, `totals`, `llm` and every verdict are identical to the original. Groq request
IDs (`requestId`, per-request support identifiers, as already present in the 2026-10-18 report) are kept.

Before copying, each file (including the two 2026-10-19 copies, after redaction) was scanned for API keys (the project's Groq key, `gsk_`/`sk-`/`rzp_` patterns, Bearer
tokens, authorization headers), secret-valued fields, `.env`-style assignments, local paths (home, temp and repo
directories, drive paths), user and host names, e-mail addresses and private IP addresses: no matches. Local paths
in the reports are redacted by the harness (`<repo>`, `<tmp>`, `<home>`). The 64-hex-character strings are webhook
signatures computed with the public dummy secret in `merchant/config.js`.
