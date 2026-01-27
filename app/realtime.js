// app/realtime.js
import { app } from "./state.js";
import { getActorId, getActorName } from "./auth.js";
import { render, setLobbyGateVisible, setSetupModalVisible, showSeatJoinToast, showSeatLeaveToast, setNameRowDanger, showHostLeftModal } from "./ui/render.js";
import { updateAuditFromState, renderAuditChat } from "./ui/auditChat.js";
// app/ui/auditChat is lightweight; audits are derived from state deltas.
import { playClipsWebAudio, stopAllAudio } from "./audio/audio.js";
import { applyFinishedMatchProfileUpdatesForMe } from "./userStats.js";
import { nudgeVoiceAfterGameActivity } from "./input/voice.js";

// Call this whenever we move to a different game document.
// Prevents stale audio IDs + seat-claim state leaking across lobbies.
export function resetRealtimeStateForGameSwitch() {
  app.seatClaimed = false;
  app.lastAudioId = null;
  stopAllAudio();
}

let lastAudioId = null;
let lastSeat2Present = false;
let lastSeat1Present = false;
let lastSeat2Name = null;
let lastSeat1Name = null;
let lastLobbyStatus = null;

export async function tryClaimSeat2(state) {
  if (app.seatClaimed) return;
  if (!state) return;

  const exp = state.expiresAt?.toDate ? state.expiresAt.toDate() : state.expiresAt;
  if (exp && Date.now() > new Date(exp).getTime()) return;

  const d = getActorId();
  if (!d) return;

  // -------- Lobby: claim seat2 BEFORE a match exists --------
  if (state.status === "lobby" && !state.match) {
    const hostId = state.seat1Id || state?.lobby?.host?.actorId;
    if (!hostId) return;
    if (hostId === d) return;
    if (state.seat2Id) return;

    app.seatClaimed = true;

    try {
      await app.db.runTransaction(async (tx) => {
        const snap = await tx.get(app.gameRef);
        const fresh = snap.data();
        if (!fresh) return;
        if (fresh.status !== "lobby") return;
        if (fresh.match) return;
        if (!fresh.seat1Id) return;
        if (fresh.seat1Id === d) return;
        if (fresh.seat2Id) return;

        const name = getActorName();
        fresh.seat2Id = d;
        fresh.seat2Name = name;
        fresh.seat2PhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;
        fresh.lobby = fresh.lobby || {};
        fresh.lobby.joiner = {
          actorId: d,
          name,
          uid: (app.user && !app.user.isAnonymous) ? app.user.uid : null,
          photoURL: fresh.seat2PhotoURL,
        };
        fresh.updatedAt = new Date();
        tx.set(app.gameRef, fresh);
      });
    } catch {
      app.seatClaimed = false;
    }

    return;
  }

  // -------- In-match (online) seat claim --------
  if (!state.match) return;
  if (state.match.gameType !== "online") return;
  if (!state.match.seat1Id) return;
  if (state.match.seat1Id === d) return;
  if (state.match.seat2Id) return;

  app.seatClaimed = true;

  try {
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(app.gameRef);
      const fresh = snap.data();
      if (!fresh?.match) return;
      if (fresh.match.gameType !== "online") return;
      if (fresh.match.seat2Id) return;
      if (fresh.match.seat1Id === d) return;

      fresh.match.seat2Id = d;

      // Identity (for in-game profile popups)
      fresh.match.seat2Uid = (app.user && !app.user.isAnonymous) ? app.user.uid : null;
      fresh.match.seat2Name = getActorName();
      fresh.match.seat2PhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;

      // Keep players array in sync if present
      if (Array.isArray(fresh.match.players) && fresh.match.players[1]) {
        fresh.match.players[1].uid = fresh.match.seat2Uid;
        fresh.match.players[1].name = fresh.match.seat2Name;
        fresh.match.players[1].photoURL = fresh.match.seat2PhotoURL;
      }

      fresh.updatedAt = new Date();
      tx.set(app.gameRef, fresh);
    });
  } catch {
    app.seatClaimed = false;
  }
}


export function bindGameListener() {
  if (typeof app.unsubscribeGame === "function") {
    app.unsubscribeGame();
    app.unsubscribeGame = null;
  }
  if (!app.gameRef) return;

  app.unsubscribeGame = app.gameRef.onSnapshot(
    (doc) => {
      // Missing doc (deleted link / bad URL) => show gate
      if (!doc.exists) {
        app.latestState = null;
        render(null);
        setLobbyGateVisible(true);
        return;
      }

      const state = doc.data();
      const prev = app.latestState;
      try { updateAuditFromState(state, prev); } catch (e) { console.log("[audit] update failed", e); }
      app.latestState = state;

      // Keep Chrome/Edge Web Speech sessions alive in voice mode by nudging after score/turn changes.
      try { nudgeVoiceAfterGameActivity(prev, state); } catch (_) {}

      // Detect seat2 being filled (online only) and show a lightweight toast.
      // No extra reads/writes: we already have the game snapshot.
      try {
        const lobbyType = state?.lobbyType || state?.match?.gameType;
        const isOnline = lobbyType === "online";
        const seat1IdNow = state?.match?.seat1Id || state?.seat1Id || null;
        const seat1NameNow = state?.match?.seat1Name || state?.seat1Name || "Player 1";
        const seat2IdNow = state?.match?.seat2Id || state?.seat2Id || null;
        const seat2NameNow = state?.match?.seat2Name || state?.seat2Name || "Player 2";

        const seat1NowPresent = !!seat1IdNow;
        const seat2NowPresent = !!seat2IdNow;

        // Joined / left toasts + red highlight on the name row for the player who left
        if (isOnline) {
          if (!lastSeat2Present && seat2NowPresent) {
            showSeatJoinToast(`${seat2NameNow} has joined the game`);
            setNameRowDanger(1, false);
          } else if (lastSeat2Present && !seat2NowPresent) {
            const leftName = lastSeat2Name || seat2NameNow;
            showSeatLeaveToast(`${leftName} has left the game`);
            setNameRowDanger(1, true);
          }

          if (lastSeat1Present && !seat1NowPresent) {
            const leftName = lastSeat1Name || seat1NameNow;
            showSeatLeaveToast(`${leftName} has left the game`);
            setNameRowDanger(0, true);

            // If I'm currently in seat 2 and the host leaves, force a clear UX action (leave lobby/match).
            try {
              const me = getActorId();
              if (me && seat2IdNow && me === seat2IdNow) {
                showHostLeftModal(leftName);
              }
            } catch (_) {}
          } else if (!lastSeat1Present && seat1NowPresent) {
            setNameRowDanger(0, false);
          }
        }

        // If the lobby was explicitly closed (eg host left), also mark it as a leave state.
        const statusNow = state?.status || null;
        if (isOnline && lastLobbyStatus && lastLobbyStatus !== "closed" && statusNow === "closed") {
          showSeatLeaveToast("Invite expired (host left)");
        }
        lastLobbyStatus = statusNow;

        // Persist last-known names so leave toasts can show the correct player name
        if (seat1NowPresent) lastSeat1Name = seat1NameNow;
        if (seat2NowPresent) lastSeat2Name = seat2NameNow;

        lastSeat1Present = seat1NowPresent;
        lastSeat2Present = seat2NowPresent;
      } catch (_) {
        // non-fatal
      }

      // Expired lobbies should fall back to the gate (prevents “stuck connecting”)
      const exp = state?.expiresAt?.toDate ? state.expiresAt.toDate() : state?.expiresAt;
      const isExpired = exp && Date.now() > new Date(exp).getTime();
      if (state?.status === "lobby" && isExpired) {
        render(null);
        setLobbyGateVisible(true);
        return;
      }

      render(state);
      try { renderAuditChat(state); } catch (e) {}

      // Profile stats (signed-in users only): apply once when the client observes
      // match.status === "finished". Each client only writes its own /users/{uid}
      // doc (required by Firestore rules).
      try {
        const uid = app.user && !app.user.isAnonymous ? app.user.uid : null;
        if (uid && state?.match?.status === "finished") {
          applyFinishedMatchProfileUpdatesForMe(app.db, uid, app.gameRef?.id || app.gameId, state.match);
        }
      } catch (e) {
        console.warn("applyFinishedMatchProfileUpdatesForMe failed (non-fatal)", e);
      }

      // If we arrived from the dashboard for a local game, auto-open setup.
      maybeAutoOpenSetup(state);

      tryClaimSeat2(state);

      // Firestore-synced audio: every device plays the same event once
      if (state?.audio?.id && state.audio.id !== app.lastAudioId) {
        app.lastAudioId = state.audio.id;
        playClipsWebAudio(state.audio.clips);
      }
    },
    (err) => {
      console.warn("bindGameListener snapshot error", err);
      render(null);
      setLobbyGateVisible(true);
    }
  );
}

function maybeAutoOpenSetup(state) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get("setup") !== "1") return;
    if (!state || state.status !== "lobby") return;
    if (state.match) return;

    const lobbyType = state.lobbyType || "local";
    const isOnline = lobbyType === "online";

    const localFields = document.getElementById("setupLocalNameFields");
    const onlineOpts = document.getElementById("setupOnlineOptions");
    const mutualRow = document.getElementById("setupMutualRow");

    if (localFields) localFields.classList.toggle("hidden", isOnline);
    if (onlineOpts) onlineOpts.classList.toggle("hidden", !isOnline);
    if (mutualRow) mutualRow.classList.toggle("hidden", !isOnline);

    setSetupModalVisible(true);

    const url = new URL(window.location.href);
    url.searchParams.delete("setup");
    window.history.replaceState({}, "", url.toString());
  } catch (e) {
    // non-fatal
    console.warn("maybeAutoOpenSetup failed", e);
  }
}