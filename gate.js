// /gate.js
// Dedicated landing route at /index.
//
// Goal: **avoid duplicating** the full LobbyGate UI to prevent regressions.
// We keep all lobby/create/join/offline logic on /game (existing, battle-tested).
// This page simply:
//   - applies the saved/default theme
//   - initializes Firebase auth (no auto-anon)
//   - redirects:
//       * signed-in Google user -> /dashboard
//       * otherwise -> /game (which will show the real LobbyGate)

import { app } from "./app/state.js";
import { initFirebase } from "./app/firebase.js";
import { initAuth } from "./app/auth.js";
import { initPageTransitions, softNavigate } from "./app/ui/pageTransitions.js";
import { withBase } from "./app/routing.js";

function applyGateTheme() {
  // Match dashboard behavior: use saved theme, otherwise default.
  const DEFAULT_THEME = "cyan";
  document.body.setAttribute("data-theme", localStorage.getItem("theme") || DEFAULT_THEME);
}

async function main() {
  applyGateTheme();
  initPageTransitions();

  // Ensure Firebase is ready, but don't spawn anonymous accounts on /index.
  app.db = initFirebase();
  await initAuth({ autoAnonymous: false });

  // If already signed-in (Google), go straight to dashboard.
  if (app.user && !app.user.isAnonymous) {
    window.location.replace(withBase("/dashboard"));
    return;
  }

  // Otherwise, go to the game lobby (it will show the correct LobbyGate UI).
  window.location.replace(withBase("/game"));
}

main().catch((e) => {
  console.error(e);
  // Worst-case fallback: don't strand the user.
  try { window.location.replace(withBase("/game")); } catch (_) {}
});
