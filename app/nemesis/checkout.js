// app/nemesis/checkout.js
// Checkout routing + dart-level outcome simulation.

import { CHECKOUTS } from "../../checkouts.js";
import { rngInt, rngPick, rngWeightedPick } from "./rng.js";

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function clampInt(n, lo, hi) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function roll(rng, p) {
  return rng() < p;
}

function parseToken(tok) {
  const t = String(tok || "").trim().toUpperCase();
  if (t === "BULL") return { ring: "BULL", n: 50 };
  if (t.startsWith("T")) return { ring: "T", n: clampInt(t.slice(1), 1, 20) };
  if (t.startsWith("D")) return { ring: "D", n: clampInt(t.slice(1), 1, 20) };
  // plain number => single
  const n = clampInt(t, 1, 20);
  return { ring: "S", n };
}

function tokenScore(token) {
  if (token.ring === "BULL") return 50;
  if (token.ring === "T") return token.n * 3;
  if (token.ring === "D") return token.n * 2;
  return token.n;
}

function preferredDoubleWeight(preferredDoubles, token) {
  if (token.ring !== "D") return 1;
  const name = `D${token.n}`;
  const idx = preferredDoubles.indexOf(name);
  if (idx < 0) return 1;
  return 1.8 - idx * 0.25;
}

export function chooseCheckoutRoute(remaining, prefs, rng) {
  const rem = Number(remaining) || 0;
  if (rem < 2) return null;

  const line = CHECKOUTS[rem];
  if (!line) return null;

  const toks = String(line).split(/\s+/).filter(Boolean);
  const parsed = toks.map(parseToken);

  // If last dart is a double, we can bias toward preferred doubles when multiple routes exist.
  // Our CHECKOUTS table provides a single route; we still keep a "route weight" hook here
  // so you can add alternate routes later.
  const w = preferredDoubleWeight(prefs.preferredDoubles || [], parsed[parsed.length - 1]);
  return { tokens: parsed, weight: w };
}

export function shouldAttemptCheckout(remaining, band, sliders, prefs, rng, pressureEvent) {
  const rem = Number(remaining) || 0;
  if (rem < 2) return false;

  // Always behave "checkout-aware" in the finish zone.
  // Even with weak checkout skill, a real player does not keep "scoring" on 14, 3, etc.
  if (rem <= 20) return true;
  if (rem <= 40) return true; // includes odd totals (will use setup route)
  if (rem <= 60) {
    // Strong bias to enter checkout logic (setup + doubles) in this zone.
    const chk = clampInt(sliders.checkout ?? 5, 1, 10);
    const p = clamp(0.75 + (chk - 5) * 0.03, 0.60, 0.92);
    return roll(rng, p);
  }

  // Above 60: consider based on band threshold.
  if (rem > band.checkoutConsiderAt) return false;

  // Must be a possible checkout (double out chart) or a simple fallback.
  if (!CHECKOUTS[rem]) {
    if (!(rem === 50 || (rem <= 40 && rem % 2 === 0))) return false;
  }

  const chk = clampInt(sliders.checkout ?? 5, 1, 10);
  const risk = 5;

  // Base willingness increases with checkout skill.
  let p = 0.32 + (chk - 5) * 0.045; // ~0.10..0.55

  // Big outs only sometimes.
  if (rem > 100) {
    const big = band.takeout170Rate;
    const riskAdj = 1 + (risk - 5) * 0.08;
    p = clamp(big * riskAdj * (0.7 + chk / 10), 0.02, 0.55);
  }

  // Pressure can change willingness slightly.

  return roll(rng, clamp(p, 0, 0.75));
}

export function checkoutDoubleConvertChance(band, sliders, doubleName) {
  const chk = clampInt(sliders.checkout ?? 5, 1, 10);
  // Slider center (5) should be "neutral" (mult ~= 1.0).
  // Higher checkout increases double conversion meaningfully.
  const mult = clamp(1.00 + (chk - 5) * 0.08, 0.70, 1.65);

  if (doubleName === "BULL") return clamp(band.bullConvert * mult, 0.01, 0.45);

  const key = String(doubleName || "").toLowerCase();
  // Many bands define only a handful of common doubles.
  // If a specific double isn't listed (e.g., D1), derive a reasonable baseline
  // from overall band strength rather than using a flat default.
  // Derived baseline for doubles not explicitly listed (e.g., D1).
  // Calibrated so "slider 5" feels like a real player (not double-jail).
  const derivedBase = clamp(0.12 + (clampInt(band.id, 30, 90) - 30) * 0.004, 0.10, 0.40);
  const base = band.doubleConvert?.[key] ?? derivedBase;
  return clamp(base * mult, 0.02, 0.60);
}

export function simulateCheckoutVisit({ remaining, routeTokens, band, sliders, prefs, rng }) {
  let rem = Number(remaining) || 0;
  let scoredTotal = 0;
  let checkoutHit = false;
  let attemptedCheckout = true;

  let checkoutAttemptDartsOnDouble = 0;
  let checkoutDartsOnDouble = 0;

  const darts = [];

  // If a route provides fewer than 3 tokens (e.g. "D1"), a real player keeps aiming
  // at the same finishing double for the remaining darts in the visit.
  let lastAimToken = null;

  for (let dart = 0; dart < 3; dart++) {
    if (rem <= 1) break;

    let token = routeTokens?.[dart] || null;
    if (!token) {
      // Re-aim logic when the provided route is shorter than 3 darts.
      // Prefer continuing the last aimed double/bull; otherwise derive a sensible token.
      if (lastAimToken && (lastAimToken.ring === "D" || lastAimToken.ring === "BULL")) {
        token = lastAimToken;
      } else if (rem === 50) {
        token = { ring: "BULL", n: 50 };
      } else if (rem <= 40) {
        if (rem % 2 === 0) token = { ring: "D", n: rem / 2 };
        else {
          // On an odd finish, set up with S1 unless we're on the last dart.
          token = (dart === 2) ? { ring: "S", n: 1 } : { ring: "S", n: 1 };
        }
      } else {
        // Default: do nothing further (shouldn't generally happen; engine only enters checkout with a route)
        break;
      }
    }

    let aim = token;
    lastAimToken = aim;
    let scored = 0;
    let onDouble = false;

    if (aim.ring === "BULL") {
      // Bull attempt.
      checkoutAttemptDartsOnDouble += 1;
      onDouble = true;
      const p = checkoutDoubleConvertChance(band, sliders, "BULL");
      const hit = roll(rng, p);
      scored = hit ? 50 : 25;
      if (hit && rem - 50 === 0) {
        checkoutHit = true;
        checkoutDartsOnDouble += 1;
      }
      darts.push({ aim: "BULL", scored });
    } else if (aim.ring === "D") {
      // Double attempt.
      checkoutAttemptDartsOnDouble += 1;
      onDouble = true;
      const dblName = `D${aim.n}`;
      const p = checkoutDoubleConvertChance(band, sliders, dblName);

      // Miss model: inside single, outside miss, or (rare) total miss.
      // These probabilities scale with both skill and checkout slider.
      const chk = clampInt(sliders.checkout ?? 5, 1, 10);
      const skill = clampInt(band.id ?? 50, 30, 90);

      // Miss probabilities tuned so "all sliders 5" produces sensible finishing times.
      // At mid skill / checkout=5, we want doubles to land in a believable ~12–18% hit-per-dart range
      // after accounting for inside/outside misses.
      const missZeroP = clamp(0.10 - (chk - 5) * 0.015 - (skill - 30) * 0.0018, 0.01, 0.10);
      const insideP = clamp(0.20 - (chk - 5) * 0.012 - (skill - 30) * 0.0012, 0.05, 0.20);
      const outsideSingleP = clamp(0.18 - (chk - 5) * 0.01, 0.05, 0.22);

      if (roll(rng, missZeroP)) {
        scored = 0;
      } else if (roll(rng, insideP)) {
        scored = aim.n;
      } else {
        const hit = roll(rng, p);
        if (hit) {
          scored = aim.n * 2;
          if (rem - scored === 0) {
            checkoutHit = true;
            checkoutDartsOnDouble += 1;
          }
        } else {
          // Outside miss: often lands in a plausible neighboring single rather than 0.
          scored = roll(rng, outsideSingleP) ? clampInt(aim.n + (roll(rng, 0.5) ? 1 : -1), 1, 20) : 0;
        }
      }
      darts.push({ aim: dblName, scored });
    } else if (aim.ring === "T") {
      // Treble as part of a checkout line.
      const p = clamp(band.trebleConvertGivenIntent * (0.85), 0.05, 0.70);
      const hit = roll(rng, p);
      scored = hit ? aim.n * 3 : aim.n; // miss to single
      darts.push({ aim: `T${aim.n}`, scored });
    } else {
      // Single setup.
      scored = aim.n;
      darts.push({ aim: `S${aim.n}`, scored });
    }

    // Bust rules
    const next = rem - scored;
    if (next < 0 || next === 1) {
      // bust entire visit
      return {
        score: 0,
        dartsUsed: 3,
        darts,
        checkoutHit: false,
        attemptedCheckout,
        checkoutAttemptDartsOnDouble,
        checkoutDartsOnDouble: 0,
        bust: true,
      };
    }

    rem = next;
    scoredTotal += scored;

    if (rem === 0) {
      // Must have finished on a double or bull (we only enter here if token was D or BULL).
      checkoutHit = true;
      const used = dart + 1;
      return {
        score: scoredTotal,
        dartsUsed: used,
        darts,
        checkoutHit,
        attemptedCheckout,
        checkoutAttemptDartsOnDouble,
        checkoutDartsOnDouble: Math.max(1, checkoutDartsOnDouble || (onDouble ? 1 : 0)),
        bust: false,
      };
    }
  }

  // Did not finish.
  return {
    score: scoredTotal,
    dartsUsed: 3,
    darts,
    checkoutHit: false,
    attemptedCheckout,
    checkoutAttemptDartsOnDouble,
    checkoutDartsOnDouble: 0,
    bust: false,
  };
}
