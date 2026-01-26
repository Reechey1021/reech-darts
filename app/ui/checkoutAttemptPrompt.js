import { openModal, closeModal } from "./render.js";

// app/ui/checkoutAttemptPrompt.js
// Modal prompt used for Double-Out checkout attempt tracking (when enabled).
// Returns:
//   { attempted: false } if user answers "No"
//   { attempted: true, dartsOnDouble: 1|2|3 } if user answers "Yes" then selects darts
//   null if user cancels (caller should abort submit)
function setVisible(visible) {
  const modal = document.getElementById("checkoutAttemptModal");
  console.log("[checkoutAttempt] setVisible", visible, "modal?", !!modal);
  if (!modal) return;
  if (visible) openModal(modal);
  else closeModal(modal);
}

function resetUI() {
  const yesNoRow = document.getElementById("checkoutAttemptYesNoRow");
  const dartsRow = document.getElementById("checkoutAttemptDartsRow");
  if (yesNoRow) yesNoRow.classList.remove("hidden");
  if (dartsRow) dartsRow.classList.add("hidden");
}

export function promptAttemptedCheckout() {
  return new Promise((resolve) => {
    const modal = document.getElementById("checkoutAttemptModal");
    const title = document.getElementById("checkoutAttemptTitle");
    const body = document.getElementById("checkoutAttemptBody");
    const yesBtn = document.getElementById("checkoutAttemptYesBtn");
    const noBtn = document.getElementById("checkoutAttemptNoBtn");
    const cancelBtn = document.getElementById("checkoutAttemptCancelBtn");
    const dartsRow = document.getElementById("checkoutAttemptDartsRow");

    if (!modal || !title || !body || !yesBtn || !noBtn || !cancelBtn || !dartsRow) {
      console.log("[checkoutAttempt] modal elements missing", {
        modal: !!modal, title: !!title, body: !!body, yesBtn: !!yesBtn, noBtn: !!noBtn, cancelBtn: !!cancelBtn, dartsRow: !!dartsRow
      });
      resolve(null);
      return;
    }

    resetUI();
    title.textContent = "Checkout";
    body.textContent = "Attempted checkout?";

    const cleanup = () => {
      yesBtn.removeEventListener("click", onYes);
      noBtn.removeEventListener("click", onNo);
      cancelBtn.removeEventListener("click", onCancel);
      Array.from(dartsRow.querySelectorAll(".checkoutAttemptDartsBtn")).forEach((b) => {
        b.removeEventListener("click", onPickDarts);
      });
      setVisible(false);
    };

    function onCancel() {
      cleanup();
      resolve(null);
    }

    function onNo() {
      cleanup();
      resolve({ attempted: false });
    }

    function onYes() {
      // advance to darts-on-double selection
      const yesNoRow = document.getElementById("checkoutAttemptYesNoRow");
      if (yesNoRow) yesNoRow.classList.add("hidden");
      dartsRow.classList.remove("hidden");
      title.textContent = "Checkout";
      body.textContent = "How many darts were used on a double?";
    }

    function onPickDarts(e) {
      const val = Number(e?.currentTarget?.dataset?.darts);
      if (![1, 2, 3].includes(val)) return;
      cleanup();
      resolve({ attempted: true, dartsOnDouble: val });
    }

    yesBtn.addEventListener("click", onYes);
    noBtn.addEventListener("click", onNo);
    cancelBtn.addEventListener("click", onCancel);
    Array.from(dartsRow.querySelectorAll(".checkoutAttemptDartsBtn")).forEach((b) => {
      b.addEventListener("click", onPickDarts);
    });

    setVisible(true);
  });
}
