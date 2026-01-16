// main.js
import { app } from "./app/state.js";
import { initFirebase } from "./app/firebase.js";
import { getGameIdFromUrl } from "./app/routing.js";
import { bindGameListener } from "./app/realtime.js";
import { wireUI, wireGlobalKeyboard } from "./app/ui/events.js";
import { setLobbyGateVisible } from "./app/ui/render.js";
import { initBullUI } from "./app/bull/ui.js";

console.log("Reech Darts loaded");
window.onerror = (m, s, l, c, e) => console.log("JS ERROR:", m, l, c, e);

app.db = initFirebase();

app.gameId = getGameIdFromUrl();
app.gameRef = app.gameId ? app.db.collection("games").doc(app.gameId) : null;

wireUI();
wireGlobalKeyboard();
initBullUI();

if (!app.gameId) {
  setLobbyGateVisible(true);
} else {
  setLobbyGateVisible(false);
  bindGameListener();
}
