// /dashboard.js (ES module)
// Dashboard is for signed-in (non-anonymous) users only.

import { app } from "./app/state.js";
import { applyBuildTag, logBuildInfo } from "./app/ui/buildInfo.js";
import { initFirebase } from "./app/firebase.js";
import { initAuth, onUserChanged, signOutUser, getActorId, getActorName } from "./app/auth.js";
import { ensureUserProfile, updateMyProfile } from "./app/userProfile.js";
import { acceptFriendRequest, cancelFriendRequest, declineFriendRequest, getFriendStateDb, removeFriend, sendFriendRequest, sendGameInvite, respondToGameInvite, listenForGameInvites } from "./app/friends.js";
import { playSfxWebAudio } from "./app/audio/audio.js";
import { initPageTransitions, softNavigate } from "./app/ui/pageTransitions.js";
import { withBase } from "./app/routing.js";

logBuildInfo();
applyBuildTag();


function qs(id) {
  return document.getElementById(id);
}

function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = (crypto?.randomUUID?.() || (Date.now() + "-" + Math.random())).toString();
    localStorage.setItem("deviceId", id);
  }
  return id;
}

function extractGameIdFromUrl(text) {
  const raw = (text || "").trim();
  if (!raw) return null;

  // Accept a full URL or just a game id
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw) && !raw.includes("?") && !raw.includes("/")) {
    return raw;
  }

  // Try parse as URL
  try {
    const url = new URL(raw, window.location.origin);
    const id = url.searchParams.get("game") || url.searchParams.get("id");
    if (id && /^[A-Za-z0-9_-]{10,}$/.test(id)) return id;
  } catch (e) {
    // ignore parse errors
  }

  // Fallback: look for `game=<id>` substring
  const m = raw.match(/game=([A-Za-z0-9_-]{10,})/);
  if (m && m[1]) return m[1];

  return null;
}

let pendingInviteConfirm = null; // { toUid, toName }
let latestIncomingInvite = null; // { id, ...data }
let stopInviteListener = null;

function openModal(el) {
  if (!el) return;
  ensureModalTopLevel(el);
  el.classList.remove("hidden");
  // modal CSS animates using opacity/visibility; we toggle helper class
  el.classList.add("is-open");
}

function closeModal(el) {
  if (!el) return;
  el.classList.add("is-closing");
  setTimeout(() => {
    el.classList.add("hidden");
    el.classList.remove("is-open");
    el.classList.remove("is-closing");
  }, 160);
}

async function createLobbyDoc({ lobbyType = "online" } = {}) {
  const db = app.db;
  if (!db) return null;

  const seat1Id = getActorId();
  if (!seat1Id) return null;

  const newRef = db.collection("games").doc();
  const newId = newRef.id;

  const now = new Date();
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);

  const seat1Name = getActorName();
  const seat1PhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;

  await newRef.set({
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: "lobby",
    lobbyType,
    createdBy: seat1Id,

    seat1Id,
    seat1Name,
    seat1PhotoURL,
    seat2Id: null,
    seat2Name: null,
    seat2PhotoURL: null,

    lobby: {
      host: {
        actorId: seat1Id,
        name: seat1Name,
        uid: (app.user && !app.user.isAnonymous) ? app.user.uid : null,
        photoURL: seat1PhotoURL,
      },
      joiner: null,
    },
  });

  return newId;
}

function goToGame(gameId, { openInvite = true, autoSetup = true } = {}) {
  if (!gameId) return;
  // Use query-string navigation so this works reliably on simple static servers
  // (e.g. VS Code Live Server on localhost:5500) without requiring rewrite rules.
  const params = new URLSearchParams();
  params.set("game", gameId);
  if (openInvite) params.set("openInvite", "1");
  if (autoSetup) params.set("autoSetup", "1");
  window.location.href = `/game/?${params.toString()}`;
}

function initInviteUiHandlers() {
  const confirmModal = qs("inviteConfirmModal");
  const confirmText = qs("inviteConfirmText");
  const confirmCancel = qs("inviteConfirmCancelBtn");
  const confirmGo = qs("inviteConfirmGoBtn");

  if (confirmCancel) {
    confirmCancel.addEventListener("click", () => closeModal(confirmModal));
  }
  if (confirmGo) {
    confirmGo.addEventListener("click", async () => {
      const toUid = pendingInviteConfirm?.toUid;
      const toName = pendingInviteConfirm?.toName || "Player";
      if (!toUid || !app.user || !app.db) return;

      try {
        // Create lobby first
        const gameId = await createLobbyDoc({ lobbyType: "online" });
        if (!gameId) return;

        // Send invite
        await sendGameInvite(app.db, app.user.uid, toUid, gameId, {
          fromName: getActorName(),
          fromPhotoURL: (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null,
        });

        // Feedback
        if (typeof showFriendFeedback === "function") showFriendFeedback(`Invite sent to ${toName}`);
        closeModal(confirmModal);

        // Navigate to lobby WITHOUT showing the invite/copy-link modal.
        // (This is a friend-invite flow; the invite has already been sent.)
        // Auto-open match setup for the host.
        const params = new URLSearchParams();
        params.set("game", gameId);
        params.set("setup", "1");
        window.location.href = `/game/?${params.toString()}`;
      } catch (e) {
        console.warn("Invite failed", e);
        if (typeof showFriendFeedback === "function") showFriendFeedback("Invite failed. Please try again.");
        closeModal(confirmModal);
      }
    });
  }

  // Incoming invite modal
  const incomingModal = qs("incomingInviteModal");
  const incomingText = qs("incomingInviteText");
  const incomingAccept = qs("incomingInviteAcceptBtn");
  const incomingDecline = qs("incomingInviteDeclineBtn");
  const incomingOk = qs("incomingInviteOkBtn");

  if (incomingDecline) {
    incomingDecline.addEventListener("click", async () => {
      if (!app.user || !app.db || !latestIncomingInvite?.id) return;
      try {
        await respondToGameInvite(app.db, app.user.uid, latestIncomingInvite.id, "declined");
        closeModal(incomingModal);
        latestIncomingInvite = null;
        if (typeof showFriendFeedback === "function") showFriendFeedback("Invite declined");
      } catch (e) {
        console.warn("Decline invite failed", e);
        if (typeof showFriendFeedback === "function") showFriendFeedback("Could not decline invite");
      }
    });
  }

  if (incomingAccept) {
    incomingAccept.addEventListener("click", async () => {
      if (!app.user || !app.db || !latestIncomingInvite?.id) return;
      try {
        const gameId = latestIncomingInvite.gameId;
        const validation = await validateInviteGame(app.db, gameId);
        if (!validation.ok) {
          // Mark invite as expired (best-effort), but keep the modal open so the user sees the message.
          try { await respondToGameInvite(app.db, app.user.uid, latestIncomingInvite.id, "expired"); } catch (e) {}

          if (incomingText) incomingText.textContent = validation.message || "This lobby is no longer available";

          // Swap to a single OK button to acknowledge
          if (incomingAccept) incomingAccept.style.display = "none";
          if (incomingDecline) incomingDecline.style.display = "none";
          if (incomingOk) incomingOk.style.display = "inline-flex";

          if (incomingOk) {
            incomingOk.onclick = () => {
              closeModal(incomingModal);
              latestIncomingInvite = null;
              // restore buttons for next invite
              if (incomingOk) incomingOk.style.display = "none";
              if (incomingAccept) incomingAccept.style.display = "";
              if (incomingDecline) incomingDecline.style.display = "";
            };
          }
          return;
        }

        await respondToGameInvite(app.db, app.user.uid, latestIncomingInvite.id, "accepted");
        closeModal(incomingModal);
        latestIncomingInvite = null;

        // Go to lobby/game WITHOUT showing the invite/copy-link modal.
        // (This user is joining via a friend invite, so no need to show copy-link UI.)
        goToGame(gameId, { openInvite: false, autoSetup: false });
      } catch (e) {
        console.warn("Accept invite failed", e);
        if (typeof showFriendFeedback === "function") showFriendFeedback("Invite failed");
      }
    });
  }

  // Set initial confirm text helper
  if (confirmText) confirmText.textContent = "—";
  if (incomingText) incomingText.textContent = "—";
}

async function validateInviteGame(db, gameId) {
  try {
    if (!db || !gameId) return { ok: false, message: "Invite expired" };

    const snap = await db.collection("games").doc(gameId).get();
    if (!snap.exists) return { ok: false, message: "Invite expired" };

    const state = snap.data() || {};

    // If host has closed/abandoned the lobby/match, treat as unavailable
    if (state.status === "closed" || state.status === "abandoned") {
      return { ok: false, message: "This lobby is no longer available" };
    }

    // must be an online lobby
    const lobbyType = state.lobbyType || state.match?.gameType || "local";
    if (lobbyType !== "online") return { ok: false, message: "That invite is no longer valid" };

    // must still be a lobby (not started/finished)
    if (state.status && state.status !== "lobby") return { ok: false, message: "This lobby is no longer available" };

    // expired lobby
    const exp = state.expiresAt?.toDate ? state.expiresAt.toDate() : state.expiresAt;
    if (exp && Date.now() > new Date(exp).getTime()) return { ok: false, message: "Invite expired" };

    // lobby must have a host
    if (!state.seat1Id) return { ok: false, message: "This lobby is no longer available" };

    // if full, reject
    const fullCheck = await isLobbyFull(db, gameId);
    if (fullCheck.full) return { ok: false, message: fullCheck.message || "Lobby is full" };

    return { ok: true, message: "" };
  } catch (e) {
    console.warn("validateInviteGame failed", e);
    return { ok: false, message: "Invite expired" };
  }
}

function startInviteListener() {
  if (!app.db || !app.user || app.user.isAnonymous) return;
  if (stopInviteListener) stopInviteListener();

  stopInviteListener = listenForGameInvites(app.db, app.user.uid, (docs) => {
    // only on dashboard; show newest pending invite
    const pending = (docs || []).find((d) => d && d.status === "pending");
    if (!pending) return;

    // if already showing this invite, skip
    if (latestIncomingInvite && latestIncomingInvite.id === pending.id) return;

    latestIncomingInvite = pending;

    const incomingModal = qs("incomingInviteModal");
    const incomingText = qs("incomingInviteText");
    if (incomingText) {
      const fromName = pending.fromName || "Player";
      incomingText.textContent = `${fromName} has invited you to a game.`;
    }

    // Invite pop sound (best-effort)
    playSfxWebAudio("/audio/sounds/GameInvite.mp3");
    openModal(incomingModal);
    // Invite received SFX
    playSfxWebAudio("/audio/sounds/GameInvite.mp3");
  });
}

async function isLobbyFull(db, gameId) {
  const snap = await db.collection("games").doc(gameId).get();
  if (!snap.exists) return { full: true, message: "That lobby does not exist." };

  const state = snap.data() || {};
  const match = state.match || {};

  // ✅ Determine game type from match if active, otherwise from lobbyType
  const gameType = match.gameType || state.lobbyType;

  if (gameType !== "online") {
    return { full: true, message: "That lobby is not an online game." };
  }


  if (match.seat1Id && match.seat2Id) {
    const d = getDeviceId();
    if (match.seat1Id !== d && match.seat2Id !== d) {
      return { full: true, message: "This lobby is full." };
    }
  }


  return { full: false, message: "" };
}

// This dashboard is a single-screen layout; keep for backwards compat.
function showView() {}

// -----------------------------
// Modal helpers (match in-game modal animation system)
// Dashboard uses the same .modal / .modal-card CSS.
// -----------------------------
function ensureModalTopLevel(modal) {
  if (!modal) return;
  // If a modal is accidentally nested inside another hidden modal/container,
  // opening it won't show until the parent becomes visible. Move modals to <body>
  // the first time we open them so they always render on top correctly.
  if (modal.dataset && modal.dataset.modalTopLevel === "1") return;

  // Only move true overlay modals (.modal) to avoid breaking normal layout.
  if (modal.classList && modal.classList.contains("modal")) {
    document.body.appendChild(modal);
    if (modal.dataset) modal.dataset.modalTopLevel = "1";
  }
}

function openModalEl(modal) {
  if (!modal) return;
  ensureModalTopLevel(modal);
  modal.classList.remove("hidden");
  modal.style.display = "flex";
  requestAnimationFrame(() => {
    modal.classList.remove("is-closing");
    modal.classList.add("is-open");
  });
}

function closeModalEl(modal) {
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.classList.add("is-closing");

  const finish = () => {
    modal.classList.remove("is-closing");
    modal.classList.add("hidden");
    modal.style.display = "none";
    modal.removeEventListener("transitionend", onEnd);
  };

  const onEnd = (e) => {
    if (e.target === modal && e.propertyName === "opacity") finish();
  };

  modal.addEventListener("transitionend", onEnd);
  setTimeout(() => {
    if (!modal.classList.contains("hidden")) finish();
  }, 250);
}

function formatDateDDMMYYYY(ts) {
  const d = ts ? new Date(ts) : new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = d.getFullYear();
  return `${dd}/${mm}/${yy}`;
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setSettingsModalVisible(visible) {
  const modal = qs("settingsModal");
  if (!modal) return;
  visible ? openModalEl(modal) : closeModalEl(modal);
}

function applyTheme(theme, { persist = true } = {}) {
  document.body.setAttribute("data-theme", theme);
  if (persist) localStorage.setItem("theme", theme);
}

const DASH_DEFAULT_THEME = "cyan";

function getSavedTheme() {
  return localStorage.getItem("theme") || DASH_DEFAULT_THEME;
}

let pendingTheme = null;

function setThemePickerSelected(theme) {
  document.querySelectorAll(".themeSwatch").forEach((btn) => {
    if (btn.dataset.theme === theme) btn.classList.add("isSelected");
    else btn.classList.remove("isSelected");
  });
}

function initThemePicker() {
  // Apply saved theme (or default)
  const initial = getSavedTheme();
  applyTheme(initial, { persist: !localStorage.getItem("theme") }); // persist default once
  pendingTheme = initial;
  setThemePickerSelected(initial);

  // Wire swatches for live preview (no persistence)
  document.querySelectorAll(".themeSwatch").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const theme = btn.dataset.theme;
      if (!theme) return;
      pendingTheme = theme;
      applyTheme(theme, { persist: false }); // preview only
      setThemePickerSelected(theme);
    });
  });
}

async function createLobbyAndGo({ lobbyType = "online" } = {}) {
  const db = app.db;
  if (!db) return;

  const uid = getActorId();
  if (!uid) return;

  const newRef = db.collection("games").doc();
  const newId = newRef.id;

  const now = new Date();
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);

const seat1Id = getActorId();
const seat1Name = getActorName();
const seat1PhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;

await newRef.set({
  createdAt: now,
  updatedAt: now,
  expiresAt,
  status: "lobby",
  lobbyType,
  createdBy: seat1Id,

  // ✅ these are what your realtime join + "waiting for player 2" logic expects
  seat1Id,
  seat1Name,
  seat1PhotoURL,
  seat2Id: null,
  seat2Name: null,
  seat2PhotoURL: null,

  // (optional but helpful – matches what your realtime code already looks for)
  lobby: {
    host: {
      actorId: seat1Id,
      name: seat1Name,
      uid: (app.user && !app.user.isAnonymous) ? app.user.uid : null,
      photoURL: seat1PhotoURL,
    },
    joiner: null,
  },
});


  // Navigate using query-string form so this works on localhost static servers
  // without requiring rewrite rules.
  const params = new URLSearchParams();
  params.set("game", newId);
  if (lobbyType === "online") {
    params.set("openInvite", "1");
    params.set("autoSetup", "1");
  } else {
    // Local games should jump straight into setup once the game listener attaches
    params.set("setup", "1");
  }
  window.location.href = `/game/?${params.toString()}`;
}

function renderWelcome(profile) {
  const nameEl = qs("dashName");
  const equipEl = qs("dashEquipment");
  const img = qs("dashUserPhoto");
  if (img) {
    const url = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || "") : "";
    if (url) {
      img.src = url;
      img.classList.remove("hidden");
    } else {
      img.classList.add("hidden");
      img.removeAttribute("src");
    }
  }

  const name = (profile?.displayName || profile?.nickname || getActorName() || "Player").trim();
  if (nameEl) nameEl.textContent = name;

  const equipment = (profile?.setEquipment || profile?.equipment || "").trim();
  if (equipEl) {
    equipEl.textContent = equipment ? `${equipment}` : "";
    equipEl.style.display = equipment ? "flex" : "none";
  }
}

function renderStats(profile) {
  const last = qs("dashLast5");
  const tdaEl = qs("dashTdaVal");
  const f9dEl = qs("dashF9dVal");
  const matchesEl = qs("dashMatchesVal");
  const dartsEl = qs("dashDartsVal");
  const winsEl = qs("dashWinsVal");
  const lossesEl = qs("dashLossesVal");
  const winRateEl = qs("dashWinRateVal");
  const winRateDonut = qs("dashWinRateDonut");
  const s100El = qs("dash100Val");
  const s140El = qs("dash140Val");
  const s180El = qs("dash180Val");
  const checkoutPctEl = qs("dashCheckoutPctVal");

  const s = profile?.stats || {};

  const matches = Number(s.matches || 0);
  const wins = Number(s.wins || 0);
  const losses = Number(s.losses || 0);

  const totalPoints = Number(s.totalPoints || 0);
  const totalDarts = Number(s.totalDarts || 0);
  // Support both legacy keys (first9Points/first9Darts + hs/s100/s140/s180)
  // and the newer aggregated keys written by app/userStats.js.
  const first9Points = Number(s.first9Points || s.totalFirst9Points || 0);
  const first9Darts = Number(s.first9Darts || s.totalFirst9Darts || 0);

  const tda = totalDarts ? Math.round((totalPoints / totalDarts) * 3) : 0;
  const f9d = first9Darts ? Math.round((first9Points / first9Darts) * 3) : 0;

  const hs = Number(s.hs || s.highestScore || 0);
  const s100 = Number(s.s100 || s.hundredPlus || s.total100s || 0);
  const s140 = Number(s.s140 || s.oneFortyPlus || s.total140s || 0);
  const s180 = Number(s.s180 || s.oneEighty || s.total180s || 0);
  const lifetimeDarts = Number(s.lifetimeDarts || 0);

  const checkoutThrown = Number(s.checkoutDoublesThrown || 0);
  const checkoutHit = Number(s.checkoutDoublesHit || 0);
  const checkoutPct = checkoutThrown ? Math.round((checkoutHit / checkoutThrown) * 100) : 0;

  if (tdaEl) tdaEl.textContent = tda;
  if (f9dEl) f9dEl.textContent = f9d;
  if (matchesEl) matchesEl.textContent = matches;
  if (dartsEl) dartsEl.textContent = lifetimeDarts || totalDarts || 0;
  if (winsEl) winsEl.textContent = wins;
  if (lossesEl) lossesEl.textContent = losses;
  if (winRateEl) {
    const rate = matches ? Math.round((wins / matches) * 100) : 0;
    winRateEl.textContent = `${rate}%`;
    if (winRateDonut) {
      const p = Math.max(0, Math.min(1, rate / 100));
      winRateDonut.style.setProperty("--p", String(p));
    }
  }
  if (s100El) s100El.textContent = s100;
  if (s140El) s140El.textContent = s140;
  if (s180El) s180El.textContent = s180;
  if (checkoutPctEl) checkoutPctEl.textContent = `${checkoutPct}%`;

  if (last) {
    const arr = Array.isArray(s.recentResults) ? s.recentResults.slice(0, 5) : [];
    last.innerHTML = arr.length
      ? arr
          .map((r) => {
            const v = String(r).toUpperCase();
            const cls = v === "W" ? "w" : "l";
            return `<span class="dashWL ${cls}">${v}</span>`;
          })
          .join("")
      : `<span style="opacity:.7;">—</span>`;
  }
}

function wireDashboardUI() {
  const playLocalCard = qs("dashPlayLocalCard");
  const playOnlineCard = qs("dashPlayOnlineCard");
  const nemesisCard = qs("dashNemesisCard");
  const joinGameBtn = qs("dashJoinGameBtn");
  const settingsBtn = qs("dashSettingsBtn");
  const matchHistoryBtn = qs("dashMatchHistoryBtn");
  const statsHistoryBtn = qs("dashStatsHistoryBtn");
  const friendsBtn = qs("dashFriendsBtn");

  // Confirm sign out modal
  const confirmSignOutModal = qs("confirmSignOutModal");
  const confirmSignOutCancelBtn = qs("confirmSignOutCancelBtn");
  const confirmSignOutOkBtn = qs("confirmSignOutOkBtn");

  const setConfirmSignOutVisible = (visible) => {
    if (!confirmSignOutModal) return;
    visible ? openModalEl(confirmSignOutModal) : closeModalEl(confirmSignOutModal);
  };


  // Stats History modal
  const statsHistoryModal = qs("statsHistoryModal");
  const shCloseBtn = qs("shCloseBtn");
  const shWeekBtn = qs("shWeekBtn");
  const shMonthBtn = qs("shMonthBtn");
  const shYearBtn = qs("shYearBtn");
  const shLegend = qs("shLegend");
  const shXAxisLabels = qs("shXAxisLabels");
  const shMasterCanvas = qs("shMasterCanvas");

  const setStatsHistoryVisible = (visible) => {
    if (!statsHistoryModal) return;
    visible ? openModalEl(statsHistoryModal) : closeModalEl(statsHistoryModal);
  };

  function setRangeActive(range) {
    const btns = [
      [shWeekBtn, "week"],
      [shMonthBtn, "month"],
      [shYearBtn, "year"],
    ];
    btns.forEach(([b, k]) => {
      if (!b) return;
      b.classList.toggle("primary", k === range);
      b.classList.toggle("secondary", k !== range);
    });
  }

  function ymd(d) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  function getSeries(range) {
    const daily = app.userProfile?.stats?.dailyAgg || {};
    const now = new Date();

    const buckets = [];
    if (range === "week") {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const a = daily[ymd(d)] || {};
        buckets.push({
          label: d.toLocaleDateString(undefined, { weekday: "short" }),
          matches: Number(a.matches || 0),
          tda: a.tdaCount ? (Number(a.tdaSum || 0) / Number(a.tdaCount || 1)) : 0,
          f9d: a.f9dCount ? (Number(a.f9dSum || 0) / Number(a.f9dCount || 1)) : 0,
          checkout: a.checkoutPctCount ? (Number(a.checkoutPctSum || 0) / Number(a.checkoutPctCount || 1)) : 0,
        });
      }
    } else if (range === "month") {
      // 4 buckets of 7 days
      for (let w = 3; w >= 0; w--) {
        const start = new Date(now);
        start.setDate(start.getDate() - (w * 7 + 6));
        const end = new Date(now);
        end.setDate(end.getDate() - (w * 7));

        let matches = 0, tdaSum = 0, tdaCount = 0, f9dSum = 0, f9dCount = 0, cSum = 0, cCount = 0;
        for (let i = 0; i < 7; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const a = daily[ymd(d)] || {};
          matches += Number(a.matches || 0);
          tdaSum += Number(a.tdaSum || 0); tdaCount += Number(a.tdaCount || 0);
          f9dSum += Number(a.f9dSum || 0); f9dCount += Number(a.f9dCount || 0);
          cSum += Number(a.checkoutPctSum || 0); cCount += Number(a.checkoutPctCount || 0);
        }

        buckets.push({
          label: `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })}-${end.toLocaleDateString(undefined, { day: "numeric" })}`,
          matches,
          tda: tdaCount ? (tdaSum / tdaCount) : 0,
          f9d: f9dCount ? (f9dSum / f9dCount) : 0,
          checkout: cCount ? (cSum / cCount) : 0,
        });
      }
    } else {
      // year: 12 months
      for (let m = 11; m >= 0; m--) {
        const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
        const month = d.getMonth();
        const year = d.getFullYear();

        let matches = 0, tdaSum = 0, tdaCount = 0, f9dSum = 0, f9dCount = 0, cSum = 0, cCount = 0;
        const dim = new Date(year, month + 1, 0).getDate();
        for (let day = 1; day <= dim; day++) {
          const dd = new Date(year, month, day);
          const a = daily[ymd(dd)] || {};
          matches += Number(a.matches || 0);
          tdaSum += Number(a.tdaSum || 0); tdaCount += Number(a.tdaCount || 0);
          f9dSum += Number(a.f9dSum || 0); f9dCount += Number(a.f9dCount || 0);
          cSum += Number(a.checkoutPctSum || 0); cCount += Number(a.checkoutPctCount || 0);
        }

        buckets.push({
          label: d.toLocaleDateString(undefined, { month: "short" }),
          matches,
          tda: tdaCount ? (tdaSum / tdaCount) : 0,
          f9d: f9dCount ? (f9dSum / f9dCount) : 0,
          checkout: cCount ? (cSum / cCount) : 0,
        });
      }
    }

    return buckets;
  }

  function cssVar(name, fallback = "") {
    // Prefer the canvas scope if available (theme-aware)
    if (window.shMasterCanvas) {
      const v = getComputedStyle(shMasterCanvas)
        .getPropertyValue(name)
        .trim();
      if (v) return v;
    }

    // Fallback: body (theme classes usually live here)
    const bodyVal = getComputedStyle(document.body)
      .getPropertyValue(name)
      .trim();
    if (bodyVal) return bodyVal;

    // Last resort: :root
    const rootVal = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return rootVal || fallback;
  }



  function drawMulti(canvas, series, labels, colors) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    // IMPORTANT: never use `canvas.height` as the *CSS* height source.
    // We set canvas.height to the DPR-scaled backing buffer, which would
    // otherwise inflate the element's layout height on each redraw (mobile bug:
    // Week/Month/Year buttons make the graph grow taller and taller).
    const baseHAttr = Number(canvas.getAttribute("height") || 240);
    if (!canvas.dataset.cssH) {
      const cssH0 = Math.floor(rect.height || baseHAttr);
      canvas.dataset.cssH = String(cssH0 || baseHAttr);
      // lock the CSS height so changing the backing buffer doesn't change layout
      canvas.style.height = `${canvas.dataset.cssH}px`;
    }

    const cssW = Math.max(320, Math.floor(rect.width || 720));
    const cssH = Math.max(180, Math.floor(Number(canvas.dataset.cssH) || baseHAttr || 240));

    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = cssW;
    const h = cssH;
    ctx.clearRect(0, 0, w, h);

    const padL = 52, padR = 14, padT = 16, padB = 28;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    // Y scale: auto-fit data (still keeps a visible 0–100 band)
    const flat = [];
    (series || []).forEach(arr => (arr || []).forEach(v => flat.push(Number(v || 0))));
    const maxValRaw = flat.length ? Math.max(...flat) : 0;
    const maxVal = Math.max(10, maxValRaw);
    const yMaxBase = Math.ceil(maxVal / 10) * 10;
    // Scale to the next tier above the maximum (so the top gridline is always above the max).
    const yMax = Math.max(20, yMaxBase + 10);
// 100, 110, 120, 130...

    // Wireframe (grid/axes) should follow the theme accent, but the *data* lines
    // should stay on their own fixed colors.
    const gridCol = cssVar("--accent", "#ffffff"); // fallback if var missing
    // Force axis labels to be readable on all themes (mobile previously showed black)
    const textCol = "#ffffffa8";

    // Minor grid lines: aim for ~20 lines max (avoid clutter if yMax is big)
    const minorStep = yMax <= 160 ? 5 : 10;
    ctx.strokeStyle = gridCol;
    ctx.globalAlpha = 0.18;
    for (let v = 0; v <= yMax; v += minorStep) {
      const y = padT + innerH - (v / yMax) * innerH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + innerW, y);
      ctx.stroke();
    }

    // Major lines + labels every 10
    ctx.globalAlpha = 0.42;
    ctx.fillStyle = textCol;
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, Arial";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";

    for (let v = 0; v <= yMax; v += 10) {
      const y = padT + innerH - (v / yMax) * innerH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + innerW, y);
      ctx.stroke();

      ctx.globalAlpha = 0.9;
      ctx.fillText(String(v), padL - 10, y);
      ctx.globalAlpha = 0.42;
    }

    // Emphasize the 100 line if it is inside the scale
    if (yMax >= 100) {
      ctx.save();
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      const y100 = padT + innerH - (100 / yMax) * innerH;
      ctx.moveTo(padL, y100);
      ctx.lineTo(padL + innerW, y100);
      ctx.stroke();
      ctx.restore();
    }

    // y-axis line
    ctx.globalAlpha = 0.65;
    ctx.beginPath();
    ctx.moveTo(padL, padT);
    ctx.lineTo(padL, padT + innerH);
    ctx.stroke();

    ctx.globalAlpha = 1;

    const n = labels.length;
    const xAt = (i) => padL + (innerW * (n === 1 ? 0 : i / (n - 1)));

    const yAt = (v) => {
      const vv = Number(v || 0);
      const clamped = Math.max(0, Math.min(yMax, vv));
      return padT + innerH - (clamped / yMax) * innerH;
    };

    // draw each line (no per-series normalization; values are plotted on the shared y-axis)
    series.forEach((vals, sIdx) => {
      const col = colors[sIdx] || cssVar("--accent", "white");
      const arr = (vals || []).map(v => Number(v || 0));

      // glow
      ctx.save();
      ctx.shadowColor = col;
      ctx.shadowBlur = 10;
      ctx.lineWidth = 2.2;
      ctx.strokeStyle = col;

      ctx.beginPath();
      ctx.moveTo(xAt(0), yAt(arr[0]));
      for (let i = 1; i < arr.length; i++) ctx.lineTo(xAt(i), yAt(arr[i]));
      ctx.stroke();
      ctx.restore();

      // dots
      ctx.fillStyle = col;
      for (let i = 0; i < arr.length; i++) {
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(arr[i]), 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // x labels
    if (shXAxisLabels) {
      shXAxisLabels.innerHTML = "";
      labels.forEach((lab) => {
        const span = document.createElement("span");
        span.textContent = lab;
        shXAxisLabels.appendChild(span);
      });
    }
  }
  function renderLegend(items) {
    if (!shLegend) return;
    shLegend.innerHTML = "";
    items.forEach(it => {
      const div = document.createElement("div");
      div.className = "shLegendItem";
      const sw = document.createElement("span");
      sw.className = "shLegendSwatch";
      sw.style.background = it.color;
      div.appendChild(sw);
      const tx = document.createElement("span");
      tx.textContent = it.label;
      div.appendChild(tx);
      shLegend.appendChild(div);
    });
  }

  function renderStatsHistory(range) {
    const rows = getSeries(range);
    const labels = rows.map(r => r.label);

    const sMatches = rows.map(r => r.matches);
    const sTda = rows.map(r => r.tda);
    const sF9d = rows.map(r => r.f9d);
    const sCo = rows.map(r => r.checkout);

    // Data series colors are fixed (not theme-driven). Only the graph wireframe
    // (grid/axes) uses --accent.
    const colors = [
      "#FFFFFF", // Matches
      "#FF6BD6", // 3DA
      "#F6C745", // First 9
      "#6CFF7A", // Checkout %
    ];

    renderLegend([
      { label: "Matches", color: colors[0] },
      { label: "3DA", color: colors[1] },
      { label: "First 9", color: colors[2] },
      { label: "Checkout %", color: colors[3] },
    ]);

    drawMulti(shMasterCanvas, [sMatches, sTda, sF9d, sCo], labels, colors);
  }

  let currentRange = "week";


  // Join modal
  const joinModal = qs("dashJoinModal");
  const joinLink = qs("dashJoinLink");
  const joinConfirm = qs("dashJoinConfirmBtn");
  const joinClose = qs("dashJoinCloseBtn");
  const joinError = qs("dashJoinError");
  let joinErrTimer = null;

  function showJoinError(msg) {
    if (!joinError) return; // fallback optional: alert(msg)
    joinError.textContent = String(msg || "");
    joinError.classList.remove("hidden");
    clearTimeout(joinErrTimer);
    joinErrTimer = setTimeout(() => joinError.classList.add("hidden"), 2500);
  }

  function clearJoinError() {
    if (!joinError) return;
    joinError.classList.add("hidden");
    joinError.textContent = "";
  }




// Match history modal
const mhModal = qs("matchHistoryModal");
const mhRows = qs("mhRows");
const mhCloseBtn = qs("mhCloseBtn");

// Friends modal
const friendsModal = qs("friendsModal");
const friendsCloseBtn = qs("friendsCloseBtn");
const friendsIncomingEmpty = qs("friendsIncomingEmpty");
const friendsIncomingList = qs("friendsIncomingList");
const friendsOutgoingEmpty = qs("friendsOutgoingEmpty");
const friendsOutgoingList = qs("friendsOutgoingList");
const friendsListEmpty = qs("friendsListEmpty");
const friendsList = qs("friendsList");
const friendSearchUid = qs("friendSearchUid");
const friendSearchAddBtn = qs("friendSearchAddBtn");
const friendSearchMsg = qs("friendSearchMsg");

// Friend feedback modal
const friendFeedbackModal = qs("friendFeedbackModal");
const friendFeedbackMsg = qs("friendFeedbackMsg");
const friendFeedbackOkBtn = qs("friendFeedbackOkBtn");

let friendFeedbackTimer = null;
let friendFeedbackOpenedAt = 0;
function showFriendFeedback(message) {
  if (!friendFeedbackModal || !friendFeedbackMsg) return;
  friendFeedbackMsg.textContent = String(message || "");

  // Defer opening to avoid the same click event immediately closing the backdrop.
  setTimeout(() => openModalEl(friendFeedbackModal), 0);

  // Keep open until user clicks OK (no auto-close)
  clearTimeout(friendFeedbackTimer);
  friendFeedbackTimer = null;

  if (friendFeedbackOkBtn) {
    friendFeedbackOkBtn.onclick = () => closeModalEl(friendFeedbackModal);
  }
}



// Opponent profile friend actions
const oppFriendActions = qs("oppFriendActions");
const oppAddFriendBtn = qs("oppAddFriendBtn");
const oppRemoveFriendBtn = qs("oppRemoveFriendBtn");
const oppFriendPendingRow = qs("oppFriendPendingRow");
const oppAcceptFriendBtn = qs("oppAcceptFriendBtn");
const oppDeclineFriendBtn = qs("oppDeclineFriendBtn");
// oppFriendStatus removed (use feedback modal instead)
const oppCancelFriendBtn = qs("oppCancelFriendBtn");

// Opponent profile modal (dashboard-style, mirrors in-game profileModal)
const oppModal = qs("oppProfileModal");
const oppCloseBtn = qs("oppProfileCloseBtn");
const oppNameEl = qs("oppProfileName");
const oppEquipEl = qs("oppProfileEquipment");
const oppPhotoEl = qs("oppProfileUserPhoto");
const oppLast5El = qs("oppProfileLast5");

const oppTdaVal = qs("oppProfileTdaVal");
const oppF9dVal = qs("oppProfileF9dVal");
const oppMatchesVal = qs("oppProfileMatchesVal");
const oppDartsVal = qs("oppProfileDartsVal");
const oppWinsVal = qs("oppProfileWinsVal");
const oppLossesVal = qs("oppProfileLossesVal");
const oppWinRateVal = qs("oppProfileWinRateVal");
const oppWinRateDonut = qs("oppProfileWinRateDonut");
const oppCheckoutPctVal = qs("oppProfileCheckoutPctVal");
const opp100Val = qs("oppProfile100Val");
const opp140Val = qs("oppProfile140Val");
const opp180Val = qs("oppProfile180Val");

function setMatchHistoryVisible(visible) {
  if (!mhModal) return;
  visible ? openModalEl(mhModal) : closeModalEl(mhModal);
}

function setFriendsVisible(visible) {
  if (!friendsModal) return;
  visible ? openModalEl(friendsModal) : closeModalEl(friendsModal);
}

async function refreshMyUserDoc() {
  if (!app.db || !app.user) return null;
  try {
    const snap = await app.db.collection("users").doc(app.user.uid).get();
    if (snap.exists) {
      app.userProfile = snap.data();
      return app.userProfile;
    }
  } catch (e) {
    console.warn("Failed to refresh my user doc", e);
  }
  return app.userProfile || null;
}

async function fetchMyFriendsData() {
  if (!app.db || !app.user) return { incoming: [], outgoing: [], friends: [] };
  const meRef = app.db.collection("users").doc(app.user.uid);
  const [inSnap, fSnap] = await Promise.all([
    meRef.collection("friendRequestsIncoming").get(),
    meRef.collection("friends").get(),
  ]);

  // Outgoing requests are optional in the UI; fetch separately to avoid any accidental extra reads.
  let outSnap = null;
  try {
    outSnap = await meRef.collection("friendRequestsOutgoing").get();
  } catch (_) {
    outSnap = { docs: [] };
  }

  const incoming = inSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  const outgoing = (outSnap?.docs || []).map((d) => ({ id: d.id, ...(d.data() || {}) }));
  const friends = fSnap.docs.map((d) => ({ id: d.id, ...(d.data() || {}) }));
  return { incoming, outgoing, friends };
}

function renderFriendsModal(data) {
  const incomingArr = Array.isArray(data?.incoming) ? data.incoming : [];
  const outgoingArr = Array.isArray(data?.outgoing) ? data.outgoing : [];
  const friendsArr = Array.isArray(data?.friends) ? data.friends : [];

  const incomingIds = incomingArr.map((r) => r.uid || r.id).filter(Boolean);
  const outgoingIds = outgoingArr.map((r) => r.uid || r.id).filter(Boolean);
  const friendIds = friendsArr.map((f) => f.uid || f.id).filter(Boolean);

  if (friendsIncomingEmpty) friendsIncomingEmpty.classList.toggle("hidden", incomingIds.length > 0);
  if (friendsOutgoingEmpty) friendsOutgoingEmpty.classList.toggle("hidden", outgoingIds.length > 0);
  if (friendsListEmpty) friendsListEmpty.classList.toggle("hidden", friendIds.length > 0);

  if (friendsIncomingList) {
    const sortedIncoming = [...incomingArr].sort((a, b) => Number(b.sentAt || 0) - Number(a.sentAt || 0));
    friendsIncomingList.innerHTML = sortedIncoming
      .map((r) => {
        const uid = r.uid || r.id;
        const name = escapeHtml(r.displayName || "Player");
        const photo = r.photoURL ? escapeHtml(r.photoURL) : "";
        return `
          <div class="friendRow" data-uid="${escapeHtml(uid)}">
            <div class="friendRowLeft">
              ${photo ? `<img class="avatar" src="${photo}" alt="" />` : `<div class="mhOppAvatarFallback">${name.slice(0,1).toUpperCase()}</div>`}
              <div class="friendRowName">${name}</div>
            </div>
            <div class="friendRowActions">
              <button class="greenbutton iconOnly"
        data-action="accept"
        type="button"
        aria-label="Accept">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
       xmlns="http://www.w3.org/2000/svg">
    <path d="M5 13l4 4L19 7"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"/>
  </svg>
</button>

              <button class="redbutton danger iconOnly"
        data-action="cancel"
        type="button"
        aria-label="Cancel">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none"
       xmlns="http://www.w3.org/2000/svg">
    <path d="M6 6l12 12M18 6l-12 12"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"/>
  </svg>
</button>
            </div>
          </div>
        `;
      })
      .join("");

    // bind actions
    friendsIncomingList.querySelectorAll(".friendRow").forEach((row) => {
      const uid = row.getAttribute("data-uid");
      row.querySelectorAll("button[data-action]").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          if (!uid || !app.user) return;
          const act = btn.getAttribute("data-action");
          try {
            if (act === "accept") await acceptFriendRequest(app.db, app.user.uid, uid);
            if (act === "decline") await declineFriendRequest(app.db, app.user.uid, uid);
            const refreshed = await fetchMyFriendsData();
            renderFriendsModal(refreshed);
            if (act === "accept") showFriendFeedback("Friend request accepted");
            if (act === "decline") showFriendFeedback("Friend request declined");
          } catch (err) {
            console.warn("Friend request action failed", err);
          }
        });
      });
    });
  }

  if (friendsOutgoingList) {
    const sortedOutgoing = [...outgoingArr].sort((a, b) => Number(b.sentAt || 0) - Number(a.sentAt || 0));
    friendsOutgoingList.innerHTML = sortedOutgoing
      .map((r) => {
        const uid = r.uid || r.id;
        const name = escapeHtml(r.displayName || "Player");
        const photo = r.photoURL ? escapeHtml(r.photoURL) : "";
        return `
          <div class="friendRow" data-uid="${escapeHtml(uid)}">
            <div class="friendRowLeft" data-action="open">
              ${photo ? `<img class="avatar" src="${photo}" alt="" />` : `<div class="mhOppAvatarFallback">${name.slice(0,1).toUpperCase()}</div>`}
              <div class="friendRowName">${name}</div>
            </div>
            <div class="friendRowActions">
              <button class="redbutton danger friends" data-action="cancel" type="button">Cancel</button>
            </div>
          </div>
        `;
      })
      .join("");

    friendsOutgoingList.querySelectorAll(".friendRow").forEach((row) => {
      const uid = row.getAttribute("data-uid");
      const left = row.querySelector(".friendRowLeft");
      if (left) {
        left.addEventListener("click", (e) => {
          e.preventDefault();
          if (uid) openOpponentProfile(uid, "Player");
        });
      }

      const btn = row.querySelector("button[data-action='cancel']");
      if (btn) {
        btn.addEventListener("click", async (e) => {
          e.preventDefault();
          if (!uid || !app.user) return;
          try {
            await cancelFriendRequest(app.db, app.user.uid, uid);
            const refreshed = await fetchMyFriendsData();
            renderFriendsModal(refreshed);
            showFriendFeedback("Friend request cancelled");
          } catch (err) {
            console.warn("Cancel friend request failed", err);
          }
        });
      }
    });
  }

  if (friendsList) {
    const sortedFriends = [...friendsArr].sort((a, b) => String(a.displayName || "").localeCompare(String(b.displayName || "")));
    friendsList.innerHTML = sortedFriends
      .map((f) => {
        const uid = f.uid || f.id;
        const name = escapeHtml(f.displayName || "Player");
        const photo = f.photoURL ? escapeHtml(f.photoURL) : "";
        return `
          <div class="friendRow" data-uid="${escapeHtml(uid)}" data-name="${name}">
            <div class="friendRowLeft" data-action="open">
              ${photo ? `<img class="avatar" src="${photo}" alt="" />` : `<div class="mhOppAvatarFallback">${name.slice(0,1).toUpperCase()}</div>`}
              <div class="friendRowName">${name}</div>
            </div>
            <div class="friendRowActions">
              <button class="bluebutton mobsmall" data-action="invite" type="button">Invite to game</button>
            </div>
          </div>
        `;
      })
      .join("");

    friendsList.querySelectorAll(".friendRow").forEach((row) => {
      const uid = row.getAttribute("data-uid");
      const left = row.querySelector(".friendRowLeft");
      if (left) {
        left.addEventListener("click", (e) => {
          e.preventDefault();
          if (uid) openOpponentProfile(uid, "Friend");
        });
      }

      const inviteBtn = row.querySelector('button[data-action="invite"]');
      if (inviteBtn) {
        inviteBtn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!uid) return;
          const name = row.getAttribute("data-name") || "Player";
          pendingInviteConfirm = { toUid: uid, toName: name };
          const confirmText = qs("inviteConfirmText");
          if (confirmText) confirmText.textContent = `You are inviting ${name} to an online game. Are you sure?`;
          openModal(qs("inviteConfirmModal"));
        });
      }
    });
  }
}

function setOppProfileVisible(visible) {
  if (!oppModal) return;
  visible ? openModalEl(oppModal) : closeModalEl(oppModal);
}

function renderOppProfile({ displayName, equipment, photoURL, stats }) {
  const s = stats || {};
  const matches = Number(s.matches || 0);
  const wins = Number(s.wins || 0);
  const losses = Number(s.losses || 0);

  const totalPoints = Number(s.totalPoints || 0);
  const totalDarts = Number(s.totalDarts || 0);
  const first9Points = Number(s.first9Points || s.totalFirst9Points || 0);
  const first9Darts = Number(s.first9Darts || s.totalFirst9Darts || 0);

  const tda = totalDarts ? Math.round((totalPoints / totalDarts) * 3) : 0;
  const f9d = first9Darts ? Math.round((first9Points / first9Darts) * 3) : 0;

  const s100 = Number(s.s100 || s.hundredPlus || s.total100s || 0);
  const s140 = Number(s.s140 || s.oneFortyPlus || s.total140s || 0);
  const s180 = Number(s.s180 || s.oneEighty || s.total180s || 0);
  const lifetimeDarts = Number(s.lifetimeDarts || 0);

  const checkoutThrown = Number(s.checkoutDoublesThrown || 0);
  const checkoutHit = Number(s.checkoutDoublesHit || 0);
  const checkoutPct = checkoutThrown ? Math.round((checkoutHit / checkoutThrown) * 100) : 0;

  if (oppNameEl) oppNameEl.textContent = displayName || "—";
  if (oppEquipEl) oppEquipEl.textContent = equipment || "";

  if (oppPhotoEl) {
    if (photoURL) {
      oppPhotoEl.src = photoURL;
      oppPhotoEl.classList.remove("hidden");
    } else {
      oppPhotoEl.removeAttribute("src");
      oppPhotoEl.classList.add("hidden");
    }
  }

  if (oppTdaVal) oppTdaVal.textContent = String(tda);
  if (oppF9dVal) oppF9dVal.textContent = String(f9d);
  if (oppMatchesVal) oppMatchesVal.textContent = String(matches);
  if (oppDartsVal) oppDartsVal.textContent = String(lifetimeDarts || totalDarts || 0);
  if (oppWinsVal) oppWinsVal.textContent = String(wins);
  if (oppLossesVal) oppLossesVal.textContent = String(losses);
  const oppRate = matches ? Math.round((wins / matches) * 100) : 0;
  if (oppWinRateVal) oppWinRateVal.textContent = `${oppRate}%`;
  if (oppWinRateDonut) {
    const p = Math.max(0, Math.min(1, oppRate / 100));
    oppWinRateDonut.style.setProperty("--p", String(p));
  }
  if (oppCheckoutPctVal) oppCheckoutPctVal.textContent = `${checkoutPct}%`;
  if (opp100Val) opp100Val.textContent = String(s100);
  if (opp140Val) opp140Val.textContent = String(s140);
  if (opp180Val) opp180Val.textContent = String(s180);

  // Last 5 pills
  if (oppLast5El) {
    const arr = Array.isArray(s.recentResults) ? s.recentResults.slice(0, 5) : [];
    oppLast5El.innerHTML = arr.length
      ? arr
          .map((r) => {
            const v = String(r).toUpperCase();
            const cls = v === "W" ? "w" : "l";
            return `<span class="dashWL ${cls}">${v}</span>`;
          })
          .join("")
      : `<span style="opacity:.7;">—</span>`;
  }
}

let currentOppUid = null;

function resetOppFriendUI() {
  if (!oppFriendActions) return;
  oppFriendActions.classList.add("hidden");
  [oppAddFriendBtn, oppRemoveFriendBtn, oppFriendPendingRow, oppCancelFriendBtn].forEach((el) => el && el.classList.add("hidden"));
  currentOppUid = null;
}

async function renderOppFriendUI(otherUid, otherData) {
  if (!oppFriendActions || !app.user || !app.db) return;
  if (!otherUid || otherUid === app.user.uid) {
    resetOppFriendUI();
    return;
  }

  currentOppUid = otherUid;
  // Use subcollection-based friend state (requests/friends are not stored on user doc).
  const state = await getFriendStateDb(app.db, app.user.uid, otherUid);

  oppFriendActions.classList.remove("hidden");
  // hide all
  [oppAddFriendBtn, oppRemoveFriendBtn, oppFriendPendingRow, oppCancelFriendBtn].forEach((el) => el && el.classList.add("hidden"));

  if (state === "friends") {
    if (oppRemoveFriendBtn) oppRemoveFriendBtn.classList.remove("hidden");
  } else if (state === "incoming") {
    if (oppFriendPendingRow) oppFriendPendingRow.classList.remove("hidden");
  } else if (state === "outgoing") {
    if (oppCancelFriendBtn) oppCancelFriendBtn.classList.remove("hidden");
  } else {
    if (oppAddFriendBtn) oppAddFriendBtn.classList.remove("hidden");
  }
}

async function openOpponentProfile(uid, fallbackName = "Opponent") {
  if (!uid || !app.db) return;
  try {
    const snap = await app.db.collection("users").doc(uid).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const name = data.displayName || data.nickname || fallbackName;
    renderOppProfile({
      displayName: name,
      equipment: (data.setEquipment || data.equipment || ""),
      photoURL: (data.photoURL || null),
      stats: data.stats || null,
    });
    await renderOppFriendUI(uid, data);
    setOppProfileVisible(true);
  } catch (e) {
    console.warn("Opponent profile load failed", e);
    renderOppProfile({ displayName: fallbackName, equipment: "", photoURL: null, stats: null });
    resetOppFriendUI();
    setOppProfileVisible(true);
  }
}

function renderMatchHistory(stats) {
  if (!mhRows) return;
  const hist = Array.isArray(stats?.matchHistory) ? stats.matchHistory : [];
  if (!hist.length) {
    mhRows.innerHTML = `<div style="opacity:.75; padding:8px 0;">No matches yet.</div>`;
    return;
  }

  mhRows.innerHTML = hist.slice(0, 10).map((row, i) => {
    const res = String(row.result || "").toUpperCase() === "W" ? "W" : "L";
    const pillCls = res === "W" ? "win" : "lose";
    const score = escapeHtml(row.scoreline || "—");
    const mode = escapeHtml(row.mode || "—");
    const type = escapeHtml(row.competition || "—");
    const oppName = escapeHtml(row.opponentName || "Opponent");
    const oppUid = row.opponentUid || "";
    const avatar = row.opponentAvatar ? escapeHtml(row.opponentAvatar) : "";
    const tda = Number(row.threeDartAvg || 0);
    const tdaTxt = Number.isFinite(tda) ? tda.toFixed(0) : "0";
    const dateTxt = formatDateDDMMYYYY(row.finishedAt);

    return `
      <div class="mhGrid mhRow" data-idx="${i}">
        <div><span class="mhPill ${pillCls}">${res}</span></div>
        <div>${score}</div>
        <div>${mode}</div>
        <div>${type}</div>
        <div class="mhOpponent" data-uid="${escapeHtml(oppUid)}" data-name="${oppName}">
          ${avatar ? `<img class="mhOppAvatar hiddenmobile" src="${avatar}" alt="" />` : `<div class="mhOppAvatarFallback hiddenmobile">${(oppName||"O").slice(0,1).toUpperCase()}</div>`}
          <span>${oppName}</span>
        </div>
        <div>${tdaTxt}</div>
        <div>${dateTxt}</div>
      </div>
    `;
  }).join("");

  // Delegate clicks for opponent profile
  mhRows.querySelectorAll(".mhOpponent").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault();
      const uid = el.getAttribute("data-uid");
      const nm = el.getAttribute("data-name") || "Opponent";
      if (uid) openOpponentProfile(uid, nm);
    });
  });
}

  // Settings modal IDs (match /dashboard)
  const settingsSave = qs("setSaveBtn");
  const settingsClose = qs("settingsCloseBtn");
  const signOutBtn = qs("settingsSignOutBtn");
  const dnInput = qs("setDisplayName");
  const eqInput = qs("setEquipment");
  const openChatDefaultChk = qs("setOpenChatByDefault");
  const uidInput = qs("setUserUid");
  const copyUidBtn = qs("copyUserUidBtn");


  function wireCard(el, fn) {
    if (!el) return;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      fn();
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fn();
      }
    });
  }

  wireCard(playLocalCard, async () => createLobbyAndGo({ lobbyType: "local" }));
  wireCard(playOnlineCard, async () => createLobbyAndGo({ lobbyType: "online" }));
  wireCard(nemesisCard, () => {
    // Slice 1: Nemesis configuration screen (logged-in users only)
    softNavigate(withBase("/nemesis"));
  });
  wireCard(nemesisCard, () => {
    // Nemesis is for signed-in users only; dashboard is already gated.
    softNavigate(withBase("/nemesis"));
  });

  // Match history open/close
if (matchHistoryBtn) {
  matchHistoryBtn.addEventListener("click", (e) => {
    e.preventDefault();
    // Render from current cached profile stats
    renderMatchHistory(app.userProfile?.stats || {});
    setMatchHistoryVisible(true);
  });
}
if (mhCloseBtn) mhCloseBtn.addEventListener("click", () => setMatchHistoryVisible(false));
if (mhModal) {
  mhModal.addEventListener("click", (e) => {
    if (e.target === mhModal) setMatchHistoryVisible(false);
  });
}
if (oppCloseBtn) oppCloseBtn.addEventListener("click", () => setOppProfileVisible(false));
if (oppModal) {
  oppModal.addEventListener("click", (e) => {
    if (e.target === oppModal) setOppProfileVisible(false);
  });
}

// Friends open/close

  if (statsHistoryBtn) {
    statsHistoryBtn.addEventListener("click", (e) => {
      e.preventDefault();
      currentRange = "week";
      setRangeActive(currentRange);
      setStatsHistoryVisible(true);
      // allow layout to settle before canvas sizing
      setTimeout(() => renderStatsHistory(currentRange), 50);
    });
  }

  if (shCloseBtn) shCloseBtn.addEventListener("click", () => setStatsHistoryVisible(false));
  if (statsHistoryModal) {
    statsHistoryModal.addEventListener("click", (e) => {
      if (e.target === statsHistoryModal) setStatsHistoryVisible(false);
    });
  }
  if (shWeekBtn) shWeekBtn.addEventListener("click", () => { currentRange="week"; setRangeActive(currentRange); renderStatsHistory(currentRange); });
  if (shMonthBtn) shMonthBtn.addEventListener("click", () => { currentRange="month"; setRangeActive(currentRange); renderStatsHistory(currentRange); });
  if (shYearBtn) shYearBtn.addEventListener("click", () => { currentRange="year"; setRangeActive(currentRange); renderStatsHistory(currentRange); });

if (friendsBtn) {
  friendsBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    const data = await fetchMyFriendsData();
    renderFriendsModal(data);
    if (friendSearchUid) friendSearchUid.value = "";
    if (friendSearchMsg) { friendSearchMsg.textContent = ""; friendSearchMsg.classList.add("hidden"); friendSearchMsg.classList.remove("error"); }
    setFriendsVisible(true);
  });
}

function setFriendSearchMessage(msg, { isError = false } = {}) {
  if (!friendSearchMsg) return;
  friendSearchMsg.textContent = msg || "";
  friendSearchMsg.classList.toggle("hidden", !msg);
  friendSearchMsg.classList.toggle("error", !!isError);
}

async function addFriendByUid() {
  const db = app.db;
  const myUid = app.user?.uid || null;
  if (!db || !myUid) return;

  const raw = (friendSearchUid?.value || "").trim();
  const uid = raw.replaceAll(/\s+/g, "");
  if (friendSearchUid) friendSearchUid.value = uid;

  if (!uid) return setFriendSearchMessage("Please enter a UID.", { isError: true });
  if (uid === myUid) return setFriendSearchMessage("You can't add yourself.", { isError: true });
  if (uid.length < 10 || uid.length > 128) return setFriendSearchMessage("That UID doesn't look valid.", { isError: true });

  // Guardrails: already friends / pending
  try {
    const state = await getFriendStateDb(db, myUid, uid);
    if (state === "friends") return setFriendSearchMessage("You're already friends with this user.");
    if (state === "outgoing") return setFriendSearchMessage("Friend request already sent.");
    if (state === "incoming") return setFriendSearchMessage("This user has already sent you a friend request.");
  } catch {}

  // Check user exists
  const targetRef = db.collection("users").doc(uid);
  const snap = await targetRef.get();
  if (!snap.exists) return setFriendSearchMessage("There was no user found with this ID.", { isError: true });

  await sendFriendRequest(db, myUid, uid);
  setFriendSearchMessage("Friend request sent.");
}

if (friendSearchAddBtn) {
  friendSearchAddBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    await addFriendByUid();
  });
}
if (friendSearchUid) {
  friendSearchUid.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      await addFriendByUid();
    }
  });
}

if (friendsCloseBtn) friendsCloseBtn.addEventListener("click", () => setFriendsVisible(false));
if (friendsModal) {
  friendsModal.addEventListener("click", (e) => {
    if (e.target === friendsModal) setFriendsVisible(false);
  });
}

// Friend feedback modal close
if (friendFeedbackOkBtn) friendFeedbackOkBtn.addEventListener("click", () => friendFeedbackModal && closeModalEl(friendFeedbackModal));
if (friendFeedbackModal) {
  friendFeedbackModal.addEventListener("click", (e) => {
    if (Date.now() - friendFeedbackOpenedAt < 200) return;
    if (e.target === friendFeedbackModal) closeModalEl(friendFeedbackModal);
  });
}

// Opponent profile friend actions
if (oppAddFriendBtn) {
  oppAddFriendBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentOppUid || !app.user) return;
    await sendFriendRequest(app.db, app.user.uid, currentOppUid);
    await renderOppFriendUI(currentOppUid);
    showFriendFeedback("Friend request sent");
  });
}
if (oppRemoveFriendBtn) {
  oppRemoveFriendBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentOppUid || !app.user) return;
    await removeFriend(app.db, app.user.uid, currentOppUid);
    await renderOppFriendUI(currentOppUid);
    showFriendFeedback("Friend has been removed");
  });
}
if (oppAcceptFriendBtn) {
  oppAcceptFriendBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentOppUid || !app.user) return;
    await acceptFriendRequest(app.db, app.user.uid, currentOppUid);
    await renderOppFriendUI(currentOppUid);
    showFriendFeedback("Friend request accepted");
  });
}

if (oppCancelFriendBtn) {
  oppCancelFriendBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentOppUid || !app.user) return;
    await cancelFriendRequest(app.db, app.user.uid, currentOppUid);
    await renderOppFriendUI(currentOppUid);
    showFriendFeedback("Friend request cancelled");
  });
}

if (oppDeclineFriendBtn) {
  oppDeclineFriendBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (!currentOppUid || !app.user) return;
    await declineFriendRequest(app.db, app.user.uid, currentOppUid);
    await renderOppFriendUI(currentOppUid);
    showFriendFeedback("Friend request declined");
  });
}


  // Join a Game
  if (joinGameBtn) {
    joinGameBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (joinLink) joinLink.value = "";
      if (joinModal) openModalEl(joinModal);
    });
  }

  if (joinClose) {
    joinClose.addEventListener("click", (e) => {
      e.preventDefault();
      if (joinModal) closeModalEl(joinModal);
    });
  }

  if (joinConfirm) {
  joinConfirm.addEventListener("click", async (e) => {
    e.preventDefault();

    clearJoinError();

    const text = (joinLink?.value || "").trim();
    if (!text) {
      showJoinError("Please paste a valid invite link.");
      joinLink?.focus();
      return;
    }

    const gid = extractGameIdFromUrl(text);
    if (!gid) {
      showJoinError("Please paste a valid invite link.");
      joinLink?.focus();
      return;
    }

    const res = await isLobbyFull(app.db, gid); // NOTE: pass db
    if (res.full) {
      showJoinError(res.message || "This lobby is full.");
      return;
    }

    window.location.href = `/game/?game=${encodeURIComponent(gid)}`;
  });

  }

  // Confirm sign out
  if (confirmSignOutCancelBtn) {
    confirmSignOutCancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setConfirmSignOutVisible(false);
    });
  }

  if (confirmSignOutOkBtn) {
    confirmSignOutOkBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      setConfirmSignOutVisible(false);
      await signOutUser();
      window.location.href = withBase("/index/");
    });
  }

  // Header sign out -> show confirmation

  if (settingsBtn) {
    settingsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const p = app.userProfile || {};
      if (dnInput) dnInput.value = p.displayName || p.nickname || "";
      if (eqInput) eqInput.value = p.equipment || "";
      if (openChatDefaultChk) {
        const ls = localStorage.getItem("openAuditChatByDefault");
        openChatDefaultChk.checked = (ls === null) ? !!p.openAuditChatByDefault : (ls === "1");
      }
      pendingTheme = getSavedTheme();
applyTheme(pendingTheme, { persist: false });
setThemePickerSelected(pendingTheme);
      if (uidInput) uidInput.value = (app.user && app.user.uid) ? app.user.uid : "";
setSettingsModalVisible(true);
    });
  
  if (copyUidBtn) {
    copyUidBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      const uid = uidInput?.value || "";
      if (!uid) return;
      try {
        await navigator.clipboard.writeText(uid);
        const prev = copyUidBtn.textContent;
        copyUidBtn.textContent = "Copied";
        setTimeout(() => { copyUidBtn.textContent = prev; }, 900);
      } catch {
        // Fallback for older browsers / permission issues
        try {
          uidInput?.select?.();
          document.execCommand("copy");
          const prev = copyUidBtn.textContent;
          copyUidBtn.textContent = "Copied";
          setTimeout(() => { copyUidBtn.textContent = prev; }, 900);
        } catch {}
      }
    });
  }

}

  if (settingsClose) {
    settingsClose.addEventListener("click", (e) => {
      e.preventDefault();
      // Revert any previewed theme when closing without saving
const saved = getSavedTheme();
pendingTheme = saved;
applyTheme(saved, { persist: false });
setThemePickerSelected(saved);
setSettingsModalVisible(false);
    });
  }

  if (settingsSave) {
    settingsSave.addEventListener("click", async (e) => {
      e.preventDefault();
      const dn = (dnInput?.value || "").trim().slice(0, 12);
      const eq = (eqInput?.value || "").trim().slice(0, 35);

      // Keep the inputs trimmed to their max lengths (so the UI reflects what we store)
      if (dnInput) dnInput.value = dn;
      if (eqInput) eqInput.value = eq;

      const openByDefault = !!openChatDefaultChk?.checked;
      await updateMyProfile({ displayName: dn, equipment: eq, openAuditChatByDefault: openByDefault });
      localStorage.setItem("openAuditChatByDefault", openByDefault ? "1" : "0");
      await ensureUserProfile();

      renderWelcome(app.userProfile);
      renderStats(app.userProfile);

      // Commit selected theme
      if (pendingTheme) applyTheme(pendingTheme, { persist: true });
      setSettingsModalVisible(false);
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setConfirmSignOutVisible(true);
    });
  }

  // Close modal when clicking backdrop
  const modal = qs("settingsModal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) setSettingsModalVisible(false);
    });
  }
}

// -------------------- init --------------------

(async () => {
  app.db = initFirebase();
  initThemePicker();
  initPageTransitions();
  wireDashboardUI();
  initInviteUiHandlers();

  await initAuth({ autoAnonymous: false });

  onUserChanged(async (user) => {
    app.user = user;

    if (!user || user.isAnonymous) {
      window.location.href = withBase("/index/");
      return;
    }

    await ensureUserProfile();
    renderWelcome(app.userProfile);
    renderStats(app.userProfile);
    showView("home");
    startInviteListener();
  });
})();

