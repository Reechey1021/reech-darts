// app/model/rules.js
import { CHECKOUTS } from "../../checkouts.js";
import { BOGEY_NUMBERS } from "./constants.js";

// Hard reject: certain finishes are impossible in standard double-out rules
export function isImpossibleCheckout(remainingBeforeThrow, enteredScore, checkOutRule = "double") {
  const after = remainingBeforeThrow - enteredScore;
  if (after !== 0) return false;

  const r = Number(remainingBeforeThrow);
  if (!Number.isFinite(r)) return true;

  // Straight-out: allow checkouts up to 180 (bogeys still blocked)
  if (checkOutRule === "straight") {
    if (r > 180) return true;
    if (BOGEY_NUMBERS.has(r)) return true;
    return false;
  }

  // Double-out (legacy V3 behavior): only allow standard checkout table up to 170 (bogeys blocked)
  if (r > 170) return true;
  if (r >= 171 && r <= 180) return true;
  if (BOGEY_NUMBERS.has(r)) return true;

  return false;
}

export function isBustScore(newScore, checkOutRule = "double") {
  // In double-out, leaving 1 remaining is a bust because you cannot finish.
  // In straight-out, 1 remaining is allowed.
  if (newScore < 0) return true;
  if (checkOutRule === "double" && newScore === 1) return true;
  return false;
}

export function checkoutSuggestion(remaining) {
  if (typeof remaining !== "number") return null;
  if (remaining > 170) return null;
  if (remaining >= 171 && remaining <= 180) return null;
  if (BOGEY_NUMBERS.has(remaining)) return null;
  if (remaining <= 1) return null;
  return CHECKOUTS[remaining] || null;
}

export function minDartsForCheckout(remaining, checkOutRule = "double") {
  const r = Number(remaining);
  if (!Number.isFinite(r)) return 3;

  // Straight-out: 1 dart up to 60, 2 darts up to 120, otherwise confirm-only (3)
  if (checkOutRule === "straight") {
    if (r <= 60) return 1;
    if (r <= 120) return 2;
    return 3;
  }

  // Double-out: based on checkout suggestion tokens (legacy behavior)
  const s = checkoutSuggestion(r);
  if (!s) return 1;
  const tokens = String(s).trim().split(/\s+/).filter(Boolean);
  return Math.min(Math.max(tokens.length, 1), 3);
}

// Whether someone is "on a possible checkout" (used for require audio)
// Whether someone is "on a possible checkout" (used for require audio / quick checkout UI)
// Double-out uses the checkout table (<=170). Straight-out allows up to 180 (bogeys still blocked).
export function isPossibleCheckout(remaining, checkOutRule = "double") {
  const r = Number(remaining);
  if (!Number.isFinite(r)) return false;

  // We treat "0" as already checked out; this helper is for "can you finish from here?"
  if (r <= 0) return false;

  const n = Math.trunc(r);

  if (checkOutRule === "straight") {
    // In straight-out, 1 is a valid remaining score, and finishes are possible up to 180.
    if (n > 180) return false;
    if (BOGEY_NUMBERS.has(n)) return false;
    // Any non-bogey integer <= 180 is achievable in 3 darts.
    return true;
  }

  // Double-out (legacy): only allow standard checkout table up to 170 (bogeys blocked)
  if (n <= 1) return false;
  if (n > 170) return false;
  if (n >= 169 && BOGEY_NUMBERS.has(n)) return false;

  return !!CHECKOUTS[n];
}

