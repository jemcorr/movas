// The motion check of the plan pass: steps and spikes on the path of each element. It reads display lists and the optional
// track(params) hook of GL programs, and changes nothing, so it cannot change a plan hash or a pixel.
// Rules (docs/plan-motion.md section 2, frozen):
// - Identity: the op's id, else its kind, colour and text. An id seen once in the frame links to its track at any distance.
//   Look-alikes and repeated ids link nearest-first to each track's predicted position, within 80 px and an area ratio of 0.5 to 2.
// - Step: velocity steady within 1.5 px for 2 frames before and 2 after, and the frame off that path by 10 px, or 4 px on a still path.
// - Spike: velocities before and after agree within 1.5 px, and the frame is 10 px or more off the midpoint of its neighbours.
// - Both count only while the centre is in frame at opacity 0.5 or more. A scene start, a gap and a program's own cut close tracks.
import { mul3 } from "./reelrt.js";
import { scanFrame } from "./scan.js";

const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const SNAP = 10, STILL_SNAP = 4, STILL = 0.5, EVEN = 1.5, GATE = 80, KEEP = 6, SEEN_A = 0.5, CAP = 2000;

// The last KEEP samples of one element in one buffer: x at 0, y at KEEP, opacity at 2 * KEEP. Shifted in place, never reallocated.
class Track {
  constructor(key, owner, area, by) { this.key = key; this.owner = owner; this.by = by; this.la = area; this.n = 0; this.s = new Float64Array(3 * KEEP); }
  push(x, y, a, area) {
    const s = this.s;
    if (this.n === KEEP) { for (let k = 0; k < 3 * KEEP - 1; k++) s[k] = s[k + 1]; this.n--; }
    const n = this.n; s[n] = x; s[KEEP + n] = y; s[2 * KEEP + n] = a; this.n = n + 1; this.la = area;
  }
  // The distance from where the path puts the next sample (a constant-velocity step from the last two), or -1 past the gate.
  fits(x, y, area) {
    const s = this.s, n = this.n, px = n > 1 ? 2 * s[n - 1] - s[n - 2] : s[n - 1], py = n > 1 ? 2 * s[KEEP + n - 1] - s[KEEP + n - 2] : s[KEEP + n - 1];
    const d = Math.hypot(px - x, py - y), ar = area / Math.max(1, this.la);
    return d <= GATE && ar > 0.5 && ar < 2 ? d : -1;
  }
}

/** One run of frames with no scene start inside: tracks open at its first frame and close at its end. */
export class Motion {
  constructor({ W, H, programs, comp, now, sceneAt, drawer = () => null, installedBy = {} }) {
    Object.assign(this, { W, H, programs, comp, now, sceneAt, drawer, installedBy });
    this.open = new Map(); this.events = []; this.n = 0; this.ms = 0; this.scanMs = 0; this.hookMs = 0; this.items = 0; this.hookItems = 0;
    this.hooked = new Set(); this.blind = new Set();
    // This frame's items as parallel columns, reused from frame to frame.
    this.ik = []; this.ix = []; this.iy = []; this.iar = []; this.ia = []; this.io = []; this.ib = []; this.m = 0;
  }
  gls(list, M = I3, op = 1, out = []) {
    for (const o of list) {
      if (!o) continue;
      const m = o.m ? mul3(M, o.m) : M, a = op * (o.opacity ?? 1);
      if (o.op === "group") this.gls(o.children ?? [], m, a, out); else if (o.op === "gl") out.push({ o, m, a });
    }
    return out;
  }
  add(key, x, y, area, a, owner, by) { const j = this.m++; this.ik[j] = key; this.ix[j] = x; this.iy[j] = y; this.iar[j] = area; this.ia[j] = a; this.io[j] = owner; this.ib[j] = by; }
  frame(f, list) {
    const t0 = this.now();
    this.m = 0;
    const s0 = this.now(); const scanned = scanFrame(list, this.comp); this.scanMs += this.now() - s0;
    for (const it of scanned) {
      if (it.k !== "t" && it.k !== "r" && it.k !== "i" && it.k !== "h") continue;
      const b = it.b, area = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
      if (it.a < 0.02 || area < 16) continue;
      const key = it.id ? `${it.k}:${it.id}` : it.k === "t" ? `t|${it.tx}|${it.ink}` : `${it.k}|${it.c ?? ""}`;
      this.add(key, (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, area, it.a, it.id ? it.id.split(".").slice(0, 2).join(".") : "-", this.drawer(it.sc ?? null));
      this.items++;
    }
    // A GL op is one image to the list. A program's track(params) names what moves inside it, in the op's frame space.
    for (const { o, m, a } of this.gls(list)) {
      const prog = this.programs[o.program];
      if (typeof prog?.track !== "function") { this.blind.add(o.program); continue; }
      this.hooked.add(o.program);
      const h0 = this.now(); const r = prog.track(o.params) ?? {}; this.hookMs += this.now() - h0;
      const pre = `g:${o.program}:`, by = this.installedBy[`p:${o.program}`] ?? null;
      if (r.cut) for (const k of [...this.open.keys()]) if (k.startsWith(pre)) this.open.delete(k);
      for (const p of r.items ?? []) {
        const w = m[6] * p.x + m[7] * p.y + m[8];
        this.add(pre + p.id, (m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w, Math.max(16, (p.w ?? 10) * (p.h ?? 10)), a * (p.a ?? 1), o.program, by);
        this.hookItems++;
      }
    }
    // Items per key: the first index, and the rest only for keys seen more than once.
    const first = new Map(), more = new Map();
    for (let j = 0; j < this.m; j++) {
      const k = this.ik[j], at = first.get(k);
      if (at === undefined) first.set(k, j); else { const l = more.get(k); if (l) l.push(j); else more.set(k, [at, j]); }
    }
    const next = new Map();
    for (const [key, j0] of first) {
      const cur = this.open.get(key), group = more.get(key);
      if (!group && (!cur || cur.length === 1)) {
        // One element under this key and at most one open track. An id seen once links at any distance.
        let t = cur ? cur[0] : null;
        if (t && key.includes("|") && t.fits(this.ix[j0], this.iy[j0], this.iar[j0]) < 0) t = null;
        if (!t) t = new Track(key, this.io[j0], this.iar[j0], this.ib[j0]);
        this.step(t, j0, f);
        if (cur && cur[0] === t) next.set(key, cur); else next.set(key, [t]);
        continue;
      }
      const idx = group ?? [j0], pairs = [];
      for (let q = 0; q < idx.length; q++) for (const t of cur ?? []) { const j = idx[q], d = t.fits(this.ix[j], this.iy[j], this.iar[j]); if (d >= 0) pairs.push([d, q, t]); }
      pairs.sort((p, r) => p[0] - r[0] || p[1] - r[1]);
      const got = new Map(), taken = new Set();
      for (const [, q, t] of pairs) { if (got.has(q) || taken.has(t)) continue; got.set(q, t); taken.add(t); }
      const out = [];
      for (let q = 0; q < idx.length; q++) { const j = idx[q], t = got.get(q) ?? new Track(key, this.io[j], this.iar[j], this.ib[j]); this.step(t, j, f); out.push(t); }
      next.set(key, out);
    }
    this.open = next;
    this.ms += this.now() - t0;
  }
  step(t, j, f) { t.push(this.ix[j], this.iy[j], this.ia[j], this.iar[j]); if (t.n >= 5) this.test(t, f); }
  lit(t, from, to) { const s = t.s; for (let k = from; k < to; k++) if (s[2 * KEEP + k] < SEEN_A) return false; return true; }
  seen(t, q) { const x = t.s[q], y = t.s[KEEP + q]; return x >= 0 && x <= this.W && y >= 0 && y <= this.H; }
  hit(t, f, k, d, still) {
    this.n++;
    if (this.events.length < CAP) this.events.push({ k, f: f - 2, sc: this.sceneAt(f - 2), owner: t.owner, ...(t.by ? { by: t.by } : {}), key: t.key.slice(0, 60), d: Math.round(d * 10) / 10, ...(still ? { still: 1 } : {}) });
  }
  // Tests the sample two frames back, once the two after it are in. Axis x first, then y; one event per test.
  test(t, f) {
    const n = t.n, i = n - 3, s = t.s;
    if (this.lit(t, i - 2, i + 3) && this.seen(t, i - 1)) {
      for (let o = 0; o <= KEEP; o += KEEP) {
        const vb = s[o + i - 1] - s[o + i - 2], va = s[o + i + 2] - s[o + i + 1], off = s[o + i] - (s[o + i - 1] + s[o + i + 1]) / 2;
        if (Math.abs(vb - va) <= EVEN && Math.abs(off) >= SNAP && Math.abs((s[o + i + 1] - s[o + i - 1]) / 2 - vb) <= EVEN) { this.hit(t, f, "spike", off, false); break; }
      }
    }
    if (n >= 6 && this.lit(t, i - 3, i + 3) && this.seen(t, i - 1) && this.seen(t, i)) {
      for (let o = 0; o <= KEEP; o += KEEP) {
        const v0 = s[o + i - 1] - s[o + i - 2];
        const still = Math.abs(v0) <= STILL && Math.abs(s[o + i + 1] - s[o + i]) <= STILL, lim = still ? STILL_SNAP : SNAP;
        if (Math.abs(s[o + i - 2] - s[o + i - 3] - v0) <= EVEN && Math.abs(s[o + i + 1] - s[o + i] - v0) <= EVEN && Math.abs(s[o + i + 2] - s[o + i + 1] - v0) <= EVEN && Math.abs(s[o + i] - s[o + i - 1] - v0) >= lim) {
          this.hit(t, f, "step", s[o + i] - s[o + i - 1] - v0, still); break;
        }
      }
    }
  }
}
