// app/routing.js

function getPathGameId() {
  // Supports pretty URLs:
  //   /game/<id>
  // And file-based fallbacks:
  //   /game/index.html (no id)
  const parts = window.location.pathname.split("/").filter(Boolean);
  // Expect ["game", "<id>"] or just ["game"]
  if (parts.length >= 2 && parts[0] === "game") {
    const id = parts[1];
    return id && id.trim() ? id.trim() : null;
  }
  return null;
}

export function getGameIdFromUrl() {
  const fromPath = getPathGameId();
  if (fromPath) return fromPath;

  // Back-compat: ?game=<id>
  const params = new URLSearchParams(window.location.search);
  const id = params.get("game");
  return id && id.trim() ? id.trim() : null;
}

export function setGameIdInUrl(gameId) {
  const cleaned = (gameId || "").trim();
  if (!cleaned) return;

  const url = new URL(window.location.href);

  // Use query-param routing for robustness on static hosts that don't support
  // history rewrites for /game/<id>.
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length >= 1 && parts[0] === "game") {
    url.pathname = "/game";
  }
  url.searchParams.set("game", cleaned);

  window.history.replaceState({}, "", url.toString());
}


export function clearGameIdFromUrl() {
  const url = new URL(window.location.href);
  const parts = url.pathname.split("/").filter(Boolean);

  if (parts.length >= 1 && parts[0] === "game") {
    url.pathname = "/game";
    url.searchParams.delete("game");
    window.history.replaceState({}, "", url.toString());
    return;
  }

  url.searchParams.delete("game");
  window.history.replaceState({}, "", url.toString());
}
