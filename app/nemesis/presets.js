// /app/nemesis/presets.js
// Pre-programmed Nemesis presets.
// Presets MUST NOT modify target 3DA (target is always set separately).

export const NEMESIS_PRESETS = [
  {
    id: "standard",
    name: "Standard",
    description: "Your usual opponent.",
    values: {
      rangeStep: 2, // ±4
      consistency: 5,
      checkout: 5,
    },
  },
  {
    id: "elite",
    name: "Elite",
    description: "Clinical and ruthless.",
    values: {
      rangeStep: 1, // ±2
      consistency: 8,
      checkout: 7,
    },
  },
  {
    id: "finisher",
    name: "Finisher",
    description: "Finishes everything, even if it’s messy.",
    values: {
      rangeStep: 3, // ±6
      consistency: 5,
      checkout: 8,
    },
  },
  {
    id: "rollercoaster",
    name: "Rollercoaster",
    description: "Just can’t find a rhythm.",
    values: {
      rangeStep: 4, // ±8
      consistency: 2,
      checkout: 5,
    },
  },
  {
    id: "scorer",
    name: "Scorer",
    description: "Relentless scoring, shaky finishing.",
    values: {
      rangeStep: 2, // ±4
      consistency: 8,
      checkout: 3,
    },
  },
  {
    id: "wildcard",
    name: "Wildcard",
    description: "You never know what’s coming.",
    values: {
      rangeStep: 5, // ±10
      consistency: 4,
      checkout: 5,
    },
  },
  {
    id: "survivor",
    name: "Survivor",
    description: "Just needs to get through the leg.",
    values: {
      rangeStep: 1, // ±2
      consistency: 2,
      checkout: 4,
    },
  },
  {
    id: "custom",
    name: "Custom",
    description: "Manually tuned settings.",
    values: {
      // Intentionally empty. This is selected automatically when sliders are adjusted.
    },
  },
];

export function getPresetById(id) {
  return NEMESIS_PRESETS.find((p) => p.id === id) || NEMESIS_PRESETS[0];
}

export function findMatchingPresetId({ rangeStep, consistency, checkout } = {}) {
  const r = Number.isFinite(rangeStep) ? rangeStep : null;
  const c = Number.isFinite(consistency) ? consistency : null;
  const k = Number.isFinite(checkout) ? checkout : null;

  for (const p of NEMESIS_PRESETS) {
    if (p.id === "custom") continue;
    const v = p.values || {};
    if (r === v.rangeStep && c === v.consistency && k === v.checkout) return p.id;
  }
  return "custom";
}
