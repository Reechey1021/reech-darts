// /arcade/shared/setupUi.js
// Arcade setup UI helpers: steppers + button groups + on/off toggles.
// Mirrors the behavior used on /game/ setupModal and the in-game arcade setup UI.

function syncStepperFromControl(targetId, scope = document) {
  const stepper = scope.querySelector(`[data-setup-stepper][data-target="${targetId}"]`);
  const ctrl = scope.getElementById ? scope.getElementById(targetId) : document.getElementById(targetId);
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
}

function syncGroupFromControl(targetId, scope = document) {
  const ctrl = document.getElementById(targetId);
  if (!ctrl) return;
  const row = scope.querySelector(`.setupBtnRow[data-setup-group][data-target="${targetId}"]`);
  if (!row) return;
  const val = String(ctrl.value);
  Array.from(row.querySelectorAll(".setupBtn")).forEach((b) => {
    b.classList.toggle("selected", String(b.getAttribute("data-value")) === val);
  });
}

function syncToggleFromControl(targetId, scope = document) {
  const ctrl = document.getElementById(targetId);
  if (!ctrl || ctrl.type !== "checkbox") return;
  const row = scope.querySelector(`.setupBtnRow[data-setup-toggle][data-target="${targetId}"]`);
  if (!row) return;
  const on = !!ctrl.checked;
  Array.from(row.querySelectorAll(".setupBtn")).forEach((b) => {
    const v = String(b.getAttribute("data-value"));
    b.classList.toggle("selected", (v === "on" && on) || (v === "off" && !on));
  });
}

export function initArcadeSetupUi(scope = document) {
  // Steppers
  const steppers = Array.from(scope.querySelectorAll("[data-setup-stepper][data-target]"));
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
      syncStepperFromControl(targetId, scope);
    };

    const decBtn = stepper.querySelector('.setupStepBtn[data-step="dec"]');
    const incBtn = stepper.querySelector('.setupStepBtn[data-step="inc"]');
    if (decBtn) decBtn.addEventListener("click", () => {
      const cur = String(ctrl.value);
      const idx = values.indexOf(cur);
      setByIndex((idx >= 0 ? idx : 0) - 1);
    });
    if (incBtn) incBtn.addEventListener("click", () => {
      const cur = String(ctrl.value);
      const idx = values.indexOf(cur);
      setByIndex((idx >= 0 ? idx : 0) + 1);
    });

    ctrl.addEventListener("change", () => syncStepperFromControl(targetId, scope));
    syncStepperFromControl(targetId, scope);
  }

  // Button groups
  const groupRows = Array.from(scope.querySelectorAll('.setupBtnRow[data-setup-group][data-target]'));
  for (const row of groupRows) {
    const targetId = row.getAttribute("data-target");
    if (!targetId) continue;
    const ctrl = document.getElementById(targetId);
    if (!ctrl) continue;

    const btns = Array.from(row.querySelectorAll(".setupBtn"));
    for (const b of btns) {
      b.addEventListener("click", () => {
        const v = String(b.getAttribute("data-value"));
        ctrl.value = v;
        ctrl.dispatchEvent(new Event("change", { bubbles: true }));
        syncGroupFromControl(targetId, scope);
      });
    }
    syncGroupFromControl(targetId, scope);
  }

  // Toggles
  const toggleRows = Array.from(scope.querySelectorAll('.setupBtnRow[data-setup-toggle][data-target]'));
  for (const row of toggleRows) {
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
        syncToggleFromControl(targetId, scope);
      });
    }
    ctrl.addEventListener("change", () => syncToggleFromControl(targetId, scope));
    syncToggleFromControl(targetId, scope);
  }
}
