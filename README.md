# PayProbe

PayProbe looks for business-state bugs in payment integrations: orders marked paid without a real payment,
wrong amounts accepted, double fulfilment, paid orders reversed by late events, and over-refunds. It does
this by sending adversarial sequences of payment events and then checking the merchant's **database**,
not its HTTP responses.

## Status (honest)

| Capability | State |
|------------|-------|
| Reference (correct) and vulnerable merchant apps | Built, smoke-tested |
| Executable business invariants | Not built (Phase 2) |
| Reproducible bug detection | **Not yet demonstrated** (Phase 3) |
| Autonomous investigation agent | Not built; design in Phase 4 |
| Real Razorpay integration / test-mode payments | **None.** Everything uses local mocks |

## Setup on Windows

1. Install Node.js 22.13 or newer (LTS from https://nodejs.org). Check in PowerShell:
   ```powershell
   node --version
   ```
2. Install dependencies:
   ```powershell
   cd C:\Users\S.n.umamahesh\payprobe
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
test/                  node:test suites
docs/
  ARCHITECTURE.md      components and invariants I1–I6
  DECISIONS.md         design decisions and their costs
  SEEDED_BUGS.md       answer key for the vulnerable app (keep away from the agent)
TODO.md
```

## Warning

`merchant/vulnerable` is deliberately insecure. It exists only as a test target. Do not deploy it.
