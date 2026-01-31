// app/bull/ui.js
import { app } from "../state.js";
import { mySeatIndex } from "../permissions.js";
import { tryResolveBull, initBullState, finalizeBull, makeNemesisBullPick } from "./core.js";

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
    const isNemesis = !!state?.nemesis?.enabled;

    const isOnlineOrNemesis = isOnline || isNemesis;

    // Nemesis behaves like online: you don't see the other throw until it lands.
    if (!isOnlineOrNemesis) {
      if (bull.p1) renderBullMarker(bull.p1, { cls: "p1" });
      if (bull.p2) renderBullMarker(bull.p2, { cls: "p2" });
      return;
    }

    const seat = (mySeat === null && isNemesis) ? 0 : mySeat;
    if (seat === 0 && bull.p1) renderBullMarker(bull.p1, { cls: "me" });
    if (seat === 1 && bull.p2) renderBullMarker(bull.p2, { cls: "me" });
    return;
  }

  // After resolution: each client sees THEIR marker as green ("me") and the other as red ("them")
  const isNemesis = !!state?.nemesis?.enabled;
  const me = (mySeat === null && isNemesis) ? 0 : mySeat;
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
  window.__bullNemesisPending = false;
  window.__bullNemesisLock = false;

  if (bullBoard) {
    bullBoard.addEventListener("click", (e) => {
      const st = app.latestState;
      if (window.__bullNemesisLock || window.__bullNemesisPending) return;
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

      let autoNemesis = false;

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(gameRef);
        const state = snap.data();
        if (!state?.match?.bull) return;
        if (state.match.starting !== "bull") return;

        const bull = state.match.bull;
        if (bull.resolved) return;

        const neededPlayer = bull.p1 ? 1 : 0;

        const isNemesis = !!state?.nemesis?.enabled;
        // In Nemesis games, seat 0 is always the human and seat 1 is Nemesis.
        // After the human confirms their throw (p1), auto-trigger Nemesis throw (p2).
        if (isNemesis && neededPlayer === 0) autoNemesis = true;

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

      // Clear local pending pick UI.
      window.__bullPick = null;
      const bullBoardEl = document.getElementById("bullBoard");
      if (bullBoardEl) bullBoardEl.querySelectorAll(".bullMarker.pending").forEach((n) => n.remove());
      bullConfirmBtn.disabled = true;

      // Nemesis bull throw: after Player 1 confirms, auto-generate seat 2 throw (online-style).
      if (autoNemesis) {
        const bullWaiting = document.getElementById("bullWaiting");
        if (bullWaiting) {
          bullWaiting.textContent = "Nemesis is throwing for bull…";
          bullWaiting.classList.remove("hidden");
        }

        window.__bullNemesisPending = true;
        window.__bullNemesisLock = true;

        if (bullBoardEl) bullBoardEl.classList.add("isLocked");
        if (bullResetBtn) bullResetBtn.disabled = true;
        if (bullConfirmBtn) bullConfirmBtn.disabled = true;

        setTimeout(async () => {
          try {
            await db.runTransaction(async (tx2) => {
              const snap2 = await tx2.get(gameRef);
              const st2 = snap2.data();
              if (!st2?.match?.bull) return;
              if (st2.match.starting !== "bull") return;
              if (!st2?.nemesis?.enabled) return;

              const bull2 = st2.match.bull;
              if (bull2.resolved) return;
              if (!bull2.p1 || bull2.p2) return;

              bull2.p2 = makeNemesisBullPick(st2);
              tryResolveBull(st2);

              st2.updatedAt = new Date();
              tx2.set(gameRef, st2);
            });
          } catch (err) {
            console.warn("[bull] Nemesis bull throw failed", err);
          } finally {
            const bullWaiting2 = document.getElementById("bullWaiting");
            if (bullWaiting2) bullWaiting2.classList.add("hidden");

            window.__bullNemesisLock = false;
            window.__bullNemesisPending = false;

            const bb = document.getElementById("bullBoard");
            if (bb) bb.classList.remove("isLocked");

            if (bullResetBtn) bullResetBtn.disabled = false;
            if (bullConfirmBtn) bullConfirmBtn.disabled = true;
          }
        }, 900);
      }
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