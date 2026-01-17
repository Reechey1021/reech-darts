// app/ui/render.js
import { app } from "../state.js";
import { canScoreNow, canUndoNow, canEditScores, mySeatIndex } from "../permissions.js";
import { checkoutSuggestion, minDartsForCheckout } from "../model/rules.js";
import { calcLegStats, calcMatchStats, formatPills } from "../model/stats.js";
import { getActorId } from "../auth.js";

export function showError(msg) {
  // Prefer the in-game error area
  const gameErr = document.getElementById("error");

  // Fallback for lobby gate (because .card is hidden while gate is open)
  const gateErr = document.getElementById("gateError");

  // Pick whichever is actually visible / usable
  const el =
    (gameErr && gameErr.offsetParent !== null) ? gameErr :
    (gateErr ? gateErr : gameErr);

  if (!el) return;

  el.innerText = msg;
  el.classList.remove("hidden");

  clearTimeout(window.__errTimer);
  window.__errTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}


export function setLobbyGateVisible(visible) {
  const card = document.querySelector(".card");
  if (card) card.style.display = visible ? "none" : "";
  const modal = document.getElementById("lobbyGateModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

export function setBullModalVisible(visible) {
  const modal = document.getElementById("bullModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

export function setWinnerModalVisible(visible, winnerName = "") {
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

export function setInviteModalVisible(visible) {
  const modal = document.getElementById("inviteModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

export function setSetupModalVisible(visible) {
  const modal = document.getElementById("setupModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

export function setCheckoutModalVisible(visible) {
  const modal = document.getElementById("checkoutModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

export function setConfirmNewMatchModalVisible(visible) {
  const modal = document.getElementById("confirmNewMatchModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

export function safeFocusScoreInput() {
  const el = document.getElementById("scoreInput");
  if (!el) return;
  // Avoid iOS keyboard popping up; your original check used pointer: coarse
  const isTouch = window.matchMedia("(pointer: coarse)").matches;
  if (isTouch) return;
  el.focus();
}

export function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);

  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
}

export function initThemeToggle() {
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

export function render(state) {
  const inputArea = document.getElementById("inputArea");
  const overlay = document.getElementById("turnOverlay");
  const overlayText = document.getElementById("turnOverlayText");
  const overlayUndoBtn = document.getElementById("overlayUndoBtn");
  const abortBullBtn = document.getElementById("abortBullBtn");

  // --- Throw for bull UI ---
  const bullWaiting = document.getElementById("bullWaiting");
  const bullResetBtn = document.getElementById("bullResetBtn");
  const bullConfirmBtn = document.getElementById("bullConfirmBtn");
  const bullBoard = document.getElementById("bullBoard");

  const bullModalShouldShow =
    state?.match?.starting === "bull" &&
    state?.match?.bull &&
    !state.match.bull.resolved;

  if (bullModalShouldShow) {
    const promptEl = document.getElementById("bullPrompt");
    const bull = state.match.bull;

    let neededPlayer = 0;
    if (bull.p1 && !bull.p2) neededPlayer = 1;
    if (bull.p1 && bull.p2) neededPlayer = null;

    const whoName =
      neededPlayer === null
        ? "Calculating…"
        : state.match.players?.[neededPlayer]?.name || (neededPlayer === 0 ? "Player 1" : "Player 2");

    const isOnline = state.match.gameType === "online";
    const mySeat = mySeatIndex(state);
    const iAmThrower = !isOnline ? true : (mySeat !== null && mySeat === neededPlayer);

    if (promptEl) {
      if (neededPlayer === null) promptEl.textContent = "Calculating starter…";
      else if (iAmThrower) promptEl.textContent = `You: tap where your dart landed, then confirm.`;
      else promptEl.textContent = "";
    }

    if (bullWaiting) {
      if (isOnline && neededPlayer !== null && !iAmThrower) {
        bullWaiting.textContent = `${whoName} is throwing for bull…`;
        bullWaiting.classList.remove("hidden");
      } else {
        bullWaiting.classList.add("hidden");
      }
    }

    const shouldHideControls = isOnline && neededPlayer !== null && !iAmThrower;

    if (bullResetBtn) bullResetBtn.classList.toggle("hidden", shouldHideControls);
    if (bullConfirmBtn) bullConfirmBtn.classList.toggle("hidden", shouldHideControls);
    if (bullBoard) bullBoard.style.pointerEvents = shouldHideControls ? "none" : "auto";

    setBullModalVisible(true);
  } else {
    setBullModalVisible(false);
  }
  if (abortBullBtn) abortBullBtn.classList.toggle("hidden", !bullModalShouldShow);

  const isOnline = state?.match?.gameType === "online";
  const scoreAllowed = canScoreNow(state);
  const undoAllowed = canUndoNow(state);

  if (overlay && overlayText) {
    if (isOnline && !scoreAllowed && state?.match && state?.leg) {
      const who = state.match.players[state.leg.currentPlayer]?.name || "the other player";
      overlayText.textContent = `It’s ${who}’s turn`;
      overlay.classList.remove("hidden");
    } else {
      overlay.classList.add("hidden");
    }
  }

  if (overlayUndoBtn) overlayUndoBtn.disabled = !undoAllowed;

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

  if (!state || !state.match || !state.leg) {
    if (statusEl) statusEl.innerText = "Press New Game to start.";
    if (p1ScoreEl) p1ScoreEl.innerText = "—";
    if (p2ScoreEl) p2ScoreEl.innerText = "—";
    if (p1CheckoutEl) p1CheckoutEl.innerHTML = "";
    if (p2CheckoutEl) p2CheckoutEl.innerHTML = "";
    if (p1StatsEl) p1StatsEl.innerHTML = "";
    if (p2StatsEl) p2StatsEl.innerHTML = "";
    if (gameMetaEl) gameMetaEl.innerText = "";
    setWinnerModalVisible(false);
    setCheckoutModalVisible(false);
    return;
  }

  // readOnly logic
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

  if (readOnly) {
    if (scoreInput) scoreInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (undoBtn) undoBtn.disabled = true;
  } else {
    if (scoreInput) scoreInput.disabled = !scoreAllowed;
    if (submitBtn) submitBtn.disabled = !scoreAllowed;

    // Table mode: only allow submit once 3 darts chosen
    if (submitBtn && app.inputMode === "table" && !readOnly) {
      submitBtn.disabled = (!scoreAllowed) || (app.dartThrows.length !== 3);
    }

    if (undoBtn) undoBtn.disabled = isOnline && !scoreAllowed;
  }

  const match = state.match;
  const leg = state.leg;

  if (gameMetaEl) gameMetaEl.innerText = `${match.mode} • BO${match.bestOf}`;

  const showLegs = Number(match.bestOf) > 1;
  document.querySelectorAll(".legsBadge").forEach((b) => {
    b.classList.toggle("hidden", !showLegs);
  });

  // Lobby indicator (optional element)
  const lobbyIndicator = document.getElementById("lobbyIndicator");
  if (lobbyIndicator) {
    const isOnlineMode = state.match.gameType === "online";
    lobbyIndicator.classList.toggle("hidden", !isOnlineMode);
    if (isOnlineMode) {
      const connected = !!state.match.seat1Id && !!state.match.seat2Id;
      lobbyIndicator.classList.toggle("connected", connected);
      lobbyIndicator.title = connected ? "Both devices connected" : "Waiting for Player 2…";
    }
  }

  // Lock names in the main UI
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
  if (p1ScoreEl) p1ScoreEl.innerText = s1 ?? "—";
  if (p2ScoreEl) p2ScoreEl.innerText = s2 ?? "—";

  const p1LegsEl = document.getElementById("p1Legs");
  const p2LegsEl = document.getElementById("p2Legs");
  if (p1LegsEl) p1LegsEl.innerText = String(match.legsWon?.[0] ?? 0);
  if (p2LegsEl) p2LegsEl.innerText = String(match.legsWon?.[1] ?? 0);

  // Checkout suggestions
  const sug1 = typeof s1 === "number" ? checkoutSuggestion(s1) : null;
  const sug2 = typeof s2 === "number" ? checkoutSuggestion(s2) : null;
  if (p1CheckoutEl) p1CheckoutEl.innerHTML = sug1 ? `<span class="pill">${sug1}</span>` : "";
  if (p2CheckoutEl) p2CheckoutEl.innerHTML = sug2 ? `<span class="pill">${sug2}</span>` : "";

  // Leg stats pills
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

  // Pending checkout modal
  if (state.pendingCheckout) {
    const who = match.players[state.pendingCheckout.player].name;
    const title = document.getElementById("checkoutTitle");
    const body = document.getElementById("checkoutBody");
    const minDarts = state.pendingCheckout.minDarts ?? 1;

    const dartsBtns = Array.from(document.querySelectorAll(".dartsBtn"));
    const confirmBtn = document.getElementById("checkoutConfirmBtn");

    for (const b of dartsBtns) b.style.display = "";

    if (minDarts === 2) {
      const b1 = document.querySelector('.dartsBtn[data-darts="1"]');
      if (b1) b1.style.display = "none";
    }

    if (minDarts === 3) {
      for (const b of dartsBtns) b.style.display = "none";
      window.__selectedCheckoutDarts = 3;
      if (confirmBtn) confirmBtn.disabled = false;
      if (body) body.innerText = `${who} is checking out. Confirm?`;
    } else {
      window.__selectedCheckoutDarts = null;
      if (confirmBtn) confirmBtn.disabled = true;
    }

    if (title) title.innerText = "Confirm Checkout";
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

  // Winner modal
  if (leg.status === "finished") {
    const winnerIdx = typeof leg.winner === "number" ? leg.winner : 0;
    const winnerName = match.players[winnerIdx].name;

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

    if (winnerNewGameBtn) {
      winnerNewGameBtn.innerText = match.status === "finished" ? "New Match" : "Continue (Next Leg)";
    }

    if (statusEl) statusEl.innerText = `${winnerName} wins the leg`;
    setWinnerModalVisible(true, winnerName);
  } else {
    const whoName = match.players[leg.currentPlayer].name;
    if (statusEl) statusEl.innerText = `${whoName} to throw`;
    setWinnerModalVisible(false);
  }
}
