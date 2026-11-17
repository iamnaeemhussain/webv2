// DPay client (https://api.dpay.com.pk/v1) + webhook signature verification.
// Auth: `Authorization: Bearer <DPAY_API_KEY>` — server side only.

import { ApiError, fetchWithTimeout, logEvent, notConfigured } from "./http.js";

const USER_AGENT = "myPakTel/1.0 (+https://pak-tel.com)"; // DPay asks for a named client

function baseUrl(env) {
  return (env.DPAY_API_BASE_URL || env.DPAY_API_BASE || "https://api.dpay.com.pk/v1").replace(/\/+$/, "");
}

export function dpayConfigured(env) {
  return typeof env.DPAY_API_KEY === "string" && env.DPAY_API_KEY.trim().length > 0;
}

function authHeaders(env) {
  if (!dpayConfigured(env)) throw notConfigured("Online payment");
  return { authorization: `Bearer ${env.DPAY_API_KEY.trim()}`, accept: "application/json", "user-agent": USER_AGENT };
}

async function request(env, method, path, { body, idempotencyKey } = {}) {
  const headers = authHeaders(env);
  if (body) headers["content-type"] = "application/json";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  let response;
  try {
    response = await fetchWithTimeout(baseUrl(env) + path, { method, headers, body: body ? JSON.stringify(body) : undefined }, 15000);
  } catch {
    throw new ApiError(502, "payment_service_unreachable", "The payment service did not respond. Please try again in a moment.");
  }
  let data = null;
  try { data = await response.json(); } catch { /* e.g. an HTML challenge page */ }
  if (!response.ok) {
    // Log DPay's machine code only — never headers, keys or full bodies.
    logEvent("dpay_error", { path: path.replace(/dpay_ps_[^/]+/, ":id"), status: response.status, code: String(data?.error?.code || "unknown").slice(0, 40) });
    if (response.status === 404) throw new ApiError(404, "payment_not_found", "Payment not found.");
    if (response.status === 429 || response.status >= 500) {
      throw new ApiError(503, "payment_service_busy", "The payment service is busy. Please try again in a moment.");
    }
    throw new ApiError(503, "payment_unavailable", "Online payment is temporarily unavailable. Please contact support on WhatsApp.");
  }
  if (!data || typeof data !== "object") {
    throw new ApiError(502, "payment_service_error", "The payment service returned an unexpected response. Please try again.");
  }
  return data;
}

/** POST /payment_sessions. The order id doubles as DPay's Idempotency-Key, so a retry returns the original session. */
export function createPaymentSession(env, { orderId, amountPkr, description, successUrl, cancelUrl, metadata }) {
  return request(env, "POST", "/payment_sessions", {
    idempotencyKey: orderId,
    body: {
      amount: amountPkr * 100, // paisa; always a whole number of rupees
      description,
      order_id: orderId,
      success_url: successUrl,
      cancel_url: cancelUrl,
      expires_in: 1800,
      metadata,
    },
  });
}

/** GET /payment_sessions/:id — authoritative read of a session's state. */
export function getPaymentSession(env, sessionId) {
  if (!/^[A-Za-z0-9_]{6,80}$/.test(sessionId)) throw new ApiError(400, "invalid_session", "Invalid payment reference.");
  return request(env, "GET", `/payment_sessions/${sessionId}`);
}

const hexToBytes = (hex) => {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};

/**
 * Verify `DPay-Signature: t=<unix>,v1=<hex>` where v1 = HMAC-SHA256(secret, "<t>.<raw body>").
 * Timestamps more than 300 s away (either direction) are rejected. Comparison is constant-time
 * (WebCrypto `verify`).
 */
export async function verifyWebhookSignature(rawBody, header, secret, nowSeconds = Date.now() / 1000) {
  if (!header || !secret) return false;
  const parts = {};
  for (const piece of header.split(",")) {
    const idx = piece.indexOf("=");
    if (idx > 0) parts[piece.slice(0, idx).trim()] = piece.slice(idx + 1).trim();
  }
  const { t, v1 } = parts;
  if (!t || !v1 || !/^\d{1,12}$/.test(t)) return false;
  if (Math.abs(nowSeconds - Number(t)) > 300) return false;
  const signature = hexToBytes(v1);
  if (!signature || signature.length !== 32) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, enc.encode(`${t}.${rawBody}`));
}
