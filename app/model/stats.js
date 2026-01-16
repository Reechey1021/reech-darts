// app/model/stats.js

export function calcLegStats(leg, playerIndex) {
  const visits = (leg.history || []).filter((h) => h.player === playerIndex);
  if (visits.length === 0) {
    return { points: 0, darts: 0, first9Points: 0, first9Darts: 0, hs: 0 };
  }

  let points = 0;
  let darts = 0;
  let hs = 0;

  for (const v of visits) {
    const dartsUsed = Number.isFinite(v.dartsUsed) ? v.dartsUsed : 3;
    darts += dartsUsed;
    hs = Math.max(hs, v.entered);
    if (!v.bust) points += v.entered;
  }

  const first3 = visits.slice(0, 3);
  let first9Points = 0;
  let first9Darts = 0;
  for (const v of first3) {
    const dartsUsed = Number.isFinite(v.dartsUsed) ? v.dartsUsed : 3;
    first9Darts += dartsUsed;
    if (!v.bust) first9Points += v.entered;
  }

  return { points, darts, first9Points, first9Darts, hs };
}

export function format3DA(points, darts) {
  if (!darts) return 0;
  return Math.round((points / darts) * 3);
}

export function formatPills(stats) {
  const tda = format3DA(stats.points, stats.darts);
  const f9d = stats.first9Darts ? Math.round((stats.first9Points / stats.first9Darts) * 3) : 0;
  const hs = stats.hs || 0;
  return { tda, f9d, hs };
}

export function calcMatchStats(match) {
  const totals = [
    { points: 0, darts: 0, first9Points: 0, first9Darts: 0, hs: 0 },
    { points: 0, darts: 0, first9Points: 0, first9Darts: 0, hs: 0 },
  ];

  for (const legSum of match.legs || []) {
    for (let p = 0; p < 2; p++) {
      const s = legSum.players[p];
      totals[p].points += s.points;
      totals[p].darts += s.darts;
      totals[p].first9Points += s.first9Points;
      totals[p].first9Darts += s.first9Darts;
      totals[p].hs = Math.max(totals[p].hs, s.hs);
    }
  }

  return totals;
}
