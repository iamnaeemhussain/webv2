// Small HTTP helpers shared by every API route.

const API_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...API_HEADERS, ...extra } });
}

/** Uniform error shape. `message` is always safe to show to a customer. */
export function fail(status, code, message, extra = {}) {
  return json({ error: { code, message } }, status, extra);
}

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Safe "not configured" error: names the feature, never the secret or its value. */
export function notConfigured(what) {
  return new ApiError(503, "not_configured", `${what} is not configured yet. Please try again later or contact support.`);
}

export async function readJsonBody(request, maxBytes = 4096) {
  const type = request.headers.get("content-type") || "";
  if (!type.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Send JSON.");
  }
  const text = await request.text();
  if (text.length > maxBytes) throw new ApiError(413, "too_large", "Request is too large.");
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    return body;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body is not valid JSON.");
  }
}

/** Reject cross-site browser POSTs (CSRF defence for the JSON API). */
export function assertSameOrigin(request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new ApiError(403, "forbidden_origin", "Cross-site requests are not allowed.");
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    throw new ApiError(403, "forbidden_origin", "Cross-site requests are not allowed.");
  }
}

export async function fetchWithTimeout(url, init = {}, ms = 15000) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** Logs an operational message with secrets structurally excluded (never pass URLs with tokens). */
export function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

export const nowIso = () => new Date().toISOString();
