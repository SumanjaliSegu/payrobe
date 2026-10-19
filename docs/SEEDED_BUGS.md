# Seeded bugs in `merchant/vulnerable`

This is the answer key for the vulnerable fixture. **Never give this file, or the reference app, to the
investigation agent**: it would turn discovery into lookup.

Status column: whether a test in this repo has *demonstrated* the bug. Nothing is demonstrated yet;
Phase 3 fills this in.

| ID | Where | Defect | Invariant it should break | Demonstrated |
|----|-------|--------|---------------------------|--------------|
| B1 | `POST /api/payments/verify` | Computes the checkout signature from the client-supplied `razorpay_order_id` and looks up the order by the client-supplied `order_id`. A valid signature for a ₹1 order can mark a ₹4,999 order paid. It also fulfils on the browser callback without waiting for a captured payment. | I1 paid ⇒ matching verified captured payment | not yet |
| B2 | webhook `payment.captured` | No check that the payment amount and currency match the server-side order. | I2 amount matches order | not yet |
| B3 | `fulfil()` | Check-then-act across an `await` (`notifyWarehouse`). Sequential duplicates are caught by the status check; concurrent duplicates both fulfil and decrement stock twice. No event-id dedupe. | I3 at most one fulfilment per order (concurrent) | not yet |
| B4 | webhook `payment.failed` | Unconditionally sets the order to `failed` and overwrites a `captured` payment with `failed`. A late or out-of-order failure reverses a valid paid order. | I4 final valid state is not reversed | not yet |
| B5 | `POST /api/orders/:id/refunds` | Caps each refund at the order amount but ignores earlier refunds; the check also spans an `await`. | I5 refunds ≤ captured | not yet |
| B6 | webhook signature | HMAC computed over `JSON.stringify(req.body)` instead of the raw bytes. Genuine events whose bytes are not canonical JSON are rejected. This is an availability bug (missed fulfilment), not a money-state violation, so I1–I5 will not catch it. | none of I1–I5; needs a liveness check | not yet |

## Unplanned defects noticed while writing the fixture

| ID | Defect | Note |
|----|--------|------|
| U1 | No validation of `quantity`. A negative or fractional quantity produces a negative or fractional order amount. | Not seeded on purpose. Kept because real code has unplanned bugs too. |
| U2 | Signature comparison with `!==` (not constant-time). | Timing side channel; not testable through state invariants. |
