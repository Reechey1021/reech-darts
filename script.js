import { CHECKOUTS } from "./checkouts.js";

console.log("Reech Darts loaded");
window.onerror = (m, s, l, c, e) => console.log("JS ERROR:", m, l, c, e);

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCG8yBJ5JeUlDQmWi27nrPLmezwu7IdrEM",
  authDomain: "reech-darts.firebaseapp.com",
  projectId: "reech-darts",
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
console.log("Firebase connected");

// ---------- Game routing (URL -> Firestore doc) ----------
function getGameIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("game");
  return id && id.trim() ? id.trim() : null;
}

function getDeviceId() {
  let id = localStorage.getItem("deviceId");
  if (!id) {
    id = (crypto?.randomUUID?.() || (Date.now() + "-" + Math.random())).toString();
    localStorage.setItem("deviceId", id);
  }
  return id;
}


function setGameIdInUrl(gameId) {
  const url = new URL(window.location.href);
  url.searchParams.set("game", gameId);
  // keep it neat if you ever want: url.searchParams.delete("somethingElse");
  window.history.replaceState({}, "", url.toString());
}

let gameId = getGameIdFromUrl() || "test-game";
let gameRef = db.collection("games").doc(gameId);

function switchToGame(newGameId) {
  gameId = newGameId;
  gameRef = db.collection("games").doc(gameId);
  setGameIdInUrl(gameId);

  // Important: reset audio event tracking so new game can play audio again
  lastAudioId = null;
  seatClaimed = false;

  console.log("Switched to gameId:", gameId);
  bindGameListener();
}


console.log("Using gameId:", gameId);

let latestState = null;

// ---------- Constants ----------
const BOGEY_NUMBERS = new Set([169, 168, 166, 165, 163, 162, 159]);
const IMPOSSIBLE_TURN_SCORES = new Set([179, 178, 176, 175, 173, 172, 169, 166, 163]);

// ---------- Audio (WebAudio for require → number) ----------

// ---------- Audio (Firestore-synced, WebAudio-only, iOS-safe) ----------
let audioCtx;
const bufferCache = new Map();
let audioUnlocked = false;
let lastAudioId = null;
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

function stopAllAudio() {
  for (const s of activeSources) {
    try { s.stop(0); } catch {}
    try { s.disconnect(); } catch {}
  }
  activeSources = [];
}

// IMPORTANT: must be called from a user gesture at least once on iOS
async function unlockAudioOnce() {
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

async function playClipsWebAudio(clips) {
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

function pad3(n) {
  return String(n).padStart(3, "0");
}

function requireClipForName(name) {
  const cleaned = (name || "").trim();
  if (cleaned === "Richard") return "./audio/phrases/require_richard.mp3";
  if (cleaned === "Kameron") return "./audio/phrases/require_kameron.mp3";
  return "./audio/phrases/require.mp3";
}

// Whether someone is "on a possible checkout" (your current rules)
function isPossibleCheckout(remaining) {
  const r = Number(remaining);
  if (!Number.isFinite(r)) return false;
  if (r <= 1) return false;
  if (r > 170) return false;
  if (r >= 171 && r <= 180) return false;
  if (BOGEY_NUMBERS.has(r)) return false;
  return Boolean(CHECKOUTS[r]);
}

// Build “Score. (Optional) Require + remaining.”
function buildVisitClips({ scoreCallType, entered, nextPlayerName, nextRemaining }) {
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

function setAudioEvent(state, clips) {
  // unique id so all clients play exactly once
  state.audio = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    clips,
    at: new Date(),
  };
}


// ---------- UI helpers ----------

function canActNow(state) {
  if (!state?.match || !state?.leg) return false;
  if (state.match.gameType !== "online") return true; // singleplayer: always can
  const seat = mySeatIndex(state);
  if (seat === null) return false; // not seated
  if (state.leg.status !== "in_progress") return false;
  if (state.pendingCheckout) return false;
  return seat === state.leg.currentPlayer; // must be your turn
}

function mySeatIndex(state) {
  const d = getDeviceId();
  if (!state?.match) return null;
  if (state.match.seat1Id === d) return 0;
  if (state.match.seat2Id === d) return 1;
  return null;
}

function canEditScores(state) {
  if (!state?.match) return false;
  if (state.match.gameType !== "online") return true; // singleplayer
  return mySeatIndex(state) !== null;
}


function getRequireFile(playerName) {
  if (playerName === "Richard") return "require_richard.mp3";
  if (playerName === "Kameron") return "require_kameron.mp3";
  return "require.mp3";
}

function isTouchDevice() {
  return window.matchMedia("(pointer: coarse)").matches;
}

function safeFocusScoreInput() {
  const el = document.getElementById("scoreInput");
  if (!el) return;
  if (isTouchDevice()) return; // prevent iOS keyboard popping up
  el.focus();
}

function showError(msg) {
  const el = document.getElementById("error");
  if (!el) return;

  el.innerText = msg;
  el.classList.remove("hidden");

  clearTimeout(window.__errTimer);
  window.__errTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}

function setWinnerModalVisible(visible, winnerName = "") {
  const modal = document.getElementById("winnerModal");
  const winnerText = document.getElementById("winnerText");
  if (!modal) return;

  if (visible) {
    if (winnerText) winnerText.innerText = `${winnerName} has won 🎉`;
    modal.style.display = "flex";
    modal.classList.remove("hidden");
  } else {
    if (winnerText) winnerText.innerText = "";
    modal.style.display = "none";
    modal.classList.add("hidden");
  }
}

function setInviteModalVisible(visible) {
  const modal = document.getElementById("inviteModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

async function createNewGameAndShowInvite() {
  const newRef = db.collection("games").doc(); // auto id
  const newId = newRef.id;

  // create empty doc so link is “real” immediately
const now = new Date();
const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000); // 3 hours

await newRef.set({
  createdAt: now,
  updatedAt: now,
  expiresAt: expiresAt,
  status: "lobby", // optional but nice: "lobby" | "active" | "finished"
});


  switchToGame(newId);

  const url = new URL(window.location.href);
  url.searchParams.set("game", newId);

  const txt = url.toString();
  const linkEl = document.getElementById("inviteLinkText");
  if (linkEl) linkEl.textContent = txt;

  setInviteModalVisible(true);
}


function setSetupModalVisible(visible) {
  const modal = document.getElementById("setupModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

function setCheckoutModalVisible(visible) {
  const modal = document.getElementById("checkoutModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

function setConfirmNewMatchModalVisible(visible) {
    const modal = document.getElementById("confirmNewMatchModal");
    if (!modal) return;
    modal.classList.toggle("hidden", !visible);
  }  

// ---------- Rules ----------
function isImpossibleCheckout(remainingBeforeThrow, enteredScore) {
  const after = remainingBeforeThrow - enteredScore;
  if (after !== 0) return false;

  if (remainingBeforeThrow > 170) return true;
  if (remainingBeforeThrow >= 171 && remainingBeforeThrow <= 180) return true;
  if (BOGEY_NUMBERS.has(remainingBeforeThrow)) return true;

  return false;
}

function isBustScore(newScore) {
  return newScore < 0 || newScore === 1;
}

function checkoutSuggestion(remaining) {
  if (typeof remaining !== "number") return null;
  if (remaining > 170) return null;
  if (remaining >= 171 && remaining <= 180) return null;
  if (BOGEY_NUMBERS.has(remaining)) return null;
  if (remaining <= 1) return null;

  return CHECKOUTS[remaining] || null;
}

function minDartsForCheckout(remaining) {
    const s = CHECKOUTS[remaining];
    if (!s) return 1; // fallback
  
    // e.g. "T20 D12" => 2, "T20 T20 BULL" => 3
    const tokens = String(s).trim().split(/\s+/).filter(Boolean);
    return Math.min(Math.max(tokens.length, 1), 3);
  }
  

// ---------- Match/Leg model ----------
function makeNewMatch({ mode, bestOf, p1Name, p2Name }) {
  const starter = Math.random() < 0.5 ? 0 : 1;

  return {
    match: {
      mode,
      bestOf,
      players: [{ name: p1Name }, { name: p2Name }],
      starterLeg1: starter,
      legsWon: [0, 0],
      legs: [], // each leg summary appended at end of leg
      status: "in_progress", // "finished" when match done
      winner: null,
      createdAt: new Date(),
      hostId: null,              // set when host starts match
      gameType: "single",        // "single" | "online"
      seat1Id: null,             // deviceId of Player 1
      seat2Id: null,             // deviceId of Player 2

    },
    leg: makeFreshLeg(mode, starter),
    pendingCheckout: null, // { player, entered, before, at }
    updatedAt: new Date(),
  };
}

function makeFreshLeg(mode, starterPlayer) {
  return {
    players: [
      { score: mode },
      { score: mode },
    ],
    currentPlayer: starterPlayer,
    status: "in_progress", // "finished"
    winner: null,
    history: [], // {player, entered, bust, before, after, dartsUsed}
  };
}

function starterForLeg(match) {
  const legsPlayed = match.legs.length;
  // leg 0 uses starterLeg1. next legs alternate.
  return (match.starterLeg1 + legsPlayed) % 2;
}

// ---------- Stats ----------
function calcLegStats(leg, playerIndex) {
  const visits = (leg.history || []).filter(h => h.player === playerIndex);
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

    // Busts still used darts, but score doesn't count
    if (!v.bust) points += v.entered;
  }

  // First 9 darts = first 3 visits for that player (normally 9 darts)
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

function format3DA(points, darts) {
  if (!darts) return 0;
  return Math.round((points / darts) * 3);
}

function formatPills(stats) {
  const tda = format3DA(stats.points, stats.darts);
  const f9d = stats.first9Darts ? Math.round((stats.first9Points / stats.first9Darts) * 3) : 0;
  const hs = stats.hs || 0;
  return { tda, f9d, hs };
}

function calcMatchStats(match) {
  // sum leg stats across all legs
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

// ---------- Render ----------
function render(state) {

const inputArea = document.getElementById("inputArea");
const overlay = document.getElementById("turnOverlay");
const overlayText = document.getElementById("turnOverlayText");

if (state?.match && state?.leg) {
  const allowed = canActNow(state);
  const isOnline = state.match.gameType === "online";

  if (inputArea) inputArea.classList.toggle("locked", isOnline && !allowed);

  if (overlay && overlayText) {
    if (isOnline && !allowed) {
      const who = state.match.players[state.leg.currentPlayer]?.name || "the other player";
      overlayText.textContent = `It’s ${who}’s turn`;
      overlay.classList.remove("hidden");
    } else {
      overlay.classList.add("hidden");
    }
  }
} else {

  // no match yet — ensure unlocked + hidden overlay
  if (inputArea) inputArea.classList.remove("locked");
  if (overlay) overlay.classList.add("hidden");
}

const gameMetaEl = document.getElementById("gameMeta");

  const statusEl = document.getElementById("status");

  const p1Box = document.getElementById("p1Box");
  const p2Box = document.getElementById("p2Box");

  const p1NameEl = document.getElementById("p1Name");
  const p2NameEl = document.getElementById("p2Name");

  const p1ScoreEl = document.getElementById("p1Score");
  const p2ScoreEl = document.getElementById("p2Score");

  const p1CheckoutEl = document.getElementById("p1Checkout");
  const p2CheckoutEl = document.getElementById("p2Checkout");

  const p1StatsEl = document.getElementById("p1Stats");
  const p2StatsEl = document.getElementById("p2Stats");

  const matchStatsGrid = document.getElementById("matchStatsGrid");
  const winnerNewGameBtn = document.getElementById("winnerNewGameBtn");

  

  // If no match yet
if (!state || !state.match || !state.leg) {
  statusEl.innerText = "Press New Game to start.";
  p1ScoreEl.innerText = "—";
  p2ScoreEl.innerText = "—";
  if (p1CheckoutEl) p1CheckoutEl.innerHTML = "";
  if (p2CheckoutEl) p2CheckoutEl.innerHTML = "";
  if (p1StatsEl) p1StatsEl.innerHTML = "";
  if (p2StatsEl) p2StatsEl.innerHTML = "";
  if (gameMetaEl) gameMetaEl.innerText = "";
  setWinnerModalVisible(false);
  setCheckoutModalVisible(false);
  return;
}

// ✅ readOnly logic MUST be here (after the early return)
const readOnly = !canEditScores(state);

if (readOnly && state.match?.gameType === "online") {
  const seat2Taken = !!state.match.seat2Id;
  showError(
    seat2Taken
      ? "This online game already has 2 devices connected (read-only)."
      : "Waiting for Player 2 to join… (read-only)."
  );
}

const scoreInput = document.getElementById("scoreInput");
const submitBtn = document.getElementById("submitBtn");
const undoBtn = document.getElementById("undoBtn");

if (scoreInput) scoreInput.disabled = readOnly;
if (submitBtn) submitBtn.disabled = readOnly;
if (undoBtn) undoBtn.disabled = readOnly;

  const match = state.match;
  const leg = state.leg;
  if (gameMetaEl) gameMetaEl.innerText = `${match.mode} • BO${match.bestOf}`;

  const lobbyIndicator = document.getElementById("lobbyIndicator");

if (lobbyIndicator) {
  // only show in online mode
  const isOnline = state.match.gameType === "online";
  lobbyIndicator.classList.toggle("hidden", !isOnline);

  if (isOnline) {
    const connected = !!state.match.seat1Id && !!state.match.seat2Id;
    lobbyIndicator.classList.toggle("connected", connected);
    lobbyIndicator.title = connected ? "Both devices connected" : "Waiting for Player 2…";
  }
}


  // Lock names in the main UI (setup controls names now)
  if (p1NameEl) {
    p1NameEl.value = match.players[0].name;
    p1NameEl.setAttribute("readonly", "readonly");
  }
  if (p2NameEl) {
    p2NameEl.value = match.players[1].name;
    p2NameEl.setAttribute("readonly", "readonly");
  }

  // Scores
  const s1 = leg.players?.[0]?.score ?? null;
  const s2 = leg.players?.[1]?.score ?? null;
  p1ScoreEl.innerText = s1 ?? "—";
  p2ScoreEl.innerText = s2 ?? "—";

  const p1LegsEl = document.getElementById("p1Legs");
    const p2LegsEl = document.getElementById("p2Legs");

    if (p1LegsEl) p1LegsEl.innerText = String(match.legsWon?.[0] ?? 0);
    if (p2LegsEl) p2LegsEl.innerText = String(match.legsWon?.[1] ?? 0);


  // Checkout suggestions
  const sug1 = typeof s1 === "number" ? checkoutSuggestion(s1) : null;
  const sug2 = typeof s2 === "number" ? checkoutSuggestion(s2) : null;
  if (p1CheckoutEl) p1CheckoutEl.innerHTML = sug1 ? `<span class="pill">${sug1}</span>` : "";
  if (p2CheckoutEl) p2CheckoutEl.innerHTML = sug2 ? `<span class="pill">${sug2}</span>` : "";

  // Leg stats pills (current leg only)
  const st1 = formatPills(calcLegStats(leg, 0));
  const st2 = formatPills(calcLegStats(leg, 1));

  if (p1StatsEl) {
    p1StatsEl.innerHTML =
      `<span class="pill">3DA: ${st1.tda}</span>` +
      `<span class="pill">F9D: ${st1.f9d}</span>` +
      `<span class="pill">HS: ${st1.hs}</span>`;
  }
  if (p2StatsEl) {
    p2StatsEl.innerHTML =
      `<span class="pill">3DA: ${st2.tda}</span>` +
      `<span class="pill">F9D: ${st2.f9d}</span>` +
      `<span class="pill">HS: ${st2.hs}</span>`;
  }

  // Active glow
  if (p1Box && p2Box) {
    p1Box.classList.toggle("active", leg.currentPlayer === 0 && leg.status === "in_progress");
    p2Box.classList.toggle("active", leg.currentPlayer === 1 && leg.status === "in_progress");
  }

  // Pending checkout modal (confirm/cancel)
  if (state.pendingCheckout) {
    const p = state.pendingCheckout.player;
    const who = match.players[p].name;
    const title = document.getElementById("checkoutTitle");
    const body = document.getElementById("checkoutBody");
    const minDarts = state.pendingCheckout.minDarts ?? 1;

const dartsBtns = Array.from(document.querySelectorAll(".dartsBtn"));
const confirmBtn = document.getElementById("checkoutConfirmBtn");

// Default: show all buttons
for (const b of dartsBtns) b.style.display = "";

// If minDarts is 2, hide the 1-dart button
if (minDarts === 2) {
  const b1 = document.querySelector('.dartsBtn[data-darts="1"]');
  if (b1) b1.style.display = "none";
}

// If minDarts is 3, hide all dart-choice buttons and auto-select 3
if (minDarts === 3) {
  for (const b of dartsBtns) b.style.display = "none";
  window.__selectedCheckoutDarts = 3;
  if (confirmBtn) confirmBtn.disabled = false;

  const body = document.getElementById("checkoutBody");
  if (body) body.innerText = `${match.players[state.pendingCheckout.player].name} is checking out. Confirm?`;
} else {
  // require user selection if not forced
  window.__selectedCheckoutDarts = null;
  if (confirmBtn) confirmBtn.disabled = true;
}

if (title) title.innerText = `Confirm Checkout`;

if (body) {
  body.innerText =
    (minDarts === 3)
      ? `${who} is checking out. Confirm?`
      : `${who} is checking out. How many darts did you use?`;
}

    setCheckoutModalVisible(true);
  } else {
    setCheckoutModalVisible(false);
  }

  // Winner modal: leg finished
  if (leg.status === "finished") {
    const winnerIdx = typeof leg.winner === "number" ? leg.winner : 0;
    const winnerName = match.players[winnerIdx].name;

    // Match stats (across legs)
    const totals = calcMatchStats(match);
    const p1m = formatPills(totals[0]);
    const p2m = formatPills(totals[1]);

    if (matchStatsGrid) {
      matchStatsGrid.innerHTML = `
        <div class="col">
          <h3>${match.players[0].name}</h3>
          <div class="line">Legs: ${match.legsWon[0]}</div>
          <div class="line">3DA: ${p1m.tda}</div>
          <div class="line">F9D: ${p1m.f9d}</div>
          <div class="line">HS: ${p1m.hs}</div>
        </div>
        <div class="col">
          <h3>${match.players[1].name}</h3>
          <div class="line">Legs: ${match.legsWon[1]}</div>
          <div class="line">3DA: ${p2m.tda}</div>
          <div class="line">F9D: ${p2m.f9d}</div>
          <div class="line">HS: ${p2m.hs}</div>
        </div>
      `;
    }

    // Button text depends on match state
    if (winnerNewGameBtn) {
      winnerNewGameBtn.innerText = match.status === "finished" ? "New Match" : "Continue (Next Leg)";
    }

    statusEl.innerText = `${winnerName} wins the leg`;
    setWinnerModalVisible(true, winnerName);
  } else {
    // In progress
    const whoName = match.players[leg.currentPlayer].name;
    statusEl.innerText = `${whoName} to throw`;
    setWinnerModalVisible(false);
  }
}

// ---------- Actions ----------
async function openNewGameFlow() {
  // If a match is in progress and the winner modal isn't up, confirm before nuking it
  const snap = await gameRef.get();
  const state = snap.data();

  // if no state, just open setup
  if (!state || !state.match) {
    setSetupModalVisible(true);
    return;
  }

  // If leg finished, no confirmation needed (you're already in an end state)
  if (state.leg?.status === "finished") {
    setSetupModalVisible(true);
    return;
  }

// Match in progress: show our custom confirm modal
setConfirmNewMatchModalVisible(true);

}

async function startMatchFromSetup() {
  const p1 = (document.getElementById("setupP1")?.value || "Player 1").trim() || "Player 1";
  const p2 = (document.getElementById("setupP2")?.value || "Player 2").trim() || "Player 2";
  const mode = Number(document.getElementById("setupMode")?.value || 501);
  const bestOf = Number(document.getElementById("setupBestOf")?.value || 3);

await db.runTransaction(async (tx) => {
  const state = makeNewMatch({ mode, bestOf, p1Name: p1, p2Name: p2 });

  state.expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  state.status = "active";

  const d = getDeviceId();
  const gameType = (document.getElementById("setupGameType")?.value || "single");

  state.match.hostId = d;
  state.match.gameType = gameType;

  // Host is always Player 1 (seat 0)
  state.match.seat1Id = d;

  // Reset seat2 whenever a new match is created
  state.match.seat2Id = null;

  setAudioEvent(state, ["./audio/phrases/match_start.mp3"]);
  tx.set(gameRef, state);
});


  setSetupModalVisible(false);

  const inputEl = document.getElementById("scoreInput");
  if (inputEl) inputEl.value = "";
}


async function submitScore() {
  const inputEl = document.getElementById("scoreInput");
  const entered = Number(inputEl?.value);

  if (!Number.isFinite(entered) || entered < 0 || entered > 180) {
    showError("Enter a number from 0 to 180.");
    return;
  }
  if (IMPOSSIBLE_TURN_SCORES.has(entered)) {
    showError("That score is not possible");
    return;
  }

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const state = snap.data();
    if (!state || !state.match || !state.leg) {
      showError("Press New Game to start.");
      return;
    }

    if (state.leg.status !== "in_progress") {
      showError("Leg finished.");
      return;
    }

    if (state.pendingCheckout) {
      showError("Confirm or cancel the checkout first.");
      return;
    }

    if (state.match.gameType === "online") {
      const seat = mySeatIndex(state);
    if (seat !== state.leg.currentPlayer) {
      showError("Not your turn / not your player.");
    return;
    }
  }


    const p = state.leg.currentPlayer;
    const oldScore = state.leg.players[p].score;
    const newScore = oldScore - entered;

    // Hard reject: impossible checkout number
    if (isImpossibleCheckout(oldScore, entered)) {
      showError("This checkout is not possible");
      return;
    }

    // If this would finish exactly, do NOT apply yet — require confirmation + darts used
    if (newScore === 0) {
        state.pendingCheckout = {
            player: p,
            entered,
            before: oldScore,
            minDarts: minDartsForCheckout(oldScore),
            at: new Date(),
          };          
      state.updatedAt = new Date();
      tx.set(gameRef, state);
      return;
    }

    // Normal path
    const bust = isBustScore(newScore);

    // Record history (dartsUsed=3 always for non-checkout visits)
    state.leg.history.push({
      player: p,
      entered,
      bust,
      before: oldScore,
      after: bust ? oldScore : newScore,
      dartsUsed: 3,
      at: new Date(),
    });

    if (!bust) {
      state.leg.players[p].score = newScore;
    }

    // Advance turn
// Advance turn
state.leg.currentPlayer = (state.leg.currentPlayer + 1) % 2;

// Decide what to call as the score
// You said: no_score for bust OR 0
const scoreCallType = (bust || entered === 0) ? "no_score" : "number";

// Next player status for "require"
const nextP = state.leg.currentPlayer;
const nextName = state.match.players[nextP].name;
const nextRemaining = state.leg.players[nextP].score;

// Build and attach the full spoken sentence
const clips = buildVisitClips({
  scoreCallType,
  entered,
  nextPlayerName: nextName,
  nextRemaining,
});

setAudioEvent(state, clips);

state.updatedAt = new Date();
tx.set(gameRef, state);

  });

  inputEl.value = "";
  safeFocusScoreInput();
}

async function confirmCheckout(dartsUsed) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const state = snap.data();
    if (!state?.match || !state?.leg || !state.pendingCheckout) return;

    const match = state.match;
    const leg = state.leg;
    const pc = state.pendingCheckout;


    // Apply the checkout now
    const p = pc.player;
    const oldScore = leg.players[p].score;
    const entered = pc.entered;
    const newScore = oldScore - entered;

    // Safety checks
    if (newScore !== 0) {
      state.pendingCheckout = null;
      tx.set(gameRef, state);
      return;
    }

    // Record history with dartsUsed (1/2/3)
    leg.history.push({
      player: p,
      entered,
      bust: false,
      before: oldScore,
      after: 0,
      dartsUsed: dartsUsed,
      at: new Date(),
      checkout: true,
    });

    leg.players[p].score = 0;
    leg.status = "finished";
    leg.winner = p;

    // Build leg summary stats and push into match
    const s0 = calcLegStats(leg, 0);
    const s1 = calcLegStats(leg, 1);

    match.legs.push({
      winner: p,
      players: [s0, s1],
      finishedAt: new Date(),
    });

    match.legsWon[p] += 1;

    // Decide match winner
    const needed = Math.ceil(match.bestOf / 2);
    if (match.legsWon[p] >= needed) {
      match.status = "finished";
      match.winner = p;
    }

// Audio: leg end vs match end
if (match.status === "finished") {
  setAudioEvent(state, ["./audio/phrases/match_end.mp3"]);
} else {
  setAudioEvent(state, ["./audio/phrases/game_end.mp3"]);
}



    state.pendingCheckout = null;
    state.updatedAt = new Date();
    tx.set(gameRef, state);
  });

  // reset checkout modal selection state
  window.__selectedCheckoutDarts = null;
  const btn = document.getElementById("checkoutConfirmBtn");
  if (btn) btn.disabled = true;

  const inputEl = document.getElementById("scoreInput");
  if (inputEl) safeFocusScoreInput();
}

async function cancelCheckout() {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const state = snap.data();
    if (!state) return;
    state.pendingCheckout = null;
    state.updatedAt = new Date();
    tx.set(gameRef, state);
  });

  window.__selectedCheckoutDarts = null;
  const btn = document.getElementById("checkoutConfirmBtn");
  if (btn) btn.disabled = true;

  const inputEl = document.getElementById("scoreInput");
  if (inputEl) safeFocusScoreInput();
}

async function continueOrNewMatch() {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const state = snap.data();
    if (!state?.match || !state?.leg) return;

    const match = state.match;

    // If match finished: open setup (handled outside transaction)
    if (match.status === "finished") return;

    // Start next leg
    const starter = starterForLeg(match);
    state.leg = makeFreshLeg(match.mode, starter);
    state.pendingCheckout = null;
    state.updatedAt = new Date();

    tx.set(gameRef, state);
  });
}

async function undoLast() {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const state = snap.data();
    if (!state?.match || !state?.leg) {
      showError("Press New Game to start.");
      return;
    }

    if (state.pendingCheckout) {
      showError("Cancel the checkout first.");
      return;
    }

    const leg = state.leg;
    if (leg.status !== "in_progress") {
      showError("Leg finished.");
      return;
    }

    if (!Array.isArray(leg.history) || leg.history.length === 0) {
      showError("Nothing to undo");
      return;
    }

    leg.history.pop();

    // Rebuild leg deterministically from match’s leg starter and remaining history
    const match = state.match;
    const starter = starterForLeg(match);
    const rebuilt = makeFreshLeg(match.mode, starter);

    for (const h of leg.history) {
      const p = h.player;
      const before = rebuilt.players[p].score;
      const after = before - h.entered;

      // Should never happen now, but keep safe
      if (isImpossibleCheckout(before, h.entered)) continue;

      const bust = isBustScore(after);
      rebuilt.history.push({
        player: p,
        entered: h.entered,
        bust,
        before,
        after: bust ? before : after,
        dartsUsed: 3,
        at: h.at || new Date(),
      });

      if (!bust) rebuilt.players[p].score = after;
      rebuilt.currentPlayer = (rebuilt.currentPlayer + 1) % 2;
    }

    state.leg = rebuilt;
    state.updatedAt = new Date();
    tx.set(gameRef, state);
  });
}

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);

  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}

function initThemeToggle() {
  const saved = localStorage.getItem("theme");
  const preferred =
    saved ||
    (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light");

  applyTheme(preferred);

  const btn = document.getElementById("themeToggleBtn");
  if (!btn) return;

  btn.addEventListener("click", () => {
    const current = document.body.getAttribute("data-theme") || "light";
    applyTheme(current === "dark" ? "light" : "dark");
  });
}


// ---------- Wire UI ----------
function wireUI() {
  // Main
  const newGameBtn = document.getElementById("newGameBtn");
  const submitBtn = document.getElementById("submitBtn");
  const undoBtn = document.getElementById("undoBtn");
  const scoreInputEl = document.getElementById("scoreInput");

  // Mobile menu buttons (reuse same flows)
const mobileNewGameBtn = document.getElementById("mobileNewGameBtn");
const mobileInviteBtn = document.getElementById("mobileInviteBtn");
const mobileMenu = document.getElementById("mobileMenu");

if (mobileNewGameBtn) mobileNewGameBtn.addEventListener("click", () => {
  if (mobileMenu) mobileMenu.removeAttribute("open");
  openNewGameFlow();
});

if (mobileInviteBtn) mobileInviteBtn.addEventListener("click", () => {
  if (mobileMenu) mobileMenu.removeAttribute("open");
  createNewGameAndShowInvite();
});

document.addEventListener("click", (e) => {
  const menu = document.getElementById("mobileMenu");
  if (!menu) return;
  if (!menu.hasAttribute("open")) return;
  if (!menu.contains(e.target)) menu.removeAttribute("open");
});


  document.addEventListener("click", unlockAudioOnce, { once: true });
  document.addEventListener("touchstart", unlockAudioOnce, { once: true });

  const inviteBtn = document.getElementById("inviteBtn");
const copyInviteBtn = document.getElementById("copyInviteBtn");
const closeInviteBtn = document.getElementById("closeInviteBtn");

if (inviteBtn) inviteBtn.addEventListener("click", createNewGameAndShowInvite);

if (copyInviteBtn) {
  copyInviteBtn.addEventListener("click", async () => {
    const text = document.getElementById("inviteLinkText")?.textContent || "";
    try { await navigator.clipboard.writeText(text); } catch {}
  });
}


if (closeInviteBtn) closeInviteBtn.addEventListener("click", () => setInviteModalVisible(false));


  // Setup modal
  const setupCancelBtn = document.getElementById("setupCancelBtn");
  const setupStartBtn = document.getElementById("setupStartBtn");

  // Checkout modal
  const checkoutCancelBtn = document.getElementById("checkoutCancelBtn");
  const checkoutConfirmBtn = document.getElementById("checkoutConfirmBtn");
  const dartsBtns = Array.from(document.querySelectorAll(".dartsBtn"));

  // Winner modal button
  const winnerNewGameBtn = document.getElementById("winnerNewGameBtn");

  if (newGameBtn) newGameBtn.addEventListener("click", openNewGameFlow);
  if (submitBtn) submitBtn.addEventListener("click", submitScore);
  if (undoBtn) undoBtn.addEventListener("click", undoLast);

  // Keyboard: Enter submits
  if (scoreInputEl) {
    scoreInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitScore();
    });

    scoreInputEl.addEventListener("input", () => {
      scoreInputEl.value = scoreInputEl.value.replace(/\D/g, "").slice(0, 3);
    });
  }

  // Keypad buttons
  const keypad = document.getElementById("keypad");
  const clearBtn = document.getElementById("keyClear");
  const backBtn = document.getElementById("keyBack");

  if (keypad && scoreInputEl) {
    keypad.addEventListener("click", (e) => {
      if (!canActNow(latestState)) return;

      const btn = e.target.closest("button");
      if (!btn) return;
      const digit = btn.getAttribute("data-digit");
      if (digit !== null) {
        scoreInputEl.value = (scoreInputEl.value + digit).slice(0, 3);
        safeFocusScoreInput();
      }
    });
  }

  if (clearBtn && scoreInputEl) {
    clearBtn.addEventListener("click", () => {
      if (!canActNow(latestState)) return;

      scoreInputEl.value = "";
      safeFocusScoreInput();
    });
  }

  if (backBtn && scoreInputEl) {
    backBtn.addEventListener("click", () => {
      if (!canActNow(latestState)) return;

      scoreInputEl.value = scoreInputEl.value.slice(0, -1);
      safeFocusScoreInput();
    });
  }

  // Setup modal buttons
  if (setupCancelBtn) setupCancelBtn.addEventListener("click", () => setSetupModalVisible(false));
  if (setupStartBtn) setupStartBtn.addEventListener("click", startMatchFromSetup);

  // Checkout modal selection
  window.__selectedCheckoutDarts = null;

for (const b of dartsBtns) {
  b.addEventListener("click", () => {
    // Clear previous selection
    dartsBtns.forEach(btn => btn.classList.remove("selected"));

    // Mark this one selected
    b.classList.add("selected");

    const d = Number(b.getAttribute("data-darts"));
    window.__selectedCheckoutDarts = d;

    if (checkoutConfirmBtn) checkoutConfirmBtn.disabled = false;
  });
}


  if (checkoutCancelBtn) checkoutCancelBtn.addEventListener("click", cancelCheckout);
  if (checkoutConfirmBtn) {
    checkoutConfirmBtn.addEventListener("click", () => {
      const d = window.__selectedCheckoutDarts;
      if (![1,2,3].includes(d)) {
        showError("Select 1, 2 or 3 darts");
        return;
      }
      confirmCheckout(d);
    });
  }

  // Winner modal button
  if (winnerNewGameBtn) {
    winnerNewGameBtn.addEventListener("click", async () => {
      // If match still running, continue to next leg
      const snap = await gameRef.get();
      const state = snap.data();
      if (!state?.match) return;

      if (state.match.status === "finished") {
        // Start setup for a brand new match
        setWinnerModalVisible(false);
        setSetupModalVisible(true);
      } else {
        setWinnerModalVisible(false);
        await continueOrNewMatch();
      }
    });
  }

  // Confirm New Match modal
const confirmNewMatchCancelBtn = document.getElementById("confirmNewMatchCancelBtn");
const confirmNewMatchOkBtn = document.getElementById("confirmNewMatchOkBtn");

if (confirmNewMatchCancelBtn) {
  confirmNewMatchCancelBtn.addEventListener("click", () => {
    setConfirmNewMatchModalVisible(false);
  });
}

if (confirmNewMatchOkBtn) {
  confirmNewMatchOkBtn.addEventListener("click", () => {
    setConfirmNewMatchModalVisible(false);
    setSetupModalVisible(true);
  });
}

initThemeToggle();


}

function isAnyModalOpen() {
    const ids = ["winnerModal", "setupModal", "checkoutModal", "confirmNewMatchModal"];
    return ids.some((id) => {
      const el = document.getElementById(id);
      return el && !el.classList.contains("hidden");
    });
  }
  
  function wireGlobalKeyboard() {
    const scoreInputEl = document.getElementById("scoreInput");
    if (!scoreInputEl) return;
  
    window.addEventListener("keydown", (e) => {
      // Only when tab is active and no modal is open
      if (document.hidden) return;
      if (isAnyModalOpen()) return;
      if (!canActNow(latestState)) return;
  
      // Don't steal keys when user is typing in another input/select
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        return;
      }
  
      // Digits
      if (e.key >= "0" && e.key <= "9") {
        e.preventDefault();
        scoreInputEl.value = (scoreInputEl.value + e.key).slice(0, 3);
        safeFocusScoreInput();
        return;
      }
  
      // Backspace
      if (e.key === "Backspace") {
        e.preventDefault();
        scoreInputEl.value = scoreInputEl.value.slice(0, -1);
        safeFocusScoreInput();
        return;
      }
  
      // Enter submits
      if (e.key === "Enter") {
        e.preventDefault();
        submitScore();
        return;
      }
    });
  }
  

wireUI();
setWinnerModalVisible(false);
setSetupModalVisible(false);
setCheckoutModalVisible(false);
setConfirmNewMatchModalVisible(false);
setInviteModalVisible(false);
wireGlobalKeyboard();

// ---------- Real-time updates ----------
let unsubscribeGame = null;
let seatClaimed = false;


async function tryClaimSeat2(state) {
  if (seatClaimed) return;
  if (!state?.match) return;
  if (state.match.gameType !== "online") return;

  const exp = state.expiresAt?.toDate ? state.expiresAt.toDate() : state.expiresAt;
  if (exp && Date.now() > new Date(exp).getTime()) return;


  const d = getDeviceId();
  if (!state.match.seat1Id) return;
  if (state.match.seat1Id === d) return; // host
  if (state.match.seat2Id) return; // already taken

  seatClaimed = true;

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(gameRef);
      const fresh = snap.data();
      if (!fresh?.match) return;
      if (fresh.match.gameType !== "online") return;
      if (fresh.match.seat2Id) return;
      if (fresh.match.seat1Id === d) return;

      fresh.match.seat2Id = d;
      fresh.updatedAt = new Date();
      tx.set(gameRef, fresh);
    });
  } catch {
    seatClaimed = false;
  }
}


function bindGameListener() {
  if (typeof unsubscribeGame === "function") {
    unsubscribeGame();
    unsubscribeGame = null;
  }

  unsubscribeGame = gameRef.onSnapshot(
    (doc) => {
      const state = doc.data();

      latestState = state;
      render(state);
      tryClaimSeat2(state);

      // Firestore-synced audio: every device plays the same event once
      if (state?.audio?.id && state.audio.id !== lastAudioId) {
        lastAudioId = state.audio.id;
        playClipsWebAudio(state.audio.clips);
      }
    },
    (err) => {
      console.error(err);
      const statusEl = document.getElementById("status");
      if (statusEl) statusEl.innerText = "Firestore error: " + err.message;
    }
  );
}


// start listening
bindGameListener();


