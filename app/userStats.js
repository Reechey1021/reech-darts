// app/userStats.js
// Profile statistics updates (competitive matches only).

import { calcMatchStats } from "./model/stats.js";

// Dev-only logging for profile stat writes.
// Flip to false when you're done debugging.
const DEV_STATS_LOG = true;
function logStats(...args) {
  if (DEV_STATS_LOG) console.log("[STATS]", ...args);
}

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
    checkoutDoublesThrown: 0,
    checkoutDoublesHit: 0,
    recentResults: [], // "W" / "L"
  };
}


function dayKey(ts) {
  const d = new Date(ts || Date.now());
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function bumpDailyAgg(daily, key, delta) {
  const next = daily ? { ...daily } : {};
  const cur = next[key] || { matches: 0, tdaSum: 0, tdaCount: 0, f9dSum: 0, f9dCount: 0, checkoutPctSum: 0, checkoutPctCount: 0 };
  next[key] = {
    matches: (cur.matches || 0) + (delta.matches || 0),
    tdaSum: (cur.tdaSum || 0) + (delta.tdaSum || 0),
    tdaCount: (cur.tdaCount || 0) + (delta.tdaCount || 0),
    f9dSum: (cur.f9dSum || 0) + (delta.f9dSum || 0),
    f9dCount: (cur.f9dCount || 0) + (delta.f9dCount || 0),
    checkoutPctSum: (cur.checkoutPctSum || 0) + (delta.checkoutPctSum || 0),
    checkoutPctCount: (cur.checkoutPctCount || 0) + (delta.checkoutPctCount || 0),
  };
  // trim to last ~400 days
  const keys = Object.keys(next).sort();
  if (keys.length > 420) {
    for (let i = 0; i < keys.length - 420; i++) delete next[keys[i]];
  }
  return next;
}
function pushRecent(arr, val, max = 5) {
  const next = Array.isArray(arr) ? arr.slice() : [];
  next.unshift(val);
  return next.slice(0, max);
}


function sumCheckoutFromLegs(match, pIndex) {
  const legs = Array.isArray(match?.legs) ? match.legs : [];
  let thrown = 0;
  let hit = 0;
  for (const leg of legs) {
    const ps = leg?.players?.[pIndex];
    if (!ps) continue;
    thrown += Number(ps.checkoutDoublesThrown || 0);
    hit += Number(ps.checkoutDoublesHit || 0);
  }
  return { thrown, hit };
}


export async function applyCompetitiveMatchToProfilesTx(tx, db, match) {
  if (!match || match.status !== "finished") return;
  if (match.competition !== "competitive") return;

  const totals = calcMatchStats(match);

  // Firestore transactions require ALL reads to happen before ANY writes.
  // So we read both user docs first, then perform the writes.
  const players = [];
  for (let p = 0; p < 2; p++) {
    const uid = match.players?.[p]?.uid;
    if (!uid) continue; // guests don't get stored
    const ref = db.collection("users").doc(uid);
    const snap = await tx.get(ref);
    players.push({ p, uid, ref, snap });
  }

  for (const item of players) {
    const p = item.p;
    const existing = item.snap.exists ? item.snap.data() : {};
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

    tx.set(item.ref, { stats: next, updatedAt: new Date() }, { merge: true });
  }
}

// Writes ALL finished-match profile updates in a single transaction pass.
// This avoids Firestore's "all reads must happen before any writes" rule when
// combining multiple stat updaters.
export async function applyFinishedMatchProfileUpdatesTx(tx, db, match) {
  if (!match || match.status !== "finished") return;

  const totals = calcMatchStats(match);
  const isCompetitive = match.competition === "competitive";

  // 1) READ all user docs first
  const players = [];
  for (let p = 0; p < 2; p++) {
    const uid = match.players?.[p]?.uid;
    if (!uid) continue; // guests don't get stored
    const ref = db.collection("users").doc(uid);
    const snap = await tx.get(ref);
    players.push({ p, uid, ref, snap });
  }

  if (players.length) {
    logStats("Applying finished-match profile updates", {
      competition: match.competition,
      gameType: match.gameType,
      winner: match.winner,
      uids: players.map((x) => x.uid),
    });
  }

  // 2) WRITE after all reads
  for (const item of players) {
    const p = item.p;
    const existing = item.snap.exists ? item.snap.data() : {};
    const stats = existing.stats || emptyAgg();

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

    // Always track lifetime darts across ALL modes
    let next = {
      ...stats,
      lifetimeDarts: (stats.lifetimeDarts || 0) + (t.darts || 0),
    };

    if (isCompetitive) {
      const won = match.winner === p;
      const opp = 1 - p;
      next = {
        ...next,
        matches: (next.matches || 0) + 1,
        wins: (next.wins || 0) + (won ? 1 : 0),
        losses: (next.losses || 0) + (won ? 0 : 1),
        legsWon: (next.legsWon || 0) + (match.legsWon?.[p] || 0),
        legsLost: (next.legsLost || 0) + (match.legsWon?.[opp] || 0),
        highestScore: Math.max(Number(next.highestScore || 0), Number(t.hs || 0)),
        totalPoints: (next.totalPoints || 0) + (t.points || 0),
        totalDarts: (next.totalDarts || 0) + (t.darts || 0),
        totalFirst9Points: (next.totalFirst9Points || 0) + (t.first9Points || 0),
        totalFirst9Darts: (next.totalFirst9Darts || 0) + (t.first9Darts || 0),
        total100s: (next.total100s || 0) + (t.c100 || 0),
        total140s: (next.total140s || 0) + (t.c140 || 0),
        total180s: (next.total180s || 0) + (t.c180 || 0),
        recentResults: pushRecent(next.recentResults, won ? "W" : "L"),
      };
    }

    logStats("Writing stats", item.uid, {
      competitive: isCompetitive,
      lifetimeDarts: next.lifetimeDarts,
      matches: next.matches,
      wins: next.wins,
      losses: next.losses,
    });

    tx.set(item.ref, { stats: next, updatedAt: new Date() }, { merge: true });
  }
}

// Counts darts thrown across ALL match types (casual + competitive).
// This is stored separately so it doesn't get filtered by game mode.
export async function applyLifetimeDartsToProfilesTx(tx, db, match) {
  if (!match || match.status !== "finished") return;

  const totals = calcMatchStats(match);

  // Same transaction read-before-write rule here.
  const players = [];
  for (let p = 0; p < 2; p++) {
    const uid = match.players?.[p]?.uid;
    if (!uid) continue;
    const ref = db.collection("users").doc(uid);
    const snap = await tx.get(ref);
    players.push({ p, uid, ref, snap });
  }

  for (const item of players) {
    const p = item.p;
    const existing = item.snap.exists ? item.snap.data() : {};
    const stats = existing.stats || emptyAgg();

    const t = totals[p] || { darts: 0 };

    const next = {
      ...stats,
      lifetimeDarts: (stats.lifetimeDarts || 0) + (t.darts || 0),
    };

    tx.set(item.ref, { stats: next, updatedAt: new Date() }, { merge: true });
  }
}

function tsToKey(ts) {
  // Firestore Timestamp (seconds/nanos), Date, or number
  if (!ts) return "";
  if (typeof ts === "number") return String(ts);
  if (ts instanceof Date) return String(ts.getTime());
  if (typeof ts.seconds === "number") return String(ts.seconds);
  // sometimes timestamps are serialized
  if (typeof ts._seconds === "number") return String(ts._seconds);
  return "";
}

// Apply finished-match profile stats for the CURRENT signed-in user only.
// This is necessary because Firestore rules typically only allow a user to
// write their own /users/{uid} document.
//
// This function is designed to be called by the realtime listener when
// it observes match.status === "finished".
function presetLabelFromRules(rules) {
  const p = (rules && rules.preset) ? String(rules.preset) : "custom";
  switch (p) {
    case "grand_prix": return "GP";
    case "x01": return "X01";
    case "straight_in_out": return "SISO";
    default: return "Custom";
  }
}


function computeFirst9AvgFromTotals(tot) {
  const p = Number(tot.first9Points || 0);
  const d = Number(tot.first9Darts || 0);
  if (!d) return 0;
  return Math.round((p / d) * 3);
}

function computeCheckoutPctFromLegs(match, playerIndex) {
  const legs = Array.isArray(match?.legs) ? match.legs : [];
  let thrown = 0;
  let hit = 0;
  for (const leg of legs) {
    const ps = leg?.players?.[playerIndex];
    if (!ps) continue;
    thrown += Number(ps.checkoutDoublesThrown || 0);
    hit += Number(ps.checkoutDoublesHit || 0);
  }
  return thrown ? Math.round((hit / thrown) * 100) : 0;
}
function computeThreeDartAvgFromTotals(t) {
  const darts = Number(t?.darts || 0);
  const points = Number(t?.points || 0);
  if (!darts) return 0;
  return (points / darts) * 3;
}

// Apply finished-match profile stats for the CURRENT signed-in user only.
// This is necessary because Firestore rules typically only allow a user to
// write their own /users/{uid} document.
//
// This function is designed to be called by the realtime listener when
// it observes match.status === "finished".
export async function applyFinishedMatchProfileUpdatesForMe(db, uid, gameId, match) {
  if (!uid) return; // guests
  if (!match || match.status !== "finished") return;

  const pIndex = match.players?.findIndex((p) => p?.uid === uid);
  if (pIndex == null || pIndex < 0) {
    logStats("Skip stats (uid not in match)", { uid, gameId });
    return;
  }

  const isCompetitive = match.competition === "competitive";
  const totals = calcMatchStats(match);
  const t = totals?.[pIndex] || {
    points: 0,
    darts: 0,
    first9Points: 0,
    first9Darts: 0,
    hs: 0,
    c100: 0,
    c140: 0,
    c180: 0,
  };

  // Prevent double-application on reload.
  // We use a stable key derived from gameId + match createdAt.
  const matchKey = `${gameId || ""}:${tsToKey(match.createdAt)}`;
  const doneKey = `statsApplied:${uid}:${matchKey}`;
  if (localStorage.getItem(doneKey) === "1") {
    logStats("Skip stats (already applied)", { uid, matchKey });
    return;
  }

  await db.runTransaction(async (tx) => {
    const ref = db.collection("users").doc(uid);
    const snap = await tx.get(ref);
    const existing = snap.exists ? snap.data() : {};
    const stats = existing.stats || emptyAgg();

    // Always track lifetime darts across ALL modes
    let next = {
      ...stats,
      lifetimeDarts: (stats.lifetimeDarts || 0) + (t.darts || 0),
    };

    // Competitive-only aggregates (your existing rule)
    if (isCompetitive) {
      const won = match.winner === pIndex;
      const opp = 1 - pIndex;

      next = {
        ...next,
        matches: (next.matches || 0) + 1,
        wins: (next.wins || 0) + (won ? 1 : 0),
        losses: (next.losses || 0) + (won ? 0 : 1),
        legsWon: (next.legsWon || 0) + (match.legsWon?.[pIndex] || 0),
        legsLost: (next.legsLost || 0) + (match.legsWon?.[opp] || 0),
        highestScore: Math.max(Number(next.highestScore || 0), Number(t.hs || 0)),
        totalPoints: (next.totalPoints || 0) + (t.points || 0),
        totalDarts: (next.totalDarts || 0) + (t.darts || 0),
        totalFirst9Points: (next.totalFirst9Points || 0) + (t.first9Points || 0),
        totalFirst9Darts: (next.totalFirst9Darts || 0) + (t.first9Darts || 0),
        total100s: (next.total100s || 0) + (t.c100 || 0),
        total140s: (next.total140s || 0) + (t.c140 || 0),
        total180s: (next.total180s || 0) + (t.c180 || 0),
        recentResults: pushRecent(next.recentResults, won ? "W" : "L"),
      };

      // Checkout % support (tracked double-out matches only, competitive only)
      const rules = match.rules || {};
      const trackCheckout = !!rules.trackCheckoutStats && rules.checkOut === "double";
      if (trackCheckout) {
        const sums = sumCheckoutFromLegs(match, pIndex);
        next.checkoutDoublesThrown = (next.checkoutDoublesThrown || 0) + sums.thrown;
        next.checkoutDoublesHit = (next.checkoutDoublesHit || 0) + sums.hit;
      }
    }

    // Match history: store for BOTH casual + competitive so the dashboard list works.
    // This is lightweight (10 rows) and uses the same single user-doc write as above.
    const oppIndex = 1 - pIndex;
    const oppPlayer = match.players?.[oppIndex] || {};
    const wonNow = match.winner === pIndex;

    const legsMe = Number(match.legsWon?.[pIndex] || 0);
    const legsOpp = Number(match.legsWon?.[oppIndex] || 0);
    const scoreline = `${legsMe}-${legsOpp}`;

    const rules = match.rules || {};
    const mode = (match.gameMeta && String(match.gameMeta).trim())
      ? String(match.gameMeta).trim()
      : presetLabelFromRules(rules);

    const entry = {
      matchKey,
      result: wonNow ? "W" : "L",
      scoreline,
      mode,
      competition: isCompetitive ? "Competitive" : "Casual",
      opponentUid: oppPlayer.uid || null,
      opponentName: oppPlayer.name || "Opponent",
      // Avatars: follow the same fallback chain used in-game.
      // Some matches store avatars on seat1PhotoURL/seat2PhotoURL rather than players[].photoURL.
      opponentAvatar:
        (oppPlayer.photoURL || oppPlayer.photoUrl || oppPlayer.photo || null) ||
        (oppIndex === 0 ? (match.seat1PhotoURL || null) : (match.seat2PhotoURL || null)) ||
        null,
      threeDartAvg: computeThreeDartAvgFromTotals(t),
      first9Avg: computeFirst9AvgFromTotals(t),
      checkoutPct: computeCheckoutPctFromLegs(match, pIndex),
      finishedAt: Date.now(),
    };

    const hist = Array.isArray(next.matchHistory) ? next.matchHistory.slice() : [];
    // De-dupe by matchKey
    const filtered = hist.filter((x) => x && x.matchKey !== matchKey);
    filtered.unshift(entry);
    next.matchHistory = filtered.slice(0, 10);

    // Daily aggregates for Stats History (small, long-lived; avoids storing full match logs)
    const kDay = dayKey(entry.finishedAt);
    next.dailyAgg = bumpDailyAgg(next.dailyAgg, kDay, {
      matches: 1,
      tdaSum: Number(entry.threeDartAvg || 0),
      tdaCount: 1,
      f9dSum: Number(entry.first9Avg || 0),
      f9dCount: 1,
      checkoutPctSum: Number(entry.checkoutPct || 0),
      checkoutPctCount: 1,
    });


    logStats("Write my stats + matchHistory", {
      uid,
      gameId,
      matchKey,
      competitive: isCompetitive,
      lifetimeAdded: t.darts || 0,
      matches: next.matches,
      wins: next.wins,
      losses: next.losses,
      historyLen: next.matchHistory.length,
    });

    tx.set(ref, { stats: next, updatedAt: new Date() }, { merge: true });
  });

  localStorage.setItem(doneKey, "1");
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
