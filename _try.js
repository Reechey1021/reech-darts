
function canScoreNow(state) {
  if (!state?.match) return false;
  // Local games: always allow scoring
  const gameType = state.match.gameType || state.lobbyType || state.match.lobbyType || "single";
  if (gameType !== "online") return true;

  // Online: block if not seated
  const myUid = getActorId();
  if (!myUid) return false;

  const seats = getSeatIds(state);
  const seatIndex = (seats.seat1 && myUid === seats.seat1) ? 0 : (seats.seat2 && myUid === seats.seat2) ? 1 : null;
  if (seatIndex === null) return false;

  // Allow mutual control: either device can score
  if (state.match.allowMutualControl) return true;

  // Use leg.currentPlayer when present (consistent with existing arcade games)
  const turn = (typeof state?.leg?.currentPlayer === "number")
    ? state.leg.currentPlayer
    : (typeof state?.match?.leg?.currentPlayer === "number" ? state.match.leg.currentPlayer : null);

  if (turn === null) return false;
  return seatIndex === turn;
}
// /arcade/play/arcadeMain.js
import { app } from "../../app/state.js";
import { applyBuildTag, logBuildInfo } from "../../app/ui/buildInfo.js";
import { initFirebase } from "../../app/firebase.js";
import { initAuth, getActorId } from "../../app/auth.js";
import { sendGameInvite } from "../../app/friends.js";
import { getGameIdFromUrl, withBase } from "../../app/routing.js";
import { tryClaimSeat2 } from "../../app/realtime.js";
import { initAuditChatUI, updateAuditFromState, renderAuditChat } from "../../app/ui/auditChat.js";

import { playSfxWebAudio } from "../../app/audio/audio.js";

import { multFactor } from "../../app/input/dartpad.js";

// Latest Firestore snapshot state (used for UI actions like Start Match)
let liveState = null;

let __lastSeat1Id = null;
let __lastSeat2Id = null;
let __lastSeat1Name = null;
let __lastSeat2Name = null;

// Bull Challenge: pending darts are LOCAL ONLY (not written to Firestore until Submit Visit).
let pendingHits = [];

// (No global state needed; we only write when a specific field is missing.)

function qs(id) {
  // Prefer data-role selectors (arcade-generic), fall back to legacy bc* IDs.
  if (!id) return null;
  // 1) Direct role lookup
  let el = document.querySelector(`[data-role="${id}"]`);
  if (el) return el;

  // 2) Direct ID lookup (in case we already migrated IDs)
  el = document.getElementById(id);
  if (el) return el;

  // 3) Back-compat mapping between legacy bc* and new arcade* roles/IDs
  if (id.startsWith("arcade")) {
    const legacy = "bc" + id.slice("arcade".length);
    el = document.getElementById(legacy) || document.querySelector(`[data-role="${legacy}"]`);
    if (el) return el;
  }
  if (id.startsWith("bc")) {
    const role = "arcade" + id.slice(2);
    el = document.querySelector(`[data-role="${role}"]`) || document.getElementById(role);
    if (el) return el;
  }
  return null;
}

function getSavedTheme() {
  try { return localStorage.getItem("theme") || "cyan"; } catch (_) { return "cyan"; }
}

function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme || "cyan");
}

function showError(msg) {
  const el = qs("arcadeError");
  if (!el) return;
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
}

function openModalEl(modal) {
  if (!modal) return;
  modal.classList.remove("is-closing");
  modal.classList.add("is-open");
}

function closeModalEl(modal) {
  if (!modal) return;
  modal.classList.remove("is-open");
  modal.classList.add("is-closing");
  window.setTimeout(() => modal.classList.remove("is-closing"), 180);
}

function openHiddenModal(id) {
  const el = typeof id === "string" ? qs(id) : id;
  if (!el) return;
  // Our CSS modal system requires .is-open to become visible/clickable.
  // Many modals also start with .hidden to keep the DOM light.
  el.classList.remove("hidden");
  openModalEl(el);
}

function closeHiddenModal(id) {
  const el = typeof id === "string" ? qs(id) : id;
  if (!el) return;
  if (app._lockedSetup) {
    const modalId = el.id || (typeof id === "string" ? id : "");
    if (modalId === "arcadeSetupLocalModal" || modalId === "arcadeSetupOnlineModal") {
      // Locked: must Cancel or Start.
      return;
    }
  }
  // Close animation then hide.
  closeModalEl(el);
  window.setTimeout(() => el.classList.add("hidden"), 180);
}


// -----------------------------
// Arcade end-of-game modal: winnerModal-style stats grid
// -----------------------------
function renderArcadeMatchStatsGrid({ p1Name, p2Name, p1PhotoURL, p2PhotoURL, rows }) {
  const grid = document.getElementById("matchStatsGrid");
  if (!grid) return;

  const safe = (v) => (v === null || v === undefined ? "—" : String(v));

  const head = (name, photo) => `
    <div class="msHead">
      ${photo ? `<img class="msAvatar" src="${photo}" alt="avatar" />` : ``}
      <div class="msName">${safe(name)}</div>
    </div>
  `;

  const cells = [];
  // Header row: P1 | (blank) | P2
  cells.push(`<div class="msCell">${head(p1Name, p1PhotoURL)}</div>`);
  cells.push(`<div class="msCell"></div>`);
  cells.push(`<div class="msCell">${head(p2Name, p2PhotoURL)}</div>`);

  for (const r of (Array.isArray(rows) ? rows : [])) {
    cells.push(`<div class="msCell msVal">${safe(r.p1)}</div>`);
    cells.push(`<div class="msCell msLabel">${safe(r.label)}</div>`);
    cells.push(`<div class="msCell msVal">${safe(r.p2)}</div>`);
  }

  grid.innerHTML = cells.join("");
}

function openArcadeEndModal({ title, p1Name, p2Name, p1PhotoURL, p2PhotoURL, rows }) {
  const endModal = qs("arcadeEndModal");
  if (!endModal) return;

  const titleEl = qs("arcadeEndTitle");
  if (titleEl) titleEl.textContent = title || "Match ended";

  renderArcadeMatchStatsGrid({ p1Name, p2Name, p1PhotoURL, p2PhotoURL, rows });

  openHiddenModal(endModal);
}

function closeArcadeEndModal() {
  closeHiddenModal(qs("arcadeEndModal"));
}


// ATC: Checkout confirmation modal (used when player presses Bull).
let _atcCheckoutResolve = null;
function promptAtcCheckout() {
  const modal = qs("atcCheckoutModal");
  if (!modal) return Promise.resolve(true);
  return new Promise((resolve) => {
    _atcCheckoutResolve = resolve;
    openHiddenModal(modal);
  });
}

function resolveAtcCheckout(ok) {
  const modal = qs("atcCheckoutModal");
  closeHiddenModal(modal);
  const fn = _atcCheckoutResolve;
  _atcCheckoutResolve = null;
  if (typeof fn === "function") fn(!!ok);
}

let __seatToastTimer = null;
function showSeatJoinToast(message, durationMs = 5000) {
  try {
    const el = document.getElementById("seatJoinToast");
    const t = document.getElementById("seatJoinToastText");
    if (!el) return;
    el.classList.remove("danger");
    if (t) t.textContent = String(message || "");
    if (__seatToastTimer) { clearTimeout(__seatToastTimer); __seatToastTimer = null; }
    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("show"));
    try { playSfxWebAudio("/audio/sounds/LobbyJoin.mp3"); } catch (_) {}
    __seatToastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.classList.add("hidden"), 260);
    }, Math.max(1200, Number(durationMs) || 5000));
  } catch (_) {}
}

function showSeatLeaveToast(message, durationMs = 5000) {
  try {
    const el = document.getElementById("seatJoinToast");
    const t = document.getElementById("seatJoinToastText");
    if (!el) return;
    el.classList.add("danger");
    if (t) t.textContent = String(message || "Player left the game");
    if (__seatToastTimer) { clearTimeout(__seatToastTimer); __seatToastTimer = null; }
    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("show"));
    try { playSfxWebAudio("/audio/sounds/LobbyLeave.mp3"); } catch (_) {}
    __seatToastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.classList.add("hidden"), 260);
    }, Math.max(1200, Number(durationMs) || 5000));
  } catch (_) {}
}

function isOnlineGame(state) {
  // Online games may expose online-ness in a few places depending on which code path created the doc.
  const rootLobbyType = String(state?.lobbyType || state?.gameType || "");
  const matchType = String(state?.match?.gameType || state?.match?.lobbyType || state?.match?.gameType || "");
  const lobbyType = String(state?.match?.lobbyType || state?.match?.lobbyType || "");
  const isOnline = (rootLobbyType === "online") || (matchType === "online") || (lobbyType === "online");
  return isOnline;
}

function getSeatIds(state) {
  // Normalize seat identifiers across different doc shapes (root fields vs match fields vs lobby maps).
  const seat1 =
    state?.seat1Id ||
    state?.match?.seat1Id ||
    state?.match?.seat1Uid ||
    state?.lobby?.host?.uid ||
    state?.lobby?.host?.actorId ||
    state?.match?.lobby?.host?.uid ||
    state?.match?.lobby?.host?.actorId ||
    null;

  const seat2 =
    state?.seat2Id ||
    state?.match?.seat2Id ||
    state?.seat2Uid ||
    state?.match?.seat2Uid ||
    state?.lobby?.joiner?.uid ||
    state?.lobby?.joiner?.actorId ||
    state?.match?.lobby?.joiner?.uid ||
    state?.match?.lobby?.joiner?.actorId ||
    null;

  return { seat1, seat2 };
}


function getArcadeMode(state) {
  return state?.match?.arcade?.mode || state?.arcadeMode || "";
}


// Firestore SDK compat helper: supports both snap.exists (bool) and snap.exists() (fn)
function snapExists(snap) {
  if (!snap) return false;
  try {
    if (typeof snap.exists === "function") return !!snap.exists();
    return !!snap.exists;
  } catch (_) {
    return false;
  }
}

function computeBullStateFromHistory({ visitsLimit, suddenDeath }, history) {
  const vLimit = Math.max(1, Number(visitsLimit) || 10);
  const hist = Array.isArray(history) ? history.filter(h => h && (h.player === 0 || h.player === 1) && Array.isArray(h.darts) && h.darts.length === 3) : [];

  let effectiveLimit = vLimit;

  const players = [
    { score: 0, bulls: 0, outers: 0, misses: 0 },
    { score: 0, bulls: 0, outers: 0, misses: 0 },
  ];
  const visitsTaken = [0, 0];
  let finished = false;
  let winner = null;

  const scoreFor = (hit) => hit === "bull" ? 2 : (hit === "outer" ? 1 : 0);

  for (const entry of hist) {
    if (finished) break;
    const p = entry.player;
    const darts = entry.darts;
    let addScore = 0;
    let addBulls = 0;
    let addOuters = 0;
    let addMisses = 0;

    for (const d of darts) {
      if (d === "bull") addBulls += 1;
      else if (d === "outer") addOuters += 1;
      else addMisses += 1;
      addScore += scoreFor(d);
    }

    players[p].score += addScore;
    players[p].bulls += addBulls;
    players[p].outers += addOuters;
    players[p].misses += addMisses;
    visitsTaken[p] += 1;

    const bothDone = (visitsTaken[0] >= effectiveLimit) && (visitsTaken[1] >= effectiveLimit);
    if (bothDone) {
      const s0 = players[0].score;
      const s1 = players[1].score;
      if (s0 > s1) { finished = true; winner = 0; }
      else if (s1 > s0) { finished = true; winner = 1; }
      else {
        if (suddenDeath) {
          effectiveLimit += 1;
        } else {
          finished = true;
          winner = null;
        }
      }
    }
  }

  // Next player is simply alternating, unless finished.
  const cur = finished ? (hist.length ? hist[hist.length - 1].player : 0) : (hist.length % 2);

  return {
    visitsLimit: vLimit,
    suddenDeath: !!suddenDeath,
    effectiveLimit,
    history: hist,
    players,
    visitsTaken,
    currentPlayer: finished ? cur : cur,
    finished,
    winner,
  };
}

function ensureBullChallengeState(state) {
  const visitsLimit = Math.max(1, Number(state?.match?.arcade?.visitsLimit) || 10);
  const suddenDeath = !!state?.match?.arcade?.suddenDeath;

  const existing = state?.match?.arcade?.bcState;
  const history = existing && typeof existing === "object" ? existing.history : [];
  const computed = computeBullStateFromHistory({ visitsLimit, suddenDeath }, history);

  // Keep a stable object shape for storage/readbacks.
  return {
    ...computed,
    // Derived UI-only helpers
    players: computed.players,
    visitsTaken: computed.visitsTaken,
  };
}


function canActNow(state, bc) {
  // Local games: allow input from this device.
  if (!isOnlineGame(state)) return true;

  const actor = getActorId();
  if (!actor) return false;

  const seat1 = state?.match?.seat1Id || state?.seat1Id || state?.lobby?.host?.actorId || null;
  const seat2 = state?.match?.seat2Id || state?.seat2Id || null;

  const isSeat = (actor === seat1) || (actor === seat2);
  if (!isSeat) return false;

  // Mutual Control: either device can submit for whoever is throwing.
  const mutual = state?.match?.allowMutualControl !== false;
  if (mutual) return true;

  // Strict turns (mutual off): only the active seat can act.
  const p = Number(bc.currentPlayer || 0);
  if (p === 0) return actor === seat1;
  if (p === 1) return actor === seat2;
  return false;
}


function isStarted(state) {
  if (!isOnlineGame(state)) return true;
  return state?.match?.arcade?.started === true;
}

function getReadyMap(state) {
  const ready = state?.readyRoom?.ready;
  if (ready && typeof ready === "object") return ready;
  return {};
}

function seatIds(state) {
  const seat1 = state?.match?.seat1Id || state?.seat1Id || state?.lobby?.host?.actorId || null;
  const seat2 = state?.match?.seat2Id || state?.seat2Id || state?.lobby?.joiner?.actorId || null;
  return { seat1, seat2 };
}

function renderReadyRoom(state) {
  const modal = qs("readyRoomModal");
  if (!modal) return;

  const startedFlag = state?.match?.arcade?.started;

  // Ready room is shown for any match where arcade.started is explicitly false.
  // This is more reliable than inferring online-ness from lobbyType across different arcade modes.
  if (startedFlag !== false) {
    closeHiddenModal(modal);
    return;
  }

  const { seat1, seat2 } = seatIds(state);
  const ready = getReadyMap(state);
  const me = getActorId();
  const iAmHost = !!(me && seat1 && me === seat1);

  const p1Name = state?.seat1Name || state?.match?.seat1Name || state?.lobby?.host?.name || "Player 1";
  const p2Name = state?.seat2Name || state?.match?.seat2Name || state?.lobby?.joiner?.name || "Player 2";

  const p1Ready = !!(seat1 && ready[seat1] === true);
  const p2Ready = !!(seat2 && ready[seat2] === true);
  const mineReady = !!(me && ready[me] === true);

  const subtitle = qs("readyRoomSubtitle");
  if (subtitle) subtitle.textContent = seat2 ? "Waiting for both players to get ready…" : "Waiting for Player 2 to join…";

  const metaEl = qs("readyRoomMeta");
  if (metaEl) {
    const mode = getArcadeMode(state);
    const label = (mode === "high_score") ? "High Score" : (mode === "around_the_clock") ? "Around the Clock" : "Bull Challenge";
    metaEl.textContent = `${label} · Arcade`;
  }


// Seat2-empty tools (invite/copy/friends) live INSIDE the P2 card and must disappear permanently once Seat 2 is ever filled.
try {
  const tools = qs("readySeat2EmptyTools");
  const everFilled = !!(state?.match?.arcade?.seat2EverFilled);
  const showTools = !!(iAmHost && !seat2 && !everFilled);
  if (tools) tools.classList.toggle("hidden", !showTools);

  const linkEl = qs("readyInviteLinkText");
  if (linkEl) {
    const params = new URLSearchParams();
    params.set("game", app.gameId || "");
    linkEl.textContent = `${withBase("/arcade/play/")}?${params.toString()}`;
  }
  const copyMsg = qs("readyInviteCopyMsg");
  if (copyMsg) copyMsg.classList.add("hidden");

  const inviteFriendsBtn = qs("readyInviteFriendsBtn");
  if (inviteFriendsBtn) inviteFriendsBtn.classList.toggle("hidden", !showTools);
} catch (_) {}

  const badge = (isReady) => isReady
    ? `<span class="dashWL w" style="margin-left:8px; padding:6px 10px;">READY</span>`
    : `<span class="dashWL l" style="margin-left:8px; padding:6px 10px;">NOT READY</span>`;

  const cardHtml = ({ title, name, photoURL, ready }) => {
    const img = photoURL
      ? `<img class="dashAvatar" src="${photoURL}" alt="Player photo" />`
      : `<div class="dashAvatar hidden"></div>`;
    return `
      <div class="readyroomdashIdentity" style="margin-bottom:14px; justify-content:space-between; display: block !important">
        <div class="row" style="display:block !important; align-items:center; gap:10px;">
          ${img}
          <div>
            <div class="dashWelcome">${title}</div>
            <div class="dashName" style="font-size:22px;">${name || "—"}</div>
          </div>
        </div>
        <div>${badge(ready)}</div>
      </div>
      <div style="opacity:.85;">Invite friends with your link. When both players are ready, the host can start.</div>
    `;
  };

  const p1Card = qs("readyRoomP1Inner");
  const p2Card = qs("readyRoomP2Inner");
  if (p1Card) p1Card.innerHTML = cardHtml({ title: "HOST", name: p1Name, photoURL: state?.seat1PhotoURL || state?.match?.seat1PhotoURL || state?.lobby?.host?.photoURL || null, ready: p1Ready });
  if (p2Card) {
    if (seat2) {
      p2Card.innerHTML = cardHtml({ title: "GUEST", name: p2Name, photoURL: state?.seat2PhotoURL || state?.match?.seat2PhotoURL || state?.lobby?.joiner?.photoURL || null, ready: p2Ready });
    } else {
      p2Card.innerHTML = "";
    }
  }

  const readyBtn = qs("readyRoomReadyBtn");
  if (readyBtn) {
    readyBtn.textContent = mineReady ? "Unready" : "Ready";
    readyBtn.classList.toggle("greenbutton", !mineReady);
    readyBtn.classList.toggle("danger", mineReady);
  }

  const leaveBtn = qs("readyRoomLeaveBtn");
  if (leaveBtn) leaveBtn.textContent = iAmHost ? "Back" : "Leave Match";

  openHiddenModal(modal);
}

async function toggleMyReady(ref) {
  const me = getActorId();
  if (!me) return;
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) return;
    const state = snap.data() || {};
    liveState = state;
    if (!isOnlineGame(state)) return;

    state.readyRoom = state.readyRoom || {};
    state.readyRoom.ready = state.readyRoom.ready || {};
    const cur = !!state.readyRoom.ready[me];
    state.readyRoom.ready[me] = !cur;
    state.readyRoom.updatedAt = Date.now();
    state.updatedAt = new Date();
    tx.set(ref, state);
  });
}

async function maybeAutoStartFromReady(ref, state) {
  if (!isOnlineGame(state)) return;
  if (isStarted(state)) return;
  const me = getActorId();
  const { seat1, seat2 } = seatIds(state);
  if (!me || !seat1 || me !== seat1) return;
  if (!seat2) return;

  const ready = getReadyMap(state);
  if (!(ready[seat1] === true && ready[seat2] === true)) return;

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) return;
    const fresh = snap.data() || {};
    if (!isOnlineGame(fresh)) return;
    if (fresh?.match?.arcade?.started === true) return;
    if (!fresh.match) return;
    fresh.match.arcade = fresh.match.arcade || {};
    fresh.match.arcade.started = true;
    fresh.updatedAt = new Date();
    tx.set(ref, fresh);
  });
}


function formatCounts(p) {
  const bulls = Number(p?.bulls) || 0;
  const outers = Number(p?.outers) || 0;
  const misses = Number(p?.misses) || 0;
  return `Bulls: ${bulls} • Outer: ${outers} • Misses: ${misses}`;
}


function formatAtcEndStatsHtml(atc, pIndex) {
  const p = atc?.players?.[pIndex] || {};
  const singles = Number(p.singles) || 0;
  const doubles = Number(p.doubles) || 0;
  const trebles = Number(p.trebles) || 0;
  const bulls = Number(p.bulls) || 0;
  const outers = Number(p.outers) || 0;
  const misses = Number(p.misses) || 0;

  const totalHits = singles + doubles + trebles + bulls + outers;
  const totalDarts = totalHits + misses;
  const hitPct = totalDarts > 0 ? Math.round((totalHits / totalDarts) * 100) : 0;

  const inExit = !!p.inExit;
  const finalTarget = inExit ? "BULL" : String(Number(p.target) || (Number(atc?.startOn) || 1));

  const exitType = atc?.exitType || "bull";
  let exitLine = "";
  if (inExit) {
    if (exitType === "outer_and_bull") {
      exitLine = p.exitArmed ? "Exit: Armed (Bull to win)" : "Exit: Not armed (Outer then Bull)";
    } else if (exitType === "outer_or_bull") {
      exitLine = "Exit: Outer or Bull";
    } else {
      exitLine = "Exit: Bull";
    }
  }

  const visits = Array.isArray(atc?.visitsTaken) ? (Number(atc.visitsTaken[pIndex]) || 0) : 0;

  const rows = [
    `<div><b>Final:</b> ${finalTarget}</div>`,
    `<div><b>Total hits:</b> ${totalHits}</div>`,
    `<div><b>Singles:</b> ${singles} &nbsp; <b>Doubles:</b> ${doubles} &nbsp; <b>Trebles:</b> ${trebles}</div>`,
    `<div><b>Misses:</b> ${misses} &nbsp; <b>Hit %:</b> ${hitPct}%</div>`,
    (bulls + outers) > 0 ? `<div><b>Bulls:</b> ${bulls} &nbsp; <b>Outer:</b> ${outers}</div>` : "",
    visits ? `<div style="opacity:.85; margin-top:6px;">Visits: ${visits}</div>` : "",
    exitLine ? `<div style="opacity:.9; margin-top:6px;">${exitLine}</div>` : "",
  ].filter(Boolean);

  return rows.join("");
}

function computeAllowInput(state, currentPlayer) {
  const online = isOnlineGame(state);
  const startedOk = isStarted(state);
  const joinedOk = !online || !!(state?.match?.seat2Id || state?.seat2Id);
  if (!startedOk) return false;
  if (!joinedOk) return false;

  if (!online) return true;

  const actor = getActorId();
  const mutual = state?.match?.allowMutualControl !== false;
  const seat1 = state?.match?.seat1Id || state?.seat1Id || state?.lobby?.host?.actorId || null;
  const seat2 = state?.match?.seat2Id || state?.seat2Id || null;

  if (!actor) return false;

  if (mutual) {
    return (actor === seat1 || actor === seat2);
  }
  const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
  return mySeat === Number(currentPlayer || 0);
}

let __lastArcadeMode = null;
let __lastArcadeCurrentPlayer = null;

function render(state) {
  const modeNow = getArcadeMode(state);
  const cpNow = (() => {
    if (modeNow === "around_the_clock") return state?.match?.arcade?.atcState?.currentPlayer ?? state?.match?.arcade?.atc?.currentPlayer ?? state?.match?.arcade?.atcState?.currentPlayer;
    if (modeNow === "bull_challenge") return state?.leg?.currentPlayer ?? state?.match?.leg?.currentPlayer ?? state?.match?.currentPlayer;
    if (modeNow === "high_score") return state?.match?.arcade?.highScoreState?.currentPlayer;
    if (modeNow === "rounds") return state?.match?.arcade?.roundsState?.currentPlayer;
    if (modeNow === "race") return state?.match?.arcade?.raceState?.currentPlayer;
    return null;
  })();

  // Clear score input when turn changes or mode changes (prevents stale typed values carrying across turns/modes).
  if (__lastArcadeMode !== null && (__lastArcadeMode !== modeNow || (__lastArcadeCurrentPlayer !== null && cpNow !== null && Number(__lastArcadeCurrentPlayer) !== Number(cpNow)))) {
    const si = document.getElementById("scoreInput");
    if (si) si.value = "";
    // Also clear dartpad pending UI if available
    if (typeof clearDarts === "function") {
      try { clearDarts(); } catch (e) {}
    }
  }
  __lastArcadeMode = modeNow;
  __lastArcadeCurrentPlayer = cpNow;

  const mode = getArcadeMode(state);
  if (mode === "around_the_clock") return renderAtc(state);
  if (mode === "high_score") return renderHighScore(state);
  if (mode === "rounds") return renderRounds(state);
  if (mode === "race") return renderRace(state);
  return renderBull(state);
}


// ---------------------------
// High Score (fixed rounds) — Segment 1
// ---------------------------

function ensureHighScoreConfig(state) {
  const cfg = state?.match?.arcade?.highScore;
  if (cfg && typeof cfg === "object") return cfg;
  return { rounds: 10 };
}


function parseHighScoreDartLabel(label) {
  const s = String(label || "").trim().toUpperCase();
  if (!s || s === "MISS" || s === "M") return { kind: "MISS", mult: "M", num: 0, score: 0 };
  const m = s.match(/^([SDT])\s*(\d{1,2})$/);
  if (m) {
    const mult = m[1];
    const num = Number(m[2]) || 0;
    const score = mult === "D" ? num * 2 : mult === "T" ? num * 3 : num;
    return { kind: "NUM", mult, num, score };
  }
  // Fallback: numeric score
  const n = Number(s);
  if (isFinite(n)) return { kind: "RAW", mult: "R", num: 0, score: Math.max(0, Math.round(n)) };
  return { kind: "UNK", mult: "U", num: 0, score: 0 };

}


// ---------------------------------------------------------------------------
// Score-game shared helpers (used by High Score now; reused for Rounds/Race next)
// ---------------------------------------------------------------------------

function scoregame_applyDartToCounters(pObj, dartLabel) {
  const parsed = parseHighScoreDartLabel(dartLabel);
  if (parsed.kind === "MISS" || parsed.score === 0) {
    pObj.misses += 1;
    return;
  }
  if (parsed.mult === "S") pObj.singles += 1;
  if (parsed.mult === "D") pObj.doubles += 1;
  if (parsed.mult === "T") pObj.trebles += 1;
}

function scoregame_visitScoreFromDarts(dartsArr) {
  let total = 0;
  for (const d of (Array.isArray(dartsArr) ? dartsArr : [])) {
    const parsed = parseHighScoreDartLabel(d);
    total += Number(parsed.score || 0);
  }
  return total;
}

function computeHighScoreStateFromHistory(state) {
  const cfg = ensureHighScoreConfig(state);
  const rounds = Number(cfg.rounds || 10);
  const hist = Array.isArray(state?.match?.arcade?.highScoreState?.history)
    ? state.match.arcade.highScoreState.history
    : [];

  const players = [
    { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
    { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
  ];

  for (const v of hist) {
    const p = Number(v?.p ?? 0);
    if (p !== 0 && p !== 1) continue;
    const score = Number(v?.score || 0);
    players[p].total += score;
    players[p].visits += 1;
    const dartsArr = Array.isArray(v?.darts) ? v.darts : [];
    players[p].darts += dartsArr.length;
    for (const d of dartsArr) {
      scoregame_applyDartToCounters(players[p], d);
    }
  }

  const totalVisits = hist.length;
  const maxVisits = Math.max(0, rounds) * 2;
  const finished = (maxVisits > 0) ? (totalVisits >= maxVisits) : false;

  const roundIndex = (rounds > 0) ? Math.floor(Math.min(totalVisits, maxVisits) / 2) : 0;
  const currentPlayer = finished ? 0 : (totalVisits % 2);

  let winner = null;
  if (finished) {
    if (players[0].total > players[1].total) winner = 0;
    else if (players[1].total > players[0].total) winner = 1;
    else winner = null; // draw
  }

  return {
    currentPlayer,
    roundIndex,
    rounds,
    finished,
    winner,
    history: hist,
    players,
  };
}


// -----------------------------
// High Score: classic-style keypad + dartpad (minimal port)
// -----------------------------

function ensureRoundsConfig(state) {
  const cfg = state?.match?.arcade?.rounds || state?.match?.arcade?.roundsConfig || {};
  const firstTo = Number(cfg.firstTo || cfg.first_to || 5);
  return { firstTo: ([5,10,15,20].includes(firstTo) ? firstTo : 5) };
}

function computeRoundsStateFromHistory(state) {
  const cfg = ensureRoundsConfig(state);
  const firstTo = Number(cfg.firstTo || 5);

  const hist = Array.isArray(state?.match?.arcade?.roundsState?.history)
    ? state.match.arcade.roundsState.history
    : [];

  const players = [
    { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
    { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
  ];

  // accumulate totals + per-dart counters
  for (const v of hist) {
    const p = Number(v?.p ?? 0);
    if (p !== 0 && p !== 1) continue;
    const score = Number(v?.score || 0);
    players[p].total += score;
    players[p].visits += 1;
    const dartsArr = Array.isArray(v?.darts) ? v.darts : [];
    players[p].darts += dartsArr.length;
    for (const d of dartsArr) scoregame_applyDartToCounters(players[p], d);
  }

  // round points (each round = 1 visit per player)
  const points = [0, 0];
  const roundScores = []; // [{p0, p1}]
  for (let i = 0; i < hist.length; i += 2) {
    const a = hist[i];
    const b = hist[i + 1];
    const s0 = (a && Number(a.p) === 0) ? Number(a.score || 0) : (b && Number(b.p) === 0) ? Number(b.score || 0) : null;
    const s1 = (a && Number(a.p) === 1) ? Number(a.score || 0) : (b && Number(b.p) === 1) ? Number(b.score || 0) : null;
    roundScores.push({ p0: s0, p1: s1 });

    if (s0 === null || s1 === null) continue; // round not complete
    if (s0 > s1) points[0] += 1;
    else if (s1 > s0) points[1] += 1;
  }

  const finished = (points[0] >= firstTo) || (points[1] >= firstTo);
  const currentPlayer = finished ? 0 : (hist.length % 2);
  const roundIndex = Math.floor(hist.length / 2);

  let winner = null;
  if (finished) {
    if (points[0] > points[1]) winner = 0;
    else if (points[1] > points[0]) winner = 1;
    else winner = null;
  }

  return { mode: "rounds", config: cfg, firstTo, players, points, roundIndex, currentPlayer, finished, winner, history: hist, roundScores };
}

function ensureRaceConfig(state) {
  const cfg = state?.match?.arcade?.race || state?.match?.arcade?.raceConfig || {};
  const target = Number(cfg.target || cfg.targetScore || 300);
  const valid = (target >= 100 && target <= 1000 && target % 100 === 0) ? target : 300;
  return { target: valid };
}

function computeRaceStateFromHistory(state) {
  const cfg = ensureRaceConfig(state);
  const target = Number(cfg.target || 300);

  const hist = Array.isArray(state?.match?.arcade?.raceState?.history)
    ? state.match.arcade.raceState.history
    : [];

  const players = [
    { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
    { total: 0, singles: 0, doubles: 0, trebles: 0, misses: 0, darts: 0, visits: 0 },
  ];

  for (const v of hist) {
    const p = Number(v?.p ?? 0);
    if (p !== 0 && p !== 1) continue;
    const score = Number(v?.score || 0);
    players[p].total += score;
    players[p].visits += 1;
    const dartsArr = Array.isArray(v?.darts) ? v.darts : [];
    players[p].darts += dartsArr.length;
    for (const d of dartsArr) scoregame_applyDartToCounters(players[p], d);
  }

  let winner = null;
  if (players[0].total >= target) winner = 0;
  if (players[1].total >= target) {
    if (winner === null) winner = 1;
    else if (players[1].total > players[0].total) winner = 1; // tie-break by higher total
  }

  const finished = winner !== null;
  const currentPlayer = finished ? 0 : (hist.length % 2);

  return { mode: "race", config: cfg, target, players, currentPlayer, finished, winner, history: hist };
}


function setInputMode(mode) {
  app.inputMode = mode;
  const keypad = document.getElementById("keypad");
  const dartArea = document.getElementById("dartTableArea");
  const voiceArea = document.getElementById("voiceArea");
  const picker = document.getElementById("inputModePicker");
  if (picker) picker.classList.add("hidden");

  if (keypad) keypad.classList.toggle("hidden", mode !== "keypad");
  if (dartArea) dartArea.classList.toggle("hidden", mode !== "table");
  if (voiceArea) voiceArea.classList.toggle("hidden", mode !== "voice");

  updateDartUI();
}

function clearDarts() {
  app.dartThrows = [];
  app.dartLabels = [];
  updateDartUI();
}

function popDart() {
  if (Array.isArray(app.dartThrows)) app.dartThrows.pop();
  if (Array.isArray(app.dartLabels)) app.dartLabels.pop();
  updateDartUI();
}

function pushDart(value, label) {
  if (!Array.isArray(app.dartThrows)) app.dartThrows = [];
  if (!Array.isArray(app.dartLabels)) app.dartLabels = [];
  if (app.dartThrows.length >= 3) return;
  app.dartThrows.push(Number(value) || 0);
  app.dartLabels.push(String(label || value || "MISS"));
  updateDartUI();
}

function updateDartUI() {
  const scoreInput = document.getElementById("scoreInput");
  if (!scoreInput) return;

  if (app.inputMode === "table") {
    const labels = Array.isArray(app.dartLabels) ? app.dartLabels : [];
    scoreInput.value = labels.join(" ");
    scoreInput.placeholder = labels.length < 3 ? `Enter ${3 - labels.length} dart(s)` : "";
  } else if (app.inputMode === "keypad") {
    scoreInput.placeholder = "Enter visit total (0–180)";
  } else {
    scoreInput.placeholder = "";
  }
}

function initHighScoreInputUi() {
  // High Score uses the classic input plumbing (keypad/dartpad) that is already wired globally.
  // This function is intentionally lightweight and idempotent to avoid double-binding click handlers.
  if (app._hsInputInited) return;
  app._hsInputInited = true;

  // Hide bull/outer buttons for High Score v1 (no bull scoring).
  const dartArea = document.getElementById("dartTableArea");
  if (dartArea) {
    dartArea.querySelectorAll(".dartInstantBtn").forEach((b) => b.classList.add("hidden"));
  }

}


function showHighScoreInputArea(show) {
  const hs = document.getElementById("hsInputArea");
  if (hs) hs.classList.toggle("hidden", !show);
  // NOTE: Do not toggle other keypads here. Each arcade mode renderer
  // must explicitly show/hide the correct keypad(s). This prevents
  // keypad "leakage" when switching modes (e.g., ATC keys showing in Bull).
}

function renderHighScore(state) {
  showHighScoreInputArea(true);

  const hs = computeHighScoreStateFromHistory(state);
  const p1 = hs.players?.[0] || {};
  const p2 = hs.players?.[1] || {};

  const p1ScoreEl = qs("bcP1Score");
  const p2ScoreEl = qs("bcP2Score");
  if (p1ScoreEl) p1ScoreEl.textContent = String(p1.total ?? 0);
  if (p2ScoreEl) p2ScoreEl.textContent = String(p2.total ?? 0);

  const titleEl = qs("bcTitle");
  if (titleEl) titleEl.textContent = "High Score";

  // Meta + names/photos (shared with other arcade modes)
  const metaEl = qs("arcadePlayMeta");
  if (metaEl) metaEl.textContent = "Arcade • High Score";

  const p1Name = state?.seat1Name || state?.match?.seat1Name || state?.lobby?.host?.name || "Player 1";
  const p2Name = state?.seat2Name || state?.match?.seat2Name || state?.lobby?.joiner?.name || "Player 2";
  const p1Photo = state?.seat1PhotoURL || state?.match?.seat1PhotoURL || state?.lobby?.host?.photoURL || null;
  const p2Photo = state?.seat2PhotoURL || state?.match?.seat2PhotoURL || state?.lobby?.joiner?.photoURL || null;

  const p1NameEl = qs("arcadeP1Name");
  const p2NameEl = qs("arcadeP2Name");
  if (p1NameEl) p1NameEl.textContent = p1Name;
  if (p2NameEl) p2NameEl.textContent = p2Name;

  const p1PhotoEl = qs("arcadeP1Photo");
  const p2PhotoEl = qs("arcadeP2Photo");
  if (p1PhotoEl) {
    if (p1Photo) { p1PhotoEl.src = p1Photo; p1PhotoEl.classList.remove("hidden"); }
    else { p1PhotoEl.classList.add("hidden"); }
  }
  if (p2PhotoEl) {
    if (p2Photo) { p2PhotoEl.src = p2Photo; p2PhotoEl.classList.remove("hidden"); }
    else { p2PhotoEl.classList.add("hidden"); }
  }

  const subEl = qs("bcSubTitle");
  const r = Math.max(1, Math.min((hs.roundIndex ?? 0) + 1, hs.rounds || 1));
  if (subEl) {
    subEl.textContent = hs.finished
      ? "Finished"
      : `Round ${r} / ${hs.rounds} • ${hs.currentPlayer === 0 ? "Player 1" : "Player 2"} to throw`;
  }

  // High Score uses the classic input bar; hide Bull/ATC visit UI bits and wire the round hint.
  const hideByIdOrRole = (id, role) => {
    const el = document.getElementById(id) || document.querySelector(`[data-role="${role}"]`);
    if (!el) return;
    el.classList.add("hidden");
    el.style.display = "none";
  };
  hideByIdOrRole("bcVisitEntry", "arcadeVisitEntry");
  hideByIdOrRole("bcRoundHintDarts", "arcadeRoundHintDarts");

  const hintRounds = document.getElementById("bcRoundHintRounds") || document.querySelector(`[data-role="arcadeRoundHintRounds"]`);
  if (hintRounds) {
    hintRounds.classList.remove("hidden");
    hintRounds.style.display = "";
    hintRounds.textContent = `Round ${r} / ${hs.rounds || 1}`;
  }

  // Active player highlight
  const p1Box = document.getElementById("bcP1Box") || document.querySelector(`[data-role="arcadeP1Box"]`) || qs("arcadeP1Box");
  const p2Box = document.getElementById("bcP2Box") || document.querySelector(`[data-role="arcadeP2Box"]`) || qs("arcadeP2Box");
  if (p1Box) p1Box.classList.toggle("active", Number(hs.currentPlayer || 0) === 0);
  if (p2Box) p2Box.classList.toggle("active", Number(hs.currentPlayer || 0) === 1);

  // Disable scoring if not your turn (online gating reuse) if not your turn (online gating reuse)
  const online = isOnlineGame(state);
  const mutualOff = online && state?.match?.allowMutualControl === false;

  let canScore = true;
  let mySeat = -1;

  if (mutualOff) {
    const ids = getSeatIds(state);
    const actor = getActorId();
    const seat1 = ids.seat1;
    const seat2 = ids.seat2;
    mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);

    const joinedOk = !!ids.seat2;
    const startedOk = isStarted(state);
    const curSeat = Number(hs.currentPlayer || 0);

    // Only allow input when: started, both seats present, you are seated, not finished, and it is your turn.
    canScore = !!(startedOk && joinedOk && !hs.finished && mySeat >= 0 && mySeat === curSeat);
  } else {
    // Local games or mutual control on: allow normal interaction (we still block when finished).
    canScore = !hs.finished;
  }

  // Turn overlay parity with Bull/ATC. Only used when Online + Mutual Control is OFF.
  try {
    const overlay = qs("turnOverlay");
    const overlayText = qs("turnOverlayText");
    const overlayUndo = qs("overlayUndoBtn");

    if (!mutualOff || !overlay) {
      if (overlay) overlay.classList.add("hidden");
    } else {
      const ids = getSeatIds(state);
      const joinedOk = !!ids.seat2;
      const startedOk = isStarted(state);
      const curSeat = Number(hs.currentPlayer || 0);

      const p1Name = state?.match?.seat1Name || state?.seat1Name || "Player 1";
      const p2Name = state?.match?.seat2Name || state?.seat2Name || "Player 2";
      const curName = curSeat === 0 ? p1Name : p2Name;

      const show = startedOk && joinedOk && !hs.finished && (mySeat >= 0) && (mySeat !== curSeat);
      overlay.classList.toggle("hidden", !show);
      if (overlayText) overlayText.textContent = `It's ${curName}'s turn`;

      if (overlayUndo) {
        const hist = Array.isArray(hs.history)
          ? hs.history
          : (Array.isArray(state?.match?.arcade?.highScoreState?.history) ? state.match.arcade.highScoreState.history : []);
        const last = hist && hist.length ? hist[hist.length - 1] : null;
        const canUndo = !!(show && last && Number(last.p) === Number(mySeat));
        overlayUndo.classList.toggle("hidden", !canUndo);
      }
    }
  } catch (_) {}

  const submitBtn = document.getElementById("submitBtn");

  const undoBtn = document.getElementById("undoBtn");
  const scoreInput = document.getElementById("scoreInput");

  if (submitBtn) submitBtn.disabled = !canScore || hs.finished;
  if (undoBtn) undoBtn.disabled = !canScore; // local protection is handled separately for Segment 1
  if (scoreInput) scoreInput.disabled = !canScore || hs.finished;

  // When you can't score, block ALL input controls (mode switcher, keypad, dartpad).
  try {
    const inputModeBtn = qs("inputModeBtn");
    const pickKeypad = qs("pickKeypadModeBtn");
    const pickTable = qs("pickTableModeBtn");
    const pickVoice = qs("pickVoiceModeBtn");
    if (inputModeBtn) inputModeBtn.disabled = !canScore || hs.finished;
    if (pickKeypad) pickKeypad.disabled = !canScore || hs.finished;
    if (pickTable) pickTable.disabled = !canScore || hs.finished;
    if (pickVoice) pickVoice.disabled = !canScore || hs.finished;

    const kp = document.getElementById("keypad");
    if (kp) kp.querySelectorAll("button").forEach(b => b.disabled = !canScore || hs.finished);
    const dp = document.getElementById("dartPad");
    if (dp) dp.querySelectorAll("button").forEach(b => b.disabled = !canScore || hs.finished);
  } catch (_) {}
// End-of-game: show winner modal stats grid
try {
  if (hs.finished) {
    const p1Name = state?.seat1Name || state?.match?.seat1Name || state?.lobby?.host?.name || "Player 1";
    const p2Name = state?.seat2Name || state?.match?.seat2Name || state?.lobby?.joiner?.name || "Player 2";
    const p1Photo = state?.seat1PhotoURL || state?.match?.seat1PhotoURL || state?.lobby?.host?.photoURL || null;
    const p2Photo = state?.seat2PhotoURL || state?.match?.seat2PhotoURL || state?.lobby?.joiner?.photoURL || null;

    let winText = "Draw";
    if (hs.winner === 0) winText = `${p1Name} wins!`;
    if (hs.winner === 1) winText = `${p2Name} wins!`;

    const hits = (p) => (Number(p.singles)||0) + (Number(p.doubles)||0) + (Number(p.trebles)||0);
    const pct = (p) => {
      const d = Number(p.darts)||0;
      return d > 0 ? (Math.round((hits(p) / d) * 100) + "%") : "0%";
    };
    const avg = (p) => {
      const v = Number(p.visits)||0;
      const t = Number(p.total)||0;
      return v > 0 ? (t / v).toFixed(1) : "0.0";
    };
    const bestVisit = (playerIndex) => {
      let best = 0;
      for (const v of (hs.history || [])) {
        if (Number(v?.p) !== playerIndex) continue;
        best = Math.max(best, Number(v?.score) || 0);
      }
      return best;
    };

    openArcadeEndModal({
      title: winText,
      p1Name, p2Name,
      p1PhotoURL: p1Photo,
      p2PhotoURL: p2Photo,
      rows: [
        { label: "Total", p1: Number(p1.total)||0, p2: Number(p2.total)||0 },
        { label: "Avg/visit", p1: avg(p1), p2: avg(p2) },
        { label: "Best visit", p1: bestVisit(0), p2: bestVisit(1) },
        { label: "Singles", p1: Number(p1.singles)||0, p2: Number(p2.singles)||0 },
        { label: "Doubles", p1: Number(p1.doubles)||0, p2: Number(p2.doubles)||0 },
        { label: "Trebles", p1: Number(p1.trebles)||0, p2: Number(p2.trebles)||0 },
        { label: "Misses", p1: Number(p1.misses)||0, p2: Number(p2.misses)||0 },
        { label: "Hit %", p1: pct(p1), p2: pct(p2) },
      ],
    });
  } else {
    closeArcadeEndModal();
  }
} catch (_) {}
  // Keep classic dartpad UI consistent.
  try { updateDartUI(); } catch (_) {}
}



function renderRounds(state) {
  showHighScoreInputArea(true);

  // Hide Bull/ATC visit UI for score-based modes
  const hideByIdOrRole = (id, role) => {
    const el = document.getElementById(id) || document.querySelector(`[data-role="${role}"]`);
    if (!el) return;
    el.classList.add("hidden");
    el.style.display = "none";
  };
  hideByIdOrRole("bcVisitEntry", "arcadeVisitEntry");
  hideByIdOrRole("bcRoundHintDarts", "arcadeRoundHintDarts");

  const rs = computeRoundsStateFromHistory(state);
  const p1 = rs.players?.[0] || {};
  const p2 = rs.players?.[1] || {};

  // Title/meta
  const titleEl = qs("bcTitle");
  if (titleEl) titleEl.textContent = "Rounds";
  const metaEl = qs("arcadePlayMeta");
  if (metaEl) metaEl.textContent = "Arcade • Rounds";

  // Names/photos (match existing arcade pattern)
  const p1Name = state?.match?.seat1Name || state?.seat1Name || state?.lobby?.host?.name || "Player 1";
  const p2Name = state?.match?.seat2Name || state?.seat2Name || state?.lobby?.joiner?.name || "Player 2";
  const p1PhotoURL = state?.match?.seat1PhotoURL || state?.seat1PhotoURL || state?.lobby?.host?.photoURL || "";
  const p2PhotoURL = state?.match?.seat2PhotoURL || state?.seat2PhotoURL || state?.lobby?.joiner?.photoURL || "";

  const p1NameEl = qs("arcadeP1Name") || qs("bcP1Name");
  const p2NameEl = qs("arcadeP2Name") || qs("bcP2Name");
  if (p1NameEl) p1NameEl.textContent = p1Name;
  if (p2NameEl) p2NameEl.textContent = p2Name;

  const p1PhotoEl = qs("arcadeP1Photo") || qs("bcP1Photo");
  const p2PhotoEl = qs("arcadeP2Photo") || qs("bcP2Photo");
  if (p1PhotoEl) {
    if (p1PhotoURL) { p1PhotoEl.src = p1PhotoURL; p1PhotoEl.classList.remove("hidden"); }
    else { p1PhotoEl.classList.add("hidden"); }
  }
  if (p2PhotoEl) {
    if (p2PhotoURL) { p2PhotoEl.src = p2PhotoURL; p2PhotoEl.classList.remove("hidden"); }
    else { p2PhotoEl.classList.add("hidden"); }
  }

  // Scores = points
  const p1ScoreEl = qs("bcP1Score");
  const p2ScoreEl = qs("bcP2Score");
  if (p1ScoreEl) p1ScoreEl.textContent = String(rs.points?.[0] ?? 0);
  if (p2ScoreEl) p2ScoreEl.textContent = String(rs.points?.[1] ?? 0);

  // Round hint (keep the rounds row)
  const hintRounds = document.getElementById("bcRoundHintRounds") || document.querySelector(`[data-role="arcadeRoundHintRounds"]`);
  if (hintRounds) {
    hintRounds.classList.remove("hidden");
    hintRounds.style.display = "";
    hintRounds.textContent = rs.finished
      ? `Finished • First to ${rs.firstTo}`
      : `First to ${rs.firstTo} • Round ${rs.roundIndex + 1}`;
  }

  // Active player highlight
  const p1Box = document.getElementById("bcP1Box") || document.querySelector(`[data-role="arcadeP1Box"]`) || qs("arcadeP1Box");
  const p2Box = document.getElementById("bcP2Box") || document.querySelector(`[data-role="arcadeP2Box"]`) || qs("arcadeP2Box");
  if (p1Box) p1Box.classList.toggle("active", Number(rs.currentPlayer || 0) === 0);
  if (p2Box) p2Box.classList.toggle("active", Number(rs.currentPlayer || 0) === 1);

  // Online gating (same model as High Score)
  const online = isOnlineGame(state);
  const mutualOff = online && state?.match?.allowMutualControl === false;

  let canScore = true;
  let mySeat = -1;

  if (mutualOff) {
    const ids = getSeatIds(state);
    const actor = getActorId();
    const seat1 = ids.seat1;
    const seat2 = ids.seat2;
    mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);

    const joinedOk = !!ids.seat2;
    const startedOk = isStarted(state);
    const curSeat = Number(rs.currentPlayer || 0);

    canScore = !!(startedOk && joinedOk && !rs.finished && mySeat >= 0 && mySeat === curSeat);
  } else {
    canScore = !rs.finished;
  }

  // Turn overlay parity (only Online + Mutual Control OFF)
  try {
    const overlay = qs("turnOverlay");
    const overlayText = qs("turnOverlayText");
    const overlayUndo = qs("overlayUndoBtn");

    if (!mutualOff || !overlay) {
      if (overlay) overlay.classList.add("hidden");
    } else {
      const ids = getSeatIds(state);
      const joinedOk = !!ids.seat2;
      const startedOk = isStarted(state);
      const curSeat = Number(rs.currentPlayer || 0);
      const curName = curSeat === 0 ? p1Name : p2Name;

      const show = startedOk && joinedOk && !rs.finished && (mySeat >= 0) && (mySeat !== curSeat);
      overlay.classList.toggle("hidden", !show);
      if (overlayText) overlayText.textContent = `It's ${curName}'s turn`;

      if (overlayUndo) {
        const hist = Array.isArray(rs.history) ? rs.history : [];
        const last = hist.length ? hist[hist.length - 1] : null;
        const canUndo = !!(show && last && Number(last.p) === Number(mySeat));
        overlayUndo.classList.toggle("hidden", !canUndo);
      }
    }
  } catch (_) {}

  // Disable/enable input controls (classic input bar)
  const submitBtn = document.getElementById("submitBtn");
  const undoBtn = document.getElementById("undoBtn");
  const scoreInput = document.getElementById("scoreInput");

  if (submitBtn) submitBtn.disabled = !canScore || rs.finished;
  if (undoBtn) undoBtn.disabled = !canScore;
  if (scoreInput) scoreInput.disabled = !canScore || rs.finished;

  try {
    const inputModeBtn = qs("inputModeBtn");
    const pickKeypad = qs("pickKeypadModeBtn");
    const pickTable = qs("pickTableModeBtn");
    const pickVoice = qs("pickVoiceModeBtn");
    if (inputModeBtn) inputModeBtn.disabled = !canScore || rs.finished;
    if (pickKeypad) pickKeypad.disabled = !canScore || rs.finished;
    if (pickTable) pickTable.disabled = !canScore || rs.finished;
    if (pickVoice) pickVoice.disabled = !canScore || rs.finished;

    const kp = document.getElementById("keypad");
    if (kp) kp.querySelectorAll("button").forEach(b => b.disabled = !canScore || rs.finished);
    const dp = document.getElementById("dartPad");
    if (dp) dp.querySelectorAll("button").forEach(b => b.disabled = !canScore || rs.finished);
  } catch (_) {}
// End-of-game: winner modal stats grid
try {
  if (rs.finished) {
    let winText = "Draw";
    if (rs.winner === 0) winText = `${p1Name} wins!`;
    if (rs.winner === 1) winText = `${p2Name} wins!`;

    const hits = (p) => (Number(p.singles)||0) + (Number(p.doubles)||0) + (Number(p.trebles)||0);
    const pct = (p) => {
      const d = Number(p.darts)||0;
      return d > 0 ? (Math.round((hits(p) / d) * 100) + "%") : "0%";
    };
    const avg = (p) => {
      const v = Number(p.visits)||0;
      const t = Number(p.total)||0;
      return v > 0 ? (t / v).toFixed(1) : "0.0";
    };
    const bestVisit = (playerIndex) => {
      let best = 0;
      for (const v of (rs.history || [])) {
        if (Number(v?.p) !== playerIndex) continue;
        best = Math.max(best, Number(v?.score) || 0);
      }
      return best;
    };

    openArcadeEndModal({
      title: winText,
      p1Name, p2Name,
      p1PhotoURL,
      p2PhotoURL,
      rows: [
        { label: "Points", p1: Number(rs.points?.[0]||0), p2: Number(rs.points?.[1]||0) },
        { label: "Total scored", p1: Number(p1.total)||0, p2: Number(p2.total)||0 },
        { label: "Avg/visit", p1: avg(p1), p2: avg(p2) },
        { label: "Best visit", p1: bestVisit(0), p2: bestVisit(1) },
        { label: "Misses", p1: Number(p1.misses)||0, p2: Number(p2.misses)||0 },
        { label: "Hit %", p1: pct(p1), p2: pct(p2) },
      ],
    });
  } else {
    closeArcadeEndModal();
  }
} catch (_) {}

  try { updateDartUI(); } catch (_) {}
}




function renderRace(state) {
  showHighScoreInputArea(true);

  // Hide Bull/ATC visit UI for score-based modes
  const hideByIdOrRole = (id, role) => {
    const el = document.getElementById(id) || document.querySelector(`[data-role="${role}"]`);
    if (!el) return;
    el.classList.add("hidden");
    el.style.display = "none";
  };
  hideByIdOrRole("bcVisitEntry", "arcadeVisitEntry");
  hideByIdOrRole("bcRoundHintDarts", "arcadeRoundHintDarts");

  const rs = computeRaceStateFromHistory(state);
  const p1 = rs.players?.[0] || {};
  const p2 = rs.players?.[1] || {};

  // Title/meta
  const titleEl = qs("bcTitle");
  if (titleEl) titleEl.textContent = "Race";
  const metaEl = qs("arcadePlayMeta");
  if (metaEl) metaEl.textContent = "Arcade • Race";

  // Names/photos
  const p1Name = state?.match?.seat1Name || state?.seat1Name || state?.lobby?.host?.name || "Player 1";
  const p2Name = state?.match?.seat2Name || state?.seat2Name || state?.lobby?.joiner?.name || "Player 2";
  const p1PhotoURL = state?.match?.seat1PhotoURL || state?.seat1PhotoURL || state?.lobby?.host?.photoURL || "";
  const p2PhotoURL = state?.match?.seat2PhotoURL || state?.seat2PhotoURL || state?.lobby?.joiner?.photoURL || "";

  const p1NameEl = qs("arcadeP1Name") || qs("bcP1Name");
  const p2NameEl = qs("arcadeP2Name") || qs("bcP2Name");
  if (p1NameEl) p1NameEl.textContent = p1Name;
  if (p2NameEl) p2NameEl.textContent = p2Name;

  const p1PhotoEl = qs("arcadeP1Photo") || qs("bcP1Photo");
  const p2PhotoEl = qs("arcadeP2Photo") || qs("bcP2Photo");
  if (p1PhotoEl) {
    if (p1PhotoURL) { p1PhotoEl.src = p1PhotoURL; p1PhotoEl.classList.remove("hidden"); }
    else { p1PhotoEl.classList.add("hidden"); }
  }
  if (p2PhotoEl) {
    if (p2PhotoURL) { p2PhotoEl.src = p2PhotoURL; p2PhotoEl.classList.remove("hidden"); }
    else { p2PhotoEl.classList.add("hidden"); }
  }

  // Scores = total accumulated
  const p1ScoreEl = qs("bcP1Score");
  const p2ScoreEl = qs("bcP2Score");
  if (p1ScoreEl) p1ScoreEl.textContent = String(p1.total ?? 0);
  if (p2ScoreEl) p2ScoreEl.textContent = String(p2.total ?? 0);

  // Target hint
  const hintRounds = document.getElementById("bcRoundHintRounds") || document.querySelector(`[data-role="arcadeRoundHintRounds"]`);
  if (hintRounds) {
    hintRounds.classList.remove("hidden");
    hintRounds.style.display = "";
    hintRounds.textContent = rs.finished ? `Finished • Target ${rs.target}` : `Target ${rs.target}`;
  }

  // Active highlight
  const p1Box = document.getElementById("bcP1Box") || document.querySelector(`[data-role="arcadeP1Box"]`) || qs("arcadeP1Box");
  const p2Box = document.getElementById("bcP2Box") || document.querySelector(`[data-role="arcadeP2Box"]`) || qs("arcadeP2Box");
  if (p1Box) p1Box.classList.toggle("active", Number(rs.currentPlayer || 0) === 0);
  if (p2Box) p2Box.classList.toggle("active", Number(rs.currentPlayer || 0) === 1);

  // Online gating (same model as High Score)
  const online = isOnlineGame(state);
  const mutualOff = online && state?.match?.allowMutualControl === false;

  let canScore = true;
  let mySeat = -1;

  if (mutualOff) {
    const ids = getSeatIds(state);
    const actor = getActorId();
    const seat1 = ids.seat1;
    const seat2 = ids.seat2;
    mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);

    const joinedOk = !!ids.seat2;
    const startedOk = isStarted(state);
    const curSeat = Number(rs.currentPlayer || 0);

    canScore = !!(startedOk && joinedOk && !rs.finished && mySeat >= 0 && mySeat === curSeat);
  } else {
    canScore = !rs.finished;
  }

  // Turn overlay parity (only Online + Mutual Control OFF)
  try {
    const overlay = qs("turnOverlay");
    const overlayText = qs("turnOverlayText");
    const overlayUndo = qs("overlayUndoBtn");

    if (!mutualOff || !overlay) {
      if (overlay) overlay.classList.add("hidden");
    } else {
      const ids = getSeatIds(state);
      const joinedOk = !!ids.seat2;
      const startedOk = isStarted(state);
      const curSeat = Number(rs.currentPlayer || 0);
      const curName = curSeat === 0 ? p1Name : p2Name;

      const show = startedOk && joinedOk && !rs.finished && (mySeat >= 0) && (mySeat !== curSeat);
      overlay.classList.toggle("hidden", !show);
      if (overlayText) overlayText.textContent = `It's ${curName}'s turn`;

      if (overlayUndo) {
        const hist = Array.isArray(rs.history) ? rs.history : [];
        const last = hist.length ? hist[hist.length - 1] : null;
        const canUndo = !!(show && last && Number(last.p) === Number(mySeat));
        overlayUndo.classList.toggle("hidden", !canUndo);
      }
    }
  } catch (_) {}

  // Disable/enable input controls
  const submitBtn = document.getElementById("submitBtn");
  const undoBtn = document.getElementById("undoBtn");
  const scoreInput = document.getElementById("scoreInput");

  if (submitBtn) submitBtn.disabled = !canScore || rs.finished;
  if (undoBtn) undoBtn.disabled = !canScore;
  if (scoreInput) scoreInput.disabled = !canScore || rs.finished;

  try {
    const inputModeBtn = qs("inputModeBtn");
    const pickKeypad = qs("pickKeypadModeBtn");
    const pickTable = qs("pickTableModeBtn");
    const pickVoice = qs("pickVoiceModeBtn");
    if (inputModeBtn) inputModeBtn.disabled = !canScore || rs.finished;
    if (pickKeypad) pickKeypad.disabled = !canScore || rs.finished;
    if (pickTable) pickTable.disabled = !canScore || rs.finished;
    if (pickVoice) pickVoice.disabled = !canScore || rs.finished;

    const kp = document.getElementById("keypad");
    if (kp) kp.querySelectorAll("button").forEach(b => b.disabled = !canScore || rs.finished);
    const dp = document.getElementById("dartPad");
    if (dp) dp.querySelectorAll("button").forEach(b => b.disabled = !canScore || rs.finished);
  } catch (_) {}
// End-of-game: winner modal stats grid
try {
  if (rs.finished) {
    let winText = "Draw";
    if (rs.winner === 0) winText = `${p1Name} wins!`;
    if (rs.winner === 1) winText = `${p2Name} wins!`;

    const hits = (p) => (Number(p.singles)||0) + (Number(p.doubles)||0) + (Number(p.trebles)||0);
    const pct = (p) => {
      const d = Number(p.darts)||0;
      return d > 0 ? (Math.round((hits(p) / d) * 100) + "%") : "0%";
    };
    const avg = (p) => {
      const v = Number(p.visits)||0;
      const t = Number(p.total)||0;
      return v > 0 ? (t / v).toFixed(1) : "0.0";
    };
    const bestVisit = (playerIndex) => {
      let best = 0;
      for (const v of (rs.history || [])) {
        if (Number(v?.p) !== playerIndex) continue;
        best = Math.max(best, Number(v?.score) || 0);
      }
      return best;
    };

    openArcadeEndModal({
      title: winText,
      p1Name, p2Name,
      p1PhotoURL,
      p2PhotoURL,
      rows: [
        { label: "Target", p1: `${rs.target}`, p2: `${rs.target}` },
        { label: "Total", p1: Number(p1.total)||0, p2: Number(p2.total)||0 },
        { label: "Avg/visit", p1: avg(p1), p2: avg(p2) },
        { label: "Best visit", p1: bestVisit(0), p2: bestVisit(1) },
        { label: "Misses", p1: Number(p1.misses)||0, p2: Number(p2.misses)||0 },
        { label: "Hit %", p1: pct(p1), p2: pct(p2) },
      ],
    });
  } else {
    closeArcadeEndModal();
  }
} catch (_) {}

  try { updateDartUI(); } catch (_) {}
}






async function submitHighScoreVisit(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const mode = getArcadeMode(liveState || {});
  if (mode !== "high_score") return;

  // Determine visit score from input mode.
  const inputMode = app.inputMode || "keypad";
  let darts = [];
  let visitScore = 0;

  const scoreInput = document.getElementById("scoreInput");

  if (inputMode === "table") {
    const arr = Array.isArray(app.dartThrows) ? app.dartThrows.slice(0, 3) : [];
    if (arr.length !== 3) throw new Error("Enter 3 darts first");
    darts = arr.map((n) => Number(n) || 0);
    visitScore = (Array.isArray(app.dartThrows) ? app.dartThrows.slice(0, 3) : []).reduce((a, b) => a + (Number(b) || 0), 0);
  } else {
    // keypad mode: treat the input as a single visit total (0..180)
    const raw = (scoreInput?.value || "").trim();
    const n = Number(raw);
    if (!isFinite(n)) throw new Error("Enter a score first");
    if (n < 0 || n > 180) throw new Error("Score must be 0–180");
    visitScore = Math.round(n);
    darts = [visitScore];
  }

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const data = snap.data() || {};
    const state = { match: data.match || {} };
    const cfg = ensureHighScoreConfig(state);
    const rounds = Number(cfg.rounds || 10);

    const prevHist = Array.isArray(data?.match?.arcade?.highScoreState?.history)
      ? data.match.arcade.highScoreState.history
      : [];

    const totalVisits = prevHist.length;
    const maxVisits = Math.max(0, rounds) * 2;
    if (maxVisits > 0 && totalVisits >= maxVisits) return;

    const online = (data?.match?.lobbyType === "online") || (data?.lobbyType === "online") || (data?.match?.gameType === "online");
    const mutualOff = online && data?.match?.allowMutualControl === false;
    const actor = getActorId();

    // Prefer stored currentPlayer when available (important for online).
    const storedCur = Number(data?.match?.arcade?.highScoreState?.currentPlayer);
    const p = Number.isFinite(storedCur) ? storedCur : (totalVisits % 2);

    if (mutualOff) {
      const seat1 = data?.match?.seat1Id || data?.seat1Id || data?.lobby?.host?.actorId || null;
      const seat2 = data?.match?.seat2Id || data?.seat2Id || null;
      const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
      if (mySeat !== p) return; // ignore out-of-turn submits
    }

    const round = Math.floor(totalVisits / 2);

    const nextHist = prevHist.concat([{ p, round, darts, score: visitScore }]);
    const nextState = computeHighScoreStateFromHistory({
      match: { arcade: { highScore: cfg, highScoreState: { history: nextHist } } }
    });

    tx.update(ref, {
      "match.arcade.mode": "high_score",
      "match.arcade.highScore": { rounds: rounds },
      "match.arcade.highScoreState": {
        history: nextHist,
        currentPlayer: nextState.currentPlayer,
        roundIndex: nextState.roundIndex,
        rounds: nextState.rounds,
        finished: nextState.finished,
        winner: nextState.winner,
        players: nextState.players,
      },
      updatedAt: new Date(),
    });
  });

  // Clear local input buffers
  try { clearDarts(); } catch (_) { app.dartThrows = []; }
  if (scoreInput) scoreInput.value = "";
}


async function submitRoundsVisit(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const mode = getArcadeMode(liveState || {});
  if (mode !== "rounds") return;

  const inputMode = app.inputMode || "keypad";
  let darts = [];
  let visitScore = 0;

  const scoreInput = document.getElementById("scoreInput");

  if (inputMode === "table") {
    const arr = Array.isArray(app.dartThrows) ? app.dartThrows.slice(0, 3) : [];
    if (arr.length !== 3) throw new Error("Enter 3 darts first");
    darts = arr.map((n) => Number(n) || 0);
    visitScore = (Array.isArray(app.dartThrows) ? app.dartThrows.slice(0, 3) : []).reduce((a, b) => a + (Number(b) || 0), 0);
  } else {
    const raw = (scoreInput?.value || "").trim();
    const n = Number(raw);
    if (!isFinite(n)) throw new Error("Enter a score first");
    if (n < 0 || n > 180) throw new Error("Score must be 0–180");
    visitScore = Math.round(n);
    darts = [visitScore];
  }


  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const cur = snap.data() || {};
    const cfg = ensureRoundsConfig(cur);
    const st = computeRoundsStateFromHistory(cur);

    if (st.finished) return;

    // Online mutual-control gating (mirror High Score / Race)
    const online = (cur?.match?.lobbyType === "online") || (cur?.lobbyType === "online") || (cur?.match?.gameType === "online");
    const mutualOff = online && cur?.match?.allowMutualControl === false;
    if (mutualOff) {
      const actor = getActorId();
      const ids = getSeatIds({ match: cur.match || {} });
      const mySeat = (actor && ids.seat1 && actor === ids.seat1) ? 0 : ((actor && ids.seat2 && actor === ids.seat2) ? 1 : -1);
      const joinedOk = !!ids.seat2;
      const startedOk = isStarted({ match: cur.match || {}, lobbyType: cur?.lobbyType });
      const curSeat = Number(st.currentPlayer || 0);
      if (!(startedOk && joinedOk && mySeat >= 0 && mySeat === curSeat)) return;
    }

    const p = Number(st.currentPlayer || 0);
    const round = Math.floor((Array.isArray(st.history) ? st.history.length : 0) / 2);
    const nextHist = (Array.isArray(st.history) ? st.history : []).concat([{ p, round, darts, score: visitScore }]);

    const nextState = computeRoundsStateFromHistory({
      match: { arcade: { rounds: cfg, roundsState: { history: nextHist } } }
    });

    tx.update(ref, {
      "match.arcade.mode": "rounds",
      "match.arcade.rounds": { firstTo: Number(cfg.firstTo || 5) },
      "match.arcade.roundsState": {
        history: nextHist,
        currentPlayer: nextState.currentPlayer,
        roundIndex: nextState.roundIndex,
        firstTo: nextState.firstTo,
        points: nextState.points,
        finished: nextState.finished,
        winner: nextState.winner,
        players: nextState.players,
      },
      updatedAt: new Date(),
    });
  });

  try { clearDarts(); } catch (_) { app.dartThrows = []; }
  if (scoreInput) scoreInput.value = "";
}




async function submitRaceVisit(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const mode = getArcadeMode(liveState || {});
  if (mode !== "race") return;

  // Determine visit score from input mode.
  const inputMode = app.inputMode || "keypad";
  let darts = [];
  let visitScore = 0;

  const scoreInput = document.getElementById("scoreInput");

  if (inputMode === "table") {
    const arr = Array.isArray(app.dartThrows) ? app.dartThrows.slice(0, 3) : [];
    if (arr.length !== 3) throw new Error("Enter 3 darts first");
    darts = arr.map((n) => Number(n) || 0);
    visitScore = darts.reduce((a, b) => a + (Number(b) || 0), 0);
  } else {
    const raw = (scoreInput?.value || "").trim();
    const n = Number(raw);
    if (!isFinite(n)) throw new Error("Enter a score first");
    if (n < 0 || n > 180) throw new Error("Score must be 0–180");
    visitScore = Math.round(n);
    darts = [visitScore];
  }

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const data = snap.data() || {};
    const state = { match: data.match || {} };

    const cfg = ensureRaceConfig(state);

    const prevHist = Array.isArray(data?.match?.arcade?.raceState?.history)
      ? data.match.arcade.raceState.history
      : [];

    // Compute current state from history + config (source of truth)
    const curState = computeRaceStateFromHistory({
      match: {
        ...(data.match || {}),
        arcade: {
          ...(data?.match?.arcade || {}),
          race: data?.match?.arcade?.race || cfg,
          raceState: { history: prevHist },
        },
      },
    });

    if (curState.finished) return;

    const totalVisits = prevHist.length;
    const storedCur = Number(data?.match?.arcade?.raceState?.currentPlayer);
    const p = Number.isFinite(storedCur) ? storedCur : (totalVisits % 2);

    // Online mutual-control gating
    const online = (data?.match?.lobbyType === "online") || (data?.lobbyType === "online") || (data?.match?.gameType === "online");
    const mutualOff = online && data?.match?.allowMutualControl === false;

    if (mutualOff) {
      const actor = getActorId();
      const ids = getSeatIds({ match: data.match || {} });
      const mySeat = (actor && ids.seat1 && actor === ids.seat1) ? 0 : ((actor && ids.seat2 && actor === ids.seat2) ? 1 : -1);
      const joinedOk = !!ids.seat2;
      const startedOk = isStarted({ match: data.match || {}, lobbyType: data?.lobbyType });
      if (!(startedOk && joinedOk && mySeat >= 0 && mySeat === Number(curState.currentPlayer || 0))) return;
    }

    const nextHist = prevHist.concat([{ p, score: visitScore, darts, ts: Date.now() }]);

    const nextState = computeRaceStateFromHistory({
      match: {
        ...(data.match || {}),
        arcade: {
          ...(data?.match?.arcade || {}),
          race: cfg,
          raceState: { history: nextHist },
        },
      },
    });

    // Persist full derived state so render + input gating stay in sync.
    tx.update(ref, {
      "match.arcade.mode": "race",
      "match.arcade.race": cfg,
      "match.arcade.raceState": {
        history: nextHist,
        currentPlayer: Number(nextState.currentPlayer || 0),
        finished: !!nextState.finished,
        winner: (nextState.winner === 0 || nextState.winner === 1) ? nextState.winner : null,
        players: nextState.players || [],
        target: nextState.target,
      },
      updatedAt: new Date(),
      "match.updatedAt": new Date(),
    });
  });

  clearDarts();
  const scoreInputEl = document.getElementById("scoreInput");
  if (scoreInputEl) scoreInputEl.value = "";
  try { render(liveState || {}); } catch (_) {}
}


async function undoRace(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const mode = getArcadeMode(liveState || {});
  if (mode !== "race") return;

  // First clear pending input if any.
  if (app.inputMode === "table" && Array.isArray(app.dartThrows) && app.dartThrows.length) {
    try { clearDarts(); } catch (_) { app.dartThrows = []; }
    return;
  }
  const scoreInput = document.getElementById("scoreInput");
  if (scoreInput && scoreInput.value) {
    scoreInput.value = "";
    return;
  }

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data() || {};

    const online = (data?.lobbyType === "online") || (data?.match?.gameType === "online");
    const mutualOff = online && data?.match?.allowMutualControl === false;
    const actor = getActorId();

    const prevHist = Array.isArray(data?.match?.arcade?.raceState?.history)
      ? data.match.arcade.raceState.history
      : [];
    if (!prevHist.length) return;

    if (mutualOff) {
      const seat1 = data?.match?.seat1Id || data?.seat1Id || data?.lobby?.host?.actorId || null;
      const seat2 = data?.match?.seat2Id || data?.seat2Id || null;
      const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
      const lastP = Number(prevHist[prevHist.length - 1]?.p);
      if (mySeat !== lastP) return;
    }

    const nextHist = prevHist.slice(0, prevHist.length - 1);

    tx.update(ref, {
      "match.arcade.mode": "race",
      "match.arcade.raceState.history": nextHist,
      "match.arcade.raceState.currentPlayer": nextHist.length % 2,
      "match.arcade.raceState.roundIndex": Math.floor(nextHist.length / 2),
      "match.arcade.raceState.finished": false,
      "match.arcade.raceState.winner": null,
      updatedAt: new Date(),
    });
  });
}


async function undoRounds(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const mode = getArcadeMode(liveState || {});
  if (mode !== "rounds") return;

  // Clear pending input first
  if (app.inputMode === "table" && Array.isArray(app.dartThrows) && app.dartThrows.length) {
    try { clearDarts(); } catch (_) { app.dartThrows = []; }
    return;
  }
  const scoreInput = document.getElementById("scoreInput");
  if (scoreInput && scoreInput.value) {
    scoreInput.value = "";
    return;
  }

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const cur = snap.data() || {};
    const st = computeRoundsStateFromHistory(cur);
    const hist = Array.isArray(st.history) ? st.history.slice() : [];
    if (!hist.length) return;

    const last = hist[hist.length - 1];
    const p = Number(last?.p ?? -1);
    if (!canUndoNow(cur, p)) throw new Error("Cannot undo");

    hist.pop();

    const nextState = computeRoundsStateFromHistory({
      match: { arcade: { rounds: ensureRoundsConfig(cur), roundsState: { history: hist } } }
    });

    tx.update(ref, {
      "match.arcade.mode": "rounds",
      "match.arcade.roundsState": {
        history: hist,
        currentPlayer: nextState.currentPlayer,
        roundIndex: nextState.roundIndex,
        firstTo: nextState.firstTo,
        points: nextState.points,
        finished: nextState.finished,
        winner: nextState.winner,
        players: nextState.players,
      },
      updatedAt: new Date(),
    });
  });
}

async function undoHighScore(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const mode = getArcadeMode(liveState || {});
  if (mode !== "high_score") return;

  // First clear pending input if any.
  if (app.inputMode === "table" && Array.isArray(app.dartThrows) && app.dartThrows.length) {
    try { clearDarts(); } catch (_) { app.dartThrows = []; }
    return;
  }
  const scoreInput = document.getElementById("scoreInput");
  if (scoreInput && scoreInput.value) {
    scoreInput.value = "";
    return;
  }

  // Otherwise undo last submitted visit.
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const data = snap.data() || {};
    const prevHist = Array.isArray(data?.match?.arcade?.highScoreState?.history)
      ? data.match.arcade.highScoreState.history
      : [];
    if (!prevHist.length) return;

    const nextHist = prevHist.slice(0, prevHist.length - 1);
    const cfg = (data?.match?.arcade?.highScore) || { rounds: 10 };
    const nextState = computeHighScoreStateFromHistory({
      match: { arcade: { highScore: cfg, highScoreState: { history: nextHist } } }
    });

    tx.update(ref, {
      "match.arcade.highScoreState": {
        history: nextHist,
        currentPlayer: nextState.currentPlayer,
        roundIndex: nextState.roundIndex,
        rounds: nextState.rounds,
        finished: nextState.finished,
        winner: nextState.winner,
        players: nextState.players,
      },
      updatedAt: new Date(),
    });
  });
}

function wireHighScoreClassicInputUI(ref) {
  const hsArea = document.getElementById("hsInputArea");
  if (!hsArea) return;

  // Input mode picker
  const inputModeBtn = document.getElementById("inputModeBtn");
  const picker = document.getElementById("inputModePicker");
  if (inputModeBtn && picker) {
    inputModeBtn.addEventListener("click", () => {
      picker.classList.toggle("hidden");
    });
  }

  const pickKeypad = document.getElementById("pickKeypadModeBtn");
  const pickTable = document.getElementById("pickTableModeBtn");
  const pickVoice = document.getElementById("pickVoiceModeBtn");
  if (pickKeypad) pickKeypad.addEventListener("click", () => { try { setInputMode("keypad"); } catch (_) {} if (picker) picker.classList.add("hidden"); });
  if (pickTable) pickTable.addEventListener("click", () => { try { setInputMode("table"); } catch (_) {} if (picker) picker.classList.add("hidden"); });
  if (pickVoice) pickVoice.addEventListener("click", () => { /* voice not enabled in arcade */ if (picker) picker.classList.add("hidden"); });

  // Keypad numeric input
  const keypad = document.getElementById("keypad");
  const scoreInput = document.getElementById("scoreInput");
  if (keypad && scoreInput) {
    keypad.addEventListener("click", (e) => {
      const btn = e.target?.closest("button");
      if (!btn) return;
      const digit = btn.getAttribute("data-digit");
      if (digit) {
        scoreInput.value = (scoreInput.value || "") + digit;
        return;
      }
      if (btn.id === "keyBack") {
        scoreInput.value = (scoreInput.value || "").slice(0, -1);
        return;
      }
      if (btn.id === "keyClear") {
        scoreInput.value = "";
        return;
      }
    });
  }

  // Dartpad/table input
  const dartPad = document.getElementById("dartPad");
  if (dartPad) {
    dartPad.addEventListener("click", (e) => {
      const btn = e.target?.closest("button");
      if (!btn) return;

      const m = btn.getAttribute("data-mult");
      if (m) { try { setMult(m); } catch (_) {} return; }

      const instant = btn.getAttribute("data-instant");
      if (instant) { try { pushDart(Number(instant)); } catch (_) {} return; }

      const num = btn.getAttribute("data-num");
      if (num) {
        const v = Number(num);
        try { pushDart(v * multFactor(app.dartMult)); } catch (_) {}
        return;
      }

      const action = btn.getAttribute("data-action");
      if (action === "back") { try { popDart(); } catch (_) {} return; }
      if (action === "miss") { try { pushDart(0); } catch (_) {} return; }
    });
  }

    // High Score input plumbing (shared)
  initHighScoreInputUi();

  // Submit / undo
  const submitBtn = document.getElementById("submitBtn");
  const undoBtn = document.getElementById("undoBtn");
  if (submitBtn) submitBtn.addEventListener("click", async () => {
    try {
      const mode = getArcadeMode(liveState || {});
      if (mode === "high_score") await submitHighScoreVisit(ref);
      else if (mode === "rounds") await submitRoundsVisit(ref);
      else if (mode === "race") await submitRaceVisit(ref);
      else await submitVisit(ref);
    } catch (e) { showError(e?.message || String(e)); }
  });
  if (undoBtn) undoBtn.addEventListener("click", async () => {
    try {
      const mode = getArcadeMode(liveState || {});
      if (mode === "high_score") await undoHighScore(ref);
      else if (mode === "rounds") await undoRounds(ref);
      else if (mode === "race") await undoRace(ref);
      else await undo(ref);
    } catch (e) { showError(e?.message || String(e)); }
  });

  // Default input mode
  try { setInputMode(app.inputMode || "table"); } catch (_) {}
  try { updateDartUI(); } catch (_) {}
}

function atcPreviewTarget(state, playerIndex) {
  const atc = ensureAtcState(state);
  // If this player is in the exit stage, their next target is the bull.
  if (atc.players?.[playerIndex]?.inExit) return 20;
  const base = Number(atc.players?.[playerIndex]?.target) || ((Number(atc.startOn) === 20) ? 20 : 1);
  const dir = (atc.direction === "down") ? "down" : "up";
  const stepSign = (dir === "down") ? -1 : 1;
  const darts = Array.isArray(pendingHits) ? pendingHits : [];

  const multipliersOn = (atc.multipliers !== false);
  const valueOf = (d) => {
    if (d === "miss") return 0;
    if (!multipliersOn) return 1;
    if (d === "double") return 2;
    if (d === "treble") return 3;
    return 1; // single
  };

  const delta = darts.reduce((sum, d) => sum + valueOf(d), 0);
  const next = base + stepSign * delta;
  return Math.max(1, Math.min(20, next));
}

// ATC: Determine whether (within the CURRENT buffered 3-dart visit) the player
// should already be in the EXIT (bull) input stage for the *next* dart.
//
// This MUST be simulated dart-by-dart; a simple "previewTarget === 20" style
// shortcut is wrong for cases like: S19 -> S20 (still clock input), then S20
// again -> exit input.
function atcInExitDuringBuffer(state, playerIndex, bufferedHits) {
  try {
    const atc = ensureAtcState(state);
    if (!atc || !atc.players || !atc.players[playerIndex]) return false;

    // If already in exit stage (saved), we stay there.
    if (!!atc.players[playerIndex].inExit) return true;

    const startOn = (Number(atc.startOn) === 20) ? 20 : 1;
    const dir = (atc.direction === "down") ? "down" : "up";
    const stepSign = (dir === "down") ? -1 : 1;
    const endClock = (dir === "down") ? 1 : 20;
    const multipliersOn = (atc.multipliers !== false);

    let target = Number(atc.players[playerIndex].target);
    if (!Number.isFinite(target) || target < 1 || target > 20) target = startOn;
    let inExit = false;

    const darts = Array.isArray(bufferedHits) ? bufferedHits : [];
    const valueOf = (d) => {
      if (d === "miss") return 0;
      if (!multipliersOn) return 1;
      if (d === "double") return 2;
      if (d === "treble") return 3;
      return 1; // single
    };

    for (const d of darts) {
      if (inExit) break;

      // If we're already ON the endClock, the player must score on it (any
      // non-miss clock hit) to transition into exit stage.
      if (target === endClock) {
        const advance = valueOf(d);
        if (advance > 0) {
          inExit = true;
          break;
        }
        // miss: stay on endClock and remain in clock stage.
        continue;
      }

      const advance = valueOf(d);
      const nextRaw = target + stepSign * advance;
      const overshoot = (dir === "down") ? (nextRaw < endClock) : (nextRaw > endClock);
      if (overshoot) {
        // Any skip beyond the endClock (e.g. D19/T19) jumps straight into exit stage.
        target = endClock;
        inExit = true;
        break;
      }
      // Normal progression (or miss).
      const clamped = Math.max(1, Math.min(20, nextRaw));
      target = clamped;
    }

    return inExit;
  } catch (_) {
    // Safety: default to "not in exit" if anything is missing.
    return false;
  }
}


function atcExitInputContext(state, playerIndex, bufferedHits) {
  try {
    const atc = ensureAtcState(state);
    if (!atc || !atc.players || !atc.players[playerIndex]) return { inExit: false, allowOuter: false, exitType: "bull", exitArmed: false };

    const exitType = (atc.exitType === "outer_and_bull" || atc.exitType === "outer_or_bull") ? atc.exitType : "bull";

    // Start from saved player state.
    let target = Number(atc.players[playerIndex].target);
    const startOn = (Number(atc.startOn) === 20) ? 20 : 1;
    if (!Number.isFinite(target) || target < 1 || target > 20) target = startOn;

    const dir = (atc.direction === "down") ? "down" : "up";
    const stepSign = (dir === "down") ? -1 : 1;
    const endClock = (dir === "down") ? 1 : 20;
    const multipliersOn = (atc.multipliers !== false);

    let inExit = !!atc.players[playerIndex].inExit;
    let exitArmed = !!atc.players[playerIndex].exitArmed;

    const darts = Array.isArray(bufferedHits) ? bufferedHits : [];

    const valueOf = (d) => {
      if (d === "miss") return 0;
      if (!multipliersOn) return 1;
      if (d === "double") return 2;
      if (d === "treble") return 3;
      return 1; // single
    };

    for (const d of darts) {
      if (!inExit) {
        // CLOCK stage simulation (only consider S/D/T/Miss).
        const isClock = (d === "miss" || d === "single" || d === "double" || d === "treble");
        if (!isClock) continue;

        if (target === endClock) {
          const adv = valueOf(d);
          if (adv > 0) {
            inExit = true;
            // entering exit does not arm anything by itself
          }
          continue;
        }

        const adv = valueOf(d);
        const nextRaw = target + stepSign * adv;
        const overshoot = (dir === "down") ? (nextRaw < endClock) : (nextRaw > endClock);
        if (overshoot) {
          target = endClock;
          inExit = true;
          continue;
        }
        target = Math.max(1, Math.min(20, nextRaw));
        continue;
      }

      // EXIT stage simulation.
      if (exitType === "bull") {
        // Bull (red only): outer is not even an option.
        continue;
      }
      if (exitType === "outer_or_bull") {
        // Always allow outer.
        continue;
      }
      // outer_and_bull
      if (!exitArmed) {
        // First step: Outer OR Bull moves you to final-bull requirement.
        if (d === "outer" || d === "bull") exitArmed = true;
      } else {
        // Final step: Bull only (outer ignored even if present).
        // No state change needed for input context.
      }
    }

    const allowOuter = inExit && (
      exitType === "outer_or_bull" ||
      (exitType === "outer_and_bull" && !exitArmed)
    );

    return { inExit: !!inExit, allowOuter: !!allowOuter, exitType, exitArmed: !!exitArmed };
  } catch (_) {
    return { inExit: false, allowOuter: false, exitType: "bull", exitArmed: false };
  }
}

function ensureAtcState(state) {
  const raw = state?.match?.arcade?.atcState;
  const cfg = state?.match?.arcade?.atc || {};
  const startOn = (Number(cfg.startOn) === 20) ? 20 : 1;
  const direction = startOn === 20 ? "down" : "up";
  const multipliers = (cfg.multipliers !== false);
  const exitType = (cfg.exitType === "outer_and_bull" || cfg.exitType === "outer_or_bull") ? cfg.exitType : "bull";
  const punishment = (cfg.punishment === 1 || cfg.punishment === 2 || cfg.punishment === 3) ? cfg.punishment : 0;

  // If this is an older ATC match, raw may exist but not include config fields like multipliers.
  if (raw && typeof raw === "object") {
    if (typeof raw.multipliers === "boolean" && typeof raw.exitType === "string" && typeof raw.punishment === "number") return raw;
    return { ...raw, multipliers, exitType: (raw.exitType || exitType), punishment: (typeof raw.punishment === "number" ? raw.punishment : punishment) };
  }

  return computeAtcStateFromHistory({ startOn, direction, multipliers, exitType, punishment }, []);
}


function renderAtc(state) {
  showHighScoreInputArea(false);


  // ATC uses the Bull/ATC visit + dart hint panels (score-games hide these).
  const showByIdOrRole = (id, role) => {
    const el = document.getElementById(id) || document.querySelector(`[data-role="${role}"]`);
    if (el) { el.classList.remove("hidden"); el.style.display = ""; }
  };
  showByIdOrRole("bcVisitEntry", "arcadeVisitEntry");
  showByIdOrRole("bcRoundHintDarts", "arcadeRoundHintDarts");

  const atc = ensureAtcState(state);

  // Meta header
  const metaEl = qs("arcadePlayMeta");
  if (metaEl) metaEl.textContent = "Arcade • Around the Clock";

  // Names/photos (reuse existing IDs)
  // Online games tend to store identity under match.* and/or lobby joiner/host.
  // Use the same fallbacks as Ready Room so the nameRow always populates.
  const p1Name = state?.seat1Name || state?.match?.seat1Name || state?.lobby?.host?.name || "Player 1";
  const p2Name = state?.seat2Name || state?.match?.seat2Name || state?.lobby?.joiner?.name || "Player 2";
  const p1Photo = state?.seat1PhotoURL || state?.match?.seat1PhotoURL || state?.lobby?.host?.photoURL || null;
  const p2Photo = state?.seat2PhotoURL || state?.match?.seat2PhotoURL || state?.lobby?.joiner?.photoURL || null;

  const p1NameEl = qs("arcadeP1Name");
  const p2NameEl = qs("arcadeP2Name");
  if (p1NameEl) p1NameEl.textContent = p1Name;
  if (p2NameEl) p2NameEl.textContent = p2Name;

  const p1PhotoEl = qs("arcadeP1Photo");
  const p2PhotoEl = qs("arcadeP2Photo");
  if (p1PhotoEl) {
    if (p1Photo) { p1PhotoEl.src = p1Photo; p1PhotoEl.classList.remove("hidden"); }
    else { p1PhotoEl.classList.add("hidden"); }
  }
  if (p2PhotoEl) {
    if (p2Photo) { p2PhotoEl.src = p2Photo; p2PhotoEl.classList.remove("hidden"); }
    else { p2PhotoEl.classList.add("hidden"); }
  }

  // Scores = current target (or BULL when in exit stage)
  const p1ScoreEl = qs("arcadeP1Score");
  const p2ScoreEl = qs("arcadeP2Score");

  const p1InExit = !!atc.players?.[0]?.inExit;
  const p2InExit = !!atc.players?.[1]?.inExit;
  const p1Armed = !!atc.players?.[0]?.exitArmed;
  const p2Armed = !!atc.players?.[1]?.exitArmed;
  const p1ExitLabel = (p1InExit && atc.exitType === "outer_and_bull" && !p1Armed) ? "O-BULL" : (p1InExit ? "BULL" : null);
  const p2ExitLabel = (p2InExit && atc.exitType === "outer_and_bull" && !p2Armed) ? "O-BULL" : (p2InExit ? "BULL" : null);
  if (p1ScoreEl) p1ScoreEl.textContent = p1ExitLabel || String(Number(atc.players?.[0]?.target) || atc.startOn || 1);
  if (p2ScoreEl) p2ScoreEl.textContent = p2ExitLabel || String(Number(atc.players?.[1]?.target) || atc.startOn || 1);

  // Hide bull-only small stats in ATC (prevents leftover stats when switching modes).
  const p1StatsEl = qs("arcadeP1Stats");
  const p2StatsEl = qs("arcadeP2Stats");
  if (p1StatsEl) p1StatsEl.classList.add("hidden");
  if (p2StatsEl) p2StatsEl.classList.add("hidden");

  // Hints
  const hintRoundsEl = qs("arcadeRoundHintRounds");
  const hintDartsEl = qs("arcadeRoundHintDarts");
  if (hintRoundsEl) {
    const curP2 = Number(atc.currentPlayer || 0);
    const curPl = atc.players?.[curP2] || {};
    let extra = "";
    if (curPl.inExit) {
      if (atc.exitType === "outer_and_bull") {
        extra = curPl.exitArmed ? "Exit armed (Bull to win)" : "Exit not armed (Outer then Bull)";
      } else if (atc.exitType === "outer_or_bull") {
        extra = "Exit (Outer or Bull)";
      } else {
        extra = "Exit (Bull)";
      }
    }
    hintRoundsEl.textContent = extra ? `Around the Clock • ${extra}` : "Around the Clock";
  }
  if (hintDartsEl) {
    const darts = Array.isArray(pendingHits) ? pendingHits.length : 0;
    const n = Math.min(3, darts + 1);
    hintDartsEl.textContent = darts >= 3 ? `Darts 3/3` : `Darts ${n}/3`;
  }

  // Keypads
  const bcKeypad = qs("arcadeKeypad");
  const atcKeypad = qs("atcKeypad");

  const cur = Number(atc.currentPlayer || 0);
  const exitCtx = atcExitInputContext(state, cur, pendingHits);
  const inExitInput = !!exitCtx.inExit;
  const allowOuter = !!exitCtx.allowOuter;

  // In exit stage (after reaching 20/1), input switches to bull-only keypad.
  if (bcKeypad) bcKeypad.classList.toggle("hidden", !inExitInput);
  if (atcKeypad) atcKeypad.classList.toggle("hidden", inExitInput);

  // Ensure bull keypad labels are explicit
  const bcOuterBtn = qs("arcadeOuterBtn");
  const bcBullBtn = qs("arcadeBullBtn");
  const bcMissBtn = qs("arcadeMissBtn");
  if (bcOuterBtn) bcOuterBtn.textContent = "Outer Bull";
  if (bcBullBtn) bcBullBtn.textContent = "Bull";
  if (bcMissBtn) bcMissBtn.textContent = "Miss";

// Outer Bull availability depends on exit rule:
// - bull: Bull (red) only -> hide Outer Bull
// - outer_or_bull: show Outer + Bull
// - outer_and_bull: show Outer only until armed; then Bull only
if (bcOuterBtn) {
  const showOuter = allowOuter;
  bcOuterBtn.classList.toggle("hidden", !showOuter);
}


  const canAct = canActNow(state, atc);
  const ids = seatIds(state);
  const joinedOk = !isOnlineGame(state) || !!ids.seat2;
  const startedOk = isStarted(state);
  const allowInput = computeAllowInput(state, cur) && !atc.finished;

  // Turn overlay parity with Bull Challenge. Only used when Online + Mutual Control is OFF.
  try {
    const overlay = qs("turnOverlay");
    const overlayText = qs("turnOverlayText");
    const overlayUndo = qs("overlayUndoBtn");
    const online = isOnlineGame(state);
    const mutualOff = online && state?.match?.allowMutualControl === false;

    if (!mutualOff || !overlay) {
      if (overlay) overlay.classList.add("hidden");
    } else {
      const actor = getActorId();
      const seat1 = state?.match?.seat1Id || state?.seat1Id || null;
      const seat2 = state?.match?.seat2Id || state?.seat2Id || null;
      const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
      const curSeat = Number(atc.currentPlayer || 0);
      const curName = curSeat === 0 ? p1Name : p2Name;

      const show = startedOk && joinedOk && !atc.finished && (mySeat >= 0) && (mySeat !== curSeat);
      overlay.classList.toggle("hidden", !show);
      if (overlayText) overlayText.textContent = `It's ${curName}'s turn`;

      // Red Undo button on overlay: only allow undoing YOUR last submitted visit, after the turn has passed.
      if (overlayUndo) {
        const hist = Array.isArray(atc.history)
          ? atc.history
          : (Array.isArray(state?.match?.arcade?.atcState?.history) ? state.match.arcade.atcState.history : []);
        const last = hist && hist.length ? hist[hist.length - 1] : null;
        const canUndo = !!(show && last && Number(last.player) === Number(mySeat));
        overlayUndo.classList.toggle("hidden", !canUndo);
      }
    }
  } catch (_) {}
  const dartsNow = Array.isArray(pendingHits) ? pendingHits.length : 0;

  // Bull-only keypad button enabled state (used in exit stage)
  if (bcOuterBtn) bcOuterBtn.disabled = !inExitInput || !allowInput || dartsNow >= 3;
  if (bcBullBtn) bcBullBtn.disabled = !inExitInput || !allowInput || dartsNow >= 3;
  if (bcMissBtn) bcMissBtn.disabled = !inExitInput || !allowInput || dartsNow >= 3;

  const singleBtn = qs("atcSingleBtn");
  const doubleBtn = qs("atcDoubleBtn");
  const trebleBtn = qs("atcTrebleBtn");
  const missBtn = qs("atcMissBtn");

  const multipliersOn = (atc.multipliers !== false);
  const tgt = atcPreviewTarget(state, cur);

  if (singleBtn) {
    singleBtn.textContent = `S${tgt}`;
    singleBtn.disabled = inExitInput || !allowInput || dartsNow >= 3;
  }

  if (doubleBtn) {
    doubleBtn.textContent = `D${tgt}`;
    // Hide/disable when multipliers off (Phase 2 option)
    doubleBtn.classList.toggle("hidden", !multipliersOn);
    doubleBtn.disabled = inExitInput || !allowInput || dartsNow >= 3 || !multipliersOn;
  }

  if (trebleBtn) {
    trebleBtn.textContent = `T${tgt}`;
    trebleBtn.classList.toggle("hidden", !multipliersOn);
    trebleBtn.disabled = inExitInput || !allowInput || dartsNow >= 3 || !multipliersOn;
  }

  if (missBtn) {
    missBtn.disabled = inExitInput || !allowInput || dartsNow >= 3;
  }

  // Submit/back/clear same buttons
  const submitVisitBtn = qs("arcadeSubmitVisitBtn");
  if (submitVisitBtn) submitVisitBtn.disabled = !(allowInput && dartsNow === 3);
  const backBtn = qs("arcadeBackspaceVisitBtn");
  const clearBtn = qs("arcadeClearVisitBtn");
  if (backBtn) backBtn.disabled = !(allowInput && dartsNow > 0);
  if (clearBtn) clearBtn.disabled = !(allowInput && dartsNow > 0);

  // Undo visibility same rule
  const undoBtn = qs("arcadeUndoBtn");
  const mutualOff = isOnlineGame(state) && state?.match?.allowMutualControl === false;
  if (undoBtn) undoBtn.classList.toggle("hidden", !!mutualOff);
  // Local-only protection: disable Undo until at least one visit has been submitted.
  // Prevents a first-turn edge-case where undoing before any submitted visits can
  // desync the local pending buffer vs the UI.
  if (undoBtn && !isOnlineGame(state)) {
    const hasAnyVisits = Array.isArray(atc.history) && atc.history.length > 0;
    undoBtn.disabled = !hasAnyVisits;
  }

  // Active player highlight
  const p1Box = qs("arcadeP1Box");
  const p2Box = qs("arcadeP2Box");
  if (p1Box) p1Box.classList.toggle("active", Number(atc.currentPlayer||0) === 0);
  if (p2Box) p2Box.classList.toggle("active", Number(atc.currentPlayer||0) === 1);

  // Pending darts display
  const d1 = qs("arcadeDart1");
  const d2 = qs("arcadeDart2");
  const d3 = qs("arcadeDart3");
  // Always render pending hits so players can see what they've buffered.
  // Input itself is still enforced via button disabling + click-handler guards.
  const dartsArr = Array.isArray(pendingHits) ? pendingHits : [];
  const fmt = (h) => (
    h === "single" ? "S" :
    (h === "double" ? "D" :
      (h === "treble" ? "T" :
        (h === "outer" ? "Outer" :
          (h === "bull" ? "Bull" :
            (h === "miss" ? "Miss" : "—")))))
  );
  if (d1) d1.textContent = fmt(dartsArr[0]);
  if (d2) d2.textContent = fmt(dartsArr[1]);
  if (d3) d3.textContent = fmt(dartsArr[2]);// End modal (winnerModal-style stats grid)
if (atc.finished) {
  let winText = "Draw";
  if (atc.winner === 0) winText = `${p1Name} wins!`;
  if (atc.winner === 1) winText = `${p2Name} wins!`;

  const p0 = atc.players?.[0] || {};
  const p1p = atc.players?.[1] || {};
  const hits0 = (Number(p0.singles)||0)+(Number(p0.doubles)||0)+(Number(p0.trebles)||0)+(Number(p0.bulls)||0)+(Number(p0.outers)||0);
  const hits1 = (Number(p1p.singles)||0)+(Number(p1p.doubles)||0)+(Number(p1p.trebles)||0)+(Number(p1p.bulls)||0)+(Number(p1p.outers)||0);
  const darts0 = hits0 + (Number(p0.misses)||0);
  const darts1 = hits1 + (Number(p1p.misses)||0);
  const pct0 = darts0 ? Math.round((hits0/darts0)*100) + "%" : "0%";
  const pct1 = darts1 ? Math.round((hits1/darts1)*100) + "%" : "0%";

  openArcadeEndModal({
    title: winText,
    p1Name, p2Name,
    p1PhotoURL: p1Photo,
    p2PhotoURL: p2Photo,
    rows: [
      { label: "Singles", p1: Number(p0.singles)||0, p2: Number(p1p.singles)||0 },
      { label: "Doubles", p1: Number(p0.doubles)||0, p2: Number(p1p.doubles)||0 },
      { label: "Trebles", p1: Number(p0.trebles)||0, p2: Number(p1p.trebles)||0 },
      { label: "Misses", p1: Number(p0.misses)||0, p2: Number(p1p.misses)||0 },
      { label: "Hit %", p1: pct0, p2: pct1 },
    ],
  });
} else {
  closeArcadeEndModal();
}
}

function renderBull(state) {
  showHighScoreInputArea(false);

  // Keypad visibility: Bull uses bcKeypad only.
  const hsArea = document.getElementById("hsInputArea");
  if (hsArea) hsArea.classList.add("hidden");
  const bcKeypadEl = qs("arcadeKeypad");     // bcKeypad (data-role arcadeKeypad)
  const atcKeypadEl = qs("atcKeypad");
  if (bcKeypadEl) bcKeypadEl.classList.remove("hidden");
  if (atcKeypadEl) atcKeypadEl.classList.add("hidden");

  // Ensure Bull buttons are visible + correctly labelled (ATC can hide/rename these in exit stage).
  const bcOuterBtn = qs("arcadeOuterBtn");
  const bcBullBtn = qs("arcadeBullBtn");
  const bcMissBtn = qs("arcadeMissBtn");
  if (bcOuterBtn) { bcOuterBtn.classList.remove("hidden"); bcOuterBtn.textContent = "Outer Bull"; }
  if (bcBullBtn) { bcBullBtn.classList.remove("hidden"); bcBullBtn.textContent = "Bull"; }
  if (bcMissBtn) { bcMissBtn.classList.remove("hidden"); bcMissBtn.textContent = "Miss"; }


  // Bull Challenge uses the visit + dart hint panels (score-games hide these).
  const showByIdOrRole = (id, role) => {
    const el = document.getElementById(id) || document.querySelector(`[data-role="${role}"]`);
    if (el) { el.classList.remove("hidden"); el.style.display = ""; }
  };
  showByIdOrRole("bcVisitEntry", "arcadeVisitEntry");
  showByIdOrRole("bcRoundHintDarts", "arcadeRoundHintDarts");

  const bc = ensureBullChallengeState(state);

  // Names/photos
  // Online games tend to store identity under match.* and/or lobby joiner/host.
  // Use the same fallbacks as Ready Room so the nameRow always populates.
  const p1Name = state?.seat1Name || state?.match?.seat1Name || state?.lobby?.host?.name || "Player 1";
  const p2Name = state?.seat2Name || state?.match?.seat2Name || state?.lobby?.joiner?.name || "Player 2";
  const p1Photo = state?.seat1PhotoURL || state?.match?.seat1PhotoURL || state?.lobby?.host?.photoURL || null;
  const p2Photo = state?.seat2PhotoURL || state?.match?.seat2PhotoURL || state?.lobby?.joiner?.photoURL || null;

  const p1NameEl = qs("arcadeP1Name");
  const p2NameEl = qs("arcadeP2Name");
  if (p1NameEl) p1NameEl.textContent = p1Name;
  if (p2NameEl) p2NameEl.textContent = p2Name;

  const p1PhotoEl = qs("arcadeP1Photo");
  const p2PhotoEl = qs("arcadeP2Photo");
  if (p1PhotoEl) {
    if (p1Photo) { p1PhotoEl.src = p1Photo; p1PhotoEl.classList.remove("hidden"); }
    else { p1PhotoEl.classList.add("hidden"); }
  }
  if (p2PhotoEl) {
    if (p2Photo) { p2PhotoEl.src = p2Photo; p2PhotoEl.classList.remove("hidden"); }
    else { p2PhotoEl.classList.add("hidden"); }
  }

  // Scores
  const p1ScoreEl = qs("arcadeP1Score");
  const p2ScoreEl = qs("arcadeP2Score");
  if (p1ScoreEl) p1ScoreEl.textContent = String(Number(bc.players?.[0]?.score) || 0);
  if (p2ScoreEl) p2ScoreEl.textContent = String(Number(bc.players?.[1]?.score) || 0);

  // Small stats counts (non-end screen)
  const p1StatsEl = qs("arcadeP1Stats");
  const p2StatsEl = qs("arcadeP2Stats");
  if (p1StatsEl) p1StatsEl.textContent = formatCounts(bc.players?.[0]);
  if (p2StatsEl) p2StatsEl.textContent = formatCounts(bc.players?.[1]);

  // Round label: round increments after BOTH players complete a visit.

    const hintRoundsEl = qs("arcadeRoundHintRounds");
  const hintDartsEl = qs("arcadeRoundHintDarts");

  const mode = getArcadeMode(state) || "bull_challenge";
  const metaEl = qs("arcadePlayMeta");
  if (metaEl) {
    metaEl.textContent = `Arcade • ${mode === "bull_challenge" ? "Bull Challenge" : mode}`;
  }

  const canAct = canActNow(state, bc);
  const ids = seatIds(state);
  const joinedOk = !isOnlineGame(state) || !!ids.seat2;
  const startedOk = isStarted(state);
  const allowInput = canAct && joinedOk && startedOk && !bc.finished;

// Turn overlay (matches classic behavior). Only used when Online + Mutual Control is OFF.
try {
  const overlay = qs("turnOverlay");
  const overlayText = qs("turnOverlayText");
  const overlayUndo = qs("overlayUndoBtn");
  const online = isOnlineGame(state);
  const mutualOff = online && state?.match?.allowMutualControl === false;

  if (!mutualOff || !overlay) {
    if (overlay) overlay.classList.add("hidden");
  } else {
    const actor = getActorId();
    const seat1 = state?.match?.seat1Id || state?.seat1Id || null;
    const seat2 = state?.match?.seat2Id || state?.seat2Id || null;
    const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
    const curSeat = Number(bc.currentPlayer || 0);
    const curName = curSeat === 0 ? p1Name : p2Name;

    const show = startedOk && joinedOk && !bc.finished && (mySeat >= 0) && (mySeat !== curSeat);
    overlay.classList.toggle("hidden", !show);
    if (overlayText) overlayText.textContent = `It's ${curName}'s turn`;

    // Red Undo button on overlay: only allow undoing YOUR last submitted visit, after the turn has passed.
    if (overlayUndo) {
      const hist = Array.isArray(bc.history) ? bc.history : (Array.isArray(state?.match?.arcade?.bcState?.history) ? state.match.arcade.bcState.history : []);
      const last = hist && hist.length ? hist[hist.length - 1] : null;
      const canUndo = !!(show && last && Number(last.player) === Number(mySeat));
      overlayUndo.classList.toggle("hidden", !canUndo);
    }
  }
} catch (_) {}


    // Round + dart hints
  if (hintRoundsEl) {
    const v0 = Number(bc.visitsTaken?.[0] || 0);
    const v1 = Number(bc.visitsTaken?.[1] || 0);
    const eff = Number(bc.effectiveLimit || bc.visitsLimit || 10);
    const curRound = Math.min(eff, Math.min(v0, v1) + 1);
    hintRoundsEl.textContent = `Round ${curRound}/${eff}`;
  }
  if (hintDartsEl) {
    const darts = Array.isArray(pendingHits) ? pendingHits.length : 0;
    const n = Math.min(3, darts + 1);
    hintDartsEl.textContent = darts >= 3 ? `Darts 3/3` : `Darts ${n}/3`;
  }

  // Enable/disable buttons
  const keypad = qs("arcadeKeypad");
  if (keypad) keypad.classList.toggle("hidden", false);
  const dartsNow = Array.isArray(pendingHits) ? pendingHits.length : 0;
  for (const id of ["bcOuterBtn","bcBullBtn","bcMissBtn"]) {
    const b = qs(id);
    if (b) b.disabled = !allowInput || dartsNow >= 3;
  }


  const submitVisitBtn = qs("arcadeSubmitVisitBtn");
  if (submitVisitBtn) submitVisitBtn.disabled = !(allowInput && (Array.isArray(pendingHits) ? pendingHits.length : 0) === 3);
  const backBtn = qs("arcadeBackspaceVisitBtn");
  const clearBtn = qs("arcadeClearVisitBtn");
  const dartsNow2 = Array.isArray(pendingHits) ? pendingHits.length : 0;
  if (backBtn) backBtn.disabled = !(allowInput && dartsNow2 > 0);
  if (clearBtn) clearBtn.disabled = !(allowInput && dartsNow2 > 0);

  const undoBtn = qs("arcadeUndoBtn");
  const mutualOff = isOnlineGame(state) && state?.match?.allowMutualControl === false;
  if (undoBtn) undoBtn.classList.toggle("hidden", !!mutualOff);

  // Highlight current player box
  const p1Box = qs("arcadeP1Box");
  const p2Box = qs("arcadeP2Box");
  if (p1Box) p1Box.classList.toggle("active", Number(bc.currentPlayer||0) === 0);
  if (p2Box) p2Box.classList.toggle("active", Number(bc.currentPlayer||0) === 1);

  // Render pending darts UI
  const d1 = qs("arcadeDart1");
  const d2 = qs("arcadeDart2");
  const d3 = qs("arcadeDart3");
  const dartsArr = (allowInput && Array.isArray(pendingHits)) ? pendingHits : [];
  const fmt = (h) => h === "bull" ? "Bull" : (h === "outer" ? "Outer" : (h === "miss" ? "Miss" : "—"));
  if (d1) d1.textContent = fmt(dartsArr[0]);
  if (d2) d2.textContent = fmt(dartsArr[1]);
  if (d3) d3.textContent = fmt(dartsArr[2]);

  // End modal (winnerModal-style stats grid)
if (bc.finished) {
  let winText = "Draw";
  if (bc.winner === 0) winText = `${p1Name} wins!`;
  if (bc.winner === 1) winText = `${p2Name} wins!`;

  const p0 = bc.players?.[0] || {};
  const p1p = bc.players?.[1] || {};
  const totalHits0 = (Number(p0.bulls)||0) + (Number(p0.outers)||0);
  const totalHits1 = (Number(p1p.bulls)||0) + (Number(p1p.outers)||0);
  const darts0 = totalHits0 + (Number(p0.misses)||0);
  const darts1 = totalHits1 + (Number(p1p.misses)||0);
  const pct0 = darts0 ? Math.round((totalHits0/darts0)*100) + "%" : "0%";
  const pct1 = darts1 ? Math.round((totalHits1/darts1)*100) + "%" : "0%";

  openArcadeEndModal({
    title: winText,
    p1Name, p2Name,
    p1PhotoURL: p1Photo,
    p2PhotoURL: p2Photo,
    rows: [
      { label: "Bulls", p1: Number(p0.bulls)||0, p2: Number(p1p.bulls)||0 },
      { label: "Outer", p1: Number(p0.outers)||0, p2: Number(p1p.outers)||0 },
      { label: "Misses", p1: Number(p0.misses)||0, p2: Number(p1p.misses)||0 },
      { label: "Hit %", p1: pct0, p2: pct1 },
    ],
  });
} else {
  closeArcadeEndModal();
}


async function ensureDocHasBullState(ref) {
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;
    const mode = getArcadeMode(state);
    if (mode !== "bull_challenge") return;

    const bc = ensureBullChallengeState(state);
    const cur = state?.match?.arcade?.bcState;
    if (cur && typeof cur === "object") return;

    const match = { ...(state.match || {}) };
    const arcade = { ...(match.arcade || {}) };
    arcade.bcState = bc;
    match.arcade = arcade;

    tx.update(ref, { match, updatedAt: new Date() });
  });
}

async function ensureDocHasHighScoreState(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const snap = await ref.get();
  if (!snapExists(snap)) return;
  const data = snap.data() || {};
  const match = data.match || {};
  const arcade = match.arcade || {};
  const hsCfg = arcade.highScore || { rounds: 10 };
  const hsState = arcade.highScoreState || { history: [] };
  if (arcade.mode !== "high_score" || !hsCfg || !hsState) {
    await ref.update({
      "match.arcade.mode": "high_score",
      "match.arcade.highScore": hsCfg || { rounds: 10 },
      "match.arcade.highScoreState": hsState || { history: [] },
      updatedAt: new Date(),
    });
  }
}


async function ensureDocHasRoundsState(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const snap = await ref.get();
  if (!snapExists(snap)) return;
  const data = snap.data() || {};
  const match = data.match || {};
  const arcade = match.arcade || {};
  const cfg = arcade.rounds || { firstTo: 5 };
  const st = arcade.roundsState || { history: [], points: [0,0] };
  if (arcade.mode !== "rounds" || !cfg || !st) {
    await ref.update({
      "match.arcade.mode": "rounds",
      "match.arcade.rounds": cfg || { firstTo: 5 },
      "match.arcade.roundsState": st || { history: [], points: [0,0] },
      updatedAt: new Date(),
    });
  }
}

async function ensureDocHasRaceState(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  const snap = await ref.get();
  if (!snapExists(snap)) return;
  const data = snap.data() || {};
  const match = data.match || {};
  const arcade = match.arcade || {};
  const cfg = arcade.race || { target: 300 };
  const st = arcade.raceState || { history: [] };
  if (arcade.mode !== "race" || !cfg || !st) {
    await ref.update({
      "match.arcade.mode": "race",
      "match.arcade.race": cfg || { target: 300 },
      "match.arcade.raceState": st || { history: [] },
      updatedAt: new Date(),
    });
  }
}

async function ensureDocHasAtcState(ref) {
  if (!app.db) return;
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) return;
    const state = snap.data() || {};
    const atcRaw = state?.match?.arcade?.atcState;
    const atcCfg = state?.match?.arcade?.atc || {};
    const startOnNum = (Number(atcCfg.startOn) === 20) ? 20 : 1;
    const direction = startOnNum === 20 ? "down" : "up";
    const multipliers = (atcCfg.multipliers !== false);
    const exitType2 = (atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull";
    const punishment2 = (atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0;
    if (atcRaw && typeof atcRaw === "object") return;

    const freshAtc = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers, exitType: exitType2, punishment: punishment2 }, []);
    tx.update(ref, { "match.arcade.atcState": freshAtc, updatedAt: new Date() });
  });
}


function computeAtcStateFromHistory({ startOn, direction, multipliers, exitType, punishment }, history) {
  const dir = (direction === "down") ? "down" : "up";
  const start = (Number(startOn) === 20) ? 20 : 1;

  const exitMode = (exitType === "outer_and_bull" || exitType === "outer_or_bull") ? exitType : "bull";
  const punishmentMode = (punishment === 1 || punishment === 2 || punishment === 3) ? punishment : 0;

  const hist = Array.isArray(history)
    ? history.filter(h => h && (h.player === 0 || h.player === 1) && Array.isArray(h.darts) && h.darts.length === 3)
    : [];

  const players = [
    { target: start, inExit: false, exitArmed: false, singles: 0, doubles: 0, trebles: 0, misses: 0, hits: 0, bulls: 0, outers: 0 },
    { target: start, inExit: false, exitArmed: false, singles: 0, doubles: 0, trebles: 0, misses: 0, hits: 0, bulls: 0, outers: 0 },
  ];

  const visitsTaken = [0, 0];
  let currentPlayer = 0;
  let finished = false;
  let winner = null;

  const clampTarget = (n) => Math.max(1, Math.min(20, Number(n) || start));
  const stepSign = (dir === "down") ? -1 : 1;
  const endClock = (dir === "down") ? 1 : 20;
  const multipliersOn = (multipliers !== false);

  const isClockDart = (d) => (d === "miss" || d === "single" || d === "double" || d === "treble");
  const clockValue = (d) => {
    if (d === "miss") return 0;
    if (!multipliersOn) return 1;
    if (d === "double") return 2;
    if (d === "treble") return 3;
    return 1; // single
  };

  // Apply a single regression "step" (used for punishment). In exit stage, we regress
  // exit requirements first (AND mode), then fall back to numeric regression off the end clock.
  const regressOne = (pl) => {
    if (pl.inExit) {
      if (exitMode === "outer_and_bull" && pl.exitArmed) {
        // Regress from final-bull requirement back to outer-bull requirement.
        pl.exitArmed = false;
        return;
      }
      // Leave exit stage back to endClock (clock stage). Further regression steps (if any)
      // will move off the endClock numerically.
      pl.inExit = false;
      pl.exitArmed = false;
      pl.target = endClock;
      return;
    }
    pl.target = clampTarget(clampTarget(pl.target) - (stepSign * 1));
  };

  for (const entry of hist) {
    if (finished) break;

    const p = Number(entry.player || 0);
    const darts = (entry.darts || []).slice(0, 3);
    visitsTaken[p] += 1;

    let singlesThisVisit = 0;
    let doublesThisVisit = 0;
    let treblesThisVisit = 0;
    let missesThisVisit = 0;
    let bullsThisVisit = 0;
    let outersThisVisit = 0;

    for (const d of darts) {
      if (d === "single") singlesThisVisit += 1;
      else if (d === "double") doublesThisVisit += 1;
      else if (d === "treble") treblesThisVisit += 1;
      else if (d === "bull") bullsThisVisit += 1;
      else if (d === "outer") outersThisVisit += 1;
      else missesThisVisit += 1;
    }

    const pl = players[p];
    let winAchieved = false;

    // Simulate darts sequentially so exit rules (especially AND mode) behave correctly.
    for (const d of darts) {
      if (pl.inExit) {
        // EXIT stage behaviour.
        if (exitMode === "bull") {
          if (d === "bull") winAchieved = true;
        } else if (exitMode === "outer_or_bull") {
          if (d === "bull" || d === "outer") winAchieved = true;
        } else {
          // outer_and_bull:
          // Step 1 (O-BULL): hit Outer OR Bull to arm final bull requirement.
          // Step 2 (BULL): hit Bull (red) to finish.
          if (!pl.exitArmed) {
            if (d === "outer" || d === "bull") pl.exitArmed = true;
          } else {
            if (d === "bull") winAchieved = true;
          }
        }
        continue;
      }

      // CLOCK stage progression (S/D/T/Miss only). Any unexpected tokens are ignored.
      if (!isClockDart(d)) continue;

      const adv = clockValue(d);
      const oldTarget = clampTarget(pl.target);

      if (oldTarget === endClock) {
        // Must score on endClock (any non-miss clock hit) to move into exit.
        if (adv > 0) {
          pl.target = endClock;
          pl.inExit = true;
          // entering exit does not auto-arm
        }
        continue;
      }

      const nextRaw = oldTarget + stepSign * adv;
      const overshoot = (dir === "down") ? (nextRaw < endClock) : (nextRaw > endClock);
      if (overshoot) {
        pl.target = endClock;
        pl.inExit = true;
        continue;
      }
      pl.target = clampTarget(nextRaw);
    }

    // Aggregate stats (per dart, per player).
    pl.singles += singlesThisVisit;
    pl.doubles += doublesThisVisit;
    pl.trebles += treblesThisVisit;
    pl.misses += missesThisVisit;
    pl.hits += (singlesThisVisit + doublesThisVisit + treblesThisVisit);
    pl.bulls += bullsThisVisit;
    pl.outers += outersThisVisit;

    // Phase 4 punishment: after dart 3, before exit check. Applies on MISS darts only.
    if (punishmentMode > 0 && missesThisVisit > 0) {
      const steps = punishmentMode * missesThisVisit;
      for (let i = 0; i < steps; i += 1) regressOne(pl);
    }

    // Exit check (after punishment).
    if (winAchieved) {
      if (exitMode === "outer_and_bull") {
        if (pl.inExit && pl.exitArmed) {
          finished = true;
          winner = p;
        }
      } else {
        if (pl.inExit) {
          finished = true;
          winner = p;
        }
      }
    }

    currentPlayer = 1 - p;
  }

  return {
    phase: 2,
    startOn: start,
    direction: dir,
    multipliers: (multipliers !== false),
    exitType: exitMode,
    punishment: punishmentMode,
    history: hist,
    players,
    visitsTaken,
    currentPlayer,
    finished,
    winner,
  };
}


function addPendingHit(hit) {
  const mode = getArcadeMode(liveState || {});
  const isBull = (hit === "bull" || hit === "outer" || hit === "miss");
  const atcCfg = liveState?.match?.arcade?.atc || {};
  const multipliersOn = (atcCfg.multipliers !== false);
  const atcState = (mode === "around_the_clock") ? ensureAtcState(liveState || {}) : null;
  const curP = Number(atcState?.currentPlayer || 0);
  const ctx = (mode === "around_the_clock") ? atcExitInputContext(liveState || {}, curP, pendingHits) : { inExit:false, allowOuter:false };
  const inExit = !!ctx.inExit;
  const allowOuter = !!ctx.allowOuter;

  const isAtcClock = (hit === "single" || hit === "miss" || (multipliersOn && (hit === "double" || hit === "treble")));
  const isAtcExit = (hit === "miss" || hit === "bull" || (allowOuter && hit === "outer"));
  const hitKey = (mode === "around_the_clock")
    ? ((inExit ? isAtcExit : isAtcClock) ? hit : null)
    : (isBull ? hit : null);
  if (!hitKey) return;
  if (!Array.isArray(pendingHits)) pendingHits = [];
  if (pendingHits.length >= 3) return;
  pendingHits = pendingHits.concat([hitKey]).slice(0, 3);
}

function backspacePendingHit() {
  if (!Array.isArray(pendingHits) || pendingHits.length === 0) return;
  pendingHits = pendingHits.slice(0, pendingHits.length - 1);
}

function clearPendingHits() {
  pendingHits = [];
}


async function submitAtcVisit(ref) {
  if (!app.db) throw new Error("Missing Firestore");

  const darts = Array.isArray(pendingHits) ? pendingHits.slice(0, 3) : [];
  if (darts.length !== 3) throw new Error("Enter 3 darts first");

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;

    const online = isOnlineGame(state);
    const startedOk = isStarted(state);

    const actor = getActorId();
    if (online) {
      if (!startedOk) throw new Error("In ready room");
      const seat2 = state?.match?.seat2Id || state?.seat2Id || null;
      if (!seat2) throw new Error("Waiting for opponent");
    }

    const atcRaw = state?.match?.arcade?.atcState || {};
    const atcCfg = state?.match?.arcade?.atc || {};
    const startOnNum = (Number(atcCfg.startOn) === 20) ? 20 : 1;
    const direction = startOnNum === 20 ? "down" : "up";

    const multipliers = (atcCfg.multipliers !== false);
    const atc = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers, exitType: ((atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull"), punishment: ((atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0) }, atcRaw.history);

    if (atc.finished) return;

    const mutual = state?.match?.allowMutualControl !== false;
    const seat1 = state?.match?.seat1Id || state?.seat1Id || state?.lobby?.host?.actorId || null;
    const seat2 = state?.match?.seat2Id || state?.seat2Id || null;

    if (online && !actor) throw new Error("Not signed in");

    if (online && !mutual) {
      const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
      if (mySeat !== Number(atc.currentPlayer || 0)) throw new Error("Not your turn");
    } else if (online && mutual) {
      if (!(actor === seat1 || actor === seat2)) throw new Error("Not seated");
    }

    const nextHistory = Array.isArray(atc.history) ? atc.history.slice() : [];
    nextHistory.push({ player: Number(atc.currentPlayer || 0), darts });

    const multipliers2 = (atcCfg.multipliers !== false);
    const exitType2 = (atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull";
    const punishment2 = (atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0;
    const nextAtc = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers: multipliers2, exitType: exitType2, punishment: ((atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0) }, nextHistory);

    tx.update(ref, { "match.arcade.atcState": nextAtc, updatedAt: new Date() });
  });

  pendingHits = [];
}

async function submitBullVisit(ref) {
  if (!app.db) throw new Error("Missing Firestore");

  const darts = Array.isArray(pendingHits) ? pendingHits.slice(0, 3) : [];
  if (darts.length !== 3) throw new Error("Enter 3 darts first");

  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;
    const bcRaw = state?.match?.arcade?.bcState || {};
    const visitsLimit = Math.max(1, Number(state?.match?.arcade?.visitsLimit) || 10);
    const suddenDeath = !!state?.match?.arcade?.suddenDeath;

    const online = isOnlineGame(state);
    const startedOk = isStarted(state);

    const actor = getActorId();
    if (online) {
      if (!startedOk) throw new Error("In ready room");
      const seat2 = state?.match?.seat2Id || state?.seat2Id || null;
      if (!seat2) throw new Error("Waiting for opponent");
    }

    const bc = computeBullStateFromHistory({ visitsLimit, suddenDeath }, bcRaw.history);

    if (bc.finished) return;

    const mutual = state?.match?.allowMutualControl !== false;
    const seat1 = state?.match?.seat1Id || state?.seat1Id || state?.lobby?.host?.actorId || null;
    const seat2 = state?.match?.seat2Id || state?.seat2Id || null;

    if (online && !actor) throw new Error("Not signed in");

    if (online && !mutual) {
      const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
      if (mySeat !== Number(bc.currentPlayer || 0)) throw new Error("Not your turn");
    } else if (online && mutual) {
      // Must at least be one of the seated players
      if (!(actor === seat1 || actor === seat2)) throw new Error("Not seated");
    }

    const nextHistory = Array.isArray(bc.history) ? bc.history.slice() : [];
    nextHistory.push({ player: Number(bc.currentPlayer || 0), darts });

    const nextBc = computeBullStateFromHistory({ visitsLimit, suddenDeath }, nextHistory);

    tx.update(ref, { "match.arcade.bcState": nextBc, updatedAt: new Date() });
  });

  // Clear local pending after a successful submit.
  pendingHits = [];
}


async function undoBullVisit(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;

    const online = isOnlineGame(state);
    const mutualOff = online && state?.match?.allowMutualControl === false;
    if (mutualOff) throw new Error("Undo disabled (Mutual control is off)");

    const bcRaw = state?.match?.arcade?.bcState || {};
    const visitsLimit = Math.max(1, Number(state?.match?.arcade?.visitsLimit) || 10);
    const suddenDeath = !!state?.match?.arcade?.suddenDeath;

    const hist = Array.isArray(bcRaw.history) ? bcRaw.history.slice() : [];
    if (hist.length === 0) return;

    hist.pop();
    const nextBc = computeBullStateFromHistory({ visitsLimit, suddenDeath }, hist);

    tx.update(ref, { "match.arcade.bcState": nextBc, updatedAt: new Date() });
  });

  // Local pending resets on undo
  pendingHits = [];
}


async function undoBullVisitTurnOnly(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;

    const online = isOnlineGame(state);

    const bcRaw = state?.match?.arcade?.bcState || {};
    const visitsLimit = Math.max(1, Number(state?.match?.arcade?.visitsLimit) || 10);
    const suddenDeath = !!state?.match?.arcade?.suddenDeath;
    const hist = Array.isArray(bcRaw.history) ? bcRaw.history.slice() : [];
    if (!hist.length) return;

    if (!online) {
      hist.pop();
      const nextBc = computeBullStateFromHistory({ visitsLimit, suddenDeath }, hist);
      tx.update(ref, { "match.arcade.bcState": nextBc, updatedAt: new Date() });
      return;
    }

    const mutualOff = state?.match?.allowMutualControl === false;
    if (!mutualOff) throw new Error("Use Undo button");

    const actor = getActorId();
    const seat1 = state?.match?.seat1Id || state?.seat1Id || null;
    const seat2 = state?.match?.seat2Id || state?.seat2Id || null;
    const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
    if (mySeat < 0) throw new Error("Not seated");

    const last = hist[hist.length - 1];
    const bc = computeBullStateFromHistory({ visitsLimit, suddenDeath }, hist);

    if (Number(last.player) != Number(mySeat)) throw new Error("You can only undo your last score");
    if (Number(bc.currentPlayer || 0) === Number(mySeat)) throw new Error("Wait until turn passes to undo");

    hist.pop();
    const nextBc = computeBullStateFromHistory({ visitsLimit, suddenDeath }, hist);
    tx.update(ref, { "match.arcade.bcState": nextBc, updatedAt: new Date() });
  });

  pendingHits = [];
}


async function undoAtcVisit(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;

    const online = isOnlineGame(state);
    const mutualOff = online && state?.match?.allowMutualControl === false;
    if (mutualOff) throw new Error("Undo disabled (Mutual control is off)");

    const atcRaw = state?.match?.arcade?.atcState || {};
    const atcCfg = state?.match?.arcade?.atc || {};
    const startOnNum = (Number(atcCfg.startOn) === 20) ? 20 : 1;
    const direction = startOnNum === 20 ? "down" : "up";
    const multipliers = (atcCfg.multipliers !== false);

    const hist = Array.isArray(atcRaw.history) ? atcRaw.history.slice() : [];
    if (hist.length === 0) return;

    hist.pop();
    const nextAtc = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers, exitType: ((atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull"), punishment: ((atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0) }, hist);
    tx.update(ref, { "match.arcade.atcState": nextAtc, updatedAt: new Date() });
  });

  pendingHits = [];
}


async function undoAtcVisitTurnOnly(ref) {
  if (!app.db) throw new Error("Missing Firestore");
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;

    const online = isOnlineGame(state);
    const atcRaw = state?.match?.arcade?.atcState || {};
    const atcCfg = state?.match?.arcade?.atc || {};
    const startOnNum = (Number(atcCfg.startOn) === 20) ? 20 : 1;
    const direction = startOnNum === 20 ? "down" : "up";
    const multipliers = (atcCfg.multipliers !== false);
    const hist = Array.isArray(atcRaw.history) ? atcRaw.history.slice() : [];
    if (!hist.length) return;

    if (!online) {
      hist.pop();
      const nextAtc = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers, exitType: ((atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull"), punishment: ((atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0) }, hist);
      tx.update(ref, { "match.arcade.atcState": nextAtc, updatedAt: new Date() });
      return;
    }

    const mutualOff = state?.match?.allowMutualControl === false;
    if (!mutualOff) throw new Error("Use Undo button");

    const actor = getActorId();
    const seat1 = state?.match?.seat1Id || state?.seat1Id || null;
    const seat2 = state?.match?.seat2Id || state?.seat2Id || null;
    const mySeat = (actor && seat1 && actor === seat1) ? 0 : ((actor && seat2 && actor === seat2) ? 1 : -1);
    if (mySeat < 0) throw new Error("Not seated");

    const last = hist[hist.length - 1];
    const atc = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers, exitType: ((atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull"), punishment: ((atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0) }, hist);

    if (Number(last.player) != Number(mySeat)) throw new Error("You can only undo your last score");
    if (Number(atc.currentPlayer || 0) === Number(mySeat)) throw new Error("Wait until turn passes to undo");

    hist.pop();
    const nextAtc = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers, exitType: ((atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull"), punishment: ((atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? atcCfg.punishment : 0) }, hist);
    tx.update(ref, { "match.arcade.atcState": nextAtc, updatedAt: new Date() });
  });

  pendingHits = [];
}

async function restartMatch(ref) {
  await app.db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snapExists(snap)) throw new Error("Game not found");
    const state = snap.data() || {};
    liveState = state;
    if ((state.runtime || "classic") !== "arcade") throw new Error("Not an arcade game");
    const mode = getArcadeMode(state) || "bull_challenge";

    const match = { ...(state.match || {}) };
    const arcade = { ...(match.arcade || {}) };

    // Reset buffered input
    pendingHits = [];

    if (mode === "around_the_clock") {
      const cfg = arcade.atc || {};
      const startOnNum = (Number(cfg.startOn) === 20) ? 20 : 1;
      const direction = startOnNum === 20 ? "down" : "up";
      const multipliers = (cfg.multipliers !== false);
      arcade.atcState = computeAtcStateFromHistory({ startOn: startOnNum, direction, multipliers, exitType: (match.arcade?.atc?.exitType || "bull"), punishment: ((match.arcade?.atc?.punishment === 1 || match.arcade?.atc?.punishment === 2 || match.arcade?.atc?.punishment === 3) ? match.arcade.atc.punishment : 0) }, []);
    } else if (mode === "high_score") {
      const rounds = Math.max(1, Number(arcade.highScore?.rounds) || Number(match.arcade?.highScore?.rounds) || 10);
      arcade.highScore = { ...(arcade.highScore || {}), rounds };
      const hs = computeHighScoreStateFromHistory({ match: { arcade: { highScore: arcade.highScore, highScoreState: { history: [] } } } });
      arcade.highScoreState = {
        rounds: hs.rounds,
        history: [],
        players: hs.players,
        currentPlayer: 0,
        roundIndex: 0,
        finished: false,
        winner: null,
      };

    } else if (mode === "rounds") {
      const firstTo = Math.max(1, Number(arcade.rounds?.firstTo) || Number(match.arcade?.rounds?.firstTo) || 5);
      arcade.rounds = { ...(arcade.rounds || {}), firstTo };
      const rs = computeRoundsStateFromHistory({ match: { arcade: { rounds: arcade.rounds, roundsState: { history: [] } } } });
      arcade.roundsState = {
        firstTo: rs.firstTo,
        history: [],
        players: rs.players,
        points: [0, 0],
        currentPlayer: 0,
        roundIndex: 0,
        finished: false,
        winner: null,
      };
    } else if (mode === "race") {
      const target = Number(arcade.race?.target) || Number(match.arcade?.race?.target) || 300;
      arcade.race = ensureRaceConfig({ match: { arcade: { race: { target } } } });
      const rs = computeRaceStateFromHistory({ match: { arcade: { race: arcade.race, raceState: { history: [] } } } });
      arcade.raceState = {
        target: rs.target,
        history: [],
        players: rs.players,
        currentPlayer: 0,
        finished: false,
        winner: null,
      };
    } else {
      const visitsLimit = Math.max(1, Number(arcade.visitsLimit) || 10);
      const suddenDeath = !!arcade.suddenDeath;
      arcade.bcState = {
        visitsLimit,
        suddenDeath,
        effectiveLimit: visitsLimit,
        history: [],
        players: [
          { score: 0, bulls: 0, outers: 0, misses: 0 },
          { score: 0, bulls: 0, outers: 0, misses: 0 },
        ],
        visitsTaken: [0, 0],
        currentPlayer: 0,
        finished: false,
        winner: null,
      };
    }

    match.arcade = arcade;
    tx.update(ref, { match, updatedAt: new Date() });
  });
}

async function main() {
  applyTheme(getSavedTheme());
  applyBuildTag();
  logBuildInfo();

  app.db = initFirebase();
  initAuth({ autoAnonymous: true });

  const gameId = getGameIdFromUrl();
  if (!gameId) {
    showError("Missing game id in URL. Use ?game=<id>.");
    return;
  }

  app.gameId = gameId;
  const ref = app.db.collection("games").doc(gameId);
  app.gameRef = ref;

  // High Score: wire classic keypad/dartpad (hidden unless mode=high_score)
  try { wireHighScoreClassicInputUI(ref); } catch (_) {}

  // Shared UI systems (Chat & Audits) reuse /game/ IDs.
  try { initAuditChatUI(); } catch (_) {}
  // Ensure Audit/Chat panel can be closed in Arcade.
  try {
    const acClose = qs("auditChatCloseBtn");
    if (acClose) acClose.addEventListener("click", () => {
      const panel = qs("auditChatPanel");
      if (!panel) return;
      closeHiddenModal(panel);
      panel.setAttribute("aria-hidden", "true");
      });
  } catch (_) {}


// Ready-room invite controls (integrated)

// Helper used by Ready Room invite tools (no invite popup modal on /arcade/play)
const inviteUrl = () => {
  const params = new URLSearchParams();
  params.set("game", app.gameId || "");
  return `${withBase("/arcade/play/")}?${params.toString()}`;
};
const readyLinkEl = qs("readyInviteLinkText");
const readyCopyBtn = qs("readyCopyInviteBtn");
const readyCopyMsg = qs("readyInviteCopyMsg");
const readyInviteFriendsBtn = qs("readyInviteFriendsBtn");

try { if (readyLinkEl) readyLinkEl.textContent = inviteUrl(); } catch (_) {}

const inviteFriendsModal = qs("inviteFriendsModal");
const inviteFriendsList = qs("inviteFriendsList");
const inviteFriendsEmpty = qs("inviteFriendsEmpty");
const inviteFriendsCloseBtn = qs("inviteFriendsCloseBtn");

const openInviteFriendsModal = async () => {
  if (!inviteFriendsModal) return;
  if (inviteFriendsList) inviteFriendsList.innerHTML = "";
  if (inviteFriendsEmpty) inviteFriendsEmpty.classList.add("hidden");

  const uid = app.user && !app.user.isAnonymous ? app.user.uid : null;
  if (!uid) {
    if (inviteFriendsEmpty) {
      inviteFriendsEmpty.textContent = "Sign in to invite friends.";
      inviteFriendsEmpty.classList.remove("hidden");
    }
    openHiddenModal(inviteFriendsModal);
    return;
  }

  try {
    const snap = await app.db.collection("users").doc(uid).collection("friends").get();
    const rows = [];
    snap.forEach((doc) => {
      const f = doc.data() || {};
      rows.push({ id: doc.id, uid: doc.id, name: f.name || f.displayName || f.username || f.handle || "Friend", photoURL: f.photoURL || f.photoUrl || null });
    });

    if (!rows.length) {
      if (inviteFriendsEmpty) {
        inviteFriendsEmpty.textContent = "No friends yet.";
        inviteFriendsEmpty.classList.remove("hidden");
      }
    } else if (inviteFriendsList) {
      inviteFriendsList.innerHTML = rows.map((f) => {
        const img = f.photoURL ? `<img class="dashAvatar" src="${f.photoURL}" alt="Friend photo" />` : `<div class="dashAvatar hidden"></div>`;
        return `
          <div class="readyroomdashIdentity" style="justify-content:space-between; margin:10px 0;">
            <div class="row" style="display:flex; align-items:center; gap:10px;">
              ${img}
              <div>
                <div class="dashName" style="font-size:20px;">${f.name}</div>
              </div>
            </div>
	            <button class="actionBtn autowidth" data-invite-uid="${f.uid}" data-invite-name="${(f.name||"").replace(/"/g,'&quot;')}" type="button">Invite</button>
          </div>`;
      }).join("");
    }
  } catch (err) {
    console.error(err);
    if (inviteFriendsEmpty) {
      inviteFriendsEmpty.textContent = "Could not load friends.";
      inviteFriendsEmpty.classList.remove("hidden");
    }
  }

  openHiddenModal(inviteFriendsModal);
};

if (inviteFriendsCloseBtn) inviteFriendsCloseBtn.addEventListener("click", () => closeHiddenModal(inviteFriendsModal));

function onInviteFriendsClick(e) {
  const btn = e.target && e.target.closest ? e.target.closest("button[data-invite-uid]") : null;
  if (!btn) return;
  const friendUid = btn.getAttribute("data-invite-uid");
  if (!friendUid) return;
  const myUid = (app.user && !app.user.isAnonymous) ? app.user.uid : null;
  if (!myUid) return;
  const fromName = (liveState?.seat1Name || liveState?.match?.seat1Name || app.user.displayName || "Player");
  const fromPhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;
  (async () => {
    try {
      btn.disabled = true;
      await sendGameInvite(app.db, myUid, friendUid, app.gameId, { fromName, fromPhotoURL, mode: "arcade" });
      btn.textContent = "Invited";
    } catch (err) {
      console.error(err);
      showError(err?.message || String(err));
      btn.disabled = false;
    }
  })();
}
if (inviteFriendsList) inviteFriendsList.addEventListener("click", onInviteFriendsClick);


if (readyCopyBtn) readyCopyBtn.addEventListener("click", async () => {
  try {
    const txt = inviteUrl();
    await navigator.clipboard.writeText(txt);
    if (readyCopyMsg) readyCopyMsg.classList.remove("hidden");
  } catch (_) {
    try {
      const ta = document.createElement("textarea");
      ta.value = inviteUrl();
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      if (readyCopyMsg) readyCopyMsg.classList.remove("hidden");
    } catch (_) {}
  }
});

if (readyInviteFriendsBtn) readyInviteFriendsBtn.addEventListener("click", async () => {
  try { await openInviteFriendsModal(); } catch (_) {}
});

  // ----------------------------
  // Game Settings menu (ported from /game/)
  // ----------------------------
  const gameSettingsBtn = qs("gameSettingsBtn");
  const gsm = qs("gameSettingsModal");
  if (gameSettingsBtn) gameSettingsBtn.addEventListener("click", () => openHiddenModal(gsm));
  const gsCloseBtn = qs("gsCloseBtn");
  if (gsCloseBtn) gsCloseBtn.addEventListener("click", () => closeHiddenModal(gsm));

  const gsNewGameBtn = qs("gsNewGameBtn");
  const gsRestartGameBtn = qs("gsRestartGameBtn");
  const gsChangeGamemodeBtn = qs("gsChangeGamemodeBtn");
  const gsLeaveMatchBtn = qs("gsLeaveMatchBtn");
  const gsOpenAuditChatBtn = qs("gsOpenAuditChatBtn");

  const changeGamemodeModal = qs("changeGamemodeModal");
  const cgBullBtn = qs("cgBullBtn");
  const cgAtcBtn = qs("cgAtcBtn");
  const cgHighScoreBtn = document.getElementById("cgHighScoreBtn");
  const cgRoundsBtn = document.getElementById("cgRoundsBtn");
  const cgRaceBtn = document.getElementById("cgRaceBtn");
  const cgCloseBtn = qs("cgCloseBtn");

  const confirmRestartModal = qs("confirmRestartMatchModal");
  const confirmRestartOk = qs("confirmRestartOkBtn");
  const confirmRestartCancel = qs("confirmRestartCancelBtn");

  const confirmLeaveModal = qs("confirmLeaveMatchModal");
  const confirmLeaveOk = qs("confirmLeaveOkBtn");
  const confirmLeaveCancel = qs("confirmLeaveCancelBtn");

  const arcadeSetupLocalModal = qs("arcadeSetupLocalModal");
  const arcadeSetupOnlineModal = qs("arcadeSetupOnlineModal");
  const arcadeStartLocalBtn = qs("arcadeLocalStartMatchBtn");
  const arcadeStartOnlineBtn = qs("arcadeOnlineStartMatchBtn");

  const openSetupForCurrentLobby = () => {
    const st = liveState || {};
    const mode = getArcadeMode(st) || "bull_challenge";
    const online = isOnlineGame(st);

    const atcCfg = st?.match?.arcade?.atc || {};
    const startOnVal = (Number(atcCfg.startOn) === 20) ? "20" : "1";
    const multipliersVal = (atcCfg.multipliers !== false);
    const exitTypeVal = (atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull";
    const punishmentVal = (atcCfg.punishment === 1 || atcCfg.punishment === 2 || atcCfg.punishment === 3) ? String(atcCfg.punishment) : "0";

    // Toggle mode-specific setup fields + titles
    const localTitle = qs("arcadeLocalSetupTitle");
    const onlineTitle = qs("arcadeOnlineSetupTitle");
    const localAtcFields = qs("atcSetupFieldsLocal");
    const onlineAtcFields = qs("atcSetupFieldsOnline");
    const localHsFields = qs("hsSetupFieldsLocal");
    const onlineHsFields = qs("hsSetupFieldsOnline");
    const localRoundsFields = qs("roundsSetupFieldsLocal");
    const onlineRoundsFields = qs("roundsSetupFieldsOnline");
    const localRaceFields = qs("raceSetupFieldsLocal");
    const onlineRaceFields = qs("raceSetupFieldsOnline");

    if (localAtcFields) localAtcFields.classList.toggle("hidden", mode !== "around_the_clock");
    if (onlineAtcFields) onlineAtcFields.classList.toggle("hidden", mode !== "around_the_clock");
    if (localHsFields) localHsFields.classList.toggle("hidden", mode !== "high_score");
    if (onlineHsFields) onlineHsFields.classList.toggle("hidden", mode !== "high_score");
    if (localRoundsFields) localRoundsFields.classList.toggle("hidden", mode !== "rounds");
    if (onlineRoundsFields) onlineRoundsFields.classList.toggle("hidden", mode !== "rounds");
    if (localRaceFields) localRaceFields.classList.toggle("hidden", mode !== "race");
    if (onlineRaceFields) onlineRaceFields.classList.toggle("hidden", mode !== "race");

    const titleBase = (mode === "around_the_clock") ? "Around the Clock"
      : (mode === "high_score") ? "High Score"
      : (mode === "rounds") ? "Rounds"
      : (mode === "race") ? "Race"
      : "Bull Challenge";
    if (localTitle) localTitle.textContent = `${titleBase} • Local`;
    if (onlineTitle) onlineTitle.textContent = `${titleBase} • Online`;

    // Bull Challenge legacy length controls. For score-based games (High Score / later Rounds/Race),
    // the only length control is the mode-specific selector (e.g., rounds). These legacy fields are
    // hidden to keep a single source of truth.
    const setNumberRowVisible = (inputId, visible) => {
      const input = qs(inputId);
      if (input) input.style.display = visible ? "" : "none";
      const lbl = document.querySelector(`label[for="${inputId}"]`);
      if (lbl) lbl.style.display = visible ? "" : "none";
    };
    if (online) {
      // Pre-fill mutual control with current setting
      const mutual = st?.match?.allowMutualControl !== false;
      const chk = qs("arcadeOnlineMutualChk");
      if (chk) chk.checked = !!mutual;

      const v = Number(st?.match?.arcade?.visitsLimit || 10);
      const vis = qs("arcadeOnlineVisitsInput");
      if (vis) vis.value = String(v);
      const sd = !!st?.match?.arcade?.suddenDeath;
      const sdChk = qs("arcadeOnlineSuddenDeathChk");
      if (sdChk) sdChk.checked = !!sd;

      // ATC-only fields
      if (mode === "around_the_clock") {
        const sSel = qs("atcOnlineStartOnSelect");
        const mChk = qs("atcOnlineMultipliersChk");
        const eSel = qs("atcOnlineExitTypeSelect");
        const pSel = qs("atcOnlinePunishmentSelect");
        if (sSel) sSel.value = startOnVal;
        if (mChk) mChk.checked = !!multipliersVal;
        if (eSel) eSel.value = exitTypeVal;
        if (pSel) pSel.value = punishmentVal;
      }

      // High Score-only fields
      if (mode === "high_score") {
        const rounds = Number(st?.match?.arcade?.highScore?.rounds || 10);
        const sel = qs("hsOnlineRoundsSelect");
        if (sel) sel.value = String(rounds);
      }
      // Rounds-only fields
      if (mode === "rounds") {
        const firstTo = Number(st?.match?.arcade?.rounds?.firstTo || 5);
        const sel = qs("roundsOnlineFirstToSelect");
        if (sel) sel.value = String(firstTo);
      }

      // Race-only fields
      if (mode === "race") {
        const target = Number(st?.match?.arcade?.race?.target || 300);
        const sel = qs("raceOnlineTargetSelect");
        if (sel) sel.value = String(target);
      }

      // Hide Bull Challenge fields when not relevant
      setNumberRowVisible("arcadeOnlineVisitsInput", mode === "bull_challenge");
      const sdRow = qs("arcadeOnlineSuddenDeathChk")?.closest("label");
      if (sdRow) sdRow.style.display = (mode === "bull_challenge") ? "flex" : "none";

      openHiddenModal(arcadeSetupOnlineModal);
    } else {
      const v = Number(st?.match?.arcade?.visitsLimit || 10);
      const vis = qs("arcadeLocalVisitsInput");
      if (vis) vis.value = String(v);
      const sd = !!st?.match?.arcade?.suddenDeath;
      const sdChk = qs("arcadeLocalSuddenDeathChk");
      if (sdChk) sdChk.checked = !!sd;
      // Hide Bull Challenge fields when not relevant
      setNumberRowVisible("arcadeLocalVisitsInput", mode === "bull_challenge");

      // Sudden death-if-draw is not relevant for ATC.
      if (sdChk) {
        const row = sdChk.closest("label");
        if (row) row.style.display = (mode === "bull_challenge") ? "flex" : "none";
      }

      if (mode === "around_the_clock") {
        const sSel = qs("atcLocalStartOnSelect");
        const mChk = qs("atcLocalMultipliersChk");
        const eSel = qs("atcLocalExitTypeSelect");
        const pSel = qs("atcLocalPunishmentSelect");
        if (sSel) sSel.value = startOnVal;
        if (mChk) mChk.checked = !!multipliersVal;
        if (eSel) eSel.value = exitTypeVal;
        if (pSel) pSel.value = punishmentVal;
      }

      // High Score-only fields
      if (mode === "high_score") {
        const rounds = Number(st?.match?.arcade?.highScore?.rounds || 10);
        const sel = qs("hsLocalRoundsSelect");
        if (sel) sel.value = String(rounds);
      }
      // Rounds-only fields
      if (mode === "rounds") {
        const firstTo = Number(st?.match?.arcade?.rounds?.firstTo || 5);
        const sel = qs("roundsLocalFirstToSelect");
        if (sel) sel.value = String(firstTo);
      }

      // Race-only fields
      if (mode === "race") {
        const target = Number(st?.match?.arcade?.race?.target || 300);
        const sel = qs("raceLocalTargetSelect");
        if (sel) sel.value = String(target);
      }


      openHiddenModal(arcadeSetupLocalModal);
    }
  };

const closeArcadeSetupModals = (force = false) => {
    if (app._lockedSetup && !force) return;
  closeHiddenModal(arcadeSetupLocalModal);
  closeHiddenModal(arcadeSetupOnlineModal);
};

qs("arcadeLocalCancelBtn")?.addEventListener("click", () => {
  if (app._lockedSetup) {
    app._lockedSetup = false;
    closeArcadeSetupModals(true);
    openHiddenModal(changeGamemodeModal);
    return;
  }
  closeHiddenModal(arcadeSetupLocalModal);
});
qs("arcadeOnlineCancelBtn")?.addEventListener("click", () => {
  if (app._lockedSetup) {
    app._lockedSetup = false;
    closeArcadeSetupModals(true);
    openHiddenModal(changeGamemodeModal);
    return;
  }
  closeHiddenModal(arcadeSetupOnlineModal);
});

if (gsNewGameBtn) gsNewGameBtn.addEventListener("click", () => {
  closeHiddenModal(gsm);
  openSetupForCurrentLobby();
});

const readLocalSetupInputs = () => {
  const visits = Math.max(1, Number(qs("arcadeLocalVisitsInput")?.value || 10));
  const suddenDeath = !!qs("arcadeLocalSuddenDeathChk")?.checked;
  const mode = getArcadeMode(liveState || {}) || "bull_challenge";
  const atcStartOn = Number(qs("atcLocalStartOnSelect")?.value || 1);
  const atcMultipliers = !!qs("atcLocalMultipliersChk")?.checked;
  const atcExitType = String(qs("atcLocalExitTypeSelect")?.value || "bull");
  const atcPunishment = Number(qs("atcLocalPunishmentSelect")?.value || 0);
  const highScoreRounds = Number(qs("hsLocalRoundsSelect")?.value || 10);
  const roundsFirstTo = Number(qs("roundsLocalFirstToSelect")?.value || 5);
  const raceTarget = Number(qs("raceLocalTargetSelect")?.value || 300);
  return { visits, suddenDeath, allowMutualControl: true, mode, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget };
};

const readOnlineSetupInputs = () => {
  const visits = Math.max(1, Number(qs("arcadeOnlineVisitsInput")?.value || 10));
  const suddenDeath = !!qs("arcadeOnlineSuddenDeathChk")?.checked;
  const allowMutualControl = !!qs("arcadeOnlineMutualChk")?.checked;
  const mode = getArcadeMode(liveState || {}) || "bull_challenge";
  const atcStartOn = Number(qs("atcOnlineStartOnSelect")?.value || 1);
  const atcMultipliers = !!qs("atcOnlineMultipliersChk")?.checked;
  const atcExitType = String(qs("atcOnlineExitTypeSelect")?.value || "bull");
  const atcPunishment = Number(qs("atcOnlinePunishmentSelect")?.value || 0);
  const highScoreRounds = Number(qs("hsOnlineRoundsSelect")?.value || 10);
  const roundsFirstTo = Number(qs("roundsOnlineFirstToSelect")?.value || 5);
  const raceTarget = Number(qs("raceOnlineTargetSelect")?.value || 300);
  return { visits, suddenDeath, allowMutualControl, mode, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget };
};

qs("arcadeLocalStartMatchBtn")?.addEventListener("click", async () => {
  try {
    const { visits, suddenDeath, mode, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget } = readLocalSetupInputs();
    app._lockedSetup = false;
    closeArcadeSetupModals(true);
    await applyArcadeSetupToLobby({ lobbyType: "single", visitsLimit: visits, suddenDeath, allowMutualControl: true, arcadeMode: mode, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget });
  } catch (e) { showError(e?.message || String(e)); }
});

qs("arcadeOnlineStartMatchBtn")?.addEventListener("click", async () => {
  try {
    const { visits, suddenDeath, allowMutualControl, mode, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget } = readOnlineSetupInputs();
    app._lockedSetup = false;
    closeArcadeSetupModals(true);
    await applyArcadeSetupToLobby({ lobbyType: "online", visitsLimit: visits, suddenDeath, allowMutualControl, arcadeMode: mode, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget });
  } catch (e) { showError(e?.message || String(e)); }
});

  const resetBullChallengeState = (visitsLimit, suddenDeath) => {
    const v = Math.max(1, Number(visitsLimit) || 10);
    return {
      visitsLimit: v,
      suddenDeath: !!suddenDeath,
      effectiveLimit: v,
      history: [],
      players: [
        { score: 0, bulls: 0, outers: 0, misses: 0 },
        { score: 0, bulls: 0, outers: 0, misses: 0 },
      ],
      visitsTaken: [0, 0],
      currentPlayer: 0,
      finished: false,
      winner: null,
    };
  };

  const applyArcadeSetupToLobby = async ({ lobbyType, visitsLimit, suddenDeath, allowMutualControl, arcadeMode, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo , raceTarget }) => {
    const actor = getActorId();
    if (!actor) throw new Error("Not signed in");
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snapExists(snap)) throw new Error("Game not found");
      const state = snap.data() || {};
    liveState = state;
      if ((state.runtime || "classic") !== "arcade") throw new Error("Not an arcade game");

      const match = { ...(state.match || {}) };
      match.gameType = lobbyType === "online" ? "online" : "single";
      match.allowMutualControl = (lobbyType === "online") ? (allowMutualControl !== false) : true;
      match.rules = match.rules || {};
      match.rules.preset = "arcade";
      match.rules.checkIn = match.rules.checkIn || "straight";
      match.rules.checkOut = match.rules.checkOut || "straight";
      match.rules.trackCheckoutStats = false;

      const nextMode = (arcadeMode === "around_the_clock") ? "around_the_clock" : (arcadeMode === "high_score") ? "high_score" : (arcadeMode === "rounds") ? "rounds" : (arcadeMode === "race") ? "race" : "bull_challenge";
      match.arcade = { ...(match.arcade || {}) };
      match.arcade.mode = nextMode;
      match.arcade.visitsLimit = Math.max(1, Number(visitsLimit) || 10);
      match.arcade.suddenDeath = !!suddenDeath;
      match.arcade.started = (lobbyType !== "online");

      if (nextMode === "bull_challenge") {
        match.arcade.bcState = resetBullChallengeState(match.arcade.visitsLimit, match.arcade.suddenDeath);
      } else if (nextMode === "around_the_clock") {
        const startOnNum = (Number(atcStartOn) === 20) ? 20 : 1;
        const direction = startOnNum === 20 ? "down" : "up";
        const multipliers = (atcMultipliers !== false);
        const exitType = (atcExitType === "outer_and_bull" || atcExitType === "outer_or_bull") ? atcExitType : (match.arcade?.atc?.exitType || "bull");
        const punishment = (atcPunishment === 1 || atcPunishment === 2 || atcPunishment === 3) ? atcPunishment : (match.arcade?.atc?.punishment || 0);
        match.arcade.atc = { ...(match.arcade.atc || {}), startOn: startOnNum, multipliers, exitType, punishment };
        match.arcade.atcState = computeAtcStateFromHistory(match.arcade.atc, [], direction);
      } else if (nextMode === "high_score") {
        const rounds = Math.max(1, Number(highScoreRounds) || 10);
        match.arcade.highScore = { ...(match.arcade.highScore || {}), rounds };
        const hs = computeHighScoreStateFromHistory({ match: { arcade: { highScore: match.arcade.highScore, highScoreState: { history: [] } } } });
        match.arcade.highScoreState = {
          history: [],
          currentPlayer: hs.currentPlayer,
          roundIndex: hs.roundIndex,
          rounds: hs.rounds,
          finished: hs.finished,
          winner: hs.winner,
          players: hs.players,
        };

      }
else if (nextMode === "rounds") {
  const firstTo = Math.max(1, Number(roundsFirstTo) || 5);
  match.arcade.rounds = { ...(match.arcade.rounds || {}), firstTo };
  const rs = computeRoundsStateFromHistory({ match: { arcade: { rounds: match.arcade.rounds, roundsState: { history: [] } } } });
  match.arcade.roundsState = {
    history: [],
    currentPlayer: rs.currentPlayer,
    roundIndex: rs.roundIndex,
    firstTo: rs.firstTo,
    points: rs.points,
    finished: rs.finished,
    winner: rs.winner,
    players: rs.players,
  };
} else if (nextMode === "race") {
  const target = Math.max(100, Math.min(1000, Number(raceTarget) || 300));
  match.arcade.race = { ...(match.arcade.race || {}), target };
  const rc = computeRaceStateFromHistory({ match: { arcade: { race: match.arcade.race, raceState: { history: [] } } } });
  match.arcade.raceState = {
    history: [],
    currentPlayer: rc.currentPlayer,
    target: rc.target,
    finished: rc.finished,
    winner: rc.winner,
    players: rc.players,
  };
}
 else if (nextMode === "rounds") {
        const firstTo = Math.max(1, Number(roundsFirstTo) || 5);
        match.arcade.rounds = { ...(match.arcade.rounds || {}), firstTo };
        const rs = computeRoundsStateFromHistory({ match: { arcade: { rounds: match.arcade.rounds, roundsState: { history: [] } } } });
        match.arcade.roundsState = {
          history: [],
          currentPlayer: rs.currentPlayer,
          roundIndex: rs.roundIndex,
          firstTo: rs.firstTo,
          points: rs.points,
          finished: rs.finished,
          winner: rs.winner,
          players: rs.players,
        };
      } else if (nextMode === "race") {
        const target = Math.max(100, Math.min(1000, Number(raceTarget) || 300));
        match.arcade.race = { ...(match.arcade.race || {}), target };
        const rc = computeRaceStateFromHistory({ match: { arcade: { race: match.arcade.race, raceState: { history: [] } } } });
        match.arcade.raceState = {
          history: [],
          currentPlayer: rc.currentPlayer,
          target: rc.target,
          finished: rc.finished,
          winner: rc.winner,
          players: rc.players,
        };
      }



      // Reset chat ring buffer for a new game
      match.chat = [];

      // Online vs Local seat handling
      state.lobbyType = lobbyType;
      if (lobbyType === "online") {
        // Keep host identity; clear joiner seat
        match.seat1Id = match.seat1Id || state.seat1Id || state?.lobby?.host?.actorId || actor;
        match.seat2Id = null;
        if (Array.isArray(match.players) && match.players[1]) {
          match.players[1].uid = null;
          match.players[1].name = "Player 2";
          match.players[1].photoURL = null;
        }
        state.seat2Id = null;
        state.seat2Name = null;
        state.seat2PhotoURL = null;
        state.lobby = state.lobby || {};
        state.lobby.joiner = null;
        // Ready room scaffold
        state.readyRoom = {
          ready: { [match.seat1Id]: false },
          updatedAt: Date.now(),
          setup: { mode: "Arcade", bestOf: 1, rules: { preset: "arcade", checkIn: "straight", checkOut: "straight" } },
        };
      } else {
        // Local: clear readyRoom + joiner meta (single-device game)
        state.readyRoom = null;
        state.lobby = state.lobby || {};
        state.lobby.joiner = null;
      }

      state.match = match;
      state.updatedAt = new Date();
      tx.set(ref, state);
    });
  };

  // Segment 3: Online "Change Gamemode" must NOT tear down the lobby / clear seat2.
  // This updates match.arcade config/state in-place and resets ready flags for the existing seats.
  const applyArcadeModeChangeOnline = async ({ arcadeMode, visitsLimit, suddenDeath, atcStartOn, atcMultipliers, atcExitType, atcPunishment, highScoreRounds, roundsFirstTo, raceTarget }) => {
    const actor = getActorId();
    if (!actor) throw new Error("Not signed in");
    await app.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snapExists(snap)) throw new Error("Game not found");
      const state = snap.data() || {};
      liveState = state;
      if ((state.runtime || "classic") !== "arcade") throw new Error("Not an arcade game");
      if (!isOnlineGame(state)) throw new Error("Not an online game");

      const match = { ...(state.match || {}) };
      match.gameType = "online";
      match.rules = match.rules || {};
      match.rules.preset = "arcade";
      match.rules.checkIn = match.rules.checkIn || "straight";
      match.rules.checkOut = match.rules.checkOut || "straight";
      match.rules.trackCheckoutStats = false;

      // Preserve seats + identity
      const seat1 = match.seat1Id || state.seat1Id || state?.lobby?.host?.actorId || actor;
      const seat2 = match.seat2Id || state.seat2Id || state?.lobby?.joiner?.actorId || null;
      match.seat1Id = seat1;
      match.seat2Id = seat2;

      match.arcade = { ...(match.arcade || {}) };
            const nextMode = (arcadeMode === "around_the_clock") ? "around_the_clock"
        : (arcadeMode === "high_score") ? "high_score"
        : (arcadeMode === "rounds") ? "rounds"
        : (arcadeMode === "race") ? "race"
        : "bull_challenge";
      match.arcade.mode = nextMode;
      match.arcade.visitsLimit = Math.max(1, Number(visitsLimit) || (Number(match.arcade.visitsLimit) || 10));
      match.arcade.suddenDeath = (suddenDeath != null) ? !!suddenDeath : !!match.arcade.suddenDeath;

      // Online: a mode change sends you back through ready room; game is not started until ready-room completes.
      match.arcade.started = false;
      match.arcade.effectiveLimit = match.arcade.visitsLimit;

      // Reset per-mode state cleanly.
      if (nextMode === "bull_challenge") {
        match.arcade.bcState = resetBullChallengeState(match.arcade.visitsLimit, match.arcade.suddenDeath);
      } else if (nextMode === "around_the_clock") {
        const startOnNum = (Number(atcStartOn) === 20) ? 20 : 1;
        const direction = startOnNum === 20 ? "down" : "up";
        const multipliers = (atcMultipliers !== false);
        const exitType = (atcExitType === "outer_and_bull" || atcExitType === "outer_or_bull") ? atcExitType : (match.arcade?.atc?.exitType || "bull");
        const punishment = (atcPunishment === 1 || atcPunishment === 2 || atcPunishment === 3) ? atcPunishment : (match.arcade?.atc?.punishment || 0);
        match.arcade.atc = { ...(match.arcade.atc || {}), startOn: startOnNum, multipliers, exitType, punishment };
        match.arcade.atcState = computeAtcStateFromHistory(match.arcade.atc, [], direction);
      } else if (nextMode === "high_score") {
        const rounds = Math.max(1, Number(highScoreRounds) || 10);
        match.arcade.highScore = { ...(match.arcade.highScore || {}), rounds };
        const hs = computeHighScoreStateFromHistory({ match: { arcade: { highScore: match.arcade.highScore, highScoreState: { history: [] } } } });
        match.arcade.highScoreState = {
          history: [],
          currentPlayer: hs.currentPlayer,
          roundIndex: hs.roundIndex,
          rounds: hs.rounds,
          finished: hs.finished,
          winner: hs.winner,
          players: hs.players,
        };
      }
else if (nextMode === "rounds") {
  const firstTo = Math.max(1, Number(roundsFirstTo) || 5);
  match.arcade.rounds = { ...(match.arcade.rounds || {}), firstTo };
  const rs = computeRoundsStateFromHistory({ match: { arcade: { rounds: match.arcade.rounds, roundsState: { history: [] } } } });
  match.arcade.roundsState = {
    history: [],
    currentPlayer: rs.currentPlayer,
    roundIndex: rs.roundIndex,
    firstTo: rs.firstTo,
    points: rs.points,
    finished: rs.finished,
    winner: rs.winner,
    players: rs.players,
  };
} else if (nextMode === "race") {
  const target = Math.max(100, Math.min(1000, Number(raceTarget) || 300));
  match.arcade.race = { ...(match.arcade.race || {}), target };
  const rc = computeRaceStateFromHistory({ match: { arcade: { race: match.arcade.race, raceState: { history: [] } } } });
  match.arcade.raceState = {
    history: [],
    currentPlayer: rc.currentPlayer,
    target: rc.target,
    finished: rc.finished,
    winner: rc.winner,
    players: rc.players,
  };
}


      // Reset chat ring buffer for a fresh match in the new mode.
      match.chat = [];

      // Keep lobby + joiner; just reset ready flags.
      state.lobbyType = "online";
      state.lobby = state.lobby || {};
      // Keep any existing readyRoom metadata, but reset readiness for active seats.
      const ready = {};
      if (seat1) ready[seat1] = false;
      if (seat2) ready[seat2] = false;
      state.readyRoom = {
        ...(state.readyRoom || {}),
        ready,
        updatedAt: Date.now(),
        setup: (state.readyRoom && state.readyRoom.setup) ? state.readyRoom.setup : { mode: "Arcade", bestOf: 1, rules: { preset: "arcade", checkIn: "straight", checkOut: "straight" } },
      };

      state.match = match;
      state.updatedAt = new Date();
      tx.set(ref, state);
    });
  };

  if (gsRestartGameBtn) gsRestartGameBtn.addEventListener("click", () => {
    closeHiddenModal(gsm);
    openHiddenModal(confirmRestartModal);
  });
  if (confirmRestartCancel) confirmRestartCancel.addEventListener("click", () => closeHiddenModal(confirmRestartModal));
  if (confirmRestartOk) confirmRestartOk.addEventListener("click", async () => {
    try {
      closeHiddenModal(confirmRestartModal);
      await restartMatch(ref);
    } catch (e) {
      showError(e?.message || String(e));
    }
  });

  if (gsChangeGamemodeBtn) gsChangeGamemodeBtn.addEventListener("click", () => {
    closeHiddenModal(gsm);
    openHiddenModal(changeGamemodeModal);
  });

  if (gsOpenAuditChatBtn) gsOpenAuditChatBtn.addEventListener("click", () => {
    closeHiddenModal(gsm);
    openHiddenModal("auditChatPanel");
    const input = qs("auditChatInput");
    if (input && !input.disabled) try { input.focus(); } catch (_) {}
  });

  if (cgCloseBtn) cgCloseBtn.addEventListener("click", () => closeHiddenModal(changeGamemodeModal));
  if (cgBullBtn) cgBullBtn.addEventListener("click", async () => {
    try {
      closeHiddenModal(changeGamemodeModal);
      const st = app.latestState || {};
      const v = Number(st?.match?.arcade?.visitsLimit || 10);
      const sd = !!st?.match?.arcade?.suddenDeath;
      const lt = (String(st?.lobbyType || "") === "online") ? "online" : "single";
      if (lt === "online") {
        // Segment 3: change mode in-place (preserve seats/lobby)
        await applyArcadeModeChangeOnline({ arcadeMode: "bull_challenge", visitsLimit: v, suddenDeath: sd });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
      } else {
        await applyArcadeSetupToLobby({ lobbyType: lt, visitsLimit: v, suddenDeath: sd, arcadeMode: "bull_challenge" });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
      }
    } catch (e) {
      showError(e?.message || String(e));
    }
  });

  if (cgAtcBtn) cgAtcBtn.addEventListener("click", async () => {
    try {
      closeHiddenModal(changeGamemodeModal);
      const st = app.latestState || {};
      const v = Number(st?.match?.arcade?.visitsLimit || 10);
      const sd = !!st?.match?.arcade?.suddenDeath;
      const lt = (String(st?.lobbyType || "") === "online") ? "online" : "single";
      const atcCfg = st?.match?.arcade?.atc || {};
      const startOn = (Number(atcCfg.startOn) === 20) ? 20 : 1;
      const mult = (atcCfg.multipliers !== false);
      const exitType = (atcCfg.exitType === "outer_and_bull" || atcCfg.exitType === "outer_or_bull") ? atcCfg.exitType : "bull";
      if (lt === "online") {
        // Segment 3: change mode in-place (preserve seats/lobby)
        await applyArcadeModeChangeOnline({ arcadeMode: "around_the_clock", visitsLimit: v, suddenDeath: sd, atcStartOn: startOn, atcMultipliers: mult, atcExitType: exitType, atcPunishment: Number(qs("atcOnlinePunishmentSelect")?.value || 0) });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
      } else {
        await applyArcadeSetupToLobby({ lobbyType: lt, visitsLimit: v, suddenDeath: sd, arcadeMode: "around_the_clock", atcStartOn: startOn, atcMultipliers: mult, atcExitType: exitType, atcPunishment: Number(qs((lt === "online") ? "atcOnlinePunishmentSelect" : "atcLocalPunishmentSelect")?.value || 0) });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
      }
    } catch (e) {
      showError(e?.message || String(e));
    }
  });


if (cgHighScoreBtn) cgHighScoreBtn.addEventListener("click", async () => {
  try {
    closeHiddenModal(changeGamemodeModal);
    const st = app.latestState || {};
    const online = isOnlineGame(st);
    const rounds = Number(st?.match?.arcade?.highScore?.rounds || 10);

    if (online) {
      await applyArcadeModeChangeOnline({ arcadeMode: "high_score", highScoreRounds: rounds });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
    } else {
      await applyArcadeSetupToLobby({ lobbyType: "single", arcadeMode: "high_score", highScoreRounds: rounds });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
    }
  } catch (e) {
    showError(e?.message || String(e));
  }
});

if (cgRoundsBtn) cgRoundsBtn.addEventListener("click", async () => {
  try {
    closeHiddenModal(changeGamemodeModal);
    const st = app.latestState || {};
    const online = isOnlineGame(st);
    const firstTo = Number(st?.match?.arcade?.rounds?.firstTo || 5);

    if (online) {
      await applyArcadeModeChangeOnline({ arcadeMode: "rounds", roundsFirstTo: firstTo });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
    } else {
      await applyArcadeSetupToLobby({ lobbyType: "single", arcadeMode: "rounds", roundsFirstTo: firstTo });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
    }
  } catch (e) {
    showError(e?.message || String(e));
  }
});

if (cgRaceBtn) cgRaceBtn.addEventListener("click", async () => {
  try {
    closeHiddenModal(changeGamemodeModal);
    const st = app.latestState || {};
    const online = isOnlineGame(st);
    const target = Number(st?.match?.arcade?.race?.target || 300);

    if (online) {
      await applyArcadeModeChangeOnline({ arcadeMode: "race", raceTarget: target });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
    } else {
      await applyArcadeSetupToLobby({ lobbyType: "single", arcadeMode: "race", raceTarget: target });
        app._lockedSetup = true;
        app._openSetupAfterModeChange = true;
    }
  } catch (e) {
    showError(e?.message || String(e));
  }
});

  const leaveArcadeMatch = async () => {
    try {
      const state = app.latestState || {};
      const actor = getActorId();
      const now = new Date();
      if (actor && app.gameRef && isOnlineGame(state)) {
        // Mark as abandoned/closed, mirroring the intent of app/actions.leaveMatch
        const update = { status: "abandoned", abandonedAt: now, updatedAt: now };
        const seat1 = state?.match?.seat1Id || state?.seat1Id || state?.lobby?.host?.actorId || null;
        const seat2 = state?.match?.seat2Id || state?.seat2Id || state?.lobby?.joiner?.actorId || null;
        if (seat1 && actor === seat1) {
          update.status = "closed";
          update.closedAt = now;
        }
        if (seat2 && actor === seat2) {
          // Free seat2 on leave so the lobby can be reused
          update.seat2Id = null;
          update.seat2Name = null;
          update.seat2PhotoURL = null;
          update["lobby.joiner"] = null;
          update["match.seat2Id"] = null;
          update["match.seat2Name"] = null;
          update["match.seat2PhotoURL"] = null;
        }
        try { await app.gameRef.update(update); } catch (_) {}
      }
    } catch (_) {}
    window.location.href = withBase("/arcade/");
  };

  if (gsLeaveMatchBtn) gsLeaveMatchBtn.addEventListener("click", () => {
    closeHiddenModal(gsm);
    openHiddenModal(confirmLeaveModal);
  });
  if (confirmLeaveCancel) confirmLeaveCancel.addEventListener("click", () => closeHiddenModal(confirmLeaveModal));
  if (confirmLeaveOk) confirmLeaveOk.addEventListener("click", async () => {
    closeHiddenModal(confirmLeaveModal);
    await leaveArcadeMatch();
  });

  // Ready room controls
  const rrReadyBtn = qs("readyRoomReadyBtn");
  const rrLeaveBtn = qs("readyRoomLeaveBtn");
  if (rrReadyBtn) rrReadyBtn.addEventListener("click", async () => {
    try {
      await toggleMyReady(ref);
      // Host will auto-start when both are ready (in snapshot handler)
    } catch (e) {
      showError(e?.message || String(e));
    }
  });
  if (rrLeaveBtn) rrLeaveBtn.addEventListener("click", async () => {
    await leaveArcadeMatch();
  });

function closeAllSettingsModals() {
  try { closeHiddenModal(gsm); } catch (_) {}
  try { closeHiddenModal(confirmRestartModal); } catch (_) {}
  try { closeHiddenModal(confirmLeaveModal); } catch (_) {}
  try { closeArcadeSetupModals(true); } catch (_) {}
  try { closeHiddenModal(changeGamemodeModal); } catch (_) {}
  try { closeHiddenModal(inviteFriendsModal); } catch (_) {}
}

  // Close any open settings-related modal if user hits Escape
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAllSettingsModals();
  });

  // Live updates
  app._arcadeUnsub = ref.onSnapshot(async (snap) => {
    if (!snapExists(snap)) {
      showError("Game not found.");
      return;
    }
    const state = snap.data() || {};
    liveState = state;

    // Redirect protection
    const runtime = state.runtime || "classic";
    if (runtime !== "arcade") {
      window.location.replace(withBase(`/game/?game=${encodeURIComponent(gameId)}`));
      return;
    }

    const mode = getArcadeMode(state);
    if (mode === "bull_challenge") {
      try { await ensureDocHasBullState(ref); } catch (_) {}
    } else if (mode === "high_score") {
      try { await ensureDocHasHighScoreState(ref); } catch (_) {}
    } else if (mode === "rounds") {
      try { await ensureDocHasRoundsState(ref); } catch (_) {}
    } else if (mode === "race") {
      try { await ensureDocHasRaceState(ref); } catch (_) {}
    } else if (mode === "around_the_clock") {
      try { await ensureDocHasAtcState(ref); } catch (_) {}
    } else {
      showError("This arcade mode is not implemented yet.");
      return;
    }

    // Seat claim (online join) mirrors classic behavior
    try { await tryClaimSeat2(state); } catch (_) {}


// Join/leave toasts + SFX (same behavior/CSS as classic)
try {
  const seat1IdNow = state?.match?.seat1Id || state?.seat1Id || null;
  const seat2IdNow = state?.match?.seat2Id || state?.seat2Id || null;
  const seat1NameNow = state?.seat1Name || state?.match?.seat1Name || "Player 1";
  const seat2NameNow = state?.seat2Name || state?.match?.seat2Name || "Player 2";

  if (__lastSeat2Id === null && seat2IdNow) {
    showSeatJoinToast(`${seat2NameNow} has joined the game`);
  } else if (__lastSeat2Id && !seat2IdNow) {
    const leftName = __lastSeat2Name || seat2NameNow;
    showSeatLeaveToast(`${leftName} has left the game`);
  }

  if (__lastSeat1Id && !seat1IdNow) {
    const leftName = __lastSeat1Name || seat1NameNow;
    showSeatLeaveToast(`${leftName} has left the game`);
  }

  __lastSeat1Id = seat1IdNow || null;
  __lastSeat2Id = seat2IdNow || null;
  __lastSeat1Name = seat1NameNow || null;
  __lastSeat2Name = seat2NameNow || null;
} catch (_) {}

// Permanently hide ready-room invite tools once Seat 2 has ever been filled
try {
  if (isOnlineGame(state)) {
    const seat2Now = state?.match?.seat2Id || state?.seat2Id || null;
    const everFilled = !!state?.match?.arcade?.seat2EverFilled;
    if (seat2Now && !everFilled) {
      await app.db.runTransaction(async (tx) => {
        const snap3 = await tx.get(ref);
        if (!snap3.exists) return;
        const s3 = snap3.data() || {};
        if (!isOnlineGame(s3)) return;
        const seat2Now2 = s3?.match?.seat2Id || s3?.seat2Id || null;
        if (!seat2Now2) return;
        s3.match = s3.match || {};
        s3.match.arcade = s3.match.arcade || {};
        if (s3.match.arcade.seat2EverFilled === true) return;
        s3.match.arcade.seat2EverFilled = true;
        s3.updatedAt = new Date();
        tx.set(ref, s3);
      });
    }
  }
} catch (_) {}

    // Audit/Chat derived feed
    try { updateAuditFromState(state, app.latestState); } catch (_) {}
    app.latestState = state;
    try { renderAuditChat(state); } catch (_) {}

    // Ensure Ready Room scaffold for online games (started flag + ready map)
    try {
      if (isOnlineGame(state)) {
        const started = state?.match?.arcade?.started;
        const needsStarted = (started !== true && started !== false);
        const { seat1, seat2 } = seatIds(state);
        const ready = getReadyMap(state);
        const needsReadyMap = !state?.readyRoom || typeof state.readyRoom !== "object";
        const needsSeat1Ready = !!(seat1 && !(seat1 in ready));
        const needsSeat2Ready = !!(seat2 && !(seat2 in ready));

        if (needsStarted || needsReadyMap || needsSeat1Ready || needsSeat2Ready) {
          await app.db.runTransaction(async (tx) => {
            const snap2 = await tx.get(ref);
            if (!snap2.exists) return;
            const s = snap2.data() || {};
            if (!isOnlineGame(s)) return;
            s.match = s.match || {};
            s.match.arcade = s.match.arcade || {};
            if (s.match.arcade.started !== true && s.match.arcade.started !== false) {
              s.match.arcade.started = false;
            }
            s.readyRoom = s.readyRoom || {};
            s.readyRoom.ready = s.readyRoom.ready || {};
            const idsNow = seatIds(s);
            if (idsNow.seat1 && !(idsNow.seat1 in s.readyRoom.ready)) s.readyRoom.ready[idsNow.seat1] = false;
            if (idsNow.seat2 && !(idsNow.seat2 in s.readyRoom.ready)) s.readyRoom.ready[idsNow.seat2] = false;
            s.readyRoom.updatedAt = Date.now();
            s.readyRoom.setup = s.readyRoom.setup || { mode: "Arcade", bestOf: 1, rules: { preset: "arcade", checkIn: "straight", checkOut: "straight" } };
            s.updatedAt = new Date();
            tx.set(ref, s);
          });
        }
      }
    } catch (_) {}

    showError(null);
    render(state);
    renderReadyRoom(state);
    if (app._openSetupAfterModeChange) {
      app._openSetupAfterModeChange = false;
      // Locked until Start or Cancel
      openSetupForCurrentLobby();
    }
    try { await maybeAutoStartFromReady(ref, state); } catch (_) {}
  }, (err) => {
    console.error(err);
    showError(err?.message || String(err));
  });

  // Wire buttons
  const keypad = qs("arcadeKeypad");
  if (keypad) {
    keypad.addEventListener("click", async (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-hit]") : null;
      if (!btn) return;
      const hit = btn.getAttribute("data-hit");
      try {
        showError(null);
        // In ATC exit stage, this keypad is reused for Bull/Outer/Miss.
        // Guard against phantom buffering when input is not allowed.
        const mode = getArcadeMode(liveState || {});
        if (mode === "around_the_clock") {
          const atc = ensureAtcState(liveState || {});
          const allow = computeAllowInput(liveState || {}, Number(atc.currentPlayer || 0)) && !atc.finished;
          if (!allow) return;
          if (Array.isArray(pendingHits) && pendingHits.length >= 3) return;
        }
                // ATC: In exit stage, some hits can immediately end the game (with confirmation).
if (mode === "around_the_clock") {
  const atc = ensureAtcState(liveState || {});
  const curP = Number(atc.currentPlayer || 0);
  const exitCtx = atcExitInputContext(liveState || {}, curP, pendingHits);
  if (exitCtx.inExit) {
    const exitType = exitCtx.exitType || "bull";
    const armed = !!exitCtx.exitArmed;

    // Determine whether this hit would COMPLETE the exit rules right now.
    const wouldWin =
      (exitType === "bull" && hit === "bull") ||
      (exitType === "outer_or_bull" && (hit === "outer" || hit === "bull")) ||
      (exitType === "outer_and_bull" && armed && hit === "bull");

    if (wouldWin) {
      const ok = await promptAtcCheckout();
      if (!ok) return;
      addPendingHit(hit);
      // Force 3 darts in the visit before committing (same buffering rule).
      while (Array.isArray(pendingHits) && pendingHits.length < 3) addPendingHit("miss");
      render(liveState);
      await submitAtcVisit(ref);
      return;
    }
  }
}


addPendingHit(hit);
        render(liveState);
      } catch (err) {
        console.error(err);
        showError(err?.message || String(err));
      }
    });
  }

  // Around-the-Clock keypad wiring (Phase 1)
  const atcKeypad = qs("atcKeypad");
  if (atcKeypad) {
    atcKeypad.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-hit]") : null;
      if (!btn) return;
      const hit = btn.getAttribute("data-hit");
      try {
        showError(null);
        // Guard against out-of-turn / disabled-state phantom buffering.
        const mode = getArcadeMode(liveState || {});
        if (mode === "around_the_clock") {
          const atc = ensureAtcState(liveState || {});
          const allow = computeAllowInput(liveState || {}, Number(atc.currentPlayer || 0)) && !atc.finished;
          if (!allow) return;
          if (Array.isArray(pendingHits) && pendingHits.length >= 3) return;
        }
        addPendingHit(hit);
        render(liveState);
      } catch (err) {
        console.error(err);
        showError(err?.message || String(err));
      }
    });
  }

  // ATC checkout confirmation modal buttons
  const atcCheckoutCancel = qs("atcCheckoutCancelBtn");
  if (atcCheckoutCancel) atcCheckoutCancel.addEventListener("click", () => resolveAtcCheckout(false));
  const atcCheckoutYes = qs("atcCheckoutYesBtn");
  if (atcCheckoutYes) atcCheckoutYes.addEventListener("click", () => resolveAtcCheckout(true));

  const submitVisitBtn = qs("arcadeSubmitVisitBtn");
  if (submitVisitBtn) submitVisitBtn.addEventListener("click", async () => {
    try {
      showError(null);
      const mode = getArcadeMode(liveState || {});
      if (mode === "around_the_clock") await submitAtcVisit(ref);
      else await submitBullVisit(ref);
    } catch (err) {
      console.error(err);
      showError(err?.message || String(err));
    }
  });


  const backspaceVisitBtn = qs("arcadeBackspaceVisitBtn");
  if (backspaceVisitBtn) backspaceVisitBtn.addEventListener("click", () => {
    try {
      showError(null);
      backspacePendingHit();
      render(liveState);
    } catch (err) {
      console.error(err);
      showError(err?.message || String(err));
    }
  });

  const clearVisitBtn = qs("arcadeClearVisitBtn");
  if (clearVisitBtn) clearVisitBtn.addEventListener("click", async () => {
    try {
      showError(null);
      clearPendingHits();
      render(liveState);
    } catch (err) {
      console.error(err);
      showError(err?.message || String(err));
    }
  });


const undoBtn = qs("arcadeUndoBtn");
if (undoBtn) undoBtn.addEventListener("click", async () => {
  try {
    showError(null);
    const mode = getArcadeMode(liveState || {});
    if (mode === "around_the_clock") await undoAtcVisit(ref);
    else await undoBullVisit(ref);
    // If undo was a no-op (e.g. no visits yet), Firestore won't change and we
    // won't get a snapshot-driven re-render. Still refresh so the local pending
    // buffer UI stays in sync (and doesn't show stale darts).
    render(liveState);
  } catch (err) {
    console.error(err);
    showError(err?.message || String(err));
  }
});

const overlayUndoBtn = qs("overlayUndoBtn");
if (overlayUndoBtn) overlayUndoBtn.addEventListener("click", async () => {
  try {
    showError(null);
    const mode = getArcadeMode(liveState || {});
    if (mode === "around_the_clock") await undoAtcVisitTurnOnly(ref);
    else await undoBullVisitTurnOnly(ref);
    render(liveState);
  } catch (err) {
    console.error(err);
    showError(err?.message || String(err));
  }
});

  const leaveBtn = qs("arcadeLeaveBtn");
  if (leaveBtn) leaveBtn.addEventListener("click", () => {
    window.location.href = withBase("/arcade/");
  });

  const restartBtn = qs("arcadeRestartBtn");
  if (restartBtn) restartBtn.addEventListener("click", async () => {
    try {
      showError(null);
      await restartMatch(ref);
      closeHiddenModal(qs("arcadeEndModal"));
    } catch (err) {
      console.error(err);
      showError(err?.message || String(err));
    }
  });

  // Allow closing end modal by clicking outside (optional)
  const endModal = qs("arcadeEndModal");
  if (endModal) {
    endModal.addEventListener("click", (e) => {
      if (e.target === endModal) closeHiddenModal(endModal);
    });
  }
}

main().catch((err) => {
  console.error(err);
  showError(err?.message || String(err));
});

}
