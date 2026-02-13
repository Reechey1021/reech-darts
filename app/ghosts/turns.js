// app/ghosts/turns.js
import { app } from "../state.js";
import { submitGhostScore } from "../actions.js";

function randBetween(a, b) {
  return a + Math.random() * (b - a);
}

function computeDelayMs() {
  // Match Nemesis-like cadence: feels like 3 darts were thrown.
  // Keep slightly snappier than Nemesis but still natural.
  const base = randBetween(1500, 2600);
  const extra = randBetween(0, 450);
  return Math.floor(base + extra);
}


// Similar to Nemesis scheduling, but deterministic: uses stored visit totals.
// We only auto-play when it is Ghost's turn (seat 2) and the leg is in progress.

let lastKey = null;
let timer = null;

function currentGhostKey(state) {
  const hLen = Array.isArray(state?.leg?.history) ? state.leg.history.length : 0;
  const p = state?.leg?.currentPlayer ?? -1;
  const idx = Number(state?.match?.ghost?.index || 0);
  const enabled = state?.match?.ghost?.enabled === true;
  const status = state?.leg?.status || "";
  return `${enabled ? "1" : "0"}|${status}|${p}|${idx}|${hLen}`;
}

export function resetGhostTurnScheduler() {
  lastKey = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function maybeHandleGhostTurn(prev, state) {
  if (!state?.match?.ghost?.enabled) return;
  if (!state?.match || !state?.leg) return;
  if (state.leg.status !== "in_progress") return;
  if (state.pendingCheckout) return;

  // Ghost is always seat 2 in Ghost Mode
  if (state.leg.currentPlayer !== 1) return;

  const key = currentGhostKey(state);
  if (key === lastKey) return;
  lastKey = key;

  // Small delay so UI feels natural.
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    try { submitGhostScore(); } catch (e) { console.warn("submitGhostScore failed", e); }
  }, computeDelayMs());
}