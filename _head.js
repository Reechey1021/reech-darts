
function canScoreNow(state) {
  if (!state?.match) return false;
  // Local games: always allow scoring
  const gameType = state.match.gameType || state.lobbyType || state.match.lobbyType || "single";
  if (gameType !== "online") return true;

  // Online: block if not seated
  const myUid = getActorId();
  if (!myUid) return false;

  const seats = getSeatIds(state);
  const seatIndex = (seats.seat1 && myUid === seats.seat1) ? 0 : (seats.seat2 && myUid === seats.seat2) ? 1 : null;
  if (seatIndex === null) return false;

  // Allow mutual control: either device can score
  if (state.match.allowMutualControl) return true;
}