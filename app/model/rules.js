// app/model/rules.js
import { CHECKOUTS } from "../../checkouts.js";
import { BOGEY_NUMBERS } from "./constants.js";

// Hard reject: certain finishes are impossible in standard double-out rules
export function isImpossibleCheckout(remainingBeforeThrow, enteredScore) {
  const after = remainingBeforeThrow - enteredScore;
  if (after !== 0) return false;

  if (remainingBeforeThrow > 170) return true;
  if (remainingBeforeThrow >= 171 && remainingBeforeThrow <= 180) return true;
  if (BOGEY_NUMBERS.has(remainingBeforeThrow)) return true;

  return false;
}

export function isBustScore(newScore) {
  return newScore < 0 || newScore === 1;
}

export function checkoutSuggestion(remaining) {
  if (typeof remaining !== "number") return null;
  if (remaining > 170) return null;
  if (remaining >= 171 && remaining <= 180) return null;
  if (BOGEY_NUMBERS.has(remaining)) return null;
  if (remaining <= 1) return null;
  return CHECKOUTS[remaining] || null;
}

export function minDartsForCheckout(remaining) {
  const s = CHECKOUTS[remaining];
  if (!s) return 1;
  const tokens = String(s).trim().split(/\s+/).filter(Boolean);
  return Math.min(Math.max(tokens.length, 1), 3);
}

// Whether someone is "on a possible checkout" (used for require audio)
export function isPossibleCheckout(remaining) {
  const r = Number(remaining);
  if (!Number.isFinite(r)) return false;
  if (r <= 1) return false;
  if (r > 170) return false;
  if (r >= 171 && r <= 180) return false;
  if (BOGEY_NUMBERS.has(r)) return false;
  return Boolean(CHECKOUTS[r]);
}
