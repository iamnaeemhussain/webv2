/* my Pak-Tel — portal front end.
 * Talks only to this site's own /api/* routes. No API credentials ever reach the browser. */
(() => {
  "use strict";

  const WHATSAPP_NUMBER = "923259717066";
  const ICCID_RE = /^\d{19,20}$/;
  const SESSION_KEY = "mypaktel.iccid";

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  };

  document.addEventListener("click", (event) => {
    if (event.target.closest?.('a[href^="https://wa.me/"]') && window.PakTelNotify?.ready) {
      window.PakTelNotify("info", "Opening WhatsApp", "Connect with Pak-Tel support.");
    }
  });

  const state = { iccid: null, esim: null, plans: null, catalogueReadOnly: false, pendingPlan: null, idempotencyKey: null, pollTimer: null, pollStarted: 0, lastOrderState: null };

  /* ---------- helpers ---------- */
  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, {
        method: options.method || "GET",
        headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch {
      throw Object.assign(new Error("We couldn't reach my Pak-Tel. Check your connection and try again."), { code: "network" });
    }
    let data = null;
    try { data = await response.json(); } catch { /* non-JSON */ }
    if (!response.ok) {
      const message = data?.error?.message || "Something went wrong. Please try again.";
      throw Object.assign(new Error(message), { code: data?.error?.code || "error", status: response.status });
    }
    return data;
  }

  const pkr = (n) => `PKR ${Number(n).toLocaleString("en-PK")}`;

  function formatData(mb) {
    if (mb === null || mb === undefined || Number.isNaN(Number(mb))) return { num: "—", unit: "", text: "—" };
    const value = Math.max(0, Number(mb));
    if (value >= 1024) {
      const gb = value / 1024;
      const num = gb >= 100 ? gb.toFixed(0) : gb.toFixed(2).replace(/\.?0+$/, "");
      return { num, unit: "GB", text: `${num} GB` };
    }
    const num = value >= 100 ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, "");
    return { num, unit: "MB", text: `${num} MB` };
  }

  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const formatDate = (iso) => {
    if (!iso) return null;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
  };

  function relativeExpiry(iso) {
    const ms = new Date(iso).getTime() - Date.now();
    if (Number.isNaN(ms)) return "";
    const abs = Math.abs(ms);
    const days = Math.floor(abs / 86400000);
    const hours = Math.floor((abs % 86400000) / 3600000);
    const span = days >= 1 ? `${days} day${days === 1 ? "" : "s"}${days < 3 && hours ? ` ${hours} h` : ""}` : hours >= 1 ? `${hours} hour${hours === 1 ? "" : "s"}` : "less than an hour";
    return ms >= 0 ? `in ${span}` : `${span} ago`;
  }

  let toastTimer;
  function toast(message, type = "info", description) {
    if (window.PakTelNotify?.ready) { window.PakTelNotify(type, message, description); return; }
    const node = $("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3200);
  }

  async function copyText(text, okMessage) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch {
      toast("Copy isn't available — press and hold to copy.", "warning");
    }
  }

  function setChip(node, label, tone) {
    node.textContent = label;
    if (tone) node.dataset.tone = tone; else delete node.dataset.tone;
  }

  function whatsappLink(message) {
    return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
  }

  function refreshWhatsappLinks() {
    const message = state.iccid
      ? `Hi Pak-Tel, I need help with my eSIM. ICCID: ${state.iccid}`
      : "Hi Pak-Tel, I need help with my eSIM.";
    document.querySelectorAll("[data-whatsapp]").forEach((a) => { a.href = whatsappLink(message); });
  }

  /* ---------- ICCID form ---------- */
  const input = $("iccid");
  const errorNode = $("iccid-error");
  const countNode = $("iccid-count");

  function showFormError(message) {
    errorNode.textContent = message || "";
    errorNode.hidden = !message;
    input.classList.toggle("is-invalid", Boolean(message));
    input.setAttribute("aria-invalid", message ? "true" : "false");
  }

  function updateCount() {
    const len = input.value.length;
    countNode.textContent = `${len} / 20`;
    countNode.classList.toggle("is-valid", ICCID_RE.test(input.value));
  }

  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D+/g, "").slice(0, 20); // digits only, hard cap at 20
    if (digits !== input.value) input.value = digits;
    updateCount();
    if (!errorNode.hidden) showFormError("");
  });

  $("lookup").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!ICCID_RE.test(value)) {
      showFormError(value.length === 0 ? "Enter your ICCID." : `ICCID must be exactly 19 or 20 digits — you entered ${value.length}.`);
      toast("Check your ICCID", "warning", "Enter 19 or 20 digits.");
      input.focus();
      return;
    }
    loadEsim(value, { scroll: true });
  });

  /* ---------- eSIM lookup + render ---------- */
  function setLoading(isLoading, silent) {
    const btn = $("lookup-btn");
    btn.disabled = isLoading;
    $("recheck-btn").disabled = isLoading;
    $("recheck-btn").classList.toggle("is-loading", isLoading);
    if (!silent) {
      $("dash-skeleton").hidden = !isLoading;
      if (isLoading) { $("dash").hidden = true; $("empty-state").hidden = true; }
    }
  }

  async function loadEsim(iccid, { scroll = false, silent = false } = {}) {
    showFormError("");
    setLoading(true, silent);
    try {
      const data = await api("/api/esim/lookup", { method: "POST", body: { iccid } });
      state.iccid = iccid;
      state.esim = data.esim;
      try { sessionStorage.setItem(SESSION_KEY, iccid); } catch { /* private mode */ }
      renderEsim(data.esim, data.checkedAt);
      renderPlans();
      refreshWhatsappLinks();
      loadHistory();
      if (scroll) $("dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
      if (silent) toast("Balance updated.", "success");
      else if (scroll) toast("eSIM details loaded", "success");
      return true;
    } catch (error) {
      if (silent && state.esim) {
        toast(error.message, "error");
      } else {
        state.iccid = null;
        state.esim = null;
        $("dash").hidden = true;
        $("history").hidden = true;
        $("empty-state").hidden = false;
        showFormError(error.message);
        toast("eSIM lookup unavailable", "error", error.message);
        renderPlans();
        refreshWhatsappLinks();
      }
      return false;
    } finally {
      setLoading(false, silent);
    }
  }

  const SIM_STATUS = {
    released: ["Ready to install", "info"],
    installed: ["Installed", null],
    enabled: ["Enabled on device", null],
    disabled: ["Disabled on device", "warn"],
    deleted: ["Deleted from device", "bad"],
  };
  const PLAN_STATE = {
    active: ["Active", null],
    not_started: ["Starts on first use", "info"],
    expired: ["Expired", "bad"],
    none: ["No active plan", "quiet"],
  };

  function renderEsim(esim, checkedAt) {
    $("empty-state").hidden = true;
    $("dash-skeleton").hidden = true;
    $("dash").hidden = false;

    $("d-iccid").textContent = esim.iccid;
    $("d-checked").textContent = `Checked ${formatDate(checkedAt) || "just now"}`;

    const [planLabel, planTone] = PLAN_STATE[esim.planState] || PLAN_STATE.none;
    setChip($("d-plan-chip"), planLabel, planTone);
    $("d-plan-state").textContent = planLabel;

    const statusKey = String(esim.simStatus || "").toLowerCase();
    const [simLabel, simTone] = SIM_STATUS[statusKey] || [esim.simStatus || "Unknown", "quiet"];
    setChip($("d-sim-status"), esim.deleted ? "eSIM removed" : simLabel, esim.deleted ? "bad" : simTone);

    $("d-plan-name").textContent = esim.planName || (esim.planId ? "Pak-Tel data plan" : "—");
    $("d-activated").textContent = formatDate(esim.activatedAt) || (esim.planState === "not_started" ? "On first use" : "—");

    const expires = $("d-expires");
    expires.textContent = "";
    const expiryText = formatDate(esim.expiresAt);
    if (expiryText) {
      expires.append(expiryText, el("small", null, relativeExpiry(esim.expiresAt)));
    } else {
      expires.textContent = esim.planState === "not_started" ? "Set at activation" : "—";
    }

    const net = esim.network;
    const network = $("d-network");
    network.textContent = "";
    if (net && net.rat) {
      network.append(net.rat);
      const seen = formatDate(net.time);
      if (seen) network.append(el("small", null, seen));
    } else {
      network.textContent = "—";
    }

    // Usage
    const ring = $("d-ring");
    const circumference = 2 * Math.PI * 52;
    const note = $("d-usage-note");
    const used = formatData(esim.dataUsedMb);
    $("d-used").textContent = used.text;
    let fraction = 0;
    let ringLabel;

    if (esim.unlimited) {
      $("d-left-num").textContent = "∞";
      $("d-left-unit").textContent = "UNLIMITED";
      $("d-left").textContent = "Unlimited";
      $("d-total").textContent = "Unlimited";
      fraction = esim.planState === "expired" ? 0 : 1;
      ringLabel = `Unlimited data plan. ${used.text} used.`;
      note.textContent = "Unlimited plan — only used data is reported.";
      note.hidden = false;
    } else if (esim.dataTotalMb !== null && esim.dataTotalMb !== undefined) {
      const left = formatData(esim.dataLeftMb);
      const total = formatData(esim.dataTotalMb);
      $("d-left-num").textContent = left.num;
      $("d-left-unit").textContent = left.unit;
      $("d-left").textContent = left.text;
      $("d-total").textContent = total.text;
      fraction = esim.dataTotalMb > 0 ? Math.min(1, Math.max(0, Number(esim.dataLeftMb || 0) / esim.dataTotalMb)) : 0;
      ringLabel = `${left.text} remaining of ${total.text}. ${used.text} used.`;
      note.hidden = true;
      if (esim.planState === "expired") { note.textContent = "This plan has expired. Top up below to get back online."; note.hidden = false; }
      else if (fraction <= 0.1) { note.textContent = "You're running low. Top up below to stay connected."; note.hidden = false; }
    } else {
      $("d-left-num").textContent = "—";
      $("d-left-unit").textContent = "";
      $("d-left").textContent = "—";
      $("d-total").textContent = "—";
      ringLabel = "No data plan on this eSIM.";
      note.textContent = "There is no data plan on this eSIM right now. Choose a top-up below.";
      note.hidden = false;
    }
    ring.style.strokeDashoffset = String(circumference * (1 - fraction));
    ring.style.opacity = fraction > 0 ? "1" : "0";
    ring.style.stroke = fraction <= 0.1 && !esim.unlimited ? "var(--red)" : fraction <= 0.25 && !esim.unlimited ? "var(--orange)" : "var(--lime)";
    $("d-ring-label").setAttribute("aria-label", ringLabel);

    renderQr(esim);
  }

  function renderQr(esim) {
    const frame = $("qr-frame");
    const canvas = $("qr-canvas");
    const body = frame.parentElement;
    frame.querySelectorAll("img").forEach((img) => img.remove());
    canvas.hidden = false;
    let drawn = false;

    if (esim.lpa && typeof window.qrcode === "function") {
      try {
        const qr = window.qrcode(0, "M");
        qr.addData(esim.lpa);
        qr.make();
        const count = qr.getModuleCount();
        const quiet = 2;
        const scale = Math.max(4, Math.floor(440 / (count + quiet * 2)));
        const size = (count + quiet * 2) * scale;
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = "#071322";
        for (let r = 0; r < count; r += 1) {
          for (let c = 0; c < count; c += 1) {
            if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
          }
        }
        drawn = true;
      } catch { drawn = false; }
    }
    if (!drawn && esim.qrImage) {
      const img = new Image();
      img.alt = "eSIM installation QR code";
      img.src = esim.qrImage; // server only passes through data:image/png;base64
      canvas.hidden = true;
      frame.append(img);
      drawn = true;
    }

    body.hidden = !drawn && !esim.lpa && !esim.iosLink;
    frame.hidden = !drawn;
    $("qr-missing").hidden = !body.hidden;

    const lpa = $("d-lpa");
    lpa.value = esim.lpa || "";
    lpa.closest(".copy-row").hidden = !esim.lpa;
    document.querySelector(".qr-code-label").hidden = !esim.lpa;

    const ios = $("d-ios-link");
    const iosCopy = $("copy-ios");
    if (esim.iosLink) {
      ios.href = esim.iosLink;
      ios.hidden = false;
      iosCopy.hidden = false;
    } else {
      ios.removeAttribute("href");
      ios.hidden = true;
      iosCopy.hidden = true;
    }
  }

  $("copy-lpa").addEventListener("click", () => copyText($("d-lpa").value, "Activation code copied."));
  $("copy-ios").addEventListener("click", () => state.esim?.iosLink && copyText(state.esim.iosLink, "Install link copied."));
  $("recheck-btn").addEventListener("click", () => state.iccid && loadEsim(state.iccid, { silent: true }));

  /* ---------- Plans ---------- */
  async function loadPlans() {
    const status = $("plans-status");
    try {
      const data = await api("/api/plans");
      state.plans = data.plans || [];
      state.catalogueReadOnly = data.readOnly === true;
      status.textContent = data.source === "snapshot" ? `Preview snapshot · ${data.updatedAt} · checkout disabled` : state.plans.length
        ? `Live pricing synced · ${state.plans.length} plan${state.plans.length === 1 ? "" : "s"}`
        : "No plans are available right now.";
      if (data.source === "snapshot") toast("Preview prices", "warning", "Snapshot from 17 Nov 2026; checkout is disabled.");
      else toast(state.plans.length ? "Plans synced" : "No plans available", state.plans.length ? "success" : "warning");
    } catch (error) {
      state.plans = null;
      state.plansError = error.message;
      status.textContent = "Plans unavailable";
      toast("Plans unavailable", "error", "Please try again later.");
    }
    renderPlans();
  }

  const svg = (d) => `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const PLAN_ICONS = {
    signal: svg('<path d="M5 20v-4M10 20v-8M15 20V8M20 20V4"/>'),
    sim: svg('<rect x="5" y="3" width="14" height="18" rx="2"/><rect x="9" y="11" width="6" height="6"/>'),
    calendar: svg('<rect x="4" y="5" width="16" height="16" rx="2"/><path d="M4 10h16M9 3v4M15 3v4"/>'),
    wifi: svg('<path d="M3 9a14 14 0 0 1 18 0M6.5 13a9 9 0 0 1 11 0M10 17a3.5 3.5 0 0 1 4 0"/>'),
    bolt: svg('<path d="M13 2 5 14h6l-1 8 8-12h-6l1-8z"/>'),
    reload: svg('<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>'),
  };

  function renderPlans() {
    const grid = $("plan-grid");
    grid.textContent = "";
    if (state.plans === null) {
      const notice = el("div", "notice");
      notice.append(el("b", null, "We couldn't load top-up plans. "), state.plansError || "Loading…", " ");
      if (state.plansError) {
        const retry = el("button", "text-link text-link--dark", "Try again");
        retry.type = "button";
        retry.addEventListener("click", () => { state.plansError = null; $("plans-status").textContent = "Loading plans…"; loadPlans(); });
        notice.append(retry);
      }
      grid.append(notice);
      return;
    }
    if (!state.plans.length) {
      grid.append(el("div", "notice", "No top-up plans are available right now. Please check back shortly or message us on WhatsApp."));
      return;
    }
    // Most-popular plans first (same order as pak-tel.com); otherwise keep the sheet order.
    const ordered = [...state.plans].sort((a, b) => Number(Boolean(b.popular)) - Number(Boolean(a.popular)));
    ordered.forEach((plan, index) => {
      const card = el("article", `plan-card${plan.popular ? " plan-card--popular" : ""}`);

      const top = el("div", "plan-top");
      top.append(el("span", "plan-badge", plan.popular ? "Most popular" : "Flexible data"));
      top.append(el("span", "plan-index", String(index + 1).padStart(2, "0")));
      card.append(top);

      if (plan.discountPct) {
        const save = el("span", "plan-save");
        save.append(el("small", null, "Save"), el("b", null, `${plan.discountPct}%`), el("small", null, "off"));
        save.setAttribute("aria-label", `Save ${plan.discountPct}%`);
        card.append(save);
      }

      card.append(el("h3", "plan-name", plan.name));

      // Big data figure: "15 GB" → 15 + unit, "Unlimited Data" → words.
      const dataText = String(plan.data || "").trim();
      const amount = dataText.match(/^(\d+(?:\.\d+)?)\s*([A-Za-z]+)?/);
      if (amount) {
        const figure = el("div", "plan-data");
        figure.append(el("span", "plan-data-num", amount[1]));
        const unit = el("span", "plan-data-unit");
        unit.append((amount[2] || "GB").toUpperCase(), document.createElement("br"), "DATA");
        figure.append(unit);
        card.append(figure);
      } else if (dataText) {
        card.append(el("div", "plan-data plan-data--text", dataText));
      }

      const specs = el("dl", "plan-specs");
      const spec = (icon, label, value) => {
        if (!value) return;
        const row = el("div", "plan-spec");
        const term = el("dt");
        const ico = el("span", "plan-ico");
        ico.innerHTML = PLAN_ICONS[icon];
        term.append(ico, label);
        row.append(term, el("dd", null, value));
        specs.append(row);
      };
      spec("signal", "Coverage", "5G/4G/LTE");
      spec("sim", "Plan type", "Data only");
      spec("calendar", "Validity period", plan.days ? `${plan.days} ${plan.days === 1 ? "Day" : "Days"}` : "");
      spec("wifi", "Hotspot", "Yes");
      spec("bolt", "Plan activation", "Instant");
      spec("reload", "Reloadable", plan.reloadable === null || plan.reloadable === undefined ? "" : plan.reloadable ? "Yes" : "No");
      card.append(specs);

      const bottom = el("div", "plan-bottom");
      const priceWrap = el("div");
      priceWrap.append(el("span", "plan-price-label", "Price (PKR)"));
      if (plan.actualPricePkr) {
        const was = el("div", "plan-was");
        was.append("Actual price ", el("s", null, pkr(plan.actualPricePkr)));
        priceWrap.append(was);
      }
      const price = el("div", "plan-price");
      price.append(el("small", null, "PKR"), Number(plan.pricePkr).toLocaleString("en-PK"));
      priceWrap.append(price);
      const button = el("button", "plan-cta", state.esim ? "Get this plan ↗" : "Enter ICCID ↗");
      button.type = "button";
      if (state.catalogueReadOnly) { button.disabled = true; button.textContent = "Preview only"; }
      button.setAttribute("aria-label", state.catalogueReadOnly ? "Checkout disabled in preview" : state.esim ? `Top up with ${plan.name} for ${pkr(plan.pricePkr)}` : `Enter your ICCID to buy ${plan.name}`);
      button.addEventListener("click", () => openCheckout(plan));
      bottom.append(priceWrap, button);
      card.append(bottom);
      grid.append(card);
    });
  }

  /* ---------- Checkout ---------- */
  const dialog = $("checkout-dialog");
  $("dpay-logo").addEventListener("error", (event) => { event.target.hidden = true; });

  function newIdempotencyKey() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function openCheckout(plan) {
    if (state.catalogueReadOnly) return;
    if (!state.esim || !state.iccid) {
      $("lookup").scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus({ preventScroll: true });
      showFormError("Enter your ICCID first so we know which eSIM to top up.");
      toast("Enter your ICCID first", "warning");
      return;
    }
    state.pendingPlan = plan;
    toast("Top-up selected", "info", "Review your plan before continuing to DPay.");
    state.idempotencyKey = newIdempotencyKey(); // one key per confirmation: double clicks can't create two payments
    $("c-iccid").textContent = state.iccid;
    $("c-plan").textContent = plan.name;
    $("c-plan-id").textContent = plan.planId;
    $("c-price").textContent = pkr(plan.pricePkr);
    $("c-error").hidden = true;
    const pay = $("c-pay");
    pay.disabled = false;
    pay.classList.remove("is-loading");
    if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  }

  $("c-pay").addEventListener("click", async () => {
    const plan = state.pendingPlan;
    if (!plan || !state.iccid) return;
    const pay = $("c-pay");
    const errorBox = $("c-error");
    pay.disabled = true;
    pay.classList.add("is-loading");
    errorBox.hidden = true;
    toast("Preparing checkout", "info", "Connecting to DPay securely.");
    try {
      const data = await api("/api/checkout", {
        method: "POST",
        headers: { "Idempotency-Key": state.idempotencyKey },
        body: { iccid: state.iccid, planId: plan.planId, pricePkr: plan.pricePkr },
      });
      toast("Opening DPay", "info", "Complete your payment on the secure checkout page.");
      window.location.assign(data.checkoutUrl); // DPay hosted checkout
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
      toast("Checkout unavailable", "error", error.message);
      pay.classList.remove("is-loading");
      if (error.code === "price_changed") {
        await loadPlans();
        pay.disabled = true; // customer must reopen with the new price
      } else {
        pay.disabled = false;
        if (error.status && error.status >= 500) state.idempotencyKey = newIdempotencyKey();
      }
    }
  });

  /* ---------- Order status (after DPay) ---------- */
  const ORDER_VIEW = {
    awaiting_payment: { tone: "wait", icon: "…", title: "Waiting for your payment", text: "We haven't received confirmation from DPay yet. If you've already paid, this page updates by itself — usually within a minute." },
    processing: { tone: "wait", icon: "↻", title: "Payment received — applying your top-up", text: "Your payment is verified. We're adding the plan to your eSIM now." },
    completed: { tone: "good", icon: "✓", title: "Top-up successful", text: "Your plan has been added to your eSIM. Your updated balance is shown below." },
    topup_failed: { tone: "bad", icon: "!", title: "Payment received, but the top-up failed", text: "Your payment is safe and recorded. We couldn't add the plan automatically — message us on WhatsApp with your order reference and we'll fix it right away." },
    review: { tone: "warn", icon: "?", title: "We're double-checking your top-up", text: "Your payment is recorded, but we couldn't confirm the top-up automatically. Our team will verify it — message us on WhatsApp with your order reference for a faster response." },
    expired: { tone: "warn", icon: "⌛", title: "Payment window expired", text: "This checkout expired before a payment was confirmed. If you did send money, contact us on WhatsApp with your order reference. Otherwise simply choose a plan again." },
    payment_failed: { tone: "bad", icon: "✕", title: "Payment failed", text: "The payment wasn't completed, so no top-up was applied and nothing was added to your eSIM. You can try again below." },
    cancelled: { tone: "warn", icon: "✕", title: "Payment cancelled", text: "No payment was taken and no top-up was applied." },
  };
  const FINAL_STATES = new Set(["completed", "topup_failed", "review", "expired", "payment_failed", "cancelled"]);

  function renderOrder(order, { cancelledHint = false } = {}) {
    const banner = $("order-banner");
    const view = ORDER_VIEW[order.state] || ORDER_VIEW.awaiting_payment;
    banner.hidden = false;
    banner.dataset.tone = view.tone;
    $("order-icon").textContent = view.icon;
    $("order-title").textContent = cancelledHint && order.state === "awaiting_payment" ? "Payment not completed yet" : view.title;
    let text = view.text;
    if (order.state === "completed" && !order.topupVerified) {
      text = "Your top-up was accepted by the network. It can take a moment to show — tap “Recheck balance” if it isn't visible yet.";
    }
    if (cancelledHint && order.state === "awaiting_payment") {
      text = "You left the checkout before paying. You can resume the payment, or pick a different plan below. If you already paid, just wait — this page updates by itself.";
    }
    $("order-text").textContent = `${order.planName} · ${pkr(order.amountPkr)}. ${text}`;
    $("order-ref").textContent = order.orderId;

    const actions = $("order-actions");
    actions.textContent = "";
    if (order.state === "awaiting_payment" && order.checkoutUrl) {
      const resume = el("a", "button button--dark button--small", "Resume payment ↗");
      resume.href = order.checkoutUrl;
      actions.append(resume);
    }
    if (["topup_failed", "review", "expired"].includes(order.state)) {
      const help = el("a", "button button--dark button--small", "WhatsApp support ↗");
      help.href = whatsappLink(`Hi Pak-Tel, I need help with my top-up.\nOrder: ${order.orderId}\nICCID: ${order.iccid}\nPlan: ${order.planName}\nStatus: ${view.title}`);
      help.target = "_blank";
      help.rel = "noopener";
      actions.append(help);
    }
    if (FINAL_STATES.has(order.state)) {
      const dismiss = el("button", "button button--ghost-dark button--small", "Dismiss");
      dismiss.type = "button";
      dismiss.addEventListener("click", () => { banner.hidden = true; });
      actions.append(dismiss);
    }
  }

  async function trackOrder(orderId, opts) {
    clearTimeout(state.pollTimer);
    let order;
    try {
      order = (await api(`/api/orders/${encodeURIComponent(orderId)}`)).order;
    } catch (error) {
      if (error.status === 404 || error.status === 400) {
        toast("We couldn't find that order.", "error");
        return;
      }
      state.pollTimer = setTimeout(() => trackOrder(orderId, opts), 8000);
      return;
    }
    renderOrder(order, opts);

    if (!state.iccid && order.iccid) {
      input.value = order.iccid;
      updateCount();
      await loadEsim(order.iccid);
    }

    const changed = state.lastOrderState !== order.state;
    state.lastOrderState = order.state;
    if (changed) {
      if (order.state === "completed") toast("Top-up successful", "success", "Your plan was added to your eSIM.");
      else if (order.paymentStatus === "paid" && order.state === "processing") toast("Payment confirmed", "success", "Your top-up is being prepared.");
      else if (["review", "topup_failed"].includes(order.state)) toast("Order needs attention", "warning", "Please contact support with your order reference.");
      else if (["expired", "payment_failed", "cancelled"].includes(order.state)) toast("Payment not confirmed", "warning", "Contact support if you have already paid.");
    }
    if (FINAL_STATES.has(order.state)) {
      if (changed && state.iccid) {
        if (order.state === "completed") await loadEsim(state.iccid, { silent: true });
        loadHistory();
      }
      return;
    }
    if (changed && state.iccid) loadHistory();
    const elapsed = Date.now() - state.pollStarted;
    if (elapsed > 45 * 60 * 1000) return; // stop after 45 min; a reload resumes
    state.pollTimer = setTimeout(() => trackOrder(orderId, opts), elapsed > 3 * 60 * 1000 ? 10000 : 4000);
  }

  /* ---------- History ---------- */
  const PAY_CHIP = {
    pending: ["Payment pending", "quiet"], paid: ["Paid", null], expired: ["Payment expired", "warn"],
    failed: ["Payment failed", "bad"], cancelled: ["Cancelled", "quiet"], review: ["Payment in review", "warn"], error: ["Not started", "quiet"],
  };
  const TOPUP_CHIP = {
    not_started: null, processing: ["Top-up in progress", "info"], success: ["Top-up successful", null],
    failed: ["Top-up failed", "bad"], review: ["Top-up in review", "warn"],
  };

  async function loadHistory() {
    if (!state.iccid) return;
    const iccid = state.iccid;
    const block = $("history");
    const list = $("history-list");
    const status = $("history-status");
    block.hidden = false;
    try {
      const data = await api("/api/transactions", { method: "POST", body: { iccid } });
      if (iccid !== state.iccid) return;
      list.textContent = "";
      const items = data.transactions || [];
      status.textContent = items.length ? `${items.length} transaction${items.length === 1 ? "" : "s"} for this eSIM` : "";
      if (!items.length) {
        list.append(el("div", "notice", "No top-ups yet for this eSIM. Your payments and top-ups will appear here."));
        return;
      }
      for (const tx of items) {
        const row = el("div", "history-item");
        const main = el("div", "history-main");
        main.append(el("strong", null, tx.planName), el("small", null, `${formatDate(tx.createdAt) || ""} · ${tx.orderId}`));
        const amount = el("div", "history-amount", pkr(tx.amountPkr));
        const chips = el("div", "history-chips");
        const [payLabel, payTone] = PAY_CHIP[tx.paymentStatus] || [tx.paymentStatus, "quiet"];
        const payChip = el("span", "status-chip");
        setChip(payChip, payLabel, payTone);
        chips.append(payChip);
        const topup = TOPUP_CHIP[tx.topupStatus];
        if (topup) {
          const chip = el("span", "status-chip");
          setChip(chip, topup[0], topup[1]);
          chips.append(chip);
        }
        row.append(main, amount, chips);
        if (tx.state === "awaiting_payment" && tx.checkoutUrl) {
          const resume = el("a", "button button--dark button--small", "Pay ↗");
          resume.href = tx.checkoutUrl;
          row.append(resume);
        } else if (["topup_failed", "review"].includes(tx.state)) {
          const help = el("a", "button button--dark button--small", "Get help ↗");
          help.href = whatsappLink(`Hi Pak-Tel, I need help with my top-up.\nOrder: ${tx.orderId}\nICCID: ${iccid}\nPlan: ${tx.planName}`);
          help.target = "_blank";
          help.rel = "noopener";
          row.append(help);
        } else {
          row.append(el("span"));
        }
        list.append(row);
      }
    } catch (error) {
      list.textContent = "";
      status.textContent = "";
      list.append(el("div", "notice", `We couldn't load your transaction history. ${error.message}`));
    }
  }

  /* ---------- boot ---------- */
  const header = document.querySelector("[data-header]");
  const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 12);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // Restoring from the back/forward cache after DPay: re-enable the pay button.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) { if (dialog.open) dialog.close(); if (state.iccid) loadEsim(state.iccid, { silent: true }); }
  });

  updateCount();
  refreshWhatsappLinks();
  loadPlans();

  const params = new URLSearchParams(window.location.search);
  const orderId = params.get("order");
  let saved = null;
  try { saved = sessionStorage.getItem(SESSION_KEY); } catch { /* ignore */ }

  (async () => {
    // Prefilled link: /iccid/<iccid> fills the box and runs "Check eSIM" automatically.
    // It wins over the eSIM remembered for this tab.
    const linkMatch = window.location.pathname.match(/^\/iccid(?:\/([^/]*))?\/?$/);
    let linked = null;
    let linkInvalid = false;
    if (linkMatch) {
      let segment = "";
      try { segment = decodeURIComponent(linkMatch[1] || "").trim(); } catch { /* malformed escape */ }
      if (ICCID_RE.test(segment)) linked = segment;
      else linkInvalid = true;
    }
    if (linkInvalid) {
      showFormError("This link doesn't contain a valid ICCID. An ICCID is exactly 19 or 20 digits — please check the link or type your ICCID here.");
      input.focus();
    } else {
      const initial = linked || (saved && ICCID_RE.test(saved) ? saved : null);
      if (initial) {
        input.value = initial;
        updateCount();
        await loadEsim(initial, { scroll: Boolean(linked) && !orderId });
      }
    }
    if (orderId && /^PT-[A-Z0-9]{20}$/.test(orderId)) {
      state.pollStarted = Date.now();
      await trackOrder(orderId, { cancelledHint: params.get("cancelled") === "1" });
      $("order-banner").scrollIntoView({ behavior: "smooth", block: "center" });
      // Keep the order in the URL out of history noise but allow reload to resume tracking.
    }
  })();
})();
