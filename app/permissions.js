// app/permissions.js
import { getDeviceId } from "./device.js";

export function mySeatIndex(state) {
  const d = getDeviceId();
  if (!state?.match) return null;
  if (state.match.seat1Id === d) return 0;
  if (state.match.seat2Id === d) return 1;
  return null;
}

export function canEditScores(state) {
  if (!state?.match) return false;
  if (state.match.gameType !== "online") return true;
  return mySeatIndex(state) !== null;
}

export function canUndoNow(state) {
  if (!state?.match || !state?.leg) return false;
  if (state.match.gameType !== "online") return true;
  const seat = mySeatIndex(state);
  if (seat === null) return false;
  if (state.leg.status !== "in_progress") return false;
  if (state.pendingCheckout) return false;
  return true;
}

export function canScoreNow(state) {
  if (!state?.match || !state?.leg) return false;
  if (state.match.gameType !== "online") return true;
  const seat = mySeatIndex(state);
  if (seat === null) return false;
  if (state.leg.status !== "in_progress") return false;
  if (state.pendingCheckout) return false;

  // Bull throw blocks scoring until resolved
  if (state.match?.starting === "bull" && state.match?.bull && !state.match.bull.resolved) {
    return false;
  }

  return seat === state.leg.currentPlayer;
}
