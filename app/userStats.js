// app/userStats.js
// Profile statistics updates (competitive matches only).

import { calcMatchStats } from "./model/stats.js";

function emptyAgg() {
  return {
    matches: 0,
    wins: 0,
    losses: 0,
    legsWon: 0,
    legsLost: 0,
    highestScore: 0,
    totalPoints: 0,
    totalDarts: 0,
    totalFirst9Points: 0,
    totalFirst9Darts: 0,
    total100s: 0,
    total140s: 0,
    total180s: 0,
    lifetimeDarts: 0,
    recentResults: [], // "W" / "L"
  };
}

function pushRecent(arr, val, max = 5) {
  const next = Array.isArray(arr) ? arr.slice() : [];
  next.unshift(val);
  return next.slice(0, max);
}

export async function applyCompetitiveMatchToProfilesTx(tx, db, match) {
  if (!match || match.status !== "finished") return;
  if (match.competition !== "competitive") return;

  const totals = calcMatchStats(match);

  for (let p = 0; p < 2; p++) {
    const uid = match.players?.[p]?.uid;
    if (!uid) continue; // guests don't get stored

    const ref = db.collection("users").doc(uid);
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : {};
    const stats = existing.stats || emptyAgg();

    const won = match.winner === p;
    const opp = 1 - p;

    const t = totals[p] || {
      points: 0,
      darts: 0,
      first9Points: 0,
      first9Darts: 0,
      hs: 0,
      c100: 0,
      c140: 0,
      c180: 0,
    };

    const next = {
      ...stats,
      matches: (stats.matches || 0) + 1,
      wins: (stats.wins || 0) + (won ? 1 : 0),
      losses: (stats.losses || 0) + (won ? 0 : 1),
      legsWon: (stats.legsWon || 0) + (match.legsWon?.[p] || 0),
      legsLost: (stats.legsLost || 0) + (match.legsWon?.[opp] || 0),
      highestScore: Math.max(Number(stats.highestScore || 0), Number(t.hs || 0)),
      totalPoints: (stats.totalPoints || 0) + (t.points || 0),
      totalDarts: (stats.totalDarts || 0) + (t.darts || 0),
      totalFirst9Points: (stats.totalFirst9Points || 0) + (t.first9Points || 0),
      totalFirst9Darts: (stats.totalFirst9Darts || 0) + (t.first9Darts || 0),
      total100s: (stats.total100s || 0) + (t.c100 || 0),
      total140s: (stats.total140s || 0) + (t.c140 || 0),
      total180s: (stats.total180s || 0) + (t.c180 || 0),
      recentResults: pushRecent(stats.recentResults, won ? "W" : "L"),
    };

    tx.set(ref, { stats: next, updatedAt: new Date() }, { merge: true });
  }
}

// Counts darts thrown across ALL match types (casual + competitive).
// This is stored separately so it doesn't get filtered by game mode.
export async function applyLifetimeDartsToProfilesTx(tx, db, match) {
  if (!match || match.status !== "finished") return;

  const totals = calcMatchStats(match);

  for (let p = 0; p < 2; p++) {
    const uid = match.players?.[p]?.uid;
    if (!uid) continue; // guests don't get stored

    const ref = db.collection("users").doc(uid);
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : {};
    const stats = existing.stats || emptyAgg();

    const t = totals[p] || { darts: 0 };

    const next = {
      ...stats,
      lifetimeDarts: (stats.lifetimeDarts || 0) + (t.darts || 0),
    };

    tx.set(ref, { stats: next, updatedAt: new Date() }, { merge: true });
  }
}

export function formatProfileStats(stats) {
  const s = stats || {};
  const totalPoints = Number(s.totalPoints || 0);
  const totalDarts = Number(s.totalDarts || 0);
  const tda = totalDarts ? Math.round((totalPoints / totalDarts) * 3) : 0;

  const f9p = Number(s.totalFirst9Points || 0);
  const f9d = Number(s.totalFirst9Darts || 0);
  const f9 = f9d ? Math.round((f9p / f9d) * 3) : 0;

  const total100s = Number(s.total100s || 0);
  const total140s = Number(s.total140s || 0);
  const total180s = Number(s.total180s || 0);
  const lifetimeDarts = Number(s.lifetimeDarts || 0);

  return {
    matches: Number(s.matches || 0),
    wins: Number(s.wins || 0),
    losses: Number(s.losses || 0),
    legsWon: Number(s.legsWon || 0),
    legsLost: Number(s.legsLost || 0),
    highestScore: Number(s.highestScore || 0),
    tda,
    f9,
    total100s,
    total140s,
    total180s,
    lifetimeDarts,
    recent: Array.isArray(s.recentResults) ? s.recentResults : [],
  };
}
