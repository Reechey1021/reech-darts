// app/model/match.js

export function makeFreshLeg(mode, starterPlayer, rules = {}) {
  const checkInRule = rules?.checkIn || "straight";
  const checkedInDefault = checkInRule !== "double";

  const h = rules?.handicaps;
  const useH = h?.enabled === true;

  const p0 = useH ? (h?.p0 || {}) : {};
  const p1 = useH ? (h?.p1 || {}) : {};

  const p0Score = useH && Number.isFinite(Number(p0.startScore)) ? Number(p0.startScore) : mode;
  const p1Score = useH && Number.isFinite(Number(p1.startScore)) ? Number(p1.startScore) : mode;

  const p0CheckedIn = useH ? (String(p0.checkIn || checkInRule) !== "double") : checkedInDefault;
  const p1CheckedIn = useH ? (String(p1.checkIn || checkInRule) !== "double") : checkedInDefault;

  return {
    players: [
      { score: p0Score, checkedIn: p0CheckedIn },
      { score: p1Score, checkedIn: p1CheckedIn },
    ],
    currentPlayer: starterPlayer,
    status: "in_progress", // "finished"
    winner: null,
    history: [],
  };
}


export function makeNewMatch({ mode, bestOf, p1Name, p2Name }) {
  const starter = Math.random() < 0.5 ? 0 : 1;

  return {
    match: {
      mode,
      bestOf,
      players: [{ name: p1Name }, { name: p2Name }],
      starterLeg1: starter,
      legsWon: [0, 0],
      legs: [],
      status: "in_progress",
      winner: null,
      createdAt: new Date(),

      // V4 Stage 1 defaults (V3-compatible): Straight In + Double Out
      rules: {
        preset: "x01",
        checkIn: "straight",
        checkOut: "double",
        trackCheckoutStats: true,
      },

      // Handicaps: setup-only; ALWAYS reset for new matches
      handicaps: {
        enabled: false,
        p0: { multiplier: 1, startScore: mode, checkIn: "straight", checkOut: "double", finish: "exact" },
        p1: { multiplier: 1, startScore: mode, checkIn: "straight", checkOut: "double", finish: "exact" },
      },


      // online stuff

      hostId: null,
      gameType: "single", // "single" | "online"
      seat1Id: null,
      seat2Id: null,

      // starting selection
      starting: "random", // "bull" | "random" | "p1" | "p2"
      bull: null,
    },
    leg: makeFreshLeg(mode, starter),
    pendingCheckout: null,
    updatedAt: new Date(),
  };
}

export function starterForLeg(match) {
  const legsPlayed = match.legs.length;
  return (match.starterLeg1 + legsPlayed) % 2;
}