// Top-up catalogue, read live from the Pak-Tel Google Sheet.
//   Column A → Plan Name      Column B → Price (PKR)      Column M → Plan ID (Yesim plan id)
// The sheet is the single source of truth for what a top-up costs: the price charged at
// checkout is always re-read here on the server, never taken from the browser.

import { ApiError, fetchWithTimeout, logEvent } from "./http.js";

const COL_NAME = 0;   // A
const COL_PRICE = 1;  // B
const COL_PLAN_ID = 12; // M
// Display-only columns for the pricing cards (never used for charging):
const COL_DATA = 2;        // C  e.g. "0.5 GB", "Unlimited Data"
const COL_DAYS = 3;        // D  e.g. "7 Days"
const COL_RELOADABLE = 4;  // E  Yes / No
const COL_POPULAR = 5;     // F  Yes / blank
const COL_ACTUAL = 6;      // G  price before discount (PKR)
const COL_DISCOUNT = 7;    // H  e.g. "37%"
// Columns I-L (cost, commission, contact, rate) are internal and must never be returned.

const cell = (row, i) => String(row[i] ?? "").trim();
const truthy = (v) => /^(yes|y|true|1|✓|✔)$/i.test(v);
function displayFields(row, pricePkr) {
  const data = cell(row, COL_DATA).slice(0, 30);
  const daysMatch = cell(row, COL_DAYS).match(/\d{1,4}/);
  const reloadText = cell(row, COL_RELOADABLE);
  const actual = Number(cell(row, COL_ACTUAL).replace(/[,\s]|pkr|rs\.?/gi, ""));
  let discount = Number(cell(row, COL_DISCOUNT).replace(/[%\s]/g, ""));
  if (discount > 0 && discount < 1) discount *= 100; // sheet stored a fraction (0.37)
  return {
    data: data || null,
    days: daysMatch ? Number(daysMatch[0]) : null,
    reloadable: reloadText ? truthy(reloadText) : null,
    popular: truthy(cell(row, COL_POPULAR)),
    actualPricePkr: Number.isFinite(actual) && actual > pricePkr ? Math.round(actual) : null,
    discountPct: Number.isFinite(discount) && discount >= 1 && discount < 100 ? Math.round(discount) : null,
  };
}
const CACHE_SECONDS = 60;

let memo = { at: 0, plans: null };

function sheetUrl(env) {
  if (env.PLANS_SHEET_CSV_URL) return env.PLANS_SHEET_CSV_URL; // override (tests)
  const id = env.PLANS_SHEET_ID;
  if (!id || !/^[A-Za-z0-9_-]{20,}$/.test(id)) {
    throw new ApiError(503, "not_configured", "Top-up plans are not configured yet. Please contact support.");
  }
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=Sheet1`;
}

/** Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function plansFromCsv(text) {
  const rows = parseCsv(text.replace(/^\uFEFF/, ""));
  if (!rows.length) throw new Error("empty sheet");
  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  // Fail closed if the sheet layout changed: never sell with the wrong price / plan column.
  if (!header[COL_NAME]?.includes("plan name") || !header[COL_PRICE]?.includes("price") || !header[COL_PLAN_ID]?.includes("plan id")) {
    throw new Error("unexpected sheet header");
  }
  const plans = [];
  const seen = new Set();
  for (const row of rows.slice(1)) {
    const name = String(row[COL_NAME] || "").trim().slice(0, 80);
    const priceText = String(row[COL_PRICE] || "").replace(/[,\s]/g, "");
    const planId = String(row[COL_PLAN_ID] || "").trim();
    if (!name || !planId) continue;
    if (!/^\d{1,7}$/.test(priceText)) continue;           // whole rupees only (DPay requirement)
    const pricePkr = Number(priceText);
    if (pricePkr < 1) continue;
    if (!/^[A-Za-z0-9]{1,64}$/.test(planId) || seen.has(planId)) continue;
    seen.add(planId);
    plans.push({ name, pricePkr, planId, ...displayFields(row, pricePkr) });
  }
  return plans;
}

/** Returns [{ name, pricePkr, planId, data, days, reloadable, popular, actualPricePkr, discountPct }]. Cached briefly per isolate. */
export async function getPlans(env, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && memo.plans && now - memo.at < CACHE_SECONDS * 1000) return memo.plans;
  try {
    const response = await fetchWithTimeout(sheetUrl(env), { headers: { accept: "text/csv" }, redirect: "follow" }, 10000);
    if (!response.ok) throw new Error(`sheet http ${response.status}`);
    const plans = plansFromCsv(await response.text());
    memo = { at: now, plans };
    return plans;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logEvent("plans_sheet_error", { reason: String(error?.message || "error").slice(0, 80) });
    // Serve a slightly stale catalogue for display only; checkout always passes fresh=true.
    if (!fresh && memo.plans && now - memo.at < 15 * 60 * 1000) return memo.plans;
    throw new ApiError(502, "plans_unavailable", "Top-up plans are temporarily unavailable. Please try again shortly.");
  }
}

export async function findPlan(env, planId, opts) {
  const plans = await getPlans(env, opts);
  return plans.find((p) => p.planId === planId) || null;
}
