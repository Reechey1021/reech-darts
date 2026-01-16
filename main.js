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

// ✅ Auth first (so we have a uid for seat logic + rules)
initAuth().then(() => {
  app.gameId = getGameIdFromUrl();
  app.gameRef = app.gameId ? app.db.collection("games").doc(app.gameId) : null;

  wireUI();
  wireGlobalKeyboard();

  // If no gameId -> show lobby gate modal
  const modal = document.getElementById("lobbyGateModal");
  if (!app.gameId) {
    if (modal) modal.classList.remove("hidden");
    return;
  }

  if (modal) modal.classList.add("hidden");
    if (!app.gameId) {
    setLobbyGateVisible(true);
  } else {
    setLobbyGateVisible(false);
    bindGameListener();
  }
});

