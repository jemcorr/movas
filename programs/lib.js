// Shared building blocks for scene programs. Every function is pure: same arguments, same display list.
export { loadThree, seededStream, withSeeded } from "../runtime/seeded.js";
// Timing comes from the solved score, never from a literal.
import { about3, mul3, persp3, rotate3, scale3, translate3 } from "../runtime/reelrt.js";

/** Text for an html op: escapes it, drops score markup, and tags it with the score id so the checks read it. Style is plain CSS. */
export const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const htmlText = (v, name, style = "", tag = "div") => { const t = v.text(name); return `<${tag} data-id="${esc(t.id)}" style="${esc(style)}">${esc(String(t.text).replace(/\*/g, "").replace(/\s*\/\s*/g, " ").replace(/\\n/g, " "))}</${tag}>`; };
export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const bezier = (x1, y1, x2, y2) => {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t, Y = (t) => ((ay * t + by) * t + cy) * t, dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x; for (let i = 0; i < 8; i++) { const e = X(t) - x; if (Math.abs(e) < 1e-6) break; const d = dX(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
    return Y(t);
  };
};
export const EXPO_OUT = bezier(0.16, 1, 0.3, 1), BACK_OUT = bezier(0.34, 1.56, 0.64, 1), EXPO_IN = bezier(0.7, 0, 0.84, 0), IN_OUT = bezier(0.65, 0, 0.35, 1);
export const prog = (f, start, dur, e = EXPO_OUT) => e(clamp01((f - start) / Math.max(1, dur)));
export const pop = (f, start, dur = 10) => prog(f, start, dur, BACK_OUT);
export const leave = (f, start, dur = 8) => prog(f, start, dur, EXPO_IN);
export const rand = (seed) => { const x = Math.sin(seed * 127.1 + 311.7) * 43758.5453123; return x - Math.floor(x); };
export const lerp = (f, a, b, x, y) => x + (y - x) * clamp01((f - a) / (b - a));
export const smoothDim = bezier(0.65, 0, 0.35, 1);

export const parseSpans = (s, hi, base) => {
  const out = []; for (const p of s.split(/(\*[^*]+\*)/g).filter(Boolean)) out.push(p.startsWith("*") && p.endsWith("*") ? { text: p.slice(1, -1), color: hi } : { text: p, color: base });
  return out;
};
const plain = (s) => s.replace(/\*/g, "");

/** A view of one scene: event frames in local time, so a shifted scene hashes the same. */
export const sceneView = (solved, id) => {
  const sc = solved.scenes.find((s) => s.id === id);
  const start = sc.startFrame;
  const ev = (name) => { const e = solved.events[`${id}.${name}`]; if (!e) throw new Error(`no event ${id}.${name}`); return e.frame - start; };
  const texts = solved.texts.filter((t) => t.scene === id);
  const text = (name) => { const t = texts.find((x) => x.id === `${id}.${name}`); if (!t) throw new Error(`no text ${id}.${name}`); return t; };
  return { id, start, end: sc.endFrame - start, title: sc.title, ev, text, texts, solved, has: (name) => `${id}.${name}` in solved.events };
};

export const PUNCH_IN = 7;
export const INK = "#f4f6f8", HOT = "#ff4a2a";

/** A headline. Groups are one line each and share a block that leaves together. */
export function punch(v, name, { size, top, highlight = HOT, out, W = 1080, lineHeight = 1.02 }) {
  const t = v.text(name), f = v.f;
  const groups = t.text.split(/\s\/\s/);
  // A *span* may run across groups.
  let open = false; const marked = groups.map((g) => { let s = g; if (open) s = `*${s}`; const n = (g.match(/\*/g) ?? []).length; if (n % 2) { open = !open; } if (open) s = `${s}*`; return s; });
  const ats = groups.map((_, i) => v.ev(`${name}.g${i + 1}`));
  const outF = out ?? v.ev(`${name}.out`);
  if (f < ats[0] || f > outF + 12) return null;
  const o = leave(f, outF, 9);
  let shake = 0; for (const a of ats) { const d = f - a; if (d >= 0 && d < 8) shake += Math.sin(d * 2.4) * 7 * Math.exp(-d / 2.5); }
  const settled = ats[ats.length - 1] + PUNCH_IN;
  const push = lerp(f, settled, outF, 1, 1.035);
  const lh = size * lineHeight, blockH = lh * groups.length;
  const blockM = mul3(translate3(shake, -o * 70), about3(W / 2, top + blockH * 0.4, scale3(push)));
  const children = [];
  marked.forEach((g, i) => {
    const a = ats[i];
    if (f < a) return;
    const p = BACK_OUT(clamp01((f - a) / PUNCH_IN)), sharp = prog(f, a, 6);
    const cy = top + lh * (i + 0.5), s = 1.45 - 0.45 * p;
    children.push({
      op: "text", id: `${t.id}.g${i + 1}`, text: plain(g), spans: parseSpans(g, highlight, INK), weight: 800, size, tracking: -0.04, align: "center", x: W / 2, y: cy + size * 0.36,
      color: INK, opacity: Math.min(1, sharp * 1.6), m: about3(W / 2, cy, scale3(s)), blur: sharp < 1 ? (1 - sharp) * 14 : 0,
      shadow: { blur: 40, dy: 8, color: "rgba(0,0,0,0.65)" },
    });
  });
  return { op: "group", m: blockM, opacity: 1 - o, children };
}

const DOCK = { entryScale: 1.6, lineIn: 8, lineStagger: 3, dockFrames: 10 };
/** A caption that holds, then docks to a corner. */
export function dock(v, name, { size, dockLeft, dockTop, W = 1080, H = 1920, centerY = H * 0.44, highlight = "#7ee08f", comp }) {
  const t = v.text(name), f = v.f, at = v.ev(name), outF = v.ev(`${name}.out`);
  if (f < at || f > outF + 12) return null;
  const raw = t.text.split("\n");
  // Spans that span lines close at each line break.
  const lines = raw;
  const tx = (s) => comp.measure({ text: plain(s), size, weight: 800, tracking: -0.035 }).width;
  const lh = 1.06, pad = 26, blockW = Math.max(...lines.map(tx)), blockH = lines.length * size * lh, k = DOCK.entryScale;
  const dockStart = v.ev(`${name}.undock`) - at, docked = v.ev(`${name}.docked`) - at, fullyOn = v.ev(`${name}.on`) - at;
  const d = EXPO_OUT(clamp01((f - (at + dockStart)) / (docked - dockStart)));
  const breathe = 1 + 0.03 * lerp(f, at + fullyOn, at + dockStart, 0, 1) * (1 - d);
  const scale = (k + (1 - k) * d) * breathe;
  const cx = (W - blockW * k * breathe) / 2, cy = centerY - (blockH * k * breathe) / 2;
  const x = cx + (dockLeft - cx) * d, y = cy + (dockTop - cy) * d, o = leave(f, outF, 8);
  const children = [];
  if (d > 0.002) {
    children.push({ op: "shadow", x: -pad, y: -pad * 0.7, w: blockW + pad * 2, h: blockH + pad * 1.4, r: 28, blur: 50, dy: 18, color: "rgba(0,0,0,0.5)", opacity: d });
    children.push({ op: "rect", x: -pad, y: -pad * 0.7, w: blockW + pad * 2, h: blockH + pad * 1.4, r: 28, color: "rgba(6,9,14,0.9)", stroke: { w: 2, color: "rgba(255,255,255,0.07)" }, opacity: d });
  }
  lines.forEach((l, i) => {
    const a = at + i * DOCK.lineStagger;
    if (f < a) return;
    const p = BACK_OUT(clamp01((f - a) / DOCK.lineIn)), sharp = prog(f, a, DOCK.lineIn - 2);
    children.push({
      op: "text", id: `${t.id}.l${i + 1}`, text: plain(l), spans: parseSpans(l, highlight, INK), weight: 800, size, tracking: -0.035, x: 0, y: size * lh * (i + 0.5) + size * 0.36 + (1 - p) * 30,
      color: INK, opacity: Math.min(1, sharp * 1.5), blur: sharp < 1 ? (1 - sharp) * 10 : 0,
      shadow: d < 1 ? { blur: 30, dy: 6, color: `rgba(0,0,0,${(0.7 * (1 - d)).toFixed(3)})` } : undefined,
    });
  });
  return { op: "group", m: mul3(translate3(x, y - o * 40), scale3(scale)), opacity: 1 - o, children };
}

/** How far the action is pushed back: the rule from src/headlines.ts, read from the score's PUNCH and DOCK cues. */
export function actionDim(v) {
  const f = v.f; let dim = 0, blur = 0;
  for (const t of v.texts) {
    if (t.verb === "punch" && !t.kv.with) {
      const name = t.id.split(".")[1];
      const first = v.ev(`${name}.g1`), base = parseFloat(t.kv.dim ?? "0.78"), out = v.ev(`${name}.out`);
      const until = t.kv.dimUntil === "end" ? Infinity : out;
      const inn = smoothDim(clamp01((f - (first - 6)) / 8)), rec = smoothDim(clamp01((f - until) / 10));
      const d = base * inn * (1 - rec);
      if (d > dim) { dim = d; blur = 8 * (d / 0.78); }
    } else if (t.verb === "dock") {
      const name = t.id.split(".")[1], at = v.ev(name), un = v.ev(`${name}.undock`);
      const inn = smoothDim(clamp01((f - at) / 6)), rec = smoothDim(clamp01((f - un) / DOCK.dockFrames));
      const d = 0.6 * inn * (1 - rec);
      if (d > dim) { dim = d; blur = 6 * (d / 0.6); }
    }
  }
  return { dim, blur };
}
export const dimFilter = (v) => { const { dim, blur } = actionDim(v); return dim < 0.001 ? undefined : { brightness: 1 - dim, blur }; };

/** Greedy word wrap, the same result CSS gives for normal text in a box. */
export function wrap(comp, text, o, maxW) {
  const out = []; for (const para of text.split("\n")) {
    let line = ""; for (const w of para.split(" ")) {
      const t = line ? `${line} ${w}` : w;
      if (comp.measure({ ...o, text: t }).width > maxW && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}
export const ICONS = {
  ticks: () => { const c = document.createElement("canvas"); c.width = 108; c.height = 80; const x = c.getContext("2d"); x.scale(4, 4); x.strokeStyle = "#53bdeb"; x.lineWidth = 2.4; x.lineCap = "round"; x.lineJoin = "round"; x.stroke(new Path2D("M1.5 11.2l4.6 4.6L15.6 4.2")); x.stroke(new Path2D("M10.2 15.6l1 .9L21.6 4.2")); return c; },
  avatar: () => { const c = document.createElement("canvas"); c.width = 400; c.height = 400; const x = c.getContext("2d"); x.scale(4, 4); x.fillStyle = "#cfd8dc"; x.beginPath(); x.arc(50, 50, 50, 0, 7); x.fill(); x.fillStyle = "#f5f7f8"; x.beginPath(); x.arc(50, 40, 18, 0, 7); x.fill(); x.fill(new Path2D("M18 88c4-18 18-26 32-26s28 8 32 26")); return c; },
  send: () => { const c = document.createElement("canvas"); c.width = 192; c.height = 192; const x = c.getContext("2d"); x.scale(8, 8); x.fillStyle = "#fff"; x.fill(new Path2D("M3.4 20.4L21 12 3.4 3.6l.02 6.53L15 12 3.42 13.87z")); return c; },
};
export { translate3, scale3, rotate3, about3, mul3, persp3 };

/** One frame of a `clip` line as an image op, or null outside its time. Frames were extracted by `./movas probe`. */
export function clipOp(v, name, f, W, H) {
  const m = v.ctx.solved.media.find((x) => x.id === `${v.id}.${name}`), at = v.ev(name);
  if (!m || f < at || f >= at + m.durFrames) return null;
  const n = Math.floor((f - at) * (m.srcFps / v.ctx.solved.clock.fps) + m.inSec * m.srcFps) + 1, k = m.kv;
  const scale = Math.min(W / m.w, H / m.h), w = k.w ? parseFloat(k.w) : m.w * scale, h = k.h ? parseFloat(k.h) : m.h * scale;
  return { op: "image", src: `${m.framesUrl}/${String(n).padStart(5, "0")}.jpg`, x: k.x ? parseFloat(k.x) : (W - w) / 2, y: k.y ? parseFloat(k.y) : (H - h) / 2, w, h };
}
