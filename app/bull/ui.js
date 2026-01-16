// app/bull/ui.js
import { app } from "../state.js";
import { mySeatIndex } from "../permissions.js";
import { tryResolveBull } from "./core.js";

export function renderBullMarker(pick) {
  const bullBoard = document.getElementById("bullBoard");
  if (!bullBoard) return;

  bullBoard.querySelectorAll(".bullMarker").forEach((n) => n.remove());
  if (!pick) return;

  const m = document.createElement("div");
  m.className = "bullMarker";
  m.style.left = `${pick.x * 100}%`;
  m.style.top = `${pick.y * 100}%`;
  bullBoard.appendChild(m);
}

export function initBullUIHandlers() {
  const bullBoard = document.getElementById("bullBoard");
  const bullConfirmBtn = document.getElementById("bullConfirmBtn");
  const bullResetBtn = document.getElementById("bullResetBtn");

  window.__bullPick = null;

  if (bullBoard) {
    bullBoard.addEventListener("click", (e) => {
      const st = app.latestState;
      if (!st?.match?.bull || st.match.bull.resolved) return;
      if (st.match.starting !== "bull") return;

      const bull = st.match.bull;
      const neededPlayer = bull.p1 ? 1 : 0;

      if (st.match.gameType === "online") {
        const seat = mySeatIndex(st);
        if (seat === null || seat !== neededPlayer) return;
      }

      const rect = bullBoard.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;

      const clamped = {
        x: Math.min(1, Math.max(0, x)),
        y: Math.min(1, Math.max(0, y)),
      };

      window.__bullPick = clamped;
      renderBullMarker(clamped);
      if (bullConfirmBtn) bullConfirmBtn.disabled = false;
    });
  }

  if (bullResetBtn) {
    bullResetBtn.addEventListener("click", () => {
      window.__bullPick = null;
      renderBullMarker(null);
      if (bullConfirmBtn) bullConfirmBtn.disabled = true;
    });
  }

  if (bullConfirmBtn) {
    bullConfirmBtn.addEventListener("click", async () => {
      const pick = window.__bullPick;
      if (!pick) return;

      const { db, gameRef } = app;
      if (!db || !gameRef) return;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(gameRef);
        const state = snap.data();
        if (!state?.match?.bull) return;
        if (state.match.starting !== "bull") return;

        const bull = state.match.bull;
        if (bull.resolved) return;

        const neededPlayer = bull.p1 ? 1 : 0;

        if (state.match.gameType === "online") {
          const seat = mySeatIndex(state);
          if (seat === null || seat !== neededPlayer) return;
        }

        if (neededPlayer === 0) bull.p1 = pick;
        if (neededPlayer === 1) bull.p2 = pick;

        tryResolveBull(state);

        state.updatedAt = new Date();
        tx.set(gameRef, state);
      });

      window.__bullPick = null;
      renderBullMarker(null);
      bullConfirmBtn.disabled = true;
    });
  }
}

export { initBullUIHandlers as initBullUI };