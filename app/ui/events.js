// app/ui/events.js
import { app } from "../state.js";
import { withBase } from "../routing.js";
import { canScoreNow, canUndoNow, isHost, mySeatIndex } from "../permissions.js";
import {
  openNewGameFlow,
  submitScore,
  undoLast,
  startMatchFromSetup,
  startMatchFromNemesisSetup,
  cancelCheckout,
  confirmCheckout,
  continueOrNewMatch,
  createNewGameAndShowInvite,
  createLocalGameAndOpenSetup,
  leaveMatch,
  restartMatch,
  prepareGhostFromWinnerModalView,
  savePreparedGhostToken,
  toggleReadyRoom,
  cancelReadyRoomBackToSetup,
} from "../actions.js";
import { applyTheme, initThemeToggle, showError, hideError, setInviteModalVisible, setSetupModalVisible, setLobbyGateVisible, openModal, closeModal, render, showSeatJoinToast } from "./render.js";
import { unlockAudioOnce } from "../audio/audio.js";
import { initBullUI } from "../bull/ui.js";
import { initAuditChatUI, isAuditChatInputFocused, addAuditSystem } from "./auditChat.js";
import { signInWithGoogle, ensureAnonymousSignIn } from "../auth.js";
import { setGuestDisplayName } from "../profile.js";
import { openProfileModalForPlayerIndex as openProfileForPlayer } from "./profileModal.js";
import { initProfileModalUI as wireProfileModalClose } from "./profileModal.js";
import { sendGameInvite } from "../friends.js";
import {
  setInputMode,
  setMult,
  multFactor,
  pushDart,
  popDart,
  clearDarts,
  updateDartUI,
} from "../input/dartpad.js";
import { initVoiceUI, stopVoice, startVoiceAuto } from "../input/voice.js";

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

  // Host-left modal
  const hostLeftLeaveBtn = document.getElementById("hostLeftLeaveBtn");
  if (hostLeftLeaveBtn) {
    hostLeftLeaveBtn.addEventListener("click", async () => {
      try {
        await leaveMatch();
      } catch (_) {
        // ignore
      }
    });
  }

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

  // joinGameCloseBtn is wired later using closeModal(joinGameModal) so it animates.

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

      // Open the join modal (animated)
      const modal = document.getElementById("joinGameModal");
      if (modal) openModal(modal);
    });
  }

  // Join modal cancel should work (return to gate)
  if (joinGameCancelBtn) {
    joinGameCancelBtn.addEventListener("click", (e) => {
      e.preventDefault();
      if (joinGameModal) closeModal(joinGameModal);
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
      if (joinGameModal) openModal(joinGameModal);
      try { joinGameLink?.focus(); } catch { }
    });
  }

  if (joinGameCloseBtn && joinGameModal) {
    joinGameCloseBtn.addEventListener("click", () => closeModal(joinGameModal));
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
      // Prefer pretty URLs: /game/<id>
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[0] === "game") {
        gameId = (parts[1] || "").trim() || null;
      }
      // Back-compat: ?game=<id>
      if (!gameId) {
        gameId = (url.searchParams.get("game") || "").trim() || null;
      }
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
    window.location.href = withBase(`/game/?game=${encodeURIComponent(gameId)}`);
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
      try {
        await navigator.clipboard.writeText(text);
        const old = copyInviteBtn.innerText;
        copyInviteBtn.innerText = "Copied ✓";
        copyInviteBtn.disabled = true;
        setTimeout(() => {
          copyInviteBtn.innerText = old;
          copyInviteBtn.disabled = false;
        }, 1200);
      } catch (_) {
        // Fallback: briefly show the existing inline message if present.
        const msg = document.getElementById("inviteCopyMsg");
        if (msg) {
          msg.classList.remove("hidden");
          clearTimeout(window.__inviteCopyTimer);
          window.__inviteCopyTimer = setTimeout(() => msg.classList.add("hidden"), 1500);
        }
      }
    });
  }

  // ----------------------------
  // Ready Room: Invite Friends (Classic /game/ runtime)
  // ----------------------------
  const inviteFriendsModal = document.getElementById("inviteFriendsModal");
  const inviteFriendsList = document.getElementById("inviteFriendsList");
  const inviteFriendsEmpty = document.getElementById("inviteFriendsEmpty");
  const inviteFriendsCloseBtn = document.getElementById("inviteFriendsCloseBtn");

  const openInviteFriendsModal = async () => {
    if (!inviteFriendsModal) return;
    if (inviteFriendsList) inviteFriendsList.innerHTML = "";
    if (inviteFriendsEmpty) {
      inviteFriendsEmpty.textContent = "No friends yet.";
      inviteFriendsEmpty.classList.add("hidden");
    }

    const uid = (app.user && !app.user.isAnonymous) ? app.user.uid : null;
    if (!uid || !app.db) {
      if (inviteFriendsEmpty) {
        inviteFriendsEmpty.textContent = "Sign in to invite friends.";
        inviteFriendsEmpty.classList.remove("hidden");
      }
      openModal(inviteFriendsModal);
      return;
    }

    try {
      const snap = await app.db.collection("users").doc(uid).collection("friends").get();
      const rows = [];
      snap.forEach((doc) => {
        const f = doc.data() || {};
        rows.push({
          uid: doc.id,
          name: f.name || f.displayName || f.username || f.handle || "Friend",
          photoURL: f.photoURL || f.photoUrl || null,
        });
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
              <div class="readyDIwrapper">
                ${img}
                <div>
                  <div class="dashName" style="font-size:20px;">${f.name}</div>
                </div>
              </div>
              <button class="actionBtn autowidth" type="button" data-invite-uid="${f.uid}">Invite</button>
            </div>
          `;
        }).join("");
      }
    } catch (err) {
      console.error(err);
      if (inviteFriendsEmpty) {
        inviteFriendsEmpty.textContent = "Could not load friends.";
        inviteFriendsEmpty.classList.remove("hidden");
      }
    }

    openModal(inviteFriendsModal);
  };

  if (inviteFriendsCloseBtn && inviteFriendsModal) {
    inviteFriendsCloseBtn.addEventListener("click", () => closeModal(inviteFriendsModal));
  }

  if (inviteFriendsList) {
    inviteFriendsList.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button[data-invite-uid]") : null;
      if (!btn) return;
      const toUid = btn.getAttribute("data-invite-uid") || "";
      const fromUid = (app.user && !app.user.isAnonymous) ? app.user.uid : null;
      if (!toUid || !fromUid || !app.db || !app.gameId) return;

      const fromName = (app.user.displayName || app.user.email || "Player");
      const fromPhotoURL = (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null;

      (async () => {
        try {
          btn.disabled = true;
          await sendGameInvite(app.db, fromUid, toUid, app.gameId, { fromName, fromPhotoURL, mode: "classic" });
          btn.textContent = "Invited";
        } catch (err) {
          console.error(err);
          showError(err?.message || String(err));
          btn.disabled = false;
        }
      })();
    });
  }

  // Seat2 placeholder proxies ("+" opens invite friends; "Copy Link" copies direct invite URL)
  try {
    const rr = document.getElementById("readyRoomModal");
    if (rr) {
      const copyLink = async () => {
        if (!app.gameId) return;
        const url = new URL(window.location.href);
        url.searchParams.set("game", app.gameId);
        url.searchParams.delete("openInvite");
        url.searchParams.delete("autoSetup");
        url.searchParams.delete("setup");
        try {
          await navigator.clipboard.writeText(url.toString());
        } catch (_) {
          // fallback
          try {
            const ta = document.createElement("textarea");
            ta.value = url.toString();
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.focus();
            ta.select();
            document.execCommand("copy");
            document.body.removeChild(ta);
          } catch (_) {}
        }
      };

      rr.addEventListener("click", (e) => {
        const inv = e.target && e.target.closest ? e.target.closest('[data-role="readyInviteFriendsProxy"]') : null;
        if (inv) {
          e.preventDefault();
          openInviteFriendsModal();
          return;
        }
        const cpy = e.target && e.target.closest ? e.target.closest('[data-role="readyCopyInviteProxy"]') : null;
        if (cpy) {
          e.preventDefault();
          try {
            const orig = (cpy.dataset && cpy.dataset.origText) ? cpy.dataset.origText : (cpy.textContent || "Copy Link");
            if (cpy.dataset && !cpy.dataset.origText) cpy.dataset.origText = orig;
            cpy.textContent = "Copied";
            if (cpy.__copiedTimer) clearTimeout(cpy.__copiedTimer);
            cpy.__copiedTimer = setTimeout(() => {
              try { cpy.textContent = (cpy.dataset && cpy.dataset.origText) ? cpy.dataset.origText : "Copy Link"; } catch (_) {}
            }, 1200);
          } catch (_) {}
          copyLink();
        }
      });

      rr.addEventListener("keydown", (e) => {
        if (!(e.key === "Enter" || e.key === " ")) return;
        const inv = e.target && e.target.closest ? e.target.closest('[data-role="readyInviteFriendsProxy"]') : null;
        if (inv) {
          e.preventDefault();
          openInviteFriendsModal();
          return;
        }
        const cpy = e.target && e.target.closest ? e.target.closest('[data-role="readyCopyInviteProxy"]') : null;
        if (cpy) {
          e.preventDefault();
          try {
            const orig = (cpy.dataset && cpy.dataset.origText) ? cpy.dataset.origText : (cpy.textContent || "Copy Link");
            if (cpy.dataset && !cpy.dataset.origText) cpy.dataset.origText = orig;
            cpy.textContent = "Copied";
            if (cpy.__copiedTimer) clearTimeout(cpy.__copiedTimer);
            cpy.__copiedTimer = setTimeout(() => {
              try { cpy.textContent = (cpy.dataset && cpy.dataset.origText) ? cpy.dataset.origText : "Copy Link"; } catch (_) {}
            }, 1200);
          } catch (_) {}
          copyLink();
        }
      });
    }
  } catch (_) {}


  // Google login
  if (googleLoginBtn) {
    googleLoginBtn.addEventListener("click", async () => {
      try {
        await signInWithGoogle();
        // Go to dashboard for logged-in users.
        window.location.href = withBase("/dashboard");
      } catch (e) {
        console.error(e);
        showError("Google login failed.");
      }
    });
  }

  // Main UI refs
  const gameSettingsBtn = document.getElementById("gameSettingsBtn");
  const leaveMatchBtn = document.getElementById("leaveMatchBtn");
  const readyRoomReadyBtn = document.getElementById("readyRoomReadyBtn");
  const readyRoomLeaveBtn = document.getElementById("readyRoomLeaveBtn");

  // Confirm Leave modal
  const confirmLeaveMatchModal = document.getElementById("confirmLeaveMatchModal");
  const confirmLeaveCancelBtn = document.getElementById("confirmLeaveCancelBtn");
  const confirmLeaveOkBtn = document.getElementById("confirmLeaveOkBtn");
  const gameSettingsModal = document.getElementById("gameSettingsModal");
  const gsNewGameBtn = document.getElementById("gsNewGameBtn");
  const gsRestartBtn = document.getElementById("gsRestartGameBtn");
  const gsLeaveBtn = document.getElementById("gsLeaveMatchBtn");
  const gsCloseBtn = document.getElementById("gsCloseBtn");
  const abortBullBtn = document.getElementById("abortBullBtn");

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
  const inputModePicker = document.getElementById("inputModePicker");
  const pickKeypadModeBtn = document.getElementById("pickKeypadModeBtn");
  const pickTableModeBtn = document.getElementById("pickTableModeBtn");
  const pickVoiceModeBtn = document.getElementById("pickVoiceModeBtn");
  // Legacy mobile menu refs (no longer used)

  // ----------------------------
  // Input mode init + toggle
  // ----------------------------
  // Always start in keypad mode on page load.
  try {
    app.inputMode = "keypad";
    localStorage.setItem("inputMode", "keypad");
  } catch (_) {}
  setInputMode("keypad");

  // Voice UI init (safe no-op if unsupported)
  initVoiceUI();

  function updateInputModePickerSelection() {
    if (!inputModePicker) return;
    const setSel = (el, on) => el && el.classList.toggle("selected", !!on);
    setSel(pickKeypadModeBtn, app.inputMode === "keypad");
    setSel(pickTableModeBtn, app.inputMode === "table");
    setSel(pickVoiceModeBtn, app.inputMode === "voice");
  }

  function closeInputModePicker() {
    if (!inputModePicker) return;
    inputModePicker.classList.add("hidden");
  }

  function toggleInputModePicker() {
    if (!inputModePicker) return;
    const willOpen = inputModePicker.classList.contains("hidden");
    if (willOpen) {
      updateInputModePickerSelection();
      inputModePicker.classList.remove("hidden");
    } else {
      closeInputModePicker();
    }
  }

  function pickInputMode(next) {
    closeInputModePicker();

    // Leaving voice mode? Ensure we stop any active recognition.
    if (app.inputMode === "voice" && next !== "voice") {
      stopVoice();
    }

    setInputMode(next);
    updateInputModePickerSelection();

    if (next === "voice") {
      // Auto-start listening when entering voice mode (runs inside this click gesture).
      startVoiceAuto();
    }
  }

  updateInputModePickerSelection();

  if (inputModeBtn) {
    inputModeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      toggleInputModePicker();
    });
  }

  if (pickKeypadModeBtn) pickKeypadModeBtn.addEventListener("click", () => pickInputMode("keypad"));
  if (pickTableModeBtn) pickTableModeBtn.addEventListener("click", () => pickInputMode("table"));
  if (pickVoiceModeBtn) pickVoiceModeBtn.addEventListener("click", () => pickInputMode("voice"));

  // Close picker on outside click / Escape.
  document.addEventListener("pointerdown", (e) => {
    if (!inputModePicker || inputModePicker.classList.contains("hidden")) return;
    if (inputModePicker.contains(e.target)) return;
    if (inputModeBtn && inputModeBtn.contains(e.target)) return;
    closeInputModePicker();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!inputModePicker || inputModePicker.classList.contains("hidden")) return;
    closeInputModePicker();
  });

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
  // Handicap-aware score input: keep a raw numeric buffer and display "raw → effective"
  const st = app.latestState;
  const p = st?.leg?.currentPlayer ?? 0;
  const mult = Number(st?.match?.handicaps?.["p" + p]?.multiplier ?? 1);
  const usePreview = Number.isFinite(mult) && Math.abs(mult - 1) > 1e-9;

  if (usePreview) {
    const raw = String(app.__rawScoreInput || "");
    const nextRaw = (raw + digit).slice(0, 3);
    app.__rawScoreInput = nextRaw;
    const rawNum = Number(nextRaw || 0);
    const effective = Math.round(rawNum * mult);
    scoreInputEl.value = nextRaw ? `${nextRaw} → ${effective}` : "";
  } else {
    // Normal behaviour
    scoreInputEl.value = (scoreInputEl.value + digit).slice(0, 3);
  }
}

    });
  }

  if (clearBtn && scoreInputEl) {
    clearBtn.addEventListener("click", () => {
      if (app.inputMode !== "keypad") return;
      if (!canScoreNow(app.latestState)) return;

      app.__rawScoreInput = "";
      scoreInputEl.value = "";
    });
  }

  if (backBtn && scoreInputEl) {
    backBtn.addEventListener("click", () => {
      if (app.inputMode !== "keypad") return;
      if (!canScoreNow(app.latestState)) return;

      const st = app.latestState;
const p = st?.leg?.currentPlayer ?? 0;
const mult = Number(st?.match?.handicaps?.["p" + p]?.multiplier ?? 1);
const usePreview = Number.isFinite(mult) && Math.abs(mult - 1) > 1e-9;

if (usePreview) {
  const raw = String(app.__rawScoreInput || "");
  const nextRaw = raw.slice(0, -1);
  app.__rawScoreInput = nextRaw;
  const rawNum = Number(nextRaw || 0);
  const effective = Math.round(rawNum * mult);
  scoreInputEl.value = nextRaw ? `${nextRaw} → ${effective}` : "";
} else {
  scoreInputEl.value = scoreInputEl.value.slice(0, -1);
}

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
    if (!gameSettingsModal) return;

    // Role-based menu: host gets full settings; non-host gets Chat/Audits + Leave only
    const st = app.latestState;
    const host = isHost(st);

    if (gsNewGameBtn) gsNewGameBtn.classList.toggle("hidden", !host);
    if (gsRestartBtn) gsRestartBtn.classList.toggle("hidden", !host);

    // Open Chat/Audits always available
    const gsOpenAuditChatBtn = document.getElementById("gsOpenAuditChatBtn");
    if (gsOpenAuditChatBtn) gsOpenAuditChatBtn.classList.toggle("hidden", false);

    if (gsLeaveBtn) gsLeaveBtn.classList.toggle("hidden", false);

    openModal(gameSettingsModal);
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

  // Bull throw: Abort game (uses the same leave confirmation + leave logic)
  if (abortBullBtn) {
    abortBullBtn.addEventListener("click", (e) => {
      e.preventDefault();
      confirmLeaveMatch();
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

  // Ready Room (online pre-game)
  if (readyRoomReadyBtn) {
    readyRoomReadyBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      await toggleReadyRoom();
    });
  }

  if (readyRoomLeaveBtn) {
    readyRoomLeaveBtn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const st = app.latestState;
      const host = isHost(st);

      if (host) {
        await cancelReadyRoomBackToSetup();
        setSetupModalVisible(true);
      } else {
        await leaveMatch();
      }
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
        if (app.inputMode === "voice") stopVoice();
        setInputMode("keypad");
        clearDarts();
        updateDartUI();
      }

      // Handicap multiplier: submitScore() will apply multiplier after submission.
      // For Quick Checkout we want the EFFECTIVE score to equal the remaining score,
      // so we inject a raw value that rounds to the target after multiplication.
      let rawToEnter = remaining;
      try {
        const h = state?.match?.handicaps;
        const ph = (h && h.enabled === true) ? (h["p" + p] || {}) : null;
        const mult = Number(ph?.multiplier ?? 1);
        const useMult = Number.isFinite(mult) && mult > 0 && Math.abs(mult - 1) > 1e-9;
        if (useMult) {
          const target = remaining;
          let cand = Math.round(target / mult);
          cand = Math.max(0, Math.min(180, cand));
          const eff = (x) => Math.round(Number(x) * mult);
          if (eff(cand) !== target) {
            for (const d of [1,-1,2,-2,3,-3,4,-4,5,-5,6,-6,7,-7,8,-8,9,-9,10,-10]) {
              const c2 = Math.max(0, Math.min(180, cand + d));
              if (eff(c2) === target) { cand = c2; break; }
            }
          }
          rawToEnter = cand;
        }
      } catch (_) {}

      try { app.__rawScoreInput = ""; } catch (_) {}
      if (scoreInputEl) scoreInputEl.value = String(rawToEnter);
      submitScore();
    });
  }
  async function undoWithAudit() {
    if (!canUndoNow(app.latestState)) return;
    await undoLast();

    // Write a local, centered system line into the combined Chat & Audits feed.
    try {
      const s = app.latestState;
      let seat = mySeatIndex(s);
      if (seat === null || seat === undefined) {
        // Local/offline games do not have actor IDs; default to Player 1.
        seat = 0;
      }
      const name = s?.match?.players?.[seat]?.name || (seat === 0 ? "Player 1" : "Player 2");
      addAuditSystem(`${name} performed action: Undo.`);
    } catch (_) {}
  }

  if (undoBtn) undoBtn.addEventListener("click", undoWithAudit);

  // Overlay undo (allowed even when not your turn in online mode)
  if (overlayUndoBtn) {
    overlayUndoBtn.addEventListener("click", () => {
      undoWithAudit();
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
    if (modal) closeModal(modal);
  });


  
// Nemesis match setup modal buttons (used when clicking "New Game" during a Nemesis match)
const nemesisSetupBackBtn = document.getElementById("nemesisSetupBackBtn");
const nemesisSetupStartBtn = document.getElementById("nemesisSetupStartBtn");

if (nemesisSetupBackBtn) nemesisSetupBackBtn.addEventListener("click", () => {
  const modal = document.getElementById("nemesisMatchSetupModal");
  if (modal) closeModal(modal);
});

if (nemesisSetupStartBtn) nemesisSetupStartBtn.addEventListener("click", () => {
  startMatchFromNemesisSetup();
});

// Setup modal controls (button-driven UI with hidden canonical form controls)
  const setupPresetEl = document.getElementById("setupPreset");
  const setupCheckInEl = document.getElementById("setupCheckIn");
  const setupCheckOutEl = document.getElementById("setupCheckOut");
  const setupCompetitionEl = document.getElementById("setupCompetition");
  const setupAllowMutualControlEl = document.getElementById("setupAllowMutualControl");
  const setupTrackCheckoutStatsEl = document.getElementById("setupTrackCheckoutStats");
  const setupHandicapsBtn = document.getElementById("setupHandicapsBtn");
  let setupHandicapsBtnWrap = null;
  if (setupHandicapsBtn && !setupHandicapsBtn.parentElement?.classList?.contains("tooltipWrap")) {
    // Disabled buttons don't show title tooltips reliably; wrap in a span so hover works.
    const wrap = document.createElement("span");
    wrap.className = "tooltipWrap";
    wrap.style.display = "inline-block";
    setupHandicapsBtn.parentNode.insertBefore(wrap, setupHandicapsBtn);
    wrap.appendChild(setupHandicapsBtn);
    setupHandicapsBtnWrap = wrap;
  } else if (setupHandicapsBtn) {
    setupHandicapsBtnWrap = setupHandicapsBtn.parentElement;
  }

  const setupHandicapsBadge = document.getElementById("setupHandicapsBadge");
  const setupModalEl = document.getElementById("setupModal");
  const handicapModal = document.getElementById("handicapModal");
  const hcpCancelBtn = document.getElementById("hcpCancelBtn");
  const hcpSaveBtn = document.getElementById("hcpSaveBtn");
  const hcpResetBtn = document.getElementById("hcpResetBtn");
  const hcpErrorEl = document.getElementById("hcpError");
  const hcpP1NameEl = document.getElementById("hcpP1Name");
  const hcpP2NameEl = document.getElementById("hcpP2Name");

  const setupCheckInFieldEl = document.getElementById("setupCheckInField");
  const setupCheckOutFieldEl = document.getElementById("setupCheckOutField");
  const setupMutualControlFieldEl = document.getElementById("setupMutualControlField");

  const setupBtnRows = Array.from(document.querySelectorAll(".setupBtnRow[data-setup-group]"));
  const setupToggleRows = Array.from(document.querySelectorAll(".setupBtnRow[data-setup-toggle]"));
  const helpIcons = Array.from(document.querySelectorAll(".helpIcon[data-tip]"));


// Stepper controls (Score / Legs): UI steppers synced to hidden canonical <select>s
const setupSteppers = Array.from(document.querySelectorAll("[data-setup-stepper][data-target]"));

const syncStepperFromControl = (targetId) => {
  const stepper = document.querySelector(`[data-setup-stepper][data-target="${targetId}"]`);
  const ctrl = document.getElementById(targetId);
  if (!stepper || !ctrl) return;

  const values = String(stepper.getAttribute("data-values") || "")
    .split(",")
    .map((x) => String(x).trim())
    .filter(Boolean);

  const cur = String(ctrl.value);
  const idx = Math.max(0, values.indexOf(cur));
  const display = stepper.querySelector("[data-stepper-value]");
  if (display) display.textContent = values[idx] || cur || "—";

  const decBtn = stepper.querySelector('.setupStepBtn[data-step="dec"]');
  const incBtn = stepper.querySelector('.setupStepBtn[data-step="inc"]');
  if (decBtn) decBtn.classList.toggle("isDisabled", idx <= 0);
  if (incBtn) incBtn.classList.toggle("isDisabled", idx >= values.length - 1);
};

for (const stepper of setupSteppers) {
  const targetId = stepper.getAttribute("data-target");
  if (!targetId) continue;
  const ctrl = document.getElementById(targetId);
  if (!ctrl) continue;

  const values = String(stepper.getAttribute("data-values") || "")
    .split(",")
    .map((x) => String(x).trim())
    .filter(Boolean);

  const setByIndex = (i) => {
    if (!values.length) return;
    const idx = Math.max(0, Math.min(values.length - 1, i));
    ctrl.value = values[idx];
    ctrl.dispatchEvent(new Event("change", { bubbles: true }));
    syncStepperFromControl(targetId);
  };

  const decBtn = stepper.querySelector('.setupStepBtn[data-step="dec"]');
  const incBtn = stepper.querySelector('.setupStepBtn[data-step="inc"]');

  if (decBtn) {
    decBtn.addEventListener("click", () => {
      const cur = String(ctrl.value);
      const idx = values.indexOf(cur);
      setByIndex((idx >= 0 ? idx : 0) - 1);
    });
  }
  if (incBtn) {
    incBtn.addEventListener("click", () => {
      const cur = String(ctrl.value);
      const idx = values.indexOf(cur);
      setByIndex((idx >= 0 ? idx : 0) + 1);
    });
  }

  // Keep display in sync with the canonical control
  ctrl.addEventListener("change", () => syncStepperFromControl(targetId));

  // Initialize
  syncStepperFromControl(targetId);
}

  const syncGroupFromControl = (targetId) => {
    const ctrl = document.getElementById(targetId);
    if (!ctrl) return;
    const row = document.querySelector(`.setupBtnRow[data-setup-group][data-target="${targetId}"]`);
    if (!row) return;
    const val = String(ctrl.value);
    Array.from(row.querySelectorAll(".setupBtn")).forEach((b) => {
      b.classList.toggle("selected", String(b.getAttribute("data-value")) === val);
    });
  };

  const syncToggleFromControl = (targetId) => {
    const ctrl = document.getElementById(targetId);
    if (!ctrl || ctrl.type !== "checkbox") return;
    const row = document.querySelector(`.setupBtnRow[data-setup-toggle][data-target="${targetId}"]`);
    if (!row) return;
    const on = !!ctrl.checked;
    Array.from(row.querySelectorAll(".setupBtn")).forEach((b) => {
      const v = String(b.getAttribute("data-value"));
      b.classList.toggle("selected", (v === "on" && on) || (v === "off" && !on));
    });
  };

  const setFieldDisabled = (fieldEl, disabled) => {
    if (!fieldEl) return;
    fieldEl.classList.toggle("isDisabled", !!disabled);
  };

  function applySetupPreset(preset) {
    if (!setupCheckInEl || !setupCheckOutEl) return;

    const setVals = (checkIn, checkOut) => {
      setupCheckInEl.value = checkIn;
      setupCheckOutEl.value = checkOut;
      syncGroupFromControl("setupCheckIn");
      syncGroupFromControl("setupCheckOut");
    };

    if (preset === "custom") {
      setFieldDisabled(setupCheckInFieldEl, false);
      setFieldDisabled(setupCheckOutFieldEl, false);
      return;
    }

    // Non-custom presets: lock check-in/out selectors but keep selected state visible.
    setFieldDisabled(setupCheckInFieldEl, true);
    setFieldDisabled(setupCheckOutFieldEl, true);

    if (preset === "grand_prix") {
      setVals("double", "double");
    } else if (preset === "x01") {
      setVals("straight", "double");
    } else if (preset === "straight_in_out") {
      setVals("straight", "straight");
    } else {
      // Unknown preset: fall back safely
      setVals("straight", "double");
    }
  }

  

// ----------------------------
// Handicaps (setup-only, never persisted)
// ----------------------------
const HANDICAP_STEPS = [0.5, 0.66, 0.75, 0.9, 1.0, 1.1, 1.25, 1.33, 1.5, 1.75, 2.0];

function showHcpError(msg) {
  if (!hcpErrorEl) return;
  hcpErrorEl.textContent = msg || "";
  hcpErrorEl.classList.toggle("hidden", !msg);
}

function getSetupDefaultsForHandicap() {
  const mode = Number(document.getElementById("setupMode")?.value || 501);
  const checkIn = String(document.getElementById("setupCheckIn")?.value || "straight");
  const checkOut = String(document.getElementById("setupCheckOut")?.value || "double");
  return { mode, checkIn, checkOut };
}

function parseMultiplier(v) {
  const n = Number(String(v).replace("x","").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

function setStepperValue(inputId, n) {
  const el = document.getElementById(inputId);
  if (!el) return;
  el.value = String(n);
}

function setSelectValue(id, value) {
  const sel = document.getElementById(id);
  if (!sel) return;
  sel.value = value;
  // update visual button group
  const group = document.querySelector(`.btnGroup[data-control="${id}"]`);
  if (group) {
    Array.from(group.querySelectorAll("button")).forEach(b => {
      b.classList.toggle("selected", String(b.getAttribute("data-value")) === String(value));
    });
  }
}

function readHandicapFromUI(playerIdx) {
  const d = getSetupDefaultsForHandicap();
  const mult = parseMultiplier(document.getElementById(playerIdx === 0 ? "hcpP0Mult" : "hcpP1Mult")?.value);
  const start = Number(document.getElementById(playerIdx === 0 ? "hcpP0Start" : "hcpP1Start")?.value || d.mode);
  const checkIn = String(document.getElementById(playerIdx === 0 ? "hcpP0CheckIn" : "hcpP1CheckIn")?.value || d.checkIn);
  const checkOut = String(document.getElementById(playerIdx === 0 ? "hcpP0CheckOut" : "hcpP1CheckOut")?.value || d.checkOut);
  const finish = String(document.getElementById(playerIdx === 0 ? "hcpP0Finish" : "hcpP1Finish")?.value || "exact");
  return { multiplier: mult ?? 1, startScore: start, checkIn, checkOut, finish };
}

function handicapIsActive() {
  const d = getSetupDefaultsForHandicap();
  const p0 = readHandicapFromUI(0);
  const p1 = readHandicapFromUI(1);

  const isDefault = (p) => {
    const sameStart = Number(p.startScore) === Number(d.mode);
    const sameIn = String(p.checkIn) === String(d.checkIn);
    const sameOut = String(p.checkOut) === String(d.checkOut);
    const sameFinish = String(p.finish) === "exact";
    const sameMult = Math.abs(Number(p.multiplier) - 1) < 1e-9;
    return sameStart && sameIn && sameOut && sameFinish && sameMult;
  };

  return !(isDefault(p0) && isDefault(p1));
}

function applyHandicapBadgeAndDoublesLock() {
  const active = handicapIsActive();
  if (setupHandicapsBadge) setupHandicapsBadge.classList.toggle("hidden", !active);

  // When ANY handicap is active, disable Track doubles / checkout stats in setup
  if (setupTrackCheckoutStatsEl) {
    if (active) {
      setupTrackCheckoutStatsEl.checked = false;
      setupTrackCheckoutStatsEl.disabled = true;
    } else {
      setupTrackCheckoutStatsEl.disabled = false;
    }
    syncToggleFromControl("setupTrackCheckoutStats");
  }
}

function resetHandicapsToDefault() {
  const d = getSetupDefaultsForHandicap();

  setStepperValue("hcpP0Mult", 1);
  setStepperValue("hcpP1Mult", 1);
  try { syncStepperFromControl("hcpP0Mult"); } catch (_) {}
  try { syncStepperFromControl("hcpP1Mult"); } catch (_) {}

  const p0Start = document.getElementById("hcpP0Start");
  const p1Start = document.getElementById("hcpP1Start");
  if (p0Start) p0Start.value = String(d.mode);
  if (p1Start) p1Start.value = String(d.mode);
  try { syncStepperFromControl("hcpP0Start"); } catch (_) {}
  try { syncStepperFromControl("hcpP1Start"); } catch (_) {}

  setSelectValue("hcpP0CheckIn", d.checkIn);
  setSelectValue("hcpP1CheckIn", d.checkIn);
  setSelectValue("hcpP0CheckOut", d.checkOut);
  setSelectValue("hcpP1CheckOut", d.checkOut);

  setSelectValue("hcpP0Finish", "exact");
  setSelectValue("hcpP1Finish", "exact");

  showHcpError("");
  applyHandicapBadgeAndDoublesLock();
}

function openHandicapModal() {
  if (!handicapModal) return;
  // Populate defaults every time setup is opened for a new match.
  if (!app.__handicapsInitialized) {
    resetHandicapsToDefault();
    app.__handicapsInitialized = true;
  } else {
    // Ensure start score tracks current setupMode if no custom overrides were made
    // (keeps it intuitive when user changes 301/501 then opens handicaps)
    const d = getSetupDefaultsForHandicap();
    const p0Start = document.getElementById("hcpP0Start");
    const p1Start = document.getElementById("hcpP1Start");
    if (p0Start && (p0Start.value === "" || Number(p0Start.value) === Number(app.__lastSetupMode || d.mode))) p0Start.value = String(d.mode);
    if (p1Start && (p1Start.value === "" || Number(p1Start.value) === Number(app.__lastSetupMode || d.mode))) p1Start.value = String(d.mode);
    try { syncStepperFromControl("hcpP0Start"); } catch (_) {}
    try { syncStepperFromControl("hcpP1Start"); } catch (_) {}
  }
  openModal(handicapModal);
  showHcpError("");
  applyHandicapBadgeAndDoublesLock();
}

function closeHandicapModal() {
  if (!handicapModal) return;
  closeModal(handicapModal);
  showHcpError("");
}


// When setup modal opens for a new match, handicaps must reset to defaults (never persisted).
if (setupModalEl) {
  setupModalEl.addEventListener("modalopen", () => {
    app.__handicapsInitialized = false;
    resetHandicapsToDefault();

    // Update column headers with latest player names if available
    try {
      const p1 = (document.getElementById("setupP1")?.value || "Player 1").trim() || "Player 1";
      const p2 = (document.getElementById("setupP2")?.value || "Player 2").trim() || "Player 2";
      if (hcpP1NameEl) hcpP1NameEl.textContent = p1;
      if (hcpP2NameEl) hcpP2NameEl.textContent = p2;
    } catch (_) {}
  });
}

  function applyCompetitionRules() {
    if (!setupCompetitionEl || !setupAllowMutualControlEl) return;
    const ranked = String(setupCompetitionEl.value) === "competitive";
    if (setupHandicapsBtn) {
      setupHandicapsBtn.disabled = ranked;
      setupHandicapsBtn.classList.toggle("disabled", ranked);
      // Hover hint only when disabled
      (setupHandicapsBtnWrap || setupHandicapsBtn).title = ranked ? "Unavailable in Ranked mode." : "";
    }
    if (ranked) {
      // Ranked disables handicaps entirely
      resetHandicapsToDefault();
      if (setupHandicapsBadge) setupHandicapsBadge.classList.add("hidden");
      app.__handicapsInitialized = true;
    }
    if (ranked) {
      setupAllowMutualControlEl.value = "no";
      syncGroupFromControl("setupAllowMutualControl");
    }
    setFieldDisabled(setupMutualControlFieldEl, ranked);
  }

  // Wire up button-driven groups to the hidden canonical controls
  for (const row of setupBtnRows) {
    const targetId = row.getAttribute("data-target");
    if (!targetId) continue;
    const ctrl = document.getElementById(targetId);
    if (!ctrl) continue;
    const btns = Array.from(row.querySelectorAll(".setupBtn"));
    for (const b of btns) {
      b.addEventListener("click", () => {
        if (row.closest(".setupField")?.classList.contains("isDisabled")) return;
        const v = String(b.getAttribute("data-value"));
        ctrl.value = v;
        // Keep existing code paths working
        ctrl.dispatchEvent(new Event("change", { bubbles: true }));
        syncGroupFromControl(targetId);
      });
    }
    // Initialize selection
    syncGroupFromControl(targetId);
  }

  for (const row of setupToggleRows) {
    const targetId = row.getAttribute("data-target");
    if (!targetId) continue;
    const ctrl = document.getElementById(targetId);
    if (!ctrl || ctrl.type !== "checkbox") continue;
    const btns = Array.from(row.querySelectorAll(".setupBtn"));
    for (const b of btns) {
      b.addEventListener("click", () => {
        const v = String(b.getAttribute("data-value"));
        ctrl.checked = (v === "on");
        ctrl.dispatchEvent(new Event("change", { bubbles: true }));
        syncToggleFromControl(targetId);
      });
    }
    syncToggleFromControl(targetId);
  }

  // Preset => locks/unlocks Check-in/out
  if (setupPresetEl) {
    setupPresetEl.addEventListener("change", () => {
      applySetupPreset(String(setupPresetEl.value || "x01"));
      syncGroupFromControl("setupPreset");
    });
    applySetupPreset(String(setupPresetEl.value || "x01"));
    syncGroupFromControl("setupPreset");
  }

  // Mode => locks/unlocks mutual control (Ranked forces Off)
  if (setupCompetitionEl) {
    setupCompetitionEl.addEventListener("change", () => {
      applyCompetitionRules();
      syncGroupFromControl("setupCompetition");
    });
    applyCompetitionRules();
    syncGroupFromControl("setupCompetition");
  }

  // Keep mutual control in sync (even though the UI is button-driven)
  if (setupAllowMutualControlEl) {
    setupAllowMutualControlEl.addEventListener("change", () => syncGroupFromControl("setupAllowMutualControl"));
    syncGroupFromControl("setupAllowMutualControl");
  }

  // Keep doubles tracking toggle in sync
  if (setupTrackCheckoutStatsEl) {
    setupTrackCheckoutStatsEl.addEventListener("change", () => syncToggleFromControl("setupTrackCheckoutStats"));
    syncToggleFromControl("setupTrackCheckoutStats");
  }

  // Tooltips: show bubble while pressed
  for (const icon of helpIcons) {
    const tip = String(icon.getAttribute("data-tip") || "").trim();
    if (!tip) continue;
    const bubble = document.createElement("span");
    bubble.className = "tipBubble";
    bubble.textContent = tip;
    icon.appendChild(bubble);

    const show = () => icon.classList.add("showTip");
    const hide = () => icon.classList.remove("showTip");

    icon.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      // Close other tooltips
      helpIcons.forEach(h => h !== icon && h.classList.remove("showTip"));
      show();
    });
    icon.addEventListener("pointerup", hide);
    icon.addEventListener("pointercancel", hide);
    icon.addEventListener("pointerleave", hide);
  }

  document.addEventListener("pointerdown", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest && t.closest(".helpIcon")) return;
    helpIcons.forEach(h => h.classList.remove("showTip"));
  });

  
if (setupHandicapsBtn) {
  setupHandicapsBtn.addEventListener("click", () => {
    // Only allow in Casual; ranked is disabled in applyCompetitionRules
    openHandicapModal();
  });
}

if (handicapModal) {
  handicapModal.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;

    // Button-group controls
    const btn = t.closest("button");
    if (btn && btn.closest(".btnGroup")) {
      const group = btn.closest(".btnGroup");
      const controlId = group.getAttribute("data-control");
      const val = btn.getAttribute("data-value");
      if (controlId && val) {
        setSelectValue(controlId, val);
        applyHandicapBadgeAndDoublesLock();
      }
      return;
    }

    // Click outside card to close
    if (t === handicapModal) closeHandicapModal();
  });
}

if (hcpCancelBtn) hcpCancelBtn.addEventListener("click", () => closeHandicapModal());
if (hcpResetBtn) hcpResetBtn.addEventListener("click", () => resetHandicapsToDefault());

// Stepper buttons
function stepMultiplier(playerIdx, dir) {
  const inputId = playerIdx === 0 ? "hcpP0Mult" : "hcpP1Mult";
  const el = document.getElementById(inputId);
  const current = parseMultiplier(el?.value) ?? 1;
  // Choose nearest step then move
  let i = 0;
  let best = Infinity;
  for (let k=0;k<HANDICAP_STEPS.length;k++) {
    const d = Math.abs(HANDICAP_STEPS[k] - current);
    if (d < best) { best = d; i = k; }
  }
  const nextIdx = Math.max(0, Math.min(HANDICAP_STEPS.length - 1, i + dir));
  setStepperValue(inputId, HANDICAP_STEPS[nextIdx]);
  applyHandicapBadgeAndDoublesLock();
}
const p0Down = document.getElementById("hcpP0MultDown");
const p0Up = document.getElementById("hcpP0MultUp");
const p1Down = document.getElementById("hcpP1MultDown");
const p1Up = document.getElementById("hcpP1MultUp");
if (p0Down) p0Down.addEventListener("click", () => stepMultiplier(0, -1));
if (p0Up) p0Up.addEventListener("click", () => stepMultiplier(0, +1));
if (p1Down) p1Down.addEventListener("click", () => stepMultiplier(1, -1));
if (p1Up) p1Up.addEventListener("click", () => stepMultiplier(1, +1));

// Inputs: live validation + doubles lock
["hcpP0Mult","hcpP1Mult","hcpP0Start","hcpP1Start","setupMode","setupCheckIn","setupCheckOut"].forEach((id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const handler = () => {
    if (id === "setupMode") app.__lastSetupMode = Number(el.value || 501);
    applyHandicapBadgeAndDoublesLock();
    // Keep any steppers in sync (handicap modal uses steppers too)
    try { syncStepperFromControl(id); } catch (_) {}
  };
  el.addEventListener("input", handler);
  el.addEventListener("change", handler);
});

if (hcpSaveBtn) {
  hcpSaveBtn.addEventListener("click", () => {
    showHcpError("");
    const p0 = readHandicapFromUI(0);
    const p1 = readHandicapFromUI(1);

    const badMult = (p) => !Number.isFinite(Number(p.multiplier)) || Number(p.multiplier) <= 0;
    if (badMult(p0) || badMult(p1)) {
      showHcpError("Multiplier must be greater than 0.");
      return;
    }
    const badStart = (p) => !Number.isFinite(Number(p.startScore)) || Number(p.startScore) < 1;
    if (badStart(p0) || badStart(p1)) {
      showHcpError("Starting score must be 1 or more.");
      return;
    }
    // Saved (we simply close; values live in the setup DOM)
    closeHandicapModal();
    applyHandicapBadgeAndDoublesLock();
  });
}

if (setupStartBtn) setupStartBtn.addEventListener("click", () => { app.__handicapsInitialized = true; startMatchFromSetup(); });


  // Checkout modal
  const checkoutCancelBtn = document.getElementById("checkoutCancelBtn");
  const checkoutConfirmBtn = document.getElementById("checkoutConfirmBtn");
  const dartsBtns = Array.from(document.querySelectorAll(".dartsBtn"));
  const doubleDartsBtns = Array.from(document.querySelectorAll(".doubleDartsBtn"));

  window.__selectedCheckoutDarts = null;
  window.__selectedCheckoutDoubleDarts = null;
  window.__checkoutRequireDoubleDarts = false;

  for (const b of dartsBtns) {
    b.addEventListener("click", () => {
      dartsBtns.forEach(btn => btn.classList.remove("selected"));
      b.classList.add("selected");
      const d = Number(b.getAttribute("data-darts"));
      window.__selectedCheckoutDarts = d;
      const needDouble = window.__checkoutRequireDoubleDarts === true;
      const doubleOk = !needDouble || [1, 2, 3].includes(window.__selectedCheckoutDoubleDarts);
      if (checkoutConfirmBtn) checkoutConfirmBtn.disabled = !doubleOk;
    });
  }


  for (const b of doubleDartsBtns) {
    b.addEventListener("click", () => {
      doubleDartsBtns.forEach(btn => btn.classList.remove("selected"));
      b.classList.add("selected");
      const d = Number(b.getAttribute("data-darts"));
      window.__selectedCheckoutDoubleDarts = d;
      const needDouble = window.__checkoutRequireDoubleDarts === true;
      const totalOk = [1, 2, 3].includes(window.__selectedCheckoutDarts);
      const doubleOk = !needDouble || [1, 2, 3].includes(window.__selectedCheckoutDoubleDarts);
      if (checkoutConfirmBtn) checkoutConfirmBtn.disabled = !(totalOk && doubleOk);
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
      const needDouble = window.__checkoutRequireDoubleDarts === true;
      if (needDouble) {
        const dd = window.__selectedCheckoutDoubleDarts;
        if (![1, 2, 3].includes(dd)) {
          showError("Select darts used on double");
          return;
        }
      }

      confirmCheckout(d, window.__selectedCheckoutDoubleDarts);
    });
  }

  // Winner modal button
  const winnerNewGameBtn = document.getElementById("winnerNewGameBtn");
  if (winnerNewGameBtn) {
    winnerNewGameBtn.addEventListener("click", continueOrNewMatch);
  }

  const wireGhostSave = (el) => {
    if (!el) return;
    el.addEventListener("click", async () => {
      // Step 1: prepare token from the currently-viewed leg.
      // Step 2: ask for a name. Step 3: save by token (even if the match advances).
      try {
        const st = app.latestState;
        if (st?.match?.handicaps?.enabled === true) {
          showError("Save Ghost is disabled when Handicap Mode is active.");
          return;
        }
        const prep = await prepareGhostFromWinnerModalView();
        if (!prep || !prep.ok) {
          if (prep && prep.reason === "DUPLICATE") {
            showError("You already have this leg saved.");
          } else if (prep && prep.reason === "SELECT_LEG") {
            showError("Select a leg tab to save.");
          } else if (prep && (prep.reason === "NOT_WINNER" || prep.reason === "NO_CHECKOUT")) {
            showError("Only winning legs can be saved.");
          } else {
            showError("Couldn't prepare replay.");
          }
          return;
        }

        // Stash token for the name modal. This must survive if host clicks Continue.
        window.__pendingGhostToken = prep.token;

        const m = document.getElementById("ghostNameModal");
        const inp = document.getElementById("ghostNameInput");
        const err = document.getElementById("ghostNameError");
        if (err) { err.innerText = ""; err.classList.add("hidden"); }
        if (inp) {
          inp.value = "";
          inp.focus();
        }
        if (m) openModal(m);
      } catch (e) {
        console.warn("prepare ghost failed", e);
        showError("Couldn't prepare replay.");
      }
    });

  };

  const winnerSaveGhostBtn = document.getElementById("winnerSaveGhostBtn");
  wireGhostSave(winnerSaveGhostBtn);

  // Ghost naming modal controls
  const ghostNameModal = document.getElementById("ghostNameModal");
  const ghostNameInput = document.getElementById("ghostNameInput");
  const ghostNameError = document.getElementById("ghostNameError");
  const ghostNameCancelBtn = document.getElementById("ghostNameCancelBtn");
  const ghostNameSaveBtn = document.getElementById("ghostNameSaveBtn");

  const setGhostNameError = (msg) => {
    if (!ghostNameError) return;
    if (msg) {
      ghostNameError.innerText = msg;
      ghostNameError.classList.remove("hidden");
    } else {
      ghostNameError.innerText = "";
      ghostNameError.classList.add("hidden");
    }
  };

  if (ghostNameCancelBtn) {
    ghostNameCancelBtn.addEventListener("click", () => {
      try { window.__pendingGhostToken = ""; } catch (_) {}
      setGhostNameError("");
      if (ghostNameModal) closeModal(ghostNameModal);
    });
  }

  if (ghostNameSaveBtn) {
    ghostNameSaveBtn.addEventListener("click", async () => {
      const tok = String(window.__pendingGhostToken || "").trim();
      const nm = String(ghostNameInput?.value || "").trim();
      if (!tok) { setGhostNameError("No replay selected."); return; }
      if (!nm) { setGhostNameError("Please enter a name."); return; }

      ghostNameSaveBtn.disabled = true;
      const oldText = ghostNameSaveBtn.innerText;
      ghostNameSaveBtn.innerText = "Saving...";
      let savedOk = false;
      try {
        const res = await savePreparedGhostToken(tok, nm);
        if (res && res.ok) {
          savedOk = true;
          // Subtle in-UI confirmation without browser dialogs.
          ghostNameSaveBtn.innerText = "Saved ✓";
          try { window.__pendingGhostToken = ""; } catch (_) {}
          setGhostNameError("");
          setTimeout(() => {
            if (ghostNameModal) closeModal(ghostNameModal);
            ghostNameSaveBtn.innerText = oldText;
            ghostNameSaveBtn.disabled = false;
          }, 500);

          // If the winner modal button is still visible, make it clear it's saved.
          if (winnerSaveGhostBtn && !winnerSaveGhostBtn.classList.contains("hidden")) {
            winnerSaveGhostBtn.innerText = "Saved ✓";
            winnerSaveGhostBtn.disabled = true;
          }
          return;
        }
        if (res && res.reason === "DUPLICATE") {
          setGhostNameError("You already have this replay saved.");
        } else if (res && res.reason === "NAME_REQUIRED") {
          setGhostNameError("Please enter a name.");
        } else {
          setGhostNameError("Couldn't save replay.");
        }
      } catch (e) {
        console.warn("save ghost named failed", e);
        setGhostNameError("Couldn't save replay.");
      } finally {
        if (!savedOk) {
          ghostNameSaveBtn.innerText = oldText;
          ghostNameSaveBtn.disabled = false;
        }
      }
    });
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
      if (modal) closeModal(modal);
    });
  }

  if (confirmNewMatchOkBtn) {
    confirmNewMatchOkBtn.addEventListener("click", () => {
      const modal = document.getElementById("confirmNewMatchModal");
      if (modal) closeModal(modal);

      // In a Nemesis game, "New Match" should open the Nemesis setup modal.
      // Use the presence of the Nemesis config block (not names) to avoid
      // accidentally triggering this for a human named "Nemesis".
      const st = (typeof app !== "undefined") ? app.latestState : null;
      const isNemesisGame = !!st?.nemesis?.enabled;
      const setupId = isNemesisGame ? "nemesisMatchSetupModal" : "setupModal";
      const setup = document.getElementById(setupId);
      if (setup) openModal(setup);
    });
  }

  // Confirm Restart Match modal
  const confirmRestartCancelBtn = document.getElementById("confirmRestartCancelBtn");
  const confirmRestartOkBtn = document.getElementById("confirmRestartOkBtn");

  if (confirmRestartCancelBtn) {
    confirmRestartCancelBtn.addEventListener("click", () => {
      const modal = document.getElementById("confirmRestartMatchModal");
      if (modal) closeModal(modal);
    });
  }

  if (confirmRestartOkBtn) {
    confirmRestartOkBtn.addEventListener("click", async () => {
      const modal = document.getElementById("confirmRestartMatchModal");
      if (modal) closeModal(modal);
      // Audit: game restarted
      try { addAuditSystem("Game Restarted"); } catch (_) {}
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
  initAuditChatUI();
  wireProfileModalClose();

  // Player profile modal (click player name pill) — only if that player is logged in
  const p1NameRow = document.querySelector("#p1Box .nameRow");
  const p2NameRow = document.querySelector("#p2Box .nameRow");

  const wireProfileClick = (idx, el) => {
    if (!el) return;
    el.style.cursor = "pointer";
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
      try { el.blur(); } catch { }
    });
  };

  wireProfileClick(0, p1NameRow);
  wireProfileClick(1, p2NameRow);



  // Winner modal match stats tabs
  const matchStatsTabs = document.getElementById("matchStatsTabs");
  if (matchStatsTabs) {
    matchStatsTabs.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("button.msTabBtn") : null;
      if (!btn) return;
      const tab = btn.getAttribute("data-tab") || "final";
      app.matchStatsTab = tab;
      if (app.latestState) render(app.latestState);
    });
  }

  // One-shot: if the URL asks us to auto-open setup (used for local/offline games),
  // do it once and then clean the URL so refresh doesn't re-trigger.
  try {
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("autoSetup") === "1") {
      qs.delete("autoSetup");
      const url = new URL(window.location.href);
      url.search = qs.toString();
      window.history.replaceState({}, "", url.toString());

      configureSetupModalForLobbyType("local");
      setSetupModalVisible(true);
    }
  } catch (_) {}

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