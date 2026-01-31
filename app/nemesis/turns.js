// /app/nemesis/turns.js
import { app } from "../state.js";
import { simulateNemesisVisit } from "./engine.js";
import { IMPOSSIBLE_TURN_SCORES } from "../model/constants.js";
import { submitNemesisScore } from "../actions.js";


function sanitizeNemesisScore(score) {
  let s = Number(score);
  if (!Number.isFinite(s)) return 0;
  s = Math.max(0, Math.min(180, Math.round(s)));
  // Avoid impossible totals (prevents submitNemesisScore early-return causing a stuck Nemesis turn)
  if (IMPOSSIBLE_TURN_SCORES && IMPOSSIBLE_TURN_SCORES.has(s)) {
    for (let d = 1; d <= 5; d++) {
      if (!IMPOSSIBLE_TURN_SCORES.has(s - d) && (s - d) >= 0) return s - d;
      if (!IMPOSSIBLE_TURN_SCORES.has(s + d) && (s + d) <= 180) return s + d;
    }
    return 0;
  }
  return s;
}

function clampInt(n, lo, hi) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function randBetween(a, b) {
  return a + Math.random() * (b - a);
}

function currentNemesisKey(state) {
  const hLen = Array.isArray(state?.leg?.history) ? state.leg.history.length : 0;
  const p = state?.leg?.currentPlayer ?? -1;
  const s = state?.leg?.players?.[1]?.score ?? "x";
  const pc = state?.pendingCheckout ? 1 : 0;
  const ls = state?.leg?.status || "";
  const ms = state?.match?.status || "";
  return `${hLen}|${p}|${s}|${pc}|${ls}|${ms}`;
}



function computeLastPlayerVisitScore(state) {
  try {
    const hist = state?.leg?.history || [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i];
      if (h && h.player === 0 && typeof h.entered === "number") return h.entered;
    }
    return 0;
  } catch (_) { return 0; }
}

// Note: Nemesis v2 plans each leg up front (target within range per leg),
// so we no longer use the old match-average governor rubber-banding.

function computeDelayMs(state) {
  const c = clampInt(state?.nemesis?.sliders?.consistency ?? 5, 1, 10);
  // Base delay feels like "throwing", not thinking.
  // Lower consistency => slightly more delay variance.
  // Keep this deliberately slower so it feels like 3 darts were thrown.
  // (User feedback: previous delay felt too quick.)
  const base = randBetween(1800, 3200);
  const extra = randBetween(0, (11 - c) * 120);
  return Math.floor(base + extra);
}


function chooseCheckoutDartsUsed(state) {
  const chk = clampInt(state?.nemesis?.sliders?.checkout ?? 5, 1, 10);
  // Higher checkout => more 1-2 dart finishes
  const r = Math.random();
  if (chk >= 9) return r < 0.55 ? 1 : 2;
  if (chk >= 7) return r < 0.35 ? 1 : (r < 0.80 ? 2 : 3);
  if (chk >= 4) return r < 0.15 ? 1 : (r < 0.55 ? 2 : 3);
  return r < 0.08 ? 2 : 3;
}

export function resetNemesisTurnScheduler() {
  if (app.nemesisTurnTimer) {
    clearTimeout(app.nemesisTurnTimer);
    app.nemesisTurnTimer = null;
  }
  app.nemesisPlannedKey = null;
}

export function maybeHandleNemesisTurn(state) {
  try {
    if (state?.nemesis?.enabled !== true) {
      resetNemesisTurnScheduler();
      return;
    }
    if (!state?.match || !state?.leg) return;
    if (state.match.status !== "in_progress") {
      resetNemesisTurnScheduler();
      return;
    }
    if (state.leg.status !== "in_progress") {
      resetNemesisTurnScheduler();
      return;
    }
    if (state.pendingCheckout) {
      // If Nemesis is waiting on a checkout confirmation, auto-confirm.
      const pc = state.pendingCheckout;
      if (pc && pc.player === 1) {
        // Confirm with a small realistic delay
        const d = chooseCheckoutDartsUsed(state);
        setTimeout(() => confirmCheckout(d, null), randBetween(250, 550));
      }
      resetNemesisTurnScheduler();
      return;

    // Bull-throw lock: don't let Nemesis act until the bull throw is finalized (Start Game pressed).
    if (state.match?.starting === "bull" && state.match?.bull && !state.match.bull.finalized) {
      resetNemesisTurnScheduler();
      return;
    }

    }

    // Only act on Nemesis' turn (seat 2 => index 1)
    if (state.leg.currentPlayer !== 1) {
      resetNemesisTurnScheduler();
      return;
    }

    const key = currentNemesisKey(state);
    if (app.nemesisPlannedKey === key && app.nemesisTurnTimer) return;

    // Schedule a visit
    resetNemesisTurnScheduler();
    app.nemesisPlannedKey = key;

    const delay = computeDelayMs(state);
    app.nemesisTurnTimer = setTimeout(async () => {
      try {
        const latest = app.latestState;
        if (!latest || latest?.nemesis?.enabled !== true) return;
        if (latest?.pendingCheckout) return;
        if (!latest?.leg || latest.leg.status !== "in_progress") return;
        // Bull-throw lock (Nemesis games behave like online): wait until Start Game.
        if (latest.match?.starting === "bull" && latest.match?.bull && !latest.match.bull.finalized) return;
        if (latest.leg.currentPlayer !== 1) return;

        // Ensure we haven't advanced since scheduling
        if (currentNemesisKey(latest) !== key) return;

        const remaining = Number(latest?.leg?.players?.[1]?.score ?? 501);
        const playerRemaining = Number(latest?.leg?.players?.[0]?.score ?? 501);
        const r = simulateNemesisVisit({ state: latest, remaining, playerRemaining });
        const safeScore = sanitizeNemesisScore(r.score);
        await submitNemesisScore(safeScore, r.dartsUsed, { nemesis: true, checkoutHit: r.checkoutHit, attemptedCheckout: r.attemptedCheckout, checkoutAttemptDartsOnDouble: r.checkoutAttemptDartsOnDouble, checkoutDartsOnDouble: r.checkoutDartsOnDouble, thought: r.thought });

        // Nemesis checkouts are resolved transactionally (no prompt).
        const after = app.latestState;
        if (after?.pendingCheckout && after.pendingCheckout.player === 1) {
          const d = chooseCheckoutDartsUsed(after);
          setTimeout(() => confirmCheckout(d, null), randBetween(250, 550));
        }
      } catch (e) {
        console.warn("[nemesis] turn failed (non-fatal)", e);
      } finally {
        // Important: clear the timer handle after it fires.
        // If a submit is rejected (e.g. impossible score), the game state key may not
        // change, and a stale truthy handle can block re-scheduling.
        app.nemesisTurnTimer = null;
        app.nemesisPlannedKey = null;
      }
    }, delay);
  } catch (e) {
    console.warn("[nemesis] maybeHandleNemesisTurn failed (non-fatal)", e);
  }
}