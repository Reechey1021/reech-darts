// /arcade.js (ES module)
import { app } from "./app/state.js";
import { initFirebase } from "./app/firebase.js";
import { initAuth, onUserChanged, getActorId, getActorName } from "./app/auth.js";
import { applyBuildTag, logBuildInfo } from "./app/ui/buildInfo.js";
import { withBase } from "./app/routing.js";
import { makeNewMatch } from "./app/model/match.js";
import { listenForGameInvites, respondToGameInvite } from "./app/friends.js";
import { playSfxWebAudio } from "./app/audio/audio.js";

import { renderArcadeSetupFields } from "./arcade/shared/setupFields.js";
import { initArcadeSetupUi } from "./arcade/shared/setupUi.js";


function qs(id) { return document.getElementById(id); }

let stopInviteListener = null;
let latestIncomingInvite = null;


function resolveStarterSeat(choice) {
  const c = String(choice || "p1");
  if (c === "p2") return 1;
  if (c === "random") return (Math.random() < 0.5) ? 0 : 1;
  return 0; // p1
}

function applySavedTheme() {
  try {
    const theme = localStorage.getItem("theme") || "cyan";
    document.body.setAttribute("data-theme", theme);
  } catch (_) {}
}

function ensureModalTopLevel(modal) {
  if (!modal) return;
  // If a modal is nested inside another hidden container, it may never show.
  // Move overlay modals to <body> so they always render on top.
  if (modal.dataset && modal.dataset.modalTopLevel === "1") return;
  if (modal.classList && modal.classList.contains("modal")) {
    document.body.appendChild(modal);
    if (modal.dataset) modal.dataset.modalTopLevel = "1";
  }
}

function openModalEl(modal) {
  if (!modal) return;
  ensureModalTopLevel(modal);
  modal.classList.remove("hidden");
  modal.style.display = "flex";
  requestAnimationFrame(() => {
    modal.classList.remove("is-closing");
    modal.classList.add("is-open");
  });
}

// Dashboard-style wrappers used by shared invite plumbing.
// Keep these names so we can reuse identical code paths across /dashboard and /arcade.
function openModal(modal) { openModalEl(modal); }
function closeModal(modal) { closeModalEl(modal); }

function closeModalEl(modal) {
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.classList.add("is-closing");

  const finish = () => {
    modal.classList.remove("is-closing");
    modal.classList.add("hidden");
    modal.style.display = "none";
    modal.removeEventListener("transitionend", onEnd);
  };

  const onEnd = (e) => {
    if (!e || e.target === modal) finish();
  };

  // Ensure we always finish even if transitionend doesn't fire
  modal.addEventListener("transitionend", onEnd);
  setTimeout(finish, 350);
}

function wireCard(el, fn) {
  if (!el) return;
  el.addEventListener("click", (e) => { e.preventDefault(); fn(); });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
  });
}

function navigateToGame(gameId, { openInvite = false } = {}) {
  if (!gameId) return;
  const params = new URLSearchParams();
  params.set("game", gameId);
  if (openInvite) params.set("openInvite", "1");
  // Arcade games are played on /arcade/play/
  window.location.href = withBase("/arcade/play/") + `?${params.toString()}`;
}

async function validateInviteGame(db, gameId) {
  try {
    if (!db || !gameId) return { ok: false, message: "Invite expired" };

    const snap = await db.collection("games").doc(gameId).get();
    if (!snap.exists) return { ok: false, message: "Invite expired" };

    const state = snap.data() || {};

    // If host has closed/abandoned the lobby/match, treat as unavailable
    if (state.status === "closed" || state.status === "abandoned") {
      return { ok: false, message: "This lobby is no longer available" };
    }

    // must be an online lobby
    const lobbyType = state.lobbyType || state.match?.gameType || "local";
    if (lobbyType !== "online") return { ok: false, message: "That invite is no longer valid" };

    // must still be a lobby (not started/finished)
    if (state.status && state.status !== "lobby" && state.status !== "readyroom") return { ok: false, message: "This lobby is no longer available" };

    // expired lobby
    const exp = state.expiresAt?.toDate ? state.expiresAt.toDate() : state.expiresAt;
    if (exp && Date.now() > new Date(exp).getTime()) return { ok: false, message: "Invite expired" };

    // lobby must have a host
    if (!state.seat1Id) return { ok: false, message: "This lobby is no longer available" };

    // if full, reject
    const fullCheck = await isLobbyFull(db, gameId);
    if (fullCheck.full) return { ok: false, message: fullCheck.message || "Lobby is full" };

    return { ok: true, message: "" };
  } catch (e) {
    console.warn("validateInviteGame failed", e);
    return { ok: false, message: "Invite expired" };
  }
}

// Mirrors the dashboard behavior but uses actorId (uid) because /arcade is signed-in only.
async function isLobbyFull(db, gameId) {
  const snap = await db.collection("games").doc(gameId).get();
  if (!snap.exists) return { full: true, message: "That lobby does not exist." };

  const state = snap.data() || {};
  const match = state.match || {};

  // Determine game type from match if active, otherwise from lobbyType
  const gameType = match.gameType || state.lobbyType;
  if (gameType !== "online") return { full: true, message: "That lobby is not an online game." };

  // Full if both seats are occupied and you're neither of them
  if (match.seat1Id && match.seat2Id) {
    const me = getActorId();
    if (me && match.seat1Id !== me && match.seat2Id !== me) {
      return { full: true, message: "This lobby is full." };
    }
  }

  return { full: false, message: "" };
}

async function createArcadeGame({ lobbyType, arcadeMode, visitsLimit, suddenDeath, starterChoice, allowMutualControl, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget }) {
  const db = app.db;
  if (!db) throw new Error("Missing Firestore");
  const seat1Id = getActorId();
  if (!seat1Id) throw new Error("Not signed in");
  const seat1Name = getActorName() || "Player 1";
  const seat1PhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;

  // Persist seat1 identity on the game doc (arcade renderers read these fields)
  

  const now = new Date();
  const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const ref = db.collection("games").doc();
  const id = ref.id;

  // Base match/leg skeleton (mode=0 so score starts at 0)
  const fresh = makeNewMatch({ mode: 0, bestOf: 1, p1Name: seat1Name, p2Name: "Player 2" });

  // Mirror seat fields at top-level (used by arcade UI nameRow)
  fresh.seat1Id = seat1Id;
  fresh.seat1Name = seat1Name;
  fresh.seat1PhotoURL = seat1PhotoURL;
  fresh.seat2Id = null;
  fresh.seat2Name = null;
  fresh.seat2PhotoURL = null;

  const isOnline = String(lobbyType || "") === "online";
  const topLobbyType = isOnline ? "online" : "single";

  fresh.match.gameType = topLobbyType;
  fresh.lobbyType = topLobbyType;

  fresh.match.hostId = seat1Id;
  fresh.match.seat1Id = seat1Id;
  fresh.match.seat2Id = null;

  // Mutual Control (same field as classic)
  fresh.match.allowMutualControl = isOnline ? (allowMutualControl !== false) : true;

  // Starter selection (stored on match.arcade; starterSeat resolved immediately for local, later for online)
  const starter = String(starterChoice || "p1");
  fresh.match.arcade = fresh.match.arcade || {};
  fresh.match.arcade.starter = starter;
  fresh.match.arcade.starterSeat = isOnline ? null : resolveStarterSeat(starter);

  // Sudden death for draws (used by score-based modes; Bull/ATC may also read it)
  fresh.match.arcade.suddenDeath = (typeof suddenDeath === "boolean") ? suddenDeath : true;

  fresh.match.rules.preset = "arcade";
  fresh.match.rules.checkIn = "straight";
  fresh.match.rules.checkOut = "straight";
  fresh.match.rules.trackCheckoutStats = false;

  // Arcade envelope
  const _arcadeMode = String(arcadeMode || "bull_challenge");
  if (_arcadeMode === "high_score") {
    const rounds = Math.max(1, Number(highScoreRounds) || 10);
    fresh.match.arcade = {
      starter: fresh.match.arcade.starter,
      starterSeat: fresh.match.arcade.starterSeat,
      suddenDeath: fresh.match.arcade.suddenDeath,
      mode: "high_score",
      started: !isOnline,
      highScore: { rounds },
      highScoreState: {
        rounds,
        history: [],
        players: [
          { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
          { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
        ],
        currentPlayer: (fresh.match.arcade.starterSeat ?? 0),
        roundIndex: 0,
        finished: false,
        winner: null,
      },
    };
  } else if (_arcadeMode === "rounds") {
    const firstTo = Math.max(1, Number(roundsFirstTo) || 5);
    fresh.match.arcade = {
      starter: fresh.match.arcade.starter,
      starterSeat: fresh.match.arcade.starterSeat,
      suddenDeath: fresh.match.arcade.suddenDeath,
      mode: "rounds",
      started: !isOnline,
      rounds: { firstTo },
      roundsState: {
        firstTo,
        history: [],
        points: [0,0],
        players: [
          { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
          { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
        ],
        currentPlayer: (fresh.match.arcade.starterSeat ?? 0),
        roundIndex: 0,
        finished: false,
        winner: null,
      },
    };
  
} else if (_arcadeMode === "race") {
  const target = Math.max(100, Math.min(1000, Number(raceTarget) || 300));
  const snapped = Math.round(target / 100) * 100;
  const finalTarget = Math.max(100, Math.min(1000, snapped));
  fresh.match.arcade = {
      starter: fresh.match.arcade.starter,
      starterSeat: fresh.match.arcade.starterSeat,
      suddenDeath: fresh.match.arcade.suddenDeath,
      mode: "race",
    started: !isOnline,
    race: { target: finalTarget },
    raceState: {
      target: finalTarget,
      history: [],
      players: [
        { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
        { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
      ],
      currentPlayer: (fresh.match.arcade.starterSeat ?? 0),
      roundIndex: 0,
      finished: false,
      winner: null,
    },
  };

  } else if (_arcadeMode === "around_the_clock") {
    const startOnNum = (Number(atcStartOn) === 20) ? 20 : 1;
    const multipliersEnabled = (typeof atcMultipliers === "boolean") ? atcMultipliers : true;
    fresh.match.arcade = {
      starter: fresh.match.arcade.starter,
      starterSeat: fresh.match.arcade.starterSeat,
      suddenDeath: fresh.match.arcade.suddenDeath,
      mode: "around_the_clock",
      started: !isOnline,
      atc: {
        phase: 2,
        startOn: startOnNum,
        multipliers: multipliersEnabled,
        exitType: (atcExitType === "outer_and_bull" || atcExitType === "outer_or_bull") ? atcExitType : "bull",
        punishment: (atcPunishment === 1 || atcPunishment === 2 || atcPunishment === 3) ? atcPunishment : 0,
      },
      atcState: {
        phase: 2,
        startOn: startOnNum,
        direction: startOnNum === 20 ? "down" : "up",
        multipliers: multipliersEnabled,
        exitType: (atcExitType === "outer_and_bull" || atcExitType === "outer_or_bull") ? atcExitType : "bull",
        punishment: (atcPunishment === 1 || atcPunishment === 2 || atcPunishment === 3) ? atcPunishment : 0,
        history: [],
        players: [
          { target: startOnNum, inExit: false, exitArmed: false, singles: 0, doubles: 0, trebles: 0, misses: 0, hits: 0, bulls: 0, outers: 0 },
          { target: startOnNum, inExit: false, exitArmed: false, singles: 0, doubles: 0, trebles: 0, misses: 0, hits: 0, bulls: 0, outers: 0 },
        ],
        currentPlayer: (fresh.match.arcade.starterSeat ?? 0),
        finished: false,
        winner: null,
      },
    };
  } else {
    const _visitsLimit = Math.max(1, Number(visitsLimit) || 10);

    fresh.match.arcade = {
      starter: fresh.match.arcade.starter,
      starterSeat: fresh.match.arcade.starterSeat,
      suddenDeath: fresh.match.arcade.suddenDeath,
      mode: "bull_challenge",
      visitsLimit: _visitsLimit,
      suddenDeath: !!suddenDeath,
      // Online games show a ready-room first. Local starts immediately.
      started: !isOnline,
      bcState: {
        visitsLimit: _visitsLimit,
        suddenDeath: !!suddenDeath,
        effectiveLimit: _visitsLimit,
        history: [],
        // derived fields (redundant but convenient)
        players: [
          { score: 0, bulls: 0, outers: 0, misses: 0 },
          { score: 0, bulls: 0, outers: 0, misses: 0 },
        ],
        visitsTaken: [0, 0],
        currentPlayer: (fresh.match.arcade.starterSeat ?? 0),
        finished: false,
        winner: null,
      },
    };
  }

  await ref.set({
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: "lobby",

    runtime: "arcade",
    lobbyType: topLobbyType,
    createdBy: seat1Id,

    seat1Id,
    seat1Name,
    seat1PhotoURL,
    seat2Id: null,
    seat2Name: null,
    seat2PhotoURL: null,

    lobby: {
      host: { actorId: seat1Id, name: seat1Name, uid: (app.user && !app.user.isAnonymous) ? app.user.uid : null, photoURL: seat1PhotoURL },
      joiner: null,
    },

    match: fresh.match,
    leg: fresh.leg,
    pendingCheckout: null,
    bull: null,
  });

  return id;
}


function initIncomingInviteModal() {
  const incomingModal = qs("incomingInviteModal");
  const incomingText = qs("incomingInviteText");
  const incomingAccept = qs("incomingInviteAcceptBtn");
  const incomingDecline = qs("incomingInviteDeclineBtn");
  const incomingOk = qs("incomingInviteOkBtn");

  if (incomingDecline) {
    incomingDecline.addEventListener("click", async () => {
      if (!app.user || !app.db || !latestIncomingInvite?.id) return;
      try {
        await respondToGameInvite(app.db, app.user.uid, latestIncomingInvite.id, "declined");
        closeModal(incomingModal);
        latestIncomingInvite = null;
      } catch (e) {
        console.warn("[arcade] Decline invite failed", e);
      }
    });
  }

  if (incomingAccept) {
    incomingAccept.addEventListener("click", async () => {
      if (!app.user || !app.db || !latestIncomingInvite?.id) return;
      try {
        const gameId = latestIncomingInvite.gameId;
        const validation = await validateInviteGame(app.db, gameId);
        if (!validation.ok) {
          try { await respondToGameInvite(app.db, app.user.uid, latestIncomingInvite.id, "expired"); } catch (_) {}
          if (incomingText) incomingText.textContent = validation.message || "This lobby is no longer available";

          if (incomingAccept) incomingAccept.style.display = "none";
          if (incomingDecline) incomingDecline.style.display = "none";
          if (incomingOk) incomingOk.style.display = "inline-flex";
          if (incomingOk) {
            incomingOk.onclick = () => {
              closeModal(incomingModal);
              latestIncomingInvite = null;
              if (incomingOk) incomingOk.style.display = "none";
              if (incomingAccept) incomingAccept.style.display = "";
              if (incomingDecline) incomingDecline.style.display = "";
            };
          }
          return;
        }

        await respondToGameInvite(app.db, app.user.uid, latestIncomingInvite.id, "accepted");
        closeModal(incomingModal);
        latestIncomingInvite = null;
        // jump to play route with invite open so ready room auto-shows
        navigateToGame(gameId, { openInvite: true });
      } catch (e) {
        console.warn("[arcade] Accept invite failed", e);
      }
    });
  }

  // Ensure OK button starts hidden
  if (incomingOk) incomingOk.style.display = "none";
}

function startInviteListener() {
  if (!app.db || !app.user || app.user.isAnonymous) return null;

  const unsubscribe = listenForGameInvites(app.db, app.user.uid, (docs) => {
    const pending = (docs || []).find((d) => d && d.status === "pending");
    if (!pending) return;

    if (latestIncomingInvite && latestIncomingInvite.id === pending.id) return;
    latestIncomingInvite = pending;

    const incomingModal = qs("incomingInviteModal");
    const incomingText = qs("incomingInviteText");
    if (incomingText) {
      const fromName = pending.fromName || "Player";
      incomingText.textContent = `${fromName} has invited you to a game.`;
    }

    // best-effort sfx
    try { playSfxWebAudio("/audio/sounds/GameInvite.mp3"); } catch (_) {}
    openModalEl(incomingModal);
  });

  return unsubscribe;
}


function renderAtcSetupFields() {
  const localRoot = qs("atcSetupFieldsLocalRoot");
  const onlineRoot = qs("atcSetupFieldsOnlineRoot");
  const build = (prefix, includeMutual) => {
    const startOnId = `${prefix}StartOnSelect`;
    const multId = `${prefix}MultipliersChk`;
    const exitId = `${prefix}ExitTypeSelect`;
    const punId = `${prefix}PunishmentSelect`;

    return `
      <label class="setupLabel" for="${startOnId}">Start on</label>
      <select id="${startOnId}" class="setupInput">
        <option value="1">1</option>
        <option value="20">20</option>
      </select>

      <label class="setupLabel" style="display:flex;align-items:center;gap:10px;margin-top:12px;">
        <input id="${multId}" type="checkbox" style="transform:scale(1.2);" checked />
        <span>Double / Treble multipliers</span>
      </label>

      <label class="setupLabel" for="${exitId}" style="margin-top:12px;">Exit type</label>
      <select id="${exitId}" class="setupInput">
        <option value="bull">Bull (Red only)</option>
        <option value="outer_and_bull">Outer Bull AND Bull</option>
        <option value="outer_or_bull">Outer Bull OR Bull</option>
      </select>

      <label class="setupLabel" for="${punId}" style="margin-top:12px;">Punishment</label>
      <select id="${punId}" class="setupInput">
        <option value="0">None</option>
        <option value="1">Regress 1 per miss</option>
        <option value="2">Regress 2 per miss</option>
        <option value="3">Regress 3 per miss</option>
      </select>

      ${
        includeMutual
          ? `
      <label class="setupLabel" style="display:flex;align-items:center;gap:10px;margin-top:12px;">
        <input id="atcOnlineMutualChk" type="checkbox" style="transform:scale(1.2);" checked />
        <span>Mutual control</span>
      </label>
      `
          : ""
      }
    `;
  };

  if (localRoot) localRoot.innerHTML = build("atcLocal", false);
  if (onlineRoot) onlineRoot.innerHTML = build("atcOnline", true);
}

function renderHighScoreSetupFields() {
  const localRoot = qs("hsSetupFieldsLocalRoot");
  const onlineRoot = qs("hsSetupFieldsOnlineRoot");

  const build = (prefix, includeMutual) => {
    const roundsId = `${prefix}RoundsSelect`;
    const mutualId = `${prefix}MutualChk`;

    return `
      <label class="dashLabel" for="${roundsId}">Rounds</label>
      <select id="${roundsId}" class="dashInput" style="width:100%;margin-bottom:10px;">
        <option value="5">5</option>
        <option value="10" selected>10</option>
        <option value="15">15</option>
        <option value="20">20</option>
      </select>

      ${includeMutual ? `
        <label class="dashLabel" style="display:flex;align-items:center;gap:10px;margin-top:8px;">
          <input id="${mutualId}" type="checkbox" checked />
          <span>Mutual control</span>
        </label>
      ` : ``}
    `;
  };

  if (localRoot) localRoot.innerHTML = build("hsLocal", false);
  if (onlineRoot) onlineRoot.innerHTML = build("hsOnline", true);
}


function renderRoundsSetupFields() {
  const localRoot = qs("roundsSetupFieldsLocalRoot");
  const onlineRoot = qs("roundsSetupFieldsOnlineRoot");

  const build = (prefix, includeMutual) => {
    const firstToId = `${prefix}FirstToSelect`;
    const mutualId = `${prefix}MutualChk`;

    return `
      <label class="dashLabel" for="${firstToId}">First to</label>
      <select id="${firstToId}" class="dashInput" style="width:100%;margin-bottom:10px;">
        <option value="5" selected>5</option>
        <option value="10">10</option>
        <option value="15">15</option>
        <option value="20">20</option>
      </select>

      ${
        includeMutual
          ? `
      <label class="setupLabel" style="display:flex;align-items:center;gap:10px;margin-top:12px;">
        <input id="${mutualId}" type="checkbox" style="transform:scale(1.2);" checked />
        <span>Mutual control</span>
      </label>
      `
          : ""
      }
    `;
  };

  if (localRoot) localRoot.innerHTML = build("roundsLocal", false);
  if (onlineRoot) onlineRoot.innerHTML = build("roundsOnline", true);
}


function renderRaceSetupFields() {
  const localRoot = qs("raceSetupFieldsLocalRoot");
  const onlineRoot = qs("raceSetupFieldsOnlineRoot");

  const build = (prefix, includeMutual) => {
    const targetId = `${prefix}TargetSelect`;
    const mutualId = `${prefix}MutualChk`;

    const opts = [100,200,300,400,500,600,700,800,900,1000]
      .map(v => `<option value="${v}"${v===300?' selected':''}>${v}</option>`)
      .join("");

    return `
      <label class="dashLabel" for="${targetId}">Target score</label>
      <select id="${targetId}" class="dashInput" style="width:100%;margin-bottom:10px;">
        ${opts}
      </select>

      ${
        includeMutual
          ? `
      <label class="setupLabel" style="display:flex;align-items:center;gap:10px;margin-top:12px;">
        <input id="${mutualId}" type="checkbox" style="transform:scale(1.2);" checked />
        <span>Mutual control</span>
      </label>
      `
          : ""
      }
    `;
  };

  if (localRoot) localRoot.innerHTML = build("raceLocal", false);
  if (onlineRoot) onlineRoot.innerHTML = build("raceOnline", true);
}


async function main() {
  applySavedTheme();
  applyBuildTag();
  logBuildInfo();

  // Keep consistent with other entrypoints (main.js/dashboard.js): store Firestore on shared app state.
  app.db = initFirebase();
  await initAuth({ autoAnonymous: false });

  // Incoming invites on /arcade (not in-game).
  initIncomingInviteModal();
  // Build Arcade setup fields (single source of truth shared with /arcade/play/)
  renderArcadeSetupFields();
  // Wire steppers + setup toggles/groups
  initArcadeSetupUi(document);

  const backBtn = qs("arcadeBackBtn");
  if (backBtn) backBtn.addEventListener("click", () => window.location.href = withBase("/dashboard/"));

  const pickModal = qs("arcadeModePickModal");
const setupLocalModal = qs("arcadeSetupLocalModal");
const setupOnlineModal = qs("arcadeSetupOnlineModal");

const bullCard = qs("arcadeBullCard");
const atcCard = qs("arcadeAtcCard");


const hsCard = qs("arcadeHighScoreCard");
const atcPickModal = qs("atcModePickModal");
const atcSetupLocalModal = qs("atcSetupLocalModal");
const atcSetupOnlineModal = qs("atcSetupOnlineModal");


const hsPickModal = qs("hsModePickModal");
const hsSetupLocalModal = qs("hsSetupLocalModal");
const hsSetupOnlineModal = qs("hsSetupOnlineModal");

const roundsCard = qs("arcadeRoundsCard");
const roundsPickModal = qs("roundsModePickModal");
const roundsSetupLocalModal = qs("roundsSetupLocalModal");
const roundsSetupOnlineModal = qs("roundsSetupOnlineModal");

const raceCard = qs("arcadeRaceCard");
const racePickModal = qs("raceModePickModal");
const raceSetupLocalModal = qs("raceSetupLocalModal");
const raceSetupOnlineModal = qs("raceSetupOnlineModal");

// Bull Challenge pick modal
const openPick = () => openModalEl(pickModal);
wireCard(bullCard, openPick);

// Around the Clock pick modal
const openAtcPick = () => openModalEl(atcPickModal);
wireCard(atcCard, openAtcPick);



// High Score pick modal
const openHsPick = () => openModalEl(hsPickModal);
wireCard(hsCard, openHsPick);

// Rounds pick modal
const openRoundsPick = () => openModalEl(roundsPickModal);
wireCard(roundsCard, openRoundsPick);

// Race pick modal
const openRacePick = () => openModalEl(racePickModal);
wireCard(raceCard, openRacePick);
qs("arcadePickCancelBtn")?.addEventListener("click", () => closeModalEl(pickModal));
qs("atcPickCancelBtn")?.addEventListener("click", () => closeModalEl(atcPickModal));
 qs("hsPickCancelBtn")?.addEventListener("click", () => closeModalEl(hsPickModal));
qs("roundsPickCancelBtn")?.addEventListener("click", () => closeModalEl(roundsPickModal));
qs("racePickCancelBtn")?.addEventListener("click", () => closeModalEl(racePickModal));

qs("arcadePickLocalBtn")?.addEventListener("click", () => {
  closeModalEl(pickModal);
  openModalEl(setupLocalModal);
});

qs("arcadePickOnlineBtn")?.addEventListener("click", () => {
  closeModalEl(pickModal);
  openModalEl(setupOnlineModal);
});

qs("atcPickLocalBtn")?.addEventListener("click", () => {
  closeModalEl(atcPickModal);
  openModalEl(atcSetupLocalModal);
});

qs("atcPickOnlineBtn")?.addEventListener("click", () => {
  closeModalEl(atcPickModal);
  openModalEl(atcSetupOnlineModal);
});

qs("hsPickLocalBtn")?.addEventListener("click", () => {
  closeModalEl(hsPickModal);
  openModalEl(hsSetupLocalModal);
});

qs("hsPickOnlineBtn")?.addEventListener("click", () => {
  closeModalEl(hsPickModal);
  openModalEl(hsSetupOnlineModal);
});

qs("roundsPickLocalBtn")?.addEventListener("click", () => {
  closeModalEl(roundsPickModal);
  openModalEl(roundsSetupLocalModal);
});

qs("roundsPickOnlineBtn")?.addEventListener("click", () => {
  closeModalEl(roundsPickModal);
  openModalEl(roundsSetupOnlineModal);
});

qs("racePickLocalBtn")?.addEventListener("click", () => {
  closeModalEl(racePickModal);
  openModalEl(raceSetupLocalModal);
});

qs("racePickOnlineBtn")?.addEventListener("click", () => {
  closeModalEl(racePickModal);
  openModalEl(raceSetupOnlineModal);
});

qs("arcadeLocalCancelBtn")?.addEventListener("click", () => closeModalEl(setupLocalModal));
qs("arcadeOnlineCancelBtn")?.addEventListener("click", () => closeModalEl(setupOnlineModal));
qs("atcLocalCancelBtn")?.addEventListener("click", () => closeModalEl(atcSetupLocalModal));
qs("atcOnlineCancelBtn")?.addEventListener("click", () => closeModalEl(atcSetupOnlineModal));
 qs("hsLocalCancelBtn")?.addEventListener("click", () => closeModalEl(hsSetupLocalModal));
 qs("hsOnlineCancelBtn")?.addEventListener("click", () => closeModalEl(hsSetupOnlineModal));
qs("roundsLocalCancelBtn")?.addEventListener("click", () => closeModalEl(roundsSetupLocalModal));
qs("roundsOnlineCancelBtn")?.addEventListener("click", () => closeModalEl(roundsSetupOnlineModal));
qs("raceLocalCancelBtn")?.addEventListener("click", () => closeModalEl(raceSetupLocalModal));
qs("raceOnlineCancelBtn")?.addEventListener("click", () => closeModalEl(raceSetupOnlineModal));

async function startLocal() {
  const visits = Number(qs("arcadeLocalVisitsInput")?.value || 10);
  const suddenDeath = !!qs("arcadeLocalSuddenDeathChk")?.checked;
  closeModalEl(setupLocalModal);

  const gameId = await createArcadeGame({ lobbyType: "single", arcadeMode: "bull_challenge", visitsLimit: visits, suddenDeath, allowMutualControl: true });
  navigateToGame(gameId, { openInvite: false });
}

async function startOnline() {
  const visits = Number(qs("arcadeOnlineVisitsInput")?.value || 10);
  const suddenDeath = !!qs("arcadeOnlineSuddenDeathChk")?.checked;
  const mutual = !!qs("arcadeOnlineMutualChk")?.checked;
  closeModalEl(setupOnlineModal);

  const gameId = await createArcadeGame({ lobbyType: "online", arcadeMode: "bull_challenge", visitsLimit: visits, suddenDeath, allowMutualControl: mutual });
  navigateToGame(gameId, { openInvite: false });
}

async function startAtcLocal() {
  const startOn = Number(qs("atcLocalStartOnSelect")?.value || 1);
  const starter = String(qs("atcLocalStarterSelect")?.value || "p1");
  const sudden = !!qs("atcLocalSuddenDeathChk")?.checked;
  const multipliers = !!qs("atcLocalMultipliersChk")?.checked;
  const exitType = String(qs("atcLocalExitTypeSelect")?.value || "bull");
  const punishment = Number(qs("atcLocalPunishmentSelect")?.value || 0);
  closeModalEl(atcSetupLocalModal);

  const gameId = await createArcadeGame({ lobbyType: "single", arcadeMode: "around_the_clock", starterChoice: starter, suddenDeath: sudden, allowMutualControl: true, atcStartOn: startOn, atcMultipliers: multipliers, atcExitType: exitType, atcPunishment: punishment });
  navigateToGame(gameId, { openInvite: false });
}

async function startAtcOnline() {
  const startOn = Number(qs("atcOnlineStartOnSelect")?.value || 1);
  const starter = String(qs("atcOnlineStarterSelect")?.value || "p1");
  const sudden = !!qs("atcOnlineSuddenDeathChk")?.checked;
  const multipliers = !!qs("atcOnlineMultipliersChk")?.checked;
  const exitType = String(qs("atcOnlineExitTypeSelect")?.value || "bull");
  const punishment = Number(qs("atcOnlinePunishmentSelect")?.value || 0);
  const mutual = !!qs("atcOnlineMutualChk")?.checked;
  closeModalEl(atcSetupOnlineModal);

  const gameId = await createArcadeGame({ lobbyType: "online", arcadeMode: "around_the_clock", starterChoice: starter, suddenDeath: sudden, allowMutualControl: mutual, atcStartOn: startOn, atcMultipliers: multipliers, atcExitType: exitType, atcPunishment: punishment });
  navigateToGame(gameId, { openInvite: false });
}

async function startHighScoreLocal() {
  const rounds = Number(qs("hsLocalRoundsSelect")?.value || 10);
  const starter = String(qs("hsLocalStarterSelect")?.value || "p1");
  const sudden = !!qs("hsLocalSuddenDeathChk")?.checked;
  closeModalEl(hsSetupLocalModal);

  const gameId = await createArcadeGame({ lobbyType: "single", arcadeMode: "high_score", starterChoice: starter, suddenDeath: sudden, allowMutualControl: true, highScoreRounds: rounds });
  navigateToGame(gameId, { openInvite: false });
}

async function startHighScoreOnline() {
  const rounds = Number(qs("hsOnlineRoundsSelect")?.value || 10);
  const starter = String(qs("hsOnlineStarterSelect")?.value || "p1");
  const sudden = !!qs("hsOnlineSuddenDeathChk")?.checked;
  const mutual = !!qs("hsOnlineMutualChk")?.checked;
  closeModalEl(hsSetupOnlineModal);

  const gameId = await createArcadeGame({ lobbyType: "online", arcadeMode: "high_score", starterChoice: starter, suddenDeath: sudden, allowMutualControl: mutual, highScoreRounds: rounds });
  navigateToGame(gameId, { openInvite: false });
}




async function startRoundsLocal() {
  const firstTo = Number(qs("roundsLocalFirstToSelect")?.value || 5);
  const starter = String(qs("roundsLocalStarterSelect")?.value || "p1");
  const sudden = !!qs("roundsLocalSuddenDeathChk")?.checked;
  closeModalEl(roundsSetupLocalModal);

  const gameId = await createArcadeGame({ lobbyType: "single", arcadeMode: "rounds", starterChoice: starter, suddenDeath: sudden, allowMutualControl: true, roundsFirstTo: firstTo });
  navigateToGame(gameId, { openInvite: false });
}

async function startRoundsOnline() {
  const firstTo = Number(qs("roundsOnlineFirstToSelect")?.value || 5);
  const starter = String(qs("roundsOnlineStarterSelect")?.value || "p1");
  const sudden = !!qs("roundsOnlineSuddenDeathChk")?.checked;
  const mutual = !!qs("roundsOnlineMutualChk")?.checked;
  closeModalEl(roundsSetupOnlineModal);

  const gameId = await createArcadeGame({ lobbyType: "online", arcadeMode: "rounds", starterChoice: starter, suddenDeath: sudden, allowMutualControl: mutual, roundsFirstTo: firstTo });
  navigateToGame(gameId, { openInvite: false });
}

async function startRaceLocal() {
  const target = Number(qs("raceLocalTargetSelect")?.value || 300);
  const starter = String(qs("raceLocalStarterSelect")?.value || "p1");
  const sudden = !!qs("raceLocalSuddenDeathChk")?.checked;
  closeModalEl(raceSetupLocalModal);

  const gameId = await createArcadeGame({ lobbyType: "single", arcadeMode: "race", starterChoice: starter, suddenDeath: sudden, allowMutualControl: true, raceTarget: target });
  navigateToGame(gameId, { openInvite: false });
}

async function startRaceOnline() {
  const target = Number(qs("raceOnlineTargetSelect")?.value || 300);
  const starter = String(qs("raceOnlineStarterSelect")?.value || "p1");
  const sudden = !!qs("raceOnlineSuddenDeathChk")?.checked;
  const mutual = !!qs("raceOnlineMutualChk")?.checked;
  closeModalEl(raceSetupOnlineModal);

  const gameId = await createArcadeGame({ lobbyType: "online", arcadeMode: "race", starterChoice: starter, suddenDeath: sudden, allowMutualControl: mutual, raceTarget: target });
  navigateToGame(gameId, { openInvite: false });
}

qs("arcadeLocalStartMatchBtn")?.addEventListener("click", () => startLocal());
qs("arcadeOnlineStartMatchBtn")?.addEventListener("click", () => startOnline());
qs("atcLocalStartMatchBtn")?.addEventListener("click", () => startAtcLocal());
qs("atcOnlineStartMatchBtn")?.addEventListener("click", () => startAtcOnline());
 qs("hsLocalStartMatchBtn")?.addEventListener("click", () => startHighScoreLocal());
 qs("hsOnlineStartMatchBtn")?.addEventListener("click", () => startHighScoreOnline());
qs("roundsStartLocalBtn")?.addEventListener("click", () => startRoundsLocal());
qs("roundsStartOnlineBtn")?.addEventListener("click", () => startRoundsOnline());
qs("raceStartLocalBtn")?.addEventListener("click", () => startRaceLocal());
qs("raceStartOnlineBtn")?.addEventListener("click", () => startRaceOnline());

  // If user is not signed-in (shouldn't happen if coming from dashboard), bounce to index gate
  onUserChanged((u) => {
    // Wire invite listener on /arcade (not in-game).
    if (stopInviteListener) { try { stopInviteListener(); } catch (e) {} stopInviteListener = null; }

    if (!u || u.isAnonymous) {
      // Arcade is dashboard-only for now.
      window.location.replace(withBase("/index/"));
      return;
    }

    // Start invite listener once a signed-in user is available.
    stopInviteListener = startInviteListener();
  });
}

main().catch((e) => console.error("[arcade] init failed", e));