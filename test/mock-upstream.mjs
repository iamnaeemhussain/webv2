// TEST ONLY. A local stand-in for the three upstream services (Yesim Partner API, the Google
// plan sheet, DPay) so the Worker can be exercised end-to-end without real credentials or money.
// It mirrors the documented request/response shapes. Nothing here is used by the deployed portal.

import http from "node:http";
import crypto from "node:crypto";

export const TEST_YESIM_TOKEN = "test-yesim-token-0000";
export const TEST_DPAY_KEY = "dpay_test_sk_mock0000";
export const TEST_WEBHOOK_SECRET = "whsec_mock_0000";

const PLAN_A = "c9b922d6a687dc41955220eb30283c6e";
const PLAN_B = "ce820a6927dc6683ae068a4a0f0d6167";
const PLAN_UNL = "c8bff43b761f6fa2687e9c56f1d1e6a6";

const fmt = (d) => d.toISOString().slice(0, 19).replace("T", " ");
const days = (n) => new Date(Date.now() + n * 86400000);

export function createMock() {
  const sims = new Map();
  const base = (iccid, extra) => ({
    id: "1806", iccid, user_id: "405", created_at: "2025-01-11 06:47:15",
    active_plan_id: null, plan_activated_at: null, plan_expired_at: null,
    qrcode: "LPA:1$smdp.io$K2-26L4K8-1KB5J7I", status_qr: "Enabled",
    imsi: "260010199895775", msisdn: null, is_deleted: "0",
    ios_tap_link: "https://esimsetup.apple.com/esim_qrcode_provisioning?carddata=LPA:1$smdp.io$K2-26L4K8-1KB5J7I",
    esim_passport: "https://esimpass.cloud/secret-passport-link",
    ...extra,
  });
  const reset = () => {
    sims.clear();
    sims.set("8937204017178106954", base("8937204017178106954", {
      active_plan_id: PLAN_A, plan_activated_at: fmt(days(-3)), plan_expired_at: fmt(days(4)),
      data_left_mb: 380.5, data_package_mb: 1024, data_used_mb: 643.5,
      networkinfo: { time: fmt(days(0)), lastMcc: 410, lastMnc: 1, lastRat: "4G - LTE" },
    }));
    sims.set("89372040171781069541", base("89372040171781069541", {
      active_plan_id: PLAN_UNL, plan_activated_at: fmt(days(-1)), plan_expired_at: fmt(days(6)), data_used_mb: 5120,
    }));
    sims.set("8937204017178100001", base("8937204017178100001", { status_qr: "Released" }));
    sims.set("8937204017178100002", base("8937204017178100002", {})); // add_plan → 400
    sims.set("8937204017178100003", base("8937204017178100003", {})); // add_plan → 500, NOT applied
    sims.set("8937204017178100004", base("8937204017178100004", {})); // add_plan → 500, but applied
  };
  reset();

  const state = { sims, sessions: new Map(), idem: new Map(), addPlanCalls: [], sheetPrice: 220, sheetBroken: false, yesimDown: false, dpayCalls: 0, seenTokens: new Set(), seenAuth: new Set(), issueCalls: [], emails: [], issueMode: "ok", emailMode: "ok" };

  const applyPlan = (sim, planId) => {
    sim.active_plan_id = planId;
    sim.plan_activated_at = sim.plan_activated_at || fmt(days(0));
    sim.plan_expired_at = fmt(days(30));
    sim.data_package_mb = (sim.data_package_mb || 0) + 1024;
    sim.data_left_mb = (sim.data_left_mb || 0) + 1024;
    sim.data_used_mb = sim.data_used_mb || 0;
  };

  const sheetCsv = () => {
    if (state.sheetBroken) return '"Name","Cost"\n"x","1"\n';
    const head = ["Plan Name", "Price (PKR)", "GBs", "Days", "Reloadable", "Most Popular", "Actual Price", "Discount %", "Cost", "Comission", "Contact", "EUR to PKR", "Plan ID", "Price difference", "Message"];
    const rows = [
      ["Trial Plan", String(state.sheetPrice), "0.5 GB", "1 Days", "Yes", "", "349", "37%", "119.7", "100", "", "", PLAN_A, "129", 'Welcome, "friend"\nline two, with comma'],
      ["1 GB 7 Days", "399", "1 GB", "7 Days", "Yes", "", "599", "33%", "187.7", "211", "", "", PLAN_B, "200", ""],
      ["Unlimited Data for 7 Days", "3,099", "Unlimited Data", "7 Days", "Yes", "Yes", "6199", "50%", "2242.2", "857", "", "", PLAN_UNL, "3100", ""],
      ["Broken price row", "12.50", "", "", "", "", "", "", "", "", "", "", "aaaa", "", ""],
      ["No plan id row", "500", "", "", "", "", "", "", "", "", "", "", "", "", ""],
    ];
    const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
    return [head, ...rows].map((r) => r.map(q).join(",")).join("\n") + "\n";
  };

  const send = (res, status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": type });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => resolve(b)); });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://mock");
    const path = url.pathname;

    // ---- test control: mark a session as paid (stands in for a customer's bank transfer) ----
    const pay = path.match(/^\/_test\/pay\/([^/]+)$/);
    if (pay && req.method === "POST") {
      const s = [...state.sessions.values()].find((x) => x.order_id === pay[1] || x.id === pay[1]);
      if (!s) return send(res, 404, { error: "no such session" });
      s.status = "succeeded"; s.amount_paid = s.amount;
      return send(res, 200, s);
    }

    // ---- Google sheet (gviz CSV) ----
    if (path === "/sheet.csv") return send(res, 200, sheetCsv(), "text/csv");

    if (path === "/brevo/smtp/email") {
      const data = JSON.parse(await readBody(req));
      state.emails.push(data);
      if (req.headers['api-key'] !== 'test-brevo-key') return send(res, 401, {});
      if (state.emailMode !== 'ok') return send(res, 500, {});
      return send(res, 201, {messageId:'mock'});
    }

    // ---- Yesim ----
    if (path.startsWith("/yesim/")) {
      state.seenTokens.add(url.searchParams.get("token"));
      if (state.yesimDown) return send(res, 503, "down", "text/plain");
      if (url.searchParams.get("token") !== TEST_YESIM_TOKEN) return send(res, 401, ["Invalid token"]);
      if (path === "/yesim/new_esim" && req.method === "GET") {
        state.issueCalls.push({ planId: url.searchParams.get('plan_id'), paymentId: url.searchParams.get('payment_id') });
        if (state.issueMode !== 'ok') return send(res, 500, {});
        return send(res, 200, {iccid:'8937204017178106954', active_plan_id:url.searchParams.get('plan_id'), qrcode:'LPA:1$smdp.io$TEST123'});
      }
      const iccid = url.searchParams.get("iccid");
      const sim = sims.get(iccid);
      if (path === "/yesim/sim_info" && req.method === "GET") {
        if (!sim) return send(res, 400, [`The eSIM with iccid ${iccid} not found.`]);
        return send(res, 200, sim);
      }
      if (path === "/yesim/add_plan_iccid" && req.method === "POST") {
        const planId = url.searchParams.get("plan_id");
        state.addPlanCalls.push({ iccid, planId });
        if (!sim) return send(res, 400, [`The eSIM with iccid ${iccid} not found.`]);
        if (iccid.endsWith("0002")) return send(res, 400, ["Plan can not be activated."]);
        if (iccid.endsWith("0003")) return send(res, 500, "error", "text/plain");
        if (iccid.endsWith("0004")) { applyPlan(sim, planId); return send(res, 500, "error", "text/plain"); }
        applyPlan(sim, planId);
        return send(res, 200, { status: "success", description: "OK" });
      }
      return send(res, 404, ["not found"]);
    }

    // ---- DPay ----
    if (path.startsWith("/dpay/")) {
      state.seenAuth.add(req.headers.authorization || "");
      if (req.headers.authorization !== `Bearer ${TEST_DPAY_KEY}`) {
        return send(res, 401, { error: { type: "authentication_error", code: "unauthorized", message: "Invalid API key" } });
      }
      if (path === "/dpay/payment_sessions" && req.method === "POST") {
        state.dpayCalls += 1;
        const body = JSON.parse(await readBody(req));
        const key = req.headers["idempotency-key"];
        if (key && state.idem.has(key)) return send(res, 200, state.sessions.get(state.idem.get(key)));
        if (!Number.isInteger(body.amount) || body.amount % 100 !== 0 || !body.description) {
          return send(res, 400, { error: { type: "invalid_request_error", code: "invalid_request", message: "bad request" } });
        }
        const id = `dpay_ps_${crypto.randomBytes(8).toString("hex")}`;
        const session = {
          id, object: "payment_session", amount: body.amount, amount_decimal: (body.amount / 100).toFixed(2),
          payable_amount: body.amount, amount_paid: null, currency: "PKR", description: body.description,
          order_id: body.order_id, status: "awaiting_payment", reference: `DPAY-${id.slice(-6).toUpperCase()}`,
          checkout_url: `https://pay.dpay.com.pk/${id}`, success_url: body.success_url, cancel_url: body.cancel_url || null,
          expires_at: new Date(Date.now() + (body.expires_in || 900) * 1000).toISOString(),
          metadata: body.metadata || {}, livemode: false,
        };
        state.sessions.set(id, session);
        if (key) state.idem.set(key, id);
        return send(res, 201, session);
      }
      const m = path.match(/^\/dpay\/payment_sessions\/([^/]+)$/);
      if (m && req.method === "GET") {
        const session = state.sessions.get(m[1]);
        if (!session) return send(res, 404, { error: { type: "invalid_request_error", code: "not_found", message: "No such session" } });
        return send(res, 200, session);
      }
      return send(res, 404, { error: { code: "not_found", message: "not found" } });
    }
    send(res, 404, "not found", "text/plain");
  });

  /** Build a signed DPay webhook delivery exactly as documented: DPay-Signature: t=<unix>,v1=<hex hmac of "t.rawBody">. */
  const signedEvent = (type, session, { secret = TEST_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000), eventId } = {}) => {
    const id = eventId || `evt_${crypto.randomBytes(8).toString("hex")}`;
    const body = JSON.stringify({ id, object: "event", type, created: t, livemode: false, data: { object: session } });
    const v1 = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return { id, body, headers: { "content-type": "application/json", "DPay-Signature": `t=${t},v1=${v1}`, "DPay-Event-Id": id, "DPay-Event-Type": type, "Idempotency-Key": id, "user-agent": "DPay-Webhooks/1.0" } };
  };

  const markPaid = (sessionId, amountPaid) => {
    const s = state.sessions.get(sessionId);
    s.status = "succeeded";
    s.amount_paid = amountPaid ?? s.amount;
    return s;
  };

  return { server, state, reset, signedEvent, markPaid, PLAN_A, PLAN_B, PLAN_UNL };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.MOCK_PORT || 8790);
  createMock().server.listen(port, "127.0.0.1", () => console.log(`mock upstream on :${port}`));
}
