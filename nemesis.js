// /nemesis.js (ES module)
// Slice 1: Nemesis configuration screen. No game creation yet.

import { app } from "./app/state.js";
import { applyBuildTag, logBuildInfo } from "./app/ui/buildInfo.js";
import { initFirebase } from "./app/firebase.js";
import { initAuth, onUserChanged, getActorId, getActorName } from "./app/auth.js";
import { NEMESIS_PRESETS, getPresetById, findMatchingPresetId } from "./app/nemesis/presets.js";
import { initPageTransitions, softNavigate } from "./app/ui/pageTransitions.js";
import { withBase } from "./app/routing.js";
import { makeNewMatch } from "./app/model/match.js";
import { initBullState } from "./app/bull/core.js";

logBuildInfo();
applyBuildTag();


const NEMESIS_DEFAULT_THEME = "cyan";

function applyNemesisTheme() {
  const theme = localStorage.getItem("theme") || NEMESIS_DEFAULT_THEME;
  document.body.setAttribute("data-theme", theme);
}

// If theme changes in another tab (or future UI), update live.
window.addEventListener("storage", (e) => {
  if (e && e.key === "theme") applyNemesisTheme();
});

const LS_KEY = "nemesisConfigV1";
const LS_SETUP_KEY = "nemesisSetupV1";

function qs(id) {
  return document.getElementById(id);
}

function setMsg(text, isError = false) {
  const el = qs("nemesisMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError));
  el.classList.toggle("success", Boolean(!isError && text));
}

function setSetupMsg(text, isError = false) {
  const el = qs("nemesisSetupMsg");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", Boolean(isError));
  el.classList.toggle("success", Boolean(!isError && text));
}

function openModal(modalEl) {
  if (!modalEl) return;

  // Cancel any pending close fallback timer from a previous close.
  if (modalEl.__closeTimer) {
    clearTimeout(modalEl.__closeTimer);
    modalEl.__closeTimer = null;
  }
  // Remove any lingering transitionend handler from a previous close.
  if (modalEl.__onCloseTransitionEnd) {
    try { modalEl.removeEventListener("transitionend", modalEl.__onCloseTransitionEnd); } catch {}
    modalEl.__onCloseTransitionEnd = null;
  }

  modalEl.classList.remove("hidden");
  modalEl.style.display = "flex";

  // Allow the browser to apply display before transitioning
  requestAnimationFrame(() => {
    modalEl.classList.remove("is-closing");
    modalEl.classList.add("is-open");
    modalEl.setAttribute("aria-hidden", "false");
  });
}

function closeModal(modalEl) {
  if (!modalEl) return;
  if (modalEl.classList.contains("hidden")) return;

  modalEl.classList.add("is-closing");
  modalEl.classList.remove("is-open");
  modalEl.setAttribute("aria-hidden", "true");

  // Prefer transitionend (more robust), but add a fallback timer.
  const onEnd = (ev) => {
    if (ev && ev.target !== modalEl) return;
    try { modalEl.removeEventListener("transitionend", onEnd); } catch {}
    modalEl.__onCloseTransitionEnd = null;
    modalEl.classList.add("hidden");
    modalEl.style.display = "none";
    modalEl.classList.remove("is-closing");
  };
  modalEl.__onCloseTransitionEnd = onEnd;
  try { modalEl.addEventListener("transitionend", onEnd); } catch {}

  modalEl.__closeTimer = window.setTimeout(() => {
    if (modalEl.__onCloseTransitionEnd) {
      try { modalEl.removeEventListener("transitionend", modalEl.__onCloseTransitionEnd); } catch {}
      modalEl.__onCloseTransitionEnd = null;
    }
    modalEl.classList.add("hidden");
    modalEl.style.display = "none";
    modalEl.classList.remove("is-closing");
    modalEl.__closeTimer = null;
  }, 220);
}

function loadStoredSetup() {
  try {
    const raw = localStorage.getItem(LS_SETUP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function saveStoredSetup(setup) {
  try {
    localStorage.setItem(LS_SETUP_KEY, JSON.stringify(setup));
  } catch {
    // ignore
  }
}


function loadStoredConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function saveStoredConfig(cfg) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch {
    // ignore
  }
}

function clampInt(n, min, max) {
  const v = Math.round(Number(n) || 0);
  return Math.max(min, Math.min(max, v));
}


function rangeStepToBand(step) {
  // UI step (0..5) -> absolute range (±0,±2,±4,±6,±8,±10)
  const s = clampInt(step, 0, 5);
  return [0, 2, 4, 6, 8, 10][s] ?? 0;
}

function buildNemesisBlock(cfg) {
  const target3DA = clampInt(cfg?.target3daStep ?? 4, 1, 10) * 10;
  const rangeBand = rangeStepToBand(cfg?.rangeStep ?? 0);
  const sliders = cfg?.sliders || {};

  return {
    enabled: true,
    version: 1,
    name: "Nemesis",
    presetId: String(cfg?.presetId || "standard"),
    target3DA,
    rangeBand,
    sliders: {
      consistency: clampInt(sliders.consistency ?? 5, 1, 10),
      checkout: clampInt(sliders.checkout ?? 5, 1, 10),
    },
    seed: Math.floor(Math.random() * 1_000_000_000),
    runtime: {
      matchTarget3DA: (() => {
        const band = clampInt(rangeBand, 0, 10);
        const delta = Math.floor((Math.random() * (band * 2 + 1)) - band);
        return clampInt(target3DA + delta, 5, 180);
      })(),
    },
    createdAt: Date.now(),
  };
}

async function createNemesisGameAndStartMatch({ cfg, setup }) {
  if (!app.db) {
    throw new Error("DB not ready");
  }

  const actorName = getActorName();
  if (!actorName) {
    throw new Error("No player name");
  }

  const gameRef = app.db.collection("games").doc();
  const gameId = gameRef.id;

  const p1Name = String(actorName || "Player").trim().slice(0, 16) || "Player";
  const p2Name = "Nemesis";

  const state = makeNewMatch({
    mode: setup.mode,
    bestOf: setup.bestOf,
    p1Name,
    p2Name,
  });

  // Apply rules
  state.match.rules = {
    preset: "x01",
    checkIn: setup.checkIn,
    checkOut: setup.checkOut,
    trackCheckoutStats: !!setup.trackCheckoutStats,
  };

  // Initialize check-in state based on rules
  const checkedInInit = setup.checkIn !== "double";
  if (state.leg && Array.isArray(state.leg.players)) {
    state.leg.players = state.leg.players.map((p) => ({ ...p, checkedIn: checkedInInit }));
  }

  // Starting selection
  state.match.starting = setup.starter;
  if (setup.starter === "p1") {
    state.match.starterLeg1 = 0;
    state.leg.currentPlayer = 0;
  } else if (setup.starter === "p2") {
    state.match.starterLeg1 = 1;
    state.leg.currentPlayer = 1;
  } else if (setup.starter === "bull") {
    state.match.bull = initBullState();
    state.match.starterLeg1 = 0;
    state.leg.currentPlayer = 0;
  }

  // Local match metadata
  state.match.gameType = "local";
  state.match.competition = "casual";
  state.match.allowMutualControl = false;
  state.match.hostId = getActorId();
  state.match.seat1Id = null;
  state.match.seat2Id = null;

  const now = new Date();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const nemesis = buildNemesisBlock(cfg);
  // UI-only: allow disabling Nemesis dialog popups per match.
  nemesis.showDialog = setup.showDialog !== false;

  await gameRef.set({
    createdAt: now,
    updatedAt: now,
    expiresAt,
    status: "active",
    lobbyType: "local",

    // Keep seats populated for UI context only (local games don't enforce seat ids)
    seat1Id: getActorId(),
    seat1Name: p1Name,
    seat1PhotoURL: (app.user && !app.user.isAnonymous) ? (app.user.photoURL || null) : null,
    seat2Id: null,
    seat2Name: p2Name,
    seat2PhotoURL: null,

    nemesis,

    ...state,
  });

  return gameId;
}

function bandToRangeStep(band) {
  const b = clampInt(band, 1, 7);
  if (b <= 1) return 1;
  if (b <= 2) return 2;
  if (b <= 3) return 3;
  if (b <= 5) return 4;
  return 5;
}

function getSetupFromUI() {
  const mode = clampInt(qs("nemesisSetupMode")?.value, 101, 1001);
  const bestOf = clampInt(qs("nemesisSetupBestOf")?.value, 1, 99);
  const starter = String(qs("nemesisSetupStarter")?.value || "random");
  const checkIn = String(qs("nemesisSetupCheckIn")?.value || "straight");
  const checkOut = String(qs("nemesisSetupCheckOut")?.value || "double");
  const trackCheckoutStats = !!qs("nemesisSetupTrackCheckoutStats")?.checked;
  const showDialog = (qs("nemesisSetupShowDialog")?.checked !== false);

  return {
    version: 1,
    mode,
    bestOf,
    starter,
    checkIn,
    checkOut,
    trackCheckoutStats,
    showDialog,
    updatedAt: Date.now(),
  };
}

function applySetupToUI(setup) {
  const s = setup || {};
  const mode = clampInt(s.mode ?? 501, 101, 1001);
  const bestOf = clampInt(s.bestOf ?? 3, 1, 99);
  const starter = String(s.starter || "random");
  const checkIn = String(s.checkIn || "straight");
  const checkOut = String(s.checkOut || "double");
  const trackCheckoutStats = s.trackCheckoutStats !== false;
  const showDialog = s.showDialog !== false;

  const modeEl = qs("nemesisSetupMode");
  if (modeEl) modeEl.value = String(mode);
  const bestEl = qs("nemesisSetupBestOf");
  if (bestEl) bestEl.value = String(bestOf);
  const starterEl = qs("nemesisSetupStarter");
  if (starterEl) starterEl.value = starter;
  const inEl = qs("nemesisSetupCheckIn");
  if (inEl) inEl.value = checkIn;
  const outEl = qs("nemesisSetupCheckOut");
  if (outEl) outEl.value = checkOut;
  const trackEl = qs("nemesisSetupTrackCheckoutStats");
  if (trackEl) trackEl.checked = !!trackCheckoutStats;

  const showDialogEl = qs("nemesisSetupShowDialog");
  if (showDialogEl) showDialogEl.checked = !!showDialog;

  // Sync button-driven UI (if wired)
  syncNemesisSetupControls();
}

// --- Nemesis setup modal: button-driven controls + steppers (copied from the main setup modal behavior) ---
function syncNemesisSetupControls() {
  const modal = qs("nemesisMatchSetupModal");
  if (!modal) return;

  const syncGroupFromControl = (targetId) => {
    const ctrl = document.getElementById(targetId);
    if (!ctrl) return;
    const row = modal.querySelector(`.setupBtnRow[data-setup-group][data-target="${targetId}"]`);
    if (!row) return;
    const val = String(ctrl.value);
    Array.from(row.querySelectorAll(".setupBtn")).forEach((b) => {
      b.classList.toggle("selected", String(b.getAttribute("data-value")) === val);
    });
  };

  const syncToggleFromControl = (targetId) => {
    const ctrl = document.getElementById(targetId);
    if (!ctrl || ctrl.type !== "checkbox") return;
    const row = modal.querySelector(`.setupBtnRow[data-setup-toggle][data-target="${targetId}"]`);
    if (!row) return;
    const on = !!ctrl.checked;
    Array.from(row.querySelectorAll(".setupBtn")).forEach((b) => {
      const v = String(b.getAttribute("data-value"));
      b.classList.toggle("selected", (v === "on" && on) || (v === "off" && !on));
    });
  };

  const syncStepperFromControl = (targetId) => {
    const stepper = modal.querySelector(`[data-setup-stepper][data-target="${targetId}"]`);
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

  [
    "nemesisSetupPreset",
    "nemesisSetupCheckIn",
    "nemesisSetupCheckOut",
    "nemesisSetupStarter",
  ].forEach(syncGroupFromControl);
  ["nemesisSetupTrackCheckoutStats", "nemesisSetupShowDialog"].forEach(syncToggleFromControl);
  ["nemesisSetupMode", "nemesisSetupBestOf"].forEach(syncStepperFromControl);
}

function initNemesisSetupControls() {
  const modal = qs("nemesisMatchSetupModal");
  if (!modal) return;
  if (modal.getAttribute("data-wired") === "1") return;
  modal.setAttribute("data-wired", "1");

  // Group rows
  const groupRows = Array.from(modal.querySelectorAll(".setupBtnRow[data-setup-group]"));
  for (const row of groupRows) {
    const targetId = row.getAttribute("data-target");
    if (!targetId) continue;
    const ctrl = document.getElementById(targetId);
    if (!ctrl) continue;

    const btns = Array.from(row.querySelectorAll(".setupBtn"));
    for (const btn of btns) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const v = String(btn.getAttribute("data-value") || "");
        if (!v) return;
        ctrl.value = v;
        ctrl.dispatchEvent(new Event("change", { bubbles: true }));
        syncNemesisSetupControls();
      });
    }

    ctrl.addEventListener("change", () => syncNemesisSetupControls());
  }

  // Toggle rows
  const toggleRows = Array.from(modal.querySelectorAll(".setupBtnRow[data-setup-toggle]"));
  for (const row of toggleRows) {
    const targetId = row.getAttribute("data-target");
    if (!targetId) continue;
    const ctrl = document.getElementById(targetId);
    if (!ctrl || ctrl.type !== "checkbox") continue;
    const btns = Array.from(row.querySelectorAll(".setupBtn"));
    for (const btn of btns) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const v = String(btn.getAttribute("data-value") || "");
        if (v === "on") ctrl.checked = true;
        if (v === "off") ctrl.checked = false;
        ctrl.dispatchEvent(new Event("change", { bubbles: true }));
        syncNemesisSetupControls();
      });
    }
    ctrl.addEventListener("change", () => syncNemesisSetupControls());
  }

  // Steppers
  const steppers = Array.from(modal.querySelectorAll("[data-setup-stepper][data-target]"));
  for (const stepper of steppers) {
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
      syncNemesisSetupControls();
    };

    const decBtn = stepper.querySelector('.setupStepBtn[data-step="dec"]');
    const incBtn = stepper.querySelector('.setupStepBtn[data-step="inc"]');

    if (decBtn) {
      decBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const cur = String(ctrl.value);
        const idx = values.indexOf(cur);
        setByIndex((idx >= 0 ? idx : 0) - 1);
      });
    }

    if (incBtn) {
      incBtn.addEventListener("click", (e) => {
        e.preventDefault();
        const cur = String(ctrl.value);
        const idx = values.indexOf(cur);
        setByIndex((idx >= 0 ? idx : 0) + 1);
      });
    }

    ctrl.addEventListener("change", () => syncNemesisSetupControls());
  }

  // Initialize visual state
  syncNemesisSetupControls();
}

function getConfigFromUI() {
  const presetId = String(qs("nemesisPresetRow")?.getAttribute("data-selected") || "standard");
  const target3daStep = clampInt(qs("nemesisTarget3da")?.value, 1, 10);
  const rangeStep = clampInt(qs("nemesisRange")?.value, 1, 5);
  const consistency = clampInt(qs("nemesisConsistency")?.value, 1, 10);
  const checkout = clampInt(qs("nemesisCheckout")?.value, 1, 10);

  return {
    version: 1,
    presetId,
    target3daStep,
    rangeStep,
    sliders: { consistency, checkout },
    updatedAt: Date.now(),
  };
}

function applyConfigToUI(cfg) {
  const presetId = String(cfg?.presetId || "standard");
  const target3daStep = clampInt(cfg?.target3daStep ?? 4, 1, 10);
  const rangeStep = clampInt(cfg?.rangeStep ?? 1, 1, 5);
  const s = cfg?.sliders || {};

  setSelectedPreset(presetId);

  const targetEl = qs("nemesisTarget3da");
  if (targetEl) targetEl.value = String(target3daStep);
  updateTarget3daLabel();
  
  const rangeEl = qs("nemesisRange");
  if (rangeEl) {
    rangeEl.value = String(rangeStep);
  }
  updateRangeLabel();

  const setRange = (id, val) => {
    const el = qs(id);
    if (!el) return;
    const next = clampInt(val, 1, 10);
    el.value = String(next);
  };

  setRange("nemesisConsistency", s.consistency ?? 5);
  setRange("nemesisCheckout", s.checkout ?? 5);

  updateAllSliderLabels();

  // Sync fancy slider bullets with the actual (possibly stored) values.
  ["nemesisTarget3da", "nemesisRange", "nemesisConsistency", "nemesisCheckout"].forEach((id) => {
    const el = qs(id);
    if (!el) return;
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (_) {
      // Fallback for older browsers
      const ev = document.createEvent("Event");
      ev.initEvent("input", true, true);
      el.dispatchEvent(ev);
    }
  });
}

function updateTarget3daLabel() {
  const step = clampInt(qs("nemesisTarget3da")?.value, 1, 10);
  const valEl = qs("nemesisTarget3daVal");
  if (valEl) valEl.textContent = String(step * 10);
}


function updateRangeLabel() {
  const step = clampInt(qs("nemesisRange")?.value, 1, 5);
  const band = rangeStepToBand(step);
  const valEl = qs("nemesisRangeVal");
  if (valEl) valEl.textContent = `±${band}`;

  // Also keep hint text in sync (optional, but helps clarity).
  const hints = document.querySelectorAll(".nemesisDifficultyGrid .nemesisSliderHint");
  // No-op if not found; we don't depend on this.
}


function updateAllSliderLabels() {
  const map = [
    ["nemesisConsistency", "nemesisConsistencyVal"],
    ["nemesisCheckout", "nemesisCheckoutVal"],
              ];
  map.forEach(([rangeId, labelId]) => {
    const range = qs(rangeId);
    const label = qs(labelId);
    if (!range || !label) return;
    label.textContent = String(clampInt(range.value, 1, 10));
  });
}

function renderPresets() {
  const row = qs("nemesisPresetRow");
  if (!row) return;

  row.innerHTML = NEMESIS_PRESETS
    .map(
      (p) =>
        `<button class="nemesisPresetBtn" type="button" data-preset-id="${p.id}" aria-label="${p.name}">
           <div class="nemesisPresetName">${p.name}</div>
           <div class="nemesisPresetDesc">${p.description}</div>
         </button>`
    )
    .join("");

  row.querySelectorAll(".nemesisPresetBtn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      const id = btn.getAttribute("data-preset-id") || "standard";
      applyPreset(id);
    });
  });
}

function setSelectedPreset(presetId) {
  const row = qs("nemesisPresetRow");
  if (!row) return;
  row.setAttribute("data-selected", presetId);

  row.querySelectorAll(".nemesisPresetBtn").forEach((btn) => {
    const id = btn.getAttribute("data-preset-id") || "";
    btn.classList.toggle("selected", id === presetId);
  });
}

function applyPreset(presetId) {
  const preset = getPresetById(presetId);

  // Preserve the user-selected target 3DA (presets must not change it).
  const currentTargetStep = clampInt(qs("nemesisTarget3da")?.value, 1, 10);

  // Apply preset defaults into sliders.
  const v = preset.values || {};
  applyConfigToUI({
    false: true,
    presetId: preset.id,
    target3daStep: currentTargetStep,
    rangeStep: v.rangeStep ?? clampInt(qs("nemesisRange")?.value, 0, 5),
    sliders: {
      consistency: v.consistency ?? clampInt(qs("nemesisConsistency")?.value, 1, 10),
      checkout: v.checkout ?? clampInt(qs("nemesisCheckout")?.value, 1, 10),
    },
  });

  setMsg(`${preset.name} selected.`);
}

function syncPresetFromUI() {
  const rangeStep = clampInt(qs("nemesisRange")?.value, 0, 5);
  const consistency = clampInt(qs("nemesisConsistency")?.value, 1, 10);
  const checkout = clampInt(qs("nemesisCheckout")?.value, 1, 10);

  const matchId = findMatchingPresetId({ rangeStep, consistency, checkout });
  setSelectedPreset(matchId);
}


function goBackToDashboard() {
  softNavigate(withBase("/dashboard"));
}

function initHelpIconTooltips(root = document) {
  const helpIcons = Array.from(root.querySelectorAll(".helpIcon[data-tip]"));
  for (const icon of helpIcons) {
    // Avoid duplicating bubbles if this is called more than once.
    if (icon.querySelector(".tipBubble")) continue;

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
      helpIcons.forEach((h) => h !== icon && h.classList.remove("showTip"));
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
    helpIcons.forEach((h) => h.classList.remove("showTip"));
  });
}


// --- Fancy slider UI (bullet label + min/max) for Nemesis sliders ---
function ensureFancySlider(inputId, { formatValue, minLabel, maxLabel } = {}) {
  const inputEl = qs(inputId);
  if (!inputEl) return;
  const parent = inputEl.parentElement;
  if (!parent) return;

  // Bullet label
  let bullet = parent.querySelector(`.nemesisRsLabel[data-for="${inputId}"]`);
  if (!bullet) {
    bullet = document.createElement("span");
    bullet.className = "nemesisRsLabel";
    bullet.setAttribute("data-for", inputId);
    bullet.setAttribute("aria-hidden", "true");
    parent.insertBefore(bullet, inputEl);
  }

  // Min/Max row
  let mm = parent.querySelector(`.nemesisMinMax[data-for="${inputId}"]`);
  if (!mm) {
    mm = document.createElement("div");
    mm.className = "nemesisMinMax";
    mm.setAttribute("data-for", inputId);
    const s1 = document.createElement("span");
    const s2 = document.createElement("span");
    s1.textContent = (minLabel != null) ? String(minLabel) : String(inputEl.min ?? "");
    s2.textContent = (maxLabel != null) ? String(maxLabel) : String(inputEl.max ?? "");
    mm.appendChild(s1);
    mm.appendChild(s2);
    parent.insertBefore(mm, inputEl.nextSibling);
  }

  const update = () => {
    const min = Number(inputEl.min);
    const max = Number(inputEl.max);
    const val = Number(inputEl.value);
    const safeMax = (Number.isFinite(max) && max !== min) ? max : (min + 1);
    const p = (Number.isFinite(val) ? (val - min) / (safeMax - min) : 0);
    const txt = (typeof formatValue === "function") ? formatValue(val) : String(val);
    bullet.textContent = txt;

    // Position bullet relative to the slider width.
    const w = inputEl.offsetWidth || 600;
    const thumb = 22; // matches CSS thumb width
    const leftPx = p * (w - thumb);
    bullet.style.left = `${leftPx}px`;
  };

  inputEl.addEventListener("input", update);
  window.addEventListener("resize", update);
  update();
}

function initNemesisFancySliders() {
  // Target 3DA slider: value is 1..10 representing 10..100
  ensureFancySlider("nemesisTarget3da", {
    formatValue: (v) => String(Number(v) * 10),
    minLabel: "10",
    maxLabel: "100",
  });

  // Range: 0..5 mapped to ±0..±10
  ensureFancySlider("nemesisRange", {
    formatValue: (v) => {
      const band = rangeStepToBand(Number(v));
      return `±${band}`;
    },
    minLabel: "±0",
    maxLabel: "±10",
  });

  ensureFancySlider("nemesisConsistency", { minLabel: "1", maxLabel: "10" });
  ensureFancySlider("nemesisCheckout", { minLabel: "1", maxLabel: "10" });
}

function wireUI() {
  // Enable tooltips on this page (reuses the same helpIcon markup as /game)
  initHelpIconTooltips(document);
  initNemesisFancySliders();
  const cancelBtn = qs("nemesisCancelBtn");
  const cancelTopBtn = qs("nemesisCancelTopBtn");
  const continueBtn = qs("nemesisContinueBtn");

  const doCancel = (e) => {
    e?.preventDefault?.();
    goBackToDashboard();
  };

  if (cancelBtn) cancelBtn.addEventListener("click", doCancel);
  if (cancelTopBtn) cancelTopBtn.addEventListener("click", doCancel);

  const targetRange = qs("nemesisTarget3da");
  const rangeRange = qs("nemesisRange");
  if (targetRange) {
    targetRange.addEventListener("input", () => {
      updateTarget3daLabel();
      setMsg("");
    });
  }

  if (rangeRange) {
    rangeRange.addEventListener("input", () => {
      updateRangeLabel();
      syncPresetFromUI();
      setMsg("");
    });
  }

  ["nemesisConsistency", "nemesisCheckout"].forEach((id) => {
    const el = qs(id);
    if (!el) return;
    el.addEventListener("input", () => {
      updateAllSliderLabels();
      syncPresetFromUI();
      setMsg("");
    });
  });

  if (continueBtn) {
    continueBtn.addEventListener("click", (e) => {
      e.preventDefault();
      const cfg = getConfigFromUI();
      saveStoredConfig(cfg);

      // Ensure the setup modal controls match the standard setup modal behavior.
      initNemesisSetupControls();

      // Populate locked names for cohesion with the main setup modal.
      const p1El = qs("nemesisSetupP1");
      const p2El = qs("nemesisSetupP2");
      if (p1El) p1El.value = String(getActorName() || "You").slice(0, 16);
      if (p2El) p2El.value = "Nemesis";

      // Prep setup modal
      const storedSetup = loadStoredSetup();
      if (storedSetup) {
        applySetupToUI(storedSetup);
      } else {
        applySetupToUI({ mode: 501, bestOf: 3, starter: "bull", checkIn: "straight", checkOut: "double", trackCheckoutStats: true });
      }

      setSetupMsg("");
      openModal(qs("nemesisMatchSetupModal"));
    });
  }

  // --- Slice 2: Match setup modal ---
  const setupModal = qs("nemesisMatchSetupModal");
  const backBtn = qs("nemesisSetupBackBtn");
  const startBtn = qs("nemesisSetupStartBtn");

  if (backBtn) {
    backBtn.addEventListener("click", (e) => {
      e.preventDefault();
      setSetupMsg("");
      closeModal(setupModal);
    });
  }

  if (setupModal) {
    setupModal.addEventListener("pointerdown", (e) => {
      // Click outside card closes
      if (e.target === setupModal) {
        closeModal(setupModal);
      }
    });
  }

  if (startBtn) {
    startBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      setSetupMsg("");

      const cfg = loadStoredConfig() || getConfigFromUI();
      const setup = getSetupFromUI();
      saveStoredSetup(setup);

      // Basic validation
      if (!["random", "bull", "p1", "p2"].includes(String(setup.starter))) {
        setSetupMsg("Invalid starter selection.", true);
        return;
      }

      try {
        startBtn.disabled = true;
        if (backBtn) backBtn.disabled = true;

        setSetupMsg("Creating match…");
        const gameId = await createNemesisGameAndStartMatch({ cfg, setup });
        // Handoff: store a one-shot pending id in case some servers drop the
        // query/path during redirects.
        try { localStorage.setItem("nemesisPendingGameId", String(gameId)); } catch (_) {}
        // Use query-param form to work even on basic static servers (no rewrites).
        window.location.href = withBase(`/game/?game=${encodeURIComponent(gameId)}`);
      } catch (err) {
        console.error(err);
        setSetupMsg(err?.message || "Couldn’t start Nemesis match.", true);
      } finally {
        startBtn.disabled = false;
        if (backBtn) backBtn.disabled = false;
      }
    });
  }
}

async function boot() {
  initPageTransitions();
  applyNemesisTheme();
  app.db = initFirebase();
  initAuth({ autoAnonymous: false });

  onUserChanged((u) => {
    app.user = u;

    // Nemesis is for signed-in (non-anonymous) users only.
    if (!u || u.isAnonymous) {
      window.location.href = withBase("/index");
      return;
    }

    // First render/wire once we know auth is valid.
    renderPresets();
    wireUI();

    const stored = loadStoredConfig();
    if (stored) {
      applyConfigToUI(stored);
      setMsg("Loaded your last Nemesis settings.");
    } else {
      // Default to Standard preset.
      applyPreset("standard");
      setMsg("");
    }
  });
}

boot();