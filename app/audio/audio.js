// app/audio/audio.js
import { CHECKOUTS } from "../../checkouts.js";
import { BOGEY_NUMBERS } from "../model/constants.js";

// ---------- Audio (Firestore-synced, WebAudio-only, iOS-safe) ----------
let audioCtx;
const bufferCache = new Map();
let audioUnlocked = false;
let activeSources = [];

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

async function loadAudioBuffer(src) {
  if (bufferCache.has(src)) return bufferCache.get(src);

  const ctx = ensureAudioCtx();
  const res = await fetch(src, { cache: "force-cache" });
  const arr = await res.arrayBuffer();
  const buf = await ctx.decodeAudioData(arr);

  bufferCache.set(src, buf);
  return buf;
}

export function stopAllAudio() {
  for (const s of activeSources) {
    try { s.stop(0); } catch {}
    try { s.disconnect(); } catch {}
  }
  activeSources = [];
}

// IMPORTANT: must be called from a user gesture at least once on iOS
export async function unlockAudioOnce() {
  if (audioUnlocked) return;
  audioUnlocked = true;

  const ctx = ensureAudioCtx();
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch {}
  }

  // silent tick (reliably unlocks iOS)
  const buffer = ctx.createBuffer(1, 1, 22050);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
}

export async function playClipsWebAudio(clips) {
  if (!Array.isArray(clips) || clips.length === 0) return;

  const ctx = ensureAudioCtx();
  if (ctx.state === "suspended") {
    try { await ctx.resume(); } catch {}
  }

  stopAllAudio();

  // Load first, THEN schedule (prevents “2nd clip never plays” on iOS)
  const buffers = await Promise.all(clips.map(loadAudioBuffer));

  let t = ctx.currentTime + 0.03;
  for (const b of buffers) {
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(t);
    activeSources.push(s);
    t += b.duration;
  }
}

export function pad3(n) {
  return String(n).padStart(3, "0");
}

export function requireClipForName(name) {
  const cleaned = (name || "").trim();
  if (cleaned === "Richard") return "./audio/phrases/require_richard.mp3";
  if (cleaned === "Kameron") return "./audio/phrases/require_kameron.mp3";
  if (cleaned === "Marie") return "./audio/phrases/require_marie.mp3";
  return "./audio/phrases/require.mp3";
}

// Whether someone is "on a possible checkout" (your current rules)
export function isPossibleCheckout(remaining) {
  const r = Number(remaining);
  if (!Number.isFinite(r)) return false;
  if (r <= 1) return false;
  if (r > 170) return false;
  if (r >= 171 && r <= 180) return false;
  if (BOGEY_NUMBERS.has(r)) return false;
  return Boolean(CHECKOUTS[r]);
}

// Build “Score. (Optional) Require + remaining.”
export function buildVisitClips({ scoreCallType, entered, nextPlayerName, nextRemaining }) {
  const clips = [];

  // score call
  if (scoreCallType === "no_score") {
    clips.push("./audio/phrases/no_score.mp3");
  } else {
    clips.push(`./audio/numbers/${pad3(entered)}.mp3`);
  }

  // require call if next player is on a checkout
  if (isPossibleCheckout(nextRemaining)) {
    clips.push(requireClipForName(nextPlayerName));
    clips.push(`./audio/numbers/${pad3(nextRemaining)}.mp3`);
  }

  return clips;
}

export function setAudioEvent(state, clips) {
  state.audio = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    clips,
    at: new Date(),
  };
}
