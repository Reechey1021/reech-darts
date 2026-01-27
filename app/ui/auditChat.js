// app/ui/auditChat.js
import { app } from "../state.js";
import { mySeatIndex } from "../permissions.js";

const MAX_AUDIT = 600; // in-memory only
const MAX_CHAT = 100;  // persisted in match doc (kept small)

function qs(id) { return document.getElementById(id); }

function nowTs() { return Date.now(); }

function safeName(state, seat) {
  const n = state?.match?.players?.[seat]?.name;
  return n || (seat === 0 ? "Player 1" : "Player 2");
}

function formatPreset(state) {
  const rules = state?.match?.rules || {};
  const preset = String(rules.preset || "CUSTOM").toUpperCase();
  const mode = state?.match?.mode || "";
  const bestOf = state?.match?.bestOf || "";
  const style = state?.match?.style || "";
  const bull = state?.match?.starting === "bull" ? "Bull Throw" : "No Bull";
  const parts = [preset, mode, bestOf ? `BO${bestOf}` : "", style, bull].filter(Boolean);
  return parts.join(" - ");
}

function distUnits(d2) {
  // d2 is squared distance in normalized board coords.
  // Convert to a human-friendly integer (arbitrary units, stable for comparison).
  const d = Math.sqrt(Number(d2) || 0);
  return Math.max(0, Math.round(d * 1000));
}

function pushAudit(entry) {
  if (!app.auditFeed) app.auditFeed = [];
  app.auditFeed.push(entry);
  if (app.auditFeed.length > MAX_AUDIT) app.auditFeed.splice(0, app.auditFeed.length - MAX_AUDIT);
}

function makeEntry({ kind, seat = null, text, t = nowTs() }) {
  return { kind, seat, text: String(text || ""), t };
}



// Public helper for other modules to write a system audit line.
export function addAuditSystem(text) {
  try {
    pushAudit(makeEntry({ kind: "system", text: String(text || "") }));
    // If panel is open, re-render immediately (restart actions may not trigger a state render right away).
    const panel = qs("auditChatPanel");
    if (panel && !panel.classList.contains("hidden")) {
      try { renderFeed(app.latestState); } catch (_) {}
    }
  } catch (_) {}
}
function getMergedFeed(state) {
  const audits = Array.isArray(app.auditFeed) ? app.auditFeed : [];
  const chat = Array.isArray(state?.match?.chat) ? state.match.chat : [];
  const items = [];

  for (const a of audits) items.push({ ...a, source: "audit" });
  for (const c of chat) items.push({ source: "chat", kind: "chat", seat: c.seat, text: c.text, t: c.t || 0 });

  items.sort((a, b) => (a.t || 0) - (b.t || 0));
  return items;
}

function renderFeed(state) {
  const feed = qs("auditChatFeed");
  if (!feed) return;

  const items = getMergedFeed(state);

  const html = items.map((it) => {
    if (it.kind === "system") {
      return `<div class="auditLine auditSystem">${escapeHtml(it.text)}</div>`;
    }

    const mySeat = mySeatIndex(state);
    // Sender should appear on the RIGHT, the other player on the LEFT.
    // (Previously this was reversed.)
    let align = "center";
    if (it.seat === mySeat) align = "right";
    else if (it.seat !== null && it.seat !== undefined) align = "left";
    const cls = it.source === "chat" ? "msgChat" : "msgAudit";
    return `<div class="msgRow ${align}">
      <div class="msgPill ${cls}">${escapeHtml(it.text)}</div>
    </div>`;
  }).join("");

  feed.innerHTML = html;

  // auto-scroll to bottom
  feed.scrollTop = feed.scrollHeight;
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}


function autoOpenIfPreferred(state) {
  // Never auto-open on mobile
  if (isMobile()) return;

  const panel = qs("auditChatPanel");
  if (!panel || !panel.classList.contains("hidden")) return;

  const pref = localStorage.getItem("openAuditChatByDefault") === "1";
  if (!pref) return;

  layoutOpen();

  // Ensure correct title for offline vs online
  const isOnline = state?.match?.gameType === "online";
  const title = document.querySelector(".auditChatTitle");
  if (title) title.textContent = isOnline ? "Chat & Audits" : "Audits";
}

function syncPanelMaxHeight() {
  const panel = qs("auditChatPanel");
  const card = qs("gameCard");
  if (!panel || !card) return;
  // Desktop: cap panel height to the game card height, so only the feed scrolls.
  if (!isMobile()) {
    const h = Math.floor(card.getBoundingClientRect().height || 0);
    if (h > 0) panel.style.maxHeight = `${h}px`;
  } else {
    // Mobile overlay: keep it safely within the top half of the viewport to avoid keyboard overlap.
    panel.style.maxHeight = "50vh";
  }
}

function isMobile() {
  // Robust mobile-ish detection: small viewport OR coarse pointer (touch)
  try {
    if (window.matchMedia) {
      if (window.matchMedia("(pointer: coarse)").matches) return true;
      if (window.matchMedia("(max-width: 780px)").matches) return true;
    }
  } catch (_) {}
  return (window.innerWidth || 9999) <= 820;
}

function layoutOpen() {
  const panel = qs("auditChatPanel");
  const card = qs("gameCard");
  if (!panel || !card) return;

  panel.classList.remove("hidden");

  syncPanelMaxHeight();
  panel.setAttribute("aria-hidden", "false");
  document.body.classList.add("auditChatOpen");
  app.__auditChatOpen = true;

  // Layout is now handled by CSS:
  // - Desktop: #gameChatWrap is a flex row with #auditChatPanel alongside #gameCard
  // - Mobile: body.auditChatOpen overlays the panel via a media query
}

function layoutClose() {
  const panel = qs("auditChatPanel");
  const card = qs("gameCard");
  if (!panel || !card) return;

  panel.classList.add("hidden");
  panel.setAttribute("aria-hidden", "true");
  document.body.classList.remove("auditChatOpen");
  app.__auditChatOpen = false;

  // Any layout/positioning is handled purely by CSS now.
}

export function isAuditChatInputFocused() {
  const el = qs("auditChatInput");
  return document.activeElement === el;
}

export function initAuditChatUI() {
  if (!window.__auditChatResizeHook) {
    window.__auditChatResizeHook = true;
    window.addEventListener("resize", () => {
      if (app.__auditChatOpen) syncPanelMaxHeight();
    });
  }
  const openBtn = qs("gsOpenAuditChatBtn");
  const closeBtn = qs("auditChatCloseBtn");
  const sendBtn = qs("auditChatSendBtn");
  const input = qs("auditChatInput");

  if (openBtn) {
    openBtn.addEventListener("click", () => {
      layoutOpen();
      const st = app.latestState;
      const isOnline = st?.match?.gameType === "online";
      const composer = document.querySelector(".auditChatComposer");
      if (composer) composer.classList.toggle("hidden", !isOnline);
      const title = document.querySelector(".auditChatTitle");
      if (title) title.textContent = isOnline ? "Chat & Audits" : "Audits";
      // Close settings modal if it's open
      const gsm = qs("gameSettingsModal");
      if (gsm) gsm.classList.add("hidden");
      // focus input on mobile for convenience
      if (isMobile() && input) setTimeout(() => input.focus(), 50);
      // initial render
      if (app.latestState) renderFeed(app.latestState);
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      layoutClose();
    });
  }

  if (input) {
    const autoresize = () => {
      // Respect the CSS min-height as the starting size (user wants 30px base).
      // We compute lines using scrollHeight minus padding so the base height is
      // stable and only grows when additional lines are added.
      const cs = window.getComputedStyle(input);
      const minH = parseFloat(cs.minHeight) || 30;
      const maxH = parseFloat(cs.maxHeight) || 140;
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const lineH = parseFloat(cs.lineHeight) || 16;

      input.style.height = "auto";
      const contentH = Math.max(0, input.scrollHeight - padY);
      const lines = Math.max(1, Math.ceil(contentH / Math.max(1, lineH)));
      const desired = Math.min(maxH, Math.max(minH, padY + lines * lineH));
      input.style.height = `${Math.round(desired)}px`;
    };
    input.addEventListener("input", autoresize);
    input.addEventListener("focus", () => {
      // allow typing without global hotkeys interfering
      document.body.classList.add("auditChatTyping");
    });
    input.addEventListener("blur", () => {
      document.body.classList.remove("auditChatTyping");
    });
    autoresize();
  }

  const send = async () => {
    const st = app.latestState;
    if (!st?.match) return;
    if (!app.db || !app.gameRef) return;

    const input = qs("auditChatInput");
    if (!input) return;

    const text = String(input.value || "").trim();
    if (!text) return;

    const isOnline = st.match.gameType === "online";
    if (!isOnline) return;
    const seat = isOnline ? mySeatIndex(st) : (st.leg?.currentPlayer ?? 0);
    if (isOnline && (seat === null || seat === undefined)) return;

    const msg = {
      id: `${seat}-${nowTs()}`,
      t: nowTs(),
      seat: seat ?? 0,
      text: text.slice(0, 200),
    };

    // Write into match doc (small ring buffer). Reliable across players and refresh.
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(app.gameRef);
      const state = snap.data();
      if (!state?.match) return;

      const arr = Array.isArray(state.match.chat) ? state.match.chat.slice() : [];
      arr.push(msg);
      if (arr.length > MAX_CHAT) arr.splice(0, arr.length - MAX_CHAT);
      state.match.chat = arr;

      state.updatedAt = new Date();
      tx.set(app.gameRef, state);
    });

    input.value = "";
    input.style.height = "auto";
  };

  if (sendBtn) sendBtn.addEventListener("click", send);
}

export function updateAuditFromState(state, prev) {
  if (!state?.match) return;

  // Initialize on first seen match
  if (!prev?.match && state.match) {
    pushAudit(makeEntry({ kind: "system", text: `Game started with: ${formatPreset(state)}` }));
    return;
  }

  // Bull throw events
  const b0 = prev?.match?.bull;
  const b1 = state?.match?.bull;

  if (b1 && (!b0 || !b0.p1) && b1.p1) {
    pushAudit(makeEntry({ kind: "audit", seat: 0, text: `${safeName(state,0)} threw for bull. Distance: ${distUnits(b1.d1 ?? 0)}.` }));
  }
  if (b1 && (!b0 || !b0.p2) && b1.p2) {
    pushAudit(makeEntry({ kind: "audit", seat: 1, text: `${safeName(state,1)} threw for bull. Distance: ${distUnits(b1.d2 ?? 0)}.` }));
  }
  if (b1 && !b0?.resolved && b1.resolved) {
    const w = b1.winner ?? 0;
    pushAudit(makeEntry({ kind: "system", text: `${safeName(state,w)} wins bull throw. Game started.` }));
  }

  // Score/audit from leg history deltas
  const h0 = Array.isArray(prev?.leg?.history) ? prev.leg.history : [];
  const h1 = Array.isArray(state?.leg?.history) ? state.leg.history : [];
  if (h1.length > h0.length) {
    for (let i = h0.length; i < h1.length; i++) {
      const ev = h1[i];
      if (!ev) continue;

      const seat = ev.player;
      const name = safeName(state, seat);
      const entered = Number(ev.entered) || 0;
      const after = Number(ev.after);
      const before = Number(ev.before);

      if (ev.bust) {
        pushAudit(makeEntry({ kind: "audit", seat, text: `${name} busted with ${entered}. Remaining: ${before}.` , t: nowTs() }));
      } else {
        pushAudit(makeEntry({ kind: "audit", seat, text: `${name} scored ${entered}. Remaining: ${after}.`, t: nowTs() }));
      }

      if (ev.checkoutOpportunity && ev.attemptedCheckout === true) {
        pushAudit(makeEntry({ kind: "system", text: `${name} attempted checkout with ${ev.dartsUsed || 3} darts.` , t: nowTs() }));
      }
    }
  }

  // Next leg start
  if (state.__auditNextLeg && (!prev || !prev.__auditNextLeg)) {
    const starter = state.__auditNextLeg.starter;
    const legNum = state.match.currentLeg;
    pushAudit(makeEntry({ kind: "system", text: `Leg ${legNum} has started. ${safeName(state, starter)} to throw first.` }));
    delete state.__auditNextLeg;
  }

    // Next leg started (Continue pressed)
  if (prev?.leg?.status === "finished" && state?.leg?.status === "in_progress" && Array.isArray(state.leg.history) && state.leg.history.length === 0) {
    const legNum = (Array.isArray(state.match.legs) ? state.match.legs.length : 0) + 1;
    const starterSeat = state.leg.currentPlayer ?? 0;
    pushAudit(makeEntry({ kind: "system", text: `Leg ${legNum} has started, ${safeName(state, starterSeat)} to throw first.` }));
  }

// Leg/match transitions
  const leg0 = prev?.leg;
  const leg1 = state?.leg;
  if (leg0 && leg1 && leg0.status !== leg1.status) {
    if (leg1.status === "finished") {
      const w = leg1.winner;
      if (w === 0 || w === 1) pushAudit(makeEntry({ kind: "system", text: `${safeName(state,w)} wins the leg.` }));
    }
  }

  const m0 = prev?.match;
  const m1 = state?.match;
  if (m0 && m1 && m0.status !== m1.status) {
    if (m1.status === "finished") {
      const w = m1.winner;
      if (w === 0 || w === 1) pushAudit(makeEntry({ kind: "system", text: `${safeName(state,w)} wins the match.` }));
    }
  }
}

export function renderAuditChat(state) {
  if (!app._autoAuditChatOpened) {
    app._autoAuditChatOpened = true;
    try { autoOpenIfPreferred(state); } catch (e) {}
  }
  const panel = qs("auditChatPanel");
  if (!panel || panel.classList.contains("hidden")) return;

  // Offline: hide composer (chat not used)
  const isOnline = state?.match?.gameType === "online";
  const composer = document.querySelector(".auditChatComposer");
  if (composer) composer.classList.toggle("hidden", !isOnline);

  renderFeed(state);
}
