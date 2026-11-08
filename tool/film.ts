// `./movas film`: the film as text. Everything here is computed from the score, the display list and the encoded file. No model runs.
// The core holds no format's rules and no film's words. The rules live in tool/packs and in the film's folder, in the language of rules.ts.
import { allOf, assignPanels, evaluate, limitOf, type Meaning, type Row } from "./rules.ts";

// ---------- colour ----------
const NAMED: Record<string, number[]> = { white: [255, 255, 255], black: [0, 0, 0] };
export const parseCss = (c: string | null | undefined): number[] | null => {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  if (NAMED[s]) return [...NAMED[s], 1];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) { const h = m[1].length <= 4 ? [...m[1]].map((x) => x + x).join("") : m[1]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length > 6 ? parseInt(h.slice(6, 8), 16) / 255 : 1]; }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0], p[1], p[2], p[3] ?? 1]; }
  return null;
};
const lin = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
const lum = (c: number[]) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export const contrast = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const lab = (c: number[]) => {
  const [r, g, b] = [lin(c[0]), lin(c[1]), lin(c[2])];
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};
export const deltaE = (a: number[], b: number[]) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
/** A colour word from hue and chroma. Only words, no meaning. */
export const family = (c: number[] | null): string => {
  if (!c) return "none";
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (l > 0.97 || (s < 0.1 && l > 0.9)) return "white";
  if (l < 0.08) return "black";
  if (s < 0.1 || d < 0.04) return "grey";
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return h < 20 || h >= 340 ? "red" : h < 45 ? "orange" : h < 70 ? "yellow" : h < 170 ? "green" : h < 200 ? "cyan" : h < 260 ? "blue" : h < 300 ? "purple" : "pink";
};
const toHex = (c: number[] | null) => c ? "#" + c.slice(0, 3).map((x) => Math.round(x).toString(16).padStart(2, "0")).join("") : "-";

// ---------- reading the scan ----------
type Item = { k: string; id: string | null; tx?: string; ink?: string; c?: string | null; b: number[]; a: number; v: number; px?: number; sc: string | null; d?: number; br?: number; gb?: number; sp?: number[] | null };
export const readScan = (path: string) => {
  const rows = new Map<number, Item[]>();
  for (const line of Deno.readTextFileSync(path).split("\n")) if (line) { const [f, items] = JSON.parse(line); rows.set(f, items); }
  return rows;
};
const inside = (o: number[], i: number[], m = 2) => o[0] - m <= i[0] && o[1] - m <= i[1] && o[2] + m >= i[2] && o[3] + m >= i[3];
const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlap = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

type Track = { key: string; k: string; id: string | null; tx?: string; sc: string | null; d: boolean; frames: number[]; x: number[]; y: number[]; a: number[]; v: number[]; legible: boolean[]; area: number; lastArea: number; maxCover: number; coverFrames: number; coverBy?: string };
/** Follows each leaf across frames: same id, or same words and size and colour, matched to the nearest position in the frame before. */
export const buildTracks = (rows: Map<number, Item[]>, frames: number[], coverShare: number) => {
  const open = new Map<string, Track[]>(), done: Track[] = [];
  const close = (t: Track) => { if (t.frames.length) done.push(t); };
  let prev = -2;
  for (const f of frames) {
    const items = rows.get(f) ?? [];
    if (f !== prev + 1) { for (const l of open.values()) l.forEach(close); open.clear(); }
    const used = new Set<Track>(), byKey = new Map<string, Item[]>();
    for (const it of items) {
      if (it.k !== "t" && it.k !== "r" && it.k !== "i" && it.k !== "h") continue;
      if (it.a < 0.02 || area(it.b) < 16) continue;
      const key = it.id ? `${it.k}:${it.id}` : it.k === "t" ? `t|${it.tx}|${it.ink}` : `${it.k}|${it.c ?? ""}`;
      (byKey.get(key) ?? byKey.set(key, []).get(key)!).push(it);
    }
    for (const [key, list] of byKey) {
      const cur = open.get(key) ?? [];
      for (const it of list) {
        const cx = (it.b[0] + it.b[2]) / 2, cy = (it.b[1] + it.b[3]) / 2;
        let best: Track | null = null, bd = 1e9;
        // Same key, the frame before, within 80 px and half to double the area: otherwise it is another element.
        let second = 1e9;
        for (const t of cur) if (!used.has(t) && t.frames[t.frames.length - 1] === f - 1) { const d = Math.hypot(t.x[t.x.length - 1] - cx, t.y[t.y.length - 1] - cy), ar = area(it.b) / Math.max(1, t.lastArea); if (it.id || (d <= 80 && ar > 0.5 && ar < 2)) { if (d < bd) { second = bd; bd = d; best = t; } else if (d < second) second = d; } }
        // Twins: two look-alike candidates at about the same distance. The match would be a guess, so the element starts a new path.
        if (best && !it.id && bd > 2 && second < bd * 1.5) best = null;
        if (!best) { best = { key, k: it.k, id: it.id, tx: it.tx, sc: it.sc, d: !!it.d, frames: [], x: [], y: [], a: [], v: [], legible: [], area: 0, lastArea: area(it.b), maxCover: 0, coverFrames: 0 }; cur.push(best); }
        used.add(best); best.frames.push(f); best.x.push(cx); best.y.push(cy); best.a.push(it.a); best.v.push(it.v); best.area = Math.max(best.area, area(it.b)); best.lastArea = area(it.b); best.legible.push((it.br ?? 1) * it.a >= 0.35 && (it.gb ?? 0) <= 3);
      }
      open.set(key, cur);
    }
    for (const [k, l] of open) { const keep = l.filter((t) => { if (t.frames[t.frames.length - 1] === f) return true; close(t); return false; }); if (keep.length) open.set(k, keep); else open.delete(k); }
    // Words covered by a later opaque rect in the same frame.
    items.forEach((it, i) => {
      // Only words a viewer could read: inside their clips, not dimmed under 0.35, blurred 3 px or less. A chat line scrolling under its header is clipped, so it is not counted.
      if (it.k !== "t" || it.a < 0.5 || it.v < 0.98 || (it.br ?? 1) * it.a < 0.35 || (it.gb ?? 0) > 3) return;
      let cover = 0; const a0 = area(it.b);
      for (let j = i + 1; j < items.length; j++) { const o = items[j]; if (o.k !== "r" || o.a < 0.9 || (parseCss(o.c)?.[3] ?? 1) < 0.9) continue; cover = Math.max(cover, a0 ? overlap(it.b, o.b) / a0 : 0); }
      if (cover > 0.05) {
        const key = it.id ? `t:${it.id}` : `t|${it.tx}|${it.ink}`, cx = (it.b[0] + it.b[2]) / 2, cy = (it.b[1] + it.b[3]) / 2;
        let best: Track | null = null, bd = 1e9;
        for (const t of open.get(key) ?? []) { if (t.frames[t.frames.length - 1] !== f) continue; const d = Math.hypot(t.x[t.x.length - 1] - cx, t.y[t.y.length - 1] - cy); if (d < bd) { bd = d; best = t; } }
        if (best) { best.maxCover = Math.max(best.maxCover, cover); if (cover >= coverShare) best.coverFrames++; }
      }
    });
    prev = f;
  }
  for (const l of open.values()) l.forEach(close);
  return done;
};

// ---------- facts of a drawn text ----------
const landedFrame = (rows: Map<number, Item[]>, id: string, tx: string, from: number, to: number) => {
  let best: { f: number; it: Item; idx: number } | null = null;
  const stem = (s: string) => s.replace(/\s+/g, " ").trim();
  const want = stem(tx.replace(/\*/g, "").replace(/\s\/\s/g, " "));
  for (let f = from; f < to; f++) {
    const items = rows.get(f); if (!items) continue;
    const idx = items.findIndex((x) => x.k === "t" && (x.id === id || (x.id?.startsWith(`${id}.`) ?? false) || (!x.id && x.tx && stem(x.tx).length >= 3 && want.startsWith(stem(x.tx)))));
    if (idx >= 0 && items[idx].a >= 0.9) { best = { f, it: items[idx], idx }; if (f >= from + 12) break; }
  }
  return best;
};
const containers = (items: Item[], idx: number) => {
  const t = items[idx]; const out: Item[] = [];
  for (let j = idx - 1; j >= 0; j--) { const o = items[j]; if (o.k === "r" && (parseCss(o.c)?.[3] ?? 1) > 0.3 && inside(o.b, t.b, 4)) out.push(o); }
  return out.sort((a, b) => area(a.b) - area(b.b));
};
const drawnFacts = (rows: Map<number, Item[]>, r: Row, W: number, H: number, sceneEnd: number) => {
  const got = landedFrame(rows, r.id, r.text, r.at, Math.min(r.at + 90, sceneEnd));
  if (!got) return null;
  const items = rows.get(got.f)!, cs = containers(items, got.idx), own = cs[0], parent = cs[1];
  const bx = own ? own.b : got.it.b, pb = parent ? parent.b : [0, 0, W, H];
  const gapL = bx[0] - pb[0], gapR = pb[2] - bx[2], width = pb[2] - pb[0];
  const align = bx[2] - bx[0] > width * 0.9 ? "full" : Math.abs(gapL - gapR) < width * 0.08 ? "center" : gapL < gapR ? "left" : "right";
  const fill = own ? parseCss(own.c) : null, ink = parseCss(got.it.ink);
  return { frame: got.f, align, fill: toHex(fill), family: own ? family(fill) : "none", ink: toHex(ink), inkFamily: family(ink), contrast: fill && ink ? Math.round(contrast(fill, ink) * 10) / 10 : null, px: Math.round(got.it.px ?? 0), inPanel: !!parent, boxed: own && area(own.b) <= 6 * area(got.it.b) ? 1 : 0, alpha: got.it.a, fillRgb: fill };
};
const fmt = (f: number, fps: number) => { const s = f / fps, m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`; };
const clean = (s: string) => s.replace(/\*/g, "").replace(/\s+\/\s+/g, " / ").replace(/\\n/g, " / ").replace(/\n/g, " / ");
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

export const buildReport = (o: { s: any; checks: any; rows: Map<number, Item[]>; meaning: Meaning; px: any | null; sections: Set<string>; W: number; H: number; onHits?: (hits: { key: string; msg: string; unvalidated: boolean }[]) => void }) => {
  const { s, rows, meaning, px, sections, W, H } = o;
  const fps = s.clock.fps, scenes = [...s.scenes].sort((a: any, b: any) => a.startFrame - b.startFrame), frames = [...rows.keys()].sort((a, b) => a - b);
  const refRead = (words: number, verb: string) => { const r = s.film.rules?.find((x: any) => x.id === `read.${verb}`); const per = parseFloat(r?.kv?.per_word ?? "0.2"), base = parseFloat(r?.kv?.base ?? "0.5"); return base + per * words; };
  // Beats: score lines with words, ordered in time. A line's own sub-lines (word groups, wraps) count with it.
  const beats: Row[] = [];
  for (const t of s.texts) {
    const eid = t.at, at = s.events[eid]?.frame ?? s.events[t.id]?.frame;
    if (at === undefined || t.id.split(".").length > 2) continue;
    if (t.verb === "panel") continue;
    beats.push({ id: t.id, scene: t.scene, verb: t.verb, text: t.text, words: t.words, kv: t.kv, at });
  }
  beats.sort((a, b) => a.at - b.at);
  const lim = (name: string) => limitOf(meaning, name);
  const tracks = buildTracks(rows, frames, lim("cover.share"));
  // A line's drawn value over time: the words of its elements in each frame, as runs. A flip or a typed line shows here as more than one run.
  const textRuns = new Map<string, { text: string; ink: string; first: number; last: number }[]>();
  for (const f of frames) {
    const now = new Map<string, { parts: string[]; ink: string }>();
    for (const it of rows.get(f) ?? []) {
      if ((it.k !== "t" && it.k !== "h") || !it.id || !it.tx || it.a < 0.5) continue;
      const root = it.id.split(".").slice(0, 2).join(".");
      const e = now.get(root) ?? now.set(root, { parts: [], ink: it.ink ?? "" }).get(root)!;
      e.parts.push(it.tx);
    }
    for (const [root, e] of now) {
      const text = e.parts.join(" "), list = textRuns.get(root) ?? textRuns.set(root, []).get(root)!, last = list[list.length - 1];
      if (last && last.text === text && last.ink === e.ink && last.last === f - 1) last.last = f; else list.push({ text, ink: e.ink, first: f, last: f });
    }
  }
  const sceneOf = (f: number) => scenes.find((x: any) => f >= x.startFrame && f < x.endFrame);
  for (const b of beats) {
    const mine = tracks.filter((t) => t.k === "t" && t.id && (t.id === b.id || t.id.startsWith(`${b.id}.`)));
    if (mine.length) {
      const vis = mine.flatMap((t) => t.frames.filter((_, i) => t.a[i] >= 0.5));
      b.first = vis.length ? Math.min(...vis) : undefined; b.last = vis.length ? Math.max(...vis) : undefined;
      const fullSet = new Set(mine.flatMap((t) => t.frames.filter((_, i) => t.a[i] >= 0.9 && t.v[i] >= 0.98)));
      b.full = fullSet.size;
      b.legible = new Set(mine.flatMap((t) => t.frames.filter((_, i) => t.legible[i] && t.v[i] >= 0.98))).size;
      b.clip = Math.max(...mine.map((t) => t.v.filter((x, i) => x < 0.98 && t.a[i] >= 0.5).length));
    }
    b.runs = textRuns.get(b.id);
    b.read = refRead(b.words, b.verb);
    const sc = s.scenes.find((x: any) => x.id === b.scene);
    b.drawn = drawnFacts(rows, b, W, H, sc?.endFrame + (sc?.post ?? 0)) ?? undefined;
  }
  const L: string[] = [], flags: string[] = [];
  const flag = (cls: string, msg: string) => flags.push(`${cls}: ${msg}`);

  const msgs = beats.filter((b) => b.kv?.in !== undefined);

  // ---------- motion ----------
  const eventFrames = new Set<number>();
  for (const e of Object.values<any>(s.events)) eventFrames.add(e.frame);
  for (const x of s.sfx) eventFrames.add(x.frame);
  const nearEvent = (f: number, back: number, fwd = 2) => { for (let d = -fwd; d <= back; d++) if (eventFrames.has(f - d)) return true; return false; };
  type SM = { moved: number; maxV: number; maxVid: string; shake: number; jitter: { id: string; f: number; n: number; amp: number }[]; jump: { id: string; f: number; d: number }[]; spike: { id: string; f: number; d: number }[]; popIn: { id: string; f: number }[]; popOut: number; clipped: { id: string; n: number }[]; covered: Track[]; decor: number; floatN: number; floatV: number; snap: Map<number, number> };
  const SMs = new Map<string, SM>();
  const sm = (id: string): SM => SMs.get(id) ?? SMs.set(id, { moved: 0, maxV: 0, maxVid: "", shake: 0, jitter: [], jump: [], spike: [], popIn: [], popOut: 0, clipped: [], covered: [], decor: 0, floatN: 0, floatV: 0, snap: new Map() }).get(id)!;
  const JIT_REV = lim("jitter.reversals"), JIT_AMP = lim("jitter.amp_px"), JIT_WIN = lim("jitter.window_frames"), JUMP = 60, SPIKE = lim("spike.px"), COVER_FRAMES = lim("cover.frames"), SNAP_PX = lim("snap.px"), SNAP_EVEN = lim("snap.even_px");
  for (const t of tracks) {
    const sc = t.sc ?? sceneOf(t.frames[0])?.id ?? "(none)"; const M = sm(sc), name = t.id ?? (t.tx ? `"${t.tx.slice(0, 18)}"` : t.key.slice(0, 24));
    if (t.k === "t" && t.d) M.decor++;
    let maxV = 0, path = 0; const n = t.frames.length;
    for (const axis of [t.x, t.y]) {
      const rev: number[] = [];
      let lastSign = 0;
      for (let i = 1; i < n; i++) {
        const v = axis[i] - axis[i - 1], av = Math.abs(v); maxV = Math.max(maxV, av); path += av;
        if (av >= JIT_AMP && t.a[i] >= 0.2) { const sg = Math.sign(v); if (lastSign && sg !== lastSign) rev.push(i); lastSign = sg; }
      }
      for (let i = 0; i < rev.length; i++) {
        let j = i; while (j + 1 < rev.length && rev[j + 1] - rev[i] <= JIT_WIN) j++;
        if (j - i + 1 >= JIT_REV) {
          const f0 = t.frames[rev[i]];
          if (nearEvent(f0, 9, 2)) M.shake++;
          else M.jitter.push({ id: name, f: f0, n: j - i + 1, amp: Math.max(...rev.slice(i, j + 1).map((q) => Math.abs(axis[q] - axis[q - 1]))) });
          i = j;
        }
      }
    }
    for (let i = 2; i < n - 1; i++) {
      const d = Math.hypot(t.x[i] - t.x[i - 1], t.y[i] - t.y[i - 1]), before = Math.hypot(t.x[i - 1] - t.x[i - 2], t.y[i - 1] - t.y[i - 2]), after = Math.hypot(t.x[i + 1] - t.x[i], t.y[i + 1] - t.y[i]);
      if (d >= JUMP && d > 4 * Math.max(before, after, 5) && t.a[i] >= 0.5 && t.a[i - 1] >= 0.5 && !nearEvent(t.frames[i], 1, 1)) M.jump.push({ id: name, f: t.frames[i], d: Math.round(d) });
      // A spike: off the path by the limit or more, back within 2 frames to where the path continues.
      for (const k of [1, 2]) if (i + k < n) { const away = Math.hypot(t.x[i] - t.x[i - 1], t.y[i] - t.y[i - 1]), back = Math.hypot(t.x[i + k] - t.x[i - 1], t.y[i + k] - t.y[i - 1]); if (away >= SPIKE && back <= Math.max(6, away * 0.2) && !nearEvent(t.frames[i], 1, 1)) { M.spike.push({ id: name, f: t.frames[i], d: Math.round(away) }); break; } }
    }
    for (let i = 3; i < n - 2; i++) {
      if (Math.min(...t.a.slice(i - 3, i + 3)) < 0.5 || nearEvent(t.frames[i], 2, 2) || t.frames[i] - t.frames[i - 3] !== 3 || t.frames[i + 2] - t.frames[i] !== 2) continue;
      const seen = (q: number) => t.x[q] >= 0 && t.x[q] <= W && t.y[q] >= 0 && t.y[q] <= H;
      if (!seen(i - 1) || !seen(i)) continue;
      for (const A of [t.x, t.y]) {
        const v0 = A[i - 1] - A[i - 2], steady = (v: number) => Math.abs(v - v0) <= SNAP_EVEN;
        if (steady(A[i - 2] - A[i - 3]) && steady(A[i + 1] - A[i]) && steady(A[i + 2] - A[i + 1]) && Math.abs(A[i] - A[i - 1] - v0) >= SNAP_PX) { M.snap.set(t.frames[i], (M.snap.get(t.frames[i]) ?? 0) + 1); break; }
      }
    }
    if (maxV > 0.05) { M.moved++; if (maxV > M.maxV) { M.maxV = maxV; M.maxVid = name; } if (maxV < 0.6 && n > 45) { M.floatN++; M.floatV = Math.max(M.floatV, maxV); } }
    const big = t.area >= W * H * 0.01, sceneRow = scenes.find((x: any) => x.id === sc);
    if (big && n >= 10 && t.a[0] >= 0.9 && sceneRow && t.frames[0] > sceneRow.startFrame + 1 && !nearEvent(t.frames[0], 2, 2)) M.popIn.push({ id: name, f: t.frames[0] });
    if (big && n >= 10 && t.a[n - 1] >= 0.9 && sceneRow && t.frames[n - 1] < sceneRow.endFrame + (sceneRow.post ?? 0) - 2 && !nearEvent(t.frames[n - 1], 2, 2)) M.popOut++;
    if (t.k === "t" && t.id) { const c = t.v.filter((x, i) => x < 0.98 && t.a[i] >= 0.5).length; if (c >= 3) M.clipped.push({ id: t.id, n: c }); }
    if (t.k === "t" && t.coverFrames >= COVER_FRAMES) M.covered.push(t);
  }
  const glFrames = new Map<string, { n: number; names: Set<string>; filt: number }>();
  for (const f of frames) for (const it of rows.get(f) ?? []) {
    if (it.k === "g") { const sc = it.sc ?? sceneOf(f)?.id ?? "(stage)"; const e = glFrames.get(sc) ?? glFrames.set(sc, { n: 0, names: new Set(), filt: 0 }).get(sc)!; e.n++; e.names.add(it.id!); }
  }
  // Measured facts for the rule language. Below a limit a number stays in the motion table as a fact. The limits live in tool/packs/craft.meaning.
  const pxBy = new Map<string, any>((px?.scenes ?? []).map((x: any) => [x.id, x]));
  const facts: Row[] = [];
  for (const sc of scenes as any[]) {
    const M = sm(sc.id), x = pxBy.get(sc.id), g = glFrames.get(sc.id);
    const per = new Map<string, number>(); for (const j of M.jitter) per.set(j.id, (per.get(j.id) ?? 0) + 1);
    const sustained = [...per].filter(([, n]) => n >= lim("jitter.runs"));
    const blind = g ? "the scene has GL content the display list cannot see, so a pass here covers list elements only" : "";
    const d = M.covered.filter((t) => t.d).length, w = M.covered.filter((t) => !t.d);
    facts.push({ id: sc.id, scene: sc.id, verb: "scene", text: "", words: 0, kv: {}, at: sc.startFrame,
      facts: { words_cut: M.covered.length, jitter_elements: sustained.length, spikes: M.spike.length, flow_jitter: x ? x.jitCellSecs : null, group_snap: Math.max(0, ...M.snap.values()) },
      partial: blind ? { words_cut: blind, jitter_elements: blind, spikes: blind, group_snap: blind } : {},
      details: {
        words_cut: `${d} decoration, ${w.length} score lines. The existing checks skip decoration. ${M.covered.slice(0, 3).map((t) => `${t.id ?? `"${t.tx}"`} up to ${Math.round(t.maxCover * 100)}%`).join(", ")}`,
        jitter_elements: sustained.length ? `${sustained.slice(0, 3).map(([id, n]) => `${id} ${n} runs`).join(", ")}; first at f${M.jitter.find((j) => j.id === sustained[0][0])!.f}` : "",
        spikes: M.spike.slice(0, 3).map((j) => `${j.id} ${j.d} px at f${j.f}`).join(", "),
        flow_jitter: x ? `up to ${x.revMax} a second in cell ${x.revCell}` : "",
        group_snap: [...M.snap].sort((p, q) => q[1] - p[1]).slice(0, 3).map(([f, c]) => `${c} at f${f}`).join(", "),
        ...(px && !x ? { "flow_jitter.why": "the pixel pass of the encoded file has no row for this scene" } : {}),
      } });
  }
  const au = px?.audio, haveSound = au && !au.none;
  const silent = haveSound ? (au.silence ?? []).filter((q: number[]) => (q[1] - q[0]) / fps >= lim("silence.seconds")) : [];
  const noSound = au?.none ? "the encoded file has no audio" : "no encoded file was given, so this was not measured";
  const filmRow: Row = { id: "film", scene: "", verb: "film", text: "", words: 0, kv: {}, at: 0,
    facts: {
      clip_samples: haveSound ? au.clipSamples : null,
      silence_s: haveSound ? Math.max(0, ...silent.map((q: number[]) => Math.round((q[1] - q[0]) / fps * 10) / 10)) : null,
      cue_lag_frames: haveSound && au.sfxN ? ((au.sfxLagOver0 ?? 0) >= lim("sync.over0_db") ? Math.abs(au.sfxLagFrames ?? 0) : 0) : null,
      bed_off_ms: haveSound && au.bedPhaseMs !== undefined ? (au.bedPhasePeak >= lim("bed.peak") ? Math.abs(au.bedPhaseMs) : 0) : null,
    },
    details: {
      "clip_samples.why": noSound, "silence_s.why": noSound, "cue_lag_frames.why": haveSound ? "the film has no event sounds" : noSound, "bed_off_ms.why": haveSound ? "the film has no beat grid, so the bed's beat has nothing to sit on" : noSound,
      clip_samples: haveSound ? `${au.clipRuns.length} runs: ${au.clipRuns.slice(0, 5).map((r: number[]) => `f${r[0]}-${r[1]}`).join(", ")}` : "",
      silence_s: silent.map((q: number[]) => `f${q[0]} to f${q[1]} in ${sceneOf(q[0])?.id ?? "?"}`).join(", "),
      cue_lag_frames: haveSound ? `${au.sfxN} events, the rise there is ${au.sfxLagOver0} dB above the rise at the cue itself` : "",
      bed_off_ms: haveSound && au.bedPhaseMs !== undefined ? `peak ${au.bedPhasePeak}x` : "",
    } };
  facts.push(filmRow);

  // ---------- rules ----------
  assignPanels(beats, rows as any, scenes.map((x: any) => x.id), s.panels ?? {}, W, H);
  const lines = [...beats, ...facts];
  const result = evaluate(meaning, lines, fps);
  const quote = (r: Row) => `${r.id} "${clean(r.text).slice(0, 28)}"`;
  const ending = (h: { note: string; from: string }) => `${h.note ? ` Limit ${h.note}.` : ""} From ${h.from}.`;
  // A rule that compares two groups of lines: their usual drawn facts must differ.
  // A rule set on one film only is reported as unvalidated; it is a warning until a second film checks it.
  const unv = (n?: string) => (n ?? "").includes("set on one film") ? "warn (unvalidated) " : "";
  const mHits: { key: string; msg: string; unvalidated: boolean }[] = [];
  for (const al of meaning.alikes) {
    const pick = (terms: typeof al.a) => beats.filter((b) => allOf(meaning, terms, b, fps).ok === true && b.drawn?.fillRgb);
    const A = pick(al.a), B = pick(al.b);
    if (!A.length || !B.length) continue;
    const modal = (l: Row[], f: (r: Row) => string) => { const c = new Map<string, number>(); for (const r of l) c.set(f(r), (c.get(f(r)) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0][0]; };
    const fa = parseCss(modal(A, (r) => r.drawn!.fill)), fb = parseCss(modal(B, (r) => r.drawn!.fill)), aa = modal(A, (r) => r.drawn!.align), ab = modal(B, (r) => r.drawn!.align);
    const de = fa && fb ? deltaE(fa, fb) : 99;
    if (aa === ab && de < lim("alike.delta")) {
      flag(`${unv(al.note)}rule ${al.id}`, `${al.say}: both ${aa}, fill ${toHex(fa)} and ${toHex(fb)}, deltaE ${de.toFixed(1)}. ${A.length} and ${B.length} lines, first ${A[0].id}, ${B[0].id}.${ending(al)}`);
      mHits.push({ key: `${al.id}|alike`, msg: `${al.say}`, unvalidated: unv(al.note) !== "" });
    }
  }
  for (const h of result.hits) if (h.row.verb !== "scene" && h.row.verb !== "film") mHits.push({ key: `${h.rule}|${h.row.id}`, msg: `${h.say} on ${h.row.id}${h.want !== undefined ? ` (expected ${h.want}, drawn ${h.got})` : ""}`, unvalidated: (h.note ?? "").includes("set on one film") });
  o.onHits?.(mHits);
  const byRule = new Map<string, typeof result.hits>();
  for (const h of result.hits) (byRule.get(h.rule) ?? byRule.set(h.rule, []).get(h.rule)!).push(h);
  for (const [id, hs] of byRule) {
    const h = hs[0], row = h.row;
    if (row.verb === "scene" || row.verb === "film") {
      for (const x of hs) flag(`${unv(x.note)}rule ${id}`, `${x.say}. Expected ${x.want}, got ${x.got}, on ${x.row.id}${x.row.details?.[x.field!] ? `: ${x.row.details[x.field!]}` : ""}.${ending(x)}`);
    } else if (h.field) {
      const sets = new Map<string, typeof hs>();
      for (const x of hs) { const k = `${x.want}|${x.got}`; (sets.get(k) ?? sets.set(k, []).get(k)!).push(x); }
      for (const l of sets.values()) flag(`${unv(l[0].note)}rule ${id}`, `${l[0].say}. Expected ${l[0].want}, drawn ${l[0].got}, on ${l.length} lines: ${l.slice(0, 4).map((x) => quote(x.row)).join(", ")}${l.length > 4 ? ", ..." : ""}.${ending(h)}`);
    } else {
      const ex = hs.slice(0, 4).map((x) => `${quote(x.row)}${x.evidence?.length ? ` beside ${x.evidence.slice(0, 2).map(quote).join(", ")}` : ""}`).join("; ");
      flag(`${unv(h.note)}rule ${id}`, `${h.say}. ${hs.length} ${hs.length === 1 ? "line" : "lines"}: ${ex}${hs.length > 4 ? "; ..." : ""}.${ending(h)}`);
    }
  }
  // ---------- ledger ----------
  const isClaim = (b: Row) => meaning.claims ? allOf(meaning, meaning.claims, b, fps).ok === true : b.kv?.in === undefined && b.verb !== "credits";
  const msgScenes = scenes.filter((sc: any) => msgs.some((m) => m.scene === sc.id));
  const ledger: string[] = [];
  for (const sc of scenes as any[]) {
    const own = msgs.filter((m) => m.scene === sc.id);
    const claims = beats.filter((b) => b.scene === sc.id && isClaim(b));
    const ev = own.length ? own : (() => { const i = msgScenes.findIndex((x: any) => x.startFrame > sc.startFrame); const p = i === -1 ? msgScenes[msgScenes.length - 1] : msgScenes[i - 1]; return p && p.endFrame <= sc.startFrame && claims.length ? msgs.filter((m) => m.scene === p.id) : []; })();
    if (!ev.length) continue;
    const src = own.length ? "" : ` (lines from ${ev[0].scene})`;
    ledger.push(`${sc.id} "${sc.title}"${src}`);
    if (own.length) ledger.push(...own.map((m) => `  ${m.kv?.side ?? "?"}${m.kv?.in ? `/${m.kv.in}` : ""}: ${clean(m.text)}`));
    for (const c of claims) if (!own.includes(c)) ledger.push(`  CLAIM ${c.verb} ${c.id}: ${clean(c.text)}${c.kv?.flip ? ` (flips to: ${c.kv.flip})` : ""}`);
  }

  // ---------- text ----------
  const want = (n: string) => sections.has("all") || sections.has(n);
  L.push(`# Film ${s.film.name ?? ""}: ${fmt(s.durationFrames, fps)}, ${s.durationFrames} frames at ${fps} fps, ${scenes.length} scenes, ${W}x${H}.`);
  L.push("Sources: [score] from the source, [list] from each frame's display list, [pixel] and [sound] from the encoded file. All computed with no model. A flag is a measured fact against a stated limit; it is not a verdict on whether the film is good.");
  if (want("flags")) {
    L.push("", `## Flags (${flags.length})`); if (!flags.length) L.push("None."); else L.push(...flags.map((x, i) => `${i + 1}. ${x}`));
    const checked = result.stats.reduce((n, x) => n + x.selected, 0), refused = result.refused.length;
    L.push("", `## Cannot check (${refused})`);
    L.push(`Rules from ${["craft", ...meaning.packs].join(", ")}, and film/meaning.txt: ${result.stats.length} rules on ${checked} lines, ${result.hits.length} misses, ${refused} refused. A refusal is not a pass: the fact was not available.`);
    const groups = new Map<string, { rule: string; why: string; ids: string[] }>();
    for (const r of result.refused) { const k = `${r.rule}|${r.why}`; (groups.get(k) ?? groups.set(k, { rule: r.rule, why: r.why, ids: [] }).get(k)!).ids.push(r.row.id); }
    for (const g of groups.values()) L.push(`- ${g.rule}: ${g.ids.slice(0, 6).join(", ")}${g.ids.length > 6 ? `, and ${g.ids.length - 6} more` : ""}: ${g.why}.`);
    const idle = result.stats.filter((x) => x.selected === 0).map((x) => x.id);
    if (idle.length) L.push(`Selected no line in this film: ${idle.join(", ")}.`);
    const named = [...meaning.limits].filter(([, v]) => !v.from.startsWith("pack craft"));
    if (named.length) L.push(`Limits this film sets: ${named.map(([k, v]) => `${k}=${v.value}`).join(", ")}.`);
  }
  if (want("outline")) {
    L.push("", "## Outline [score + list]");
    L.push("Line: time, verb id, who (declared side, then drawn align and fill), words, seconds visible and fully readable, reference read time.");
    const gaps = beats.slice(1).map((b, i) => (b.at - beats[i].at) / fps), holds: number[] = [];
    for (const sc of scenes as any[]) {
      const own = beats.filter((b) => b.scene === sc.id);
      const secs = (sc.endFrame - sc.startFrame) / fps, w = own.reduce((n, b) => n + b.words, 0);
      const inner = own.slice(1).map((b, i) => (b.at - own[i].at) / fps);
      const tail = own.length ? (sc.endFrame - own[own.length - 1].at) / fps : secs;
      const gl = glFrames.get(sc.id), ds = sm(sc.id).decor;
      L.push(`${sc.id} "${sc.title}" ${fmt(sc.startFrame, fps)} +${secs.toFixed(1)}s, ${own.length} lines, ${w} words, ${(w / secs).toFixed(1)} w/s, longest gap ${inner.length ? Math.max(...inner).toFixed(1) : "-"}s, tail ${tail.toFixed(1)}s${gl ? `, GL ${[...gl.names].join("+")}` : ""}${ds ? `, ${ds} decor words` : ""}`);
      for (const b of own) {
        const d = b.drawn, hold = b.first !== undefined ? ((b.last! - b.first + 1) / fps) : 0, full = (b.full ?? 0) / fps;
        holds.push(hold);
        const who = b.kv?.in !== undefined ? ` ${b.kv?.side ?? "?"}${d ? `>${d.align} ${d.family}` : ">?"}` : d && d.family !== "none" ? ` ${d.family}` : "";
        const tight = hold && full < (b.read ?? 0) - 0.02 ? " TIGHT" : "";
        const not = b.first === undefined ? (d ? " drawn as decoration only, no id" : " NOT DRAWN by id") : "";
        L.push(` ${fmt(b.at, fps)} ${b.verb} ${b.id.split(".").slice(1).join(".")}${who} "${clean(b.text)}" on ${hold.toFixed(1)} read ${full.toFixed(1)} need ${b.read!.toFixed(1)}${tight}${not}`);
      }
    }
    const bins = new Array(Math.ceil(s.durationFrames / fps / 10)).fill(0);
    for (const b of beats) bins[Math.floor(b.at / fps / 10)]++;
    L.push("", "Pacing numbers. They describe; they do not say whether the pacing is right.");
    L.push(`- ${beats.length} lines, ${(beats.length / (s.durationFrames / fps) * 60).toFixed(0)} a minute, ${beats.reduce((n, b) => n + b.words, 0)} words.`);
    L.push(`- Gap between lines: median ${pct(gaps, 0.5).toFixed(1)} s, p90 ${pct(gaps, 0.9).toFixed(1)} s, longest ${[...gaps.map((g, i) => [g, i] as [number, number])].sort((a, b) => b[0] - a[0]).slice(0, 3).map(([g, i]) => `${g.toFixed(1)} s at ${fmt(beats[i].at, fps)}`).join(", ")}.`);
    L.push(`- Time on screen: median ${pct(holds, 0.5).toFixed(1)} s, p90 ${pct(holds, 0.9).toFixed(1)} s. Lines readable for less than their reference time: ${beats.filter((b) => b.first !== undefined && (b.full ?? 0) / fps < (b.read ?? 0) - 0.02).length}.`);
    L.push(`- Lines per 10 s: ${bins.join(" ")}.`);
    L.push(`- Scene seconds: ${(scenes as any[]).map((x) => `${x.id} ${((x.endFrame - x.startFrame) / fps).toFixed(1)}`).join(", ")}.`);
  }
  if (want("facts")) {
    L.push("", "## Meaning facts [score against list]");
    const seen = new Map<string, Row[]>();
    for (const m of msgs) { const d = m.drawn; const k = d ? `side=${m.kv?.side} drawn ${d.align}, fill ${d.fill} ${d.family}, ink ${d.ink}, contrast ${d.contrast}, ${d.px}px` : `side=${m.kv?.side} not located in the list`; (seen.get(k) ?? seen.set(k, []).get(k)!).push(m); }
    for (const [k, l] of seen) L.push(`- ${k}: ${l.length} lines (${l.slice(0, 3).map((x) => x.id).join(", ")}${l.length > 3 ? ", ..." : ""})`);
    const others = beats.filter((b) => b.kv?.in === undefined && b.drawn && b.drawn.family !== "none");
    if (others.length) L.push(`- Other lines on a filled box: ${others.slice(0, 8).map((b) => `${b.id} ${b.drawn!.family} ${b.drawn!.align}`).join(", ")}${others.length > 8 ? ", ..." : ""}.`);
    const nd = beats.filter((b) => b.first === undefined && !b.drawn);
    if (nd.length) L.push(`- Score lines with no id in any frame: ${nd.slice(0, 6).map((b) => b.id).join(", ")}${nd.length > 6 ? ", ..." : ""}.`);
  }
  if (want("motion")) {
    L.push("", "## Motion");
    L.push("| scene | source | moving | top speed px/f | slow float | shake on event | jump/spike | pop in/out | clip | words cut | MAD med/p95 | kf excess/ratio | step share/even | rev/s cell |");
    L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const sc of scenes as any[]) {
      const M = sm(sc.id), g = glFrames.get(sc.id), x = pxBy.get(sc.id) ?? {};
      const source = g ? (g.n >= (sc.endFrame - sc.startFrame) * 0.5 ? `pixel; list blind to ${[...g.names].join("+")}` : `list+pixel; blind to ${[...g.names].join("+")} ${g.n}f`) : "list+pixel";
      L.push(`| ${sc.id} | ${source} | ${M.moved} | ${M.maxV.toFixed(1)} | ${M.floatN ? `${M.floatN} at ${M.floatV.toFixed(2)}` : "-"} | ${M.shake} | ${M.jump.length}/${M.spike.length} | ${M.popIn.length}/${M.popOut} | ${M.clipped.length} | ${M.covered.length} | ${x.mad ?? "-"}/${x.mad95 ?? "-"} | ${x.kfExcess ?? "-"}/${x.kfRatio ?? "-"} | ${x.stepShare ?? "-"}/${x.stepEven ?? "-"} | ${x.revMax ?? "-"} |`);
    }
    if (!px) L.push("No encoded file was given, so pixel columns are empty and GL scenes are unread.");
    L.push("List columns read every element's path. Pixel columns read the file in a 3 by 5 cell grid. Where the source says list blind, only the pixel columns speak.");
  }
  if (want("sound")) {
    L.push("", "## Sound [score + sound]");
    const cls = new Map<string, number>(); for (const x of s.sfx) cls.set(x.cls, (cls.get(x.cls) ?? 0) + 1);
    const onBeat = s.sfx.filter((x: any) => Math.abs(x.beat - Math.round(x.beat)) < 0.07).length, onKick = s.sfx.filter((x: any) => Math.abs(x.beat % 4) < 0.07).length;
    L.push(`Score: ${s.sfx.length} event sounds (${[...cls].map(([k, v]) => `${k} ${v}`).join(", ")}), ${onBeat} on a beat, ${onKick} on a kick. ${s.ducks.length} ducks. Music: ${s.film.music ? `${s.film.music.file ?? "bed"} gain ${s.film.music.gain ?? 1}, trim ${s.trimBeats} beats` : "none"}.`);
    if (au && !au.none) {
      L.push(`File: ${au.I} LUFS integrated, LRA ${au.LRA}, sample peak ${au.peak} dBFS, ${au.clipSamples} samples at full scale, silent spans ${au.silence.length ? au.silence.map((q: number[]) => `f${q[0]}-${q[1]}`).join(", ") : "none"}.`);
      L.push(`Cues: best lag of event sounds against the score ${au.sfxLagFrames} frames, ${au.sfxLagOver0} dB above lag 0. Rise at each cue by class: ${Object.entries<any>(au.sfxByClass ?? {}).map(([k, v]) => `${k} ${v.riseMed} dB, ${v.buried}/${v.n} under 3 dB`).join("; ")}.`);
      if (au.bedPhaseMs !== undefined) L.push(`Bed: low-band beat ${au.bedPhaseMs} ms from the grid, peak ${au.bedPhasePeak}x its median.`);
      L.push(`Loudness and attacks by scene, momentary LUFS median/max and attacks: ${(px.scenes as any[]).map((x) => `${x.id} ${x.M}/${x.Mmax} ${x.hits}`).join(", ")}.`);
      const b = au.sfxBuried ?? []; if (b.length) L.push(`Buried cues, rise under 3 dB, first of ${b.length}: ${b.slice(0, 6).map((q: any) => `f${q.frame} ${String(q.file ?? q.cls).split("/").pop()} ${q.rise}`).join(", ")}.`);
    } else L.push("No encoded file was given, so only the score side is listed.");
  }
  if (want("ledger")) {
    L.push("", "## Claims and evidence [score]");
    L.push("Each label or story claim beside the lines it rests on. Whether a claim is plausible is a judgment for a model and the director. This section does not make it. A rule in the film's own folder can.");
    L.push(...(ledger.length ? ledger : ["No lines in a panel in this film."]));
  }
  return L.join("\n");
};
