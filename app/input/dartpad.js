// app/input/dartpad.js
import { app } from "../state.js";

export function multFactor(m) {
  if (m === "D") return 2;
  if (m === "T") return 3;
  return 1;
}

export function updateDartUI() {
  const breakdownEl = document.getElementById("dartBreakdown");
  const totalEl = document.getElementById("dartTotalVal");
  const scoreInput = document.getElementById("scoreInput");
  const submitBtn = document.getElementById("submitBtn");

  const total = app.dartThrows.reduce((a, b) => a + b, 0);
  const breakdown = app.dartThrows.length ? app.dartThrows.join("+") : "—";

  if (breakdownEl) breakdownEl.textContent = breakdown;
  if (totalEl) totalEl.textContent = String(total);
  if (scoreInput) scoreInput.value = app.dartThrows.length ? String(total) : "";

  // In table/dartpad mode: submit ONLY when 3 darts picked
  if (submitBtn && app.inputMode === "table") {
    submitBtn.disabled = (app.dartThrows.length !== 3);
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
  const btn = document.getElementById("inputModeBtn");
  const scoreInput = document.getElementById("scoreInput");

  if (keypad) keypad.classList.toggle("hidden", mode !== "keypad");
  if (table) table.classList.toggle("hidden", mode !== "table");

  // icon hint
  if (btn) btn.textContent = mode === "keypad" ? "🎯" : "⌨️";

  // in table mode, prevent typing into the input (table drives it)
  if (scoreInput) scoreInput.readOnly = (mode === "table");

  if (mode === "table") {
    setMult(app.dartMult);
    updateDartUI();
  } else {
    clearDarts();
    // leaving table mode: make sure submit isn't stuck disabled
    const submitBtn = document.getElementById("submitBtn");
    if (submitBtn) submitBtn.disabled = false;
  }
}
