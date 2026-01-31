// app/nemesis/rng.js
// Deterministic RNG helpers so Nemesis is reproducible across undo/replay.

function fnv1a32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  const s = String(str ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSeed(str) {
  return fnv1a32(str);
}

export function makeRng(seedStr, salt = "") {
  const seed = fnv1a32(`${seedStr}::${salt}`);
  return mulberry32(seed);
}

export function rngInt(rng, lo, hi) {
  const a = Math.ceil(lo);
  const b = Math.floor(hi);
  const r = rng();
  return a + Math.floor(r * (b - a + 1));
}

export function rngPick(rng, arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr[rngInt(rng, 0, arr.length - 1)];
}

export function rngWeightedPick(rng, items) {
  // items: [{ v, w }]
  let sum = 0;
  for (const it of items) sum += Math.max(0, Number(it?.w) || 0);
  if (sum <= 0) return items?.[items.length - 1]?.v;
  let r = rng() * sum;
  for (const it of items) {
    r -= Math.max(0, Number(it?.w) || 0);
    if (r <= 0) return it.v;
  }
  return items?.[items.length - 1]?.v;
}

export function rngNormal(rng) {
  // Standard normal via Box–Muller
  let u = 0;
  let v = 0;
  // Avoid 0 for log
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
