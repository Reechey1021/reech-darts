// app/state.js
// Single shared runtime state so modules stay simple and avoid circular imports.

export const app = {
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
  userProfile: null, // populated for Google users (users/{uid})

  // input
  inputMode: localStorage.getItem("inputMode") || "keypad", // "keypad" | "table"
  dartMult: localStorage.getItem("dartMult") || "S", // "S" | "D" | "T"
  dartThrows: [], // per-dart scores (max 3)

  // audio sync
  lastAudioId: null,
};

export function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = (crypto?.randomUUID?.() || (Date.now() + "-" + Math.random())).toString();
    localStorage.setItem("deviceId", id);
  }
  return id;
}
