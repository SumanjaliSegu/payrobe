# Simulated gateway contract

What `merchant/gateway/mock.js` and `harness/mock-razorpay.js` promise, and how that compares with
Razorpay's published documentation. **[V]** = stated in the official docs (quoted). **[U]** = not
established by the docs. **[A]** = modelling assumption made by this simulator.

Docs checked on 2026-10-13 (refunds) and 2026-10-14 (checkout, orders, payments, webhooks). Re-check before
relying on them; docs change. In the 2026-10-14 section, **[F]** marks behaviour specific to our fixture apps,
and an *inference* is a conclusion drawn from documented facts that the docs do not state themselves.
Scenario files keep the runner's `status` values V/U/A and add a `basis` field: [F] is `status: 'A'` with
`basis: 'fixture-specific'`; an inference is `status: 'A'` with `basis: 'inference'`; the unresolved order/attempt
conflict is `status: 'A'` with `basis: 'unresolved'`; documented claims are `status: 'V'`, `basis: 'documented'`.

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

### Decision (2026-10-14): Option A — keep the mock permissive; detect over-refund via the ledger

The proposed change above was **not** adopted. The mock gateway stays permissive (accepts every refund,
always `processed`), so no existing app behaviour or test changes. The B5 attack
(`harness/scenarios/cumulative-refund-over-capture.js`) issues two refunds, **each equal to the captured
amount** (so no single request is over-cap — avoiding the documented single-over-cap simulator artefact),
and relies on I5's `gateway_refunds_exceed_captured`, computed from the independent `harness/ledger.js`
record, to detect that the non-failed refunds for a payment sum beyond what was captured. The merchant-
records branch is not used, because the validator never refunds and so refund DB-mapping entries are never
behaviour-confirmed (frozen mapping `refunds === null`). Findings are labelled: single over-cap rejection is
[V]; the cumulative cap is [U] (undocumented); the mock accepting cumulative refunds is [A]. Such a finding
is **not** reported as proven real-world money loss. See D24. The fuller Option B (enforcing documented
rejections in the mock) remains available if a future scenario needs it.

---

# Checkout, orders, payments and webhooks (docs checked 2026-10-14)

How these were read: each page was fetched on 2026-10-14 and the quotes below were extracted from the fetched
text. They are short excerpts, not full sections. Nothing here has been checked against a real Razorpay
account or real webhook deliveries. Two pages could not be fetched (HTTP 404) and are **not** sources:
`https://razorpay.com/docs/payments/payments/partial-payments/` and
`https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/checkout-options/`.

Sources used:

| Short name | URL |
|------------|-----|
| Checkout steps | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/ |
| Checkout best practices | https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/best-practices/ |
| Create order | https://razorpay.com/docs/api/orders/create/ |
| Order entity | https://razorpay.com/docs/api/orders/entity/ |
| Capture payment | https://razorpay.com/docs/api/payments/capture/ |
| Route transfers from orders | https://razorpay.com/docs/api/payments/route/create-transfers-orders/ |
| Payment Links partial payments | https://razorpay.com/docs/payments/payment-links/partial-payments/ |
| Webhooks overview | https://razorpay.com/docs/webhooks/ |
| Validate webhooks | https://razorpay.com/docs/webhooks/validate-test/ |
| Webhook best practices | https://razorpay.com/docs/webhooks/best-practices/ |
| Payment webhook events | https://razorpay.com/docs/webhooks/payments/ |

## Standard Checkout signature (scenario cross-order-checkout-signature)

| Claim | Source, heading | Quote | Establishes | Does not establish | Class |
|-------|-----------------|-------|-------------|--------------------|-------|
| On success Checkout gives the browser `razorpay_payment_id`, `razorpay_order_id`, `razorpay_signature` | Checkout steps, "3 Handle Payment Success and Failure" | "Collect these and send them to your server." | The three fields, and that they arrive through the client | How the merchant's own endpoint is named or shaped | [V] |
| Signed value and key | Checkout steps, "5 Verify Payment Signature" | `generated_signature = hmac_sha256(order_id + "\|" + razorpay_payment_id, secret);` and "`key_secret`: Available in your server" | HMAC-SHA256 over `order_id\|payment_id` with the key secret; `checkoutSignature` in `harness/mock-razorpay.js` matches | — | [V] |
| Verify against the stored order | Checkout steps, "5 Verify Payment Signature" | "Retrieve the `order_id` from your server. Do not use the `razorpay_order_id` returned by Checkout." | Using the client-supplied gateway order id is explicitly wrong | — | [V] |
| Verification is mandatory before fulfilment | Checkout steps, "Watch Out: Always verify the payment signature server-side" | "You must verify the signature on your server before fulfilling the order." | A signature check is required | That a valid signature alone is enough to fulfil | [V] |
| Fulfil only on a captured payment and paid order | Checkout best practices, "Check Payment/Order Status before Providing Services" | "Check the payment/order status, that is if the payment's status is `captured` and the order's status is `paid`" | Fulfilling on the browser callback without a confirmed capture goes against documented practice | That Razorpay prevents such integrations | [V] |
| A customer can get a valid signature for a cheap order by paying it, then present it for another order | — | — | Follows from the rows above: the signature binds a gateway order id and payment id and reaches the client | Not described by the docs as an attack | inference |
| Our verify route is `POST /api/payments/verify` and takes the merchant `order_id` plus the three fields | `harness/mappings/v2/*` (cited fixture lines) | — | Both fixtures accept that body (the scenario's control step) | Anything about Razorpay; never confirmed by the validator | [F] |

Impact (scenario labels updated 2026-10-14): the checkout claim is [V], with the quotes above. The route claim
is [F]: an assumption about our fixtures, not about Razorpay. The replay is an inference. The attack tests a
documented merchant obligation ("Do not use the `razorpay_order_id` returned by Checkout"); the docs alone do
not show that any real merchant app is exploitable.

## Captured amount vs order amount (scenario captured-amount-mismatch)

| Claim | Source, heading | Quote | Establishes | Does not establish | Class |
|-------|-----------------|-------|-------------|--------------------|-------|
| Capture amount equals the order amount | Capture payment, "Request Parameters", `amount` | "The amount to be captured (should be equal to the order amount, in the smallest unit of the currency)." | For the capture API, the capture amount is expected to equal the order amount | What happens with automatic capture; whether a `payment.captured` event can ever carry a different amount | [V] (capture API) |
| Capture must equal the authorised amount | Capture payment, "Errors" | "Capture amount must be equal to the amount authorized." | Partial capture of an authorised payment is rejected | — | [V] |
| Capture cannot exceed what is due | Capture payment, "Errors" | "Payment amount is greater than the amount due for order." | Orders track an outstanding amount | — | [V] |
| Orders track amount paid and due | Order entity, `amount_paid`, `amount_due` | "The amount paid against the order." / "The amount pending against the order." | An order can in principle be partly paid | When that happens | [V] |
| Orders can enable partial payments | Create order: Go sample and the error "first_payment_min_amount should be greater than or equal to 0."; Route transfers: "You cannot create transfers on orders which has the `partial_payment` parameter enabled." | — | An order-level `partial_payment` flag exists | Its rules: the parameter is not described in the request-parameter tables that were fetched | partly documented |
| Partial payments on Payment Links | Payment Links partial payments | each partial payment is "tied to the same `order_id`" | Several smaller payments against one order, for Payment Links | Anything about Standard Checkout orders | [V] (other product) |
| Our fixtures create orders without `partial_payment` | `merchant/*/app.js`: `gateway.createOrder({ amount, currency, receipt })` | — | Partial-payment rules do not apply to the fixtures | — | [F] |

Conclusion: **unsupported for our fixtures.** For an order created without partial payments, the documented
capture rules point *against* a genuine captured payment whose amount differs from the order. The docs do not
say it is impossible (automatic capture and the event payload are not covered), so the scenario stays **[U]**
and every result from it is conditional. The mock ledger accepts any payment amount, so the simulator can
produce events that Razorpay documents as not produced by the capture API. A realistic amount scenario would
need a fixture that creates `partial_payment` orders. The question there is whether the merchant marks an
order paid while `amount_due` is still above zero. That is not built.

## Payment attempts and event order (scenario late-failed-attempt)

| Claim | Source, heading | Quote | Establishes | Does not establish | Class |
|-------|-----------------|-------|-------------|--------------------|-------|
| An order can have several attempts | Order entity, `attempts` | "The number of payment attempts, successful and failed, that have been made against this order." | More than one attempt per order, including failed ones | That attempts have different payment ids (implied, not stated on this page) | [V] |
| The order stays `attempted` until one payment is captured | Create order, response `status` | "It remains in the `attempted` state till one payment associated with that order is captured." | Failed attempts can precede a captured one on the same order | — | [V] |
| Orders bind multiple attempts | Checkout best practices, "Integrate Orders API" | "Orders bind multiple payment attempts for a single order." | Same as above | — | [V] |
| Checkout lets the customer retry | Checkout steps, "On Payment Failure" (callback URL) | "In case of failed payments, the checkout is displayed again to facilitate payment retry." | Retries happen inside one Checkout session | Whether a retry reuses the order (implied by the rows above, not stated here) | [V] |
| **Conflicting guidance** on merchant-side retries | Create order, "Watch Out: Create a new order for every payment attempt" | "A Razorpay Order ID maps 1:1 to a payment attempt." / "Reusing the previous order ID will cause an error." | When the *merchant* starts a new payment after a failure, it must create a new order | How this fits with `attempts` and Checkout retries | conflict, unresolved |
| No new payment after paid | Create order, response `status` | "No further payment requests are permitted once the order moves to the `paid` state." | A new attempt cannot start after capture | That an *earlier* attempt's event cannot arrive later | [V] |
| Webhooks can arrive out of order | Webhook best practices | "you may not always receive the webhooks in order." | Out-of-order delivery is documented | Any bound on how late | [V] |
| Payment event sequence is not fixed | Payment webhook events, Watch Out under the failed payload | "The webhook sequence is not fixed in the JSON payload for payment events." | The same, for payment events | — | [V] |
| Failed, then captured, for one transaction | Payment webhook events, Watch Out under the captured payload | "You may occasionally observe a `payment.failed` webhook followed by a `payment.captured` webhook for the same transaction." Causes named: late authorisation, and user-initiated retries (UPI) | `payment.failed` is not terminal; a capture may follow | The reverse order for one payment | [V] |
| Failed deliveries are retried for a day | Webhook best practices | "we retry the delivery in exponential backoff policy for 24 hours" | An event can arrive long after it happened | — | [V] |
| An earlier attempt's `payment.failed` delivered after a later attempt's `payment.captured` | — | — | Follows from: several attempts per order, out-of-order delivery, retries for 24 hours | Not described as a specific sequence | inference |

Scenario labels (updated 2026-10-14): several attempts per order and out-of-order delivery are [V]; sharing one
gateway order is unresolved; the exact sequence is an inference.

Conclusion: both scenario assumptions are documented (several attempts per order; out-of-order delivery). The
exact sequence the scenario sends is an inference from those facts. The create-order Watch Out conflicts with
the order entity and Checkout pages; the scenario models the Checkout-retry case (two payment ids on one
order), not a merchant-initiated retry. Implications for merchant logic: track state per payment id; never move
a paid order back because some payment on it failed; treat `payment.failed` as non-terminal, because a capture
of the same payment can follow (late authorisation). That last case (one payment, failed then captured) is
documented but no scenario models it yet.

## Webhook delivery, payload and signature (all scenarios; `harness/mock-razorpay.js`, `harness/delivery.js`)

| Claim | Source, heading | Quote | Mock today | Class |
|-------|-----------------|-------|------------|-------|
| Signature header, algorithm, key and message | Validate webhooks | passed "under the `X-Razorpay-Signature` header", "HMAC with SHA256", "with your webhook secret set as the key and the webhook request body as the message" | The same: HMAC-SHA256 of the body with the webhook secret, in `x-razorpay-signature` | [V] |
| Validate the raw body | Validate webhooks, "Do Not Parse or Cast the Webhook Request Body" | "Do not parse or cast the webhook request body." | The harness signs and sends exact bytes | [V] |
| The page's own Node sample re-serialises the body | Validate webhooks, code sample | `validateWebhookSignature(JSON.stringify(webhookBody), webhookSignature, webhookSecret)` followed by `#webhook_body should be raw webhook request body` | — | [V] (inconsistency inside the docs) |
| Duplicate deliveries are expected; dedupe by event id | Validate webhooks, "Idempotency"; Webhook best practices | "might receive the same webhook event multiple times"; `x-razorpay-event-id` "is unique per event" | A redelivery reuses the event id, body and signature (`harness/delivery.js`) | [V] |
| Any non-2xx is a failure; 5 second timeout; retries for 24 hours; disabled after 24 hours of failures | Webhook best practices | "Every event that receives a non-2xx response is considered an event delivery failure"; "fails to respond in 5 seconds"; "the webhook is disabled" | Not modelled: the harness never retries | [V] |
| Envelope and payment entity fields | Payment webhook events, "Payment Captured" sample | `entity`, `account_id`, `event`, `contains: ["payment"]`, `payload.payment.entity` with `id`, `amount`, `currency`, `status`, `order_id`, `captured`, `method`, `created_at` | Same top-level shape. The mock entity has `id`, `entity`, `amount`, `currency`, `status`, `order_id`, `method: 'upi'`, `captured`, and no `created_at` inside the entity | [V] shape; values [A] |
| Old secret after rotation | Validate webhooks | "use the old secret for webhook signature validation while retrying older requests" | Not modelled | [V] |
| Real deliveries match the samples | — | — | Never checked: no test-mode account | unverified |

## Remaining open questions

- Can an automatically captured payment, or a `payment.captured` event, carry an amount different from a
  non-partial order's amount? The pages read do not answer this.
- How does `partial_payment` work on Standard Checkout orders (minimum first payment, when the order becomes
  `paid`, event sequence)? The parameter is not described in the fetched parameter tables, and no dedicated page
  was found.
- How is the create-order Watch Out ("maps 1:1 to a payment attempt") meant to fit with `attempts` and
  Checkout retries? Only Razorpay support or test-mode observation can settle it.
- Do the payloads and headers of real test-mode deliveries match the documented samples and our mock?
