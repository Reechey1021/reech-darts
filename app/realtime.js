// app/realtime.js
import { app } from "./state.js";
import { getDeviceId } from "./device.js";
import { render } from "./ui/render.js";
import { playClipsWebAudio } from "./audio/audio.js";

let lastAudioId = null;

export async function tryClaimSeat2(state) {
  if (app.seatClaimed) return;
  if (!state?.match) return;
  if (state.match.gameType !== "online") return;

  const exp = state.expiresAt?.toDate ? state.expiresAt.toDate() : state.expiresAt;
  if (exp && Date.now() > new Date(exp).getTime()) return;

  const d = getDeviceId();
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
      const state = doc.data();
      app.latestState = state;

      render(state);
      tryClaimSeat2(state);

      if (state?.audio?.id && state.audio.id !== lastAudioId) {
        lastAudioId = state.audio.id;
        playClipsWebAudio(state.audio.clips);
      }
    },
    (err) => {
      console.error(err);
      const statusEl = document.getElementById("status");
      if (statusEl) statusEl.innerText = "Firestore error: " + err.message;
    }
  );
}
