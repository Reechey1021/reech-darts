// app/ui/events.js
import { app } from "../state.js";
import { unlockAudioOnce } from "../audio/audio.js";
import { canScoreNow, canUndoNow } from "../permissions.js";
import { setInputMode, clearDarts, setMult, updateDartUI, multFactor, pushDart, popDart } from "../input/dartpad.js";
import {
  openNewGameFlow,
  submitScore,
  undoLast,
  startMatchFromSetup,
  cancelCheckout,
  confirmCheckout,
  continueOrNewMatch,
  createNewGameAndShowInvite,
  abortBullThrow,
} from "../actions.js";
import {
  setWinnerModalVisible,
  setSetupModalVisible,
  setCheckoutModalVisible,
  setConfirmNewMatchModalVisible,
  setInviteModalVisible,
  initThemeToggle,
} from "./render.js";
import { initBullUIHandlers } from "../bull/ui.js";
import { signInWithGoogle } from "../auth.js";

const googleLoginBtn = document.getElementById("googleLoginBtn");
if (googleLoginBtn) {
  googleLoginBtn.addEventListener("click", async () => {
    try {
      await signInWithGoogle();
    } catch (e) {
      console.error(e);
      // optional showError("Login failed");
    }
  });
}

// Prevent "Uncaught (in promise)" spam - surface a friendly toast instead.
const safe = (fn) => (...args) =>
  Promise.resolve(fn(...args)).catch((err) => {
    console.error(err);
    showError("Something went wrong (see console)");
  });

function isAnyModalOpen() {
  const ids = ["winnerModal", "setupModal", "checkoutModal", "confirmNewMatchModal", "inviteModal", "bullModal", "lobbyGateModal"];
  return ids.some((id) => {
    const el = document.getElementById(id);
    return el && !el.classList.contains("hidden");
  });
}

export function wireUI() {
  // Init input mode
  setInputMode(app.inputMode);
  setMult(app.dartMult);
  updateDartUI();

  // Unlock audio (iOS)
  document.addEventListener("click", unlockAudioOnce, { once: true });
  document.addEventListener("touchstart", unlockAudioOnce, { once: true });

  // Buttons
  const newGameBtn = document.getElementById("newGameBtn");
  const submitBtn = document.getElementById("submitBtn");
  const undoBtn = document.getElementById("undoBtn");
  const overlayUndoBtn = document.getElementById("overlayUndoBtn");

  if (newGameBtn) newGameBtn.addEventListener("click", safe(openNewGameFlow));
  if (submitBtn) submitBtn.addEventListener("click", safe(submitScore));
  if (undoBtn) undoBtn.addEventListener("click", safe(undoLast));
  if (overlayUndoBtn) {
    overlayUndoBtn.addEventListener("click", () => {
      if (!canUndoNow(app.latestState)) return;
      undoLast();
    });
  }

  // Create lobby gate
  const createLobbyBtn = document.getElementById("createLobbyBtn");
  if (createLobbyBtn) createLobbyBtn.addEventListener("click", safe(createNewGameAndShowInvite));

  // Invite modal controls
  const inviteBtn = document.getElementById("inviteBtn");
  const copyInviteBtn = document.getElementById("copyInviteBtn");
  const closeInviteBtn = document.getElementById("closeInviteBtn");
  if (inviteBtn) inviteBtn.addEventListener("click", safe(createNewGameAndShowInvite));
  if (copyInviteBtn) {
    copyInviteBtn.addEventListener("click", async () => {
      const text = document.getElementById("inviteLinkText")?.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
      } catch {}
    });
  }
  if (closeInviteBtn) closeInviteBtn.addEventListener("click", () => setInviteModalVisible(false));

  // Mobile menu buttons
  const mobileNewGameBtn = document.getElementById("mobileNewGameBtn");
  const mobileInviteBtn = document.getElementById("mobileInviteBtn");
  const mobileMenu = document.getElementById("mobileMenu");

  if (mobileNewGameBtn) {
    mobileNewGameBtn.addEventListener("click", () => {
      if (mobileMenu) mobileMenu.removeAttribute("open");
      openNewGameFlow();
    });
  }
  if (mobileInviteBtn) {
    mobileInviteBtn.addEventListener("click", () => {
      if (mobileMenu) mobileMenu.removeAttribute("open");
      createNewGameAndShowInvite();
    });
  }
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("mobileMenu");
    if (!menu) return;
    if (!menu.hasAttribute("open")) return;
    if (!menu.contains(e.target)) menu.removeAttribute("open");
  });

  // Setup modal buttons
  const setupCancelBtn = document.getElementById("setupCancelBtn");
  const setupStartBtn = document.getElementById("setupStartBtn");
  if (setupCancelBtn) setupCancelBtn.addEventListener("click", () => setSetupModalVisible(false));
  if (setupStartBtn) setupStartBtn.addEventListener("click", startMatchFromSetup);

  // Confirm new match modal
  const confirmNewMatchCancelBtn = document.getElementById("confirmNewMatchCancelBtn");
  const confirmNewMatchOkBtn = document.getElementById("confirmNewMatchOkBtn");
  if (confirmNewMatchCancelBtn) confirmNewMatchCancelBtn.addEventListener("click", () => setConfirmNewMatchModalVisible(false));
  if (confirmNewMatchOkBtn) {
    confirmNewMatchOkBtn.addEventListener("click", () => {
      setConfirmNewMatchModalVisible(false);
      setSetupModalVisible(true);
    });
  }

  // Checkout modal
  const checkoutCancelBtn = document.getElementById("checkoutCancelBtn");
  const checkoutConfirmBtn = document.getElementById("checkoutConfirmBtn");
  const dartsBtns = Array.from(document.querySelectorAll(".dartsBtn"));

  window.__selectedCheckoutDarts = null;
  for (const b of dartsBtns) {
    b.addEventListener("click", () => {
      dartsBtns.forEach((btn) => btn.classList.remove("selected"));
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
      if (![1, 2, 3].includes(d)) return;
      confirmCheckout(d);
    });
  }

  // Winner modal button
  const winnerNewGameBtn = document.getElementById("winnerNewGameBtn");
  if (winnerNewGameBtn) {
    winnerNewGameBtn.addEventListener("click", async () => {
      const snap = await app.gameRef.get();
      const state = snap.data();
      if (!state?.match) return;

      if (state.match.status === "finished") {
        setWinnerModalVisible(false);
        setSetupModalVisible(true);
      } else {
        setWinnerModalVisible(false);
        await continueOrNewMatch();
      }
    });
  }

  // Score input: enter submits; input sanitization
  const scoreInputEl = document.getElementById("scoreInput");
  if (scoreInputEl) {
    scoreInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submitScore();
    });
    scoreInputEl.addEventListener("input", () => {
      scoreInputEl.value = scoreInputEl.value.replace(/\D/g, "").slice(0, 3);
    });
  }

  // Input mode toggle
  const inputModeBtn = document.getElementById("inputModeBtn");
  if (inputModeBtn) {
    inputModeBtn.addEventListener("click", () => {
      const next = app.inputMode === "keypad" ? "table" : "keypad";
      setInputMode(next);
    });
  }

  // Dartpad click handler (table mode)
  const dartPad = document.getElementById("dartPad");
  if (dartPad) {
    dartPad.addEventListener("click", (e) => {
      if (app.inputMode !== "table") return;
      if (!canScoreNow(app.latestState)) return;

      const btn = e.target.closest("button");
      if (!btn) return;

      const m = btn.getAttribute("data-mult");
      if (m) {
        setMult(m);
        return;
      }

      const instant = btn.getAttribute("data-instant");
      if (instant) {
        pushDart(Number(instant));
        return;
      }

      const num = btn.getAttribute("data-num");
      if (num) {
        const v = Number(num);
        pushDart(v * multFactor(app.dartMult));
        return;
      }

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

  // Keypad click handler (keypad mode)
  const keypad = document.getElementById("keypad");
  const clearBtn = document.getElementById("keyClear");
  const backBtn = document.getElementById("keyBack");

  if (keypad && scoreInputEl) {
    keypad.addEventListener("click", (e) => {
      if (!canScoreNow(app.latestState)) return;
      if (app.inputMode !== "keypad") return;

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
      if (!canScoreNow(app.latestState)) return;
      if (app.inputMode !== "keypad") return;
      scoreInputEl.value = "";
    });
  }
  if (backBtn && scoreInputEl) {
    backBtn.addEventListener("click", () => {
      if (!canScoreNow(app.latestState)) return;
      if (app.inputMode !== "keypad") return;
      scoreInputEl.value = scoreInputEl.value.slice(0, -1);
    });
  }

  // Bull throw UI handlers (board click + confirm + reset)
  initBullUIHandlers();

  // Abort bull
  const abortBullBtn = document.getElementById("abortBullBtn");
  if (abortBullBtn) abortBullBtn.addEventListener("click", abortBullThrow);

  // Initial modal state (same as before)
  setWinnerModalVisible(false);
  setSetupModalVisible(false);
  setCheckoutModalVisible(false);
  setConfirmNewMatchModalVisible(false);
  setInviteModalVisible(false);

  initThemeToggle();
}

export function wireGlobalKeyboard() {
  const scoreInputEl = document.getElementById("scoreInput");
  if (!scoreInputEl) return;

  window.addEventListener("keydown", (e) => {
    if (document.hidden) return;
    if (isAnyModalOpen()) return;
    if (!canScoreNow(app.latestState)) return;
    if (app.inputMode !== "keypad") return;

    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;

    if (e.key >= "0" && e.key <= "9") {
      e.preventDefault();
      scoreInputEl.value = (scoreInputEl.value + e.key).slice(0, 3);
      return;
    }

    if (e.key === "Backspace") {
      e.preventDefault();
      scoreInputEl.value = scoreInputEl.value.slice(0, -1);
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      submitScore();
    }
  });
}
