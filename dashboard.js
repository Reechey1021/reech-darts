// /dashboard.js (ES module)
// Dashboard is for signed-in (non-anonymous) users only.

import { app } from "./app/state.js";
import { initFirebase } from "./app/firebase.js";
import { initAuth, onUserChanged, signOutUser, getActorId, getActorName } from "./app/auth.js";
import { ensureUserProfile, updateMyProfile } from "./app/userProfile.js";

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

  try {
    const url = new URL(raw, window.location.origin);
    const id = url.searchParams.get("game");
    return id && id.trim() ? id.trim() : null;
  } catch {
    const m = raw.match(/[?&]game=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
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
function openModalEl(modal) {
  if (!modal) return;
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

function setSettingsModalVisible(visible) {
  const modal = qs("settingsModal");
  if (!modal) return;
  visible ? openModalEl(modal) : closeModalEl(modal);
}

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);

  const toggle = qs("themeToggle");
  if (toggle) toggle.checked = theme === "light"; // checked = light
}

function initDashboardThemeToggle() {
  const saved = localStorage.getItem("theme");
  const preferred =
    saved ||
    (window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");

  applyTheme(preferred);

  const toggle = qs("themeToggle");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    // checked = light theme
    applyTheme(toggle.checked ? "light" : "dark");
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


  // Go to index.html with game id
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace(/\/dashboard\.html$/i, "/index.html");
  url.search = "";
  url.hash = "";
  url.searchParams.set("game", newId);
  if (lobbyType === "online") {
    url.searchParams.set("openInvite", "1");
    url.searchParams.set("autoSetup", "1");
  } else {
    url.searchParams.set("setup", "1");
  }
  window.location.href = url.toString();
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
  const s100El = qs("dash100Val");
  const s140El = qs("dash140Val");
  const s180El = qs("dash180Val");

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

  if (tdaEl) tdaEl.textContent = tda;
  if (f9dEl) f9dEl.textContent = f9d;
  if (matchesEl) matchesEl.textContent = matches;
  if (dartsEl) dartsEl.textContent = lifetimeDarts || totalDarts || 0;
  if (winsEl) winsEl.textContent = wins;
  if (lossesEl) lossesEl.textContent = losses;
  if (winRateEl) {
    const rate = matches ? Math.round((wins / matches) * 100) : 0;
    winRateEl.textContent = `${rate}%`;
  }
  if (s100El) s100El.textContent = s100;
  if (s140El) s140El.textContent = s140;
  if (s180El) s180El.textContent = s180;

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
  const joinGameBtn = qs("dashJoinGameBtn");
  const settingsBtn = qs("dashSettingsBtn");
  const signOutHeaderBtn = qs("dashSignOutBtn");

  // Confirm sign out modal
  const confirmSignOutModal = qs("confirmSignOutModal");
  const confirmSignOutCancelBtn = qs("confirmSignOutCancelBtn");
  const confirmSignOutOkBtn = qs("confirmSignOutOkBtn");

  const setConfirmSignOutVisible = (visible) => {
    if (!confirmSignOutModal) return;
    visible ? openModalEl(confirmSignOutModal) : closeModalEl(confirmSignOutModal);
  };

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


  // Settings modal IDs (match dashboard.html)
  const settingsSave = qs("setSaveBtn");
  const settingsClose = qs("settingsCloseBtn");
  const signOutBtn = qs("setSignOutBtn");
  const dnInput = qs("setDisplayName");
  const eqInput = qs("setEquipment");

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

    window.location.href = `index.html?game=${encodeURIComponent(gid)}`;
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
      window.location.href = "./index.html";
    });
  }

  // Header sign out -> show confirmation
  if (signOutHeaderBtn) {
    signOutHeaderBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setConfirmSignOutVisible(true);
    });
  }

  if (settingsBtn) {
    settingsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const p = app.userProfile || {};
      if (dnInput) dnInput.value = p.displayName || p.nickname || "";
      if (eqInput) eqInput.value = p.equipment || "";
      setSettingsModalVisible(true);
    });
  }

  if (settingsClose) {
    settingsClose.addEventListener("click", (e) => {
      e.preventDefault();
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

      await updateMyProfile({ displayName: dn, equipment: eq });
      await ensureUserProfile();

      renderWelcome(app.userProfile);
      renderStats(app.userProfile);

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
  initDashboardThemeToggle();
  wireDashboardUI();

  await initAuth({ autoAnonymous: false });

  onUserChanged(async (user) => {
    app.user = user;

    if (!user || user.isAnonymous) {
      window.location.href = "./index.html";
      return;
    }

    await ensureUserProfile();
    renderWelcome(app.userProfile);
    renderStats(app.userProfile);
    showView("home");
  });
})();


