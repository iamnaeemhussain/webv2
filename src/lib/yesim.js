// Yesim Partner API client (https://partners-api.yesim.biz).
//
// Only documented endpoints and fields are used:
//   GET  /sim_info?iccid=&token=             → eSIM details + traffic
//   POST /add_plan_iccid?iccid=&plan_id=&token= → { "status": "success", "description": "OK" }
// Authentication: the partner token is passed as the `token` query parameter, so
// request URLs are secret — they are never logged or returned.

import { ApiError, fetchWithTimeout, notConfigured } from "./http.js";

function baseUrl(env) {
  return (env.YESIM_API_BASE || "https://partners-api.yesim.biz").replace(/\/+$/, "");
}

function token(env) {
  const value = env.YESIM_API_TOKEN;
  if (!value || typeof value !== "string" || !value.trim()) throw notConfigured("eSIM service");
  return value.trim();
}

async function call(env, method, path, params, timeoutMs) {
  const url = new URL(baseUrl(env) + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("token", token(env));
  let response;
  try {
    response = await fetchWithTimeout(url.toString(), { method, headers: { accept: "application/json" } }, timeoutMs);
  } catch {
    // Deliberately drop the original error: its message can contain the request URL (and token).
    throw new ApiError(502, "esim_service_unreachable", "The eSIM service did not respond. Please try again in a moment.");
  }
  let body = null;
  try { body = await response.json(); } catch { /* non-JSON body */ }
  return { status: response.status, ok: response.ok, body };
}

/** Yesim timestamps are "YYYY-MM-DD HH:MM:SS" in UTC+0. */
function toIso(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fetch raw /sim_info. Returns null when Yesim does not know the ICCID.
 * Throws ApiError for configuration / upstream failures.
 */
export async function getSimInfo(env, iccid) {
  const { status, ok, body } = await call(env, "GET", "/sim_info", { iccid }, 15000);
  if (status === 401 || status === 403) {
    throw new ApiError(503, "esim_service_auth", "The eSIM service is temporarily unavailable. Please contact support.");
  }
  if (status >= 500) {
    throw new ApiError(502, "esim_service_error", "The eSIM service is having trouble right now. Please try again shortly.");
  }
  if (!ok || !body || typeof body !== "object" || Array.isArray(body) || String(body.iccid || "") !== iccid) {
    return null;
  }
  return body;
}

/** Map a raw /sim_info body to the safe, minimal shape the portal shows. */
export function normalizeSim(raw, now = Date.now()) {
  const activatedAt = toIso(raw.plan_activated_at);
  const expiresAt = toIso(raw.plan_expired_at);
  const planId = raw.active_plan_id ? String(raw.active_plan_id) : null;

  const total = toNumber(raw.data_package_mb);
  const used = toNumber(raw.data_used_mb);
  let left = toNumber(raw.data_left_mb);
  if (left === null && total !== null && used !== null) left = Math.max(0, total - used);

  let planState = "none";
  if (planId) {
    if (expiresAt && new Date(expiresAt).getTime() <= now) planState = "expired";
    else if (!activatedAt) planState = "not_started";
    else planState = "active";
  }
  // Docs: "Unlimited plans only display the data_used_mb field."
  const unlimited = Boolean(planId) && total === null && left === null && used !== null;

  const lpa = typeof raw.qrcode === "string" && /^LPA:1\$[\x21-\x7e]{3,200}$/.test(raw.qrcode) ? raw.qrcode : null;
  const qrImage = typeof raw.img === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]{1,60000}$/.test(raw.img) ? raw.img : null;
  let iosLink = null;
  if (typeof raw.ios_tap_link === "string") {
    try {
      const u = new URL(raw.ios_tap_link);
      if (u.protocol === "https:" && u.hostname === "esimsetup.apple.com") iosLink = u.toString();
    } catch { /* ignore malformed link */ }
  }

  const net = raw.networkinfo && typeof raw.networkinfo === "object" ? raw.networkinfo : null;

  return {
    iccid: String(raw.iccid),
    simStatus: typeof raw.status_qr === "string" ? raw.status_qr.slice(0, 40) : null, // Released | Installed | Enabled | Disabled | Deleted
    deleted: String(raw.is_deleted ?? "0") === "1",
    planState,
    planId,
    planName: null, // filled from the plan sheet by the route
    activatedAt,
    expiresAt,
    unlimited,
    dataTotalMb: total,
    dataUsedMb: used,
    dataLeftMb: left,
    lpa,
    qrImage,
    iosLink,
    network: net && typeof net.lastRat === "string" ? { rat: net.lastRat.slice(0, 40), time: toIso(net.time) } : null,
  };
}

/** Compact fingerprint of the resources a top-up changes; used to verify a top-up landed. */
export function resourceSnapshot(raw) {
  if (!raw) return null;
  return {
    planId: raw.active_plan_id ? String(raw.active_plan_id) : null,
    expiresAt: typeof raw.plan_expired_at === "string" ? raw.plan_expired_at : null,
    total: toNumber(raw.data_package_mb),
    left: toNumber(raw.data_left_mb),
  };
}

export function resourcesChanged(before, after, planId) {
  if (!after) return false;
  if (!before) return after.planId === planId;
  if (after.planId !== before.planId && after.planId === planId) return true;
  if (after.expiresAt !== before.expiresAt && after.expiresAt && (!before.expiresAt || after.expiresAt > before.expiresAt)) return true;
  if (after.total !== null && (before.total === null || after.total > before.total)) return true;
  if (after.left !== null && (before.left === null || after.left > before.left)) return true;
  return false;
}

/**
 * Activate / top up a plan on an existing ICCID.
 * Returns { outcome: "success" | "rejected" | "unknown", detail }.
 *  - success : Yesim answered {"status":"success"}
 *  - rejected: Yesim answered with a definite refusal (4xx / non-success status)
 *  - unknown : timeout / network / 5xx — the plan may or may not have been applied
 */
export async function addPlanToIccid(env, iccid, planId) {
  let result;
  try {
    result = await call(env, "POST", "/add_plan_iccid", { iccid, plan_id: planId }, 25000);
  } catch (error) {
    if (error instanceof ApiError && error.code === "not_configured") return { outcome: "rejected", detail: "not_configured" };
    return { outcome: "unknown", detail: "no_response" };
  }
  const { status, body } = result;
  if (status >= 200 && status < 300 && body && typeof body === "object" && String(body.status).toLowerCase() === "success") {
    return { outcome: "success", detail: "ok" };
  }
  if (status >= 500) return { outcome: "unknown", detail: `http_${status}` };
  return { outcome: "rejected", detail: `http_${status}` };
}
