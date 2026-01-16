// app/bull/core.js
import { setAudioEvent } from "../audio/audio.js";

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function initBullState() {
  return {
    enabled: true,
    resolved: false,
    p1: null,
    p2: null,
    winner: null,
    d1: null,
    d2: null,
  };
}

export function tryResolveBull(state) {
  const bull = state?.match?.bull;
  if (!bull || bull.resolved) return;
  if (!bull.p1 || !bull.p2) return;

  const d1 = dist2(bull.p1.x, bull.p1.y, 0.5, 0.5);
  const d2 = dist2(bull.p2.x, bull.p2.y, 0.5, 0.5);

  bull.d1 = d1;
  bull.d2 = d2;

  let winner = 0;
  if (d2 < d1) winner = 1;
  if (Math.abs(d1 - d2) < 1e-9) winner = Math.random() < 0.5 ? 0 : 1;

  bull.winner = winner;
  bull.resolved = true;

  state.match.starterLeg1 = winner;
  if (state.leg) state.leg.currentPlayer = winner;

  // "Game on" / match start is now after bull is resolved
  setAudioEvent(state, ["./audio/phrases/match_start.mp3"]);
}
