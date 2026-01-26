import { openModal, closeModal } from "./render.js";

// app/ui/checkinPrompt.js
// Lightweight modal prompts used for Double-In tracking (when enabled).
// Returns null if the user cancels.

function setVisible(visible) {
  const modal = document.getElementById("checkInModal");
  console.log("[checkin] setVisible", visible, "modal?", !!modal);
  if (!modal) return;
  if (visible) {
    openModal(modal);
  } else {
    closeModal(modal);
  }
}

function resetUI() {
  const yesNo = document.getElementById("checkInYesNoRow");
  const dartsRow = document.getElementById("checkInDartsRow");
  if (yesNo) yesNo.classList.remove("hidden");
  if (dartsRow) dartsRow.classList.add("hidden");

  // show all dart buttons by default
  const btns = Array.from(document.querySelectorAll("#checkInDartsRow .checkInDartsBtn"));
  for (const b of btns) b.style.display = "";
}

export function promptDidHitDouble() {
  return new Promise((resolve) => {
    const title = document.getElementById("checkInTitle");
    const body = document.getElementById("checkInBody");
    const yesBtn = document.getElementById("checkInYesBtn");
    const noBtn = document.getElementById("checkInNoBtn");
    const cancelBtn = document.getElementById("checkInCancelBtn");
    const yesNo = document.getElementById("checkInYesNoRow");
    const dartsRow = document.getElementById("checkInDartsRow");

    if (!title || !body || !yesBtn || !noBtn || !cancelBtn || !yesNo || !dartsRow) {
      console.log("[checkin] modal elements missing", {title:!!title, body:!!body, yesBtn:!!yesBtn, noBtn:!!noBtn, cancelBtn:!!cancelBtn, yesNo:!!yesNo, dartsRow:!!dartsRow});
      resolve(null);
      return;
    }

    resetUI();
    title.textContent = "Check-in";
    body.textContent = "Did you hit the double?";

    const cleanup = () => {
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      cancelBtn.removeEventListener("click", onCancel);
      setVisible(false);
    };

    const onCancel = () => { cleanup(); resolve(null); };
    const onNo = () => { cleanup(); resolve({ hit: false }); };

    const onYes = async () => {
      // Move to darts selection
      yesNo.classList.add("hidden");
      dartsRow.classList.remove("hidden");
      body.textContent = "How many darts were used on the double?";

      const btns = Array.from(document.querySelectorAll("#checkInDartsRow .checkInDartsBtn"));
      const onPick = (e) => {
        const v = Number(e?.currentTarget?.getAttribute("data-darts") || 0);
        for (const b of btns) b.removeEventListener("click", onPick);
        cleanup();
        resolve({ hit: true, dartsUsed: v || 1 });
      };
      for (const b of btns) b.addEventListener("click", onPick);
    };

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    cancelBtn.addEventListener("click", onCancel);

    setVisible(true);
  });
}

export function promptCheckInDartsUsed({ maxOption = 2 }) {
  return new Promise((resolve) => {
    const title = document.getElementById("checkInTitle");
    const body = document.getElementById("checkInBody");
    const yesNo = document.getElementById("checkInYesNoRow");
    const dartsRow = document.getElementById("checkInDartsRow");
    const cancelBtn = document.getElementById("checkInCancelBtn");

    if (!title || !body || !yesNo || !dartsRow || !cancelBtn) {
      resolve(null);
      return;
    }

    resetUI();
    // We only want the dart choice UI for this prompt
    yesNo.classList.add("hidden");
    dartsRow.classList.remove("hidden");

    title.textContent = "Confirm Check-in";
    body.textContent = "How many darts were used for check-in?";

    const btns = Array.from(document.querySelectorAll("#checkInDartsRow .checkInDartsBtn"));
    for (const b of btns) {
      const v = Number(b.getAttribute("data-darts") || 0);
      if (v > maxOption) b.style.display = "none";
    }

    const cleanup = () => {
      cancelBtn.removeEventListener("click", onCancel);
      for (const b of btns) b.removeEventListener("click", onPick);
      setVisible(false);
    };

    const onCancel = () => { cleanup(); resolve(null); };
    const onPick = (e) => {
      const v = Number(e?.currentTarget?.getAttribute("data-darts") || 0);
      cleanup();
      resolve({ dartsUsed: v || 1 });
    };

    cancelBtn.addEventListener("click", onCancel);
    for (const b of btns) b.addEventListener("click", onPick);

    setVisible(true);
  });
}