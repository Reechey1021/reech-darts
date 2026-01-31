// app/bull/core.js
import { setAudioEvent, nameClipForDisplayName } from "../audio/audio.js";

export function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function initBullState() {
  return {
    enabled: true,
    resolved: false,
    finalized: false,
    p1: null,
    p2: null,
    winner: null,
    d1: null,
    d2: null,
  };
}

export function makeNemesisBullPick(state) {
  // Deterministic within a game: use game id + leg/round for seed if available.
  // Falls back to Math.random in the very unlikely case RNG helper isn't present.
  const target3DA = Number(state?.nemesis?.target3DA ?? 50);

  // Radius is expressed in board-normalized units (0..~0.5).
  // Higher 3DA => tighter circle. Values tuned to feel sensible rather than perfectly physical.
  const band = Math.max(10, Math.min(100, Math.round(target3DA / 10) * 10));
  const RAD_BY_BAND = {
    10: 0.48, // basically anywhere on the board
    20: 0.44,
    30: 0.38,
    40: 0.30, // at least within triples circle from here upwards
    50: 0.24,
    60: 0.20,
    70: 0.16,
    80: 0.12,
    90: 0.09,
    100: 0.07, // slightly larger than bull
  };
  const baseR = RAD_BY_BAND[band] ?? 0.24;

  // Small chance of a wild miss (bigger radius).
  const wildRoll = Math.random();
  const radius = wildRoll < 0.035 ? Math.min(0.62, baseR * 1.8 + 0.15) : baseR;

  // Uniformly random point in circle
  const u = Math.random();
  const v = Math.random();
  const r = Math.sqrt(u) * radius;
  const theta = v * Math.PI * 2;

  const x = 0.5 + r * Math.cos(theta);
  const y = 0.5 + r * Math.sin(theta);

  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}
export function tryResolveBull(state) {
  const bull = state?.match?.bull;
  if (!bull || bull.resolved) return;
  if (!bull.p1 || !bull.p2) return;

  const d1 = dist2(bull.p1.x, bull.p1.y, 0.5, 0.5);
  const d2 = dist2(bull.p2.x, bull.p2.y, 0.5, 0.5);

  bull.d1 = d1;
  bull.d2 = d2;

  let winner = 0;
  if (d2 < d1) winner = 1;
  if (Math.abs(d1 - d2) < 1e-9) winner = Math.random() < 0.5 ? 0 : 1;

  bull.winner = winner;
  bull.resolved = true;

  state.match.starterLeg1 = winner;
  if (state.leg) state.leg.currentPlayer = winner;

}


export function finalizeBull(state) {
  const bull = state?.match?.bull;
  if (!bull || !bull.resolved) return;
  if (bull.finalized) return;
  bull.finalized = true;
  // Match start after player acknowledges result
  const starter = Number(state?.match?.starterLeg1);
  const starterName = (state?.match?.players?.[starter]?.name) || "";
  const clips = [];
  const isNemesisGame = state?.nemesis?.enabled === true;
  if (isNemesisGame && starter === 1) {
    clips.push("/audio/phrases/nemesis_gameon.mp3");
  } else {
  const nameClip = nameClipForDisplayName(starterName);
  if (nameClip) {
    clips.push(nameClip);
    clips.push("/audio/phrases/ThrowFirst.mp3");
  } else {
    clips.push("/audio/phrases/match_start.mp3");
  }
  }
  setAudioEvent(state, clips);
}