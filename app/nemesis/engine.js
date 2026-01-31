// app/nemesis/engine.js
// Nemesis simplified engine: plays back the precomputed per-leg script.
//
// All trait sliders are ignored. The planner precomputes an entire leg script
// (visit scores + dart breakdowns). This engine simply plays back the script.
//
// Public API: simulateNemesisVisit(ctx)
// returns { score, dartsUsed, checkoutHit, attemptedCheckout, checkoutAttemptDartsOnDouble, checkoutDartsOnDouble, thought }

import { getNemesisLegPlan, countBotVisitsInLeg, deriveVisitTarget } from "./planner.js";

function clampInt(n, lo, hi) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function countDoubles(darts) {
  let n = 0;
  for (const d of darts || []) {
    const a = String(d?.aim || "").toUpperCase();
    if (a.startsWith("D") || a === "BULL") n += 1;
  }
  return n;
}

function buildThought({ plan, remainingBefore, visitIndex, visitTarget, visitScore, darts, attemptedCheckout }) {
  const lines = [];
  lines.push("Nemesis (simple)");
  lines.push(
    `Target 3DA: ${plan.target3DA} | Range: ±${plan.range} | Leg target 3DA: ${plan.legTarget3DA} | Consistency: ${plan.consistency ?? (plan.sliders?.consistency ?? '?')} | Checkout skill: ${plan.checkoutSkill ?? (plan.sliders?.checkout ?? '?')} | Planned visits: ${plan.plannedVisits} | Implied 3DA: ${plan.impliedAvg.toFixed(1)}`
  );
  lines.push(`Scoring variance: Low ${plan.scoringVarLow ?? '?'} | High ${plan.scoringVarHigh ?? '?'}`);
  lines.push(
    `Checkout rate (double hit%): ${(Number(plan.checkoutPct || 0) * 100).toFixed(1)}% ` +
    `(base ${(Number(plan.checkoutPctMin||0)*100).toFixed(1)}–${(Number(plan.checkoutPctMax||0)*100).toFixed(1)}%, ` +
    `effective ${(Number(plan.checkoutPctEffMin||plan.checkoutPctMin||0)*100).toFixed(1)}–${(Number(plan.checkoutPctEffMax||plan.checkoutPctMax||0)*100).toFixed(1)}%) | ` +
    `Planned double attempts: ${plan.plannedDoubleAttempts || 0} | Checkout visits: ${plan.checkoutVisits || 0}`
  );
  const plannedAttempts = Math.max(1, Number(plan.plannedDoubleAttempts || 1));
  lines.push(`Checkout timing: will hit on double dart #${plannedAttempts} (leg ratio ${(100 / plannedAttempts).toFixed(1)}%) | Max double darts available: ${(Number(plan.checkoutVisits||0) * 3)}`);

  lines.push(`Visit: ${visitIndex + 1}/${plan.plannedVisits} | Remaining before visit: ${remainingBefore}`);
  lines.push(`Planned visit total: ${visitTarget} | Scored: ${visitScore}`);
  for (let i = 0; i < Math.min(3, (darts || []).length); i++) {
    const d = darts[i];
    lines.push(`Dart ${i + 1}: ${d.aim} -> ${d.scored}`);
  }
  lines.push(`Checkout attempt: ${attemptedCheckout ? "yes" : "no"} | Darts on doubles: ${countDoubles(darts)}`);
  return lines.join("\n");
}

export function simulateNemesisVisit(ctx) {
  const state = ctx?.state ? ctx.state : ctx;
  const remaining = clampInt(ctx?.remaining ?? state?.leg?.players?.[1]?.score ?? 501, 0, 501);

  const plan = getNemesisLegPlan(state);
  const visitIndex = countBotVisitsInLeg(state);
  const vt = deriveVisitTarget(plan, state, visitIndex);

  const idx = clampInt(visitIndex, 0, plan.visitScores.length - 1);
  const score = clampInt(plan.visitScores[idx], 0, 180);
  const darts = Array.isArray(plan.visitDarts?.[idx]) ? plan.visitDarts[idx] : [
    { aim: "MISS", scored: 0 },
    { aim: "MISS", scored: 0 },
    { aim: "MISS", scored: 0 },
  ];

  const attemptedCheckout = idx >= (plan.checkoutStartIndex ?? plan.plannedVisits - 1);
  const checkoutHit = idx === (plan.checkoutHitIndex ?? plan.plannedVisits - 1);
  const dartsOnDouble = countDoubles(darts);

  // Darts used: scoring visits always use 3; checkout visits stop once the finishing dart lands.
  let dartsUsed = 3;
  if (attemptedCheckout) {
    if (checkoutHit) {
      const finish = Number(plan.finishRemaining ?? 0);
      const hitIdx = darts.findIndex(d => (d?.onDouble === true) && Number(d?.scored ?? 0) === finish);
      dartsUsed = hitIdx >= 0 ? (hitIdx + 1) : 3;
    } else {
      dartsUsed = 3;
    }
  }

  const thought = buildThought({
    plan,
    remainingBefore: remaining,
    visitIndex: idx,
    visitTarget: vt.targetVisitTotal,
    visitScore: score,
    darts,
    attemptedCheckout,
  });

  return {
    score,
    dartsUsed,
    checkoutHit,
    attemptedCheckout,
    checkoutAttemptDartsOnDouble: attemptedCheckout ? dartsOnDouble : 0,
    checkoutDartsOnDouble: attemptedCheckout ? dartsOnDouble : 0,
    thought,
    darts,
  };
}