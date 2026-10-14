# PayProbe

PayProbe looks for business-state bugs in payment integrations: orders marked paid without a real payment,
wrong amounts accepted, double fulfilment, paid orders reversed by late events, and over-refunds. It does
this by sending adversarial sequences of payment events and then checking the merchant's **database**,
not its HTTP responses.

## Status (honest)

| Capability | State |
|------------|-------|
| Reference (correct) and vulnerable merchant apps | Built, smoke-tested |
| Independent invariant checker (ledger, mappings, snapshots, I1-I5) | Built, unit-tested; happy path passes on both apps. I6 (concurrency) is a placeholder that always returns `cannot_verify` |
| Bug detection | **One scenario only** (duplicate delivery of a genuine `payment.captured`, see below). No other attack has been run. No claim of general detection accuracy |
| Scenario runner (reusable attack runs, finding records, generated regression tests) | Not built yet; design approved 2026-10-14 |
| Mapping v2 + validator (evidence + one normal purchase) | Built, tested on both apps with correct and wrong mappings. Mappings are hand-written, not discovered |
| Isolated per-run database and app (`harness/run-db.js`, `startIsolatedMerchant`) | Built; used by the validator and isolated-run tests. The attack scenario still uses in-memory databases |
| Autonomous investigation agent / mapping discovery | Not built |
| Real Razorpay integration / test-mode payments | **None.** Everything uses local mocks |

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
test/                  node:test suites (helpers.js: startMerchant, startIsolatedMerchant)
  scenarios/           attack experiments (duplicate-captured)
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
