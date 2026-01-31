// app/routing.js

const KNOWN_PAGES = new Set(["index", "dashboard", "nemesis", "game"]);

export function getBasePrefix() {
  // Supports GitHub Pages project sites like /<repo>/<page>/...
  // If the first segment is not a known page but the second is, treat the first as a base prefix.
  const parts = window.location.pathname.split("/").filter(Boolean);
  if (parts.length >= 2 && KNOWN_PAGES.has(parts[1]) && !KNOWN_PAGES.has(parts[0])) {
    return "/" + parts[0];
  }
  return "";
}

export function withBase(path) {
  const p = String(path || "");
  if (!p.startsWith("/")) return p;
  const base = getBasePrefix();
  return base ? (base + p) : p;
}

function getPathGameId() {
  // Supports:
  //   /game/<id>
  //   /<base>/game/<id>   (GitHub Pages)
  const parts = window.location.pathname.split("/").filter(Boolean);

  // /game/<id>
  if (parts.length >= 2 && parts[0] === "game") {
    const id = parts[1];
    return id && id.trim() ? id.trim() : null;
  }

  // /<base>/game/<id>
  if (parts.length >= 3 && parts[1] === "game") {
    const id = parts[2];
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
  if ((parts.length >= 1 && parts[0] === "game") || (parts.length >= 2 && parts[1] === "game")) {
    url.pathname = withBase("/game");
  }
  url.searchParams.set("game", cleaned);

  window.history.replaceState({}, "", url.toString());
}

export function clearGameIdFromUrl() {
  const url = new URL(window.location.href);
  const parts = url.pathname.split("/").filter(Boolean);

  if ((parts.length >= 1 && parts[0] === "game") || (parts.length >= 2 && parts[1] === "game")) {
    url.pathname = withBase("/game");
    url.searchParams.delete("game");
    window.history.replaceState({}, "", url.toString());
    return;
  }

  url.searchParams.delete("game");
  window.history.replaceState({}, "", url.toString());
}


// Expose for any legacy/non-module code paths.
try { window.withBase = withBase; } catch (_) {}
