// app/ui/profileModal.js

import { app } from "../state.js";
import { openModal, closeModal } from "./render.js";
import { acceptFriendRequest, cancelFriendRequest, declineFriendRequest, getFriendStateDb, removeFriend, sendFriendRequest } from "../friends.js";

function setVisible(visible) {
  const modal = document.getElementById("profileModal");
  if (!modal) return;
  visible ? openModal(modal) : closeModal(modal);
}

let currentViewedUid = null;

let friendFeedbackTimer = null;
let friendFeedbackOpenedAt = 0;
function showFriendFeedback(message) {
  const modal = document.getElementById("friendFeedbackModal");
  const msg = document.getElementById("friendFeedbackMsg");
  const ok = document.getElementById("friendFeedbackOkBtn");
  if (!modal || !msg) return;
  msg.textContent = String(message || "");
  try { openModal(modal); } catch (_) {}
  if (ok) ok.onclick = () => closeModal(modal);
  // Keep open until user clicks OK (no auto-close)
  clearTimeout(friendFeedbackTimer);
  friendFeedbackTimer = null;
}

async function renderFriendActions(viewedUid) {
  const wrap = document.getElementById("profileFriendActions");
  const addBtn = document.getElementById("profileAddFriendBtn");
  const rmBtn = document.getElementById("profileRemoveFriendBtn");
  const pendingRow = document.getElementById("profileFriendPendingRow");
  const accBtn = document.getElementById("profileAcceptFriendBtn");
  const decBtn = document.getElementById("profileDeclineFriendBtn");
  const cancelBtn = document.getElementById("profileCancelFriendBtn");

  if (!wrap || !addBtn || !rmBtn || !pendingRow || !accBtn || !decBtn || !cancelBtn) return;

  // Default hidden
  wrap.classList.add("hidden");
  addBtn.classList.add("hidden");
  rmBtn.classList.add("hidden");
  pendingRow.classList.add("hidden");
  cancelBtn.classList.add("hidden");

  // Guests can't use friends
  if (!app.user || !app.db) return;

  // No target or self
  if (!viewedUid || viewedUid === app.user.uid) return;

  const st = await getFriendStateDb(app.db, app.user.uid, viewedUid);
  currentViewedUid = viewedUid;

  wrap.classList.remove("hidden");

  if (st === "friends") {
    rmBtn.classList.remove("hidden");
  } else if (st === "incoming") {
    pendingRow.classList.remove("hidden");
  } else if (st === "outgoing") {
    cancelBtn.classList.remove("hidden");
  } else {
    addBtn.classList.remove("hidden");
  }

  // bind actions (overwrite each time)
  addBtn.onclick = async () => {
    if (!currentViewedUid) return;
    await sendFriendRequest(app.db, app.user.uid, currentViewedUid);
    // immediate feedback (re-check state from subcollections)
    renderFriendActions(currentViewedUid);
    showFriendFeedback("Friend request sent");
  };
  rmBtn.onclick = async () => {
    if (!currentViewedUid) return;
    await removeFriend(app.db, app.user.uid, currentViewedUid);
    renderFriendActions(currentViewedUid);
    showFriendFeedback("Friend has been removed");
  };
  accBtn.onclick = async () => {
    if (!currentViewedUid) return;
    await acceptFriendRequest(app.db, app.user.uid, currentViewedUid);
    renderFriendActions(currentViewedUid);
    showFriendFeedback("Friend request accepted");
  };
  cancelBtn.onclick = async () => {
    if (!currentViewedUid) return;
    await cancelFriendRequest(app.db, app.user.uid, currentViewedUid);
    renderFriendActions(currentViewedUid);
    showFriendFeedback("Friend request cancelled");
  };

  decBtn.onclick = async () => {
    if (!currentViewedUid) return;
    await declineFriendRequest(app.db, app.user.uid, currentViewedUid);
    renderFriendActions(currentViewedUid);
    showFriendFeedback("Friend request declined");
  };
}

function renderProfileDashboardStyle({ title, displayName, equipment, photoURL, stats, uid }) {
  const t = document.getElementById("profileTitle");
  if (t) t.textContent = title || "Profile";

  // Identity
  const nameEl = document.getElementById("profileName");
  const eqEl = document.getElementById("profileEquipment");
  const photoEl = document.getElementById("profileUserPhoto");

  if (nameEl) nameEl.textContent = displayName || "—";
  if (eqEl) eqEl.textContent = equipment || "";

  if (photoEl) {
    if (photoURL) {
      photoEl.src = photoURL;
      photoEl.classList.remove("hidden");
    } else {
      photoEl.removeAttribute("src");
      photoEl.classList.add("hidden");
    }
  }

  // Friends UI
  renderFriendActions(uid || null);

  // Stats: mirror dashboard rendering
  const s = stats || {};
  const matches = Number(s.matches || 0);
  const wins = Number(s.wins || 0);
  const losses = Number(s.losses || 0);

  const totalPoints = Number(s.totalPoints || 0);
  const totalDarts = Number(s.totalDarts || 0);
  const first9Points = Number(s.first9Points || s.totalFirst9Points || 0);
  const first9Darts = Number(s.first9Darts || s.totalFirst9Darts || 0);

  const tda = totalDarts ? Math.round((totalPoints / totalDarts) * 3) : 0;
  const f9d = first9Darts ? Math.round((first9Points / first9Darts) * 3) : 0;

  const s100 = Number(s.s100 || s.hundredPlus || s.total100s || 0);
  const s140 = Number(s.s140 || s.oneFortyPlus || s.total140s || 0);
  const s180 = Number(s.s180 || s.oneEighty || s.total180s || 0);
  const lifetimeDarts = Number(s.lifetimeDarts || 0);

  const checkoutThrown = Number(s.checkoutDoublesThrown || 0);
  const checkoutHit = Number(s.checkoutDoublesHit || 0);
  const checkoutPct = checkoutThrown ? Math.round((checkoutHit / checkoutThrown) * 100) : 0;

  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(v);
  };

  setText("profileTdaVal", tda);
  setText("profileF9dVal", f9d);
  setText("profileMatchesVal", matches);
  setText("profileDartsVal", lifetimeDarts || totalDarts || 0);
  setText("profileWinsVal", wins);
  setText("profileLossesVal", losses);
  const rate = matches ? Math.round((wins / matches) * 100) : 0;
  setText("profileWinRateVal", `${rate}%`);
  const donut = document.getElementById("profileWinRateDonut");
  if (donut) donut.style.setProperty("--p", String(Math.max(0, Math.min(1, rate / 100))));
  setText("profile100Val", s100);
  setText("profile140Val", s140);
  setText("profile180Val", s180);
  setText("profileCheckoutPctVal", `${checkoutPct}%`);

  // Last 5
  const lastEl = document.getElementById("profileLast5");
  if (lastEl) {
    const arr = Array.isArray(s.recentResults) ? s.recentResults.slice(0, 5) : [];
    lastEl.innerHTML = arr.length
      ? arr
          .map((r) => {
            const v = String(r).toUpperCase();
            const cls = v === "W" ? "w" : "l";
            return `<span class="dashWL ${cls}">${v}</span>`;
          })
          .join("")
      : `<span style="opacity:.7;">—</span>`;
  }

  // Friends actions (Phase 1)
  renderFriendActions(uid);
}

export async function openProfileModalForPlayerIndex(playerIndex) {
  const st = app.latestState;
  const player = st?.match?.players?.[playerIndex];
  if (!player) return;

  const name = player.name || (playerIndex === 0 ? "Player 1" : "Player 2");
  const uid = player.uid || null;

  // Guest / no uid: show name only
  if (!uid) {
    renderProfileDashboardStyle({ title: name, displayName: name, equipment: "", photoURL: null, stats: null, uid: null });
    setVisible(true);
    return;
  }

  // Authed: load Firestore user profile
  try {
    const snap = await app.db.collection("users").doc(uid).get();
    const p = snap.exists ? snap.data() : null;
    renderProfileDashboardStyle({
      title: name,
      displayName: (p?.displayName || p?.nickname || name),
      equipment: (p?.setEquipment || p?.equipment || ""),
      photoURL: (p?.photoURL || player.photoURL || null),
      stats: p?.stats || null,
      uid,
    });
    setVisible(true);
  } catch {
    renderProfileDashboardStyle({ title: name, displayName: name, equipment: "", photoURL: player.photoURL || null, stats: null, uid });
    setVisible(true);
  }
}

export function closeProfileModal() {
  setVisible(false);
}

export function initProfileModalUI() {
  const closeBtn = document.getElementById("profileCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeProfileModal);
}