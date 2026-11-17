// Checkout, order status, history and the DPay webhook.

import { ApiError, assertSameOrigin, json, logEvent, nowIso, notConfigured, readJsonBody } from "./lib/http.js";
import { rateLimit } from "./lib/ratelimit.js";
import { newOrderId, parseIccid, parseIdempotencyKey, parseOrderId, parsePlanId } from "./lib/validate.js";
import { findPlan } from "./lib/plans.js";
import { getSimInfo } from "./lib/yesim.js";
import { createPaymentSession, dpayConfigured } from "./lib/dpay.js";
import { getTx, publicTx, requireDb } from "./lib/orders.js";

function publicBase(env, url) {
  const configured = (env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(configured) ? configured : url.origin;
}

function checkoutResponse(tx, status = 200) {
  return json({ orderId: tx.id, checkoutUrl: tx.checkout_url, amountPkr: tx.amount_pkr }, status);
}

/** POST /api/checkout — create a DPay payment session for a top-up. */
export async function handleCheckout(request, env, ctx, url) {
  assertSameOrigin(request);
  await rateLimit(env, ctx, request, "checkout", 6);
  const db = requireDb(env);
  const idemKey = parseIdempotencyKey(request.headers.get("idempotency-key"));
  const body = await readJsonBody(request);
  const iccid = parseIccid(body.iccid);
  const planId = parsePlanId(body.planId);
  if (!dpayConfigured(env) || !env.DPAY_WEBHOOK_SECRET || !env.YESIM_API_TOKEN || !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test((env.PUBLIC_BASE_URL || "").trim())) throw notConfigured("Online payment");

  // 1. Same Idempotency-Key → same order (double click, retry, refresh).
  const prior = await db.prepare("SELECT * FROM transactions WHERE idempotency_key = ?1").bind(idemKey).first();
  if (prior) {
    if (prior.iccid !== iccid || prior.plan_id !== planId) {
      throw new ApiError(409, "idempotency_conflict", "This request was already used for a different top-up. Please start again.");
    }
    if (prior.checkout_url && prior.payment_status === "pending") return checkoutResponse(prior);
    throw new ApiError(409, "checkout_in_progress", "This checkout could not be resumed. Please choose your plan again.");
  }

  // 2. Price and plan id always come from the sheet, never from the browser.
  const plan = await findPlan(env, planId, { fresh: true });
  if (!plan) throw new ApiError(404, "plan_unavailable", "That plan is no longer available. Please pick another one.");
  if (body.pricePkr !== undefined && Number(body.pricePkr) !== plan.pricePkr) {
    throw new ApiError(409, "price_changed", `The price of this plan changed to PKR ${plan.pricePkr.toLocaleString("en-US")}. Please review and confirm again.`);
  }

  // 3. Only sell top-ups for eSIMs that exist.
  const sim = await getSimInfo(env, iccid);
  if (!sim) throw new ApiError(404, "esim_not_found", "We couldn't find a Pak-Tel eSIM with that ICCID.");
  if (String(sim.is_deleted ?? "0") === "1") {
    throw new ApiError(409, "esim_deleted", "This eSIM has been removed and can't be topped up. Please contact support on WhatsApp.");
  }

  // 4. Duplicate-request protection across tabs/devices: reuse a still-open checkout for the
  //    same eSIM + plan + price, and cap how many unpaid checkouts one eSIM can open.
  const soon = new Date(Date.now() + 3 * 60 * 1000).toISOString();
  const open = await db.prepare(
    `SELECT * FROM transactions WHERE iccid = ?1 AND plan_id = ?2 AND amount_pkr = ?3 AND payment_status = 'pending'
       AND checkout_url IS NOT NULL AND expires_at > ?4 ORDER BY created_at DESC LIMIT 1`
  ).bind(iccid, planId, plan.pricePkr, soon).first();
  if (open) return checkoutResponse(open);

  const recent = await db.prepare(
    "SELECT COUNT(*) AS n FROM transactions WHERE iccid = ?1 AND payment_status IN ('pending','error') AND created_at > ?2"
  ).bind(iccid, new Date(Date.now() - 30 * 60 * 1000).toISOString()).first();
  if ((recent?.n || 0) >= 8) {
    throw new ApiError(429, "too_many_checkouts", "Too many unpaid checkouts for this eSIM. Please wait a few minutes or contact support.");
  }

  // 5. Record the order first, then create the DPay session.
  const orderId = newOrderId();
  const now = nowIso();
  const inserted = await db.prepare(
    `INSERT INTO transactions (id, idempotency_key, iccid, plan_id, plan_name, amount_pkr, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7) ON CONFLICT (idempotency_key) DO NOTHING`
  ).bind(orderId, idemKey, iccid, planId, plan.name, plan.pricePkr, now).run();
  if (inserted.meta.changes !== 1) {
    throw new ApiError(409, "checkout_in_progress", "Your checkout is already being prepared. Please wait a moment.");
  }

  let session;
  try {
    const base = publicBase(env, url);
    session = await createPaymentSession(env, {
      orderId,
      amountPkr: plan.pricePkr,
      description: `Pak-Tel eSIM top-up: ${plan.name}`,
      successUrl: `${base}/manage/?order=${orderId}`,
      cancelUrl: `${base}/manage/?order=${orderId}&cancelled=1`,
      metadata: { order_id: orderId, payment_kind: "full", plan_id: planId, iccid_last4: iccid.slice(-4) },
    });
    let checkout;
    try { checkout = new URL(session.checkout_url); } catch { checkout = null; }
    if (!/^[A-Za-z0-9_]{6,80}$/.test(session.id || "") || !checkout || checkout.protocol !== "https:" || session.order_id !== orderId || session.currency !== "PKR" || typeof session.livemode !== "boolean" || Number(session.amount) !== plan.pricePkr * 100) {
      throw new ApiError(502, "payment_service_error", "The payment service returned an unexpected response. Please try again.");
    }
  } catch (error) {
    await db.prepare("UPDATE transactions SET payment_status = 'error', updated_at = ?2 WHERE id = ?1").bind(orderId, nowIso()).run();
    throw error;
  }

  await db.prepare(
    `UPDATE transactions SET dpay_session_id = ?2, dpay_reference = ?3, checkout_url = ?4, expires_at = ?5, livemode = ?6, updated_at = ?7 WHERE id = ?1`
  ).bind(orderId, session.id, session.reference || null, session.checkout_url, session.expires_at || null, session.livemode ? 1 : 0, nowIso()).run();
  logEvent("checkout_created", { order: orderId, amount_pkr: plan.pricePkr });
  return json({ orderId, checkoutUrl: session.checkout_url, amountPkr: plan.pricePkr }, 201);
}

/** GET /api/orders/:id — payment + top-up status for one order. */
export async function handleOrderStatus(request, env, ctx, rawId) {
  await rateLimit(env, ctx, request, "order", 60);
  const id = parseOrderId(rawId);
  let tx = await getTx(env, id);
  if (!tx || tx.payment_status === "error") throw new ApiError(404, "order_not_found", "We couldn't find that order.");
  return json({ order: publicTx(tx) });
}

/** POST /api/transactions — history for one ICCID. */
export async function handleTransactions(request, env, ctx) {
  assertSameOrigin(request);
  await rateLimit(env, ctx, request, "history", 30);
  const body = await readJsonBody(request);
  const iccid = parseIccid(body.iccid);
  const { results } = await requireDb(env).prepare(
    "SELECT * FROM transactions WHERE iccid = ?1 AND payment_status != 'error' ORDER BY created_at DESC LIMIT 25"
  ).bind(iccid).all();
  return json({ transactions: results.map(publicTx) });
}
