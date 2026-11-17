// my Pak-Tel — Cloudflare Worker entry point.
// Serves the single-page portal (static assets) and the server-side JSON API.

import { checkout, webhook, newOrderStatus, automaticCheckoutAvailable } from './lib/sales.js';
import { runScheduled } from './lib/scheduled.js';
import { previewCatalogueDate, previewPlans } from './lib/preview-catalogue.js';

import { ApiError, assertSameOrigin, fail, json, logEvent, nowIso, readJsonBody } from "./lib/http.js";
import { rateLimit } from "./lib/ratelimit.js";
import { ensureSchema } from "./lib/schema.js";
import { parseIccid } from "./lib/validate.js";
import { getPlans } from "./lib/plans.js";
import { getSimInfo, normalizeSim } from "./lib/yesim.js";
import { handleCheckout, handleOrderStatus, handleTransactions } from "./routes-payments.js";

function securityHeaders(env) {
  // FRAME_ANCESTORS is only relaxed for embedded previews; production default is 'none'.
  const ancestors = (env.FRAME_ANCESTORS || "'none'").replace(/[;\r\n]/g, "");
  return {
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data: https://dpay.com.pk https://cdn.simpleicons.org; connect-src 'self' https://script.google.com https://script.googleusercontent.com; form-action 'self'; " +
      `base-uri 'none'; object-src 'none'; frame-ancestors ${ancestors}`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
}

async function serveAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(securityHeaders(env))) out.headers.set(k, v);
  // Always revalidate the page, script and styles so a new deploy is picked up immediately.
  const type = out.headers.get("Content-Type") || "";
  if (/html|javascript|css/.test(type)) out.headers.set("Cache-Control", "no-cache, must-revalidate");
  return out;
}

async function handleApi(request, env, ctx, url) {
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/health" && method === "GET") {
    return json({ ok: true, time: nowIso() });
  }

  // The webhook must not run schema DDL on its critical path. Apply migrations before registering it.
  if (pathname === "/api/webhooks/dpay" && method === "POST") return webhook(request, env);

  await ensureSchema(env);

  if (pathname === "/api/esim/lookup" && method === "POST") {
    assertSameOrigin(request);
    await rateLimit(env, ctx, request, "lookup", 12);
    const body = await readJsonBody(request);
    const iccid = parseIccid(body.iccid);
    const raw = await getSimInfo(env, iccid);
    if (!raw) {
      throw new ApiError(404, "esim_not_found", "We couldn't find a Pak-Tel eSIM with that ICCID. Check the number and try again.");
    }
    const esim = normalizeSim(raw);
    // ICCID alone is not authentication for a transferable activation code.
    esim.lpa = null; esim.qrImage = null; esim.iosLink = null;
    if (esim.planId) {
      // Best effort: show the Pak-Tel plan name when the active plan is in the sheet.
      const plans = await getPlans(env).catch(() => []);
      esim.planName = plans.find((p) => p.planId === esim.planId)?.name || null;
    }
    return json({ esim, checkedAt: nowIso() });
  }

  if (pathname === "/api/plans" && method === "GET") {
    await rateLimit(env, ctx, request, "plans", 40);
    const readOnly = env.PREVIEW_CATALOGUE === "true";
    try {
      const plans = await getPlans(env);
      return json({ plans, updatedAt: nowIso(), source: "live", readOnly, autoCheckoutAvailable: automaticCheckoutAvailable(env) });
    } catch (error) {
      // Explicit local-preview mode only; stale data can never be used at checkout.
      if (readOnly && error instanceof ApiError && error.code === "plans_unavailable") {
        return json({ plans: previewPlans, updatedAt: previewCatalogueDate, source: "snapshot", readOnly: true, autoCheckoutAvailable: false });
      }
      throw error;
    }
  }

  if (method === "POST" && env.PREVIEW_CATALOGUE === "true" && (pathname === "/api/checkout" || pathname === "/api/new-esim/checkout")) {
    throw new ApiError(503, "preview_read_only", "Checkout is disabled in catalogue preview mode.");
  }
  if (pathname === "/api/checkout" && method === "POST") return handleCheckout(request, env, ctx, url);
  if (pathname === "/api/transactions" && method === "POST") return handleTransactions(request, env, ctx);
  if (pathname === "/api/new-esim/checkout" && method === "POST") return checkout(request, env, ctx, url);
  if (pathname.startsWith("/api/new-esim/orders/") && method === "GET") return newOrderStatus(request, env, ctx, pathname.slice("/api/new-esim/orders/".length));
  if (pathname.startsWith("/api/orders/") && method === "GET") {
    return handleOrderStatus(request, env, ctx, pathname.slice("/api/orders/".length));
  }

  throw new ApiError(404, "not_found", "Not found.");
}

export default {
  async scheduled(controller, env, ctx) { await ensureSchema(env); await runScheduled(env); },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      // Prefilled links: /iccid/<19 or 20 digits> opens the portal; the page validates the ICCID, fills the box and runs the check.
      if (url.pathname === "/iccid" || url.pathname.startsWith("/iccid/")) {
        return serveAsset(new Request(new URL("/manage/index.html", url), { method: "GET", headers: request.headers }), env);
      }
      if (url.pathname === "/manage" || url.pathname === "/manage/") return serveAsset(new Request(new URL("/manage/index.html", url), { method: "GET", headers: request.headers }), env);
      return serveAsset(request, env);
    }
    try {
      return await handleApi(request, env, ctx, url);
    } catch (error) {
      if (error instanceof ApiError) {
        return fail(error.status, error.code, error.message, error.retryAfter ? { "retry-after": String(error.retryAfter) } : {});
      }
      logEvent("unhandled_error", { path: url.pathname, name: error?.name || "Error" });
      return fail(500, "internal", "Something went wrong on our side. Please try again.");
    }
  },
};
