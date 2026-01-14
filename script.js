console.log("Reech Darts loaded");

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyCG8yBJ5JeUlDQmWi27nrPLmezwu7IdrEM",
  authDomain: "reech-darts.firebaseapp.com",
  projectId: "reech-darts",
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// Initialize Firestore
const db = firebase.firestore();

console.log("Firebase connected");

// Shared game doc (we'll upgrade to unique game IDs later)
const gameRef = db.collection("games").doc("test-game");

// ---------- Helpers ----------
function makeFreshGame(mode) {
  return {
    mode: mode, // 301 or 501
    players: [
      { name: "Player 1", score: mode },
      { name: "Player 2", score: mode },
    ],
    currentPlayer: 0, // 0 = P1, 1 = P2
    status: "in_progress",
    history: [],
    updatedAt: new Date(),
  };
}

function render(game) {
  const statusEl = document.getElementById("status");
  const p1ScoreEl = document.getElementById("p1Score");
  const p2ScoreEl = document.getElementById("p2Score");

  if (!game) {
    statusEl.innerText = "No game yet — press New Game.";
    p1ScoreEl.innerText = "—";
    p2ScoreEl.innerText = "—";
    return;
  }

  p1ScoreEl.innerText = game.players?.[0]?.score ?? "—";
  p2ScoreEl.innerText = game.players?.[1]?.score ?? "—";

  if (game.status === "finished") {
    statusEl.innerText = "Game finished — press New Game.";
  } else {
    const who = game.currentPlayer === 0 ? "Player 1" : "Player 2";
    statusEl.innerText = `${who} to throw`;
  }
}

// ---------- ACTIONS ----------
async function newGame() {
  const modeEl = document.getElementById("mode");
  const mode = modeEl ? Number(modeEl.value) : 501;

  const game = makeFreshGame(mode);
  await gameRef.set(game);
}

async function resetGame() {
  await newGame();
}

async function submitScore() {
  const inputEl = document.getElementById("scoreInput");
  const entered = Number(inputEl?.value);

  if (!Number.isFinite(entered) || entered < 0 || entered > 180) {
    alert("Enter a number from 0 to 180.");
    return;
  }

  // Transaction prevents weirdness if two devices submit at once
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(gameRef);
    const game = snap.data();

    if (!game) throw new Error("No game exists. Click New Game first.");
    if (game.status !== "in_progress") throw new Error("Game finished. Click New Game.");

    const p = game.currentPlayer;
    const oldScore = game.players[p].score;
    const newScore = oldScore - entered;

    // Phase 1: prevent going below 0
    // Bust = score unchanged, but turn advances
    const isBust = newScore < 0;

    if (!isBust) {
      game.players[p].score = newScore;
    }

    // Save history for later undo/stats
    game.history = game.history || [];
    game.history.push({
      player: p,
      entered,
      bust: isBust,
      before: oldScore,
      after: isBust ? oldScore : newScore,
      at: new Date(),
    });

    // Phase 1: reset when someone hits exactly 0
    if (!isBust && newScore === 0) {
      const fresh = makeFreshGame(game.mode);
      tx.set(gameRef, fresh);
      return;
    }

    // Advance turn
    game.currentPlayer = (game.currentPlayer + 1) % 2;
    game.updatedAt = new Date();

    tx.set(gameRef, game);
  });

  // Clear input after submit
  inputEl.value = "";
  inputEl.focus();
}

// ---------- Wire buttons ----------
function wireUI() {
  const newGameBtn = document.getElementById("newGameBtn");
  const resetBtn = document.getElementById("resetBtn");
  const submitBtn = document.getElementById("submitBtn");
  const scoreInputEl = document.getElementById("scoreInput");

  newGameBtn.addEventListener("click", newGame);
  resetBtn.addEventListener("click", resetGame);
  submitBtn.addEventListener("click", submitScore);

  scoreInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitScore();
  });
}

wireUI();

// ---------- Real-time updates ----------
gameRef.onSnapshot(
  (doc) => {
    render(doc.data());
  },
  (err) => {
    console.error(err);
    document.getElementById("status").innerText = "Firestore error: " + err.message;
  }
);
