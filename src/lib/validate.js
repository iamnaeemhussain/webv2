import { ApiError } from "./http.js";

const ICCID_RE = /^\d{19,20}$/;
const PLAN_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const ORDER_ID_RE = /^PT-[A-Z0-9]{20}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** ICCID must be exactly 19 or 20 digits. Nothing else is accepted. */
export function parseIccid(value) {
  if (typeof value !== "string" || !ICCID_RE.test(value)) {
    throw new ApiError(400, "invalid_iccid", "ICCID must be exactly 19 or 20 digits.");
  }
  return value;
}

export function parsePlanId(value) {
  if (typeof value !== "string" || !PLAN_ID_RE.test(value)) {
    throw new ApiError(400, "invalid_plan", "Unknown plan.");
  }
  return value;
}

export function parseOrderId(value) {
  if (typeof value !== "string" || !ORDER_ID_RE.test(value)) {
    throw new ApiError(400, "invalid_order", "Unknown order reference.");
  }
  return value;
}

export function parseIdempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_RE.test(value)) {
    throw new ApiError(400, "invalid_idempotency_key", "A valid Idempotency-Key header is required.");
  }
  return value;
}

export function newOrderId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars → no modulo bias
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "PT-";
  for (const b of bytes) out += alphabet[b & 31];
  return out;
}
