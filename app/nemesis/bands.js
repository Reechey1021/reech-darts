// app/nemesis/bands.js
// Skill-band capability model for Nemesis (10-point steps).
//
// These values are tuned so that, with sliders ~5, the expected scoring performance
// is in the neighborhood of the band id (e.g. band 50 ~ 50 3DA, band 80 ~ 80 3DA).
// The per-leg budget planner still drives the final average; bands mainly control
// realism (miss spread, treble/double skill, big-out willingness).

export const SKILL_BANDS = {
  30: {
    id: 30,
    trebleIntentRate: 0.22,
    trebleConvertGivenIntent: 0.14,
    bullConvert: 0.05,
    missZeroRate: 0.10,
    neighborSpread: { tight: 0.50, near: 0.34, wide: 0.16 },
    baseAimBias: { s20: 0.64, s19: 0.20, other: 0.16 },
    checkoutConsiderAt: 70,
    takeout170Rate: 0.01,
    doubleConvert: { d16:0.10,d20:0.10,d10:0.09,d8:0.08,d12:0.08,d6:0.07,d4:0.07,bull:0.05 },
  },
  40: {
    id: 40,
    trebleIntentRate: 0.30,
    trebleConvertGivenIntent: 0.18,
    bullConvert: 0.07,
    missZeroRate: 0.07,
    neighborSpread: { tight: 0.58, near: 0.32, wide: 0.10 },
    baseAimBias: { s20: 0.68, s19: 0.22, other: 0.10 },
    checkoutConsiderAt: 90,
    takeout170Rate: 0.02,
    doubleConvert: { d16:0.14,d20:0.14,d10:0.13,d8:0.12,d12:0.12,d6:0.11,d4:0.10,bull:0.07 },
  },
  50: {
    id: 50,
    trebleIntentRate: 0.38,
    trebleConvertGivenIntent: 0.23,
    bullConvert: 0.09,
    missZeroRate: 0.05,
    neighborSpread: { tight: 0.64, near: 0.30, wide: 0.06 },
    baseAimBias: { s20: 0.72, s19: 0.23, other: 0.05 },
    checkoutConsiderAt: 120,
    takeout170Rate: 0.05,
    doubleConvert: { d16:0.20,d20:0.20,d10:0.18,d8:0.17,d12:0.17,d6:0.16,d4:0.15,bull:0.10 },
  },
  60: {
    id: 60,
    trebleIntentRate: 0.48,
    trebleConvertGivenIntent: 0.30,
    bullConvert: 0.11,
    missZeroRate: 0.03,
    neighborSpread: { tight: 0.70, near: 0.26, wide: 0.04 },
    baseAimBias: { s20: 0.75, s19: 0.23, other: 0.02 },
    checkoutConsiderAt: 150,
    takeout170Rate: 0.09,
    doubleConvert: { d16:0.26,d20:0.26,d10:0.24,d8:0.23,d12:0.22,d6:0.21,d4:0.20,bull:0.13 },
  },
  70: {
    id: 70,
    trebleIntentRate: 0.58,
    trebleConvertGivenIntent: 0.36,
    bullConvert: 0.13,
    missZeroRate: 0.02,
    neighborSpread: { tight: 0.76, near: 0.22, wide: 0.02 },
    baseAimBias: { s20: 0.78, s19: 0.21, other: 0.01 },
    checkoutConsiderAt: 170,
    takeout170Rate: 0.14,
    doubleConvert: { d16:0.32,d20:0.32,d10:0.30,d8:0.29,d12:0.28,d6:0.27,d4:0.26,bull:0.16 },
  },
  80: {
    id: 80,
    trebleIntentRate: 0.66,
    trebleConvertGivenIntent: 0.42,
    bullConvert: 0.15,
    missZeroRate: 0.01,
    neighborSpread: { tight: 0.80, near: 0.19, wide: 0.01 },
    baseAimBias: { s20: 0.80, s19: 0.19, other: 0.01 },
    checkoutConsiderAt: 170,
    takeout170Rate: 0.20,
    doubleConvert: { d16:0.38,d20:0.38,d10:0.36,d8:0.35,d12:0.34,d6:0.33,d4:0.32,bull:0.19 },
  },
  90: {
    id: 90,
    trebleIntentRate: 0.74,
    trebleConvertGivenIntent: 0.48,
    bullConvert: 0.17,
    missZeroRate: 0.005,
    neighborSpread: { tight: 0.84, near: 0.15, wide: 0.01 },
    baseAimBias: { s20: 0.82, s19: 0.17, other: 0.01 },
    checkoutConsiderAt: 170,
    takeout170Rate: 0.28,
    doubleConvert: { d16:0.44,d20:0.44,d10:0.42,d8:0.41,d12:0.40,d6:0.39,d4:0.38,bull:0.23 },
  },
};

export function bandFromTarget3DA(target3DA) {
  const t = Math.max(10, Math.min(100, Number(target3DA) || 50));
  const stepped = Math.round(t / 10) * 10;
  const b = Math.max(30, Math.min(90, stepped));
  return b;
}
