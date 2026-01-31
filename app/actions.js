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
  isPossibleCheckout,
} from "./model/rules.js";
import { calcLegStats } from "./model/stats.js";
// Profile stats are applied client-side (each user updates only their own /users/{uid} doc)
// when the realtime listener observes match.status === "finished".
import { initBullState, tryResolveBull } from "./bull/core.js";
import { promptDidHitDouble, promptCheckInDartsUsed } from "./ui/checkinPrompt.js";
import { promptAttemptedCheckout } from "./ui/checkoutAttemptPrompt.js";
import { setAudioEvent, buildVisitClips, nameClipForDisplayName } from "./audio/audio.js";
import { decideNemesisThought } from "./nemesis/mood.js";
import { makeRng } from "./nemesis/rng.js";
import { showError, safeFocusScoreInput, setLobbyGateVisible, setInviteModalVisible, setSetupModalVisible, setNemesisMatchSetupModalVisible, setConfirmNewMatchModalVisible, setWinnerModalVisible } from "./ui/render.js";
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

  // Build invite link using pretty route (/game/<id>)
  const url = new URL(window.location.href);
  url.pathname = `/game/${encodeURIComponent(newId)}`;
  url.searchParams.delete("game");

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

export async function leaveMatch() {
  // For ONLINE lobbies, write a single "left/closed" marker so invites can expire
  // and the remaining player gets UX feedback. (No heartbeats.)
  try {
    const state = app.latestState;
    const actorId = getActorId();
    const now = new Date();

    if (app.gameRef && state && state.lobbyType === "online") {
      // Lobby (no active match yet)
      if (state.status === "lobby" && !state.match) {
        if (actorId && state.seat1Id && actorId === state.seat1Id) {
          // Host leaving: close lobby so joiners can't enter
          await app.gameRef.update({
            status: "closed",
            closedAt: now,
            updatedAt: now,
            seat1LeftAt: now,
            seat1Id: null,
            "lobby.host": null,
          });
        } else if (actorId && state.seat2Id && actorId === state.seat2Id) {
          // Joiner leaving: free the seat
          await app.gameRef.update({
            updatedAt: now,
            seat2LeftAt: now,
            seat2Id: null,
            seat2Name: null,
            seat2PhotoURL: null,
            "lobby.joiner": null,
          });
        }
      } else if (state.match) {
        // Match in progress: mark as abandoned (still a single write)
        const update = {
          status: "abandoned",
          abandonedAt: now,
          updatedAt: now,
        };
        if (actorId && state.seat1Id && actorId === state.seat1Id) {
          update.seat1LeftAt = now;
          update.seat1Id = null;
          update.seat1Name = null;
          update.seat1PhotoURL = null;
          update["match.seat1Id"] = null;
          update["match.seat1Name"] = null;
          update["match.seat1PhotoURL"] = null;
          update["lobby.host"] = null;
        }
        if (actorId && state.seat2Id && actorId === state.seat2Id) {
          update.seat2LeftAt = now;
          update.seat2Id = null;
          update.seat2Name = null;
          update.seat2PhotoURL = null;
          update["match.seat2Id"] = null;
          update["match.seat2Name"] = null;
          update["match.seat2PhotoURL"] = null;
          update["lobby.joiner"] = null;
        }
        await app.gameRef.update(update);
      }
    }
  } catch (e) {
    // Never block leaving on a write failure.
    console.warn("leaveMatch: non-fatal write failed", e);
  }

  // Signed-in users go back to dashboard; guests go back to gate/index.
  if (app.user && !app.user.isAnonymous) {
    window.location.href = "/dashboard";
    return;
  }
  clearGameIdFromUrl();
  window.location.href = "/index";
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
    if (state?.nemesis?.enabled === true) setNemesisMatchSetupModalVisible(true);
    else setSetupModalVisible(true);
    return;
  }

  if (state.leg?.status === "finished") {
    if (state?.nemesis?.enabled === true) setNemesisMatchSetupModalVisible(true);
    else setSetupModalVisible(true);
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


  // V4 Stage 1 - rules/presets (stored only, behavior unchanged)
  const preset = (document.getElementById("setupPreset")?.value || "x01");
  const checkIn = (document.getElementById("setupCheckIn")?.value || "straight");
  const checkOut = (document.getElementById("setupCheckOut")?.value || "double");
  const trackCheckoutStats = !!document.getElementById("setupTrackCheckoutStats")?.checked;
  console.log("[setup] preset=", preset, "checkIn=", checkIn, "checkOut=", checkOut, "trackCheckoutStats=", trackCheckoutStats);


  // Mode is decided by how the lobby was created (dashboard / lobby gate)
  const p1Input = (document.getElementById("setupP1")?.value || "Player 1").trim() || "Player 1";
  const p2Input = (document.getElementById("setupP2")?.value || "Player 2").trim() || "Player 2";

  const competition = (document.getElementById("setupCompetition")?.value || "casual"); // online only
  const allowMutualControl = (document.getElementById("setupAllowMutualControl")?.value || "no") === "yes";

  try {
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(app.gameRef);
      const lobby = snap.data() || {};

      let lobbyType = lobby.lobbyType || app.pendingLobbyType || "online";

      const isNemesis = lobby?.nemesis?.enabled === true;
      if (isNemesis) {
        // Nemesis games are always local. Keep the existing Nemesis config when restarting.
        lobbyType = "local";
      } // "online" | "local"

      const actorId = getActorId();
    const actorName = getActorName();

      const hostName = lobby?.lobby?.host?.name || actorName || "Player 1";
      const joinerName = lobby?.lobby?.joiner?.name || lobby.seat2Name || "Player 2";

      // Names:
      // - local: user-entered in setup modal
      // - online: auto from host/joiner profile (not editable)
      const p1Name = isNemesis
        ? (String(lobby.seat1Name || p1Input || hostName).trim() || "Player 1")
        : (lobbyType === "local" ? p1Input : (lobby.seat1Name || hostName).trim() || "Player 1");

      const p2Name = isNemesis
        ? (String(lobby.seat2Name || "Nemesis").trim() || "Nemesis")
        : (lobbyType === "local" ? p2Input : (String(joinerName).trim() || "Player 2"));

      const seat2 = lobby.seat2Id || lobby?.match?.seat2Id || lobby?.lobby?.joiner?.actorId;
      if (lobbyType === "online" && !seat2) {
        throw new Error("Waiting for Player 2 to join…");
      }


      const state = makeNewMatch({ mode, bestOf, p1Name, p2Name });
      // Rules (stored; gameplay behavior unchanged in Stage 1)
      state.match.rules = {
        preset,
        checkIn,
        checkOut,
        trackCheckoutStats,
      };
      // Initialize per-player check-in state for the leg (Straight In => already checked in; Double In => must check in)
      const _checkedInInit = checkIn !== "double";
      if (state.leg && Array.isArray(state.leg.players)) {
        state.leg.players = state.leg.players.map(p => ({ ...p, checkedIn: _checkedInInit }));
      }



      // Persist mode
      state.match.gameType = lobbyType; // "online" | "local"

      // Preserve Nemesis configuration when restarting a Nemesis lobby.
      // IMPORTANT: do not alter scoring/checkout methodology here — this is config only.
      if (isNemesis && lobby?.nemesis && typeof lobby.nemesis === "object") {
        const prev = lobby.nemesis;
        state.nemesis = {
          ...prev,
          enabled: true,
          name: prev.name || "Nemesis",
          // Fresh seed per new match so legs re-randomise within the same config.
          seed: Math.floor(Math.random() * 1_000_000_000),
          runtime: {},
          createdAt: Date.now(),
        };
      }

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
        const isNemesisGame = !!(state?.nemesis?.enabled);
        const starterName = (state.match?.players?.[state.leg.currentPlayer]?.name) || "";
        const clips = [];
        if (isNemesisGame) {
          clips.push("/audio/phrases/nemesis_gameon.mp3");
        } else {
        const nameClip = nameClipForDisplayName(starterName);
        if (nameClip) {
          clips.push(nameClip);
          clips.push("/audio/phrases/ThrowFirst.mp3");
        } else {
          // If we do not have an eligible name clip, fall back to a generic line.
          // (File will be supplied by the repo: /audio/phrases/match_start.mp3)
          clips.push("/audio/phrases/match_start.mp3");
        }
        }
        setAudioEvent(state, clips);
      }

      // Preserve lobby identity fields on the doc so future "New Game" works
      state.lobbyType = lobbyType;
      state.seat1Id = lobby.seat1Id || lobby?.match?.seat1Id || getActorId();
      state.seat2Id = lobby.seat2Id || lobby?.match?.seat2Id || null;
      state.seat1Name = lobby.seat1Name || p1Name;
      state.seat2Name = lobby.seat2Name || p2Name;
      // Firestore does not allow `undefined` values. Ensure lobby is always an object when writing.
      // For local/Nemesis games there may not be a lobby host/joiner object present.
      state.lobby = (lobby.lobby ?? state.lobby ?? {});
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

export async function startMatchFromNemesisSetup() {
  if (!app.gameRef) {
    showError("Create a lobby first.");
    return;
  }

  const mode = Number(document.getElementById("nemesisSetupMode")?.value || 501);
  const bestOf = Number(document.getElementById("nemesisSetupBestOf")?.value || 3);
  const starterChoice = (document.getElementById("nemesisSetupStarter")?.value || "random");

  const preset = (document.getElementById("nemesisSetupPreset")?.value || "x01");
  const checkIn = (document.getElementById("nemesisSetupCheckIn")?.value || "straight");
  const checkOut = (document.getElementById("nemesisSetupCheckOut")?.value || "double");
  const trackCheckoutStats = !!document.getElementById("nemesisSetupTrackCheckoutStats")?.checked;

  try {
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(app.gameRef);
      const lobby = snap.data() || {};

      // Nemesis games are always local. Keep the existing Nemesis config when restarting.
      let lobbyType = "local";

      const actorName = getActorName();
      const hostName = lobby?.lobby?.host?.name || actorName || "Player 1";

      const p1Name = String(lobby.seat1Name || hostName || "Player 1").trim() || "Player 1";
      const p2Name = String(lobby.seat2Name || "Nemesis").trim() || "Nemesis";

      const state = makeNewMatch({ mode, bestOf, p1Name, p2Name });
      state.match.rules = { preset, checkIn, checkOut, trackCheckoutStats };

      // Initialize per-player check-in state for the leg
      const _checkedInInit = checkIn !== "double";
      if (state.leg && Array.isArray(state.leg.players)) {
        state.leg.players = state.leg.players.map(p => ({ ...p, checkedIn: _checkedInInit }));
      }

      state.match.gameType = lobbyType;

      // Match owner/host identity (needed for Game Settings host-only actions in local/Nemesis mode)
      {
        const actorId = getActorId();
        state.match.hostId = actorId;
        state.match.seat1Id = actorId;
      }

      // Preserve Nemesis configuration when restarting a Nemesis lobby.
      if (lobby?.nemesis && typeof lobby.nemesis === "object") {
        const prev = lobby.nemesis;
        state.nemesis = {
          ...prev,
          enabled: true,
          name: prev.name || "Nemesis",
          seed: Math.floor(Math.random() * 1_000_000_000),
          runtime: {},
          createdAt: Date.now(),
        };
      }

      // Starter selection (match-start behavior)
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

      // Carry seat ids through (local/nemesis doesn't need online ids)
      state.match.players[0].uid = lobby?.lobby?.host?.uid || (app.user && !app.user.isAnonymous ? app.user.uid : null);
      state.match.players[1].uid = null;

      // Photos: keep P1 photo if present; Nemesis uses fixed icon client-side
      const hostPhotoURL = lobby?.lobby?.host?.photoURL || lobby.seat1PhotoURL || (app.user && !app.user.isAnonymous ? (app.user.photoURL || null) : null);
      state.match.players[0].photoURL = hostPhotoURL;
      state.match.players[1].photoURL = null;
      state.match.seat1PhotoURL = hostPhotoURL;
      state.match.seat2PhotoURL = null;

      // Match lifecycle
      state.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      state.status = "active";

      // Reset lobby wrapper fields while preserving lobby metadata
      const next = {
        ...lobby,
        lobbyType,
        match: state.match,
        leg: state.leg,
        legs: state.match.legs,
        status: state.status,
        expiresAt: state.expiresAt,
        createdAt: lobby.createdAt || Date.now(),
        updatedAt: Date.now(),
        // Nemesis config lives at top-level for listeners
        nemesis: state.nemesis,
      };

      tx.set(app.gameRef, next, { merge: true });
    });

    // Close modal and focus score
    setNemesisMatchSetupModalVisible(false);
    safeFocusScoreInput();
  } catch (e) {
    console.error("startMatchFromNemesisSetup failed", e);
    showError(e?.message || "Could not start match");
  }
}



export async function submitScore() {
  console.log("[checkin] submitScore() called");
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

  
  // DEBUG: check-in prompt tracing
  try {
    const st0 = app.latestState;
    const rule0 = st0?.match?.rules || {};
    console.log("[checkin] submitScore entered=", entered, "checkIn=", rule0.checkIn, "trackCheckoutStats=", rule0.trackCheckoutStats, "currentPlayer=", st0?.leg?.currentPlayer, "p.checkedIn=", st0?.leg?.players?.[st0?.leg?.currentPlayer]?.checkedIn);
  } catch (e) { console.log("[checkin] debug preamble failed", e); }

  // Pre-prompt for Double-In tracking (never prompt inside a Firestore transaction).
  app.__checkInDecision = null;
  try {
    const st = app.latestState;
    const leg = st?.leg;
    const match = st?.match;
    const checkInRule = match?.rules?.checkIn || "straight";
    const trackCheckoutStats = match?.rules?.trackCheckoutStats === true;
    console.log("[checkin] rules", {checkInRule, trackCheckoutStats});

    if (leg && match && checkInRule === "double" && trackCheckoutStats) {
      console.log("[checkin] gating passed");
      const p = leg.currentPlayer;
      const playerObj = leg.players?.[p] || {};
      const checkedInBefore = playerObj.checkedIn !== false; // default true for legacy legs

      if (!checkedInBefore) {
        console.log("[checkin] player not checked in; entered=", entered);
        if (entered === 0) {
          console.log("[checkin] prompting didHitDouble");
          const res = await promptDidHitDouble();
          console.log("[checkin] didHitDouble result", res);
          if (res === null) return; // cancelled
          if (res.hit === true) {
            app.__checkInDecision = {
              forPlayer: p,
              forOldScore: playerObj.score,
              forEntered: entered,
              checkedInAfter: true,
              checkInHit: true,
              checkInDartsUsed: res.dartsUsed || 1,
            };
          } else {
            app.__checkInDecision = {
              forPlayer: p,
              forOldScore: playerObj.score,
              forEntered: entered,
              checkedInAfter: false,
              checkInHit: false,
              checkInDartsUsed: 3,
            };
          }
        } else {
          // entered > 0 implies check-in occurred this visit.
          if (entered > 60) {
            // must have checked in with dart 1 (otherwise impossible to score >60)
            app.__checkInDecision = {
              forPlayer: p,
              forOldScore: playerObj.score,
              forEntered: entered,
              checkedInAfter: true,
              checkInHit: true,
              checkInDartsUsed: 1,
            };
          } else {
          console.log("[checkin] prompting checkInDartsUsed; entered=", entered);
            const res = await promptCheckInDartsUsed({ maxOption: 2 });
          console.log("[checkin] checkInDartsUsed result", res);
            if (res === null) return; // cancelled
            app.__checkInDecision = {
              forPlayer: p,
              forOldScore: playerObj.score,
              forEntered: entered,
              checkedInAfter: true,
              checkInHit: true,
              checkInDartsUsed: res.dartsUsed || 1,
            };
          }
        }
      }
    }
  } catch (e) {
    console.error(e);
    app.__checkInDecision = null;
  }



// Step C: Double-Out checkout attempt prompt (tracking gated).
// If the player STARTS the visit on a double-out checkoutable number and DOES NOT finish the leg,
// ask whether they attempted a checkout, and (if yes) how many darts were thrown at a double.
// (Modal prompts must be done BEFORE the Firestore transaction.)
app.__checkoutAttemptDecision = null;
try {
  const stA = app.latestState;
  const matchA = stA?.match;
  const legA = stA?.leg;
  const rulesA = matchA?.rules || {};
  const checkOutRuleA = rulesA.checkOut || "double";
  const trackCheckoutStatsA = rulesA.trackCheckoutStats === true;

  if (legA && matchA && checkOutRuleA === "double" && trackCheckoutStatsA) {
    const pA = legA.currentPlayer;
    const playerObjA = legA.players?.[pA] || {};
    const oldScoreA = playerObjA.score;
    const checkedInA = playerObjA.checkedIn !== false; // legacy default true

    // Only ask when player is checked in and starts on a checkoutable number.
    if (checkedInA && isPossibleCheckout(oldScoreA, "double")) {
      const afterA = oldScoreA - entered;
      const wouldBustA = (afterA < 0) || isBustScore(afterA, "double");
      const wouldCheckoutA = (afterA === 0) && !isImpossibleCheckout(oldScoreA, entered, "double");

      // Ask only if they didn't bust and didn't checkout (entered can be 0..oldScore-1).
      if (!wouldBustA && !wouldCheckoutA && afterA > 0) {
        const res = await promptAttemptedCheckout();
        if (res === null) return; // cancelled
        app.__checkoutAttemptDecision = {
          forPlayer: pA,
          forOldScore: oldScoreA,
          forEntered: entered,
          attempted: res.attempted === true,
          dartsOnDouble: res.attempted === true ? (res.dartsOnDouble || null) : null,
        };
      }
    }
  }
} catch (e) {
  console.log("[checkoutAttempt] prompt flow error", e);
  app.__checkoutAttemptDecision = null;
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
    if (state.match?.starting === "bull" && state.match?.bull && !state.match.bull.finalized) {
      showError("Finish the bull throw first.");
      return;
    }

    const p = state.leg.currentPlayer;
    const playerObj = state.leg.players[p] || {};
    const oldScore = playerObj.score;
    const checkOutRule = state.match?.rules?.checkOut || "double";
    const checkInRule = state.match?.rules?.checkIn || "straight";
    const trackCheckoutStats = state.match?.rules?.trackCheckoutStats === true;

    const checkedInBefore = playerObj.checkedIn !== false; // default true for old legs
    let checkedInAfter = checkedInBefore;
    let checkInHit = null;
    let checkInDartsUsed = null;

    // Double-In (tracking gated). If not tracking, we still infer checked-in the first time they score > 0.
    if (checkInRule === "double" && !checkedInBefore) {
      if (!trackCheckoutStats) {
        if (entered > 0) checkedInAfter = true;
      } else {
        // Decisions were computed before the transaction and stored on app.__checkInDecision (see below).
        const d = app.__checkInDecision || null;
        if (d && d.forPlayer === p && d.forOldScore === oldScore && d.forEntered === entered) {
          checkedInAfter = d.checkedInAfter === true;
          checkInHit = d.checkInHit;
          checkInDartsUsed = d.checkInDartsUsed;
        } else {
          // If we expected a decision but don't have one, refuse the write.
          showError("Check-in confirmation required.");
          return;
        }
      }
    }

    const newScore = oldScore - entered;
    if (isImpossibleCheckout(oldScore, entered, checkOutRule)) {
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
        minDarts: minDartsForCheckout(oldScore, checkOutRule),
        at: new Date(),
      };
      state.updatedAt = new Date();
      tx.set(app.gameRef, state);
      return;
    }

    const bust = isBustScore(newScore, checkOutRule);

    state.leg.history.push({
      player: p,
      entered,
      bust,
      before: oldScore,
      after: bust ? oldScore : newScore,
      dartsUsed: 3,
      at: new Date(),

      // Double-In bookkeeping (Step A/B)
      checkedInBefore,
      checkedInAfter,
      checkInHit,
      checkInDartsUsed,


// Step C: Double-Out checkout attempt bookkeeping (tracking gated)
checkoutOpportunity: (trackCheckoutStats && checkOutRule === "double" && isPossibleCheckout(oldScore, "double")) === true,
attemptedCheckout: (() => {
  const d = app.__checkoutAttemptDecision;
  if (!d) return null;
  if (d.forPlayer !== p) return null;
  if (d.forOldScore !== oldScore) return null;
  if (d.forEntered !== entered) return null;
  return d.attempted === true;
})(),
checkoutAttemptDartsOnDouble: (() => {
  const d = app.__checkoutAttemptDecision;
  if (!d) return null;
  if (d.forPlayer !== p) return null;
  if (d.forOldScore !== oldScore) return null;
  if (d.forEntered !== entered) return null;
  return d.attempted === true ? (d.dartsOnDouble || null) : null;
})(),
    });

    if (!bust) {
      state.leg.players[p].score = newScore;
    }

    // Apply checked-in state (double-in)
    if (state.match?.rules?.checkIn === "double") {
      state.leg.players[p].checkedIn = checkedInAfter === true;
    }
    // Advance turn
    state.leg.currentPlayer = (state.leg.currentPlayer + 1) % 2;

    // Audio: score + (optional) require
    const scoreCallType = bust || entered === 0 ? "no_score" : "number";

    const nextP = state.leg.currentPlayer;
    // Prefer seat names (most consistently updated), fall back to players[].name.
    const nextName = (nextP === 0 ? (state.match.seat1Name || null) : (state.match.seat2Name || null))
      || state.match.players?.[nextP]?.name
      || (nextP === 0 ? "Player 1" : "Player 2");
    const nextRemaining = state.leg.players[nextP].score;

    const clips = buildVisitClips({
      scoreCallType,
      entered,
      nextPlayerName: nextName,
      nextRemaining,
      nextIsNemesis: !!(state?.nemesis?.enabled) && (nextP === 1),
      checkOutRule: state.match?.rules?.checkOut ?? "double",
    });

    setAudioEvent(state, clips);

    state.updatedAt = new Date();
    tx.set(app.gameRef, state);
  });

  

// Clear any one-shot prompt decisions
app.__checkInDecision = null;
app.__checkoutAttemptDecision = null;
// UI-only cleanup after transaction
  if (app.inputMode === "table") {
    clearDarts();
  }

  if (inputEl) inputEl.value = "";
  safeFocusScoreInput();
}


// Nemesis (offline bot) scoring: programmatic score submission with no UI prompts.
// This uses the same leg/match bookkeeping as submitScore(), but:
// - does not read from DOM
// - writes pendingCheckout.actorId = null so the local player can auto-confirm for Nemesis
export async function submitNemesisScore(entered, dartsUsed = 3, meta = null) {
  if (!app.gameRef) return;

  const v = Number(entered);
  if (!Number.isFinite(v) || v < 0 || v > 180) return;
  if (IMPOSSIBLE_TURN_SCORES.has(v)) return;

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(app.gameRef);
    const state = snap.data();
    if (!state || !state.match || !state.leg) return;

    const match = state.match;
    const leg = state.leg;

    if (match.status !== "in_progress") return;
    if (leg.status !== "in_progress") return;
    if (state.pendingCheckout) return;

    // Nemesis is always seat 2 (index 1) in this mode.
    const p = 1;

    const rule0 = match.rules || {};
    const checkInRule = rule0.checkIn || "straight";
    const checkOutRule = rule0.checkOut || "double";
    const trackCheckoutStats = rule0.trackCheckoutStats === true;

    const oldScore = leg.players?.[p]?.score;
    if (!Number.isFinite(oldScore)) return;

    // Double-In bookkeeping (minimal simulation for slice 3)
    const checkedInBefore = !!leg.players[p].checkedIn;
    let checkedInAfter = checkedInBefore;
    let checkInHit = false;
    let checkInDartsUsed = null;

    let effectiveEntered = v;

    if (!checkedInBefore && checkInRule === "double") {
      // Simple probability: higher target3DA => more likely to find a double-in quickly.
      const t3 = Number(state?.nemesis?.target3DA) || 50;
      const pHit = Math.max(0.10, Math.min(0.85, 0.08 + (t3 / 140)));
      checkInHit = Math.random() < pHit;
      if (!checkInHit) {
        effectiveEntered = 0;
        checkedInAfter = false;
      } else {
        checkedInAfter = true;
        checkInDartsUsed = Math.max(1, Math.min(3, Math.floor(1 + Math.random() * 3)));
      }
      leg.players[p].checkedIn = checkedInAfter;
    }

    const newScore = oldScore - effectiveEntered;

    // Persist Nemesis debug thought text each visit (temporary always-on).
    try {
      const m0 = (meta && typeof meta === "object") ? meta : null;
      if (m0 && typeof m0.thought === "string") {
        state.nemesis = state.nemesis || {};
        state.nemesis.runtime = state.nemesis.runtime || {};
        state.nemesis.runtime.lastDebugThought = m0.thought;
      }
    } catch (_) {}


    // Validate impossible checkout patterns (keeps rules consistent)
    try {
        if (isImpossibleCheckout(oldScore, effectiveEntered, checkOutRule)) {
          effectiveEntered = 0;
        }
    } catch (_) {}

    
    
    // --- Nemesis flavor thought popup (rare, meaningful) ---
    function maybeAttachNemesisPopup({ visitScore, dartsUsed, checkoutHit, attemptedCheckout }) {
      try {
        if (!(state?.nemesis?.enabled === true)) return;
        if (state?.nemesis?.showDialog === false) return;
        state.nemesis.runtime = state.nemesis.runtime || {};
        const rt = state.nemesis.runtime;

        // Count bot visits in this leg.
        const botVisits = Array.isArray(leg.history) ? leg.history.filter(h => h && h.player === p).length : 0;
        const legNo = (Array.isArray(match.legs) ? match.legs.length : 0) + 1;
        const visitKey = `L${legNo}V${botVisits}`;

        // Update visit counters (used for global throttling).
        rt.thoughtVisits = Number(rt.thoughtVisits || 0) + 1;

        // Determine actual 3DA so far in the leg (based on recorded history, so it works even before we mutate leg.players[p].score).
        let myRemaining = Number(leg.players?.[p]?.score ?? 501);
        let oppRemaining = Number(leg.players?.[1 - p]?.score ?? 501);

        let darts = 0;
        let points = 0;
        if (Array.isArray(leg.history)) {
          for (const h of leg.history) {
            if (!h || h.player !== p) continue;
            darts += Number(h.dartsUsed || 3);
            // Points actually scored in that visit (busts score 0).
            const before = Number(h.before ?? 0);
            const after = Number(h.after ?? before);
            if (h.bust === true) continue;
            if (Number.isFinite(before) && Number.isFinite(after) && before >= after) {
              points += (before - after);
            }
          }
          // Use the latest "after" as our current remaining (more accurate than leg.players while mid-transaction).
          for (let i = leg.history.length - 1; i >= 0; i--) {
            const h = leg.history[i];
            if (h && h.player === p && Number.isFinite(h.after)) { myRemaining = Number(h.after); break; }
          }
        }
        const actual3DA = darts > 0 ? (points / darts) * 3 : 0;

        const legPos = (myRemaining < oppRemaining) ? "ahead" : (myRemaining > oppRemaining) ? "behind" : "even";

        // Visit tagging (simple and realistic).
        const legTarget = Number(state?.nemesis?.runtime?.activeLegTarget3DA ?? state?.nemesis?.target3DA ?? 0);
        const cons = Number(state?.nemesis?.sliders?.consistency ?? state?.nemesis?.consistency ?? 5);

        let visitTag = "normal";
        if (checkoutHit) {
          const oppOnFinish = Number.isFinite(oppRemaining) && oppRemaining > 0 && oppRemaining <= 170;
          const clutch = oppOnFinish || Number(dartsUsed || 3) === 1;
          visitTag = clutch ? "clutch" : "normal";
        } else {
          const v = Number(visitScore || 0);
          if (v === 0 && cons <= 2 && legTarget > 0 && legTarget < 80) visitTag = "catastrophic";
          else if (legTarget > 0 && v >= Math.max(100, legTarget * 1.25)) visitTag = "great";
          else if (legTarget > 0 && v <= Math.min(40, legTarget * 0.70)) visitTag = "bad";
        }

        // Streaks: track last few tags.
        const prev = Array.isArray(rt.recentVisitTags) ? rt.recentVisitTags.slice(0) : [];
        const nextTags = prev.concat([visitTag]).slice(-4);
        rt.recentVisitTags = nextTags;

        const last2 = nextTags.slice(-2);
        let streakTag = "none";
        const goodSet = new Set(["great", "clutch"]);
        const badSet = new Set(["bad", "catastrophic"]);
        if (last2.length === 2 && badSet.has(last2[0]) && badSet.has(last2[1])) streakTag = "bad2";
        if (last2.length === 2 && goodSet.has(last2[0]) && goodSet.has(last2[1])) streakTag = "good2";

        const nowMs = Date.now();
        const seedBase = `${state?.nemesis?.seed || ""}::${state?.gameId || ""}::${visitKey}`;
        const rng = makeRng(seedBase, "popupThought");

        const text = decideNemesisThought({
          nowMs,
          visitKey,
          runtime: rt,
          target3DA: Number(state?.nemesis?.target3DA || 0),
          legTarget3DA: legTarget,
          actual3DA,
          legPos,
          visitTag,
          streakTag,
          consistency: cons,
        }, rng);

        if (typeof text === "string" && text.trim().length) {
          rt.thoughtsShown = Number(rt.thoughtsShown || 0) + 1;
          rt.lastPopupAtMs = nowMs;
          rt.lastPopupKey = visitKey;
          rt.lastFlavorThought = text;
          rt.popup = {
            text,
            ts: nowMs,
            expiresAt: nowMs + 5200,
          };
        }
      } catch (_) {}
    }

// Nemesis checkout: resolve immediately (no UI prompt).
    if (newScore === 0) {
      const m0 = (meta && typeof meta === "object") ? meta : {};
      const dartsOnDouble = (match.rules && match.rules.checkOut === "double") ? (Number(m0.checkoutDartsOnDouble) || 1) : null;

      leg.history.push({
        player: p,
        entered: effectiveEntered,
        bust: false,
        before: oldScore,
        after: 0,
        dartsUsed: Math.max(1, Math.min(3, Number(dartsUsed) || 3)),
        at: new Date(),
        checkout: true,
        checkoutOpportunity: (match.rules?.trackCheckoutStats === true && (match.rules?.checkOut || "double") === "double" && isPossibleCheckout(oldScore, "double")) === true,
        attemptedCheckout: (match.rules?.trackCheckoutStats === true && (match.rules?.checkOut || "double") === "double") ? true : null,
        checkoutAttemptDartsOnDouble: (match.rules && match.rules.checkOut === "double" && match.rules.trackCheckoutStats === true)
          ? Number(m0.checkoutAttemptDartsOnDouble ?? m0.checkoutDartsOnDouble ?? dartsOnDouble ?? 0)
          : null,
        checkoutDartsOnDouble: (match.rules && match.rules.checkOut === "double" && match.rules.trackCheckoutStats === true) ? dartsOnDouble : null,
      });

      // Decide whether Nemesis should speak (rare + meaningful)
      maybeAttachNemesisPopup({ visitScore: effectiveEntered, dartsUsed, checkoutHit: true, attemptedCheckout: true });

leg.players[p].score = 0;
      leg.status = "finished";
      leg.winner = p;

      // Advance legs/match using existing helper logic by reusing calcLegStats summary path in confirmCheckout.
      // We call the same aggregation by invoking confirmCheckout-style summary inline.
      const s0 = calcLegStats(leg, 0);
      const s1 = calcLegStats(leg, 1);

      // Step E plumbing: summarize check-in/checkout tracking for this finished leg (keeps end-game stats correct)
      const rules = match.rules || {};
      const trackingOn2 = rules.trackCheckoutStats === true;
      const checkInRule2 = rules.checkIn || "straight";
      const checkOutRule2 = rules.checkOut || "double";

      const checkInDoublesThrown2 = [0, 0];
      const checkInDoublesHit2 = [0, 0];
      const checkoutOpp2 = [0, 0];
      const checkoutDoublesThrown2 = [0, 0];
      const checkoutDoublesHit2 = [0, 0];

      if (Array.isArray(leg.history)) {
        for (const h of leg.history) {
          const pIdx = h.player;
          if (pIdx !== 0 && pIdx !== 1) continue;
          if (trackingOn2 && checkInRule2 === "double" && h.checkedInBefore === false) {
            if (h.checkInHit === true) {
              checkInDoublesHit2[pIdx] += 1;
              checkInDoublesThrown2[pIdx] += Number(h.checkInDartsUsed || 1);
            } else if (h.checkInHit === false) {
              checkInDoublesThrown2[pIdx] += Number(h.checkInDartsUsed || 3);
            }
          }
          if (trackingOn2 && checkOutRule2 === "double") {
            const isOpp = h.checkoutOpportunity === true || (h.checkout === true);
            if (isOpp) checkoutOpp2[pIdx] += 1;
            if (h.attemptedCheckout === true) {
              checkoutDoublesThrown2[pIdx] += Number(h.checkoutAttemptDartsOnDouble || 0);
            }
            if (h.checkout === true) {
              checkoutDoublesHit2[pIdx] += 1;
              checkoutDoublesThrown2[pIdx] += Number(h.checkoutDartsOnDouble || 0);
            }
          }
        }
      }

      s0.checkInDoublesThrown = checkInDoublesThrown2[0];
      s1.checkInDoublesThrown = checkInDoublesThrown2[1];
      s0.checkInDoublesHit = checkInDoublesHit2[0];
      s1.checkInDoublesHit = checkInDoublesHit2[1];
      s0.checkoutOpp = checkoutOpp2[0];
      s1.checkoutOpp = checkoutOpp2[1];
      s0.checkoutDoublesThrown = checkoutDoublesThrown2[0];
      s1.checkoutDoublesThrown = checkoutDoublesThrown2[1];
      s0.checkoutDoublesHit = checkoutDoublesHit2[0];
      s1.checkoutDoublesHit = checkoutDoublesHit2[1];


      // Record finished leg stats on match
      match.legs = match.legs || [];
      match.legs.push({
        winner: p,
        checkoutScore: oldScore,
        players: [s0, s1],
        finishedAt: new Date(),
      });

      // Increment legsWon
      match.legsWon = match.legsWon || [0, 0];
      match.legsWon[p] += 1;

      // Determine match winner
      const targetWins = Math.ceil((match.bestOf || 1) / 2);
      if (match.legsWon[p] >= targetWins) {
        match.status = "finished";
        match.winner = p;
      }
      // Next leg is started from the winner modal (keeps 'Game shot' visible).
      state.pendingCheckout = null;
      // Audio: leg/match finish announcement for Nemesis.
      try {
        const clips = [match.status === "finished"
          ? "/audio/phrases/nemesis_matchend.mp3"
          : "/audio/phrases/nemesis_gameend.mp3"];
        setAudioEvent(state, clips);
      } catch (_) {}

      state.updatedAt = new Date();
      tx.set(app.gameRef, state);
      return;
    }

    const bust = isBustScore(newScore, checkOutRule);

    leg.history.push({
      player: p,
      entered: effectiveEntered,
      bust,
      before: oldScore,
      after: bust ? oldScore : newScore,
      dartsUsed: Math.max(1, Math.min(3, Number(dartsUsed) || 3)),
      at: new Date(),

      // Double-In bookkeeping (minimal)
      checkedInBefore,
      checkedInAfter,
      checkInHit,
      checkInDartsUsed,

      // Checkout attempt bookkeeping (slice 3: conservative)
      checkoutOpportunity: (trackCheckoutStats && checkOutRule === "double" && isPossibleCheckout(oldScore, "double")) === true,
      attemptedCheckout: (meta && typeof meta === "object" && meta.attemptedCheckout === true) ? true : null,
      checkoutAttemptDartsOnDouble: (meta && typeof meta === "object")
        ? Number(meta.checkoutAttemptDartsOnDouble ?? meta.checkoutDartsOnDouble ?? 0)
        : 0,
      checkoutDartsOnDouble: null,
    });

    // Decide whether Nemesis should speak (rare + meaningful)
    maybeAttachNemesisPopup({ visitScore: effectiveEntered, dartsUsed, checkoutHit: false, attemptedCheckout: false });

if (!bust) {
      leg.players[p].score = newScore;
      if (!checkedInBefore && checkInRule === "double") {
        leg.players[p].checkedIn = checkedInAfter;
      }
    }

    // Advance turn
    leg.currentPlayer = (leg.currentPlayer + 1) % 2;

    
    try {
      const scoreCallType = bust || effectiveEntered === 0 ? "no_score" : "number";
      const nextP = leg.currentPlayer;
      const nextName = (nextP === 0 ? (state.match.seat1Name || null) : (state.match.seat2Name || null))
        || state.match.players?.[nextP]?.name
        || (nextP === 0 ? "Player 1" : "Player 2");
      const nextRemaining = leg.players[nextP].score;
      const clips = buildVisitClips({
        scoreCallType,
        entered: effectiveEntered,
        nextPlayerName: nextName,
        nextRemaining,
        nextIsNemesis: !!(state?.nemesis?.enabled) && (nextP === 1),
      checkOutRule: state.match?.rules?.checkOut ?? "double",
      });
      setAudioEvent(state, clips);
    } catch (_) {}
state.updatedAt = new Date();
    tx.set(app.gameRef, state);
  });
}


export async function confirmCheckout(dartsUsed, dartsOnDouble = null) {
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
      // For Step C/D stats aggregation: successful checkout counts as an opportunity and an attempted checkout.
      checkoutOpportunity: (match.rules?.trackCheckoutStats === true && (match.rules?.checkOut || "double") === "double" && isPossibleCheckout(oldScore, "double")) === true,
      attemptedCheckout: (match.rules?.trackCheckoutStats === true && (match.rules?.checkOut || "double") === "double") ? true : null,
      checkoutDartsOnDouble: (match.rules && match.rules.checkOut === "double" && match.rules.trackCheckoutStats === true) ? dartsOnDouble : null,
    });

    leg.players[p].score = 0;
    leg.status = "finished";
    leg.winner = p;

    const s0 = calcLegStats(leg, 0);
    const s1 = calcLegStats(leg, 1);

    // Step E plumbing: summarize check-in/checkout tracking for this finished leg
    const rules = match.rules || {};
    const trackingOn = rules.trackCheckoutStats === true;
    const checkInRule = rules.checkIn || "straight";
    const checkOutRule = rules.checkOut || "double";

    const checkInDoublesThrown = [0, 0];
    const checkInDoublesHit = [0, 0];
    const checkoutOpp = [0, 0];
    const checkoutDoublesThrown = [0, 0];
    const checkoutDoublesHit = [0, 0];

    if (Array.isArray(leg.history)) {
      for (const h of leg.history) {
        const pIdx = h.player;
        if (pIdx !== 0 && pIdx !== 1) continue;

        // Double-in tracking: count darts thrown at doubles until check-in
        if (trackingOn && checkInRule === "double" && h.checkedInBefore === false) {
          if (h.checkInHit === true) {
            checkInDoublesHit[pIdx] += 1;
            checkInDoublesThrown[pIdx] += Number(h.checkInDartsUsed || 1);
          } else if (h.checkInHit === false) {
            // Missed check-in visit: treat as 3 darts missed unless a specific count is present
            checkInDoublesThrown[pIdx] += Number(h.checkInDartsUsed || 3);
          }
        }

        // Double-out tracking: opportunities + doubles thrown/hit at checkout
        if (trackingOn && checkOutRule === "double") {
          const isOpp = h.checkoutOpportunity === true || (h.checkout === true);
          if (isOpp) checkoutOpp[pIdx] += 1;

          if (h.attemptedCheckout === true) {
            checkoutDoublesThrown[pIdx] += Number(h.checkoutAttemptDartsOnDouble || 0);
          }
          if (h.checkout === true) {
            checkoutDoublesHit[pIdx] += 1;
            checkoutDoublesThrown[pIdx] += Number(h.checkoutDartsOnDouble || 0);
          }
        }
      }
    }

    // Attach tracking summaries to the leg summary objects (used for match-end stats)
    s0.checkInDoublesThrown = checkInDoublesThrown[0];
    s1.checkInDoublesThrown = checkInDoublesThrown[1];
    s0.checkInDoublesHit = checkInDoublesHit[0];
    s1.checkInDoublesHit = checkInDoublesHit[1];

    s0.checkoutOpp = checkoutOpp[0];
    s1.checkoutOpp = checkoutOpp[1];
    s0.checkoutDoublesThrown = checkoutDoublesThrown[0];
    s1.checkoutDoublesThrown = checkoutDoublesThrown[1];
    s0.checkoutDoublesHit = checkoutDoublesHit[0];
    s1.checkoutDoublesHit = checkoutDoublesHit[1];

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

    const winnerName = (match.players?.[p]?.name) || "";
    const winnerNameClip = nameClipForDisplayName(winnerName);

    if (match.status === "finished") {
      // Match finish announcement.
      // The shipped audio pack has the spoken content for GameShot/GameShotMatch
      // swapped, so reference GameShot.mp3 here.
      const isNemesisWinner = !!(state?.nemesis?.enabled) && p === 1;
      const clips = [isNemesisWinner ? "/audio/phrases/nemesis_matchend.mp3" : "/audio/phrases/GameShot.mp3"];
      if (!isNemesisWinner) {
        if (winnerNameClip) clips.push(winnerNameClip);
        clips.push("/audio/phrases/Congratulations.mp3");
      }
      setAudioEvent(state, clips);
    } else {
      // Leg finish announcement.
      // The shipped audio pack has the spoken content for GameShot/GameShotMatch
      // swapped, so reference GameShotMatch.mp3 here.
      const isNemesisWinner = !!(state?.nemesis?.enabled) && p === 1;
      const clips = [isNemesisWinner ? "/audio/phrases/nemesis_gameend.mp3" : "/audio/phrases/GameShotMatch.mp3"];
      if (!isNemesisWinner) {
        if (winnerNameClip) clips.push(winnerNameClip);
      }
      setAudioEvent(state, clips);
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
    state.leg = makeFreshLeg(match.mode, starter, match.rules);
    state.pendingCheckout = null;

    // Nemesis: play "game on" when Nemesis starts the leg.
    try {
      if (state?.nemesis?.enabled === true && state.leg?.currentPlayer === 1) {
        setAudioEvent(state, ["/audio/phrases/nemesis_gameon.mp3"]);
      }
    } catch (_) {}

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

    const bullActive = state?.match?.starting === "bull" && state?.match?.bull && !state.match.bull.finalized;
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
    const rebuilt = makeFreshLeg(match.mode, starter, match.rules);

    for (const h of leg.history) {
      const p = h.player;
      const before = rebuilt.players[p].score;
      const after = before - h.entered;

      if (isImpossibleCheckout(before, h.entered, state.match?.rules?.checkOut || "double")) continue;

      const bust = isBustScore(after, state.match?.rules?.checkOut || "double");
      rebuilt.history.push({
        player: p,
        entered: h.entered,
        bust,
        before,
        after: bust ? before : after,
        dartsUsed: 3,
        at: h.at || new Date(),

        checkedInBefore: h.checkedInBefore ?? rebuilt.players[p].checkedIn ?? true,
        checkedInAfter: h.checkedInAfter ?? rebuilt.players[p].checkedIn ?? true,
        checkInHit: h.checkInHit ?? null,
        checkInDartsUsed: h.checkInDartsUsed ?? null,
      });

      if (!bust) rebuilt.players[p].score = after;
      if (state.match?.rules?.checkIn === "double") {
        if (h.checkedInAfter !== undefined) rebuilt.players[p].checkedIn = h.checkedInAfter === true;
        else if (rebuilt.players[p].checkedIn === undefined) rebuilt.players[p].checkedIn = true;
      }
      rebuilt.currentPlayer = (rebuilt.currentPlayer + 1) % 2;
    }

    state.leg = rebuilt;
    state.updatedAt = new Date();
    tx.set(app.gameRef, state);
  });
}