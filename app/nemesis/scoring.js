// app/nemesis/scoring.js
// Scoring-mode dart simulation: aim family (20/19) + miss spread + trebles.

import { rngNormal, rngWeightedPick } from "./rng.js";

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

const NEIGHBORS = {
  20: { near: [5, 1], wide: [12, 18] },
  19: { near: [7, 3], wide: [16, 17] },
};

const OTHER_NUMS = [14, 9, 11, 13, 15, 17, 16, 12, 18, 10, 6, 4, 2, 8, 7, 3, 5, 1, 20, 19];

function shiftNeighborSpread(base, tighten) {
  // tighten: -0.25..+0.25 (negative => wider)
  const t = clamp(Number(tighten) || 0, -0.25, 0.25);
  let tight = base.tight + t;
  let near = base.near - t * 0.7;
  let wide = base.wide - t * 0.3;

  // Renormalize and clamp.
  tight = clamp(tight, 0.25, 0.95);
  near = clamp(near, 0.02, 0.70);
  wide = clamp(wide, 0.01, 0.50);

  const sum = tight + near + wide;
  return { tight: tight / sum, near: near / sum, wide: wide / sum };
}

export function chooseAimFamily(rng, band, prefs, sliders) {
  const base20 = band.baseAimBias.s20;
  const base19 = band.baseAimBias.s19;

  // prefs.aimBias19 is 0.05..0.30; higher => more 19.
  const pref19 = clamp(Number(prefs.aimBias19) || 0.12, 0.0, 0.45);

  let p19 = clamp(base19 + pref19 , 0.05, 0.55);
  let p20 = clamp(base20 - pref19 , 0.35, 0.95);

  // Normalize just between 20 and 19 for now (other is fallback).
  const sum = p20 + p19;
  p20 /= sum;
  p19 /= sum;

  const r = rng();
  if (r < p20) return 20;
  if (r < p20 + p19) return 19;
  return 20;
}

export function simulateScoringDart({ rng, aimFamily, band, sliders, prefs, needBoost, trebleIntentOverride = null }) {
  // needBoost: -1..+1, higher => try harder for points (late-dart budget correction)
  const missArchetype = prefs.missArchetype || "normal";

  const c = clampInt(sliders.consistency ?? 5, 1, 10);

  // Consistency tightens the spread; miss archetype adds flavor.
  const tightenBase = (c - 5) * 0.03; // -0.12..+0.15
  const archAdj = (missArchetype === "tight") ? 0.04 : (missArchetype === "wild" ? -0.05 : 0);
  const tighten = clamp(tightenBase + archAdj, -0.20, 0.20);

  const spread = shiftNeighborSpread(band.neighborSpread, tighten);

  // Miss 0 probability goes down with skill and consistency.
  const missZero = clamp(band.missZeroRate * (1.08 - (c - 1) * 0.03), 0.001, 0.20);
  if (roll(rng, missZero)) {
    return { aim: `AIM ${aimFamily}`, scored: 0, landing: { ring: "MISS", n: 0 } };
  }

  // Decide landing number.
  const nset = NEIGHBORS[aimFamily] || { near: [], wide: [] };
  const bucket = rngWeightedPick(rng, [
    { v: "tight", w: spread.tight },
    { v: "near", w: spread.near },
    { v: "wide", w: spread.wide },
  ]);

  let landed = aimFamily;
  if (bucket === "near") {
    landed = nset.near.length ? nset.near[Math.floor(rng() * nset.near.length)] : aimFamily;
  } else if (bucket === "wide") {
    if (nset.wide.length && roll(rng, 0.65)) {
      landed = nset.wide[Math.floor(rng() * nset.wide.length)];
    } else {
      landed = OTHER_NUMS[Math.floor(rng() * OTHER_NUMS.length)];
    }
  }

  // Decide treble intent.
  // Risk increases treble intent, but conversion is still capped by band.
  const intentBase = band.trebleIntentRate;
  const riskAdj = (risk - 5) * 0.02;
  const boostAdj = clamp(Number(needBoost) || 0, -1, 1) * 0.06;
  const trebleIntent = (typeof trebleIntentOverride === "boolean")
    ? trebleIntentOverride
    : roll(rng, clamp(intentBase  + boostAdj, 0.05, 0.90));

  // Convert treble if intended AND landed on the intended family number.
  if (trebleIntent && landed === aimFamily) {
    const conv = clamp(band.trebleConvertGivenIntent + (c - 5) * 0.01, 0.05, 0.60);
    if (roll(rng, conv)) {
      return { aim: `T${aimFamily}`, scored: aimFamily * 3, landing: { ring: "T", n: aimFamily } };
    }
  }

  // Occasionally (mostly low bands) fluke double when aiming 20/19.
  if (band.id <= 50 && roll(rng, 0.008)) {
    const dbl = (aimFamily === 20) ? 20 : (aimFamily === 19 ? 7 : null);
    if (dbl) return { aim: `D${dbl} (fluke)`, scored: dbl * 2, landing: { ring: "D", n: dbl } };
  }

  return { aim: `S${landed}`, scored: landed, landing: { ring: "S", n: landed } };
}

export function simulateScoringVisit({ rng, visitTarget, band, sliders, prefs, remaining }) {
  // Budget-seeking scoring visit, but with *strong* realization of the planned total.
  // The old approach (just "guide aim family") under-delivered badly, causing
  // persistent low 3DA vs target. Here we:
  //  1) sample a "desired" visit total close to visitTarget (std depends on consistency)
  //  2) choose a plausible 3-dart intent combination that matches that desired total
  //  3) simulate each dart with a miss model that mostly stays near the intended value
  // This keeps averages on-plan while still looking like darts.

  const c = clampInt(sliders.consistency ?? 5, 1, 10);

  // Realization noise: budgets already include variance. Execution should be tighter.
  const realizeStd = clamp(18 - c * 1.5, 2.5, 16); // c10 ~3, c1 ~16
  let desired = Math.round(clamp(visitTarget + rngNormal(rng) * realizeStd, 0, 180));

  // Keep extremely low totals rare at mid/high consistency.
  const floor = (c >= 7) ? 20 : (c >= 4 ? 10 : 0);
  desired = Math.max(desired, floor);

  // Allowed intent scores are dominated by 20/19 families + their common misses.
  const INTENT_SCORES = [60, 57, 20, 19, 18, 17, 16, 12, 7, 5, 3, 1, 0];

  // Find the best 3-dart intent combo for desired.
  let best = { a: 20, b: 20, d: 1e9, sum: 0 };
  for (let i = 0; i < INTENT_SCORES.length; i++) {
    for (let j = 0; j < INTENT_SCORES.length; j++) {
      for (let k = 0; k < INTENT_SCORES.length; k++) {
        const s = INTENT_SCORES[i] + INTENT_SCORES[j] + INTENT_SCORES[k];
        const dist = Math.abs(desired - s);
        if (dist < best.d) {
          best = { a: INTENT_SCORES[i], b: INTENT_SCORES[j], c: INTENT_SCORES[k], d: dist, sum: s };
          if (dist === 0) break;
        }
      }
    }
  }

  const intents = [best.a, best.b, best.c];

  function intentToAim(score) {
    if (score === 60) return { kind: "T", n: 20, aim: "T20" };
    if (score === 57) return { kind: "T", n: 19, aim: "T19" };
    if (score === 20) return { kind: "S", n: 20, aim: "S20" };
    if (score === 19) return { kind: "S", n: 19, aim: "S19" };
    if (score === 0) return { kind: "MISS", n: 0, aim: "MISS" };
    // For neighbor singles, keep the aim explicit.
    return { kind: "S", n: score, aim: `S${score}` };
  }

  function simulateAimed({ kind, n }) {
    // For aims based on 20/19 families, use a family-shaped miss model.
    const is20Fam = (n === 20 || n === 5 || n === 1 || n === 12 || n === 18);
    const is19Fam = (n === 19 || n === 7 || n === 3 || n === 16 || n === 17);

    // Miss-zero probability is kept very low for mid bands; 0s are extremely damaging.
    const missZero = clamp(band.missZeroRate * (0.85 - (c - 1) * 0.02), 0.0005, 0.08);
    if (roll(rng, missZero)) return { aim: `AIM ${kind}${n}`, scored: 0 };

    if (kind === "T" && (n === 20 || n === 19)) {
      // Treble attempt: hit treble with convert chance, otherwise very often hit the single.
      const conv = clamp(band.trebleConvertGivenIntent + (c - 5) * 0.008, 0.08, 0.65);
      if (roll(rng, conv)) return { aim: `T${n}`, scored: n * 3 };
      if (roll(rng, 0.82)) return { aim: `T${n}`, scored: n }; // single
      // Occasional neighbor
      const neigh = (n === 20) ? (roll(rng, 0.5) ? 5 : 1) : (roll(rng, 0.5) ? 7 : 3);
      return { aim: `T${n}`, scored: neigh };
    }

    if (kind === "S" && (is20Fam || is19Fam)) {
      const fam = is20Fam ? 20 : 19;
      // Tightness around the intended single: higher consistency => more on-target.
      const baseTight = band.neighborSpread.tight;
      const tight = clamp(baseTight + (c - 5) * 0.03 + (prefs.missArchetype === "tight" ? 0.04 : (prefs.missArchetype === "wild" ? -0.05 : 0)), 0.35, 0.92);
      if (roll(rng, tight)) return { aim: `S${n}`, scored: n };
      // If we miss, land in the common near/wide buckets for that family.
      const near = NEIGHBORS[fam]?.near || [];
      const wide = NEIGHBORS[fam]?.wide || [];
      const r = rng();
      if (r < 0.75 && near.length) return { aim: `S${n}`, scored: near[Math.floor(rng() * near.length)] };
      if (wide.length) return { aim: `S${n}`, scored: wide[Math.floor(rng() * wide.length)] };
      return { aim: `S${n}`, scored: fam };
    }

    // Fallback: use the old simulator for anything else.
    const aimFamily = (n === 19) ? 19 : 20;
    const d = simulateScoringDart({ rng, aimFamily, band, sliders, prefs, needBoost: 0, trebleIntentOverride: false });
    return { aim: d.aim, scored: d.scored };
  }

  let scoredTotal = 0;
  const darts = [];
  for (let i = 0; i < 3; i++) {
    const intent = intentToAim(intents[i]);
    const d = simulateAimed(intent);

    const next = Number(remaining) - (scoredTotal + d.scored);
    // Avoid intentional busting in scoring mode; if it busts, convert to safe 0 for this dart.
    if (next < 0 || next === 1) {
      darts.push({ aim: `${intent.aim} (safe)`, scored: 0 });
    } else {
      darts.push({ aim: intent.aim, scored: d.scored });
      scoredTotal += d.scored;
    }
  }

  return { score: scoredTotal, dartsUsed: 3, darts, desiredTotal: desired };
}
