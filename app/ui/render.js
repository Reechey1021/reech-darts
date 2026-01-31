// app/ui/render.js
import { app } from "../state.js";
import { canScoreNow, canUndoNow, canEditScores, mySeatIndex } from "../permissions.js";
import { checkoutSuggestion, minDartsForCheckout, isPossibleCheckout } from "../model/rules.js";
import { calcLegStats, calcMatchStats, formatPills } from "../model/stats.js";
import { renderBullMarkersFromState } from "../bull/ui.js";
import { getActorId } from "../auth.js";
import { isHost } from "../permissions.js";
import { playSfxWebAudio } from "../audio/audio.js";

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

// -----------------------------
// Lightweight top toast (used for online join notifications)
// -----------------------------
let __seatToastTimer = null;
export function showSeatJoinToast(message, durationMs = 5000) {
  try {
    const el = document.getElementById("seatJoinToast");
    const text = document.getElementById("seatJoinToastText");
    if (!el) return;
    el.classList.remove("danger");
    if (text) text.textContent = String(message || "");

    if (__seatToastTimer) {
      clearTimeout(__seatToastTimer);
      __seatToastTimer = null;
    }

    el.classList.remove("hidden");
    // trigger transition
    requestAnimationFrame(() => el.classList.add("show"));

    // Best-effort SFX (non-fatal if blocked/unlocked)
    playSfxWebAudio("/audio/sounds/LobbyJoin.mp3");

    // SFX: someone joined the lobby
    playSfxWebAudio("/audio/sounds/LobbyJoin.mp3");

    __seatToastTimer = setTimeout(() => {
      el.classList.remove("show");
      // allow slide-out transition to finish
      setTimeout(() => el.classList.add("hidden"), 260);
    }, Math.max(1200, Number(durationMs) || 5000));
  } catch (_) {
    // non-fatal
  }
}

export function showSeatLeaveToast(message, durationMs = 5000) {
  try {
    const el = document.getElementById("seatJoinToast");
    const text = document.getElementById("seatJoinToastText");
    if (!el) return;
    el.classList.add("danger");
    if (text) text.textContent = String(message || "Player left the game");

    if (__seatToastTimer) {
      clearTimeout(__seatToastTimer);
      __seatToastTimer = null;
    }

    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("show"));

    // Best-effort SFX (non-fatal if blocked/unlocked)
    playSfxWebAudio("/audio/sounds/LobbyLeave.mp3");

    // Best-effort SFX (non-fatal if blocked/unlocked)
    playSfxWebAudio("/audio/sounds/LobbyLeave.mp3");

    // SFX: someone left the lobby
    playSfxWebAudio("/audio/sounds/LobbyLeave.mp3");

    __seatToastTimer = setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.classList.add("hidden"), 260);
    }, Math.max(1200, Number(durationMs) || 5000));
  } catch (_) {
    // non-fatal
  }
}

export function setNameRowDanger(playerIndex, enabled) {
  const sel = Number(playerIndex) === 0 ? "#p1Box .nameRow" : "#p2Box .nameRow";
  const el = document.querySelector(sel);
  if (el) el.classList.toggle("danger", !!enabled);
}



// --------------------------
// Host-left modal (shown to remaining player when host exits an online lobby/match)
// --------------------------
export function showHostLeftModal(hostName) {
  try {
    const modal = document.getElementById("hostLeftModal");
    const text = document.getElementById("hostLeftText");
    if (text) {
      const name = hostName ? String(hostName) : "Host";
      text.textContent = `${name} has left the game. This lobby is no longer available.`;
    }
    if (modal) openModal(modal);
  } catch (_) {}
}

export function setHostLeftModalVisible(visible) {
  const modal = document.getElementById("hostLeftModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
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

export function setNemesisMatchSetupModalVisible(visible) {
  const modal = document.getElementById("nemesisMatchSetupModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

export function setCheckoutModalVisible(visible) {
  const modal = document.getElementById("checkoutModal");
  if (!modal) return;
  // When closing, ensure any transient UI state is reset so selections don't
  // persist if the user cancels / closes the modal.
  if (!visible) {
    try {
      document.querySelectorAll(".dartsBtn").forEach((b) => b.classList.remove("selected"));
      document.querySelectorAll(".doubleDartsBtn").forEach((b) => b.classList.remove("selected"));
      window.__selectedCheckoutDarts = null;
      window.__selectedCheckoutDoubleDarts = null;
      const confirmBtn = document.getElementById("checkoutConfirmBtn");
      if (confirmBtn) confirmBtn.disabled = true;
    } catch (_) {}
  }
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

const DEFAULT_THEME = "cyan";

export function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem("theme", theme);

  const btn = document.getElementById("themeToggleBtn");
  if (btn) btn.textContent = "🎨";
}

export function initThemeToggle() {
  // Guests: always dark mode (no dashboard to toggle).
  // Signed-in users: theme is controlled from the dashboard and stored in localStorage.
  const isSignedIn = !!(app.user && !app.user.isAnonymous);

  if (!isSignedIn) {
    applyTheme(DEFAULT_THEME);
  } else {
    const saved = localStorage.getItem("theme");
    const preferred = saved || DEFAULT_THEME;
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
  const nemesisThoughtPopup = document.getElementById("nemesisThoughtPopup");
  const nemesisThoughtPopupText = document.getElementById("nemesisThoughtPopupText");
  const gsOpenAuditChatBtn = document.getElementById("gsOpenAuditChatBtn");

  if (gsOpenAuditChatBtn) {
    const isOnline = state?.match?.gameType === "online";
    gsOpenAuditChatBtn.textContent = isOnline ? "Open Chat and Audits" : "Open Audits";
  }

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
    if (settingsBtn) settingsBtn.classList.toggle("hidden", false);
    if (leaveBtn) leaveBtn.classList.toggle("hidden", true);
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
    // Nemesis: show a fixed avatar/icon for Player 2.
    if (state?.nemesis?.enabled === true) {
      setPhoto(p2Photo, "../icons/Nemesis_icon.png");
    }
  }

  const bullModalShouldShow =
    state?.match?.starting === "bull" &&
    state?.match?.bull &&
    !state.match.bull.finalized;

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
      if (bull.resolved) promptEl.textContent = "Result";
      else if (neededPlayer === null) promptEl.textContent = "Calculating starter…";
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

    const bullResolved = !!bull.resolved;
    const bullResultPanel = document.getElementById("bullResultPanel");
    const bullResultText = document.getElementById("bullResultText");
    const bullStartBtn = document.getElementById("bullStartBtn");
    const bullRethrowBtn = document.getElementById("bullRethrowBtn");
    const bullControlsRow = bullResetBtn ? bullResetBtn.closest(".row") : null;


    // When bull is resolved: show result screen, hide pick controls
    if (bullResultPanel) bullResultPanel.classList.toggle("hidden", !bullResolved);

    // Host-only actions (online): only the host should be able to Start Game / Rethrow.
    const hideBullResultActions = (state?.match?.gameType === "online") && !isHost(state);
    if (bullStartBtn) bullStartBtn.classList.toggle("hidden", hideBullResultActions);
    if (bullRethrowBtn) bullRethrowBtn.classList.toggle("hidden", hideBullResultActions);

    // Hide/show the whole controls row (Reset + Confirm) based on result panel visibility
    if (bullControlsRow) bullControlsRow.classList.toggle("hidden", bullResolved || shouldHideControls);

    // Keep button-level visibility driven ONLY by online "your turn" rules
    if (bullResetBtn) bullResetBtn.classList.toggle("hidden", shouldHideControls);
    if (bullConfirmBtn) bullConfirmBtn.classList.toggle("hidden", shouldHideControls);

    if (bullBoard) bullBoard.style.pointerEvents = (shouldHideControls || bullResolved) ? "none" : "auto";


    if (bullResetBtn) bullResetBtn.classList.toggle("hidden", shouldHideControls);
    if (bullConfirmBtn) bullConfirmBtn.classList.toggle("hidden", shouldHideControls);
    if (bullBoard) bullBoard.style.pointerEvents = shouldHideControls ? "none" : "auto";


        if (bull.resolved) {
      const winnerSeat = bull.winner;
      const winnerName = state.match.players?.[winnerSeat]?.name || (winnerSeat === 0 ? "Player 1" : "Player 2");
      if (bullResultText) bullResultText.textContent = `${winnerName} is closer, they will start.`;
    }

    // Show confirmed bull markers for all players
    try { renderBullMarkersFromState(state, mySeatIndex(state)); } catch (_) {}

    setBullModalVisible(true);
  } else {
    setBullModalVisible(false);
  }
  if (abortBullBtn) abortBullBtn.classList.toggle("hidden", !bullModalShouldShow);

  const isOnline = state?.match?.gameType === "online";
  const scoreAllowed = canScoreNow(state);
  const undoAllowed = canUndoNow(state);

  if (overlay && overlayText) {
    if ((isOnline && !scoreAllowed && state?.match && state?.leg) || (state?.nemesis?.enabled === true && state?.match && state?.leg && state.leg.status === "in_progress" && state.leg.currentPlayer === 1)) {
      const who = state.match.players[state.leg.currentPlayer]?.name || (state.leg.currentPlayer === 1 ? "Nemesis" : "the other player");
      overlayText.textContent = `It’s ${who}’s turn`;
      overlay.classList.remove("hidden");
    } else {
      overlay.classList.add("hidden");
    }
  }

  if (overlayUndoBtn) overlayUndoBtn.disabled = !undoAllowed;

  // Nemesis debug thoughts panel has been deprecated (use the seed link in Audits).

  // Nemesis thought popup (rare, meaningful)
  if (nemesisThoughtPopup && nemesisThoughtPopupText) {
    const pop = state?.nemesis?.runtime?.popup;
    const nowMs = Date.now();
    const shouldShow = (state?.nemesis?.enabled === true) && (state?.nemesis?.showDialog !== false) &&
      pop && typeof pop.text === "string" &&
      Number.isFinite(Number(pop.expiresAt)) &&
      nowMs < Number(pop.expiresAt);

    if (shouldShow) {
      // Render as an italicised quote (less "chat bubble", more "thought" vibe)
      nemesisThoughtPopupText.textContent = `“${pop.text}”`;

      // Restart animation when the message changes
      const ts = String(pop.ts || "");
      if (nemesisThoughtPopup.dataset.ts !== ts) {
        nemesisThoughtPopup.dataset.ts = ts;
        nemesisThoughtPopup.classList.remove("show");
        // Force reflow to restart CSS animation
        void nemesisThoughtPopup.offsetWidth;
      }

      nemesisThoughtPopup.classList.remove("hidden");
      nemesisThoughtPopup.classList.add("show");

      // Local hide timer (in case no further renders happen after expiry)
      try {
        if (window.__nemesisThoughtPopupTimer) clearTimeout(window.__nemesisThoughtPopupTimer);
        const msLeft = Math.max(0, Number(pop.expiresAt) - nowMs + 50);
        window.__nemesisThoughtPopupTimer = setTimeout(() => {
          // Only hide if it's still the same message
          const curTs = nemesisThoughtPopup?.dataset?.ts;
          if (curTs === String(pop.ts || "")) {
            nemesisThoughtPopup.classList.add("hidden");
            nemesisThoughtPopup.classList.remove("show");
          }
        }, msLeft);
      } catch (_) {}

      // Tail positioning: aim toward Nemesis name tag
      try {
        const bubble = nemesisThoughtPopup.querySelector(".bubble");
        const p2NameEl2 = document.getElementById("p2Name");
        if (bubble && p2NameEl2) {
          const b = bubble.getBoundingClientRect();
          const n = p2NameEl2.getBoundingClientRect();
          const targetX = (n.left + n.right) / 2;
          let x = targetX - b.left;
          x = Math.max(24, Math.min(b.width - 24, x));
          bubble.style.setProperty("--tail-x", `${x}px`);
        }
      } catch (_) {}
    } else {
      nemesisThoughtPopup.classList.add("hidden");
      nemesisThoughtPopup.classList.remove("show");
    }
  }



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
  const matchStatsTabs = document.getElementById("matchStatsTabs");
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
        try {
          const isNemesisGame = !!(state?.nemesis?.enabled) && ((state?.seat2Name || state?.lobby?.joiner?.name || "") === "Nemesis");
          const p2NameRow = document.querySelector("#p2Box .nameRow");
          if (p2NameRow) {
            p2NameRow.classList.toggle("nemesisP2Name", isNemesisGame);
          }
        } catch (_) {}
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
      const checkOutRule = state?.match?.rules?.checkOut ?? "double";
      const hasFinish = typeof remaining === "number" && isPossibleCheckout(remaining, checkOutRule);
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

  if (gameMetaEl) {
    // Match setup stores presets as keys (e.g. "grand_prix"), so map them to the
    // short UI label consistently.
    const p = String(match?.rules?.preset || "custom").toLowerCase();
    let label = "Custom";
    if (p === "grand_prix" || p === "gp") label = "GP";
    else if (p === "x01") label = "X01";
    else if (p === "straight_in_out" || p === "siso") label = "SISO";
    gameMetaEl.innerText = `${label} • ${match.mode} • BO${match.bestOf}`;
  }

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
  try {
    const isNemesisGame = !!(state?.nemesis?.enabled) && ((match.players?.[1]?.name || "") === "Nemesis");
    const p2NameRow = document.querySelector("#p2Box .nameRow");
    if (p2NameRow) p2NameRow.classList.toggle("nemesisP2Name", isNemesisGame);
  } catch (_) {}
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
  const checkOutRule = match?.rules?.checkOut ?? "double";
  if (checkOutRule === "straight") {
    if (p1CheckoutEl) p1CheckoutEl.innerHTML = "";
    if (p2CheckoutEl) p2CheckoutEl.innerHTML = "";
  } else {
    const sug1 = typeof s1 === "number" ? checkoutSuggestion(s1) : null;
    const sug2 = typeof s2 === "number" ? checkoutSuggestion(s2) : null;
    if (p1CheckoutEl) p1CheckoutEl.innerHTML = sug1 ? `<span class="pill">${sug1}</span>` : "";
    if (p2CheckoutEl) p2CheckoutEl.innerHTML = sug2 ? `<span class="pill">${sug2}</span>` : "";
  }

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
    if (state.pendingCheckout.suppressPrompt === true || state.pendingCheckout.actorId === 'nemesis' || (state?.nemesis?.enabled === true && state.pendingCheckout.player === 1)) { setCheckoutModalVisible(false); } else {
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

    const rules = match.rules || {};
    const needDouble = rules.checkOut === "double" && rules.trackCheckoutStats === true;

    const doubleBody = document.getElementById("checkoutDoubleBody");
    const doubleRow = document.getElementById("checkoutDoubleRow");
    const doubleBtns = Array.from(document.querySelectorAll(".doubleDartsBtn"));

    // Default: hide double question
    if (doubleBody) doubleBody.style.display = "none";
    if (doubleRow) doubleRow.style.display = "none";
    for (const b of doubleBtns) {
      b.style.display = "";
      b.classList.remove("selected");
    }

    // Also clear any lingering selection on the primary darts buttons.
    for (const b of dartsBtns) b.classList.remove("selected");

    window.__checkoutRequireDoubleDarts = false;
    window.__selectedCheckoutDoubleDarts = null;


    for (const b of dartsBtns) b.style.display = "";

    if (minDarts === 2) {
      const b1 = document.querySelector('.dartsBtn[data-darts="1"]');
      if (b1) b1.style.display = "none";
    }

    if (minDarts === 3) {
      for (const b of dartsBtns) b.style.display = "none";
      window.__selectedCheckoutDarts = 3;

      // In double-out with tracking, we assume 1 dart was thrown at the double when minDarts is 3.
      if (needDouble) {
        window.__selectedCheckoutDoubleDarts = 1;
        window.__checkoutRequireDoubleDarts = false;
      }

      if (confirmBtn) confirmBtn.disabled = false;
      if (body) body.innerText = `${who} is checking out. Confirm?`;
    } else {
      window.__selectedCheckoutDarts = null;

      // If we need doubles tracking, show the extra question and require a selection.
      if (needDouble) {
        window.__checkoutRequireDoubleDarts = true;
        if (doubleBody) doubleBody.style.display = "";
        if (doubleRow) doubleRow.style.display = "";

        // Hide impossible options based on minimum darts needed.
        if (minDarts === 2) {
          const db1 = document.querySelector('.doubleDartsBtn[data-darts="1"]');
          if (db1) db1.style.display = "none";
        }
      }

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

  // V4 rules + tracking flags
  const rules = match.rules || {};
  const trackingOn = rules.trackCheckoutStats === true;
  const checkInRule = rules.checkIn || "straight";
  const checkOutRule = rules.checkOut || "double";

  // Only show avatars in ONLINE games. Local games should never show Google/profile photos.
  const showMatchAvatars = match.gameType === "online";
  const p1Photo = showMatchAvatars ? (match.players?.[0]?.photoURL || match.seat1PhotoURL || "") : "";
  const p2Photo = showMatchAvatars ? (match.players?.[1]?.photoURL || match.seat2PhotoURL || "") : "";

  // Aggregate tracking summaries from per-leg summaries (added in Step E)
  const agg = {
    checkInThrown: [0, 0],
    checkInHit: [0, 0],
    checkoutOpp: [0, 0],
    checkoutThrown: [0, 0],
    checkoutHit: [0, 0],
  };

  for (const legSum of match.legs || []) {
    const pls = legSum.players || [];
    for (let p = 0; p < 2; p++) {
      const s = pls[p] || {};
      agg.checkInThrown[p] += Number(s.checkInDoublesThrown || 0);
      agg.checkInHit[p] += Number(s.checkInDoublesHit || 0);
      agg.checkoutOpp[p] += Number(s.checkoutOpp || 0);
      agg.checkoutThrown[p] += Number(s.checkoutDoublesThrown || 0);
      agg.checkoutHit[p] += Number(s.checkoutDoublesHit || 0);
    }
  }

  const pctStr = (hit, thrown) => {
    const h = Number(hit || 0);
    const t = Number(thrown || 0);
    if (!t) return "—";
    return `${Math.round((h / t) * 100)}%`;
  };

  const checkInPct = [pctStr(agg.checkInHit[0], agg.checkInThrown[0]), pctStr(agg.checkInHit[1], agg.checkInThrown[1])];
  const checkoutPct = [pctStr(agg.checkoutHit[0], agg.checkoutThrown[0]), pctStr(agg.checkoutHit[1], agg.checkoutThrown[1])];

if (matchStatsGrid) {
    const matchFinished = match.status === "finished";
    const legs = match.legs || [];
    const lastLegIndex = legs.length; // 1-based
    // Determine selected tab
    let selectedTab = app.matchStatsTab || "final";
    if (!matchFinished) {
      // Between legs: show only the most recent leg and hide tabs.
      selectedTab = `leg-${lastLegIndex}`;
      app.matchStatsTab = selectedTab;
      if (matchStatsTabs) {
        matchStatsTabs.classList.add("hidden");
        matchStatsTabs.innerHTML = "";
      }
    } else {
      // Match finished: render tabs for each leg + final
      if (matchStatsTabs) {
        matchStatsTabs.classList.remove("hidden");
        const tabKeys = [];
        for (let i = 1; i <= lastLegIndex; i++) tabKeys.push(`leg-${i}`);
        tabKeys.push("final");

        if (!tabKeys.includes(selectedTab)) selectedTab = "final";
        app.matchStatsTab = selectedTab;

        matchStatsTabs.innerHTML = tabKeys
          .map((k) => {
            const label = k === "final" ? "Final" : `Leg ${k.split("-")[1]}`;
            const active = k === selectedTab ? "active" : "";
            return `<button class="msTabBtn ${active}" data-tab="${k}" type="button">${label}</button>`;
          })
          .join("");
      }
    }

    const isFinal = selectedTab === "final";
    const legNum = !isFinal ? Number((selectedTab.split("-")[1] || "0")) : 0;
    const legSum = !isFinal ? legs[Math.max(0, legNum - 1)] : null;

    // Pick stats scope: final (whole match) vs a specific leg
    const scopeTotals = isFinal ? calcMatchStats(match) : [
      { ...(legSum?.players?.[0] || {}) },
      { ...(legSum?.players?.[1] || {}) },
    ];
    const p1mScoped = formatPills(scopeTotals[0]);
    const p2mScoped = formatPills(scopeTotals[1]);

    // Highest checkout in scope
    const maxCheckoutScoped = [0, 0];
    if (isFinal) {
      for (const ls of legs) {
        const w = typeof ls.winner === "number" ? ls.winner : null;
        const cs = Number(ls.checkoutScore || 0);
        if (w === 0 || w === 1) maxCheckoutScoped[w] = Math.max(maxCheckoutScoped[w], cs);
      }
    } else if (legSum) {
      const w = typeof legSum.winner === "number" ? legSum.winner : null;
      const cs = Number(legSum.checkoutScore || 0);
      if (w === 0 || w === 1) maxCheckoutScoped[w] = Math.max(maxCheckoutScoped[w], cs);
    }

    // Tracking aggregates in scope (for Step E stats)
    const aggScoped = {
      checkInThrown: [0, 0],
      checkInHit: [0, 0],
      checkoutOpp: [0, 0],
      checkoutThrown: [0, 0],
      checkoutHit: [0, 0],
      legsWon: [0, 0],
    };

    const addLegToAgg = (ls) => {
      if (!ls || !ls.players) return;
      const w = typeof ls.winner === "number" ? ls.winner : null;
      if (w === 0 || w === 1) aggScoped.legsWon[w] += 1;

      for (let p = 0; p < 2; p++) {
        const s = ls.players[p] || {};
        aggScoped.checkInThrown[p] += Number(s.checkInDoublesThrown || 0);
        aggScoped.checkInHit[p] += Number(s.checkInDoublesHit || 0);
        aggScoped.checkoutOpp[p] += Number(s.checkoutOpp || 0);
        aggScoped.checkoutThrown[p] += Number(s.checkoutDoublesThrown || 0);
        aggScoped.checkoutHit[p] += Number(s.checkoutDoublesHit || 0);
      }
    };

    if (isFinal) {
      for (const ls of legs) addLegToAgg(ls);
    } else {
      addLegToAgg(legSum);
    }

    const pctStr = (hit, thrown) => {
      const h = Number(hit || 0);
      const t = Number(thrown || 0);
      if (!t) return "—";
      return `${Math.round((h / t) * 100)}%`;
    };

    const checkInPctScoped = [
      pctStr(aggScoped.checkInHit[0], aggScoped.checkInThrown[0]),
      pctStr(aggScoped.checkInHit[1], aggScoped.checkInThrown[1]),
    ];
    const checkoutPctScoped = [
      pctStr(aggScoped.checkoutHit[0], aggScoped.checkoutThrown[0]),
      pctStr(aggScoped.checkoutHit[1], aggScoped.checkoutThrown[1]),
    ];

    // Checkout success = legs finished / checkout opportunities, within the scope.
    const checkoutSuccessScoped = [
      `${aggScoped.legsWon[0]}/${aggScoped.checkoutOpp[0] ?? 0}`,
      `${aggScoped.legsWon[1]}/${aggScoped.checkoutOpp[1] ?? 0}`,
    ];

    const rows = [];
    const addRow = (label, v1, v2) => {
      rows.push(`
        <div class="msCell msVal">${v1}</div>
        <div class="msCell msLabel">${label}</div>
        <div class="msCell msVal">${v2}</div>
      `);
    };

    // Between legs + per-leg tabs: hide "Legs won"
    if (isFinal) {
      addRow("Legs won", match.legsWon?.[0] ?? 0, match.legsWon?.[1] ?? 0);
    }

    addRow("3 dart avg", p1mScoped.tda, p2mScoped.tda);
    addRow("First 9 avg", p1mScoped.f9d, p2mScoped.f9d);
    addRow("Highest checkout", maxCheckoutScoped[0] || "—", maxCheckoutScoped[1] || "—");

    if (trackingOn && checkInRule === "double") {
      addRow("Check-in success", checkInPctScoped[0], checkInPctScoped[1]);
    }

    if (trackingOn && checkOutRule === "double") {
      addRow("Checkout %", checkoutPctScoped[0], checkoutPctScoped[1]);
      addRow("Checkout success", checkoutSuccessScoped[0], checkoutSuccessScoped[1]);
    }

    addRow("100+", scopeTotals[0].c100 || 0, scopeTotals[1].c100 || 0);
    addRow("140+", scopeTotals[0].c140 || 0, scopeTotals[1].c140 || 0);
    addRow("180", scopeTotals[0].c180 || 0, scopeTotals[1].c180 || 0);
    addRow("Darts thrown", scopeTotals[0].darts || 0, scopeTotals[1].darts || 0);

    matchStatsGrid.innerHTML = `
      <div class="msHeader msCell msName">${match.players[0].name}</div>
      <div class="msHeader msCell"></div>
      <div class="msHeader msCell msName">${match.players[1].name}</div>
      ${rows.join("")}
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

      const label = (labelEl.textContent || "").trim().toLowerCase();

      // Never color "Darts thrown" (misleading for who started/won).
      if (label.includes("darts thrown")) continue;

      // Reset
      p1El.classList.remove("msWin", "msLose", "msTie");
      p2El.classList.remove("msWin", "msLose", "msTie");

      const raw1 = (p1El.textContent || "").trim();
      const raw2 = (p2El.textContent || "").trim();

      const parseStat = (label, raw) => {
        const s = String(raw || "").trim();
        if (!s || s === "—") return 0;

        // Percentages: "33%"
        if (s.endsWith("%")) {
          const n = parseFloat(s.replace("%",""));
          return Number.isFinite(n) ? n : 0;
        }

        // Fractions: "2/5" (checkout success). Compare as ratio.
        if (s.includes("/")) {
          const parts = s.split("/").map((x) => Number(String(x).trim()));
          const a = parts[0], b = parts[1];
          if (Number.isFinite(a) && Number.isFinite(b) && b > 0) return a / b;
          if (Number.isFinite(a)) return a;
          return 0;
        }

        // Plain number
        const n = Number(s);
        return Number.isFinite(n) ? n : 0;
      };

      const v1 = parseStat(label, raw1);
      const v2 = parseStat(label, raw2);

      // Rows where LOWER is better (keep existing behavior for any future stats)
      const lowerIsBetter = label.includes("bust");

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

    // Seat-2 UX: show "Waiting for Host..." when Continue is hidden.
    let winnerWaitingText = document.getElementById("winnerWaitingText");
    if (!winnerWaitingText && winnerNewGameBtn && winnerNewGameBtn.parentElement) {
      winnerWaitingText = document.createElement("div");
      winnerWaitingText.id = "winnerWaitingText";
      winnerWaitingText.className = "winnerWaitingText hidden";
      winnerWaitingText.innerText = "Waiting for Host to continue…";
      winnerNewGameBtn.parentElement.insertBefore(winnerWaitingText, winnerNewGameBtn.nextSibling);
    }

    // Between legs: only show Continue.
    // End of match: host gets New Match; everyone gets Leave.
    const matchFinished = match.status === "finished";

    if (winnerNewGameBtn) {
      if (matchFinished) {
        // In online games, only the host can start a new match.
        if (match.gameType === "online" && !isHost(state)) {
          winnerNewGameBtn.classList.add("hidden");
          if (winnerWaitingText) winnerWaitingText.classList.add("hidden");
        } else {
          winnerNewGameBtn.classList.remove("hidden");
          if (winnerWaitingText) winnerWaitingText.classList.add("hidden");
          winnerNewGameBtn.innerText = "New Match";
        }
      } else {
        // In online games, only the host can advance to the next leg.
        if (match.gameType === "online" && !isHost(state)) {
          winnerNewGameBtn.classList.add("hidden");
          if (winnerWaitingText) winnerWaitingText.classList.remove("hidden");
        } else {
          if (winnerWaitingText) winnerWaitingText.classList.add("hidden");
          winnerNewGameBtn.classList.remove("hidden");
          if (winnerWaitingText) winnerWaitingText.classList.add("hidden");
          winnerNewGameBtn.innerText = "Continue (Next Leg)";
        }
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