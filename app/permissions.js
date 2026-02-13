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


  // Ghost Mode: enforce strict turn-taking (no mutual control).
  if (state?.match?.ghost?.enabled === true) {
    if (state.leg.status !== "in_progress") return false;
    if (state.pendingCheckout) return false;
    return state.leg.currentPlayer === 0;
  }

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

  // Nemesis (offline) mode: enforce strict turn-taking (no mutual control).
  // Player can only submit on their own turn.
  if (state?.nemesis?.enabled === true) {
    if (state.leg.status !== "in_progress") return false;
    if (state.pendingCheckout) return false;
    return state.leg.currentPlayer === 0;
  }


  // Ghost Mode: enforce strict turn-taking (no mutual control).
  if (state?.match?.ghost?.enabled === true) {
    if (state.leg.status !== "in_progress") return false;
    if (state.pendingCheckout) return false;
    return state.leg.currentPlayer === 0;
  }

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

  // Allow mutual control: either device can submit scores for whoever is throwing.
  if (state.match.allowMutualControl) return true;

  // otherwise: must be your turn
  return seat === state.leg.currentPlayer;
}

export function canActNow(state) {
  // “act” = score actions (submit/keypad/table)
  return canScoreNow(state);
}

export function isHost(state) {
  const me = getActorId();
  if (!me || !state) return false;

  // Lobby phase: host is seat1 (or createdBy / lobby.host as fallback)
  if (state.status === "lobby") {
    return (
      me === state.seat1Id ||
      me === state.createdBy ||
      me === state?.lobby?.host?.actorId
    );
  }

  // Active match: host is seat1 / hostId
  if (state.match) {
    return me === state.match.hostId || me === state.match.seat1Id;
  }

  return false;
}
