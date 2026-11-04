// A seeded generator for programs. page.js bans Math.random, because a frame must depend on its inputs only. three.js calls Math.random for object ids when it loads and when it builds an object.
// So a program runs that code inside withSeeded, and the ban is back when it ends, also after a throw.

/** A repeatable stream of numbers from 0 to 1. The same seed gives the same numbers. */
export const seededStream = (seed = 1) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// The calls still open, newest last, and what Math.random was before the first of them.
const active = [];
let base = null;
/** Runs fn with Math.random drawn from the seeded stream, then restores what was there. fn may be async. Calls may overlap:
 * when one ends, the newest call still open keeps its stream, and the ban comes back only when the last one ends. */
export const withSeeded = (seed, fn) => {
  const mine = seededStream(seed);
  if (!active.length) base = Math.random;
  active.push(mine);
  Math.random = mine;
  const done = () => { active.splice(active.lastIndexOf(mine), 1); Math.random = active.length ? active[active.length - 1] : base; };
  let out;
  try { out = fn(); } catch (e) { done(); throw e; }
  if (out && typeof out.then === "function") return out.finally(done);
  done();
  return out;
};

/** Imports three.js and any addons under the seeded stream. Addon paths are as in the import map: "three/addons/loaders/GLTFLoader.js". */
export const loadThree = (seed = 1, addons = []) => withSeeded(seed, async () => {
  const THREE = await import("three");
  const mods = await Promise.all(addons.map((a) => import(a)));
  return { THREE, addons: mods };
});
