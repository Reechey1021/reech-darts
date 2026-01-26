// app/model/match.js

export function makeFreshLeg(mode, starterPlayer, rules = {}) {
  const checkInRule = rules?.checkIn || "straight";
  const checkedIn = checkInRule !== "double";

  return {
    players: [
      { score: mode, checkedIn },
      { score: mode, checkedIn },
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