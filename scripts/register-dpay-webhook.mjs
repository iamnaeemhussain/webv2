#!/usr/bin/env node
// One-off setup: registers the DPay webhook endpoint and prints its signing secret ONCE.
// Never run this from startup/deploy code. A 409 (already registered) stops without replacing,
// so an existing secret is never rotated out from under the running Worker.
//
//   DPAY_API_KEY=dpay_test_sk_... node scripts/register-dpay-webhook.mjs https://<your-domain>/api/webhooks/dpay

const url = process.argv[2];
const key = process.env.DPAY_API_KEY;
const base = (process.env.DPAY_API_BASE_URL || "https://api.dpay.com.pk/v1").replace(/\/+$/, "");
const EVENTS = ["payment.succeeded", "payment.failed", "payment.expired", "payment.ambiguous"];

if (!key) { console.error("Set DPAY_API_KEY in the environment (it is not stored anywhere)."); process.exit(1); }
if (!url || !/^https:\/\/[^/]+\/api\/webhooks\/dpay$/.test(url)) {
  console.error("Usage: node scripts/register-dpay-webhook.mjs https://<your-domain>/api/webhooks/dpay");
  process.exit(1);
}

const res = await fetch(`${base}/webhook_endpoints`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "user-agent": "myPakTel/1.0 (+https://pak-tel.com)" },
  body: JSON.stringify({ url, description: "my Pak-Tel portal", events: EVENTS }),
  signal: AbortSignal.timeout(15000),
});
let data = null;
try { data = await res.json(); } catch { /* non-JSON */ }

if (res.status === 409) {
  const id = data?.id || data?.endpoint?.id || data?.error?.endpoint?.id || "(see DPay dashboard)";
  console.log(`Already registered: endpoint ${id}. Nothing changed.`);
  console.log("If you lost the secret, rotate it deliberately in the DPay dashboard, then update DPAY_WEBHOOK_SECRET.");
  process.exit(0);
}
if (!res.ok || !data?.secret) {
  console.error(`DPay answered ${res.status}: ${data?.error?.code || "unexpected response"} ${data?.error?.message || ""}`);
  process.exit(1);
}
console.log(`Registered endpoint ${data.id} for ${url}`);
console.log(`Events: ${EVENTS.join(", ")}`);
console.log("\nSigning secret (shown once) — store it as the Worker secret DPAY_WEBHOOK_SECRET:\n");
console.log(data.secret);
