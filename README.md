# Pak-Tel storefront and eSIM portal

Cloudflare Worker serving the Pak-Tel storefront at `/` and the existing-eSIM portal at `/manage/`. Both read the same Google Sheet and use the server's plan IDs and PKR prices. New eSIM checkout uses DPay, Yesim and Brevo; top-ups use DPay and Yesim.

**Not production-ready without configuration and provider verification.** The new-eSIM checkout switch is enabled (`ENABLE_NEW_ESIM_SALES = "true"`), but checkout remains unavailable until its required runtime secrets, HTTPS origin and verified sender are configured. Provider APIs and actual payment/activation/email delivery have not been tested with real credentials. Keep production checkout disabled until the deployment and operational checks below are complete.

## Payment and fulfilment

1. Checkout re-reads the catalogue, checks the displayed price, records an order and creates a DPay session using the order ID as its idempotency key. The return URL is **not** payment evidence.
2. `POST /api/webhooks/dpay` verifies the raw-body HMAC and timestamp, then durably inserts a minimal event into D1 before responding. It does not contact DPay, Yesim or Brevo. Duplicate event IDs are ignored. A storage failure returns 503 for DPay to retry rather than falsely acknowledging the event. The handler has a seven-second storage deadline, but actual delivery latency depends on the platform and network; monitor the 10-second requirement in production.
3. A scheduled Worker (every minute) matches the signed event's order, session, amount, currency when present, and live/test mode. Only `payment.succeeded` with a succeeded session can mark an order paid. Late successful payments are honoured. A status-page visit or API lookup **never** initiates fulfilment.
4. The scheduler claims each paid order atomically. For a new eSIM it calls Yesim `GET /new_esim` with the purchased `plan_id` and order reference as `payment_id`. It validates that the returned `active_plan_id` matches and stores the ICCID and LPA activation code. Yesim's documentation shows that `plan_activated_at` may still be null even when `active_plan_id` is set; the actual validity start depends on the provider and plan.
5. A separate claimed step generates a QR GIF and sends it as a Brevo transactional email attachment. `sent` means Brevo accepted the request, **not** that the email was delivered. Track delivery separately with Brevo if needed. Top-ups use the existing `/add_plan_iccid` flow.

Any uncertain issuance, top-up or email outcome, or a stale in-progress claim, goes to `review`. Never blindly retry an external operation after a timeout or crash: it may already have succeeded. This prevents automatic duplicate issuance, but is not a guarantee of exactly-once execution across provider failures. Investigate Yesim using the order reference and Brevo before manually resolving. Provide a support/refund process and alerts before taking payments.

The return page shows only generic status; it does not expose QR codes or email addresses. The original portal's ICCID-only lookup no longer returns installation codes, since an ICCID is not sufficient authentication for a transferable eSIM. Existing lookup and history still expose account information to someone who knows an ICCID; add customer authentication before treating them as private. The public Google Sheet itself may expose its other columns to anyone with the link even though the API returns only selected columns; move sensitive commercial data to a private source or separate sheet.

## Setup

1. Run `npm ci`. Create or select a Cloudflare D1 database, bind it as `DB` in `wrangler.toml` (pin its `database_id` to the intended database), and apply **both** migrations with `npm run db:migrate`. Take a backup before pointing at the existing `my-pak-tel` database. Deploying this Worker does not automatically migrate or replace the old Worker or domain routes.
2. Confirm `PUBLIC_BASE_URL` is the exact canonical HTTPS origin for your deployment (it defaults to `https://pak-tel.com`) and set `BREVO_SENDER_EMAIL` to a sender verified in Brevo. Confirm the sheet columns A (name), B (whole PKR price), C–H (display details) and M (Yesim plan ID) and that every listed plan is valid for new issuance. Checkout fails closed if the sheet or columns are unavailable.
3. Add Worker **runtime secrets**, never build variables or browser code: `YESIM_API_TOKEN`, `DPAY_API_KEY`, `DPAY_WEBHOOK_SECRET`, `BREVO_API_KEY`. Do not paste credentials into chat or commit them. Secrets must also be present for top-up checkout.
4. Register `https://<canonical-host>/api/webhooks/dpay` with DPay for `payment.succeeded`, `payment.failed`, `payment.expired`, and `payment.ambiguous`, and store its signing secret. The one-off helper is `npm run dpay:webhook -- https://<canonical-host>/api/webhooks/dpay`; see the DPay dashboard for secret handling. Send a signed `test.ping` and confirm 200. Migrations must be applied **before** real webhook events arrive.
5. Ensure the deployed Worker has the cron trigger and D1 binding. Monitor pending/review inbox events, paid-but-unissued orders, failed email delivery, stale claims, Yesim partner balance and DPay webhook retries. DPay retries are finite; investigate missed webhooks rather than fulfilling based on a redirect or a status-page visit.
6. Before allowing customers to pay, test with real provider credentials and an explicitly authorised low-value payment, verify the eSIM's plan, QR and email delivery, and confirm refund/support procedures. Set `ENABLE_NEW_ESIM_SALES = "false"` in the production environment until these checks are complete; then set it to `"true"` and redeploy. DPay test keys may still involve real bank transfers.

### Secret and data handling

Yesim requires the token in the **outgoing query string**. Code does not log the URL, upstream error messages, raw event payloads, QR data or credentials. Observability is disabled in `wrangler.toml`; verify any Cloudflare, proxy, tracing, audit or external monitoring configuration redacts `token` query parameters before enabling it. Never capture full Yesim request URLs. D1 contains buyer emails, ICCIDs and LPA codes; restrict access, protect backups and establish retention/deletion policies. Brevo receives the activation code and recipient address to deliver the purchased product.

Useful operational queries (do not publish their output or full sensitive records):

```sql
SELECT id, payment_status, fulfilment_status, email_status, updated_at
FROM new_esim_orders
WHERE payment_status = 'review' OR (payment_status = 'paid' AND (fulfilment_status != 'issued' OR email_status != 'sent'));

SELECT event_id, type, order_id, state, received_at FROM payment_inbox WHERE state != 'done';
```

Use authenticated Cloudflare tooling to inspect records. `review` is intentionally not retried automatically. Define and document authorised reconciliation procedures before launch; changing database states without confirming provider outcomes can duplicate eSIMs or emails.

## Local development and tests

```bash
npm ci
npm run db:migrate:local
npm run dev
npm test
```

For local real-provider development, copy `.dev.vars.example` to `.dev.vars` and set secrets locally; do not commit it. Cron triggers do not run automatically in Wrangler local development. `npm test` starts the real Worker with local D1 and mock sheet, DPay, Yesim and Brevo. It tests checkout pricing/idempotency, forged webhooks, redirect safety, durable processing, duplicates, failure review and top-ups. The test endpoints do not charge money. Local preview may not reach Google Sheets or provider hosts due to network restrictions. To browse a read-only preview when Google Sheets is unreachable, run `npm run dev -- --var PREVIEW_CATALOGUE:true` (add `--var FRAME_ANCESTORS:*` only for an embedded preview). This explicitly enables a snapshot of the public Sheet1 captured on 2026-11-17, labelled as such in the UI. It is not live and may become outdated. If the sheet becomes reachable the preview uses the live sheet again. Both DPay checkout endpoints remain disabled whenever preview mode is enabled, even with secrets configured. Customers can still select a plan and use the separate WhatsApp button to request manual checkout; snapshot prices are explicitly labelled and the team must confirm the current price. Never enable `PREVIEW_CATALOGUE` in production; without it, a failed sheet read fails closed and checkout always re-reads Sheet1 from the server.

Source origins: storefront from `iamnaeemhussain/pak-tel` branch `arena/01a03356-pak-tel` (commit `94132d4`); portal from `iamnaeemhussain/my` main (commit `f7fc8ffd`). Provider contracts: [Yesim](https://documenter.getpostman.com/view/19324374/2sA3kbgy28), [DPay](https://dpay.com.pk/docs), [Brevo](https://developers.brevo.com/reference/send-transac-email).

### Dynaura notifications

The frontend is plain HTML and JavaScript, not React or Next.js. It uses the official zero-dependency `dynaura/vanilla` adapter (`createToaster` and `dynaura`) with the no-font stylesheet and a Pak-Tel theme. The adapter and its MIT license are served locally from `public/vendor/dynaura`, so no CDN or extra font request is needed. The optional bridge in `public/notifications.js` leaves the existing inline messages and navigation working if the adapter fails to load. After deliberately upgrading the pinned npm package, run `npm run vendor:dynaura` and commit the updated static files and license with the lockfile.

A DPay redirect is only a hint. Payment-success toasts appear only when the server's recorded order state reports a verified payment. Email acceptance is not proof of delivery. Customers can choose automatic DPay payment or a separate manual WhatsApp order handoff. The WhatsApp message includes the selected plan and displayed price, asks the team to confirm it, and does not include the email entered for DPay. Manual orders are not automatically paid or fulfilled by this system.
