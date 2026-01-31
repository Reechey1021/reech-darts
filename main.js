// /main.js
import { app } from "./app/state.js";
import { applyBuildTag, logBuildInfo } from "./app/ui/buildInfo.js";
import { initFirebase } from "./app/firebase.js";
import { getGameIdFromUrl, setGameIdInUrl, withBase } from "./app/routing.js";
import { bindGameListener } from "./app/realtime.js";
import { wireUI, wireGlobalKeyboard } from "./app/ui/events.js";
import { initAuth } from "./app/auth.js";
import { setLobbyGateVisible } from "./app/ui/render.js";
import { openInviteModalForCurrentGame } from "./app/actions.js";
import { initPageTransitions } from "./app/ui/pageTransitions.js";
import { getGuestDisplayName, setGuestDisplayName } from "./app/profile.js";

logBuildInfo();
console.log("Reech Darts loaded");
applyBuildTag();
initPageTransitions();
window.onerror = (m, s, l, c, e) => console.log("JS ERROR:", m, l, c, e);

app.db = initFirebase();

// Routing params first
app.gameId = getGameIdFromUrl();
// Nemesis flow fallback: if we were just redirected into /game but the URL lost
// its game id (some static servers / redirects can drop query/path), recover
// from a one-shot localStorage handoff.
if (!app.gameId) {
  try {
    const pending = (localStorage.getItem("nemesisPendingGameId") || "").trim();
    if (pending) {
      localStorage.removeItem("nemesisPendingGameId");
      app.gameId = pending;
    }
  } catch (_) {
    // ignore
  }
}
app.gameRef = app.gameId ? app.db.collection("games").doc(app.gameId) : null;
const qs = new URLSearchParams(window.location.search);
const shouldOpenInvite = qs.get("openInvite") === "1";
const shouldAutoSetup = qs.get("autoSetup") === "1";

// Auth:
// - If we are entering a lobby/game URL, we need a uid for rules + seat logic (anonymous is fine).
// - If we're on the landing page (no ?game=), do NOT auto-create anon accounts.
initAuth({ autoAnonymous: Boolean(app.gameId) }).then(() => {
  wireUI();
  wireGlobalKeyboard();

  if (!app.gameId) {
    // Nemesis-only recovery: if the host drops the game id on reload, try to resume the last
    // active Nemesis game WITHOUT a full page reload (prevents the "double refresh").
    //
    // Only do this on the /game root.
    try {
      const path = window.location.pathname || "";
      const baseGame = withBase("/game");
      const isGameRoot = path === baseGame || path === (baseGame + "/");
      if (isGameRoot) {
        const lastNemesis = (localStorage.getItem("lastNemesisGameId") || "").trim();
        if (lastNemesis) {
          // Hand off the id in case the host drops the query on navigation.
          try { localStorage.setItem("nemesisPendingGameId", String(lastNemesis)); } catch (_) {}

          // Set app state + URL in-place (no reload).
          app.gameId = lastNemesis;
          app.gameRef = app.db.collection("games").doc(lastNemesis);
          setGameIdInUrl(lastNemesis);
        }
      }
    } catch (_) {}

    if (!app.gameId) {
      // On /game with no active lobby id, show the lobby gate (host/join/offline).
      setLobbyGateVisible(true);

      // If the dedicated /index gate asked us to start offline immediately, do it once.
      try {
        const flag = localStorage.getItem("startOfflineOnLoad");
        if (flag === "1") {
          localStorage.removeItem("startOfflineOnLoad");
          const playOfflineBtn = document.getElementById("playOfflineBtn");
          if (playOfflineBtn) setTimeout(() => playOfflineBtn.click(), 0);
        }
      } catch (_) {
        // ignore
      }

      return;
    }
  }

  // Direct invite links: guests must pick a display name before entering the lobby.
  // Anonymous Firebase auth gives us a uid, but we still require a user-chosen name.
  if (app.user && app.user.isAnonymous && !getGuestDisplayName()) {
    const modal = document.getElementById("directGuestNameModal");
    const input = document.getElementById("directGuestNameInput");
    const joinBtn = document.getElementById("directGuestJoinBtn");

    if (modal && input && joinBtn) {
      modal.classList.remove("hidden");

      const refresh = () => {
        const v = (input.value || "").trim();
        joinBtn.disabled = v.length === 0;
      };

      input.addEventListener("input", refresh);
      refresh();
      input.focus();

      joinBtn.addEventListener(
        "click",
        () => {
          const name = (input.value || "").trim().slice(0, 12);
          if (!name) return;
          setGuestDisplayName(name);
          modal.classList.add("hidden");
          setLobbyGateVisible(false);
          bindGameListener();
        },
        { once: true }
      );

      // Don't proceed into the game until name is chosen.
      return;
    }
  }

  setLobbyGateVisible(false);
  bindGameListener();

  if (shouldOpenInvite) {
    // Show the invite (and optionally auto-open setup) once, then remove the one-shot
    // URL flags so refreshing doesn't re-trigger the flow.
    openInviteModalForCurrentGame({ autoSetup: shouldAutoSetup });

    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("openInvite");
      url.searchParams.delete("autoSetup");
      window.history.replaceState({}, "", url.toString());
    } catch (_) {}
  }

});
