// app/actions.js
import { app } from "./state.js";
import { getActorId, getActorName } from "./auth.js";
import { setGameIdInUrl } from "./routing.js";
import { getEffectiveDisplayName } from "./profile.js";
import { bindGameListener, resetRealtimeStateForGameSwitch } from "./realtime.js";
import { makeNewMatch, makeFreshLeg, starterForLeg } from "./model/match.js";
import {
  IMPOSSIBLE_TURN_SCORES,
} from "./model/constants.js";
import {
  isImpossibleCheckout,
  isBustScore,
  minDartsForCheckout,
} from "./model/rules.js";
import { calcLegStats } from "./model/stats.js";
import { applyCompetitiveMatchToProfilesTx, applyLifetimeDartsToProfilesTx } from "./userStats.js";
import { initBullState, tryResolveBull } from "./bull/core.js";
import { setAudioEvent, buildVisitClips } from "./audio/audio.js";
import { showError, safeFocusScoreInput, setLobbyGateVisible, setInviteModalVisible, setSetupModalVisible, setConfirmNewMatchModalVisible, setWinnerModalVisible } from "./ui/render.js";
import { canScoreNow, mySeatIndex } from "./permissions.js";
import { clearDarts } from "./input/dartpad.js";

// ---------- Routing / switching ----------
export function switchToGame(newGameId) {
  app.gameId = newGameId;
  app.gameRef = app.db.collection("games").doc(newGameId);
  setGameIdInUrl(newGameId);

  // Reset per-game runtime flags
  app.lastAudioId = null;
  app.seatClaimed = false;

  console.log("Switched to gameId:", newGameId);
    resetRealtimeStateForGameSwitch();
    bindGameListener();

}

// ---------- Lobby / invite ----------
export async function createNewGameAndShowInvite() {
  // Must have a name (guest or signed-in)
  const actorName = getActorName();
  if (!actorName) {
    // showError is UI-level; don’t throw here, just return false for caller
    return { ok: false, reason: "NO_NAME" };
  }

  const newRef = app.db.collection("games").doc(); // ✅ missing before
  const newId = newRef.id;

  const now = new Date();
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 hours

  await newRef.set({
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: "lobby",

    // Lobby actors (used to auto-populate player names/ids)
    lobby: {
      host: {
        actorId: getActorId(),
        name: actorName,
        uid: app.user && !app.user.isAnonymous ? app.user.uid : null,
      },
      joiner: null,
    },
  });

  // Switch routing + bind listener
  switchToGame(newId);

  // Hide gate + show invite modal (existing UI)
  setLobbyGateVisible(false);

  const url = new URL(window.location.href);
  url.searchParams.set("game", newId);

  const txt = url.toString();
  const linkEl = document.getElementById("inviteLinkText");
  if (linkEl) linkEl.textContent = txt;

  setInviteModalVisible(true);

  return { ok: true, gameId: newId };
}

// ---------- Match flow ----------
export async function openNewGameFlow() {
  if (!app.gameRef) {
    showError("Create a lobby first.");
    return;
  }

  const snap = await app.gameRef.get();
  const state = snap.data();

  if (!state || !state.match) {
    setSetupModalVisible(true);
    return;
  }

  if (state.leg?.status === "finished") {
    setSetupModalVisible(true);
    return;
  }

  setConfirmNewMatchModalVisible(true);
}

export async function startMatchFromSetup() {
  if (!app.gameRef) {
    showError("Create a lobby first.");
    return;
  }

  const mode = Number(document.getElementById("setupMode")?.value || 501);
  const bestOf = Number(document.getElementById("setupBestOf")?.value || 3);
  const starterChoice = (document.getElementById("setupStarter")?.value || "random");
  const gameType = (document.getElementById("setupGameType")?.value || "single");
  const competition = (document.getElementById("setupCompetition")?.value || "casual");

  try {
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(app.gameRef);
      const lobby = snap.data() || {};

      const actorId = getActorId();
      const actorName = getEffectiveDisplayName(app.user);

      const hostName = lobby?.lobby?.host?.name || actorName || "Player 1";
      const joinerName = lobby?.lobby?.joiner?.name || lobby.seat2Name || "Player 2";

      const p1Name = (lobby.seat1Name || hostName).trim() || "Player 1";

      const p2Name =
        gameType === "online"
          ? (String(joinerName).trim() || "Player 2")
          : "Player 2";

      if (gameType === "online" && !lobby.seat2Id) {
        throw new Error("Waiting for Player 2 to join…");
      }

      const state = makeNewMatch({ mode, bestOf, p1Name, p2Name });

      // Mark match type for stats persistence later
      state.match.competition = competition; // "casual" | "competitive"

      // Attach player identity (uid when Google-auth, null for guests)
      const hostUid = lobby?.lobby?.host?.uid || (app.user && !app.user.isAnonymous ? app.user.uid : null);
      const joinerUid = lobby?.lobby?.joiner?.uid || null;
      state.match.players[0].uid = hostUid;
      state.match.players[1].uid = gameType === "online" ? joinerUid : null;

      // Starter selection
      state.match.starting = starterChoice; // "bull" | "random" | "p1" | "p2"

      if (starterChoice === "p1") {
        state.match.starterLeg1 = 0;
        state.leg.currentPlayer = 0;
      } else if (starterChoice === "p2") {
        state.match.starterLeg1 = 1;
        state.leg.currentPlayer = 1;
      } else if (starterChoice === "bull") {
        state.match.bull = initBullState();
        state.match.starterLeg1 = 0;
        state.leg.currentPlayer = 0;
      }

      state.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      state.status = "active";

      // Identity / seating
      state.match.hostId = actorId;
      state.match.gameType = gameType;

      // Copy lobby seats into match seats
      state.match.seat1Id = lobby.seat1Id || actorId;
      state.match.seat2Id = gameType === "online" ? (lobby.seat2Id || null) : null;

      if (starterChoice !== "bull") {
        setAudioEvent(state, ["./audio/phrases/match_start.mp3"]);
      }

      tx.set(app.gameRef, state);
    });

    setSetupModalVisible(false);

    const inputEl = document.getElementById("scoreInput");
    if (inputEl) inputEl.value = "";
  } catch (e) {
    showError(e?.message || "Could not start match.");
  }
}


export async function submitScore() {
  if (!app.gameRef) {
    showError("Create a lobby first.");
    return;
  }

  const inputEl = document.getElementById("scoreInput");
  const entered = Number(inputEl?.value);

  if (!Number.isFinite(entered) || entered < 0 || entered > 180) {
    showError("Enter a number from 0 to 180.");
    return;
  }

  if (IMPOSSIBLE_TURN_SCORES.has(entered)) {
    showError("That score is not possible");
    return;
  }

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(app.gameRef);
    const state = snap.data();

    if (!state || !state.match || !state.leg) {
      showError("Press New Game to start.");
      return;
    }

    if (state.leg.status !== "in_progress") {
      showError("Leg finished.");
      return;
    }

    if (state.pendingCheckout) {
      showError("Confirm or cancel the checkout first.");
      return;
    }

    // Online enforcement
    if (state.match.gameType === "online") {
      const seat = mySeatIndex(state);
      if (seat !== state.leg.currentPlayer) {
        showError("Not your turn / not your player.");
        return;
      }
    }

    // Bull-throw lock
    if (state.match?.starting === "bull" && state.match?.bull && !state.match.bull.resolved) {
      showError("Finish the bull throw first.");
      return;
    }

    const p = state.leg.currentPlayer;
    const oldScore = state.leg.players[p].score;
    const newScore = oldScore - entered;

    if (isImpossibleCheckout(oldScore, entered)) {
      showError("This checkout is not possible");
      return;
    }

    // Checkout confirmation path
    if (newScore === 0) {
      state.pendingCheckout = {
        player: p,
        entered,
        before: oldScore,
        minDarts: minDartsForCheckout(oldScore),
        at: new Date(),
      };
      state.updatedAt = new Date();
      tx.set(app.gameRef, state);
      return;
    }

    const bust = isBustScore(newScore);

    state.leg.history.push({
      player: p,
      entered,
      bust,
      before: oldScore,
      after: bust ? oldScore : newScore,
      dartsUsed: 3,
      at: new Date(),
    });

    if (!bust) {
      state.leg.players[p].score = newScore;
    }

    // Advance turn
    state.leg.currentPlayer = (state.leg.currentPlayer + 1) % 2;

    // Audio: score + (optional) require
    const scoreCallType = bust || entered === 0 ? "no_score" : "number";

    const nextP = state.leg.currentPlayer;
    const nextName = state.match.players[nextP].name;
    const nextRemaining = state.leg.players[nextP].score;

    const clips = buildVisitClips({
      scoreCallType,
      entered,
      nextPlayerName: nextName,
      nextRemaining,
    });

    setAudioEvent(state, clips);

    state.updatedAt = new Date();
    tx.set(app.gameRef, state);
  });

  // UI-only cleanup after transaction
  if (app.inputMode === "table") {
    clearDarts();
  }

  if (inputEl) inputEl.value = "";
  safeFocusScoreInput();
}

export async function confirmCheckout(dartsUsed) {
  if (!app.gameRef) return;

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(app.gameRef);
    const state = snap.data();
    if (!state?.match || !state?.leg || !state.pendingCheckout) return;

    const match = state.match;
    const leg = state.leg;
    const pc = state.pendingCheckout;

    const p = pc.player;
    const oldScore = leg.players[p].score;
    const entered = pc.entered;
    const newScore = oldScore - entered;

    if (newScore !== 0) {
      state.pendingCheckout = null;
      tx.set(app.gameRef, state);
      return;
    }

    leg.history.push({
      player: p,
      entered,
      bust: false,
      before: oldScore,
      after: 0,
      dartsUsed,
      at: new Date(),
      checkout: true,
    });

    leg.players[p].score = 0;
    leg.status = "finished";
    leg.winner = p;

    const s0 = calcLegStats(leg, 0);
    const s1 = calcLegStats(leg, 1);

    match.legs.push({
      winner: p,
      players: [s0, s1],
      finishedAt: new Date(),
    });

    match.legsWon[p] += 1;

    const needed = Math.ceil(match.bestOf / 2);
    if (match.legsWon[p] >= needed) {
      match.status = "finished";
      match.winner = p;
    }

    // Persist profile stats once per completed match.
    // - lifetime darts counts ALL modes
    // - other aggregates count only in competitive
    if (match.status === "finished") {
      await applyLifetimeDartsToProfilesTx(tx, app.db, match);
      if (match.competition === "competitive") {
        await applyCompetitiveMatchToProfilesTx(tx, app.db, match);
      }
    }

    if (match.status === "finished") {
      setAudioEvent(state, ["./audio/phrases/match_end.mp3"]);
    } else {
      setAudioEvent(state, ["./audio/phrases/game_end.mp3"]);
    }

    state.pendingCheckout = null;
    state.updatedAt = new Date();
    tx.set(app.gameRef, state);
  });

  // reset checkout modal selection
  window.__selectedCheckoutDarts = null;
  const btn = document.getElementById("checkoutConfirmBtn");
  if (btn) btn.disabled = true;

  safeFocusScoreInput();
}

export async function cancelCheckout() {
  if (!app.gameRef) return;

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(app.gameRef);
    const state = snap.data();
    if (!state) return;
    state.pendingCheckout = null;
    state.updatedAt = new Date();
    tx.set(app.gameRef, state);
  });

  window.__selectedCheckoutDarts = null;
  const btn = document.getElementById("checkoutConfirmBtn");
  if (btn) btn.disabled = true;

  safeFocusScoreInput();
}

export async function continueOrNewMatch() {
  if (!app.gameRef) return;

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(app.gameRef);
    const state = snap.data();
    if (!state?.match || !state?.leg) return;

    const match = state.match;

    if (match.status === "finished") return;

    const starter = starterForLeg(match);
    state.leg = makeFreshLeg(match.mode, starter);
    state.pendingCheckout = null;
    state.updatedAt = new Date();

    tx.set(app.gameRef, state);
  });
}

export async function abortBullThrow() {
  if (!app.gameRef) return;

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(app.gameRef);
    const state = snap.data();
    if (!state) return;

    const bullActive = state?.match?.starting === "bull" && state?.match?.bull && !state.match.bull.resolved;
    if (!bullActive) return;

    tx.set(app.gameRef, {
      createdAt: state.createdAt || new Date(),
      updatedAt: new Date(),
      status: "lobby",
      expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
  });
}

export async function undoLast() {
  if (!app.gameRef) {
    showError("Create a lobby first.");
    return;
  }

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(app.gameRef);
    const state = snap.data();
    if (!state?.match || !state?.leg) {
      showError("Press New Game to start.");
      return;
    }

    if (state.pendingCheckout) {
      showError("Cancel the checkout first.");
      return;
    }

    const leg = state.leg;
    if (leg.status !== "in_progress") {
      showError("Leg finished.");
      return;
    }

    if (!Array.isArray(leg.history) || leg.history.length === 0) {
      showError("Nothing to undo");
      return;
    }

    leg.history.pop();

    const match = state.match;
    const starter = starterForLeg(match);
    const rebuilt = makeFreshLeg(match.mode, starter);

    for (const h of leg.history) {
      const p = h.player;
      const before = rebuilt.players[p].score;
      const after = before - h.entered;

      if (isImpossibleCheckout(before, h.entered)) continue;

      const bust = isBustScore(after);
      rebuilt.history.push({
        player: p,
        entered: h.entered,
        bust,
        before,
        after: bust ? before : after,
        dartsUsed: 3,
        at: h.at || new Date(),
      });

      if (!bust) rebuilt.players[p].score = after;
      rebuilt.currentPlayer = (rebuilt.currentPlayer + 1) % 2;
    }

    state.leg = rebuilt;
    state.updatedAt = new Date();
    tx.set(app.gameRef, state);
  });
}
