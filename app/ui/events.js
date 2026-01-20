// app/ui/events.js
import { app } from "../state.js";
import { canScoreNow, canUndoNow, isHost } from "../permissions.js";
import {
  openNewGameFlow,
  submitScore,
  undoLast,
  startMatchFromSetup,
  cancelCheckout,
  confirmCheckout,
  continueOrNewMatch,
  createNewGameAndShowInvite,
  createLocalGameAndOpenSetup,
  leaveMatch,
  restartMatch,
} from "../actions.js";
import { applyTheme, initThemeToggle, showError, hideError, setInviteModalVisible, setSetupModalVisible, setLobbyGateVisible, openModal, closeModal } from "./render.js";
import { unlockAudioOnce } from "../audio/audio.js";
import { initBullUI } from "../bull/ui.js";
import { signInWithGoogle, ensureAnonymousSignIn } from "../auth.js";
import { setGuestDisplayName } from "../profile.js";
import { openProfileModalForPlayerIndex as openProfileForPlayer} from "./profileModal.js";
import { initProfileModalUI as wireProfileModalClose} from "./profileModal.js";
import {
  setInputMode,
  setMult,
  multFactor,
  pushDart,
  popDart,
  clearDarts,
  updateDartUI,
} from "../input/dartpad.js";

// ---------- Setup UI mode (local vs online) ----------
function configureSetupModalForLobbyType(lobbyType) {
  const isOnline = lobbyType === "online";

  const localFields = document.getElementById("setupLocalNameFields");
  const onlineFields = document.getElementById("setupOnlineFields");

  if (localFields) localFields.style.display = isOnline ? "none" : "";
  if (onlineFields) onlineFields.style.display = isOnline ? "" : "none";
}


// ---------- Helpers ----------
function isAnyModalOpen() {
  const ids = ["winnerModal", "setupModal", "checkoutModal", "confirmNewMatchModal", "inviteModal", "bullModal"];
  return ids.some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  });
}

function isIOSDevice() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent || "") && !window.MSStream;
}

// ---------- Wire UI ----------
export function wireUI() {
  // Gate UI
  const guestNameInput = document.getElementById("guestNameInput");
  const createLobbyBtn = document.getElementById("createLobbyBtn");
  const joinGameBtn = document.getElementById("joinGameBtn");
  const googleLoginBtn = document.getElementById("googleLoginBtn");
  const playOfflineBtn = document.getElementById("playOfflineBtn");

  const joinGameModal = document.getElementById("joinGameModal");
  const joinGameLink = document.getElementById("joinGameLink");
  const joinGameConfirmBtn = document.getElementById("joinGameConfirmBtn");
  const joinGameCancelBtn = document.getElementById("joinGameCancelBtn");
  const joinGameCloseBtn = document.getElementById("joinGameCloseBtn");
  const joinGameGateBtn = document.getElementById("joinGameGateBtn");

  // Gate button state: guests must provide a display name before they can create/join.
  // Signed-in users (Google) won't see the gate anyway, but keep logic correct.
  const refreshGateButtons = () => {
    const signedIn = !!(app.user && !app.user.isAnonymous);
    const name = (guestNameInput?.value || "").trim().slice(0, 12);
    const okGuest = name.length > 0;
    if (createLobbyBtn) createLobbyBtn.disabled = !(signedIn || okGuest);
    if (joinGameGateBtn) joinGameGateBtn.disabled = !(signedIn || okGuest);
  };

  if (guestNameInput) {
    guestNameInput.addEventListener("input", refreshGateButtons);
  }

  if (joinGameCloseBtn) {
  joinGameCloseBtn.addEventListener("click", () => {
    const modal = document.getElementById("joinGameModal");
    if (modal) modal.classList.add("hidden");
  });
}

  // Profile modal (closes only on this device)
  wireProfileModalClose();

  // Initial gate button state
  refreshGateButtons();

  // Create Online Lobby (guest)
  if (createLobbyBtn) {
    createLobbyBtn.addEventListener("click", async () => {
      const name = (guestNameInput?.value || "").trim().slice(0, 12);

      if (!name) {
        showError("Enter guest name");
        return;
      }

      setGuestDisplayName(name);
      await ensureAnonymousSignIn();

      // After we show the invite link, auto-open the setup modal when the invite popup is closed.
      app.pendingLobbyType = "online";
      app.autoSetupAfterInviteClose = true;

      const res = await createNewGameAndShowInvite({ lobbyType: "online", openInvite: true });
      if (!res || res.ok !== true) {
        showError("Couldn’t create lobby. Please try again.");
        return;
      }
    });
  }

  if (joinGameGateBtn) {
  joinGameGateBtn.addEventListener("click", () => {
    // If not logged in, require guest display name before joining
    const isLoggedIn = !!(app.user && !app.user.isAnonymous);
    if (!isLoggedIn) {
      const name = (guestNameInput?.value || "").trim().slice(0, 12);

      if (!name) {
        showError("Enter guest name");
        return;
      }

      // Make sure the app knows this guest name
      setGuestDisplayName(name);
    }

    // Open the join modal
    const modal = document.getElementById("joinGameModal");
    if (modal) modal.classList.remove("hidden");
  });
}

  // Join modal cancel should work (return to gate)
  if (joinGameCancelBtn) {
    joinGameCancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (joinGameModal) joinGameModal.classList.add("hidden");
      // Gate is already visible, but ensure it is shown.
      setLobbyGateVisible(true);
      refreshGateButtons();
    });
  }

  // Join Game (guest) -> open join modal
  if (joinGameBtn) {
    joinGameBtn.addEventListener("click", () => {
      const name = (guestNameInput?.value || "").trim().slice(0, 12);
      if (!name) {
        showError("Please enter a display name to continue.");
        return;
      }
      if (joinGameLink) joinGameLink.value = "";
      if (joinGameModal) joinGameModal.classList.remove("hidden");
      try { joinGameLink?.focus(); } catch {}
    });
  }

  if (joinGameCloseBtn && joinGameModal) {
    joinGameCloseBtn.addEventListener("click", () => joinGameModal.classList.add("hidden"));
  }

  async function joinGameByLinkFromGate() {
    const name = (guestNameInput?.value || "").trim().slice(0, 12);
    if (!name) {
      showError("Please enter a display name to continue.");
      return;
    }

    const txt = (joinGameLink?.value || "").trim();
    if (!txt) {
      showError("Paste an invite link first.");
      return;
    }

    let gameId = null;
    try {
      const url = new URL(txt, window.location.origin);
      gameId = (url.searchParams.get("game") || "").trim() || null;
    } catch {
      // allow pasting raw game id
      gameId = txt;
    }

    if (!gameId) {
      showError("That doesn't look like a valid invite link.");
      return;
    }

    // Ensure guest profile name is set
    setGuestDisplayName(name);
    await ensureAnonymousSignIn();

    // Pre-check lobby fullness for online games
    try {
      const snap = await app.db.collection("games").doc(gameId).get();
      if (!snap.exists) {
        showError("Game not found.");
        return;
      }
      const data = snap.data() || {};
      const match = data.match || null;
      if (match?.gameType === "online" && match.seat1Id && match.seat2Id) {
        const me = app.actorId;
        if (me !== match.seat1Id && me !== match.seat2Id) {
          showError("This lobby is full.");
          return;
        }
      }
    } catch (e) {
      console.warn("Join precheck failed", e);
    }

    // Navigate to the match
    window.location.href = `index.html?game=${encodeURIComponent(gameId)}`;
  }

  if (joinGameConfirmBtn) {
    joinGameConfirmBtn.addEventListener("click", () => {
      joinGameByLinkFromGate();
    });
  }

  // Start Offline Local Game (no invite link)
  if (playOfflineBtn) {
    playOfflineBtn.addEventListener("click", async () => {
      try {
        await ensureAnonymousSignIn();
        app.pendingLobbyType = "local";
        await createLocalGameAndOpenSetup();
        configureSetupModalForLobbyType("local");
      } catch (e) {
        console.error(e);
        showError("Couldn’t start offline game.");
      }
    });
  }

  const closeInviteBtn = document.getElementById("closeInviteBtn");
  const copyInviteBtn = document.getElementById("copyInviteBtn");

  if (closeInviteBtn) {
    closeInviteBtn.addEventListener("click", () => {
      setInviteModalVisible(false);

      if (app.autoSetupAfterInviteClose) {
        app.autoSetupAfterInviteClose = false;
        configureSetupModalForLobbyType(app.pendingLobbyType || app.latestState?.lobbyType || "online");
        setSetupModalVisible(true);
      }
    });
  }

  if (copyInviteBtn) {
    copyInviteBtn.addEventListener("click", async () => {
      const text = document.getElementById("inviteLinkText")?.textContent || "";
      try { await navigator.clipboard.writeText(text); } catch {}

      const msg = document.getElementById("inviteCopyMsg");
      if (msg) {
        msg.classList.remove("hidden");
        clearTimeout(window.__inviteCopyTimer);
        window.__inviteCopyTimer = setTimeout(() => msg.classList.add("hidden"), 1500);
      }
    });
  }


  // Google login
  if (googleLoginBtn) {
    googleLoginBtn.addEventListener("click", async () => {
      try {
        await signInWithGoogle();
        // Go to dashboard for logged-in users.
        window.location.href = "./dashboard.html";
      } catch (e) {
        console.error(e);
        showError("Google login failed.");
      }
    });
  }

  // Main UI refs
  const gameSettingsBtn = document.getElementById("gameSettingsBtn");
  const leaveMatchBtn = document.getElementById("leaveMatchBtn");
  const seat2WaitingLeaveBtn = document.getElementById("seat2WaitingLeaveBtn");

  // Confirm Leave modal
  const confirmLeaveMatchModal = document.getElementById("confirmLeaveMatchModal");
  const confirmLeaveCancelBtn = document.getElementById("confirmLeaveCancelBtn");
  const confirmLeaveOkBtn = document.getElementById("confirmLeaveOkBtn");
  const gameSettingsModal = document.getElementById("gameSettingsModal");
  const gsNewGameBtn = document.getElementById("gsNewGameBtn");
  const gsRestartBtn = document.getElementById("gsRestartGameBtn");
  const gsLeaveBtn = document.getElementById("gsLeaveMatchBtn");
  const gsCloseBtn = document.getElementById("gsCloseBtn");

  const confirmRestartMatchModal = document.getElementById("confirmRestartMatchModal");
  const confirmRestartMatchCancelBtn = document.getElementById("confirmRestartMatchCancelBtn");
  const confirmRestartMatchOkBtn = document.getElementById("confirmRestartMatchOkBtn");
  const submitBtn = document.getElementById("submitBtn");
  const quickCheckoutBtn = document.getElementById("quickCheckoutBtn");
  const undoBtn = document.getElementById("undoBtn");
  const scoreInputEl = document.getElementById("scoreInput");
  const overlayUndoBtn = document.getElementById("overlayUndoBtn");
  const overlayStartBtn = document.getElementById("overlayStartBtn");
  const inputModeBtn = document.getElementById("inputModeBtn");
  // Legacy mobile menu refs (no longer used)

    // ----------------------------
  // Input mode init + toggle
  // ----------------------------
  setInputMode(app.inputMode); // restore last mode on load

  if (inputModeBtn) {
    inputModeBtn.addEventListener("click", () => {
      const next = app.inputMode === "keypad" ? "table" : "keypad";
      setInputMode(next);
    });
  }

  // ----------------------------
  // Dartpad (table mode) clicks
  // ----------------------------
  const dartPad = document.getElementById("dartPad");
  if (dartPad) {
    dartPad.addEventListener("click", (e) => {
      if (app.inputMode !== "table") return;
      // Allow building the dart entry even if you can't score right now.
      // Submit will still be disabled/blocked by permissions.

      const btn = e.target.closest("button");
      if (!btn) return;

      // Mult select
      const m = btn.getAttribute("data-mult");
      if (m) {
        setMult(m);
        return;
      }

      // Instant adds (bull/outer)
      const instant = btn.getAttribute("data-instant");
      if (instant) {
        pushDart(Number(instant));
        return;
      }

      // Numbers (apply selected mult)
      const num = btn.getAttribute("data-num");
      if (num) {
        const v = Number(num);
        pushDart(v * multFactor(app.dartMult));
        return;
      }

      // Specials
      const action = btn.getAttribute("data-action");
      if (action === "back") {
        popDart();
        return;
      }
      if (action === "miss") {
        pushDart(0);
        return;
      }
    });
  }

  // ----------------------------
  // Keypad (classic mode) clicks
  // ----------------------------
  const keypad = document.getElementById("keypad");
  const clearBtn = document.getElementById("keyClear");
  const backBtn = document.getElementById("keyBack");

  if (keypad && scoreInputEl) {
    keypad.addEventListener("click", (e) => {
      if (app.inputMode !== "keypad") return;
      if (!canScoreNow(app.latestState)) return;

      const btn = e.target.closest("button");
      if (!btn) return;

      const digit = btn.getAttribute("data-digit");
      if (digit !== null) {
        scoreInputEl.value = (scoreInputEl.value + digit).slice(0, 3);
      }
    });
  }

  if (clearBtn && scoreInputEl) {
    clearBtn.addEventListener("click", () => {
      if (app.inputMode !== "keypad") return;
      if (!canScoreNow(app.latestState)) return;

      scoreInputEl.value = "";
    });
  }

  if (backBtn && scoreInputEl) {
    backBtn.addEventListener("click", () => {
      if (app.inputMode !== "keypad") return;
      if (!canScoreNow(app.latestState)) return;

      scoreInputEl.value = scoreInputEl.value.slice(0, -1);
    });
  }

  // If we ever re-enter a game screen with table mode active,
  // make sure UI reflects current dart state
  updateDartUI();

  // Unlock audio on first gesture (iOS-safe)
  document.addEventListener("click", unlockAudioOnce, { once: true });
  document.addEventListener("touchstart", unlockAudioOnce, { once: true });

  // Game Settings menu
  const openGameSettings = () => {
    // Host-only. No popup; the UI will hide the button for player 2.
    if (!isHost(app.latestState)) return;
    if (gameSettingsModal) openModal(gameSettingsModal);
  };

  const closeGameSettings = () => {
    if (gameSettingsModal) closeModal(gameSettingsModal);
  };

  if (gameSettingsBtn) gameSettingsBtn.addEventListener("click", openGameSettings);
  if (gsCloseBtn) gsCloseBtn.addEventListener("click", closeGameSettings);

  if (gsNewGameBtn) {
    gsNewGameBtn.addEventListener("click", () => {
      closeGameSettings();
      openNewGameFlow();
    });
  }

  if (gsRestartBtn) {
    gsRestartBtn.addEventListener("click", () => {
      closeGameSettings();
      const m = document.getElementById("confirmRestartMatchModal");
      if (m) openModal(m);
    });
  }

  const openConfirmLeaveModal = () => {
    if (confirmLeaveMatchModal) openModal(confirmLeaveMatchModal);
  };

  const closeConfirmLeaveModal = () => {
    if (confirmLeaveMatchModal) closeModal(confirmLeaveMatchModal);
  };

  async function doLeaveMatchWithHandling() {
    closeConfirmLeaveModal();
    closeGameSettings(); // if modal is open, close it
    try {
      await leaveMatch();
    } catch (e) {
      console.error(e);
      showError("Could not leave match.");
    }
  }

  function confirmLeaveMatch() {
    // Use in-app modal (no browser confirm)
    openConfirmLeaveModal();
  }

  if (confirmLeaveCancelBtn) {
    confirmLeaveCancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      closeConfirmLeaveModal();
    });
  }

  if (confirmLeaveOkBtn) {
    confirmLeaveOkBtn.addEventListener("click", (e) => {
      e.preventDefault();
      doLeaveMatchWithHandling();
    });
  }

  // NEW: Top-bar Leave button (player 2 will see this instead of settings)
  if (leaveMatchBtn) {
    leaveMatchBtn.addEventListener("click", (e) => {
      e.preventDefault();
      confirmLeaveMatch();
    });
  }

  // Seat 2 lobby waiting modal: leave without confirmation (quick exit)
  if (seat2WaitingLeaveBtn) {
    seat2WaitingLeaveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      leaveMatch();
    });
  }

  // Existing: Leave inside Game Settings modal (host will use this)
  if (gsLeaveBtn) {
    gsLeaveBtn.addEventListener("click", (e) => {
      e.preventDefault();
      confirmLeaveMatch();
    });
  }


  // Submit/Undo
  if (submitBtn) submitBtn.addEventListener("click", submitScore);
  if (quickCheckoutBtn) {
    quickCheckoutBtn.addEventListener("click", () => {
      const state = app.latestState;
      if (!canScoreNow(state)) return;
      const leg = state?.leg;
      if (!leg || !leg.players) return;
      const p = leg.currentPlayer;
      const remaining = Number(leg.players?.[p]?.score);
      if (!Number.isFinite(remaining) || remaining <= 0) return;

      // Ensure we can submit a normal score using existing logic.
      // If the user is currently in table mode, switch to keypad mode first.
      if (app.inputMode !== "keypad") {
        setInputMode("keypad");
        clearDarts();
        updateDartUI();
      }

      if (scoreInputEl) scoreInputEl.value = String(remaining);
      submitScore();
    });
  }
  if (undoBtn) undoBtn.addEventListener("click", undoLast);

  // Overlay undo (allowed even when not your turn in online mode)
  if (overlayUndoBtn) {
    overlayUndoBtn.addEventListener("click", () => {
      if (!canUndoNow(app.latestState)) return;
      undoLast();
    });
  }

  // Overlay "New Game" (shown when no match is active). Host-only.
  if (overlayStartBtn) {
    overlayStartBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (!isHost(app.latestState)) return;
      openNewGameFlow();
    });
  }

  // Keyboard: Enter submits (input box)
  if (scoreInputEl) {
    // iOS: prevent the native on-screen keyboard popping up (we use our custom keypad)
    scoreInputEl.addEventListener("focus", () => {
      if (isIOSDevice()) scoreInputEl.blur();
    });

    scoreInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitScore();
    });

    scoreInputEl.addEventListener("input", () => {
      scoreInputEl.value = scoreInputEl.value.replace(/\D/g, "").slice(0, 3);
    });
  }

  // Setup modal buttons
  const setupCancelBtn = document.getElementById("setupCancelBtn");
  const setupStartBtn = document.getElementById("setupStartBtn");

  if (setupCancelBtn) setupCancelBtn.addEventListener("click", () => {
    const modal = document.getElementById("setupModal");
    if (modal) modal.classList.add("hidden");
  });

  if (setupStartBtn) setupStartBtn.addEventListener("click", startMatchFromSetup);

  // Checkout modal
  const checkoutCancelBtn = document.getElementById("checkoutCancelBtn");
  const checkoutConfirmBtn = document.getElementById("checkoutConfirmBtn");
  const dartsBtns = Array.from(document.querySelectorAll(".dartsBtn"));

  window.__selectedCheckoutDarts = null;

  for (const b of dartsBtns) {
    b.addEventListener("click", () => {
      dartsBtns.forEach(btn => btn.classList.remove("selected"));
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
      if (![1, 2, 3].includes(d)) {
        showError("Select 1, 2 or 3 darts");
        return;
      }
      confirmCheckout(d);
    });
  }

  // Winner modal button
  const winnerNewGameBtn = document.getElementById("winnerNewGameBtn");
  if (winnerNewGameBtn) {
    winnerNewGameBtn.addEventListener("click", continueOrNewMatch);
  }

  const winnerLeaveBtn = document.getElementById("winnerLeaveBtn");
  if (winnerLeaveBtn) {
    winnerLeaveBtn.addEventListener("click", leaveMatch);
  }

  // Confirm New Match modal
  const confirmNewMatchCancelBtn = document.getElementById("confirmNewMatchCancelBtn");
  const confirmNewMatchOkBtn = document.getElementById("confirmNewMatchOkBtn");

  if (confirmNewMatchCancelBtn) {
    confirmNewMatchCancelBtn.addEventListener("click", () => {
      const modal = document.getElementById("confirmNewMatchModal");
      if (modal) modal.classList.add("hidden");
    });
  }

  if (confirmNewMatchOkBtn) {
    confirmNewMatchOkBtn.addEventListener("click", () => {
      const modal = document.getElementById("confirmNewMatchModal");
      if (modal) modal.classList.add("hidden");
      const setup = document.getElementById("setupModal");
      if (setup) setup.classList.remove("hidden");
    });
  }

  // Confirm Restart Match modal
  const confirmRestartCancelBtn = document.getElementById("confirmRestartCancelBtn");
  const confirmRestartOkBtn = document.getElementById("confirmRestartOkBtn");

  if (confirmRestartCancelBtn) {
    confirmRestartCancelBtn.addEventListener("click", () => {
      const modal = document.getElementById("confirmRestartMatchModal");
      if (modal) modal.classList.add("hidden");
    });
  }

  if (confirmRestartOkBtn) {
    confirmRestartOkBtn.addEventListener("click", async () => {
      const modal = document.getElementById("confirmRestartMatchModal");
      if (modal) modal.classList.add("hidden");
      try {
        const res = await restartMatch();
        if (!res?.ok) showError(res?.msg || "Could not restart match.");
      } catch (e) {
        console.error(e);
        showError("Could not restart match.");
      }
    });
  }

  // Theme
  initThemeToggle();

  // Error modal
  const errorOkBtn = document.getElementById("errorOkBtn");
  if (errorOkBtn) errorOkBtn.addEventListener("click", hideError);

  // Bull throw UI
  initBullUI();
  wireProfileModalClose();

  // Player profile modal (click player name) — only if that player is logged in
  const p1NameEl = document.getElementById("p1Name");
  const p2NameEl = document.getElementById("p2Name");

  const wireProfileClick = (idx, el) => {
    if (!el) return;
    el.addEventListener("click", (e) => {
      const st = app.latestState;
      // Online games only, and viewer must be logged in (guests can't browse profiles)
      const online = st?.match?.gameType === "online";
      const viewerAuthed = !!(app.user && !app.user.isAnonymous);
      if (!online || !viewerAuthed) return;

      const uid = st?.match?.players?.[idx]?.uid;
      if (!uid) return; // guests: don't open profile

      e.preventDefault();
      e.stopPropagation();
      openProfileForPlayer(idx);
      try { el.blur(); } catch {}
    });
  };

  wireProfileClick(0, p1NameEl);
  wireProfileClick(1, p2NameEl);

  // Input mode toggle (if you still use it)
  if (inputModeBtn) {
    inputModeBtn.addEventListener("click", () => {
      // your existing toggle logic lives elsewhere; keep this as-is if already implemented
      // (leaving intentionally blank here to avoid changing behaviour)
    });
  }
}

export function wireGlobalKeyboard() {
  const scoreInputEl = document.getElementById("scoreInput");
  if (!scoreInputEl) return;

  window.addEventListener("keydown", (e) => {
    if (document.hidden) return;
    if (isAnyModalOpen()) return;
    if (!canScoreNow(app.latestState)) return;

    // Don't steal keys when user is typing in another input/select
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    // Digits
    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      scoreInputEl.value = (scoreInputEl.value + e.key).slice(0, 3);
      return;
    }

    // Backspace
    if (e.key === "Backspace") {
      e.preventDefault();
      scoreInputEl.value = scoreInputEl.value.slice(0, -1);
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
