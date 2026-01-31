// app/nemesis/planner.js
// Nemesis simplified planner: ONLY target 3DA + per-leg range.
//
// This planner intentionally ignores ALL trait sliders (consistency, checkout, pressure, momentum, risk).
// It precomputes a deterministic "leg script" (visit scores + dart breakdowns) at leg start.
// The script is chosen so the final 3-dart average is within:
//   [target3DA - range, target3DA + range]
// for that leg.

import { app } from "../state.js";
import { CHECKOUTS } from "../../checkouts.js";
import { makeRng, rngPick, rngInt } from "./rng.js";

const PLANNER_VERSION = "v10_cleanUI_consistencyMore_fix1";

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

function legNumberFromState(state) {
  const played = Array.isArray(state?.match?.legs) ? state.match.legs.length : 0;
  return played + 1;
}

function legKey(state) {
  const gameId = app.gameId || state?.gameId || "local";
  const legNum = legNumberFromState(state);
  const target = clampInt(state?.nemesis?.target3DA ?? 50, 10, 100);
  const range = clampInt(state?.nemesis?.rangeBand ?? state?.nemesis?.range ?? 0, 0, 15);
  const consistency = clampInt(state?.nemesis?.consistency ?? state?.nemesis?.sliders?.consistency ?? 5, 1, 10);
  const checkoutSkill = clampInt(state?.nemesis?.checkout ?? state?.nemesis?.sliders?.checkout ?? 5, 1, 10);
  const seed = String(state?.nemesis?.seed ?? state?.nemesis?.seedStr ?? "0");
  // Include version + slider inputs in the cache key so plans never get reused across changes.
  return `${PLANNER_VERSION}|${gameId}|seed:${seed}|leg:${legNum}|t:${target}|r:${range}|c:${consistency}|chk:${checkoutSkill}`;
}


function implied3DAFromDarts(totalDarts) {
  return 1503 / Math.max(1, totalDarts);
}

function avgForVisits(visits) {
  return 501 / Math.max(1, visits);
}



function chooseLegTarget3DA(baseTarget3DA, rangeBand, rngCore) {
  const base = clampInt(baseTarget3DA, 10, 100);
  const r = clampInt(rangeBand, 0, 15);
  if (r <= 0) return base;
  // Uniform integer in [base-r, base+r]
  const lo = clampInt(base - r, 10, 100);
  const hi = clampInt(base + r, 10, 100);
  const n = rngInt(rngCore, lo, hi);
  return clampInt(n, 10, 100);
}
function chooseVisitsForTarget(target3DA, range, minVisits = 6) {
  const t = clamp(Number(target3DA), 10, 100);
  const r = clamp(Number(range), 0, 15);
  const lo = t - r;
  const hi = t + r;

  // Search plausible visit counts and pick the one whose implied average is inside the band.
  // If multiple are inside, choose closest to target.
  const minV = clampInt(minVisits, 3, 30);
  let best = null;
  for (let v = minV; v <= 30; v++) {
    const a = avgForVisits(v);
    const inside = a >= lo && a <= hi;
    const dist = inside ? Math.abs(a - t) : Math.min(Math.abs(a - lo), Math.abs(a - hi)) + 1000;
    if (!best || dist < best.dist) best = { visits: v, avg: a, dist };
  }
  return best?.visits ?? clampInt(Math.round(501 / Math.max(1, t)), 6, 18);
}

function checkoutPctFor3DA(target3DA) {
  // Table from user:
  // 10->1%, 20->3%, 30->5%, 40->10%, 50->15%, 60->20%, 70->25%, 80->30%, 90->35%, 100->40%
  const t = clamp(Number(target3DA), 10, 100);
  const points = [
    { a: 10, p: 0.01 },
    { a: 20, p: 0.03 },
    { a: 30, p: 0.05 },
    { a: 40, p: 0.10 },
    { a: 50, p: 0.15 },
    { a: 60, p: 0.20 },
    { a: 70, p: 0.25 },
    { a: 80, p: 0.30 },
    { a: 90, p: 0.35 },
    { a: 100, p: 0.40 },
  ];
  let lo = points[0];
  let hi = points[points.length - 1];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (t >= p0.a && t <= p1.a) {
      lo = p0;
      hi = p1;
      break;
    }
  }
  if (hi.a === lo.a) return clamp(lo.p, 0.005, 0.90);
  const u = (t - lo.a) / (hi.a - lo.a);
  return clamp(lo.p + u * (hi.p - lo.p), 0.005, 0.90);
}

function sampleTriangular(rng, min, mode, max) {
  // Triangular distribution (min, mode, max). Peaks at mode; extremes are less likely.
  const a = clamp(Number(min), 0.0001, 0.9999);
  const b = clamp(Number(mode), a, 0.9999);
  const c = clamp(Number(max), b, 0.9999);
  if (c === a) return a;
  const u = rng();
  const f = (b - a) / (c - a);
  if (u < f) return a + Math.sqrt(u * (b - a) * (c - a));
  return c - Math.sqrt((1 - u) * (c - b) * (c - a));
}

function checkoutEarlyDartMultiplier(checkoutSkill) {
  // Multiplier applied to the first few double darts to make extremes feel extreme.
  // Skill 1 => very low chance to hit early; Skill 10 => very high chance to hit early.
  const s = clampInt(checkoutSkill ?? 5, 1, 10);
  const lo = 0.15;
  const hi = 1.35;
  return clamp(lo + (hi - lo) * ((s - 1) / 9), 0.05, 1.8);
}

function sampleCheckoutAttempts(rng, pLeg, checkoutSkill, clutchBoostMult, clutchChance) {
  // Deterministic-by-seed plan: we generate a fixed sequence of uniform draws and find
  // the first draw that falls under the per-dart hit threshold.
  //
  // This "shared randomness" coupling makes the checkout-skill slider behave monotonically:
  // increasing checkout skill can only make the hit occur on the same or earlier double dart.
  const base = clamp(Number(pLeg), 0.0001, 0.9999);
  const chk = clampInt(checkoutSkill ?? 5, 1, 10);

  const isClutch = rng() < clamp(Number(clutchChance) || 0, 0, 0.25);
  const boost = isClutch ? clamp(Number(clutchBoostMult) || 1.0, 1.0, 2.0) : 1.0;

  const earlyMult = checkoutEarlyDartMultiplier(chk);

  const cap = 160; // hard cap for safety
  let trials = cap;

  for (let i = 1; i <= cap; i++) {
    const u = rng();
    // First 3 double darts are "special": low skill is much worse early; high skill much better early.
    let p = base;
    if (i === 1) p = clamp(base * boost, 0.0001, 0.9999);
    if (i <= 3) p = clamp(p * earlyMult, 0.0001, 0.9999);
    if (u < p) { trials = i; break; }
  }
  return { trials, isClutch, earlyMult };
}


function sampleGeometricTrials(rng, p, maxTrials = 60) {
  // Number of independent Bernoulli(p) trials until first success (inclusive).
  const prob = clamp(Number(p), 0.0001, 0.9999);
  const cap = clampInt(maxTrials, 1, 500);
  let trials = 1;
  while (trials < cap && rng() >= prob) trials += 1;
  return trials;
}

function parseCheckoutTokens(line) {
  const t = String(line || "").trim();
  if (!t) return [];
  return t
    .split(/\s+/)
    .filter(Boolean)
    .map((raw) => {
      const s = String(raw).toUpperCase();
      if (s === "BULL") return { aim: "BULL", scored: 50, onDouble: true };
      if (s.startsWith("T")) {
        const n = clampInt(s.slice(1), 1, 20);
        return { aim: `T${n}`, scored: n * 3, onDouble: false };
      }
      if (s.startsWith("D")) {
        const n = clampInt(s.slice(1), 1, 20);
        return { aim: `D${n}`, scored: n * 2, onDouble: true };
      }
      const n = clampInt(s, 1, 20);
      return { aim: `S${n}`, scored: n, onDouble: false };
    });
}

function chooseFinishRemaining(rng, target3DA, checkoutSkill) {
  // Finish remainder at which the bot begins "checkout phase".
  // Higher checkout skill can finish from larger numbers more often.
  const t = clampInt(target3DA ?? 50, 10, 100);
  const chk = clampInt(checkoutSkill ?? 5, 1, 10);

  const base = [40, 32, 24, 20, 16, 12, 10, 8, 6, 4, 2, 50];

  // Additional checkout-start remainders unlocked by stronger checkout skill.
  // These must exist in CHECKOUTS to have an out-shot route.
  const mid = [60, 64, 68, 72, 76, 80, 84, 88, 90, 96, 100];
  const hi = [104, 110, 112, 116, 120, 121, 122, 130, 132, 140, 150, 160];

  // Cap the max remainder by both checkout skill and overall scoring level.
  // This keeps "50 avg" from suddenly living in 140+ checkouts unless checkout skill is very high.
  const maxRem = clampInt(40 + (t - 40) * 1.2 + (chk - 5) * 12, 40, 170);

  const pool = [];
  for (const v of base) {
    if (v <= maxRem && (CHECKOUTS[v] || v === 50 || (v <= 40 && v % 2 === 0))) pool.push(v);
  }
  if (chk >= 7) {
    for (const v of mid) if (v <= maxRem && CHECKOUTS[v]) pool.push(v);
  }
  if (chk >= 9) {
    for (const v of hi) if (v <= maxRem && CHECKOUTS[v]) pool.push(v);
  }

  // Weighting: low skill strongly prefers easy doubles; high skill more willing to start from bigger numbers.
  // We implement weights by repeating items (simple + deterministic).
  const weighted = [];
  for (const v of pool.length ? pool : base) {
    const isEasy = (v <= 40 && v % 2 === 0) || v === 50;
    const isBig = v > 60;
    let w = 1;
    if (isEasy) w += (11 - chk); // low chk => much more likely
    if (isBig) w += Math.max(0, chk - 6) * 2; // high chk => more likely
    // Slightly favor clean popular outs.
    if (v === 40 || v === 32 || v === 24 || v === 50) w += 2;
    for (let i = 0; i < w; i++) weighted.push(v);
  }
  return rngPick(rng, weighted.length ? weighted : base);
}


// ---------------------------------------------------------------------------
// Scoring realism model (precomputed, no per-dart physics).
//
// We model a scoring dart as:
//  1) Choose an aim family (20 or 19)
//  2) Choose a neighborhood bucket (0/1/2/3/wild) around that family
//  3) Choose a wedge from that bucket
//  4) Choose a ring event: MISS_BOARD, FLUKE_DOUBLE, TREBLE, or SINGLE
//
// This yields realistic 3-dart visit totals for a given skill level while still
// allowing us to precompute a leg script deterministically.
// ---------------------------------------------------------------------------

function bandFromTarget3DA(target3DA) {
  const t = clampInt(target3DA, 10, 100);
  return clampInt(Math.round(t / 10) * 10, 10, 100);
}

function scoringModelForBand(band) {
  // All probabilities sum properly (buckets sum to 1, ring events sum to 1).
  // Wild is explicitly 0 for 80+; 12/18 remain but very rare.
  const t = clampInt(band, 10, 100);

  // Helper to clamp tiny negative due to rounding.
  const fix = (x) => Math.max(0, Math.min(1, x));

  // These curves are tuned for plausible darts *shapes*, not perfect realism.
  // You can tweak the specific numbers later; the important part is that:
  //  - p0 increases with skill
  //  - p2/p3/pwild decrease with skill
  //  - missBoard and flukeDouble decrease with skill
  //  - treble increases with skill
  let pAim19;
  if (t <= 30) pAim19 = 0.06;
  else if (t <= 60) pAim19 = 0.12;
  else if (t <= 80) pAim19 = 0.08;
  else pAim19 = 0.06;

  // Neighborhood buckets for aiming 20.
  let p0, p1, p2, p3, pw;
  if (t <= 20) {
    p0 = 0.30; p1 = 0.25; p2 = 0.15; p3 = 0.10; pw = 0.20;
  } else if (t <= 40) {
    p0 = 0.48; p1 = 0.28; p2 = 0.14; p3 = 0.06; pw = 0.04;
  } else if (t <= 60) {
    p0 = 0.62; p1 = 0.28; p2 = 0.08; p3 = 0.015; pw = 0.005;
  } else if (t <= 70) {
    // 70+ players very rarely drift into 2nd neighbors (12/18). Keep it *extremely* tiny.
    // (Even small per-dart probabilities become noticeable once we bias visits toward target totals.)
    p0 = 0.735; p1 = 0.257; p2 = 0.006; p3 = 0.002; pw = 0.0;
  } else if (t <= 80) {
    p0 = 0.80; p1 = 0.195; p2 = 0.005; p3 = 0.0; pw = 0.0;
  } else if (t <= 90) {
    p0 = 0.85; p1 = 0.148; p2 = 0.002; p3 = 0.0; pw = 0.0;
  } else {
    p0 = 0.89; p1 = 0.108; p2 = 0.002; p3 = 0.0; pw = 0.0;
  }

  // Use a very similar shape for aiming 19.
  // IMPORTANT: do NOT inflate 2nd-neighbor (n2) at high skill, otherwise S16/S17 become too common.
  let n0 = fix(p0 - 0.03);
  let n1 = fix(p1 + 0.03);
  let n2 = fix(p2 * (t >= 70 ? 1.0 : 1.25));
  let n3 = fix(p3);
  let nw = fix(1 - (n0 + n1 + n2 + n3));
  // Renormalize the 19-bucket weights to sum to 1 (floating drift protection).
  const nsum = n0 + n1 + n2 + n3 + nw;
  n0 /= nsum; n1 /= nsum; n2 /= nsum; n3 /= nsum; nw /= nsum;

  // Ring events during scoring.
  // missBoard is true 0; flukeDouble is accidental double while aiming.
  let missBoard, flukeDouble, treble;
  if (t <= 20) {
    missBoard = 0.10; flukeDouble = 0.025; treble = 0.03;
  } else if (t <= 30) {
    missBoard = 0.07; flukeDouble = 0.020; treble = 0.05;
  } else if (t <= 40) {
    missBoard = 0.05; flukeDouble = 0.015; treble = 0.08;
  } else if (t <= 50) {
    missBoard = 0.03; flukeDouble = 0.010; treble = 0.12;
  } else if (t <= 60) {
    missBoard = 0.02; flukeDouble = 0.007; treble = 0.17;
  } else if (t <= 70) {
    missBoard = 0.012; flukeDouble = 0.004; treble = 0.22;
  } else if (t <= 80) {
    missBoard = 0.007; flukeDouble = 0.002; treble = 0.28;
  } else if (t <= 90) {
    missBoard = 0.004; flukeDouble = 0.001; treble = 0.33;
  } else {
    missBoard = 0.002; flukeDouble = 0.0005; treble = 0.38;
  }
  const single = fix(1 - (missBoard + flukeDouble + treble));
  // Switching aim family mid-visit (after a bad dart) is a deliberate adjustment.
  // Low skill: rare (lack of intention); mid skill: some; 70+: most likely (still uncommon).
  let switchAfterBad;
  if (t < 40) switchAfterBad = 0.02;
  else if (t <= 70) switchAfterBad = 0.05;
  else switchAfterBad = 0.08;


  return {
    band: t,
    aim19: pAim19,
    switchAfterBad,
    // neighborhood weights
    p20: { p0, p1, p2, p3, pw },
    p19: { p0: n0, p1: n1, p2: n2, p3: n3, pw: nw },
    // ring weights
    ring: { missBoard, flukeDouble, treble, single },
  };
}

function pickBucket(rng, w) {
  const r = rng();
  const a0 = w.p0;
  const a1 = a0 + w.p1;
  const a2 = a1 + w.p2;
  const a3 = a2 + w.p3;
  if (r < a0) return 0;
  if (r < a1) return 1;
  if (r < a2) return 2;
  if (r < a3) return 3;
  return 4; // wild
}

function pickFrom(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function sampleWedge(rng, family, bucket) {
  if (family === 20) {
    if (bucket === 0) return 20;
    if (bucket === 1) return pickFrom(rng, [1, 5]);
    if (bucket === 2) return pickFrom(rng, [12, 18]);
    if (bucket === 3) return pickFrom(rng, [9, 4]);
    // wild: plausible "off" wedges
    return pickFrom(rng, [6, 10, 11, 13, 14, 15, 16, 17, 7, 8, 2, 3]);
  }
  // family 19
  if (bucket === 0) return 19;
  if (bucket === 1) return pickFrom(rng, [7, 3]);
  if (bucket === 2) return pickFrom(rng, [17, 16]);
  if (bucket === 3) return pickFrom(rng, [2, 15]);
  return pickFrom(rng, [6, 10, 11, 13, 14, 18, 12, 5, 1, 4, 9, 8]);
}

function sampleScoringDart(model, rng, family) {
  // family: 20 or 19 (visit-level aim). This keeps 19 visits "sticky" instead of mixed.
  const fam = (family === 19) ? 19 : 20;
  const weights = (fam === 19) ? model.p19 : model.p20;
  const bucket = pickBucket(rng, weights);
  const wedge = sampleWedge(rng, fam, bucket);

  // Ring event
  const r = rng();
  const ring = model.ring;
  if (r < ring.missBoard) {
    return { aim: "MISS", scored: 0, onDouble: false, family: fam, bucket, missBoard: true };
  }
  if (r < ring.missBoard + ring.flukeDouble) {
    return { aim: `D${wedge}`, scored: wedge * 2, onDouble: true, family: fam, bucket, missBoard: false };
  }
  if (r < ring.missBoard + ring.flukeDouble + ring.treble) {
    return { aim: `T${wedge}`, scored: wedge * 3, onDouble: false, family: fam, bucket, missBoard: false };
  }
  return { aim: `S${wedge}`, scored: wedge, onDouble: false, family: fam, bucket, missBoard: false };
}

function buildMenuFromModel(model) {
  // Build a small menu of possible dart outcomes for exact decomposition on the last visit.
  // Only include wedges that can actually appear.
  const wedges = new Set();
  // Always include core wedges and neighbors.
  for (const w of [20, 1, 5, 12, 18, 9, 4, 19, 7, 3, 17, 16, 2, 15]) wedges.add(w);
  // Include the wild wedge pools only if wild has any probability.
  if (model.p20.pw > 0) for (const w of [6, 10, 11, 13, 14, 15, 16, 17, 7, 8, 2, 3]) wedges.add(w);
  if (model.p19.pw > 0) for (const w of [6, 10, 11, 13, 14, 18, 12, 5, 1, 4, 9, 8]) wedges.add(w);

  const menu = [{ aim: "MISS", scored: 0, onDouble: false }];
  const ring = model.ring;
  for (const w of wedges) {
    menu.push({ aim: `S${w}`, scored: w, onDouble: false });
    // Include trebles if treble probability is non-trivial.
    if (ring.treble > 0.02) menu.push({ aim: `T${w}`, scored: w * 3, onDouble: false });
    // Include fluke doubles if non-trivial.
    if (ring.flukeDouble > 0.001) menu.push({ aim: `D${w}`, scored: w * 2, onDouble: true });
  }
  // Bull can occur as a fluke only in the previous versions; we exclude it in scoring for simplicity.
  // Sort high-to-low to keep any greedy fallback plausible.
  menu.sort((a, b) => b.scored - a.scored);
  return menu;
}

function findThreeDartsForScore(score, menu) {
  const s = clampInt(score, 0, 180);
  // Map value -> list of darts
  const byVal = new Map();
  for (const d of menu) {
    if (!byVal.has(d.scored)) byVal.set(d.scored, []);
    byVal.get(d.scored).push(d);
  }

  for (let i = 0; i < menu.length; i++) {
    const d1 = menu[i];
    for (let j = 0; j < menu.length; j++) {
      const d2 = menu[j];
      const need = s - d1.scored - d2.scored;
      const list = byVal.get(need);
      if (list && list.length) {
        const d3 = list[0];
        return [d1, d2, d3];
      }
    }
  }
  return null;
}

function sampleScoringVisit(model, rng, targetMean, maxScore) {
  // Sample 3 darts from the realism model and bias toward a target mean.
  // Rejection sampling: keep the best of N samples.
  const cap = clampInt(maxScore, 0, 180);
  const desired = clamp(Number(targetMean), 0, 180);
  const tries = 24;
  let best = null;
  for (let k = 0; k < tries; k++) {
    // Choose aim family ONCE per visit (sticky). This makes 19-visits look intentional.
    let family = (rng() < model.aim19) ? 19 : 20;
    let switched = false;
    const isBad = (d) => Boolean(d?.missBoard) || d?.bucket === 3 || d?.bucket === 4;
    const maybeSwitch = (d) => {
      if (switched) return;
      if (!isBad(d)) return;
      if (rng() < (model.switchAfterBad ?? 0)) {
        family = (family === 19) ? 20 : 19;
        switched = true;
      }
    };

    const d1 = sampleScoringDart(model, rng, family);
    maybeSwitch(d1);
    const d2 = sampleScoringDart(model, rng, family);
    maybeSwitch(d2);
    const d3 = sampleScoringDart(model, rng, family);
    const total = d1.scored + d2.scored + d3.scored;
    if (total > cap) continue;
    // Distance from desired total, plus a realism penalty for wide misses at higher skill.
    // Without this, rejection sampling can "over-select" rare neighbors to hit an exact mean.
    let dist = Math.abs(total - desired);
    if (model.band >= 70) {
      const darts = [d1, d2, d3];
      for (const d of darts) {
        if (d.bucket === 2) dist += 6;      // 2nd neighbors (12/18, 16/17)
        else if (d.bucket === 3) dist += 10; // 3rd neighbors (9/4, 2/15)
        else if (d.bucket === 4) dist += 25; // wild
        else if (d.missBoard) dist += 30;
      }
    }
    if (!best || dist < best.dist) {
      best = { total, darts: [d1, d2, d3], dist };
      if (dist <= 4) break; // close enough
    }
  }
  return best || { total: 0, darts: [{ aim: "MISS", scored: 0, onDouble: false }, { aim: "MISS", scored: 0, onDouble: false }, { aim: "MISS", scored: 0, onDouble: false }], dist: 999 };
}

function sampleRawScoringVisit(model, rng, maxScore = 180) {
  // A single 3-dart scoring visit from the realism model with no steering.
  // Aim family is chosen once per visit (sticky) with at most one switch after a bad dart.
  const cap = clampInt(maxScore, 0, 180);

  let family = (rng() < model.aim19) ? 19 : 20;
  let switched = false;
  const isBad = (d) => Boolean(d?.missBoard) || d?.bucket === 3 || d?.bucket === 4;
  const maybeSwitch = (d) => {
    if (switched) return;
    if (!isBad(d)) return;
    if (rng() < (model.switchAfterBad ?? 0)) {
      family = (family === 19) ? 20 : 19;
      switched = true;
    }
  };

  const d1 = sampleScoringDart(model, rng, family);
  maybeSwitch(d1);
  const d2 = sampleScoringDart(model, rng, family);
  maybeSwitch(d2);
  const d3 = sampleScoringDart(model, rng, family);

  const total = d1.scored + d2.scored + d3.scored;
  if (total > cap) {
    // If we exceed cap (usually because remaining is small near the end), degrade by
    // turning the last dart into a MISS. This keeps the outcomes realistic and bounded.
    const trimmed = clampInt(total - d3.scored, 0, cap);
    return {
      total: trimmed,
      darts: [d1, d2, { aim: "MISS", scored: 0, onDouble: false }],
      rarity: 0,
    };
  }

  // Rarity score used during selection (higher = less common / less realistic at high skill).
  // We treat 2nd/3rd neighbors, wild and miss-board as rarer than primary/1st neighbors.
  const darts = [d1, d2, d3];
  let rarity = 0;
  for (const d of darts) {
    if (d?.missBoard) rarity += 3;
    else if (d?.bucket === 4) rarity += 3;
    else if (d?.bucket === 3) rarity += 2;
    else if (d?.bucket === 2) rarity += 1;
  }
  return { total, darts, rarity };
}

function buildCandidatePool(model, rng, poolSize = 420) {
  const size = clampInt(poolSize, 60, 1200);
  const pool = [];
  for (let i = 0; i < size; i++) {
    const v = sampleRawScoringVisit(model, rng, 180);
    // Exclude completely dead visits for mid/high bands; keep them for very low bands.
    if (model.band >= 40 && v.total === 0) continue;
    pool.push(v);
  }
  // Ensure we have *something*.
  if (pool.length < 30) {
    for (let i = 0; i < 80; i++) pool.push(sampleRawScoringVisit(model, rng, 180));
  }
  pool.sort((a, b) => a.total - b.total);
  return pool;
}

function percentileIndex(n, p) {
  if (n <= 0) return 0;
  const q = clamp(Number(p), 0, 1);
  return clampInt(Math.floor(q * (n - 1)), 0, Math.max(0, n - 1));
}

function makeBucketsFromPool(pool) {
  const n = pool.length;
  const i20 = percentileIndex(n, 0.20);
  const i80 = percentileIndex(n, 0.80);
  const i95 = percentileIndex(n, 0.95); // top 5% is MAX

  const low = pool.slice(0, i20 + 1);
  const mid = pool.slice(i20 + 1, i80 + 1);
  const high = pool.slice(i80 + 1, i95 + 1);
  const max = pool.slice(i95 + 1);

  // Guard against empty buckets.
  const safe = (arr, fallback) => (arr && arr.length ? arr : fallback);
  return {
    low: safe(low, pool.slice(0, Math.min(20, n))),
    mid: safe(mid, pool.slice(Math.max(0, i20 - 10), Math.min(n, i80 + 1))),
    high: safe(high, pool.slice(Math.max(0, i80 - 10), Math.min(n, i95 + 1))),
    max: safe(max, pool.slice(Math.max(0, i95 - 10), n)),
  };
}

function consistencySpreadFactor(consistency) {
  // Map 1..10 (user slider) to spread factor s in [0,1]
  //  - 10 => 0 (tight/pro)
  //  - 1  => 1 (wild)
  const c = clampInt(consistency ?? 5, 1, 10);
  const x = (10 - c) / 9; // 0..1
  // Nonlinear curve so the ends feel meaningfully different.
  return Math.pow(x, 1.35);
}

function checkoutSkillMultiplier(checkoutSkill) {
  // User slider 1..10.
  //  - 1 => x0.40 (very weak on doubles)
  //  - 5 => x1.00 (neutral)
  //  - 10 => x1.80 (very strong on doubles)
  const s = clampInt(checkoutSkill ?? 5, 1, 10);
  if (s <= 5) return 0.40 + 0.15 * (s - 1); // 1..5
  return 1.00 + 0.16 * (s - 5); // 6..10
}

function checkoutClutchMultiplier(checkoutSkill) {
  // Make clutch much rarer at low checkout skill and more common at high skill.
  //  - 1 => x0.20
  //  - 5 => x1.00
  //  - 10 => x2.00
  const s = clampInt(checkoutSkill ?? 5, 1, 10);
  if (s <= 5) return 0.20 + 0.20 * (s - 1); // 1..5
  return 1.00 + 0.20 * (s - 5); // 6..10
}

function scoringSwingProfile(target3DA, consistency) {
  // Controls *shape* of scoring visits, not the overall mean.
  // Baseline is driven by target3DA, then widened/tightened by Consistency (1..10).
  const t = clampInt(target3DA, 10, 100);
  const s = consistencySpreadFactor(consistency); // 0 tight .. 1 wide

  // Floor variance (LOW selection) decreases strongly with skill.
  let pLow;
  if (t <= 20) pLow = 0.45;
  else if (t <= 30) pLow = 0.35;
  else if (t <= 40) pLow = 0.26;
  else if (t <= 50) pLow = 0.14;
  else if (t <= 60) pLow = 0.11;
  else if (t <= 70) pLow = 0.08;
  else if (t <= 80) pLow = 0.07;
  else if (t <= 90) pLow = 0.05;
  else pLow = 0.04;

  // Ceiling spikes (MAX selection) increases with skill.
  let pMax;
  if (t <= 30) pMax = 0.002;
  else if (t <= 40) pMax = 0.008;
  else if (t <= 50) pMax = 0.015;
  else if (t <= 60) pMax = 0.025;
  else if (t <= 70) pMax = 0.040;
  else if (t <= 80) pMax = 0.060;
  else if (t <= 90) pMax = 0.080;
  else pMax = 0.095;

  // Remaining mass split between MID and HIGH.
  let pHigh = 0.22;
  // Slightly increase the HIGH bucket at high skill (strong players live in 100+ a lot).
  if (t >= 80) pHigh = 0.26;
  if (t >= 90) pHigh = 0.28;

  // Apply Consistency widening/tightening.
  // Tight: reduce LOW/MAX; Wide: increase LOW/MAX. Keep HIGH fairly stable.
  const lowMult = 0.17 + (3.45 - 0.17) * s; // 0.17..3.45 (tighter at 10, wider at 1)
  const maxMult = 0.21 + (4.05 - 0.21) * s; // 0.21..4.05 (tighter at 10, wider at 1)
  const highMult = 1.05 + (0.85 - 1.05) * s; // 1.05..0.85 (subtle)
  pLow *= lowMult;
  pMax *= maxMult;
  pHigh *= highMult;

  // Ensure we leave enough room for MID (avoid pathological spreads).
  let pMid = 1 - (pLow + pHigh + pMax);
  if (pMid < 0.03) {
    const need = 0.03 - pMid;
    // Reduce LOW and MAX proportionally to free up space.
    const denom = (pLow + pMax) || 1;
    pLow = Math.max(0, pLow - (need * (pLow / denom)));
    pMax = Math.max(0, pMax - (need * (pMax / denom)));
    pMid = 1 - (pLow + pHigh + pMax);
  }

  // Final normalize.
  const sum = pLow + pMid + pHigh + pMax;
  pLow /= sum;
  pMid /= sum;
  pHigh /= sum;
  pMax /= sum;

  // Hot scoring leg increases MAX selection a bit (peaks), but is still rare.
  let hotChance = clamp(Math.max(0, (t - 50) * 0.0015), 0, 0.12);
  // Consistency also affects likelihood of a hot scoring leg (subtle).
  const hotMult = 0.70 + (1.30 - 0.70) * s;
  hotChance = clamp(hotChance * hotMult, 0, 0.20);

  return { pLow, pMid, pHigh, pMax, hotChance, spreadFactor: s };
}

function pickBucketName(rng, weights) {
  const r = rng();
  const a = weights.low;
  const b = a + weights.mid;
  const c = b + weights.high;
  if (r < a) return "low";
  if (r < b) return "mid";
  if (r < c) return "high";
  return "max";
}



function maybeCatastrophicLowVisit(target3DA, maxScore, rng, consistency) {
  // Extremely low visits should be possible when Consistency is at the wild end,
  // even for mid-skill players (e.g., S1+S1+S5 = 7). This affects shape only;
  // the planner will compensate later in the leg.
  const c = clampInt(consistency ?? 5, 1, 10);
  if (c > 2) return null;
  const t = clampInt(target3DA, 10, 100);
  // Don't allow catastrophic lows for very high skill.
  if (t >= 80) return null;

  // Chance scales with how wild the consistency is.
  const p = (c === 1) ? 0.22 : 0.10; // slightly higher to make extreme lows more visible at Consistency 1
  if (rng() >= p) return null;

  const options = [
    { total: 0, darts: [{aim:"MISS",scored:0,onDouble:false},{aim:"MISS",scored:0,onDouble:false},{aim:"MISS",scored:0,onDouble:false}] },
    { total: 3, darts: [{aim:"S1",scored:1,onDouble:false},{aim:"S1",scored:1,onDouble:false},{aim:"S1",scored:1,onDouble:false}] },
    { total: 4, darts: [{aim:"S1",scored:1,onDouble:false},{aim:"S3",scored:3,onDouble:false},{aim:"MISS",scored:0,onDouble:false}] },
    { total: 5, darts: [{aim:"S1",scored:1,onDouble:false},{aim:"S1",scored:1,onDouble:false},{aim:"S3",scored:3,onDouble:false}] },
    { total: 7, darts: [{aim:"S1",scored:1,onDouble:false},{aim:"S1",scored:1,onDouble:false},{aim:"S5",scored:5,onDouble:false}] },
    { total: 9, darts: [{aim:"S1",scored:1,onDouble:false},{aim:"S3",scored:3,onDouble:false},{aim:"S5",scored:5,onDouble:false}] },
    { total: 11, darts:[{aim:"S1",scored:1,onDouble:false},{aim:"S5",scored:5,onDouble:false},{aim:"S5",scored:5,onDouble:false}] },
    { total: 15, darts:[{aim:"S5",scored:5,onDouble:false},{aim:"S5",scored:5,onDouble:false},{aim:"S5",scored:5,onDouble:false}] },
  ];

  // Prefer 7/9/11 a bit more than pure misses.
  const weights = [0.06,0.05,0.07,0.09,0.24,0.20,0.15,0.14]; // bias toward 7/9/11 at wild end
  let sum = weights.reduce((a,b)=>a+b,0);
  let r = rng()*sum;
  for (let i=0;i<options.length;i++){
    r -= weights[i];
    if (r<=0){
      const pick = options[i];
      if (pick.total > maxScore) return null;
      return { total: pick.total, darts: pick.darts, rarity: 0.0 };
    }
  }
  const fallback = options[4];
  return (fallback.total<=maxScore) ? { total:fallback.total, darts:fallback.darts, rarity:0.0 } : null;
}

function chooseCandidateFromBucket(bucket, desired, maxScore, modelBand, rng, consistency = 5) {
  // Pick a candidate close to desired, but allow more deviation at low Consistency.
  // This controls spread without affecting checkout or the mean-plan.
  const cap = clampInt(maxScore, 0, 180);
  const want = clamp(Number(desired), 0, 180);
  const arr = bucket;
  if (!arr.length) return null;

  const c = clampInt(consistency ?? 5, 1, 10);
  // Temperature: low => tight selection, high => looser.
  const temp = clamp(2 + (10 - c) * 1.6, 2, 18); // c10->2, c1->16.4

  const samples = Math.min(arr.length, 72);
  const shortlist = [];
  for (let i = 0; i < samples; i++) {
    const cand = arr[Math.floor(rng() * arr.length)];
    if (!cand) continue;
    if (cand.total > cap) continue;
    let cost = Math.abs(cand.total - want);
    // Rarity penalty at high skill: discourage over-selecting wide/odd neighbors.
    if (modelBand >= 70) cost += 7 * (cand.rarity || 0);
    shortlist.push({ cand, cost });
  }
  if (!shortlist.length) return null;

  // Softmax over negative cost / temp.
  let sumW = 0;
  for (const it of shortlist) {
    const w = Math.exp(-it.cost / temp);
    it.w = w;
    sumW += w;
  }
  let r = rng() * (sumW || 1);
  for (const it of shortlist) {
    r -= it.w;
    if (r <= 0) return it.cand;
  }
  return shortlist[0].cand;
}


function buildLegScript({ coreSeedStr, scoreSeedStr, target3DA, range, consistency, checkoutSkill, rngCore, rngScore }) {
  // Checkout success probability (per double dart) is based on the user-provided table,
  // but we vary it per-leg with a *peaked* (triangular) distribution so extreme swings are rarer.
  // It represents: (doubles hit) / (doubles attempted).
  //
  // IMPORTANT: checkout + leg-length randomness must NOT depend on Consistency.
  // We therefore use rngCore only in this section.
  const checkoutPctMean = checkoutPctFor3DA(target3DA);
  const checkoutMin = clamp(checkoutPctMean * 0.75, 0.005, 0.95);
  const checkoutMax = clamp(checkoutPctMean * 1.25, 0.005, 0.95);

  function maxFeasibleScoringMean(t3da) {
    const t = clampInt(t3da, 10, 100);
    if (t <= 30) return t + 70;   // beginners can be wildly spiky
    if (t <= 50) return t + 45;   // mid skill shouldn't need 120+ means
    if (t <= 70) return t + 40;
    if (t <= 90) return t + 34;
    return t + 30;
  }

  // Choose finish + checkout attempts, but reject extreme checkout lengths that would
  // force unrealistic scoring means just to keep the leg average on target.
  let checkoutPct = checkoutPctMean;
  let finishRemaining = 40;
  let finishAim = "D20";
  let doubleAttempts = 6;
  let isClutch = false;
  let checkoutVisits = 2;
  let plannedVisits = 10;
  let impliedAvg = implied3DAFromDarts(plannedVisits*3);
  let scoringVisits = 8;

  const maxTries = 30;
  const chkMult = checkoutSkillMultiplier(checkoutSkill);
  const checkoutEffMin = clamp(checkoutMin * chkMult, 0.001, 0.90);
  const checkoutEffMax = clamp(checkoutMax * chkMult, 0.001, 0.90);

  for (let k = 0; k < maxTries; k++) {
    checkoutPct = sampleTriangular(rngCore, checkoutMin, checkoutPctMean, checkoutMax);
    // Apply user Checkout Skill (1..10) as a multiplier on the per-double hit chance.
    checkoutPct = clamp(checkoutPct * chkMult, 0.001, 0.90);

    // Choose a clean finish remaining for the checkout phase.
    // The simplified model prefers even doubles (including D1) and bull.
    finishRemaining = chooseFinishRemaining(rngCore, target3DA, checkoutSkill);
    finishAim = finishRemaining === 50 ? "BULL" : `D${finishRemaining / 2}`;

    // Sample how many double attempts are needed this leg to finish.
    // We simulate per-attempt Bernoulli trials to match the "hit/attempt" definition,
    // with a tiny chance of a "clutch" leg that slightly boosts the first double dart.
    const t = clampInt(target3DA, 10, 100);
    const baseClutchChance = clamp(Math.max(0, (t - 40) * 0.001), 0, 0.06);
    const clutchMult = checkoutClutchMultiplier(checkoutSkill);
    const clutchChance = clamp(baseClutchChance * clutchMult, 0, 0.25);
    const sampled = sampleCheckoutAttempts(rngCore, checkoutPct, checkoutSkill, 1.30, clutchChance);
    doubleAttempts = sampled.trials;
    isClutch = sampled.isClutch;
    checkoutVisits = Math.max(1, Math.ceil(doubleAttempts / 3));

    // Choose scoring visits to hit the target 3DA based on total darts (3DA = 501*3 / totalDarts).
// This allows the Range slider to vary the per-leg target continuously (not just 501/visits steps).
// All scoring logic remains intact; we only choose how many scoring visits occur before checkout.
const minTotalVisits = checkoutVisits + 1;
const desiredTotalDarts = 1503 / Math.max(1, clamp(Number(target3DA), 10, 100));
const desiredScoringDarts = Math.max(3, desiredTotalDarts - doubleAttempts);
scoringVisits = clampInt(Math.round(desiredScoringDarts / 3), 1, 40);
plannedVisits = Math.max(minTotalVisits, scoringVisits + checkoutVisits);
impliedAvg = implied3DAFromDarts(scoringVisits * 3 + doubleAttempts);

    const meanNeeded = (501 - finishRemaining) / Math.max(1, scoringVisits);
    const feasible = meanNeeded <= maxFeasibleScoringMean(target3DA);

    // Also guard against checkout consuming almost the entire leg at mid skill or above.
    const maxCheckoutShare = (clampInt(target3DA, 10, 100) >= 50) ? 0.45 : 0.60;
    const shareOk = (checkoutVisits / Math.max(1, plannedVisits)) <= maxCheckoutShare;

    if (feasible && shareOk) break;
    // Otherwise resample using rngCore and try again.
  }

  const band = bandFromTarget3DA(target3DA);
  const scoringModel = scoringModelForBand(band);
  const menu = buildMenuFromModel(scoringModel);

  // Build a pool of realistic scoring visits for this leg, then select from percentiles
  // to introduce skill-appropriate swing (low-skill = messy lows, high-skill = spiky highs).
  const poolRng = makeRng(scoreSeedStr, "pool");
  const pool = buildCandidatePool(scoringModel, poolRng, 520);
  const buckets = makeBucketsFromPool(pool);
  const swing = scoringSwingProfile(target3DA, consistency);
  const isHotScoringLeg = rngScore() < (swing.hotChance ?? 0);
  // Start-of-leg bucket weights.
  let baseLow = swing.pLow;
  let baseHigh = swing.pHigh;
  let baseMax = swing.pMax;
  if (isHotScoringLeg) {
    // Hot legs: slightly more top-end (140/180 etc), slightly fewer ugly turns.
    baseMax = clamp(baseMax + 0.03, 0, 0.25);
    baseLow = clamp(baseLow - 0.02, 0, 0.60);
  }
  let baseMid = clamp(1 - (baseLow + baseHigh + baseMax), 0.05, 0.95);
  // Normalize in case of rounding.
  const baseSum = baseLow + baseMid + baseHigh + baseMax;
  baseLow /= baseSum;
  baseMid /= baseSum;
  baseHigh /= baseSum;
  baseMax /= baseSum;

  const scores = [];
  const dartsByVisit = [];
  let remaining = 501;

  // Distribute points across scoringVisits such that we arrive at finishRemaining.
  // We select realistic visit totals from the percentile buckets, and steer selection
  // toward the required mean so the leg remains on-plan.
  for (let i = 0; i < scoringVisits; i++) {
    const visitsLeft = scoringVisits - i;
    const needToLeave = finishRemaining;
    const maxScore = clampInt(Math.min(180, remaining - needToLeave), 0, 180);
    const needThisPhase = (remaining - needToLeave);
    const mean = needThisPhase / Math.max(1, visitsLeft);

    // Last scoring visit must land exactly on finishRemaining.
    if (i === scoringVisits - 1) {
      const exact = clampInt(remaining - needToLeave, 0, maxScore);
      let darts = findThreeDartsForScore(exact, menu);
      if (!darts) {
        // If exact isn't representable with the strict menu, pick the closest sample and
        // patch the final dart as a single to make the arithmetic work.
        const sampled = sampleScoringVisit(scoringModel, rngScore, exact, maxScore);
        darts = sampled.darts.slice(0, 3);
        const current = darts[0].scored + darts[1].scored + darts[2].scored;
        const delta = exact - current;
        if (delta !== 0) {
          const patched = clampInt(darts[2].scored + delta, 0, 60);
          darts[2] = { aim: patched === 0 ? "MISS" : `S${patched}`, scored: patched, onDouble: false };
        }
      }
      scores.push(exact);
      dartsByVisit.push(darts);
      remaining -= exact;
      continue;
    }

    // Choose a bucket (LOW/MID/HIGH/MAX) with skill-shaped probabilities.
    // Then pick a candidate close to the needed mean, with a penalty that avoids
    // over-selecting rare neighbors (especially 70+).
    let wLow = baseLow;
    let wMid = baseMid;
    let wHigh = baseHigh;
    let wMax = baseMax;

    // Dynamic steering: if we need a much higher mean than the target, bias upward;
    // if we need a much lower mean, bias downward.
    const delta = mean - clamp(Number(target3DA), 10, 100);
    if (delta > 6) {
      const bump = clamp(delta / 60, 0, 0.18);
      wMax = clamp(wMax + bump * 0.6, 0, 0.35);
      wHigh = clamp(wHigh + bump * 0.4, 0, 0.60);
      wLow = clamp(wLow - bump * 0.7, 0, 0.60);
    } else if (delta < -6) {
      const bump = clamp((-delta) / 60, 0, 0.18);
      wLow = clamp(wLow + bump * 0.7, 0, 0.75);
      wMax = clamp(wMax - bump * 0.6, 0, 0.35);
      wHigh = clamp(wHigh - bump * 0.4, 0, 0.60);
    }
    // Recompute mid and normalize.
    wMid = clamp(1 - (wLow + wHigh + wMax), 0.03, 0.95);
    const wSum = wLow + wMid + wHigh + wMax;
    wLow /= wSum; wMid /= wSum; wHigh /= wSum; wMax /= wSum;

    const bucketName = pickBucketName(rngScore, { low: wLow, mid: wMid, high: wHigh, max: wMax });
    const bucketArr = buckets[bucketName] || buckets.mid;
    const catastrophic = (bucketName === "low") ? maybeCatastrophicLowVisit(target3DA, maxScore, rngScore, consistency) : null;
    let picked = catastrophic || chooseCandidateFromBucket(bucketArr, mean, maxScore, scoringModel.band, rngScore, consistency);
    if (!picked) {
      // Fallback to a steered sample if something goes wrong.
      const sampled = sampleScoringVisit(scoringModel, rngScore, mean, maxScore);
      picked = { total: sampled.total, darts: sampled.darts, rarity: 0 };
    }

    const s = clampInt(picked.total, 0, maxScore);
    scores.push(s);
    dartsByVisit.push(picked.darts);
    remaining -= s;
  }

  // Checkout phase: up to 3 darts per visit, always aiming at the finishing double/bull.
  // Misses score 0 and do not change remaining (simplified). The final successful dart scores finishRemaining.
  let attemptsSoFar = 0;
  let finished = false;
  for (let v = 0; v < checkoutVisits; v++) {
    const darts = [];
    let visitScore = 0;
    for (let d = 0; d < 3; d++) {
      if (finished) {
        darts.push({ aim: "MISS", scored: 0, onDouble: false });
        continue;
      }
      attemptsSoFar += 1;
      const isHit = attemptsSoFar >= doubleAttempts;
      if (isHit) {
        darts.push({ aim: finishAim, scored: finishRemaining, onDouble: true });
        visitScore += finishRemaining;
        finished = true;
      } else {
        darts.push({ aim: finishAim, scored: 0, onDouble: true });
      }
    }
    scores.push(clampInt(visitScore, 0, 180));
    dartsByVisit.push(darts);
  }
  // Scoring variance (scoring visits only; excludes checkout visits)
  const scoringSlice = scores.slice(0, Math.max(0, scoringVisits));
  const scoringVarLow = scoringSlice.length ? Math.min(...scoringSlice) : 0;
  const scoringVarHigh = scoringSlice.length ? Math.max(...scoringSlice) : 0;


  return {
    seedStr: scoreSeedStr,
    coreSeedStr: coreSeedStr,
    plannedVisits,
    impliedAvg,
    scoringVisits,
    checkoutVisits,
    finishRemaining,
    checkoutPct,
    checkoutPctMean,
    checkoutPctMin: checkoutMin,
    checkoutPctMax: checkoutMax,
    checkoutPctEffMin: checkoutEffMin,
    checkoutPctEffMax: checkoutEffMax,
    checkoutClutch: isClutch,
    scoringHot: isHotScoringLeg,
    scoringVarLow,
    scoringVarHigh,
    doubleAttempts,
    visitScores: scores,
    visitDarts: dartsByVisit,
  };
}

const PLAN_CACHE = new Map();

export function clearNemesisPlanCache() {
  PLAN_CACHE.clear();
}

export function getNemesisLegPlan(state) {
  const key = legKey(state);
  const existing = PLAN_CACHE.get(key);
  if (existing) return existing;

  const baseTarget3DA = clampInt(state?.nemesis?.target3DA ?? 50, 10, 100);
  const range = clampInt(state?.nemesis?.rangeBand ?? state?.nemesis?.range ?? 0, 0, 15);
  const consistency = clampInt(state?.nemesis?.consistency ?? state?.nemesis?.sliders?.consistency ?? 5, 1, 10);
  const checkoutSkill = clampInt(state?.nemesis?.checkout ?? state?.nemesis?.sliders?.checkout ?? 5, 1, 10);
  const legNum = legNumberFromState(state);
  const seed = String(state?.nemesis?.seed ?? state?.nemesis?.seedStr ?? "0");
  const coreSeedStr = `${app.gameId || "local"}|nemesis|seed:${seed}|leg:${legNum}|target:${baseTarget3DA}|range:${range}|chk:${checkoutSkill}`;
  const scoreSeedStr = `${coreSeedStr}|cons:${consistency}`;

  // IMPORTANT: checkout + leg-length randomness must NOT depend on Consistency.
  // Only scoring-shape selection depends on Consistency.
  const rngCore = makeRng(coreSeedStr, "script");
  const rngScore = makeRng(scoreSeedStr, "script");

  const bandLow = clampInt(baseTarget3DA - range, 10, 100);
  const bandHigh = clampInt(baseTarget3DA + range, 10, 100);

  // Pick ONE leg-specific target inside the range band (integer), then build multiple
  // candidate scripts around that target so the leg still feels varied while meeting
  // the same overall criteria.
  const desiredLegTarget3DA = (range > 0) ? rngInt(rngCore, bandLow, bandHigh) : baseTarget3DA;

  // Build multiple candidate scripts and pick the one whose implied 3DA is closest
  // to the desired leg target (and preferably within the band).
  let bestScript = null;
  let bestScore = Infinity;

  const CANDIDATES = (range > 0) ? 30 : 8;
  for (let i = 0; i < CANDIDATES; i++) {
    // Derive per-candidate seeds. We keep the desired target fixed, and vary the script seed.
    const candCoreSeedStr = coreSeedStr + `|cand:${i}|des:${desiredLegTarget3DA}`;
    const candScoreSeedStr = scoreSeedStr + `|cand:${i}|des:${desiredLegTarget3DA}`;

    const candRngCore = makeRng(candCoreSeedStr, "script");
    const candRngScore = makeRng(candScoreSeedStr, "script");

    const script = buildLegScript({
      coreSeedStr: candCoreSeedStr,
      scoreSeedStr: candScoreSeedStr,
      target3DA: desiredLegTarget3DA,
      range: 0,
      consistency,
      checkoutSkill,
      rngCore: candRngCore,
      rngScore: candRngScore,
    });

    const implied = Number(script.impliedAvg ?? 0);
    const inBand = (implied >= bandLow - 0.001) && (implied <= bandHigh + 0.001);
    const dist = Math.abs(implied - desiredLegTarget3DA);

    // Prefer scripts within band; tie-break by closeness to desired target.
    const score = (inBand ? 0 : 1000) + dist;

    if (score < bestScore) {
      bestScore = score;
      bestScript = script;
    }
  }

  const legScript = bestScript;
  const legTarget3DA = desiredLegTarget3DA;


  const plan = {
    key,
    seedStr: scoreSeedStr,
    coreSeedStr: coreSeedStr,
    legIndex: legNum,
    target3DA: baseTarget3DA,
    legTarget3DA,
    range,
    consistency,
    checkoutSkill,
    plannedVisits: legScript.plannedVisits,
    impliedAvg: legScript.impliedAvg,
    scoringVisits: legScript.scoringVisits,
    checkoutVisits: legScript.checkoutVisits,
    checkoutStartIndex: legScript.scoringVisits,
    checkoutHitIndex: legScript.scoringVisits + legScript.checkoutVisits - 1,
    finishRemaining: legScript.finishRemaining,
    checkoutPct: legScript.checkoutPct,
    checkoutPctMin: legScript.checkoutPctMin,
    checkoutPctMax: legScript.checkoutPctMax,
    checkoutPctEffMin: legScript.checkoutPctEffMin,
    checkoutPctEffMax: legScript.checkoutPctEffMax,
    scoringVarLow: legScript.scoringVarLow,
    scoringVarHigh: legScript.scoringVarHigh,
    plannedDoubleAttempts: legScript.doubleAttempts,
    visitScores: legScript.visitScores,
    visitDarts: legScript.visitDarts,
  };

  PLAN_CACHE.set(key, plan);
  return plan;
}

export function countBotVisitsInLeg(state) {
  const hist = Array.isArray(state?.leg?.history) ? state.leg.history : [];
  return Math.max(0, Math.floor(hist.length / 2));
}

export function deriveVisitTarget(plan, state, visitIndex) {
  // In the simplified model, the plan is the target.
  const idx = clampInt(visitIndex, 0, plan.visitScores.length - 1);
  return {
    targetVisitTotal: clampInt(plan.visitScores[idx], 0, 180),
    pressureEvent: false,
  };
}