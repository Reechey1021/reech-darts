// /main.js
import { app } from "./app/state.js";
import { initFirebase } from "./app/firebase.js";
import { getGameIdFromUrl } from "./app/routing.js";
import { bindGameListener } from "./app/realtime.js";
import { wireUI, wireGlobalKeyboard } from "./app/ui/events.js";
import { initAuth } from "./app/auth.js";
import { setLobbyGateVisible } from "./app/ui/render.js";

console.log("Reech Darts loaded");
window.onerror = (m, s, l, c, e) => console.log("JS ERROR:", m, l, c, e);

app.db = initFirebase();

// Routing params first
app.gameId = getGameIdFromUrl();
app.gameRef = app.gameId ? app.db.collection("games").doc(app.gameId) : null;

// Auth:
// - If we are entering a lobby/game URL, we need a uid for rules + seat logic (anonymous is fine).
// - If we're on the landing page (no ?game=), do NOT auto-create anon accounts.
initAuth({ autoAnonymous: Boolean(app.gameId) }).then(() => {
  wireUI();
  wireGlobalKeyboard();

  if (!app.gameId) {
    setLobbyGateVisible(true);
    return;
  }

  setLobbyGateVisible(false);
  bindGameListener();
});

