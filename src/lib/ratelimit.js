import { ApiError } from "./http.js";

/**
 * Fixed-window rate limiter backed by D1. Keyed by client IP + route bucket.
 * Throws 429 when the limit is exceeded.
 */
export async function rateLimit(env, ctx, request, bucket, limit, windowSeconds = 60) {
  if (!env.DB) return; // limiter needs D1; routes that need D1 fail on their own
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const now = Math.floor(Date.now() / 1000);
  const win = Math.floor(now / windowSeconds) * windowSeconds;
  const key = `${bucket}:${ip}`;
  let count = 1;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, win, count) VALUES (?1, ?2, 1)
       ON CONFLICT (bucket, win) DO UPDATE SET count = count + 1
       RETURNING count`
    ).bind(key, win).first();
    count = row?.count ?? 1;
  } catch {
    return; // never take the portal down because the limiter table is unavailable
  }
  if (Math.random() < 0.02) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM rate_limits WHERE win < ?1").bind(now - 3600).run().catch(() => {}));
  }
  if (count > limit) {
    const retry = Math.max(1, win + windowSeconds - now);
    const err = new ApiError(429, "rate_limited", `Too many requests. Please wait ${retry} seconds and try again.`);
    err.retryAfter = retry;
    throw err;
  }
}
