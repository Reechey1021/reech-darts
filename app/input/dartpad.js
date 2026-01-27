// app/input/dartpad.js
import { app } from "../state.js";

export function multFactor(m) {
  if (m === "D") return 2;
  if (m === "T") return 3;
  return 1;
}

// In "table" mode, the authoritative state is app.dartThrows.
// We display the breakdown directly in #scoreInput (e.g. "20+20+20").
export function updateDartUI() {
  const scoreInput = document.getElementById("scoreInput");
  const submitBtn = document.getElementById("submitBtn");

  const breakdown = app.dartThrows.length ? app.dartThrows.join("+") : "";

  // Only drive the input text in table mode.
  if (scoreInput && app.inputMode === "table") {
    scoreInput.value = breakdown;
  }

  // In table/dartpad mode: submit ONLY when 3 darts picked
  if (submitBtn && app.inputMode === "table") {
    submitBtn.disabled = app.dartThrows.length !== 3;
  }
}

export function setMult(m) {
  app.dartMult = m;
  localStorage.setItem("dartMult", m);

  document.querySelectorAll(".dartMultBtn").forEach((btn) => {
    btn.classList.toggle("selected", btn.getAttribute("data-mult") === m);
  });
}

export function pushDart(score) {
  if (app.dartThrows.length >= 3) return;
  app.dartThrows.push(score);
  updateDartUI();
}

export function popDart() {
  app.dartThrows.pop();
  updateDartUI();
}

export function clearDarts() {
  app.dartThrows = [];
  updateDartUI();
}

export function setInputMode(mode) {
  app.inputMode = mode;
  localStorage.setItem("inputMode", mode);

  const keypad = document.getElementById("keypad");
  const table = document.getElementById("dartTableArea");
  const voice = document.getElementById("voiceArea");
  const btn = document.getElementById("inputModeBtn");
  const scoreInput = document.getElementById("scoreInput");

  if (keypad) keypad.classList.toggle("hidden", mode !== "keypad");
  if (table) table.classList.toggle("hidden", mode !== "table");
  if (voice) voice.classList.toggle("hidden", mode !== "voice");

  // icon hint (shows the NEXT mode)
  // keypad -> table -> voice -> keypad
  if (btn) {
    if (mode === "keypad") btn.textContent = "🎯";
    else if (mode === "table") btn.textContent = "🎙️";
    else btn.textContent = "⌨️";
  }

  // In non-keypad modes, prevent typing into the input (the mode drives it)
  if (scoreInput) scoreInput.readOnly = mode !== "keypad";

  if (mode === "table") {
    // Entering table mode: clear any keypad numeric input and start fresh.
    if (scoreInput) scoreInput.value = "";
    clearDarts();
    setMult(app.dartMult);
    updateDartUI();
  } else {
    // Leaving table mode: clear breakdown from input and reset dart state.
    clearDarts();
    if (scoreInput) scoreInput.value = "";

    // leaving table mode: make sure submit isn't stuck disabled
    const submitBtn = document.getElementById("submitBtn");
    if (submitBtn) submitBtn.disabled = false;
  }
}
