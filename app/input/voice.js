// app/input/voice.js
// Best-effort voice scoring.
// Primary: Web Speech API (Chrome/Edge).
// Fallback: Whisper in-browser (Transformers.js / WASM) for broader compatibility (e.g., Opera/Firefox/Safari).
//
// Notes:
// - Web Speech recognition is not consistently available across Chromium forks (Opera GX, etc.)
// - Whisper fallback runs on the user's device CPU (no backend, no per-minute costs), but the first load is heavier.

import { app } from "../state.js";
import { submitScore } from "../actions.js";
import { canScoreNow } from "../permissions.js";
import { showError } from "../ui/render.js";


// -----------------------------
// Turn gating (online, mutual control OFF)
// -----------------------------
let pausedForTurn = false;
let turnOverlayObserver = null;

function isTurnGatingActive() {
  const st = app.latestState;
  return st?.match?.gameType === "online" && !st?.match?.allowMutualControl;
}

// Future-proof primary signal: if #turnOverlay is visible (NOT .hidden), it is NOT your turn.
function overlayBlocksTurn() {
  const overlay = document.getElementById("turnOverlay");
  if (!overlay) return null; // unknown
  return !overlay.classList.contains("hidden");
}

function isVoiceAllowedNow() {
  if (!isTurnGatingActive()) return true;

  const overlayBlocked = overlayBlocksTurn();
  if (overlayBlocked === true) return false;

  // If overlay is missing or hidden, fall back to rules-based check.
  return canScoreNow(app.latestState);
}

function stopWhisperCaptureOnly() {
  // Stop capture graph without transcribing (used when pausing for turn).
  clearWhisperTimers();
  whisperIsRecording = false;

  try { whisperProcessor?.disconnect?.(); } catch (_) {}
  try { whisperSource?.disconnect?.(); } catch (_) {}
  whisperProcessor = null;
  whisperSource = null;

  whisperPcmChunks = [];
  try { whisperAudioCtx?.close?.(); } catch (_) {}
  whisperAudioCtx = null;

  setMicVisual(false);
}

function applyTurnGate() {
  if (app.inputMode !== "voice") return;
  if (!wantListening) return;

  const allowed = isVoiceAllowedNow();

  if (!allowed) {
    pausedForTurn = true;
    // Hard stop listening while not your turn.
    if (activeEngine === "webspeech") {
      stopWebSpeech(true); // soft stop (keep wantListening)
    } else if (activeEngine === "whisper") {
      if (whisperIsRecording) stopWhisperCaptureOnly();
    }
    setMicVisual(false);
    setVoiceStatus("Waiting for your turn…");
    return;
  }

  // allowed
  if (pausedForTurn) {
    pausedForTurn = false;
    // Resume if still in voice mode + user wants listening.
    if (activeEngine === "webspeech") {
      // Web Speech can be touchy if restarted immediately after stop; give it a brief moment.
      clearWebSpeechTimers();
      restartTimer = setTimeout(() => {
        if (!wantListening || app.inputMode !== "voice" || pausedForTurn || !isVoiceAllowedNow()) return;
        startWebSpeech(true);
      }, 300);
      return;
    }
    startVoiceAuto();
  }
}

function setupTurnOverlayObserver() {
  if (turnOverlayObserver) return;

  const overlay = document.getElementById("turnOverlay");
  if (!overlay) return;

  turnOverlayObserver = new MutationObserver(() => {
    applyTurnGate();
  });
  turnOverlayObserver.observe(overlay, { attributes: true, attributeFilter: ["class"] });
}

// -----------------------------
// Engine selection
// -----------------------------
function isOperaGX() {
  const ua = navigator.userAgent || "";
  return /OPR\//.test(ua);
}

function getSpeechRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function isSpeechRecognitionAllowedOrigin() {
  // SpeechRecognition is generally restricted to secure contexts.
  if (window.isSecureContext) return true;

  const host = (window.location.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  if (host.endsWith(".localhost")) return true;
  return false;
}

function supportsWhisperFallback() {
  return !!window.WebAssembly &&
    !!(window.AudioContext || window.webkitAudioContext) &&
    !!navigator.mediaDevices?.getUserMedia &&
    true;
}


const WAKE_WORDS = ["score", "school", "sore", "scored", "scores", "call"];
// -----------------------------
// Parsing
// -----------------------------
const DIGIT_WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

const SMALL = {
  zero: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const PHRASE_OVERRIDES = new Map([
  ["one eighty", 180],
  ["a hundred and eighty", 180],
  ["one hundred and eighty", 180],
  ["one hundred eighty", 180],
  ["hundred and eighty", 180],
  ["hundred eighty", 180],
]);

function normalizeTranscript(raw) {
  return (raw || "")
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function normalizeBritishDigitHomophones(text) {
  // Convert common British-accent homophones ONLY when they appear in a numeric context
  // to avoid mangling normal sentences.
  // Examples: "one for zero" -> "one four zero"; "score a zero" -> "score eight zero"
  const toks = (text || "").split(" ").filter(Boolean);
  const isNumericish = (w) => (
    /^\d+$/.test(w) ||
    (w in DIGIT_WORDS) ||
    (w in SMALL) ||
    (w in TENS)
  );
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    const prev = toks[i - 1] || "";
    const next = toks[i + 1] || "";
    const nearNumber = isNumericish(prev) || isNumericish(next);

    // Careful, context-gated homophones:
    if (w === "for" && nearNumber) { out.push("four"); continue; }
    if (w === "too" && nearNumber) { out.push("two"); continue; }
    if (w === "free" && nearNumber) { out.push("three"); continue; }
    if (w === "ate" && nearNumber) { out.push("eight"); continue; }
    if (w === "a" && nearNumber) { out.push("eight"); continue; }
    if (w === "Xero" && nearNumber) { out.push("zero"); continue; }
    if (w === "Siri" && nearNumber) { out.push("zero"); continue; }

    out.push(w);
  }
  return out.join(" ");
}

function parseSpokenDigits(words) {
  // e.g. "one seven two" => 172, "1 7 2" => 172, "four 5" => 45
  if (words.length < 2 || words.length > 3) return null;
  const digits = [];
  for (const w of words) {
    if (/^\d$/.test(w)) {
      digits.push(Number(w));
      continue;
    }
    if (!(w in DIGIT_WORDS)) return null;
    digits.push(DIGIT_WORDS[w]);
  }
  const n = Number(digits.join(""));
  return Number.isFinite(n) ? n : null;
}

function parseNumberWords(words) {
  // Minimal number-word parser for 0..180
  if (!words.length) return null;

  let current = 0;
  for (const w of words) {
    if (w === "hundred") {
      if (current === 0) current = 1;
      current *= 100;
      continue;
    }
    if (w in SMALL) { current += SMALL[w]; continue; }
    if (w in TENS) { current += TENS[w]; continue; }
    return null;
  }
  return current;
}

export function parseSpokenScore(rawTranscript) {
  let t = normalizeTranscript(rawTranscript);
  if (activeEngine === "whisper") {
    t = normalizeBritishDigitHomophones(t);
  }
  if (!t) return null;

  // Whisper (and some other engines) may return digit-by-digit transcripts like:
  // "1-1-7" → normalized to "1 1 7"
  // In darts context, treat sequences of single digits as a single number: "1 1 7" → 117, "2 5" → 25.
  const tokens = t.split(" ").filter(Boolean);
  if (
    tokens.length >= 2 &&
    tokens.length <= 3 &&
    tokens.every((w) => /^\d$/.test(w))
  ) {
    const n = Number(tokens.join(""));
    if (Number.isFinite(n)) return n;
  }

  const m = t.match(/\b(\d{1,3})\b/);
  if (m) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }

  if (PHRASE_OVERRIDES.has(t)) return PHRASE_OVERRIDES.get(t);

  const words = tokens;

  const digits = parseSpokenDigits(words);
  if (digits !== null) return digits;

  return parseNumberWords(words);
}

// -----------------------------
// UI helpers
// -----------------------------
let lastHeard = "";
function setVoiceStatus(text) {
  const el = document.getElementById("voiceStatus");
  if (el) el.textContent = text;
}
function setHeard(text) {
  lastHeard = text || "";
  const el = document.getElementById("voiceHeard");
  if (el) el.textContent = lastHeard;
}
function setVoiceEngine(text) {
  const el = document.getElementById("voiceEngine");
  if (el) el.textContent = text || "";
}

function setMicVisual(active, labelOverride = null) {
  const btn = document.getElementById("voiceMicBtn");
  if (!btn) return;

  btn.classList.toggle("isListening", !!active);
  btn.setAttribute("aria-pressed", active ? "true" : "false");

  const label = btn.querySelector(".voiceMicLabel");
  if (label) label.textContent = labelOverride || (active ? "Say 'Score' followed by a number." : "Tap & Speak");
}

// -----------------------------
// Web Speech engine
// -----------------------------
let rec = null;
let wantListening = false;
let isStarting = false;
let startTimer = null;
let restartTimer = null;
let lastError = null;
let isStopping = false;
let webSpeechRunning = false;

function clearWebSpeechTimers() {
  try { if (startTimer) clearTimeout(startTimer); } catch (_) {}
  try { if (restartTimer) clearTimeout(restartTimer); } catch (_) {}
  startTimer = null;
  restartTimer = null;
}

function safeStopWebSpeech() { try { rec?.stop?.(); } catch (_) {} }
function safeAbortWebSpeech() { try { rec?.abort?.(); } catch (_) {} }

function teardownWebSpeech() {
  if (!rec) return;
  try { rec.onstart = rec.onend = rec.onerror = rec.onresult = null; } catch (_) {}
  rec = null;
}

function buildWebSpeechRecognizer() {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) return null;

  const r = new Ctor();
  r.lang = "en-GB";
  r.interimResults = true;
  r.maxAlternatives = 1;
  r.continuous = false;

  r.onstart = () => {
    webSpeechRunning = true;
    clearWebSpeechTimers();
    isStarting = false;
    lastError = null;
    setMicVisual(true, "Say 'Score' followed by a number.");
    setVoiceStatus("Say 'Score' followed by a number.");
    setHeard("");
  };

  r.onerror = (e) => {
    clearWebSpeechTimers();
    isStarting = false;
    webSpeechRunning = false;
    lastError = e?.error || "unknown";

    // If we intentionally stopped/aborted, ignore spurious errors so we don't overwrite
    // useful UI like "Logged 60".
    if (isStopping || lastError === "aborted") return;

    setMicVisual(false);
    // Keep always-on listening for transient errors (e.g., no-speech/network).
    // Only stop the loop for hard failures like permission denial.

    if (lastError === "not-allowed" || lastError === "service-not-allowed") {
      wantListening = false;
      setVoiceStatus("Microphone access denied");
    } else if (lastError === "no-speech") {
      setVoiceStatus("No speech detected");
    } else if (lastError === "audio-capture") {
      wantListening = false;
      setVoiceStatus("No microphone found");
    } else if (lastError === "network") {
      setVoiceStatus("Speech service unavailable (network)");
    } else {
      setVoiceStatus("Couldn't start listening");
    }

    // If we still want to listen (always-on), schedule a restart. Some browsers may not fire onend after onerror.
    if (wantListening && app.inputMode === "voice") {
      restartTimer = setTimeout(() => {
        if (!wantListening || app.inputMode !== "voice" || pausedForTurn || !isVoiceAllowedNow()) return;
        startWebSpeech(true);
      }, 400);
    }
  };

  r.onend = () => {
    webSpeechRunning = false;
    clearWebSpeechTimers();
    isStarting = false;
    setMicVisual(false);

    if (wantListening) {
      restartTimer = setTimeout(() => {
        if (!wantListening) return;
        startWebSpeech(true);
      }, 250);
    } else {
      if (!lastHeard) setVoiceStatus("Tap & speak");
    }
  };

  r.onresult = (event) => {
    // If we become disallowed mid-stream (online + mutual control OFF), ignore results.
    if (pausedForTurn || !isVoiceAllowedNow()) return;
    let interim = "";
    let finalText = "";

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const res = event.results[i];
      const txt = (res?.[0]?.transcript || "").trim();
      if (!txt) continue;
      if (res.isFinal) finalText += (finalText ? " " : "") + txt;
      else interim += (interim ? " " : "") + txt;
    }

    const shown = finalText || interim;
    if (shown) setHeard(shown);

    if (startTimer) { try { clearTimeout(startTimer); } catch (_) {} startTimer = null; }
    if (isStarting) isStarting = false;

    if (!finalText) return;
    handleTranscript(finalText);
  };

  return r;
}

function startWebSpeech(fromRestart = false) {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    showError("Voice input isn't supported in this browser.");
    wantListening = false;
    return;
  }

  if (!isSpeechRecognitionAllowedOrigin()) {
    setVoiceStatus("Starting… (tip: use https:// or localhost)");
  }

  // Turn gate (online + mutual control OFF): do not start while it's not your turn.
  if (!isVoiceAllowedNow()) {
    pausedForTurn = true;
    setMicVisual(false);
    setVoiceStatus("Waiting for your turn…");
    isStarting = false;
    return;
  }

  if (isStarting) return;

  if (!rec) rec = buildWebSpeechRecognizer();
  if (!rec) {
    setVoiceStatus("Voice not supported");
    wantListening = false;
    return;
  }

  isStarting = true;
  setMicVisual(true, fromRestart ? "Say 'Score' followed by a number." : "Starting…");
  setVoiceStatus(fromRestart ? "Say 'Score' followed by a number." : "Starting…");
  setHeard("");

  clearWebSpeechTimers();
  startTimer = setTimeout(() => {
    if (isStarting) {
      isStarting = false;
      wantListening = false;
      setMicVisual(false);
      setVoiceStatus("Couldn't start listening (try Chrome/Edge, and check mic permission)");
      lastError = "start-timeout";
      try { safeAbortWebSpeech(); } catch (_) {}
      teardownWebSpeech();
    }
  }, 12000);

  try {
    rec.start();
  } catch (e) {
    clearWebSpeechTimers();
    isStarting = false;
    setMicVisual(false);

    const name = e?.name || "";
    const msg = String(e || "");

    // Starting too quickly after a stop is common on Chrome and will throw InvalidStateError.
    // In always-on mode we should retry rather than killing the loop.
    if (name === "InvalidStateError" || /already started/i.test(msg) || /invalid state/i.test(msg)) {
      restartTimer = setTimeout(() => {
        if (!wantListening || app.inputMode !== "voice" || pausedForTurn || !isVoiceAllowedNow()) return;
        startWebSpeech(true);
      }, 900);
      return;
    }

    // For other errors, only stop the always-on loop for permission denials.
    if (name === "NotAllowedError" || /not-allowed/i.test(msg) || /permission/i.test(msg)) {
      setVoiceStatus("Microphone access denied");
      wantListening = false;
      teardownWebSpeech();
      return;
    }

    // Otherwise: show a transient message and retry.
    setVoiceStatus("Restarting listening…");
    restartTimer = setTimeout(() => {
      if (!wantListening || app.inputMode !== "voice" || pausedForTurn || !isVoiceAllowedNow()) return;
      startWebSpeech(true);
    }, 1200);
  }

}

function stopWebSpeech(preserveWantListening = false) {
  isStopping = true;
  webSpeechRunning = false;
  setTimeout(() => { isStopping = false; }, 750);

  if (!preserveWantListening) {
    wantListening = false;
  }
  isStarting = false;
  lastError = null;
  clearWebSpeechTimers();
  setMicVisual(false);

  // Keep any helpful status already shown (e.g. "Logged 60").
  const statusEl = document.getElementById("voiceStatus");
  if (statusEl && !statusEl.textContent) setVoiceStatus("Tap & speak");
  else if (!statusEl) setVoiceStatus("Tap & speak");

  safeStopWebSpeech();
}

// -----------------------------
// Whisper (Transformers.js) fallback
// -----------------------------
let whisper = null;                 // pipeline fn
let whisperLoadPromise = null;
let whisperLoading = false;

// Whisper fallback dependency loader
//
// We load Transformers.js via its browser bundle (UMD) rather than CDN ESM rewrites.
// Reason: Opera GX can fail with ESM CDN rewrites and onnxruntime-web ESM builds may
// require Node polyfills ("buffer", "long") that aren't present in the browser.
// Loading the browser bundle avoids these issues.
let transformersLoadPromise = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-voice-src="${src}"]`);
    if (existing) {
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", (e) => reject(e));
      // If it already loaded, resolve immediately.
      if (existing.dataset.loaded === "1") resolve();
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.crossOrigin = "anonymous";
    s.dataset.voiceSrc = src;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", (e) => reject(e));
    document.head.appendChild(s);
  });
}

async function ensureTransformersLoaded() {
  // We are in an ES module app (main.js is type="module"). Use native dynamic import
  // instead of injecting <script> tags, which breaks when the CDN serves ESM code.
  if (window.transformers?.pipeline && window.transformers?.env) return window.transformers;
  if (transformersLoadPromise) return transformersLoadPromise;

  transformersLoadPromise = (async () => {
    // Per HF docs, importing from the package root via CDN is the supported vanilla-ESM path.
    // https://huggingface.co/docs/transformers.js/main/installation
    const mod = await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1");
    const pipeline = mod?.pipeline;
    const env = mod?.env;

    if (typeof pipeline !== "function" || !env) {
      throw new Error("Transformers.js failed to load (missing exports).");
    }

    // Force ONNX Runtime Web WASM assets to a predictable location.
    // This avoids Node-polyfill issues seen in some Chromium forks when bundlers pick the wrong build.
    try {
      if (env.backends?.onnx?.wasm) {
        env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";
        // Conservative defaults for broad compatibility.
        env.backends.onnx.wasm.numThreads = 1;
        env.backends.onnx.wasm.simd = true;
      }
    } catch (e) {
      console.warn("[voice] unable to configure ONNX WASM paths:", e);
    }

    // Do not attempt to load models from local filesystem paths.
    try { env.allowLocalModels = false; } catch {}

    window.transformers = { pipeline, env };
    return window.transformers;
  })();

  return transformersLoadPromise;
}

let whisperStream = null;

// Prefer WebAudio capture over MediaRecorder blobs for Whisper input.
// Some Chromium forks (notably Opera GX) can record audio but fail to decode
// MediaRecorder-produced containers/codecs via AudioContext.decodeAudioData,
// resulting in transcription failures. WebAudio gives us raw PCM samples and
// avoids any container/codec issues.

let whisperAudioCtx = null;
let whisperSource = null;
let whisperProcessor = null;
let whisperPcmChunks = []; // Array<Float32Array>
let whisperSampleRate = 48000;
let whisperAutoStopTimer = null;
let whisperIsRecording = false;
let whisperUserActivated = false; // requires a user gesture at least once (Opera/Safari)

async function ensureWhisperReady() {
  if (whisper) return whisper;
  if (whisperLoadPromise) return whisperLoadPromise;

  whisperLoadPromise = (async () => {
    whisperLoading = true;
    setVoiceStatus("Loading voice model…");
    try {
      // Load Transformers.js from its browser bundle (UMD) for maximum compatibility.
      const t = await ensureTransformersLoaded();
      const { pipeline, env } = t;

      // Prefer browser caching; models are fetched from Hugging Face/CDNs and cached by the browser.
      try { env.allowLocalModels = false; } catch (_) {}
      try { env.allowRemoteModels = true; } catch (_) {}
      try { env.useBrowserCache = true; } catch (_) {}

      // Force ONNX Runtime WASM + set wasm path so it can find its assets.
      try {
        env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/";
      } catch (_) {}

      // Use an English tiny model for speed; plenty for darts phrases.
      whisper = await pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
        quantized: true,
        device: "wasm",
      });

      return whisper;
    } finally {
      whisperLoading = false;
    }
  })();

  return whisperLoadPromise;
}

function clearWhisperTimers() {
  try { if (whisperAutoStopTimer) clearTimeout(whisperAutoStopTimer); } catch (_) {}
  whisperAutoStopTimer = null;
}


function scheduleWhisperRestart(delayMs = 250) {
  if (!wantListening) return;
  if (activeEngine !== "whisper") return;
  if (app.inputMode !== "voice") return;
  if (!whisperUserActivated) return;
  if (whisperIsRecording) return;
  if (pausedForTurn || !isVoiceAllowedNow()) return;

  setTimeout(() => {
    if (!wantListening) return;
    if (activeEngine !== "whisper") return;
    if (app.inputMode !== "voice") return;
    if (!whisperUserActivated) return;
    if (whisperIsRecording) return;
    startWhisperRecording();
  }, delayMs);
}

function stopWhisperStream() {
  try {
    if (whisperStream) {
      for (const t of whisperStream.getTracks()) t.stop();
    }
  } catch (_) {}
  whisperStream = null;
}

async function startWhisperRecording() {
  if (whisperIsRecording) return;
  if (!supportsWhisperFallback()) {
    setVoiceStatus("Voice not supported");
    return;
  }

  // Turn gate: do not listen while it's not your turn (online + mutual control OFF).
  if (!isVoiceAllowedNow()) {
    pausedForTurn = true;
    setMicVisual(false);
    setVoiceStatus("Waiting for your turn…");
    return;
  }

  whisperIsRecording = true;
  setMicVisual(true, "Say 'Score' followed by a number.");
  setVoiceStatus("Say 'Score' followed by a number.");
  setHeard("");

  try {
    // Acquire mic (must be from user gesture - we call this directly inside the click handler)
    if (!whisperStream || whisperStream.getTracks().every((tr) => tr.readyState === "ended")) {
      whisperStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    whisperAudioCtx = new Ctx();
    whisperSampleRate = whisperAudioCtx.sampleRate || 48000;
    whisperPcmChunks = [];

    whisperSource = whisperAudioCtx.createMediaStreamSource(whisperStream);

    // ScriptProcessorNode is deprecated but still broadly supported and perfect for short, simple capture.
    const bufferSize = 4096;
    whisperProcessor = whisperAudioCtx.createScriptProcessor(bufferSize, 1, 1);

    whisperProcessor.onaudioprocess = (ev) => {
      // Copy PCM so the underlying buffer can be reused by the browser.
      const input = ev.inputBuffer.getChannelData(0);
      if (!input || input.length === 0) return;
      whisperPcmChunks.push(new Float32Array(input));
    };

    // Some browsers require the node to be connected to the destination to receive callbacks.
    whisperSource.connect(whisperProcessor);
    whisperProcessor.connect(whisperAudioCtx.destination);

    // Auto-stop after a short window (tap & speak UX)
    whisperAutoStopTimer = setTimeout(() => {
      if (whisperIsRecording) stopWhisperRecording(true);
    }, 6500);
  } catch (e) {
    console.error("[voice] mic error:", e);
    whisperIsRecording = false;
    setMicVisual(false);
    // Keep the mic stream open for always-on mode; fully stop when voice is toggled off.
    if (!wantListening) stopWhisperStream();

    const name = e?.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      setVoiceStatus("Microphone access denied");
    } else if (name === "NotFoundError") {
      setVoiceStatus("No microphone found");
    } else {
      setVoiceStatus("Couldn't start listening");
    }
  }
}

function stopWhisperRecording(fromInternal = false) {
  clearWhisperTimers();

  // Stop capture graph (if any)
  whisperIsRecording = false;
  setMicVisual(false);

  try { whisperProcessor?.disconnect?.(); } catch (_) {}
  try { whisperSource?.disconnect?.(); } catch (_) {}

  whisperProcessor = null;
  whisperSource = null;

  // Gather PCM before we close the context
  const pcm = concatFloat32(whisperPcmChunks);
  whisperPcmChunks = [];

  try { whisperAudioCtx?.close?.(); } catch (_) {}
  whisperAudioCtx = null;

  // Keep the mic stream open for always-on mode; fully stop when voice is toggled off.
    if (!wantListening) stopWhisperStream();

  if (!fromInternal) setVoiceStatus("Transcribing…");

  // If user switched modes mid-flight, bail quietly.
  if (app.inputMode !== "voice") return;

  if (!pcm || pcm.length < 2048) {
    if (!fromInternal) setVoiceStatus("No speech detected");
    else if (!lastHeard) setVoiceStatus("No speech detected");
    scheduleWhisperRestart(250);
    return;
  }

  // Simple energy gate to reduce "empty transcription" surprises.
  if (computeRms(pcm) < 0.004) {
    setVoiceStatus("No speech detected");
    scheduleWhisperRestart(250);
    return;
  }

  // Resample to 16k for Whisper
  const audioData = resampleTo16k(pcm, whisperSampleRate || 48000);

  // Kick off transcription async (don't block UI)
  (async () => {
    try {
      const text = await transcribeWithWhisperPcm(audioData);
      if (text) setHeard(text);
      handleTranscript(text);
    } catch (e) {
      console.error("[voice] whisper transcription error:", e);
      setVoiceStatus("Couldn't transcribe speech");
    } finally {
      // Always-on loop: keep listening in voice mode unless user toggled off.
      if (wantListening && app.inputMode === "voice" && activeEngine === "whisper") {
        setTimeout(() => {
          // Guard against mode changes between scheduling and execution
          if (wantListening && app.inputMode === "voice" && !whisperIsRecording) {
            startWhisperRecording();
          }
        }, 150);
      }
    }
  })();
}

function concatFloat32(chunks) {
  if (!chunks || chunks.length === 0) return new Float32Array(0);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function computeRms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

function resampleTo16k(input, inputSampleRate) {
  const sr = inputSampleRate || 48000;
  if (sr === 16000) return input.slice(0);

  const targetRate = 16000;
  const ratio = sr / targetRate;
  const newLen = Math.max(1, Math.round(input.length / ratio));
  const resampled = new Float32Array(newLen);

  for (let i = 0; i < newLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    resampled[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }

  return resampled;
}

async function transcribeWithWhisperPcm(audioData16k) {
  if (pausedForTurn || !isVoiceAllowedNow()) return "";
  const asr = await ensureWhisperReady();
  if (!asr) throw new Error("Whisper not available");

  // Transformers.js ASR expects Float32Array samples at 16kHz (mono).
  const out = await asr(audioData16k, {
    chunk_length_s: 5,
    stride_length_s: 1,
  });

  const text = (out?.text || out?.[0]?.text || "").trim();
  return text;
}

// -----------------------------
// Shared transcript handling
// -----------------------------
function handleTranscript(text) {
  const finalText = (text || "").trim();
  if (!finalText) {
    setVoiceStatus("Didn't catch a score");
    return;
  }

  // Wake word gate: only accept commands that include the wake word.
  // Example: "score one hundred and twenty five"
  const norm = normalizeTranscript(finalText);
  const parts = norm.split(" ").filter(Boolean);
  const wakeSet = new Set(WAKE_WORDS);
  const wi = parts.findIndex((w) => wakeSet.has(w));
  if (wi === -1) {
    setVoiceStatus('Say "score …"');
    return;
  }
  const cmdRaw = parts.slice(wi + 1).join(" ").trim();
  // Wake-word command normalization: in many accents, "four" is transcribed as "for",
  // and "eight" as "a"/"ate". Because this is *after* the wake word, it's safe to be
  // more aggressive than in general transcript normalization.
  let cmd = cmdRaw;
  if (cmd) {
    const cmdParts = cmd.split(" ").filter(Boolean);
    if (cmdParts.length) {
      if (cmdParts[0] === "for") cmdParts[0] = "four";
      if (cmdParts[0] === "a") cmdParts[0] = "eight";
      if (cmdParts[0] === "ate") cmdParts[0] = "eight";
      if (cmdParts[0] === "too") cmdParts[0] = "two";
      if (cmdParts[0] === "free") cmdParts[0] = "three";
      cmd = cmdParts.join(" ");
    }
  }
  if (!cmd) {
    setVoiceStatus('Say "score" then the number');
    return;
  }

  const score = parseSpokenScore(cmd);
  if (!Number.isFinite(score)) {
    setVoiceStatus("Didn't catch a score");
    return;
  }
  if (score < 0 || score > 180) {
    setVoiceStatus("Score must be 0–180");
    return;
  }

  const inputEl = document.getElementById("scoreInput");
  if (inputEl) {
    inputEl.value = String(score);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  }

  if (canScoreNow(app.latestState)) {
    setVoiceStatus(`Logged ${score}`);
    submitScore();
  } else {
    setVoiceStatus("Waiting for your turn");
  }

  // Keep listening if voice mode is toggled on.
  if (wantListening && app.inputMode === "voice") {
    if (activeEngine === "webspeech") {
      // Restart to keep the session alive.
      // IMPORTANT: do not clear wantListening here; we intend to restart.
      stopWebSpeech(true);
      setTimeout(() => {
        if (wantListening && app.inputMode === "voice") startWebSpeech(true);
      }, 900);
    }
    // Whisper loop auto-restarts in stopWhisperRecording().
  } else {
    stopVoice();
  }
}

// -----------------------------
// Public API
// -----------------------------
let activeEngine = "none"; // "webspeech" | "whisper" | "none"

export function stopVoice() {
  // Stop both, just in case.
  wantListening = false;
  clearWhisperTimers();

  if (whisperIsRecording) {
    stopWhisperRecording(true);
  }
  stopWhisperStream();

  stopWebSpeech();

  // Preserve status set by handleTranscript, if any.
  setMicVisual(false);
}

export function startVoiceAuto() {
  if (app.inputMode !== "voice") return;
  if (activeEngine === "none") return;

  // Hard gate: in online games with mutual control OFF, do not listen while it isn't your turn.
  if (!isVoiceAllowedNow()) {
    pausedForTurn = true;
    setMicVisual(false);
    setVoiceStatus("Waiting for your turn…");
    return;
  }

  // Default-on listening when entering voice mode.
  if (activeEngine === "webspeech") {
    // If we still "wantListening" but we were paused/stopped (e.g., turn gating),
    // allow a restart without requiring a manual double-click.
    if (isStarting) return;
    wantListening = true;
    if (!webSpeechRunning) startWebSpeech(false);
    return;
  }

  if (activeEngine === "whisper") {
    // Some browsers (e.g., Opera GX / Safari) require a user gesture before getUserMedia will succeed.
    // Entering voice mode via the mode-switch button *is* a user gesture, so we try to start immediately.
    // If the browser still blocks us, we fall back to requiring an explicit mic button tap.
    if (!whisperUserActivated) {
      try {
        whisperUserActivated = true;
        if (wantListening && whisperIsRecording) return;
        wantListening = true;
        startWhisperRecording();
        return;
      } catch (e) {
        whisperUserActivated = false;
        wantListening = false;
        setMicVisual(false);
        setVoiceStatus('Say "score …"');
        return;
      }
    }
    if (wantListening && whisperIsRecording) return;
    wantListening = true;
    startWhisperRecording();
  }
}

export function initVoiceUI() {
  const btn = document.getElementById("voiceMicBtn");
  const webSpeechCtor = getSpeechRecognitionCtor();
  const whisperOk = supportsWhisperFallback();

  // Decide engine:
  // - Prefer Web Speech when it is *likely* to work (Chrome/Edge).
  // - If Opera GX or Web Speech ctor missing, use Whisper fallback if available.
  const preferWebSpeech = !!webSpeechCtor && !isOperaGX();

  if (preferWebSpeech) {
    activeEngine = "webspeech";
    setVoiceEngine("Experimental feature. Results may be inconsistent.");
    setVoiceStatus(webSpeechCtor ? "Tap & Speak" : "Voice not supported");
  } else if (whisperOk) {
    activeEngine = "whisper";
    setVoiceEngine("Experimental feature. Expect a delay of 5+ seconds in processing, or use Chrome / Edge for best results.");
    setVoiceStatus("Tap & Speak");
  } else {
    activeEngine = "none";
    setVoiceEngine("Voice input is not supported by your device or browser yet.");
    setVoiceStatus("Voice not supported");
  }

  if (!btn) return;
  btn.disabled = (activeEngine === "none");

  btn.addEventListener("click", async () => {
    if (app.inputMode !== "voice") return;

    if (activeEngine === "webspeech") {
      // Toggle behaviour
      if (wantListening || isStarting) {
        stopWebSpeech();
        return;
      }
      wantListening = true;
      startWebSpeech(false);
      return;
    }

    if (activeEngine === "whisper") {
      // Toggle: ON = always-on loop (segments); OFF = stop and release mic.
      whisperUserActivated = true;
      if (wantListening) {
        // Turning off
        wantListening = false;
        if (whisperIsRecording) stopWhisperRecording(true);
        stopWhisperStream();
        setVoiceStatus("Tap & Speak");
        setMicVisual(false);
        return;
      }
      // Turning on
      wantListening = true;
      if (whisperIsRecording) return;
      await startWhisperRecording();
      return;
    }
  });

  // Turn gating observer (online + mutual control OFF). This is intentionally best-effort:
  // - It will stop voice capture while it isn't your turn.
  // - It will resume automatically when you can act again.
  setupTurnOverlayObserver();
  applyTurnGate();

  // #turnOverlay may be injected after init; retry attaching briefly.
  let tries = 0;
  const attach = setInterval(() => {
    if (turnOverlayObserver) {
      clearInterval(attach);
      return;
    }
    setupTurnOverlayObserver();
    tries++;
    if (tries > 20) clearInterval(attach);
  }, 250);
}


// When a score is logged (by you or the opponent), nudging Web Speech can help keep
// the Chrome/Edge session alive.
// Called from the game snapshot listener (realtime.js).
export function nudgeVoiceAfterGameActivity(prevState, nextState) {
  try {
    if (app.inputMode !== "voice") return;
    if (!wantListening) return;

    // Re-evaluate turn gate on any game activity (turn/score changes).
    applyTurnGate();
    if (pausedForTurn || !isVoiceAllowedNow()) return;

    if (activeEngine !== "webspeech") return;
    if (!prevState || !nextState) return;

    const ps = (st, i) => st?.leg?.players?.[i]?.score;
    const scoreChanged = (ps(prevState, 0) !== ps(nextState, 0)) || (ps(prevState, 1) !== ps(nextState, 1));
    const turnChanged = (prevState?.leg?.currentPlayer !== nextState?.leg?.currentPlayer);

    if (!scoreChanged && !turnChanged) return;

    // Soft-restart without clearing wantListening.
    stopWebSpeech(true);
    setTimeout(() => {
      if (wantListening && app.inputMode === "voice" && activeEngine === "webspeech") {
        startWebSpeech(true);
      }
    }, 220);
  } catch (_) {
    // Best-effort; never crash the app.
  }
}
