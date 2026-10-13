# Simulated gateway contract

What `merchant/gateway/mock.js` and `harness/mock-razorpay.js` promise, and how that compares with
Razorpay's published documentation. **[V]** = stated in the official docs (quoted). **[U]** = not
established by the docs. **[A]** = modelling assumption made by this simulator.

Docs checked on 2026-10-13. Re-check before relying on them; docs change.

## Refunds: what the official docs establish

Source: Create a Normal Refund, https://razorpay.com/docs/api/refunds/create-normal/

- **[V] Amount parameter.** "The amount to be refunded. Amount should be in the smallest unit of the currency
  in which the payment was made." For a partial refund, "enter a value lesser than the payment amount."
  "If the `amount` parameter is not passed, the entire payment amount will be refunded."
- **[V] A single refund above the captured amount is rejected.** Documented error (400 BAD_REQUEST):
  "The refund amount provided is greater than amount captured."
- **[V] Refund of a fully refunded payment is rejected.** "The payment has been fully refunded already."
- **[V] Other documented request errors:** "The amount must be at least INR 1.00.", "The amount must be an
  integer.", "Amount cannot be blank.", "The payment status should be captured for action to be taken.",
  "Partial refund is currently not supported for this payment method.", "Duplicate receipt found for this
  refund request.", "Request failed because another payment operation is in progress."

Source: Payments entity, https://razorpay.com/docs/api/payments/entity/

- **[V]** `amount_refunded`: "The amount refunded in currency subunits." `refund_status` values: `null`,
  `partial`, `full`. Payment `status` values include `refunded`.

Source: Refunds API overview, https://razorpay.com/docs/api/refunds/

- **[V]** Partial refunds and "Fetch Multiple Refunds for a Payment" exist, so several refunds per payment are
  supported. Normal refunds have an idempotency mechanism: "Retry or send the same normal refund request
  multiple times safely by creating a normal refund idempotency request."

## Refunds: what the docs do NOT establish

- **[U] Cumulative cap across partial refunds.** No page I found says that the *sum* of partial refunds is
  rejected once it would exceed the captured amount, or whether "greater than amount captured" is measured
  against the original captured amount or the remaining refundable amount. The `amount_refunded` field and
  the "fully refunded already" error make a cumulative cap likely, but that is an inference, not documentation.
- **[U] Concurrent refunds.** "Request failed because another payment operation is in progress." suggests that
  concurrent operations on one payment can be rejected, but the docs do not say when.
- Pages checked that do not cover these points: https://razorpay.com/docs/payments/refunds/ ,
  https://razorpay.com/docs/api/refunds/

## Current simulator contract

| Behaviour | Simulator today | Status |
|-----------|-----------------|--------|
| `createOrder` | Returns `order_<random>`, records amount and currency in the ledger | [A] shape follows docs; not validated against real responses |
| `createRefund` amount > captured (single request) | **Accepted** | **Known gap vs [V].** Not changed in Phase 2 (instruction: no refund-behaviour change during the docs check) |
| `createRefund` on a fully refunded payment | **Accepted** | **Known gap vs [V]** |
| Cumulative partial refunds > captured | **Accepted** | [U] real behaviour undocumented |
| Concurrent refunds on one payment | All accepted | [U] |
| Refund status | Always `processed` immediately | [A] real refunds can be `pending` first |
| Payments | Not created by the gateway mock. Tests that model a genuine payment call `genuinePaymentEvent(ledger, ...)`, which records it in the ledger; forged events bypass the ledger | [A] |

## Consequence for the checker

I5 reports two kinds of violation:

- `merchant_refunds_exceed_captured` / `refund_against_uncaptured_payment`: the **merchant's own records**
  claim more refunded than the gateway captured. Meaningful whatever the gateway does.
- `gateway_refunds_exceed_captured`: the **simulated gateway** accepted refunds beyond the captured amount.
  For a single over-cap refund, real Razorpay is documented to reject it, so such a finding would be a
  simulator artefact and must not be reported as real money loss. For cumulative refunds it is [U].

## Proposed change (needs approval)

Make `createRefund` follow the documented behaviour: reject a single refund above the captured amount and
any refund on a fully refunded payment, using the documented error text. Model the cumulative cap as an
explicit, labelled assumption [A] with a switch, so findings can be reported both ways. This changes what
the merchant apps see on refund calls (the vulnerable app does not handle a rejected refund), so it is left
for an explicit decision.
