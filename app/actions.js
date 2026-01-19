// app/actions.js
import { app } from "./state.js";
import { getActorId, getActorName } from "./auth.js";
import { setGameIdInUrl } from "./routing.js";
import { clearGameIdFromUrl } from "./routing.js";
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
// Profile stats are applied client-side (each user updates only their own /users/{uid} doc)
// when the realtime listener observes match.status === "finished".
import { initBullState, tryResolveBull } from "./bull/core.js";
import { setAudioEvent, buildVisitClips } from "./audio/audio.js";
import { showError, safeFocusScoreInput, setLobbyGateVisible, setInviteModalVisible, setSetupModalVisible, setConfirmNewMatchModalVisible, setWinnerModalVisible } from "./ui/render.js";
import { canScoreNow, mySeatIndex, isHost } from "./permissions.js";
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
// Creates a new game doc and switches to it.
// - lobbyType: "online" | "local"
// - openInvite: whether to show the invite modal after creation
export async function createNewGameAndShowInvite({ lobbyType = "online", openInvite = true } = {}) {
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
  const seat1PhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;

  // Remember what we’re setting up (used by UI to show the right setup fields)
  app.pendingLobbyType = lobbyType;

  await newRef.set({
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: "lobby",

    lobbyType,

    seat1Id: getActorId(),
    seat1Name: actorName,
    seat1PhotoURL,
    seat2Id: null,
    seat2Name: null,
    seat2PhotoURL: null,

    // Lobby actors (used to auto-populate player names/ids)
    lobby: {
      host: {
        actorId: getActorId(),
        name: actorName,
        uid: app.user && !app.user.isAnonymous ? app.user.uid : null,
        photoURL: seat1PhotoURL,
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

  if (openInvite) setInviteModalVisible(true);

  return { ok: true, gameId: newId };
}

// Convenience: start a local (offline) game flow
export async function createLocalGameAndOpenSetup() {
  // Local games don’t need a name gate; setup modal collects names.
  const res = await createNewGameAndShowInvite({ lobbyType: "local", openInvite: false });
  if (!res?.ok) return res;

  // QoL: prefill Player 1 name for local games with the current user's name (editable).
  // This avoids showing "Player 1" for signed-in users.
  try {
    const p1 = document.getElementById("setupP1");
    if (p1 && (!p1.value || p1.value.trim() === "Player 1")) {
      p1.value = getActorName() || "Player 1";
    }
  } catch (_) {}

  // Open setup immediately (no invite step)
  setSetupModalVisible(true);
  return res;
}

export function openInviteModalForCurrentGame({ autoSetup = false } = {}) {
  if (!app.gameId) return;

  // build the share link for THIS game
  const url = new URL(window.location.href);
  url.searchParams.set("game", app.gameId);
  url.searchParams.delete("openInvite");
  url.searchParams.delete("autoSetup");

  const linkEl = document.getElementById("inviteLinkText");
  if (linkEl) linkEl.textContent = url.toString();

  app.autoSetupAfterInviteClose = !!autoSetup;
  setInviteModalVisible(true);
}

export function leaveMatch() {
  // Signed-in users go back to dashboard; guests go back to gate/index.
  if (app.user && !app.user.isAnonymous) {
    window.location.href = "./dashboard.html";
    return;
  }
  clearGameIdFromUrl();
  window.location.href = "./index.html";
}

export async function restartMatch() {
  try {
    if (!app.gameRef) return { ok: false, msg: "No active game" };

    // Compat Firestore SDK: transactions are started via db.runTransaction and
    // DocumentSnapshot.exists is a boolean (not a function).
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(app.gameRef);
      if (!snap.exists) throw new Error("Game not found");

      const state = snap.data() || {};
      const match = state.match || {};
      if (!match || !Array.isArray(match.players) || match.players.length < 2) {
        throw new Error("No match to restart");
      }

      const p1Name = match.players?.[0]?.name || match.seat1Name || "Player 1";
      const p2Name = match.players?.[1]?.name || match.seat2Name || "Player 2";

      // IMPORTANT: makeNewMatch returns an object like { match, leg, pendingCheckout?, ... }
      const fresh = makeNewMatch({
        mode: match.mode,
        bestOf: match.bestOf,
        p1Name,
        p2Name,
      });

      // Preserve starter for the reset leg.
      const starterLeg1 = match.starterLeg1 ?? 0;
      fresh.match.starterLeg1 = starterLeg1;
      if (fresh.leg) fresh.leg.currentPlayer = starterLeg1;

      // IMPORTANT: makeNewMatch() defaults gameType to "single".
      // Our app uses "online" | "local"; keep the existing gameType so
      // permission logic (turn enforcement, mutual control) stays correct.
      fresh.match.gameType = match.gameType || "online";

      // Preserve extra match-level fields
      fresh.match.starting = match.starting || "random";
      fresh.match.competition = match.competition || "casual";
      // Preserve mutual control EXACTLY for online matches.
      // (Any non-online game type should behave local-only.)
      fresh.match.allowMutualControl =
        fresh.match.gameType === "online" ? match.allowMutualControl === true : false;

      // Preserve player identity (uids)
      fresh.match.players[0].uid = match.players?.[0]?.uid || null;
      fresh.match.players[1].uid = match.players?.[1]?.uid || null;

      // Preserve host + seating (permissions depend on these)
      fresh.match.hostId = match.hostId;
      fresh.match.seat1Id = match.seat1Id;
      fresh.match.seat2Id = match.seat2Id;
      fresh.match.seat1Uid = match.seat1Uid || null;
      fresh.match.seat2Uid = match.seat2Uid || null;
      fresh.match.seat1Name = match.seat1Name || p1Name;
      fresh.match.seat2Name = match.seat2Name || p2Name;

      // Bull throw state
      let bull = null;
      if (fresh.match.starting === "bull") {
        bull = initBullState();
      }

      // Update BOTH match and leg so it truly restarts
      tx.update(app.gameRef, {
        match: fresh.match,
        leg: fresh.leg,
        pendingCheckout: null,
        bull,
        updatedAt: new Date(),
      });
    });

    return { ok: true };
  } catch (e) {
    console.error("restartMatch failed", e);
    return { ok: false, msg: e?.message || "Could not restart match" };
  }
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

  // Mode is decided by how the lobby was created (dashboard / lobby gate)
  const p1Input = (document.getElementById("setupP1")?.value || "Player 1").trim() || "Player 1";
  const p2Input = (document.getElementById("setupP2")?.value || "Player 2").trim() || "Player 2";

  const competition = (document.getElementById("setupCompetition")?.value || "casual"); // online only
  const allowMutualControl = (document.getElementById("setupAllowMutualControl")?.value || "no") === "yes";

  try {
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(app.gameRef);
      const lobby = snap.data() || {};

      const lobbyType = lobby.lobbyType || app.pendingLobbyType || "online"; // "online" | "local"

      const actorId = getActorId();
    const actorName = getActorName();

      const hostName = lobby?.lobby?.host?.name || actorName || "Player 1";
      const joinerName = lobby?.lobby?.joiner?.name || lobby.seat2Name || "Player 2";

      // Names:
      // - local: user-entered in setup modal
      // - online: auto from host/joiner profile (not editable)
      const p1Name = lobbyType === "local" ? p1Input : (lobby.seat1Name || hostName).trim() || "Player 1";
      const p2Name =
        lobbyType === "local"
          ? p2Input
          : (String(joinerName).trim() || "Player 2");

      const seat2 = lobby.seat2Id || lobby?.match?.seat2Id || lobby?.lobby?.joiner?.actorId;
      if (lobbyType === "online" && !seat2) {
        throw new Error("Waiting for Player 2 to join…");
      }


      const state = makeNewMatch({ mode, bestOf, p1Name, p2Name });

      // Persist mode
      state.match.gameType = lobbyType; // "online" | "local"

      // Online-only options
      state.match.competition = lobbyType === "online" ? competition : "casual";
      state.match.allowMutualControl = lobbyType === "online" ? allowMutualControl : false;

      // Attach player identity (uid when Google-auth, null for guests)
      const hostUid = lobby?.lobby?.host?.uid || (app.user && !app.user.isAnonymous ? app.user.uid : null);
      const joinerUid = lobby?.lobby?.joiner?.uid || null;
      state.match.players[0].uid = hostUid;
      state.match.players[1].uid = lobbyType === "online" ? joinerUid : null;

      // Attach player photos (Google profile photo URL)
      const hostPhotoURL = lobby?.lobby?.host?.photoURL || lobby.seat1PhotoURL || (app.user && !app.user.isAnonymous ? (app.user.photoURL || null) : null);
      const joinerPhotoURL = lobby?.lobby?.joiner?.photoURL || lobby.seat2PhotoURL || null;
      state.match.players[0].photoURL = hostPhotoURL;
      state.match.players[1].photoURL = lobbyType === "online" ? joinerPhotoURL : null;
      state.match.seat1PhotoURL = hostPhotoURL;
      state.match.seat2PhotoURL = lobbyType === "online" ? joinerPhotoURL : null;

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
      state.match.gameType = lobbyType; // "local" | "online"

      // Copy lobby seats into match seats (online only)
      state.match.seat1Id = lobbyType === "online" ? (lobby.seat1Id || actorId) : null;
      state.match.seat2Id = lobbyType === "online" ? (lobby.seat2Id || null) : null;

      if (starterChoice !== "bull") {
        setAudioEvent(state, ["./audio/phrases/match_start.mp3"]);
      }

      // Preserve lobby identity fields on the doc so future "New Game" works
      state.lobbyType = lobbyType;
      state.seat1Id = lobby.seat1Id || lobby?.match?.seat1Id || getActorId();
      state.seat2Id = lobby.seat2Id || lobby?.match?.seat2Id || null;
      state.seat1Name = lobby.seat1Name || p1Name;
      state.seat2Name = lobby.seat2Name || p2Name;
      state.lobby = lobby.lobby || state.lobby;  // keep host/joiner object if present
      state.createdBy = lobby.createdBy || state.seat1Id;

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
  // In table (dartpad) mode, the score input holds a breakdown like "20+20+20".
  // The authoritative per-dart values live in app.dartThrows.
  let entered = null;
  if (app.inputMode === "table") {
    if (!Array.isArray(app.dartThrows) || app.dartThrows.length !== 3) {
      showError("Select 3 darts first.");
      return;
    }
    entered = app.dartThrows.reduce((a, b) => a + (Number(b) || 0), 0);
  } else {
    entered = Number(inputEl?.value);
  }

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
        actorId: getActorId(),
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

    // Only the actor who triggered the checkout can confirm it.
    if (pc.actorId && pc.actorId !== getActorId()) {
      return;
    }

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
      // For match-end recap (e.g., highest checkout)
      checkoutScore: oldScore,
      players: [s0, s1],
      finishedAt: new Date(),
    });

    match.legsWon[p] += 1;

    const needed = Math.ceil(match.bestOf / 2);
    if (match.legsWon[p] >= needed) {
      match.status = "finished";
      match.winner = p;
    }

    // IMPORTANT (security + permissions): do NOT write to /users/{uid} docs here.
    // Firestore rules only allow a user to write their own profile document.
    // Instead, each signed-in client applies their own stats client-side when
    // they observe match.status === "finished" via the realtime listener.

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

  // If the match is finished, the Winner modal button acts as "New Match".
  // We keep this client-side: open the New Match flow (host only in online).
  try {
    const snap = await app.gameRef.get();
    const state = snap.data();
    if (!state?.match || !state?.leg) return;

    if (state.match.status === "finished") {
      if (state.match.gameType === "online" && !isHost(state)) {
        // Non-hosts shouldn't be able to start a new match.
        return;
      }
      // Hide winner modal and show the confirm-new-match modal (then setup).
      setWinnerModalVisible(false);
      setConfirmNewMatchModalVisible(true);
      return;
    }
  } catch (e) {
    console.warn("continueOrNewMatch pre-read failed", e);
  }

  // Otherwise it's end of leg -> continue to next leg
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
