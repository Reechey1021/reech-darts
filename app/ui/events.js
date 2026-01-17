// app/ui/events.js
import { app } from "../state.js";
import { canScoreNow, canUndoNow } from "../permissions.js";
import {
  openNewGameFlow,
  submitScore,
  undoLast,
  startMatchFromSetup,
  cancelCheckout,
  confirmCheckout,
  continueOrNewMatch,
  createNewGameAndShowInvite,
} from "../actions.js";
import { applyTheme, initThemeToggle, showError, setInviteModalVisible } from "./render.js";
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


// ---------- Helpers ----------
function isAnyModalOpen() {
  const ids = ["winnerModal", "setupModal", "checkoutModal", "confirmNewMatchModal", "inviteModal", "bullModal"];
  return ids.some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  });
}

// ---------- Wire UI ----------
export function wireUI() {
  // Gate UI
  const guestNameInput = document.getElementById("guestNameInput");
  const createLobbyBtn = document.getElementById("createLobbyBtn");
  const googleLoginBtn = document.getElementById("googleLoginBtn");

  // Profile modal (closes only on this device)
  wireProfileModalClose();

if (createLobbyBtn) {
  createLobbyBtn.addEventListener("click", async () => {
    const name = (guestNameInput?.value || "").trim();

    // ✅ HARD BLOCK if blank
    if (!name) {
      showError("Please enter a display name to continue.");
      return;
    }

    // Save guest display name
    setGuestDisplayName(name);

    // We need an auth uid for Firestore rules + seat-claiming.
    // Guests can use anonymous auth.
    await ensureAnonymousSignIn();

    // Create lobby
    const res = await createNewGameAndShowInvite();

    // ✅ Surface any failure
    if (!res || res.ok !== true) {
      showError("Couldn’t create lobby. Please try again.");
      return;
    }

    // Success: (createNewGameAndShowInvite already opens invite modal)
  });
}

      if (guestNameInput && createLobbyBtn) {
    guestNameInput.addEventListener("input", () => {
      createLobbyBtn.disabled = !(guestNameInput.value || "").trim();
    });
  }


    const closeInviteBtn = document.getElementById("closeInviteBtn");
    const copyInviteBtn = document.getElementById("copyInviteBtn");

    if (closeInviteBtn) {
      closeInviteBtn.addEventListener("click", () => {
        setInviteModalVisible(false);
      });
    }

    if (copyInviteBtn) {
      copyInviteBtn.addEventListener("click", async () => {
        const text = document.getElementById("inviteLinkText")?.textContent || "";
        try { await navigator.clipboard.writeText(text); } catch {}
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
  const newGameBtn = document.getElementById("newGameBtn");
  const inviteBtn = document.getElementById("inviteBtn");
  const submitBtn = document.getElementById("submitBtn");
  const undoBtn = document.getElementById("undoBtn");
  const scoreInputEl = document.getElementById("scoreInput");
  const overlayUndoBtn = document.getElementById("overlayUndoBtn");
  const inputModeBtn = document.getElementById("inputModeBtn");
  const mobileNewGameBtn = document.getElementById("mobileNewGameBtn");
  const mobileInviteBtn = document.getElementById("mobileInviteBtn");
  const mobileMenu = document.getElementById("mobileMenu");

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
      if (!canScoreNow(app.latestState)) return;

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
        scoreInputEl.focus?.();
      }
    });
  }

  if (clearBtn && scoreInputEl) {
    clearBtn.addEventListener("click", () => {
      if (app.inputMode !== "keypad") return;
      if (!canScoreNow(app.latestState)) return;

      scoreInputEl.value = "";
      scoreInputEl.focus?.();
    });
  }

  if (backBtn && scoreInputEl) {
    backBtn.addEventListener("click", () => {
      if (app.inputMode !== "keypad") return;
      if (!canScoreNow(app.latestState)) return;

      scoreInputEl.value = scoreInputEl.value.slice(0, -1);
      scoreInputEl.focus?.();
    });
  }

  // If we ever re-enter a game screen with table mode active,
  // make sure UI reflects current dart state
  updateDartUI();

  // Unlock audio on first gesture (iOS-safe)
  document.addEventListener("click", unlockAudioOnce, { once: true });
  document.addEventListener("touchstart", unlockAudioOnce, { once: true });

  // New Game / Invite
  if (newGameBtn) newGameBtn.addEventListener("click", openNewGameFlow);

  if (inviteBtn) {
    inviteBtn.addEventListener("click", async () => {
      try {
        const res = await createNewGameAndShowInvite();
        if (!res?.ok) showError(res?.msg || "Could not create lobby.");
      } catch (e) {
        console.error(e);
        showError("Could not create lobby.");
      }
    });
  }

  // Mobile menu buttons
  if (mobileNewGameBtn) {
    mobileNewGameBtn.addEventListener("click", () => {
      if (mobileMenu) mobileMenu.removeAttribute("open");
      openNewGameFlow();
    });
  }

  if (mobileInviteBtn) {
    mobileInviteBtn.addEventListener("click", async () => {
      if (mobileMenu) mobileMenu.removeAttribute("open");
      try {
        const res = await createNewGameAndShowInvite();
        if (!res?.ok) showError(res?.msg || "Could not create lobby.");
      } catch (e) {
        console.error(e);
        showError("Could not create lobby.");
      }
    });
  }

  // Close mobile menu if click outside
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("mobileMenu");
    if (!menu) return;
    if (!menu.hasAttribute("open")) return;
    if (!menu.contains(e.target)) menu.removeAttribute("open");
  });

  // Submit/Undo
  if (submitBtn) submitBtn.addEventListener("click", submitScore);
  if (undoBtn) undoBtn.addEventListener("click", undoLast);

  // Overlay undo (allowed even when not your turn in online mode)
  if (overlayUndoBtn) {
    overlayUndoBtn.addEventListener("click", () => {
      if (!canUndoNow(app.latestState)) return;
      undoLast();
    });
  }

  // Keyboard: Enter submits (input box)
  if (scoreInputEl) {
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

  // Theme
  initThemeToggle();

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
      const uid = st?.match?.players?.[idx]?.uid;
      if (!uid) return; // guests: don't open profile

      e.preventDefault();
      e.stopPropagation();
      openProfileForPlayer(st, idx);
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
