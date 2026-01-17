// /dashboard.js (ES module)
// Dashboard is for signed-in (non-anonymous) users only.

import { app } from "./app/state.js";
import { initFirebase } from "./app/firebase.js";
import { initAuth, onUserChanged, signOutUser, getActorId } from "./app/auth.js";
import { ensureUserProfile, updateMyProfile } from "./app/userProfile.js";

function qs(id) {
  return document.getElementById(id);
}

function showView(which) {
  const home = qs("dashHome");
  const stats = qs("dashStats");
  if (home) home.classList.toggle("hidden", which !== "home");
  if (stats) stats.classList.toggle("hidden", which !== "stats");
}

function setSettingsModalVisible(visible) {
  const modal = qs("settingsModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

function applyThemeWithDashboardButton(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);

  const btn = qs("themeToggleBtn");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}

function initDashboardThemeToggle() {
  const saved = localStorage.getItem("theme");
  const preferred =
    saved ||
    (window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");

  applyThemeWithDashboardButton(preferred);

  const btn = qs("themeToggleBtn");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const current = document.body.getAttribute("data-theme") || "light";
    applyThemeWithDashboardButton(current === "dark" ? "light" : "dark");
  });
}

async function createLobbyAndGo() {
  const db = app.db;
  if (!db) return;

  const uid = getActorId();
  if (!uid) return;

  const newRef = db.collection("games").doc();
  const newId = newRef.id;

  const now = new Date();
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);

  await newRef.set({
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: "lobby",
    createdBy: uid,
  });

  // Go to index.html with game id
  const url = new URL(window.location.href);
  url.pathname = url.pathname.replace(/\/dashboard\.html$/i, "/index.html");
  url.search = "";
  url.hash = "";
  url.searchParams.set("game", newId);
  window.location.href = url.toString();
}

function renderWelcome(profile) {
  const h = qs("dashWelcome");
  if (!h) return;

  const name = (profile?.displayName || profile?.nickname || "Player").trim();
  h.textContent = `Welcome, ${name}`;
}

function renderStats(profile) {
  const grid = qs("dashStatsGrid");  // ✅ exists
  const recent = qs("dashRecent");   // ✅ exists

  const s = profile?.stats || {};

  const matches = Number(s.matches || 0);
  const wins = Number(s.wins || 0);
  const losses = Number(s.losses || 0);

  const totalPoints = Number(s.totalPoints || 0);
  const totalDarts = Number(s.totalDarts || 0);
  const first9Points = Number(s.first9Points || 0);
  const first9Darts = Number(s.first9Darts || 0);

  const tda = totalDarts ? Math.round((totalPoints / totalDarts) * 3) : 0;
  const f9d = first9Darts ? Math.round((first9Points / first9Darts) * 3) : 0;

  const hs = Number(s.hs || 0);
  const s100 = Number(s.s100 || 0);
  const s140 = Number(s.s140 || 0);
  const s180 = Number(s.s180 || 0);
  const lifetimeDarts = Number(s.lifetimeDarts || 0);

  if (grid) {
    grid.innerHTML = `
      <div class="dashStat"><div class="label">Matches</div><div class="val">${matches}</div></div>
      <div class="dashStat"><div class="label">Wins</div><div class="val">${wins}</div></div>
      <div class="dashStat"><div class="label">Losses</div><div class="val">${losses}</div></div>
      <div class="dashStat"><div class="label">3DA</div><div class="val">${tda}</div></div>
      <div class="dashStat"><div class="label">F9D</div><div class="val">${f9d}</div></div>
      <div class="dashStat"><div class="label">High Score</div><div class="val">${hs}</div></div>
      <div class="dashStat"><div class="label">100+</div><div class="val">${s100}</div></div>
      <div class="dashStat"><div class="label">140+</div><div class="val">${s140}</div></div>
      <div class="dashStat"><div class="label">180s</div><div class="val">${s180}</div></div>
      <div class="dashStat"><div class="label">Lifetime darts</div><div class="val">${lifetimeDarts}</div></div>
    `;
  }

  if (recent) {
    const arr = Array.isArray(s.recentResults) ? s.recentResults.slice(0, 5) : [];
    recent.innerHTML = arr.length
      ? arr.map(r => `<span class="pill">${String(r)}</span>`).join("")
      : `<span style="opacity:.7;">No competitive results yet.</span>`;
  }
}

function wireDashboardUI() {
  const playBtn = qs("dashPlayBtn");
  const statsBtn = qs("dashStatsBtn");
  const settingsBtn = qs("dashSettingsBtn");
  const backBtn = qs("dashStatsBackBtn");

  // Settings modal IDs (match dashboard.html)
  const settingsSave = qs("setSaveBtn");
  const settingsClose = qs("settingsCloseBtn");
  const signOutBtn = qs("setSignOutBtn");
  const dnInput = qs("setDisplayName");
  const eqInput = qs("setEquipment");

  if (playBtn) {
    playBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await createLobbyAndGo();
    });
  }

  if (statsBtn) {
    statsBtn.addEventListener("click", (e) => {
      e.preventDefault();
      renderStats(app.userProfile);
      showView("stats");
    });
  }

  if (backBtn) {
    backBtn.addEventListener("click", (e) => {
      e.preventDefault();
      showView("home");
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
      const dn = (dnInput?.value || "").trim();
      const eq = (eqInput?.value || "").trim();

      await updateMyProfile({ displayName: dn, equipment: eq });
      await ensureUserProfile();

      renderWelcome(app.userProfile);
      renderStats(app.userProfile);

      setSettingsModalVisible(false);
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await signOutUser();
      window.location.href = "./index.html";
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

app.db = initFirebase();
initAuth({ autoAnonymous: false });
initDashboardThemeToggle();
wireDashboardUI();

onUserChanged(async (user) => {
  app.user = user;

  // Dashboard only for signed-in non-anonymous users
  if (!user || user.isAnonymous) {
    window.location.href = "./index.html";
    return;
  }

  await ensureUserProfile();
  renderWelcome(app.userProfile);
  renderStats(app.userProfile);
  showView("home");
});
