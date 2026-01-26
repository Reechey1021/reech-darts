// app/bull/ui.js
import { app } from "../state.js";
import { mySeatIndex } from "../permissions.js";
import { tryResolveBull, initBullState, finalizeBull } from "./core.js";

export function renderBullMarker(pick, { cls = "" } = {}) {
  const bullBoard = document.getElementById("bullBoard");
  if (!bullBoard) return;

  if (!pick) return;

  const m = document.createElement("div");
  m.className = `bullMarker ${cls}`.trim();
  m.style.left = `${pick.x * 100}%`;
  m.style.top = `${pick.y * 100}%`;
  bullBoard.appendChild(m);
}

export function renderBullMarkersFromState(state, mySeat = null) {
  const bullBoard = document.getElementById("bullBoard");
  if (!bullBoard) return;

  bullBoard.querySelectorAll(".bullMarker").forEach((n) => n.remove());

  const bull = state?.match?.bull;
  if (!bull) return;

  const resolved = !!bull.resolved;
  if (!resolved) {
    // During online bull throws, only show MY confirmed marker to avoid misleading the other player.
    // Local games can show both markers on the same device.
    const isOnline = state?.match?.gameType === "online";

    if (!isOnline) {
      if (bull.p1) renderBullMarker(bull.p1, { cls: "p1" });
      if (bull.p2) renderBullMarker(bull.p2, { cls: "p2" });
      return;
    }

    if (mySeat === 0 && bull.p1) renderBullMarker(bull.p1, { cls: "me" });
    if (mySeat === 1 && bull.p2) renderBullMarker(bull.p2, { cls: "me" });
    return;
  }

  // After resolution: each client sees THEIR marker as green ("me") and the other as red ("them")
  const me = mySeat;
  if (bull.p1) renderBullMarker(bull.p1, { cls: me === 0 ? "me" : "them" });
  if (bull.p2) renderBullMarker(bull.p2, { cls: me === 1 ? "me" : "them" });
}

export function initBullUIHandlers() {
  const bullBoard = document.getElementById("bullBoard");
  const bullConfirmBtn = document.getElementById("bullConfirmBtn");
  const bullResetBtn = document.getElementById("bullResetBtn");
  const bullStartBtn = document.getElementById("bullStartBtn");
  const bullRethrowBtn = document.getElementById("bullRethrowBtn");

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

      // Show confirmed markers (both players) + my pending pick
      try { renderBullMarkersFromState(st, mySeatIndex(st)); } catch (_) {}
      bullBoard.querySelectorAll(".bullMarker.pending").forEach((n) => n.remove());
      renderBullMarker(clamped, { cls: "pending" });

      if (bullConfirmBtn) bullConfirmBtn.disabled = false;
    });
  }

  if (bullResetBtn) {
    bullResetBtn.addEventListener("click", () => {
      window.__bullPick = null;
      try { renderBullMarkersFromState(app.latestState, mySeatIndex(app.latestState)); } catch (_) {
        const bullBoard = document.getElementById("bullBoard");
        bullBoard?.querySelectorAll?.(".bullMarker")?.forEach?.((n) => n.remove());
      }
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
      const bullBoard = document.getElementById("bullBoard");
      if (bullBoard) bullBoard.querySelectorAll(".bullMarker.pending").forEach((n) => n.remove());
      bullConfirmBtn.disabled = true;
    });
  }

  // Result screen: Start game (finalize bull)
  if (bullStartBtn) {
    bullStartBtn.addEventListener("click", async () => {
      const { db, gameRef } = app;
      if (!db || !gameRef) return;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(gameRef);
        const state = snap.data();
        if (!state?.match?.bull) return;
        if (state.match.starting !== "bull") return;

        const bull = state.match.bull;
        if (!bull.resolved) return;

        finalizeBull(state);
        state.updatedAt = new Date();
        tx.set(gameRef, state);
      });
    });
  }

  // Result screen: Rethrow (reset bull state)
  if (bullRethrowBtn) {
    bullRethrowBtn.addEventListener("click", async () => {
      const { db, gameRef } = app;
      if (!db || !gameRef) return;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(gameRef);
        const state = snap.data();
        if (!state?.match) return;
        if (state.match.starting !== "bull") return;

        state.match.bull = initBullState();
        state.match.starterLeg1 = 0;
        if (state.leg) state.leg.currentPlayer = 0;

        state.updatedAt = new Date();
        tx.set(gameRef, state);
      });

      // Immediately reset bull UI panels
      const bullResultPanel = document.getElementById("bullResultPanel");
      if (bullResultPanel) bullResultPanel.classList.add("hidden");
      const bullResetBtnEl = document.getElementById("bullResetBtn");
      const controlsRow = bullResetBtnEl ? bullResetBtnEl.closest(".row") : null;
      if (controlsRow) controlsRow.classList.remove("hidden");

      // local UI reset
      window.__bullPick = null;
      const bullBoard = document.getElementById("bullBoard");
      if (bullBoard) bullBoard.querySelectorAll(".bullMarker").forEach((n) => n.remove());
      if (bullConfirmBtn) bullConfirmBtn.disabled = true;
    });
  }
}

export { initBullUIHandlers as initBullUI };
