"use client";

// src/store.ts
var g = globalThis;
var _a;
var S = (_a = g.__dynaura) != null ? _a : g.__dynaura = { current: null, queue: [], n: 0, subs: /* @__PURE__ */ new Set(), useQueue: false, paused: false, maxQueue: Infinity, dedupe: "id" };
var end = (t, r) => {
  var _a2, _b;
  (_a2 = t.onDismiss) == null ? void 0 : _a2.call(t, r);
  if (r === "timeout") (_b = t.onAutoClose) == null ? void 0 : _b.call(t);
};
var set = (t, r = "api") => {
  var _a2;
  const p = S.current;
  S.current = t;
  notify();
  if (p && p.id !== (t == null ? void 0 : t.id)) end(p, r);
  if (t && t.id !== (p == null ? void 0 : p.id)) (_a2 = t.onShow) == null ? void 0 : _a2.call(t);
};
var subscribe = (f) => {
  S.subs.add(f);
  return () => {
    S.subs.delete(f);
  };
};
var getCurrent = () => S.current;
var setQueue = (v) => {
  S.useQueue = v;
};
var setQueueOpts = (maxQueue, dedupe) => {
  S.maxQueue = maxQueue;
  S.dedupe = dedupe;
};
var isPaused = () => S.paused;
var notify = () => S.subs.forEach((f) => f());
var norm = (o) => typeof o === "string" ? { title: o } : o;
var make = (type) => (o) => {
  var _a2, _b;
  const o2 = norm(o);
  const sticky = type === "loading" || type === "live";
  const t0 = { duration: sticky ? null : 4e3, ...type === "live" ? { kind: "timer" } : {}, ...o2, type };
  const dup = [S.current, ...S.queue].find((x) => x && (o2.id && x.id === o2.id || S.dedupe === "title" && o2.title && x.title === o2.title));
  if (dup) {
    const { id: _, ...patch } = t0;
    update(dup.id, patch);
    return dup.id;
  }
  const t = { ...t0, id: (_a2 = o2.id) != null ? _a2 : String(++S.n) };
  if (S.current && ((_b = t.queue) != null ? _b : S.useQueue)) {
    S.queue.push(t);
    while (S.queue.length > S.maxQueue) end(S.queue.shift(), "api");
  } else set(t);
  return t.id;
};
function update(id, patch) {
  var _a2;
  if (((_a2 = S.current) == null ? void 0 : _a2.id) === id) return set({ ...S.current, ...patch });
  const i = S.queue.findIndex((t) => t.id === id);
  if (i >= 0) S.queue[i] = { ...S.queue[i], ...patch };
}
var pick = (r, v) => norm(typeof r === "function" ? r(v) : r);
var dynaura = {
  success: make("success"),
  error: make("error"),
  warning: make("warning"),
  info: make("info"),
  loading: make("loading"),
  /** Live activity: sticky island with a running timer (default) or waveform. */
  live: make("live"),
  update,
  /** fully custom body: string, DOM Node or (React adapter) element. Options as usual, `title` optional. */
  custom: (content, o = {}) => make("info")({ title: "", ...o, custom: content }),
  /** freeze every timer (e.g. while a modal is open). Toasts shown meanwhile start frozen too. */
  pause: () => {
    S.paused = true;
    notify();
  },
  resume: () => {
    S.paused = false;
    notify();
  },
  /** dismiss the current toast (next queued one shows) or a specific id */
  dismiss: (id, reason = "api") => {
    var _a2, _b;
    if (id && ((_a2 = S.current) == null ? void 0 : _a2.id) !== id) {
      const q = S.queue.find((t) => t.id === id);
      S.queue = S.queue.filter((t) => t.id !== id);
      if (q) end(q, reason);
      return;
    }
    set((_b = S.queue.shift()) != null ? _b : null, reason);
  },
  clear: () => {
    const q = S.queue;
    S.queue = [];
    set(null);
    q.forEach((t) => end(t, "api"));
  },
  promise(p, o) {
    const id = make("loading")(o.loading);
    p.then(
      (v) => update(id, { duration: 4e3, ...pick(o.success, v), type: "success" }),
      (e) => update(id, { duration: 4e3, ...pick(o.error, e), type: "error" })
    );
    return p;
  }
};

// src/confetti.ts
function burst(x, y, color) {
  const c = document.createElement("canvas");
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth, H = innerHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  c.style.cssText = `position:fixed;top:0;left:0;width:${W}px;height:${H}px;pointer-events:none;z-index:2147483647`;
  document.body.append(c);
  const ctx = c.getContext("2d");
  if (!ctx) return c.remove();
  ctx.scale(dpr, dpr);
  const colors = [color, "#fff", color, "#ffd60a", "#0a84ff"];
  const ps = Array.from({ length: 36 }, () => {
    const a = Math.random() * Math.PI * 2, s = 3 + Math.random() * 6;
    return { x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 3, r: 2 + Math.random() * 3, rot: Math.random() * 6, c: colors[Math.random() * colors.length | 0] };
  });
  const t0 = performance.now();
  const frame = (t) => {
    const k = (t - t0) / 1e3;
    if (k >= 1) return c.remove();
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.28;
      p.vx *= 0.985;
      p.rot += 0.2;
      ctx.globalAlpha = 1 - k * k;
      ctx.fillStyle = p.c;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// src/core.ts
var VAR = {
  background: "bg",
  foreground: "fg",
  muted: "muted",
  ring: "ring",
  button: "btn",
  success: "success",
  error: "error",
  warning: "warning",
  info: "info",
  loading: "loading",
  live: "live"
};
var svg = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
var ICON = {
  success: svg('<path class="dynaura-draw" d="M5 12.5l4.5 4.5L19 7.5"/>'),
  error: svg('<path class="dynaura-draw" d="M7 7l10 10M17 7L7 17"/>'),
  warning: svg('<path class="dynaura-draw" d="M12 6v7M12 17.5v.01"/>'),
  info: svg('<path class="dynaura-draw" d="M12 11v6M12 7.5v.01"/>'),
  loading: svg('<circle class="dynaura-spin" cx="12" cy="12" r="8" stroke-dasharray="30 50"/>')
};
var DOT = '<span class="dynaura-dot"></span>';
var WAVE = '<span class="dynaura-wave"><i></i><i></i><i></i><i></i></span>';
var VIBRATE = { success: [12], error: [24, 40, 24], warning: [30], info: [8], loading: [], live: [8] };
var f2 = (n) => +n.toFixed(2);
function outline(w, h2, cw, ch, hx) {
  if (h2 <= ch + 1 || w <= cw + 1) {
    const q = f2(Math.min(h2 / 2, w / 2, 32));
    return `M${q} 0H${f2(w - q)}A${q} ${q} 0 0 1 ${f2(w)} ${q}V${f2(h2 - q)}A${q} ${q} 0 0 1 ${f2(w - q)} ${f2(h2)}H${q}A${q} ${q} 0 0 1 0 ${f2(h2 - q)}V${q}A${q} ${q} 0 0 1 ${q} 0Z`;
  }
  const r = f2(Math.min(ch / 2, 32));
  const b = f2(Math.max(0, Math.min(28, (h2 - ch) / 2, (w - cw) / 2)));
  const f = f2(Math.min(16, b));
  const x0 = f2(hx), x1 = f2(hx + cw);
  const flushL = hx < 1, flushR = hx + cw > w - 1;
  let d = `M${f2(x0 + r)} 0H${f2(x1 - r)}A${r} ${r} 0 0 1 ${x1} ${r}`;
  d += flushR ? `V${f2(h2 - b)}` : `V${f2(ch - f)}A${f} ${f} 0 0 0 ${f2(x1 + f)} ${f2(ch)}H${f2(w - b)}A${b} ${b} 0 0 1 ${f2(w)} ${f2(ch + b)}V${f2(h2 - b)}`;
  d += `A${b} ${b} 0 0 1 ${f2(w - b)} ${f2(h2)}H${b}A${b} ${b} 0 0 1 0 ${f2(h2 - b)}`;
  d += flushL ? `V${r}` : `V${f2(ch + b)}A${b} ${b} 0 0 1 ${b} ${f2(ch)}H${f2(x0 - f)}A${f} ${f} 0 0 0 ${x0} ${f2(ch - f)}V${r}`;
  return d + `A${r} ${r} 0 0 1 ${f2(x0 + r)} 0Z`;
}
var h = (tag, cls, parent) => {
  const e = document.createElement(tag);
  e.className = cls;
  parent == null ? void 0 : parent.append(e);
  return e;
};
var restart = (e) => {
  e.style.animation = "none";
  void e.offsetWidth;
  e.style.animation = "";
};
function roll(e, s) {
  const sig = s.replace(/\d/g, "0");
  if (e.dataset.sig !== sig) {
    e.dataset.sig = sig;
    e.replaceChildren();
    e.setAttribute("role", "img");
    for (const ch of s) {
      if (/\d/.test(ch)) {
        const d = h("span", "dynaura-digit", e);
        d.setAttribute("aria-hidden", "true");
        h("span", "dynaura-strip", d).innerHTML = "0123456789".replace(/\d/g, "<i>$&</i>");
      } else h("span", "dynaura-char", e).textContent = ch;
    }
  }
  e.setAttribute("aria-label", s);
  [...s].forEach((ch, i) => {
    if (/\d/.test(ch)) e.children[i].style.setProperty("--d", ch);
  });
}
function createToaster(initial = {}) {
  const o = { position: "top", offset: 12, theme: "dark", timer: true, haptics: true, queue: false, maxQueue: Infinity, dedupe: "id", swipe: "edge" };
  const merge = (n) => {
    for (const k in n) if (n[k] !== void 0) o[k] = n[k];
  };
  merge(initial);
  try {
    if (process.env.NODE_ENV !== "production" && document.querySelector(".dynaura-root"))
      console.warn("[dynaura] a Toaster is already mounted. Mount one per page; extra ones render every toast twice.");
  } catch {
  }
  const root = h("div", "dynaura-root");
  const drag = h("div", "dynaura-drag", root);
  const island = h("div", "dynaura-island", drag);
  island.setAttribute("role", "status");
  island.setAttribute("aria-live", "polite");
  const inner = h("div", "dynaura-inner", island);
  const row = h("div", "dynaura-row", inner);
  const badge = h("span", "dynaura-badge", row);
  const title = h("span", "dynaura-title", row);
  const trail = h("span", "dynaura-trailing", row);
  const body = h("div", "dynaura-body", inner);
  const desc = h("div", "dynaura-desc", body);
  const actions = h("div", "dynaura-actions", body);
  const btn = h("button", "dynaura-button", actions);
  const btn2 = h("button", "dynaura-button dynaura-secondary", actions);
  const cust = h("div", "dynaura-custom", inner);
  const bar = h("div", "dynaura-bar", island);
  island.hidden = true;
  cust.hidden = true;
  island.dataset.expanded = "false";
  island.dataset.paused = "false";
  document.body.append(root);
  let t = null;
  let expanded = false, hovered = false, pinned = false, dragging = false, ready = false;
  let hideT, expandT, collapseT, dismissT, liveI, lp;
  let remaining = 0, startedAt = 0, liveStart = 0;
  let sz = { cw: 0, ch: 0, ew: 0, eh: 0 };
  let applied = [];
  const custom = { cls: [], sty: [] };
  const hosts = /* @__PURE__ */ new Map();
  let px = "center";
  const place = () => {
    const [y, x = "center"] = o.position.split("-");
    const rtl = getComputedStyle(root).direction === "rtl";
    px = x === "start" ? rtl ? "right" : "left" : x === "end" ? rtl ? "left" : "right" : x;
    root.dataset.y = y;
    root.dataset.x = px;
  };
  const dir = () => o.position.startsWith("bottom") ? 1 : -1;
  const hasBody = () => !!t && t.custom == null && (t.description != null && typeof t.description !== "boolean" || !!t.button || !!t.secondaryButton);
  const paused = () => hovered || pinned || dragging || isPaused();
  function put(slot, c) {
    var _a2;
    const old = hosts.get(slot);
    if (old) {
      (_a2 = o.render) == null ? void 0 : _a2.call(o, old, null);
      hosts.delete(slot);
    }
    slot.replaceChildren();
    if (c == null || typeof c === "boolean") return;
    if (typeof c === "string" || typeof c === "number") slot.textContent = String(c);
    else if (c instanceof Node) slot.append(c);
    else if (o.render) {
      const host = h("span", "dynaura-host", slot);
      hosts.set(slot, host);
      o.render(host, c);
    }
  }
  let raf = 0;
  const isCard = () => island.dataset.variant === "card";
  function shape() {
    const card = isCard();
    if (!card && !island.style.clipPath) return;
    const cs = getComputedStyle(island);
    const w = parseFloat(cs.width), hh = parseFloat(cs.height);
    if (!isFinite(w) || !isFinite(hh) || w <= 0) return;
    const hx = px === "left" ? 0 : px === "right" ? Math.max(0, w - sz.cw) : Math.max(0, (w - sz.cw) / 2);
    row.style.transform = `translateX(${f2(hx)}px)`;
    island.style.clipPath = `path('${card ? outline(w, hh, sz.cw, sz.ch, hx) : outline(w, hh, w, hh, 0)}')`;
  }
  function shapeLoop() {
    cancelAnimationFrame(raf);
    const end2 = performance.now() + 1300;
    const f = () => {
      shape();
      if (performance.now() < end2) raf = requestAnimationFrame(f);
      else if (!isCard()) {
        island.style.clipPath = "";
        row.style.transform = "";
      }
    };
    f();
  }
  function size() {
    if (!sz.cw) return;
    const w = expanded ? sz.ew : sz.cw, hh = expanded ? sz.eh : sz.ch;
    island.style.width = w + "px";
    island.style.height = hh + "px";
    island.style.borderRadius = isCard() ? "0" : Math.min(hh / 2, 32) + "px";
    if (isCard()) shapeLoop();
    else if (island.style.clipPath) shapeLoop();
  }
  function measure() {
    if (island.hidden) return;
    const cu = !cust.hidden;
    sz = { cw: cu ? inner.offsetWidth : row.offsetWidth, ch: cu ? inner.offsetHeight : row.offsetHeight, ew: inner.offsetWidth, eh: inner.offsetHeight };
    size();
    if (!ready && sz.cw) requestAnimationFrame(() => {
      ready = true;
      island.dataset.ready = "true";
    });
  }
  const ro = new ResizeObserver(measure);
  ro.observe(row);
  ro.observe(inner);
  function setExpanded(v) {
    v = v && hasBody();
    if (v === expanded) return;
    expanded = v;
    island.dataset.expanded = String(v);
    size();
  }
  function clear() {
    if (startedAt) {
      remaining -= Date.now() - startedAt;
      startedAt = 0;
    }
    clearTimeout(collapseT);
    clearTimeout(dismissT);
  }
  function arm() {
    clear();
    if (!t || t.duration == null || paused()) return;
    const id = t.id;
    startedAt = Date.now();
    collapseT = setTimeout(() => {
      if (!pinned) setExpanded(false);
    }, Math.max(0, remaining - 500));
    dismissT = setTimeout(() => dynaura.dismiss(id, "timeout"), remaining);
  }
  function sync() {
    island.dataset.paused = String(paused());
    if (paused()) {
      clear();
      if (hovered || pinned) setExpanded(true);
    } else arm();
  }
  function tick() {
    var _a2;
    if (!t || t.trailing != null) return;
    if (t.progress != null) roll(trail, Math.round(t.progress * 100) + "%");
    else if (t.type === "live" && ((_a2 = t.kind) != null ? _a2 : "timer") === "timer") {
      const s = Math.floor((Date.now() - liveStart) / 1e3);
      roll(trail, `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`);
    }
  }
  const hasTrail = (n) => {
    var _a2;
    return n.trailing != null || n.progress != null || n.type === "live" && ((_a2 = n.kind) != null ? _a2 : "timer") === "timer";
  };
  function apply(n, p) {
    var _a2, _b, _c, _d, _e, _f, _g;
    const ch = (k) => !p || n[k] !== p[k];
    island.dataset.type = n.type;
    island.dataset.clickable = String(!!n.onClick);
    const cu = n.custom != null;
    row.hidden = cu;
    cust.hidden = !cu;
    if (ch("custom")) put(cust, n.custom);
    island.setAttribute("aria-live", n.type === "error" ? "assertive" : "polite");
    island.setAttribute("role", n.type === "error" ? "alert" : "status");
    custom.cls.forEach((c) => island.classList.remove(c));
    custom.sty.forEach((k) => island.style.removeProperty(k));
    custom.cls = (_b = (_a2 = n.className) == null ? void 0 : _a2.split(/\s+/).filter(Boolean)) != null ? _b : [];
    custom.sty = Object.keys((_c = n.style) != null ? _c : {}).map((k) => k.startsWith("--") ? k : k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase()));
    island.classList.add(...custom.cls);
    Object.values((_d = n.style) != null ? _d : {}).forEach((v, i) => island.style.setProperty(custom.sty[i], String(v)));
    island.dataset.variant = drag.dataset.variant = (_e = n.variant) != null ? _e : "default";
    if (ch("type") || ch("icon") || ch("kind")) {
      put(badge, void 0);
      if (n.icon != null) put(badge, n.icon);
      else badge.innerHTML = n.type === "live" ? ((_f = n.kind) != null ? _f : "timer") === "wave" ? WAVE : DOT : ICON[n.type];
      restart(badge);
    }
    if (ch("title")) {
      title.textContent = n.title;
      restart(title);
    }
    if (ch("trailing") || ch("progress") || ch("type") || ch("kind")) {
      trail.hidden = !hasTrail(n);
      if (n.trailing != null) {
        delete trail.dataset.sig;
        trail.removeAttribute("aria-label");
        put(trail, n.trailing);
      } else if (!hasTrail(n)) {
        delete trail.dataset.sig;
        put(trail, void 0);
      }
    }
    if (ch("description")) put(desc, n.description);
    desc.hidden = n.description == null || typeof n.description === "boolean";
    btn.hidden = !n.button;
    if (n.button) btn.textContent = n.button.title;
    btn2.hidden = !n.secondaryButton;
    if (n.secondaryButton) btn2.textContent = n.secondaryButton.title;
    body.hidden = cu || !(n.description != null && typeof n.description !== "boolean") && !n.button && !n.secondaryButton;
    bar.dataset.mode = n.progress != null ? "value" : n.duration != null ? "time" : "none";
    bar.style.setProperty("--p", String((_g = n.progress) != null ? _g : 0));
  }
  function feedback(n) {
    var _a2, _b;
    const active = (_b = (_a2 = navigator.userActivation) == null ? void 0 : _a2.hasBeenActive) != null ? _b : true;
    if (o.haptics && typeof navigator !== "undefined" && navigator.vibrate && active && VIBRATE[n.type].length) navigator.vibrate(VIBRATE[n.type]);
    if (n.confetti && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      requestAnimationFrame(() => {
        const r = island.getBoundingClientRect();
        burst(r.left + r.width / 2, r.top + r.height / 2, getComputedStyle(island).getPropertyValue("--state").trim() || "#30d158");
      });
    }
  }
  const onlyProgress = (p, n) => p.progress == null === (n.progress == null) && [.../* @__PURE__ */ new Set([...Object.keys(n), ...Object.keys(p)])].every((k) => k === "progress" || n[k] === p[k]);
  function render() {
    var _a2, _b, _c;
    const n = getCurrent();
    const p = t;
    if (n && n === p) {
      sync();
      return;
    }
    if (!n) {
      if (p) leave();
      return;
    }
    const same = !!p && p.id === n.id;
    if (same && onlyProgress(p, n)) {
      t = n;
      bar.style.setProperty("--p", String((_a2 = n.progress) != null ? _a2 : 0));
      tick();
      return;
    }
    t = n;
    clearTimeout(hideT);
    if (island.hidden) {
      place();
      island.hidden = false;
      drag.style.transform = "";
      drag.style.opacity = "";
      restart(island);
    }
    island.dataset.open = "true";
    if (!same) {
      liveStart = Date.now();
      pinned = false;
    }
    apply(n, same ? p : null);
    measure();
    if (!same || n.type !== p.type) feedback(n);
    clearInterval(liveI);
    if (n.type === "live") liveI = setInterval(tick, 1e3);
    tick();
    clear();
    startedAt = 0;
    remaining = (_b = n.duration) != null ? _b : 0;
    restart(bar);
    bar.style.animationDuration = ((_c = n.duration) != null ? _c : 0) + "ms";
    if (!pinned) setExpanded(false);
    clearTimeout(expandT);
    if (hasBody()) expandT = setTimeout(() => setExpanded(true), 450);
    sync();
  }
  function leave() {
    clear();
    startedAt = 0;
    clearTimeout(expandT);
    clearInterval(liveI);
    hovered = pinned = dragging = false;
    t = null;
    island.dataset.open = "false";
    hideT = setTimeout(() => {
      cancelAnimationFrame(raf);
      island.style.clipPath = "";
      island.hidden = true;
      ready = false;
      expanded = false;
      row.style.transform = "";
      delete island.dataset.ready;
      island.dataset.expanded = "false";
      island.style.width = island.style.height = island.style.borderRadius = "";
      [badge, trail, desc, cust].forEach((s) => put(s, void 0));
      delete trail.dataset.sig;
    }, 450);
  }
  btn.onclick = () => {
    const c = t;
    if (c == null ? void 0 : c.button) {
      c.button.onClick();
      dynaura.dismiss(c.id, "button");
    }
  };
  btn2.onclick = () => {
    const c = t;
    if (c == null ? void 0 : c.secondaryButton) {
      c.secondaryButton.onClick();
      dynaura.dismiss(c.id, "button");
    }
  };
  let sy = 0, t0 = 0, moved = false, longed = false;
  const sign = () => o.swipe === "up" ? -1 : o.swipe === "down" ? 1 : dir();
  const dist = (dy) => o.swipe === "both" ? Math.abs(dy) : dy * sign();
  island.addEventListener("pointerenter", (e) => {
    if (e.pointerType === "mouse") {
      hovered = true;
      sync();
    }
  });
  island.addEventListener("pointerleave", (e) => {
    if (e.pointerType !== "mouse") return;
    hovered = false;
    if (!pinned) setExpanded(false);
    sync();
  });
  drag.addEventListener("pointerdown", (e) => {
    var _a2;
    if (!t || e.target.closest("button")) return;
    dragging = true;
    moved = longed = false;
    sy = e.clientY;
    t0 = Date.now();
    (_a2 = drag.setPointerCapture) == null ? void 0 : _a2.call(drag, e.pointerId);
    drag.style.transition = "none";
    lp = setTimeout(() => {
      var _a3;
      if (!moved) {
        longed = true;
        pinned = true;
        if (o.haptics) (_a3 = navigator.vibrate) == null ? void 0 : _a3.call(navigator, 8);
        sync();
      }
    }, 450);
    sync();
  });
  drag.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - sy;
    if (Math.abs(dy) > 6) {
      moved = true;
      clearTimeout(lp);
    }
    if (!moved || o.swipe === "none") return;
    const d = dist(dy);
    const off = o.swipe === "both" ? dy : (d > 0 ? d : -Math.sqrt(-d) * 4) * sign();
    drag.style.transform = `translateY(${off}px)`;
  });
  const up = (e) => {
    var _a2;
    if (!dragging) return;
    dragging = false;
    clearTimeout(lp);
    drag.style.transition = "";
    const d = dist(e.clientY - sy);
    const v = d / Math.max(1, Date.now() - t0);
    if (e.type === "pointerup" && moved && (d > 40 || v > 0.5 && d > 10) && t && o.swipe !== "none") {
      dynaura.dismiss(t.id, "swipe");
      return;
    }
    drag.style.transform = "";
    if (e.type === "pointerup" && !moved && !longed) (_a2 = t == null ? void 0 : t.onClick) == null ? void 0 : _a2.call(t);
    if (e.type === "pointerup" && !moved && !longed && hasBody()) {
      pinned = !pinned;
      if (!pinned && !hovered) setExpanded(false);
    }
    sync();
  };
  drag.addEventListener("pointerup", up);
  drag.addEventListener("pointercancel", up);
  const outside = (e) => {
    if (pinned && !island.contains(e.target)) {
      pinned = false;
      if (!hovered) setExpanded(false);
      sync();
    }
  };
  document.addEventListener("pointerdown", outside);
  const esc = (e) => {
    if (e.key === "Escape" && t && !e.defaultPrevented) dynaura.dismiss(t.id, "escape");
  };
  document.addEventListener("keydown", esc);
  function set2(n) {
    merge(n);
    setQueue(o.queue);
    setQueueOpts(o.maxQueue, o.dedupe);
    place();
    root.dataset.timer = String(o.timer);
    root.dataset.theme = typeof o.theme === "object" ? "custom" : o.theme;
    root.style.setProperty("--dynaura-offset", o.offset + "px");
    applied.forEach((v) => root.style.removeProperty(v));
    applied = [];
    if (typeof o.theme === "object")
      for (const k in o.theme) {
        const v = `--dynaura-${VAR[k]}`;
        root.style.setProperty(v, o.theme[k]);
        applied.push(v);
      }
  }
  set2({});
  const unsub = subscribe(render);
  render();
  return {
    set: set2,
    destroy() {
      unsub();
      ro.disconnect();
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", esc);
      clear();
      [hideT, expandT, liveI, lp].forEach((x) => {
        clearTimeout(x);
        clearInterval(x);
      });
      [badge, trail, desc, cust].forEach((s) => put(s, void 0));
      root.remove();
    }
  };
}

export {
  dynaura,
  createToaster
};
