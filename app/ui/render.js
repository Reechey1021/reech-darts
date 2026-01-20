// app/ui/render.js
import { app } from "../state.js";
import { canScoreNow, canUndoNow, canEditScores, mySeatIndex } from "../permissions.js";
import { checkoutSuggestion, minDartsForCheckout } from "../model/rules.js";
import { calcLegStats, calcMatchStats, formatPills } from "../model/stats.js";
import { getActorId } from "../auth.js";
import { isHost } from "../permissions.js";

// -----------------------------
// Modal animation helpers
// -----------------------------
export function openModal(modal) {
  if (!modal) return;
  // Cancel any pending close fallback timer from a previous close.
  if (modal.__closeTimer) {
    clearTimeout(modal.__closeTimer);
    modal.__closeTimer = null;
  }
  // Remove any lingering transitionend handler from a previous close.
  if (modal.__onCloseTransitionEnd) {
    try { modal.removeEventListener("transitionend", modal.__onCloseTransitionEnd); } catch {}
    modal.__onCloseTransitionEnd = null;
  }
  modal.classList.remove("hidden");
  modal.style.display = "flex";
  // Allow the browser to apply display before transitioning
  requestAnimationFrame(() => {
    modal.classList.remove("is-closing");
    modal.classList.add("is-open");
  });
}

export function closeModal(modal) {
  if (!modal) return;
  // If already hidden, nothing to do.
  if (modal.classList.contains("hidden")) return;

  // Cancel any pending close fallback timer.
  if (modal.__closeTimer) {
    clearTimeout(modal.__closeTimer);
    modal.__closeTimer = null;
  }

  modal.classList.remove("is-open");
  modal.classList.add("is-closing");

  const finish = () => {
    modal.classList.remove("is-closing");
    modal.classList.add("hidden");
    modal.style.display = "none";
    modal.removeEventListener("transitionend", onEnd);
  };

  const onEnd = (e) => {
    // Only act on the overlay opacity transition
    if (e.target === modal && e.propertyName === "opacity") finish();
  };

  // Ensure we don't accumulate listeners.
  if (modal.__onCloseTransitionEnd) {
    try { modal.removeEventListener("transitionend", modal.__onCloseTransitionEnd); } catch {}
  }
  modal.__onCloseTransitionEnd = onEnd;
  modal.addEventListener("transitionend", onEnd);
  // Fallback in case transitionend doesn't fire (rare)
  modal.__closeTimer = setTimeout(() => {
    // If the modal was re-opened, don't force-hide it.
    if (!modal.classList.contains("is-open") && !modal.classList.contains("hidden")) finish();
  }, 280);
}

export function showError(msg) {
  // Use a modal popup (requested). This is local only (doesn't sync).
  const modal = document.getElementById("errorModal");
  const textEl = document.getElementById("errorModalText");

    // Ensure error modal is ALWAYS above any other modal (lobby gate, invite, etc.)
  modal.style.zIndex = "999999";
  document.body.appendChild(modal); // move to end of <body> so it sits on top

  if (textEl) textEl.textContent = String(msg || "");

  if (modal) {
    openModal(modal);
    return;
  }

  // Fallback: legacy inline element if modal isn't present
  const el = document.getElementById("error");
  if (!el) return;
  el.innerText = msg;
  el.classList.remove("hidden");
  clearTimeout(window.__errTimer);
  window.__errTimer = setTimeout(() => el.classList.add("hidden"), 2500);
}

export function hideError() {
  const modal = document.getElementById("errorModal");
  if (modal) closeModal(modal);
  const el = document.getElementById("error");
  if (el) el.classList.add("hidden");
}


export function setLobbyGateVisible(visible) {
  const card = document.querySelector(".card");
  if (card) card.style.display = visible ? "none" : "";
  const modal = document.getElementById("lobbyGateModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

export function setBullModalVisible(visible) {
  const modal = document.getElementById("bullModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

export function setWinnerModalVisible(visible, winnerName = "") {
  const modal = document.getElementById("winnerModal");
  const winnerText = document.getElementById("winnerText");
  if (!modal) return;

  if (visible) {
    if (winnerText) winnerText.innerText = `${winnerName} has won 🎉`;
    openModal(modal);
  } else {
    if (winnerText) winnerText.innerText = "";
    closeModal(modal);
  }
}

export function setInviteModalVisible(visible) {
  const modal = document.getElementById("inviteModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

export function setSetupModalVisible(visible) {
  const modal = document.getElementById("setupModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

export function setCheckoutModalVisible(visible) {
  const modal = document.getElementById("checkoutModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

export function setConfirmNewMatchModalVisible(visible) {
  const modal = document.getElementById("confirmNewMatchModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

export function setSeat2WaitingModalVisible(visible) {
  const modal = document.getElementById("seat2WaitingModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
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
  // Guests: always dark mode (no dashboard to toggle).
  // Signed-in users: theme is controlled from the dashboard and stored in localStorage.
  const isSignedIn = !!(app.user && !app.user.isAnonymous);

  if (!isSignedIn) {
    applyTheme("dark");
  } else {
    const saved = localStorage.getItem("theme");
    const preferred =
      saved ||
      (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light");
    applyTheme(preferred);
  }

  // In-game toggle is now redundant; hide if present.
  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.style.display = "none";
}

export function render(state) {
  const inputArea = document.getElementById("inputArea");
  const overlay = document.getElementById("turnOverlay");
  const overlayText = document.getElementById("turnOverlayText");
  const overlayUndoBtn = document.getElementById("overlayUndoBtn");
  const overlayStartBtn = document.getElementById("overlayStartBtn");
  const abortBullBtn = document.getElementById("abortBullBtn");

  // --- Throw for bull UI ---
  const bullWaiting = document.getElementById("bullWaiting");
  const bullResetBtn = document.getElementById("bullResetBtn");
  const bullConfirmBtn = document.getElementById("bullConfirmBtn");
  const bullBoard = document.getElementById("bullBoard");

  // --- Host-only settings vs. Leave button (online) ---
  const settingsBtn = document.getElementById("gameSettingsBtn");
  const leaveBtn = document.getElementById("leaveMatchBtn");
  const online = state?.match?.gameType === "online" || state?.lobbyType === "online";
  const host = isHost(state);

  if (online) {
    if (settingsBtn) settingsBtn.classList.toggle("hidden", !host);
    if (leaveBtn) leaveBtn.classList.toggle("hidden", host);
  } else {
    // non-online: keep original behaviour
    if (settingsBtn) settingsBtn.classList.remove("hidden");
    if (leaveBtn) leaveBtn.classList.add("hidden");
  }

  // --- Seat 2 waiting-for-host modal (online lobby only) ---
  // Show for any non-host device that has opened the lobby link.
  const me = getActorId();
  const iAmNonHostViewer = !!me && me !== (state?.seat1Id || state?.lobby?.host?.actorId || state?.match?.seat1Id);
  const iAmSeat2 = !!me && (me === state?.seat2Id || me === state?.match?.seat2Id || me === state?.lobby?.joiner?.actorId);
  const seat2Waiting = online && state?.status === "lobby" && !host && (iAmSeat2 || (!state?.seat2Id && iAmNonHostViewer));
  setSeat2WaitingModalVisible(!!seat2Waiting);

  // --- Player photos (Google profile photo) ---
  // Online only. Local games should not show Google avatars.
  const p1Photo = document.getElementById("p1Photo");
  const p2Photo = document.getElementById("p2Photo");

  const setPhoto = (imgEl, url) => {
    if (!imgEl) return;
    if (url) {
      imgEl.src = url;
      imgEl.classList.remove("hidden");
    } else {
      imgEl.classList.add("hidden");
      imgEl.removeAttribute("src");
    }
  };

  // Only show Google profile photos for ONLINE games/lobbies.
  if (online) {
    const p1Url =
      state?.match?.players?.[0]?.photoURL ||
      state?.match?.seat1PhotoURL ||
      state?.seat1PhotoURL ||
      state?.lobby?.host?.photoURL ||
      null;

    const p2Url =
      state?.match?.players?.[1]?.photoURL ||
      state?.match?.seat2PhotoURL ||
      state?.seat2PhotoURL ||
      state?.lobby?.joiner?.photoURL ||
      null;

    setPhoto(p1Photo, p1Url);
    setPhoto(p2Photo, p2Url);
  } else {
    setPhoto(p1Photo, null);
    setPhoto(p2Photo, null);
  }

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

  // Reset overlay button visibility for in-match renders.
  if (overlayUndoBtn) overlayUndoBtn.classList.remove("hidden");
  if (overlayStartBtn) overlayStartBtn.classList.add("hidden");

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
    // Lobby/no-active-match UI.
    // Populate seat names early for ONLINE lobbies only (so it doesn't show Player 1/2 until match start).
    // Local games should keep their setup-driven names.
    if (state?.lobbyType === "online") {
      const p1NameEl = document.getElementById("p1Name");
      const p2NameEl = document.getElementById("p2Name");
      if (p1NameEl) {
        p1NameEl.textContent = state?.seat1Name || state?.lobby?.host?.name || "Player 1";
      }
      if (p2NameEl) {
        p2NameEl.textContent = state?.seat2Name || state?.lobby?.joiner?.name || "Player 2";
      }
    }

    if (statusEl) statusEl.innerText = "Press New Game to start.";
    if (p1ScoreEl) p1ScoreEl.innerText = "—";
    if (p2ScoreEl) p2ScoreEl.innerText = "—";
    if (p1CheckoutEl) p1CheckoutEl.innerHTML = "";
    if (p2CheckoutEl) p2CheckoutEl.innerHTML = "";
    if (p1StatsEl) p1StatsEl.innerHTML = "";
    if (p2StatsEl) p2StatsEl.innerHTML = "";
    if (gameMetaEl) gameMetaEl.innerText = "";

    // Disable scoring UI when no match is live.
    // Host gets a clear overlay prompt to start a new match.
    const startBtn = document.getElementById("overlayStartBtn");
    if (inputArea) inputArea.classList.add("locked");
    if (overlay && overlayText) {
      const canStart = isHost(state);
      overlayText.textContent = canStart ? "Press New Game to start" : "Waiting for host to start";
      overlay.classList.remove("hidden");
      if (overlayUndoBtn) overlayUndoBtn.classList.add("hidden");
      if (startBtn) startBtn.classList.toggle("hidden", !canStart);
    }

    const scoreInput = document.getElementById("scoreInput");
    const submitBtn = document.getElementById("submitBtn");
    const quickCheckoutBtn = document.getElementById("quickCheckoutBtn");
    const undoBtn = document.getElementById("undoBtn");
    if (scoreInput) scoreInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (quickCheckoutBtn) {
      quickCheckoutBtn.disabled = true;
      quickCheckoutBtn.classList.add("hidden");
    }
    if (undoBtn) {
      undoBtn.disabled = true;
      undoBtn.hidden = false;
    }

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
  const quickCheckoutBtn = document.getElementById("quickCheckoutBtn");
  const undoBtn = document.getElementById("undoBtn");

  if (readOnly) {
    if (scoreInput) scoreInput.disabled = true;
    if (submitBtn) submitBtn.disabled = true;
    if (quickCheckoutBtn) {
      quickCheckoutBtn.disabled = true;
      quickCheckoutBtn.classList.add("hidden");
    }
    if (undoBtn) {
      undoBtn.disabled = true;
      undoBtn.hidden = false;
    }
  } else {
    if (scoreInput) scoreInput.disabled = !scoreAllowed;
    if (submitBtn) submitBtn.disabled = !scoreAllowed;

    // Table mode: only allow submit once 3 darts chosen
    if (submitBtn && app.inputMode === "table" && !readOnly) {
      submitBtn.disabled = (!scoreAllowed) || (app.dartThrows.length !== 3);
    }

    // Quick checkout button: appears only when the current player has a finish suggestion.
    if (quickCheckoutBtn) {
      const leg = state.leg;
      const remaining = typeof leg?.players?.[leg?.currentPlayer]?.score === "number"
        ? leg.players[leg.currentPlayer].score
        : null;
      const hasFinish = typeof remaining === "number" && !!checkoutSuggestion(remaining);
      quickCheckoutBtn.classList.toggle("hidden", !hasFinish);
      quickCheckoutBtn.disabled = !scoreAllowed;

      // When quick checkout is available, turn Submit into an icon-only send button
      if (submitBtn) {
        if (!submitBtn.dataset.label) submitBtn.dataset.label = submitBtn.textContent || "Submit";
        if (hasFinish) {
          submitBtn.classList.add("iconOnly");
          submitBtn.innerHTML =
            '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
            '<path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" fill="currentColor"/>' +
            '</svg>';
        } else {
          submitBtn.classList.remove("iconOnly");
          submitBtn.textContent = submitBtn.dataset.label;
        }
      }
    }

    if (undoBtn) {
      // Hide undo ONLY for online games when mutual control is OFF.
      // Otherwise it behaves normally (and is disabled when you cannot score).
      const mutualOff = isOnline && state.match?.allowMutualControl === false;
      undoBtn.hidden = !!mutualOff;
      undoBtn.disabled = !!(!scoreAllowed);
    }
  }

  // Lock/disable input UI when it’s not your turn online (better UX)
  if (inputArea) {
    inputArea.classList.toggle("locked", !!(isOnline && !scoreAllowed));
  }

  // Also disable keypad/dartpad buttons explicitly (failsafe)
  const keypadEl = document.getElementById("keypad");
  if (keypadEl) {
    keypadEl.querySelectorAll("button").forEach((b) => {
      // Keypad should remain usable whenever the turn overlay is not active.
      // The keypad container itself is hidden in table mode, so we don't need to disable on inputMode.
      b.disabled = !!(readOnly || !scoreAllowed);
    });
  }

  // Dartpad should remain usable for building an entry, even when it's not your turn.
  // We enforce permissions via Submit/Undo + backend checks.
  const dartPadEl = document.getElementById("dartPad");
  if (dartPadEl) {
    dartPadEl.querySelectorAll("button").forEach((b) => {
      b.disabled = !!readOnly;
    });
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
    p1NameEl.textContent = match.players[0].name;
  }
  if (p2NameEl) {
    p2NameEl.textContent = match.players[1].name;
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
    // Only the player who triggered the checkout should see the confirmation modal.
    // (Other client should not be able to confirm someone else's checkout.)
    const me = getActorId();
    if (state.pendingCheckout.actorId && state.pendingCheckout.actorId !== me) {
      setCheckoutModalVisible(false);
    } else {
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
    }
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

    // Highest checkout per player (requires checkoutScore stored on each leg summary)
    const maxCheckout = [0, 0];
    for (const legSum of match.legs || []) {
      const w = typeof legSum.winner === "number" ? legSum.winner : null;
      const cs = Number(legSum.checkoutScore || 0);
      if (w === 0 || w === 1) maxCheckout[w] = Math.max(maxCheckout[w], cs);
    }

    // Optional checkout tracking (future feature). Only render if present.
    const trackingOn = Boolean(match.checkoutTrackingEnabled);
    const p1CheckoutPct = trackingOn ? (match.checkoutPct?.[0] ?? null) : null;
    const p2CheckoutPct = trackingOn ? (match.checkoutPct?.[1] ?? null) : null;

    // Only show avatars in ONLINE games. Local games should never show Google/profile photos.
    const showMatchAvatars = match.gameType === "online";
    const p1Photo = showMatchAvatars ? (match.players?.[0]?.photoURL || match.seat1PhotoURL || "") : "";
    const p2Photo = showMatchAvatars ? (match.players?.[1]?.photoURL || match.seat2PhotoURL || "") : "";

    if (matchStatsGrid) {
      matchStatsGrid.innerHTML = `
        <div class="msHead left">
          ${p1Photo ? `<img class="msAvatar" src="${p1Photo}" alt="${match.players[0].name}" />` : ``}
          <div class="msName">${match.players[0].name}</div>
        </div>
        <div></div>
        <div class="msHead right">
          ${p2Photo ? `<img class="msAvatar" src="${p2Photo}" alt="${match.players[1].name}" />` : ``}
          <div class="msName">${match.players[1].name}</div>
        </div>

        <div class="msCell msVal">${match.legsWon?.[0] ?? 0}</div>
        <div class="msCell msLabel">Legs won</div>
        <div class="msCell msVal">${match.legsWon?.[1] ?? 0}</div>

        <div class="msCell msVal">${p1m.tda}</div>
        <div class="msCell msLabel">3 dart avg</div>
        <div class="msCell msVal">${p2m.tda}</div>

        <div class="msCell msVal">${p1m.f9d}</div>
        <div class="msCell msLabel">First 9 avg</div>
        <div class="msCell msVal">${p2m.f9d}</div>

        ${trackingOn ? `
          <div class="msCell msVal">${p1CheckoutPct == null ? "—" : `${p1CheckoutPct}%`}</div>
          <div class="msCell msLabel">Checkout %</div>
          <div class="msCell msVal">${p2CheckoutPct == null ? "—" : `${p2CheckoutPct}%`}</div>
        ` : ``}

        <div class="msCell msVal">${maxCheckout[0] || "—"}</div>
        <div class="msCell msLabel">Highest checkout</div>
        <div class="msCell msVal">${maxCheckout[1] || "—"}</div>

        <div class="msCell msVal">${totals[0].c100 || 0}</div>
        <div class="msCell msLabel">100+</div>
        <div class="msCell msVal">${totals[1].c100 || 0}</div>

        <div class="msCell msVal">${totals[0].c140 || 0}</div>
        <div class="msCell msLabel">140+</div>
        <div class="msCell msVal">${totals[1].c140 || 0}</div>

        <div class="msCell msVal">${totals[0].c180 || 0}</div>
        <div class="msCell msLabel">180</div>
        <div class="msCell msVal">${totals[1].c180 || 0}</div>

        <div class="msCell msVal">${totals[0].darts || 0}</div>
        <div class="msCell msLabel">Darts thrown</div>
        <div class="msCell msVal">${totals[1].darts || 0}</div>
      `;
    }

    function applyMatchEndStatColors() {
  const grid = document.querySelector(".matchEndStats");
  if (!grid) return;

  const cells = Array.from(grid.querySelectorAll(".msCell"));
  if (cells.length < 3) return;

  // Cells are laid out as repeating triplets:
  // [p1Val] [label] [p2Val] [p1Val] [label] [p2Val] ...
  for (let i = 0; i <= cells.length - 3; i += 3) {
    const p1El = cells[i];
    const labelEl = cells[i + 1];
    const p2El = cells[i + 2];

    if (!p1El.classList.contains("msVal")) continue;
    if (!labelEl.classList.contains("msLabel")) continue;
    if (!p2El.classList.contains("msVal")) continue;

    // Reset
    p1El.classList.remove("msWin", "msLose", "msTie");
    p2El.classList.remove("msWin", "msLose", "msTie");

    const raw1 = (p1El.textContent || "").trim();
    const raw2 = (p2El.textContent || "").trim();

    // Treat "-" as 0 (for highest checkout, etc.)
    const v1 = raw1 === "—" ? 0 : Number(raw1);
    const v2 = raw2 === "—" ? 0 : Number(raw2);

    if (!Number.isFinite(v1) || !Number.isFinite(v2)) continue;


    const label = (labelEl.textContent || "").trim().toLowerCase();

    // Rows where LOWER is better
    const lowerIsBetter =
      label.includes("darts") || label.includes("bust"); // keep darts as "lower wins"

    if (v1 === v2) {
      p1El.classList.add("msTie");
      p2El.classList.add("msTie");
      continue;
    }

    const p1Wins = lowerIsBetter ? v1 < v2 : v1 > v2;

    if (p1Wins) {
      p1El.classList.add("msWin");
      p2El.classList.add("msLose");
    } else {
      p2El.classList.add("msWin");
      p1El.classList.add("msLose");
    }
  }
}

applyMatchEndStatColors();


    const winnerLeaveBtn = document.getElementById("winnerLeaveBtn");

    // Between legs: only show Continue.
    // End of match: host gets New Match; everyone gets Leave.
    const matchFinished = match.status === "finished";

    if (winnerNewGameBtn) {
      if (matchFinished) {
        // In online games, only the host can start a new match.
        if (match.gameType === "online" && !isHost(state)) {
          winnerNewGameBtn.classList.add("hidden");
        } else {
          winnerNewGameBtn.classList.remove("hidden");
          winnerNewGameBtn.innerText = "New Match";
        }
      } else {
        winnerNewGameBtn.classList.remove("hidden");
        winnerNewGameBtn.innerText = "Continue (Next Leg)";
      }
    }

    if (winnerLeaveBtn) {
      if (matchFinished) winnerLeaveBtn.classList.remove("hidden");
      else winnerLeaveBtn.classList.add("hidden");
    }

    if (statusEl) statusEl.innerText = `${winnerName} wins the leg`;
    setWinnerModalVisible(true, winnerName);
  } else {
    const whoName = match.players[leg.currentPlayer].name;
    if (statusEl) statusEl.innerText = `${whoName} to throw`;
    setWinnerModalVisible(false);
  }
}
