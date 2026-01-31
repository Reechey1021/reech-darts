// /app/nemesis/tables.js
// Table-driven scoring parameters for Nemesis.
// These are intentionally easy to tweak.

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function bandFor(target3DA) {
  const t = Math.round(Number(target3DA) / 10) * 10;
  return clamp(t, 10, 100);
}

// Helper: normalize weights list into cumulative
function normalizeOutcomes(outcomes) {
  const total = outcomes.reduce((s, o) => s + (o.w || 0), 0) || 1;
  return outcomes.map(o => ({ v: o.v, w: (o.w || 0) / total }));
}

// PDF-derived baseline (Balanced sliders).
// Values are "segment outcomes" when aiming at 20 or 19 areas.
// Ring (single/triple) is modeled elsewhere.
const PDF_BASE = {
  10: {
    missBoard: 0.50,
    tryTreble: 0.10,
    aim20vs19: [0.95, 0.05],
    outcomes20: normalizeOutcomes([
      {v:20,w:10},{v:5,w:8},{v:1,w:8},{v:12,w:6},{v:18,w:6},{v:0,w:20}
    ]),
    outcomes19: normalizeOutcomes([
      {v:19,w:10},{v:7,w:8},{v:3,w:8},{v:16,w:6},{v:17,w:6},{v:0,w:20}
    ]),
    flukeDouble: 0.15,
  },
  20: {
    missBoard: 0.30,
    tryTreble: 0.40,
    aim20vs19: [0.95, 0.05],
    outcomes20: normalizeOutcomes([{v:11,w:1},{v:14,w:1},{v:9,w:1},{v:12,w:1},{v:5,w:1},{v:20,w:1},{v:1,w:1},{v:18,w:1},{v:4,w:1},{v:13,w:1},{v:6,w:1},{v:0,w:2}]),
    outcomes19: normalizeOutcomes([{v:11,w:1},{v:8,w:1},{v:16,w:1},{v:7,w:1},{v:19,w:1},{v:3,w:1},{v:17,w:1},{v:2,w:1},{v:15,w:1},{v:10,w:1},{v:6,w:1},{v:13,w:1},{v:4,w:1},{v:0,w:2}]),
    flukeDouble: 0.10,
  },
  30: {
    missBoard: 0.15,
    tryTreble: 0.75,
    aim20vs19: [0.90, 0.10],
    outcomes20: normalizeOutcomes([{v:9,w:1},{v:12,w:1},{v:5,w:1},{v:20,w:2},{v:1,w:1},{v:18,w:1},{v:4,w:1},{v:13,w:1},{v:0,w:1}]),
    outcomes19: normalizeOutcomes([{v:8,w:1},{v:16,w:1},{v:7,w:2},{v:19,w:2},{v:3,w:2},{v:17,w:1},{v:2,w:1},{v:0,w:1}]),
    flukeDouble: 0.05,
  },
  40: {
    missBoard: 0.04,
    tryTreble: 0.95,
    aim20vs19: [0.85, 0.15],
    outcomes20: normalizeOutcomes([{v:12,w:10},{v:5,w:25},{v:20,w:30},{v:1,w:25},{v:18,w:10}]),
    outcomes19: normalizeOutcomes([{v:16,w:10},{v:7,w:25},{v:19,w:30},{v:3,w:25},{v:17,w:10}]),
    flukeDouble: 0.03,
  },
  50: {
    missBoard: 0.02,
    tryTreble: 0.95,
    aim20vs19: [0.80, 0.20],
    outcomes20: normalizeOutcomes([{v:12,w:5},{v:5,w:25},{v:20,w:40},{v:1,w:25},{v:18,w:5}]),
    outcomes19: normalizeOutcomes([{v:16,w:5},{v:7,w:25},{v:19,w:40},{v:3,w:25},{v:17,w:5}]),
    flukeDouble: 0.01,
  },
  60: {
    missBoard: 0.01,
    tryTreble: 1.00,
    aim20vs19: [0.80, 0.20],
    outcomes20: normalizeOutcomes([{v:12,w:1},{v:5,w:19},{v:20,w:60},{v:1,w:19},{v:18,w:1}]),
    outcomes19: normalizeOutcomes([{v:16,w:1},{v:7,w:19},{v:19,w:60},{v:3,w:19},{v:17,w:1}]),
    flukeDouble: 0.00,
  },
  70: {
    missBoard: 0.005,
    tryTreble: 1.00,
    aim20vs19: [0.80, 0.20],
    outcomes20: normalizeOutcomes([{v:12,w:1},{v:5,w:14},{v:20,w:70},{v:1,w:14},{v:18,w:1}]),
    outcomes19: normalizeOutcomes([{v:16,w:1},{v:7,w:14},{v:19,w:60},{v:3,w:14},{v:17,w:1}]),
    flukeDouble: 0.00,
  },
  80: {
    missBoard: 0.0,
    tryTreble: 1.00,
    aim20vs19: [0.75, 0.25],
    outcomes20: normalizeOutcomes([{v:5,w:12},{v:20,w:76},{v:1,w:12}]),
    outcomes19: normalizeOutcomes([{v:7,w:12},{v:19,w:76},{v:3,w:12}]),
    flukeDouble: 0.00,
  },
  90: {
    missBoard: 0.0,
    tryTreble: 1.00,
    aim20vs19: [0.75, 0.25],
    outcomes20: normalizeOutcomes([{v:5,w:10},{v:20,w:80},{v:1,w:10}]),
    outcomes19: normalizeOutcomes([{v:7,w:10},{v:19,w:80},{v:3,w:10}]),
    flukeDouble: 0.00,
  },
  100: {
    missBoard: 0.0,
    tryTreble: 1.00,
    aim20vs19: [0.75, 0.25],
    outcomes20: normalizeOutcomes([{v:5,w:5},{v:20,w:90},{v:1,w:5}]),
    outcomes19: normalizeOutcomes([{v:7,w:5},{v:19,w:90},{v:3,w:5}]),
    flukeDouble: 0.00,
  }
};

// Adjustable tweaks: reduce true board-misses above 40 (feels better than literal "0").
function adjustedMissRate(band) {
  const base = PDF_BASE[band]?.missBoard ?? 0.02;
  if (band >= 40) return Math.min(0.002, base * 0.25);
  if (band >= 30) return Math.min(0.02, base);
  return base;
}

export function getScoringTable(target3DA) {
  const b = bandFor(target3DA);
  const base = PDF_BASE[b] || PDF_BASE[50];
  return {
    band: b,
    tryTreble: base.tryTreble,
    aim20vs19: base.aim20vs19,
    outcomes20: base.outcomes20,
    outcomes19: base.outcomes19,
    missBoard: adjustedMissRate(b),
    flukeDouble: base.flukeDouble,
  };
}

// Checkout table (PDF-derived baseline). Values are per-attempt heuristics.
const CHECKOUT = {
  10: { considerAt: 50, pref: 0.05, wrong: 0.90, inside: 0.90, pct: 0.01 },
  20: { considerAt: 50, pref: 0.25, wrong: 0.80, inside: 0.60, pct: 0.03 },
  30: { considerAt: 60, pref: 0.50, wrong: 0.50, inside: 0.40, pct: 0.05 },
  40: { considerAt: 80, pref: 0.60, wrong: 0.25, inside: 0.30, pct: 0.10 },
  50: { considerAt: 100, pref: 0.70, wrong: 0.17, inside: 0.25, pct: 0.15 },
  60: { considerAt: 110, pref: 0.70, wrong: 0.13, inside: 0.25, pct: 0.20 },
  70: { considerAt: 120, pref: 0.80, wrong: 0.10, inside: 0.25, pct: 0.25 },
  80: { considerAt: 140, pref: 0.80, wrong: 0.05, inside: 0.20, pct: 0.30 },
  90: { considerAt: 170, pref: 0.90, wrong: 0.03, inside: 0.15, pct: 0.35 },
  100:{ considerAt: 170, pref: 0.95, wrong: 0.02, inside: 0.10, pct: 0.40 },
};

export function getCheckoutTable(target3DA) {
  const b = bandFor(target3DA);
  return CHECKOUT[b] || CHECKOUT[50];
}
