# Architecture

## Phase 1 (built)

```
                 +------------------------------+
  tests  ------> | harness/mock-razorpay.js     |  builds + signs Razorpay-shaped events
 (node:test)     +------------------------------+
     |                       | HTTP (loopback)
     |                       v
     |           +------------------------------+      +----------------------+
     |           | merchant app (Express)       | ---> | gateway/mock.js      |
     |           |  reference/  or  vulnerable/ |      | fake Orders/Refunds  |
     |           +------------------------------+      +----------------------+
     |                       |
     +--- reads state -----> SQLite (orders, payments, fulfillments, refunds, products)
```

Merchant endpoints (both implementations):

| Endpoint | Purpose |
|----------|---------|
| `POST /api/orders` `{sku, quantity}` | Server computes the amount, creates a (mock) Razorpay order |
| `POST /api/payments/verify` | Checkout success callback with `razorpay_payment_id` + `razorpay_signature` |
| `POST /webhooks/razorpay` | `payment.authorized/captured/failed`, `refund.processed/failed` |
| `POST /api/orders/:id/refunds` `{amount}` | Merchant-initiated refund (no auth: local fixture) |

## Business invariants (Phase 2 will make these executable)

Checked against the database after every event sequence, never against HTTP responses.

| ID | Invariant |
|----|-----------|
| I1 | An order is paid only if a captured payment exists for that order's own `razorpay_order_id`. |
| I2 | The payment that made an order paid has the same amount and currency as the server-side order. |
| I3 | Each order has at most one fulfilment, and stock decreases exactly once per paid order. |
| I4 | Once an order is validly paid, no later or reordered event moves it out of `paid`, and a captured payment never regresses. |
| I5 | For each payment, the sum of non-failed refunds is at most the captured amount. |
| I6 | I1–I5 hold when the same events are delivered concurrently. |

## Planned (not built)

- **Phase 2:** `harness/invariants.js` (pure checks over a DB snapshot) and invariant tests.
- **Phase 3:** `harness/scenarios.js` (named adversarial sequences: duplicates, reordering, concurrency, tampering),
  a runner that records initial state, exact event sequence, violated invariant and final state for each finding,
  and generated regression tests.
- **Phase 4:** an investigation agent that must *discover* the mapping (where orders, payments and fulfilments live,
  which routes do what) in an unseen app, validate it with a positive control, and stop when it cannot.
  The invariant checker would then run through that discovered mapping instead of hardcoded table names.
