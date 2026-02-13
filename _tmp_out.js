// app/state.js
var app = {
  // build
  buildVersion: "V4 Step F (match stats tabs)",
  buildCodename: "v4-stepF",
  buildDate: "2026-01-20",
  db: null,
  gameId: null,
  gameRef: null,
  latestState: null,
  // realtime
  unsubscribeGame: null,
  seatClaimed: false,
  autoSetupAfterInviteClose: false,
  // game flow
  // "local" | "online" (set by lobby/dashboard actions)
  pendingLobbyType: null,
  //auth
  auth: null,
  user: null,
  authReady: null,
  userProfile: null,
  // populated for Google users (users/{uid})
  // input
  inputMode: localStorage.getItem("inputMode") || "keypad",
  // "keypad" | "table" | "voice"
  dartMult: localStorage.getItem("dartMult") || "S",
  // "S" | "D" | "T"
  dartThrows: [],
  // per-dart scores (max 3)
  // audio sync
  lastAudioId: null
};

// app/routing.js
var KNOWN_PAGES = /* @__PURE__ */ new Set(["index", "dashboard", "nemesis", "game", "arcade"]);
function getBasePrefix() {
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && KNOWN_PAGES.has(parts[1]) && !KNOWN_PAGES.has(parts[0])) {
    return "/" + parts[0];
  }
  return "";
}
function withBase(path) {
  const p = String(path || "");
  if (!p.startsWith("/")) return p;
  const base = getBasePrefix();
  return base ? base + p : p;
}
try {
  window.withBase = withBase;
} catch (_) {
}

// arcade/play/arcadeMain.js
function qs(id) {
  if (!id) return null;
  let el = document.querySelector(`[data-role="${id}"]`);
  if (el) return el;
  el = document.getElementById(id);
  if (el) return el;
  if (id.startsWith("arcade")) {
    const legacy = "bc" + id.slice("arcade".length);
    el = document.getElementById(legacy) || document.querySelector(`[data-role="${legacy}"]`);
    if (el) return el;
  }
  if (id.startsWith("bc")) {
    const role = "arcade" + id.slice(2);
    el = document.querySelector(`[data-role="${role}"]`) || document.getElementById(role);
    if (el) return el;
  }
  return null;
}
function showError2(msg) {
  const el = qs("arcadeError");
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}
main().catch((err) => {
  console.error(err);
  showError2(err?.message || String(err));
});
