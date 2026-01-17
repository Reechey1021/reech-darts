// app/realtime.js
import { app } from "./state.js";
import { getActorId } from "./auth.js";
import { render, setLobbyGateVisible } from "./ui/render.js";
import { playClipsWebAudio, stopAllAudio } from "./audio/audio.js";
import { getEffectiveDisplayName } from "./profile.js";

// Call this whenever we move to a different game document.
// Prevents stale audio IDs + seat-claim state leaking across lobbies.
export function resetRealtimeStateForGameSwitch() {
  app.seatClaimed = false;
  app.lastAudioId = null;
  stopAllAudio();
}

let lastAudioId = null;

export async function tryClaimSeat2(state) {
  if (app.seatClaimed) return;
  if (!state) return;

  const exp = state.expiresAt?.toDate ? state.expiresAt.toDate() : state.expiresAt;
  if (exp && Date.now() > new Date(exp).getTime()) return;

  const d = getActorId();
  if (!d) return;

  // -------- Lobby: claim seat2 BEFORE a match exists --------
  if (state.status === "lobby" && !state.match) {
    if (!state.seat1Id) return;
    if (state.seat1Id === d) return;
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

        const name = getEffectiveDisplayName(app.user);
        fresh.seat2Id = d;
        fresh.seat2Name = name;
        fresh.lobby = fresh.lobby || {};
        fresh.lobby.joiner = {
          actorId: d,
          name,
          uid: app.user && !app.user.isAnonymous ? app.user.uid : null,
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

      // Best-effort identity (for profile popups later)
      fresh.match.seat2Uid = d;
      fresh.match.seat2Name = getEffectiveDisplayName(app.user);

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
  app.latestState = state;

  // Expired lobbies should fall back to the gate (prevents “stuck connecting”)
  const exp = state?.expiresAt?.toDate ? state.expiresAt.toDate() : state?.expiresAt;
  const isExpired = exp && Date.now() > new Date(exp).getTime();
  if (state?.status === "lobby" && isExpired) {
    render(null);
    setLobbyGateVisible(true);
    return;
  }

  render(state);
  tryClaimSeat2(state);

  // Firestore-synced audio: every device plays the same event once
  if (state?.audio?.id && state.audio.id !== app.lastAudioId) {
    app.lastAudioId = state.audio.id;
    playClipsWebAudio(state.audio.clips);
  }
}
,
    (err) => {
      console.error(err);
      const statusEl = document.getElementById("status");
      if (statusEl) statusEl.innerText = "Firestore error: " + err.message;
    }
  );
}
