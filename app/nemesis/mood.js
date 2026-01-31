// /app/nemesis/mood.js
// Flavor text generation for Nemesis thought popups.
// This does NOT change gameplay—only adds commentary.
// Deterministic: uses the Nemesis seeded RNG helpers.

import { rngPick } from "./rng.js";

/** @returns {string|null} */
export function decideNemesisThought(ctx, rng) {
  // ---- Helpers ----
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const now = Number(ctx.nowMs || Date.now());

  const runtime = (ctx.runtime && typeof ctx.runtime === "object") ? ctx.runtime : {};
  const totalVisits = Number(runtime.thoughtVisits || 0);
  const shown = Number(runtime.thoughtsShown || 0);
  const shownRate = totalVisits > 0 ? (shown / totalVisits) : 0;

  const lastShownAt = Number(runtime.lastPopupAtMs || 0);
  const lastShownKey = (typeof runtime.lastPopupKey === "string") ? runtime.lastPopupKey : "";
  const cooldownOk = (now - lastShownAt) > 1500 && (ctx.visitKey !== lastShownKey); // also blocks duplicates

  // Hard throttle: never more than ~25% of visits speaking, except tier-1 events.
  const underCap = shownRate < 0.25;

  const target = Number(ctx.legTarget3DA || ctx.target3DA || 0);
  const actual = Number(ctx.actual3DA || 0);
  const tol = 2.0;
  const pace = (target > 0 && actual > target + tol) ? "over" : (target > 0 && actual < target - tol) ? "under" : "on";

  const legPos = ctx.legPos || "even"; // ahead / behind / even
  const visitTag = ctx.visitTag || "normal"; // catastrophic / clutch / great / bad / normal
  const streakTag = ctx.streakTag || "none"; // good2 / bad2 / none
  const consistency = Number(ctx.consistency || 5);

  // ---- Phrase bank ----
  const PHRASES = {
    // Tier 1: almost-always
    catastrophic: [
      "What a nightmare…",
      "That’s unacceptable.",
      "I’ve completely lost it there.",
    ],
    clutch: [
      "Still got it.",
      "Held my nerve.",
      "That’ll do.",
    ],

    // Tier 2: pattern / streak (mostly for low consistency)
    streak_bad: [
      "Man, I just can’t keep it together.",
      "This is slipping away.",
      "I need to slow this down.",
    ],
    streak_good: [
      "That’s what I’m talking about.",
      "I’m finding something here.",
      "Keep it going.",
    ],

    // Tier 3: pace vs situation
    under_any: [
      "Just not pulling my weight.",
      "Not good enough from me.",
      "Need to sharpen up.",
    ],
    over_winning: [
      "Lead is nice, head down.",
      "Keep it tidy.",
      "No need to force it.",
    ],
    over_losing: [
      "I’m playing well but just can’t keep up.",
      "Good darts… still chasing.",
      "That should be enough, but it isn’t.",
    ],

    // Tier 4: visit quality (lightweight, often skipped)
    great_under: [
      "More of those please.",
      "That’s the visit I needed.",
      "Yes—build on that.",
    ],
    great_over: [
      "Really feeling it now.",
      "That’s more like it.",
      "Keep that rhythm.",
    ],
    bad_under: [
      "What an awful showing.",
      "That’s dreadful.",
      "Can’t do that again.",
    ],
    bad_over: [
      "That was bad, but head down.",
      "Scrappy—reset.",
      "One poor visit. Move on.",
    ],
  };

  // ---- Tier selection ----
  // Tier 1: catastrophic / clutch should almost always show, but still respect cooldown.
  if (cooldownOk) {
    if (visitTag === "catastrophic") return rngPick(rng, PHRASES.catastrophic);
    if (visitTag === "clutch") return rngPick(rng, PHRASES.clutch);
  }

  // If we just showed something recently, stop here.
  if (!cooldownOk) return null;

  // Tier 2: streaks, weighted by low consistency.
  if (streakTag === "bad2" || streakTag === "good2") {
    const isLowCons = consistency <= 3;
    const p = isLowCons ? 0.70 : 0.35;
    if (underCap || rng() < 0.12) { // allow very occasional overspeaking even when capped
      if (rng() < p) {
        return (streakTag === "bad2") ? rngPick(rng, PHRASES.streak_bad) : rngPick(rng, PHRASES.streak_good);
      }
    }
  }

  // Tier 3: pace context — only speak sometimes.
  // Prefer silence when things are average.
  if (pace !== "on") {
    const p = 0.22 + (consistency <= 3 ? 0.08 : 0); // a touch chattier when inconsistent
    if ((underCap && rng() < p) || (!underCap && rng() < 0.08)) {
      if (pace === "under") return rngPick(rng, PHRASES.under_any);
      const isWinning = (legPos === "ahead");
      return isWinning ? rngPick(rng, PHRASES.over_winning) : rngPick(rng, PHRASES.over_losing);
    }
  }

  // Tier 4: visit quality — very selective.
  // If neither great nor bad, stay silent.
  if (visitTag === "great" || visitTag === "bad") {
    const p = underCap ? 0.14 : 0.05;
    if (rng() < p) {
      if (visitTag === "great") return (pace === "under") ? rngPick(rng, PHRASES.great_under) : rngPick(rng, PHRASES.great_over);
      return (pace === "under") ? rngPick(rng, PHRASES.bad_under) : rngPick(rng, PHRASES.bad_over);
    }
  }

  return null;
}
