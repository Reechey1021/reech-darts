// app/ghosts/ghosts.js
// Ghost Mode: compact, deterministic replay tokens for X01 legs.
// Storage is local-only (IndexedDB). No Firebase reads/writes.

const DB_NAME = "reech_darts";
const DB_VERSION = 1;
const STORE = "ghosts";

// Token format (versioned):
//   G1:<startScore>:<inRule>:<outRule>:S<startedFlag>:<visitsCsv>[@<checkoutDartsUsed>]
// Example:
//   G1:501:S:D:S1:120,100,45,36,100,60,40@2
// Notes:
// - inRule: S (straight) | D (double)
// - outRule: D (double) | M (master) | S (straight)  (future-proof; current app uses D typically)
// - startedFlag: 1 if the recorded player started the leg, else 0
// - visitsCsv: scored points per visit (busts/check-in-fail encode as 0), 0..180
// - @checkoutDartsUsed is present only if the recorded player checked out (won the leg), 1..3

function clampInt(n, lo, hi) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

export function encodeGhostToken({ startScore, inRule, outRule, started, visits, checkoutDartsUsed = null }) {
  const ss = clampInt(startScore, 1, 10001);
  const ir = (inRule === "double" || inRule === "D") ? "D" : "S";
  const or = (outRule === "master" || outRule === "M") ? "M" : (outRule === "straight" || outRule === "S") ? "S" : "D";
  const st = started ? "1" : "0";

  const safeVisits = Array.isArray(visits) ? visits.map((v) => clampInt(v, 0, 180)) : [];
  const csv = safeVisits.join(",");

  let tok = `G1:${ss}:${ir}:${or}:S${st}:${csv}`;
  const du = Number(checkoutDartsUsed);
  if (Number.isFinite(du) && du >= 1 && du <= 3) tok += `@${Math.floor(du)}`;
  return tok;
}

export function parseGhostToken(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, reason: "EMPTY" };

  // Split off optional @dartsUsed
  const parts = s.split("@");
  const head = parts[0];
  const duRaw = parts.length > 1 ? parts[1] : null;

  const m = head.match(/^G1:(\d+):([SD]):([DMS]):S([01]):([0-9,]*)$/);
  if (!m) return { ok: false, reason: "FORMAT" };

  const startScore = clampInt(m[1], 1, 10001);
  const inRuleCode = m[2];
  const outRuleCode = m[3];
  const started = m[4] === "1";
  const csv = m[5] || "";

  const visits = csv.trim().length
    ? csv.split(",").map((x) => clampInt(x, 0, 180))
    : [];

  let checkoutDartsUsed = null;
  if (duRaw != null && String(duRaw).trim().length) {
    const du = clampInt(duRaw, 1, 3);
    checkoutDartsUsed = du;
  }

  return {
    ok: true,
    token: s,
    startScore,
    inRule: inRuleCode === "D" ? "double" : "straight",
    outRule: outRuleCode === "M" ? "master" : outRuleCode === "S" ? "straight" : "double",
    started,
    visits,
    checkoutDartsUsed,
  };
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("IndexedDB not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "token" });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB open failed"));
  });
}

function withStore(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const res = fn(store);
      tx.oncomplete = () => resolve(res);
      tx.onerror = () => reject(tx.error || new Error("IndexedDB tx failed"));
    } catch (e) {
      reject(e);
    }
  }));
}

export async function listGhosts() {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    try {
      const tx = db.transaction(STORE, "readonly");
      const store = tx.objectStore(STORE);
      const idx = store.index("createdAt");
      const req = idx.openCursor(null, "prev");
      const out = [];
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out.push(cur.value);
          cur.continue();
        } else {
          resolve(out);
        }
      };
      req.onerror = () => reject(req.error || new Error("IndexedDB cursor failed"));
    } catch (e) {
      reject(e);
    }
  });
}

export async function hasGhost(token) {
  const t = String(token || "").trim();
  if (!t) return false;
  return await withStore("readonly", (store) => new Promise((resolve, reject) => {
    const req = store.get(t);
    req.onsuccess = () => resolve(!!req.result);
    req.onerror = () => reject(req.error || new Error("IndexedDB get failed"));
  }));
}

export async function saveGhost(token) {
  // Back-compat wrapper for older callers.
  return await saveGhostNamed(token, "");
}

// Save a ghost token with a user-provided name (required).
export async function saveGhostNamed(token, name) {
  const parsed = parseGhostToken(token);
  if (!parsed.ok) return { ok: false, reason: "INVALID_TOKEN" };

  const nm = String(name || "").trim();
  if (!nm) return { ok: false, reason: "NAME_REQUIRED" };
  // Keep names tidy.
  const safeName = nm.length > 40 ? nm.slice(0, 40) : nm;

  // Ghost Mode only supports won legs (must include checkout darts used).
  if (!(Number.isFinite(parsed.checkoutDartsUsed) && parsed.checkoutDartsUsed >= 1 && parsed.checkoutDartsUsed <= 3)) {
    return { ok: false, reason: "NO_CHECKOUT" };
  }

  const exists = await hasGhost(parsed.token);
  if (exists) return { ok: false, reason: "DUPLICATE" };

  const rec = {
    token: parsed.token,
    name: safeName,
    createdAt: Date.now(),
    startScore: parsed.startScore,
    inRule: parsed.inRule,
    outRule: parsed.outRule,
    started: parsed.started,
    visitsCount: parsed.visits.length,
    hasCheckout: Number.isFinite(parsed.checkoutDartsUsed) && parsed.checkoutDartsUsed >= 1,
  };

  await withStore("readwrite", (store) => {
    store.put(rec);
  });

  return { ok: true, record: rec };
}

export async function deleteGhost(token) {
  const t = String(token || "").trim();
  if (!t) return { ok: false, reason: "EMPTY" };
  await withStore("readwrite", (store) => {
    store.delete(t);
  });
  return { ok: true };
}
