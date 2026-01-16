// /app/permissions.js
import { getActorId } from "./auth.js";

export function mySeatIndex(state) {
  const actor = getActorId();
  if (!actor) return null;
  if (!state?.match) return null;

  if (state.match.seat1Id === actor) return 0;
  if (state.match.seat2Id === actor) return 1;
  return null;
}

export function canEditScores(state) {
  if (!state?.match) return false;
  if (state.match.gameType !== "online") return true; // local
  return mySeatIndex(state) !== null; // seated
}

export function canUndoNow(state) {
  if (!state?.match || !state?.leg) return false;

  // local: always
  if (state.match.gameType !== "online") return true;

  // online: must be seated, leg running, not in checkout modal
  const seat = mySeatIndex(state);
  if (seat === null) return false;
  if (state.leg.status !== "in_progress") return false;
  if (state.pendingCheckout) return false;

  // You wanted: seated players can undo even when not their turn
  return true;
}

export function canScoreNow(state) {
  if (!state?.match || !state?.leg) return false;

  // local: always
  if (state.match.gameType !== "online") return true;

  // online: must be seated + in progress + not in checkout modal
  const seat = mySeatIndex(state);
  if (seat === null) return false;
  if (state.leg.status !== "in_progress") return false;
  if (state.pendingCheckout) return false;

  // block scoring while bull throw unresolved
  if (
    state.match?.starting === "bull" &&
    state.match?.bull &&
    !state.match.bull.resolved
  ) {
    return false;
  }

  // must be your turn
  return seat === state.leg.currentPlayer;
}

export function canActNow(state) {
  // “act” = score actions (submit/keypad/table)
  return canScoreNow(state);
}
