// Transaction records (D1) and the paid → top-up fulfilment state machine.

import { ApiError, logEvent, nowIso } from "./http.js";

export function requireDb(env) {
  if (!env.DB) throw new ApiError(503, "not_configured", "The portal database is not configured yet. Please contact support.");
  return env.DB;
}

export const getTx = (env, id) => requireDb(env).prepare("SELECT * FROM transactions WHERE id = ?1").bind(id).first();

/** Customer-facing state derived from payment + top-up status. */
export function deriveState(tx, now = Date.now()) {
  if (tx.payment_status === "paid") {
    if (tx.topup_status === "success") return "completed";
    if (tx.topup_status === "failed") return "topup_failed";
    if (tx.topup_status === "review") return "review";
    // processing / not_started: if it has been stuck for 5 minutes a human should look at it.
    return now - new Date(tx.updated_at).getTime() > 5 * 60 * 1000 ? "review" : "processing";
  }
  switch (tx.payment_status) {
    case "pending":
      return tx.expires_at && now > new Date(tx.expires_at).getTime() + 2 * 60 * 1000 ? "expired" : "awaiting_payment";
    case "expired": return "expired";
    case "cancelled": return "cancelled";
    case "review": return "review";
    default: return "payment_failed"; // failed | error
  }
}

export function publicTx(tx) {
  const state = deriveState(tx);
  return {
    orderId: tx.id,
    iccid: tx.iccid,
    planName: tx.plan_name,
    planId: tx.plan_id,
    amountPkr: tx.amount_pkr,
    paymentStatus: tx.payment_status === "pending" && state === "expired" ? "expired" : tx.payment_status,
    topupStatus: state === "review" && tx.payment_status === "paid" ? "review" : tx.topup_status,
    topupVerified: tx.topup_verified === 1,
    state,
    createdAt: tx.created_at,
    paidAt: tx.paid_at,
    topupAt: tx.topup_at,
    checkoutUrl: state === "awaiting_payment" ? tx.checkout_url : null,
  };
}

/** A DPay session proves payment for this order only if every one of these matches. */
export function sessionMatchesTx(session, tx) {
  return Boolean(session) && session.status === "succeeded" &&
    session.order_id === tx.id &&
    Number(session.amount) === tx.amount_pkr * 100 &&
    (!session.currency || session.currency === "PKR") &&
    (!tx.dpay_session_id || session.id === tx.dpay_session_id);
}

export function setPaymentStatus(env, id, status, onlyFrom) {
  const marks = onlyFrom.map((_, i) => `?${i + 4}`).join(",");
  return env.DB.prepare(
    `UPDATE transactions SET payment_status = ?2, updated_at = ?3 WHERE id = ?1 AND payment_status IN (${marks})`
  ).bind(id, status, nowIso(), ...onlyFrom).run();
}
