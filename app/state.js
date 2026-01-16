// app/state.js
// Single shared runtime state so modules stay simple and avoid circular imports.

export const app = {
  db: null,
  gameId: null,
  gameRef: null,

  latestState: null,

  // realtime
  unsubscribeGame: null,
  seatClaimed: false,

  // input
  inputMode: localStorage.getItem("inputMode") || "keypad", // "keypad" | "table"
  dartMult: localStorage.getItem("dartMult") || "S", // "S" | "D" | "T"
  dartThrows: [], // per-dart scores (max 3)

  // audio sync
  lastAudioId: null,
};
