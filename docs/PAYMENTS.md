# Payments

Online payment runs through **PayPal**, **Revolut** or **Stripe**. All three are wired at once; `PAYMENT_PROVIDER` decides which one opens new payments.

## Three gateways, one ledger

Two rules, and they are deliberately different:

- A **new** payment goes to the configured provider. That is a deployment decision — change `PAYMENT_PROVIDER`, restart, done. No rebuild of the front-end: the browser is told which gateway to mount by the API, not by the build.
- An **existing** payment stays with the gateway holding the money. Refunds route by the payment's own `provider` column, never by configuration. Switching providers on Monday must not make Sunday's takings unrefundable, and asking Revolut to refund a Stripe charge is not a graceful failure — it is a 404 in front of a customer who is owed money.

Everything the three have in common — which bookings may be charged, what a capture does to a booking, replay safety, when tickets go out — lives once in `PaymentLedgerService`. A second copy of "mark the booking paid" is a second place to forget the expiry sweeper.

```
apps/api/src/modules/payments/
├── payments.service.ts          the façade: routes new payments and refunds
├── payment-ledger.service.ts    the booking-side rules, shared by all three
├── payment-intent.types.ts      the discriminated union the browser receives
├── stripe/                      stripe-payments.service.ts, stripe.provider.ts
├── revolut/                     revolut-payments.service.ts, revolut.client.ts,
│                                revolut-signature.ts
└── paypal/                      paypal-payments.service.ts, paypal.client.ts,
                                 paypal-signature.ts
```

## Turning it on

```bash
PAYMENT_PROVIDER=paypal            # paypal | revolut | stripe — where NEW payments go

# PayPal
PAYPAL_MODE=sandbox                # sandbox | live. Picks the API host AND the browser SDK
PAYPAL_CLIENT_ID=A…                # handed to the browser by the API
PAYPAL_CLIENT_SECRET=E…            # server-side only. Never leaves the API
PAYPAL_WEBHOOK_ID=WH-…             # from the webhook you register. Not a signing key

# Revolut
REVOLUT_API_URL=https://sandbox-merchant.revolut.com   # merchant.revolut.com when live
REVOLUT_SECRET_KEY=sk_…            # server-side only. Never leaves the API
REVOLUT_PUBLIC_KEY=pk_…            # handed to the browser by the API
REVOLUT_WEBHOOK_SECRET=wsk_…       # from the webhook you register (comma-separate to rotate)

# Stripe
STRIPE_SECRET_KEY=sk_test_…
STRIPE_PUBLISHABLE_KEY=pk_test_…
STRIPE_WEBHOOK_SECRET=whsec_…
```

**With no credentials for the selected provider the payment routes answer `503` and everything else runs normally.** That is the state development and CI run in, and it is covered by tests. Sandbox keys exercise the whole flow.

`REVOLUT_API_URL` also decides which Revolut the _widget_ talks to — the environment is derived from the host rather than configured separately, because the two must agree and a token minted in sandbox is meaningless to production.

---

## PayPal

Reference: [Orders v2](https://developer.paypal.com/docs/api/orders/v2/). No API version header — PayPal versions in the path (`/v2/checkout/orders`) and keeps old paths working, which is why this client pins nothing the way the Revolut one has to.

### Setup

1. PayPal **Business** account.
2. Developer Dashboard → **Apps & Credentials** → create a REST app. Take the **Client ID** and **Secret** — sandbox first. Sandbox and live are separate apps with separate credentials; a sandbox secret is refused by the live host and the reverse.
3. Same app → **Webhooks** → Add Webhook, pointing at `https://<api-host>/api/v1/payments/webhook/paypal`, subscribed to the events below. **Copy the Webhook ID it shows** into `PAYPAL_WEBHOOK_ID` — without it every event is refused, because it is what the signature is verified against.

The webhook URL must be publicly reachable, so `localhost` will not do. For local work, tunnel it:

```bash
cloudflared tunnel --url http://localhost:4000     # or: ngrok http 4000
# register https://<tunnel-host>/api/v1/payments/webhook/paypal
```

### Going live

Four values move together, and three of the four are easy to leave behind:

| Value                  | Sandbox                  | Live                                     |
| ---------------------- | ------------------------ | ---------------------------------------- |
| `PAYPAL_MODE`          | `sandbox`                | `live`                                   |
| `PAYPAL_CLIENT_ID`     | the sandbox app's        | the **live** app's — a different app     |
| `PAYPAL_CLIENT_SECRET` | the sandbox app's        | the live app's                           |
| `PAYPAL_WEBHOOK_ID`    | the sandbox webhook's id | a webhook registered on the **live** app |

A webhook id is not portable between the two. Carrying the sandbox one over leaves an endpoint that refuses every live event it is sent — which does not stop a payment (the capture is confirmed by this server's own call to PayPal), but does mean refunds, disputes and reversals never post back, so the bookings behind them silently stop matching PayPal.

Only the API reads any of these, and the client id reaches the browser through the payment-intent response rather than a build-time variable — so the switch is an API restart, not a front-end rebuild.

Two things live *only* in PayPal's settings and no order can override them:

- **The name on the buyer's activity row** is the business name on the receiving account (Account Settings → Business Information). A sandbox business test account ships as "John Doe's Test Store"; a live account shows whatever the business is registered as.
- **Which currencies settle.** Bookings are charged in EUR or USD without conversion, so the live account has to accept both.

### Events

| Event                       | What it does here                                                            |
| --------------------------- | ---------------------------------------------------------------------------- |
| `PAYMENT.CAPTURE.COMPLETED` | Reads the order back, then confirms the booking and emails the tickets       |
| `CHECKOUT.ORDER.APPROVED`   | Captures an order the buyer approved but the browser never came back to take |
| `PAYMENT.CAPTURE.PENDING`   | Logged only — PayPal is holding it for review, and the completion follows    |
| `PAYMENT.CAPTURE.DENIED`    | Records the decline; the booking stays pending so it can be retried          |
| `PAYMENT.CAPTURE.REVERSED`  | Records the reversal against the payment                                     |
| `PAYMENT.CAPTURE.REFUNDED`  | Folds the refund into the original capture's payment, once                   |

Anything else is acknowledged and ignored.

### Signature verification

PayPal does not sign with a shared secret. It signs with a certificate and the verdict comes from `POST /v1/notifications/verify-webhook-signature`, so the check is a round trip rather than an HMAC.

| Step       | Rule                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| Headers    | `PayPal-Auth-Algo`, `PayPal-Cert-Url`, `PayPal-Transmission-Id`, `-Sig`, `-Time` — all five   |
| Pre-check  | `cert_url` host must be exactly `api.paypal.com` or `api.sandbox.paypal.com`, over `https`    |
| Payload    | The exact bytes sent, spliced into the verification document — never a re-serialised object   |
| Verdict    | PayPal's `verification_status`; anything but `SUCCESS`, including a failed call, is a refusal |
| Missing id | No `PAYPAL_WEBHOOK_ID` means no event can be authenticated, so the endpoint answers `503`     |

The raw body matters for the same reason it does with Stripe and Revolut: re-serialising the parsed event reorders keys and reformats numbers, PayPal computes a different digest, and a genuine event is rejected. So the body is validated as JSON and then interpolated verbatim; the header values around it go through `JSON.stringify`, because they arrive from the request and a stray quote must not be able to reshape the document.

The `cert_url` check is not redundant with the API call. PayPal — not this server — dereferences that URL, so an unchecked value would let anyone who learns the webhook URL point PayPal's fetcher wherever they liked. An exact host match, never a suffix test: `api.paypal.com.attacker.test` ends with the right string.

### Why capture is allowed to confirm a booking

This is the one place PayPal departs from the rule the other two exist to enforce, and it is worth stating plainly.

With Revolut the browser is told the payment succeeded, and that claim is worth nothing — so only the signed webhook confirms. With PayPal the browser never makes the claim. Approval only lets **this server** call `POST /v2/checkout/orders/{id}/capture`, and it is that response — read over an authenticated connection, from PayPal, by the API — that says the money moved. The browser is a trigger, not a witness.

```
Avoid:      Browser → PayPal → browser says success → mark order paid
This does:  Browser → API → PayPal Orders API → verified result → database
```

So there are two ways in and both are safe:

- the capture call, when the traveller stays on the page; and
- `PAYMENT.CAPTURE.COMPLETED`, when they close the tab mid-flow, the capture response is lost on the wire, or PayPal completes a payment it had held for review.

They converge on `ledger.markPaid`, which is conditional on the payment not already being `PAID` — so whichever arrives second writes nothing and sends no second email.

Three things are checked before a booking is confirmed, and every one comes from PayPal or from this application's own records:

1. the order is one this server opened **for this booking** — otherwise a crafted request could settle a booking with somebody else's order;
2. PayPal reports the capture `COMPLETED` — `APPROVED` is not paid, and `PENDING` is a real outcome that leaves the booking waiting; and
3. the captured amount **and** currency are what the booking is owed.

### Order reuse and repricing

A traveller who reloads the payment page must not strand a second order. The stored order is read back and reused while it is `CREATED`, `APPROVED` or `PAYER_ACTION_REQUIRED`.

| Situation                        | What happens                                                             |
| -------------------------------- | ------------------------------------------------------------------------ |
| Same amount and currency         | Reused                                                                   |
| Amount changed, order `CREATED`  | `PATCH`ed to the new amount                                              |
| Amount changed, order `APPROVED` | Abandoned; a fresh order is opened                                       |
| Currency changed                 | Abandoned — that is a different sale, not a reprice                      |
| Order already `COMPLETED`        | Applied to the booking, and the intent call then reports it already paid |

The `APPROVED` row is the one worth explaining: an approved order carries the buyer's consent to a **figure**. Repricing it behind them would charge an amount nobody agreed to, which is worth ruling out even at the cost of a second order.

The `COMPLETED` row is a repair. The money is already there and something — a lost capture response, a webhook still in flight — left the booking behind it unpaid. Opening a second order would ask for it twice.

### Refunds

A PayPal refund is made against the **capture**, not the order. So `Payment.transactionId` holds the capture id, and it is also how a `PAYMENT.CAPTURE.REFUNDED` event finds its way back to the payment — the event names the refund and the capture, and has never heard of the order id this application indexed on.

Like Revolut, PayPal reports one refund's amount rather than a running total, so `appliedRefundIds` is what stops a replay counting the same refund twice.

---

## Revolut

Reference: [Merchant API](https://developer.revolut.com/docs/merchant/merchant-api). Pinned to API version **`2024-09-01`**, the one in which the public order identifier became `token`. Revolut ships breaking changes behind dated versions; leaving it unset would let a change on their side alter this application's behaviour with no deploy.

### Setup

1. Revolut **Business** account with the Merchant API enabled.
2. Merchant API → API keys. Take the **secret** and **public** keys — sandbox first.
3. Register a webhook pointing at `https://<api-host>/api/v1/payments/webhook/revolut`, subscribed to the events below. Keep the signing secret it returns.

The webhook URL must be publicly reachable, so `localhost` will not do. For local work, tunnel it:

```bash
cloudflared tunnel --url http://localhost:4000     # or: ngrok http 4000
# register https://<tunnel-host>/api/v1/payments/webhook/revolut
```

### Events

| Event                                             | What it does here                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| `ORDER_COMPLETED`                                 | Reads the order back, then confirms the booking and emails the tickets |
| `ORDER_AUTHORISED`                                | Same path — applied only if the read-back says `completed`             |
| `ORDER_PAYMENT_FAILED` / `ORDER_PAYMENT_DECLINED` | Records the decline; the booking stays pending so it can be retried    |
| `ORDER_CANCELLED`                                 | Records the cancellation against the payment                           |
| `REFUND_COMPLETED`                                | Folds the refund into the original order's payment, once               |

Anything else is acknowledged and ignored — returning an error would make Revolut retry an event this application has no opinion about.

### Signature verification

The signature **is** the authentication for that endpoint. Without it, anyone who learns the URL can post `{"event":"ORDER_COMPLETED","order_id":"…"}` and mark a booking paid, so it is checked before the payload is parsed and before a single row is read.

| Step       | Rule                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------- |
| Payload    | `<version>.<timestamp>.<raw body>` — the exact bytes sent, not a re-serialised object         |
| Algorithm  | HMAC-SHA256 with the signing secret, hex-encoded                                              |
| Headers    | `Revolut-Signature` (may carry several entries), `Revolut-Request-Timestamp`                  |
| Freshness  | 5-minute tolerance, and a future timestamp is rejected too                                    |
| Comparison | Constant-time, after a length check                                                           |
| Rotation   | `REVOLUT_WEBHOOK_SECRET` accepts a comma-separated list; any secret matching any entry passes |

Rejecting a stale timestamp is what stops a captured payload being replayed forever.

### A webhook is a trigger, not proof

This is Revolut's own guidance and it is worth stating plainly: the event carries an order id and nothing else worth trusting. Every completion event therefore causes the order to be **read back over the API**, and the booking is only confirmed when Revolut itself reports:

- `state` is `completed`, **and**
- `amount` and `currency` match what the booking is owed.

A completed order for the wrong figure is not a paid booking. If the read-back fails, nothing is applied and the event is left for Revolut to retry — confirming a booking on an event this server could not corroborate is exactly the failure the read-back exists to prevent.

---

## Stripe

For local development, forward Stripe's events and use the secret it prints:

```bash
stripe listen --forward-to localhost:4000/api/v1/payments/webhook
stripe trigger payment_intent.succeeded
```

In production, add an endpoint in the Stripe dashboard at `https://<api-host>/api/v1/payments/webhook` — the original path, deliberately unchanged so an existing configuration does not have to be touched when Revolut is switched on beside it.

| Event                           | What it does here                                                   |
| ------------------------------- | ------------------------------------------------------------------- |
| `payment_intent.succeeded`      | Confirms the booking, clears the expiry, emails the tickets         |
| `payment_intent.payment_failed` | Records the decline; the booking stays pending so it can be retried |
| `charge.refunded`               | Mirrors a refund — including one made in the Stripe dashboard       |

Each gateway has its **own** endpoint rather than one that sniffs them apart by header. The signature scheme is the authentication, and a single endpoint guessing which one to apply is one bad guess away from accepting an unsigned payload.

---

## The flow

```
GET  /checkout/payment-methods   →  which methods are on offer at all
checkout  →  booking created (PENDING, held 30 min for an online method)
          →  POST /checkout/:reference/payment-intent
                 paypal  → { provider, orderId, clientId, environment, amountMinor, currency }
                 revolut → { provider, token, publicKey, environment, amountMinor, currency }
                 stripe  → { provider, clientSecret, publishableKey, amountMinor, currency }
          →  browser pays the gateway directly            ← card details stop here
          →  paypal  : POST /checkout/:reference/paypal/capture  → API captures, verifies, confirms
             others  : gateway → POST /payments/webhook[/revolut] → booking CONFIRMED
          →  every gateway's webhook is the backstop     → tickets emailed
          →  /booking-confirmed polls GET /checkout/:reference/status
```

The intent response is a **discriminated union** on `provider`. The three gateways genuinely need different things in the browser — Stripe mounts Elements against a client secret, Revolut mounts its pop-up against an order token, PayPal mounts its buttons against an order id — and flattening them into one optional-everything object would only move the branch out of the type system and into a runtime guess.

`GET /checkout/payment-methods` exists so the form never offers a gateway with no credentials. That is how `CARD` used to produce bookings that dead-ended on a `503` payment screen and were swept away half an hour later, and the browser has no other way to know — the credentials deliberately never leave the server.

### What may confirm a booking

A browser redirect can be lost, replayed or forged, so a browser's **claim** never confirms a booking. What counts is something this server heard from the gateway itself:

- a signed webhook, for every gateway; or
- for PayPal, the response to this server's own capture call — see [Why capture is allowed to confirm a booking](#why-capture-is-allowed-to-confirm-a-booking).

Stripe and Revolut have no equivalent of the second, so for them the webhook is the only way in. Either way the payment page hands off to the confirmation screen, which asks the API what it believes. The gap is real and usually a second or two; the page says "Confirming your payment…" during it rather than guessing.

### Card details never reach this server

All three gateways exchange them for a token inside a window they serve themselves. Nothing card-shaped is posted to the API, which keeps the deployment out of PCI scope. **Do not add a field that accepts a card number.**

---

## Idempotency and replay safety

All three gateways retry webhooks, and travellers double-click.

| Risk                                | Guard                                                                                                                                    |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Two payments open for one booking   | Stripe: `idempotencyKey: booking-intent-<id>`. Revolut and PayPal: the stored order is retrieved and reused while it can still be paid   |
| A replayed capture event            | The update is conditional on the payment not already being `PAID`; a replay writes nothing and sends no second email                     |
| A late failure after capture        | Ignored when the payment is already `PAID`                                                                                               |
| A retried refund call               | Stripe: `idempotencyKey` covering the payment, its refunded total and the amount. PayPal: `PayPal-Request-Id: refund-<capture>-<amount>` |
| A double-clicked PayPal capture     | `PayPal-Request-Id: capture-<order>`, and an `ORDER_ALREADY_CAPTURED` refusal is resolved by reading the order back                      |
| A replayed refund event             | `Payment.appliedRefundIds` records each refund id already folded in; a second sighting is a no-op                                        |
| Two payment rows for one gateway id | `Payment.providerIntentId` is unique at the database level                                                                               |
| A stale gateway id after a switch   | Reuse requires the stored `provider` to match; a Stripe intent id is never handed to Revolut or PayPal, or any other pairing             |
| A PayPal order settled twice        | The capture path refuses an order that is not the one opened for that booking, and short-circuits when the payment is already `PAID`     |

A payment whose booking was edited afterwards is **repriced**, not reused as-is — Stripe by updating the intent, Revolut and PayPal by `PATCH`ing the order. Otherwise an admin adding a tour would leave the traveller paying the old, lower amount, or paying into an order the API had stopped listening for. PayPal adds one condition the others do not need: an order the buyer has already **approved** is abandoned rather than repriced, because approval was consent to a figure.

Revolut and PayPal need one extra guard Stripe does not: Stripe reports a cumulative `amount_refunded`, so it can simply be stored, while the other two report one refund's amount at a time. A running total only exists if this side keeps one — hence `appliedRefundIds`, without which a replayed webhook would refund the customer twice on paper.

---

## Refunds

`POST /admin/payments/:id/refund`, **ADMIN only** — an editor manages content, not money. Omit `amountMinor` to refund whatever is still refundable.

The endpoint calls the gateway and then **stops**. The local record is written by the resulting webhook (`charge.refunded` / `REFUND_COMPLETED` / `PAYMENT.CAPTURE.REFUNDED`), so a refund issued here and one issued from the gateway's own dashboard travel exactly the same path and cannot disagree.

A partial refund leaves the payment `PAID` with a non-zero `refundedAmount`; only a full refund becomes `REFUNDED`.

Only the provider is read before routing. Whether the payment may actually be refunded is the chosen gateway's own first question, asked after it has checked it is configured at all — so an unconfigured environment answers "not configured" rather than a verdict about the payment, which would be a lie.

---

## Database

Migration `20260809120000_add_payment_provider` added two columns to `payments`:

| Column             | Why                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `provider`         | `STRIPE` \| `REVOLUT` \| `PAYPAL`. Existing rows backfill to `STRIPE`, which is what they are |
| `appliedRefundIds` | Refund ids already folded into `refundedAmount`, so replays are harmless                      |

Migration `20260920120000_add_paypal_provider` adds `PAYPAL` to the enum. Nothing is backfilled — `provider` is recorded per payment when it is opened, and every existing row already names the gateway it belongs to.

Run `pnpm --filter @pasta/api db:deploy` on each environment **before** the new code starts. A Postgres enum value cannot be added and used in the same transaction, so this is a deploy-then-start, not a start-then-deploy.

`Payment.transactionId` now carries a second meaning worth knowing: the gateway's id for the money itself, as distinct from the intent to take it — a Stripe charge, a Revolut order, a PayPal **capture**. A PayPal refund is made against the capture, so it is also the route a refund event takes back to the payment.

The admin panel shows the gateway under the method on the Payments table, and as **Processed By** on the booking's payment panel. With several gateways live at once, "Card" no longer says where the money is — and an operator chasing a refund needs to know which dashboard to open.

---

## Switching providers

```bash
PAYMENT_PROVIDER=stripe   # or revolut, or paypal
```

Restart the API. That is the whole change. Bookings part way through a payment on the old provider start again on the new one — their stored gateway id is recognised as belonging elsewhere and ignored, rather than handed to a gateway that has never heard of it.

Reverting is the same one line, which is why Stripe is kept wired rather than deleted.

---

## What is not built

- **Wallets and redirect methods** (Apple Pay, Google Pay, Revolut Pay, Pay by Bank, iDEAL, Klarna). Stripe is `payment_method_types: ['card']` and Revolut uses the card pop-up. Redirect methods return to a URL this application does not yet handle, which would strand travellers mid-payment. PayPal is `components: 'buttons'` for the same reason — its Advanced Card Fields are a separate onboarding and bring PCI SAQ obligations with them.
- **Manual capture.** Revolut orders use `capture_mode: 'automatic'` and PayPal orders `intent: 'CAPTURE'` — the seats are committed when the booking is made, so there is nothing to authorise now and capture later.
- **Automatic cancellation on refund.** A refund does not cancel the booking or release seats — that is an operator's decision, and cancelling is already one click away.
- **Multi-currency capture.** Bookings are priced in EUR or USD and charged in that currency; there is no conversion. Confirm the merchant account settles in both before going live.
- **Webhook registration from code.** Every webhook is created by hand in the respective dashboard. For PayPal that also means the Webhook ID has to be copied back into `PAYPAL_WEBHOOK_ID` — the application cannot discover it.
- **PayPal disputes.** `CUSTOMER.DISPUTE.*` events are acknowledged and ignored. A dispute is an operator's problem, handled in the PayPal dashboard, and nothing here would be improved by writing a row about it.

---

## Testing without an account

Every rule above is verified in CI with no credentials:

| File                                                | Covers                                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments/stripe/stripe-payments.service.spec.ts`   | Intent reuse, replay safety, refund arithmetic, signature rejection                                                                             |
| `payments/revolut/revolut-payments.service.spec.ts` | Order reuse and repricing, read-back before confirming, amount mismatch, refund idempotency                                                     |
| `payments/revolut/revolut-signature.spec.ts`        | Forged signatures, tampered bodies, stale and future timestamps, secret rotation                                                                |
| `payments/paypal/paypal-payments.service.spec.ts`   | Order reuse and repricing, the approved-order refusal, capture verification and the wrong-booking refusal, decline handling, refund idempotency |
| `payments/paypal/paypal-signature.spec.ts`          | Certificate-host spoofing, incomplete transmission headers                                                                                      |
| `test/payments.e2e-spec.ts`                         | The unconfigured environment: routes reachable, authorisation enforced, `503` not `500`, PayPal not offered at checkout                         |

```bash
pnpm --filter @pasta/api test
```

Once keys are in place, Stripe's test cards:

| Number                | Result                        |
| --------------------- | ----------------------------- |
| `4242 4242 4242 4242` | Succeeds                      |
| `4000 0000 0000 9995` | Declined — insufficient funds |
| `4000 0025 0000 3155` | Requires 3-D Secure           |

For Revolut, use the sandbox cards from [Simulate payments](https://developer.revolut.com/docs/guides/merchant/test-and-go-live/testing/simulate-payments) — they are account-specific and are not reproduced here.

For PayPal, Developer Dashboard → **Testing Tools → Sandbox Accounts** gives a business account (the merchant) and a personal one (the buyer). Sign in as the personal account in the PayPal window. The whole lifecycle is worth walking once before going live:

| Case                  | How                                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| Successful payment    | Approve as the sandbox personal account                                                             |
| Customer cancellation | Close the PayPal window — the booking must stay held, not fail                                      |
| Duplicate request     | Double-click the button; one capture, one email                                                     |
| Webhook delivery      | Developer Dashboard → your app → Webhooks → **Webhook Events**, which replays a delivery            |
| Browser never returns | Approve, then kill the tab before the capture call lands — `CHECKOUT.ORDER.APPROVED` must finish it |
| Refund                | Refund from the PayPal dashboard; the local row must mirror it                                      |

Check after each that `payments.status`, `payments.transactionId`, `bookings.status` and `bookings.paymentStatus` say what you expect, and that the amount and currency match.
