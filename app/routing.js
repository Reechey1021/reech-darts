// app/routing.js

export function getGameIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("game");
  return id && id.trim() ? id.trim() : null;
}

export function setGameIdInUrl(gameId) {
  const url = new URL(window.location.href);
  url.searchParams.set("game", gameId);
  window.history.replaceState({}, "", url.toString());
}

export function clearGameIdFromUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("game");
  window.history.replaceState({}, "", url.toString());
}
