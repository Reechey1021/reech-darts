// app/ui/profileModal.js

import { app } from "../state.js";

function setVisible(visible) {
  const modal = document.getElementById("profileModal");
  if (!modal) return;
  modal.classList.toggle("hidden", !visible);
}

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[m]);
}

function renderProfile({ title, displayName, equipment, stats, recent }) {
  const t = document.getElementById("profileTitle");
  const b = document.getElementById("profileBody");
  if (t) t.textContent = title || "Profile";

  if (!b) return;
  const lines = [];

  if (displayName) {
    lines.push(`<div><strong>Name:</strong> ${escapeHtml(displayName)}</div>`);
  }
  if (equipment) {
    lines.push(`<div><strong>Darts:</strong> ${escapeHtml(equipment)}</div>`);
  }

  if (stats) {
    const matches = stats.matches || 0;
    const wins = stats.wins || 0;
    const losses = stats.losses || 0;
    const hs = stats.highestScore || 0;
    const tda = stats.avg3DA || 0;
    const f9d = stats.avgF9D || 0;
    const s100 = stats.total100s || 0;
    const s140 = stats.total140s || 0;
    const s180 = stats.total180s || 0;
    const lifeDarts = stats.lifetimeDarts || 0;
    lines.push("<hr style=\"opacity:.25; margin:12px 0;\" />");
    lines.push(`<div><strong>Matches:</strong> ${matches} (W ${wins} / L ${losses})</div>`);
    lines.push(`<div><strong>3DA:</strong> ${tda}</div>`);
    lines.push(`<div><strong>F9D:</strong> ${f9d}</div>`);
    lines.push(`<div><strong>HS:</strong> ${hs}</div>`);
    lines.push(`<div><strong>100+:</strong> ${s100}</div>`);
    lines.push(`<div><strong>140+:</strong> ${s140}</div>`);
    lines.push(`<div><strong>180s:</strong> ${s180}</div>`);
    lines.push(`<div><strong>Lifetime darts thrown:</strong> ${lifeDarts}</div>`);
  }

  if (Array.isArray(recent) && recent.length) {
    lines.push("<hr style=\"opacity:.25; margin:12px 0;\" />");
    lines.push(`<div><strong>Last 5:</strong> ${recent.map(escapeHtml).join(" ")}</div>`);
  }

  if (lines.length === 0) {
    b.innerHTML = `<div style=\"opacity:.8\">No profile data.</div>`;
  } else {
    b.innerHTML = lines.join("\n");
  }
}

export async function openProfileModalForPlayerIndex(playerIndex) {
  const st = app.latestState;
  const player = st?.match?.players?.[playerIndex];
  if (!player) return;

  const name = player.name || (playerIndex === 0 ? "Player 1" : "Player 2");
  const uid = player.uid || null;

  // Guest / no uid: show name only
  if (!uid) {
    renderProfile({ title: name, displayName: name });
    setVisible(true);
    return;
  }

  // Authed: load Firestore user profile
  try {
    const snap = await app.db.collection("users").doc(uid).get();
    const p = snap.exists ? snap.data() : null;
    renderProfile({
      title: name,
      displayName: p?.displayName || name,
      equipment: p?.equipment || "",
      stats: p?.stats || null,
      recent: p?.stats?.recentResults || [],
    });
    setVisible(true);
  } catch {
    renderProfile({ title: name, displayName: name });
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
