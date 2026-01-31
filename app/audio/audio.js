// app/audio/audio.js
import { CHECKOUTS } from "../../checkouts.js";
import { BOGEY_NUMBERS } from "../model/constants.js";

// ---------- Audio (Firestore-synced, WebAudio-only, iOS-safe) ----------
let audioCtx;
const bufferCache = new Map();
// Per-src trim metadata computed from decoded buffers.
// { start: seconds, duration: seconds, fullDuration: seconds }
const trimCache = new Map();
let audioUnlocked = false;
let activeSources = [];
let activeSfxSources = [];

// Small, consistent timing tweak between "You require" and the remaining score.
// Negative values start the number slightly earlier to mask any residual MP3 padding.
// (Requested: reduce by another ~0.3s.)
const REQUIRE_TO_NUMBER_GAP_S = 0.0;

// Tighten overall sequencing a touch to avoid perceptible gaps between clips
// caused by MP3 padding / decode jitter.
const INTER_CLIP_OVERLAP_S = 0.08;

// Add a natural pause after number callouts so the cadence feels human.
// (Requested: remove pre-number padding, keep a shorter post-number pause.)
const NUMBER_PAD_BEFORE_S = 0.0;
const NUMBER_PAD_AFTER_S = 0.5;

// For "require" → number timing we rely on trimmed durations (computed from
// decoded audio) rather than a hard cap, to avoid cutting longer recordings.

function ensureAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function computeTrimMeta(buf, srcPath = "") {
  try {
    const sr = buf.sampleRate;
    const n = buf.length;
    if (!sr || !n) return { start: 0, duration: buf.duration, fullDuration: buf.duration };

    // Scan for non-silent content using a chunked max-amplitude envelope.
    // This is more robust than per-sample thresholds when MP3s contain
    // low-level encoder noise, which can otherwise defeat trimming.
    // Default threshold is slightly aggressive to cut leading/trailing padding.
    // Some custom voice lines (notably Nemesis' "requires") can be mastered
    // quieter, which makes aggressive thresholds trim them poorly. Use a
    // slightly lower threshold for that specific clip.
    const isNemesisRequires = String(srcPath || "").includes("/audio/phrases/nemesis_requires.mp3");
    const THRESH = isNemesisRequires ? 0.012 : 0.03;
    const CHUNK = 2048;
    const NEED = isNemesisRequires ? 1 : 2; // consecutive chunks

    // Use channel 0; in practice these clips are mono.
    const ch = buf.getChannelData(0);

    const chunks = Math.ceil(n / CHUNK);
    const env = new Float32Array(chunks);
    for (let c = 0; c < chunks; c++) {
      const a = c * CHUNK;
      const b = Math.min(n, a + CHUNK);
      let m = 0;
      for (let i = a; i < b; i++) {
        const v = Math.abs(ch[i]);
        if (v > m) m = v;
      }
      env[c] = m;
    }

    let startChunk = 0;
    let run = 0;
    for (let c = 0; c < chunks; c++) {
      if (env[c] > THRESH) {
        run++;
        if (run >= NEED) {
          startChunk = Math.max(0, c - run);
          break;
        }
      } else {
        run = 0;
      }
    }

    let endChunk = chunks;
    run = 0;
    for (let c = chunks - 1; c >= 0; c--) {
      if (env[c] > THRESH) {
        run++;
        if (run >= NEED) {
          endChunk = Math.min(chunks, c + run + 1);
          break;
        }
      } else {
        run = 0;
      }
    }

    const startIdx = Math.max(0, Math.min(n, startChunk * CHUNK));
    const endIdx = Math.max(startIdx, Math.min(n, endChunk * CHUNK));

    // Safety: don't allow negative/insane windows.
    if (endIdx <= startIdx) {
      return { start: 0, duration: buf.duration, fullDuration: buf.duration };
    }

    const start = startIdx / sr;
    const duration = (endIdx - startIdx) / sr;

    // Avoid trimming too aggressively on ultra-short clips.
    if (duration < 0.05) {
      return { start: 0, duration: buf.duration, fullDuration: buf.duration };
    }

    return { start, duration, fullDuration: buf.duration };
  } catch {
    return { start: 0, duration: buf?.duration || 0, fullDuration: buf?.duration || 0 };
  }
}

async function loadAudioBuffer(src) {
  if (!src) return null;
  if (bufferCache.has(src)) return bufferCache.get(src);

  const ctx = ensureAudioCtx();

  // Try a small set of candidates (primarily to handle case-insensitive name
  // files) without maintaining legacy/renamed phrase fallbacks.
  const candidates = [];
  const s = String(src);
  candidates.push(s);

  // Also try the same path with/without a leading slash.
  // Depending on hosting base paths, some environments resolve one but not the other.
  if (s.startsWith("/")) candidates.push(s.slice(1));
  else candidates.push("/" + s);


  // Case-insensitive names: try common casing variants.
  // (Static hosts can be case-sensitive, so we probe a few likely filenames.)
  if (s.includes("/audio/names/")) {
    const m = s.match(/^(.*\/audio\/names\/)([^/]+)$/);
    if (m) {
      const prefix = m[1];
      const file = m[2];

      // Preserve URL encoding; operate on the final segment only.
      const extIdx = file.toLowerCase().lastIndexOf(".mp3");
      const stem = extIdx > 0 ? file.slice(0, extIdx) : file;
      const ext = extIdx > 0 ? file.slice(extIdx) : "";

      const title = stem.length ? (stem[0].toUpperCase() + stem.slice(1)) : stem;
      candidates.push(prefix + stem.toLowerCase() + ext);
      candidates.push(prefix + title + ext);
      candidates.push(prefix + stem.toUpperCase() + ext);
    }
  }

  // No other fallbacks: the repo now contains the canonical filenames only.

  for (const cand of candidates) {
    try {
      let res;
      try {
        res = await fetch(cand, { cache: "force-cache" });
      } catch (e) {
        res = await fetch(cand);
      }
      if (!res.ok) continue;
      const arr = await res.arrayBuffer();
      const buf = await ctx.decodeAudioData(arr);
      bufferCache.set(src, buf);
      trimCache.set(src, computeTrimMeta(buf, src));
      return buf;
    } catch (_) {
      // try next candidate
    }
  }

  // Cache null to avoid repeated fetch storms for missing clips.
  bufferCache.set(src, null);
  return null;
}

export function stopAllAudio() {
  for (const s of activeSources) {
    try { s.stop(0); } catch {}
    try { s.disconnect(); } catch {}
  }
  activeSources = [];
}

export function stopAllSfx() {
  for (const s of activeSfxSources) {
    try { s.stop(0); } catch {}
    try { s.disconnect(); } catch {}
  }
  activeSfxSources = [];
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

  // Playback-time substitution (keeps Firestore audio events stable):
  // If a sequence expects a name clip immediately before ThrowFirst, but the
  // name clip does not exist, we must not play ThrowFirst (it starts mid-sentence
  // without a name). Instead, play a generic match start line.
  const adjClips = clips.slice();
  const adjBuffers = buffers.slice();
  for (let i = 0; i < adjClips.length - 1; i++) {
    const a = adjClips[i];
    const b = adjClips[i + 1];
    const aIsName = typeof a === "string" && a.includes("/audio/names/");
    const bIsThrowFirst = typeof b === "string" && (b.endsWith("/audio/phrases/ThrowFirst.mp3") || b.includes("/audio/phrases/ThrowFirst.mp3"));
    if (aIsName && !adjBuffers[i] && bIsThrowFirst) {
      adjClips[i + 1] = "/audio/phrases/match_start.mp3";
      // Ensure the replacement buffer is available.
      adjBuffers[i + 1] = await loadAudioBuffer(adjClips[i + 1]);
    }
  }

  // Schedule back-to-back with the AudioContext clock for gapless playback.
  // NOTE: Some of the "require" phrase clips include a noticeable trailing
  // silence. For the specific QoL case of "You require" immediately followed
  // by a number, we advance time by a shorter amount so the number starts
  // promptly on all devices (including iOS).

  const isRequireClip = (src) => {
    if (typeof src !== "string") return false;
    // Treat Nemesis' custom "requires" line the same as the default require clip
    // for trimming/gap logic.
    return (
      src.endsWith("/audio/phrases/require.mp3") ||
      src.includes("/audio/phrases/require.mp3") ||
      src.endsWith("/audio/phrases/nemesis_requires.mp3") ||
      src.includes("/audio/phrases/nemesis_requires.mp3")
    );
  };

  const isNumberClip = (src) => {
    if (typeof src !== "string") return false;
    return src.includes("/audio/numbers/");
  };

  let t = ctx.currentTime + 0.03;
  for (let i = 0; i < adjBuffers.length; i++) {
    const b = adjBuffers[i];
    const srcPath = adjClips[i];

    // Missing clip (e.g., a name not present yet) → skip without advancing.
    if (!b) continue;

    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);

    // Trim metadata (computed from decoded audio) removes leading/trailing
    // padding for tighter sequencing.
    const trim = trimCache.get(srcPath);

    // If this clip is a number callout, add a natural lead-in pause.
    if (isNumberClip(srcPath)) {
      t += NUMBER_PAD_BEFORE_S;
    }
    if (trim && Number.isFinite(trim.start) && Number.isFinite(trim.duration) && trim.duration > 0) {
      // start(when, offset, duration) to avoid leading/trailing silence.
      s.start(t, trim.start, trim.duration);
    } else {
      s.start(t);
    }
    activeSources.push(s);

    // Default: use full duration
    // Default: advance by trimmed duration if available.
    let advance = (trim && trim.duration) ? trim.duration : b.duration;

    // If this clip is a number callout, add a natural tail pause.
    if (isNumberClip(srcPath)) {
      advance += NUMBER_PAD_AFTER_S;
    }

    // Special-case: "require" phrase → next clip is a number
    if (isRequireClip(srcPath)) {
      const nextSrc = adjClips[i + 1];
      const nextIsNumber = typeof nextSrc === "string" && nextSrc.includes("/audio/numbers/");
      if (nextIsNumber) {
        // Trim metadata already removes trailing silence; we just add the
        // configured gap (often 0) for consistent timing.
        advance = advance + REQUIRE_TO_NUMBER_GAP_S;
      }
    }

    // Slight overlap to mask any tiny device-specific gaps between clips.
    // We only apply overlap when there is another clip following AND neither
    // side is a number callout (numbers intentionally have padding).
    if (i < buffers.length - 1) {
      const nextSrc = adjClips[i + 1];
      const nextIsNumber = isNumberClip(nextSrc);
      if (!isNumberClip(srcPath) && !nextIsNumber) {
        advance = Math.max(0.02, advance - INTER_CLIP_OVERLAP_S);
      }
    }

    t += advance;
  }
}

// One-shot SFX (does not interrupt the main announcement queue)
export async function playSfxWebAudio(src) {
  try {
    const ctx = ensureAudioCtx();
    if (ctx.state === "suspended") {
      try { await ctx.resume(); } catch {}
    }

    const buf = await loadAudioBuffer(src);
    if (!buf) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    s.start(ctx.currentTime + 0.02);
    activeSfxSources.push(s);
    s.onended = () => {
      activeSfxSources = activeSfxSources.filter((x) => x !== s);
      try { s.disconnect(); } catch {}
    };
  } catch (_) {
    // non-fatal
  }
}

export function pad3(n) {
  return String(n).padStart(3, "0");
}

// Candidate clip for a player's display name. If the file does not exist,
// playback will silently skip it.
export function nameClipForDisplayName(name) {
  const cleaned = String(name || "").trim();
  if (!cleaned) return null;
  // We encode the name so spaces/special chars don't break URLs.
  return `/audio/names/${encodeURIComponent(cleaned)}.mp3`;
}

// Whether someone is "on a possible checkout" (your current rules)
export function isPossibleCheckout(remaining, checkOutRule = "double") {
  const r = Number(remaining);
  if (!Number.isFinite(r)) return false;
  if (r <= 1) return false;

  if (checkOutRule === "straight") {
    if (r > 180) return false;
    if (BOGEY_NUMBERS.has(r)) return false;
    return true;
  }

  if (r > 170) return false;
  if (r >= 171 && r <= 180) return false;
  if (BOGEY_NUMBERS.has(r)) return false;
  return Boolean(CHECKOUTS[r]);
}

// Build “Score. (Optional) Require + remaining.”
export function buildVisitClips({ scoreCallType, entered, nextPlayerName, nextRemaining, checkOutRule = "double", nextIsNemesis = false }) {
  const clips = [];

  // score call
  if (scoreCallType === "no_score") {
    clips.push("/audio/phrases/no_score.mp3");
  } else {
    clips.push(`/audio/numbers/${pad3(entered)}.mp3`);
  }

  // require call if next player is on a checkout
  if (isPossibleCheckout(nextRemaining, checkOutRule)) {
    // Name (optional) + "You require" + remaining.
    const nameClip = nextIsNemesis ? null : nameClipForDisplayName(nextPlayerName);
    if (nameClip) clips.push(nameClip);
    clips.push(nextIsNemesis ? "/audio/phrases/nemesis_requires.mp3" : "/audio/phrases/require.mp3");
    clips.push(`/audio/numbers/${pad3(nextRemaining)}.mp3`);
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