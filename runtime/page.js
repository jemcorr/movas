// Runs in the pinned headless shell. It holds no state between runs: the server sends the plan, the page computes display
// lists, reports their hashes and text boxes, then draws only the chunks the server asks for.
import { Compositor, coveredBy, flatten } from "./reelrt.js";
import { makeFilm } from "/programs/film.js";
import { scanFrame } from "./scan.js";

const ws = new WebSocket(`ws://${location.host}/pipe`); ws.binaryType = "arraybuffer";
// What is said before the socket opens waits for it: the sender below can fail that early, and send() would throw.
const unsent = [];
const opened = new Promise((r) => (ws.onopen = () => { for (const s of unsent.splice(0)) ws.send(s); r(); }));
const say = (o) => { const s = JSON.stringify(o); if (ws.readyState === WebSocket.OPEN) ws.send(s); else unsent.push(s); };
// Pixels leave through a worker with a socket of its own (runtime/sender.js), in buffers it hands back once sent. This socket carries the rest.
const sender = new Worker("/runtime/sender.js", { type: "module" });
const spare = [];
sender.onmessage = (e) => { if (e.data instanceof ArrayBuffer) spare.push(new Uint8Array(e.data)); else say({ t: "error", msg: e.data?.error ?? "frame sender" }); };
sender.onerror = (e) => say({ t: "error", msg: `frame sender: ${e.message}` });
addEventListener("error", (e) => say({ t: "error", msg: `${e.message} @${e.filename}:${e.lineno}${e.error?.stack ? ` | ${e.error.stack}` : ""}` }));
addEventListener("unhandledrejection", (e) => say({ t: "error", msg: String(e.reason?.stack ?? e.reason) }));
// Network block: a refused request is reported, and the server fails the render and names the URL. Chrome's CSP refusals
// arrive as securitypolicyviolation events. A console error or warning that names a refusal is reported too.
const blocked = (msg) => say({ t: "blocked", msg });
addEventListener("securitypolicyviolation", (e) => blocked(`blocked network request: ${e.blockedURI || "(inline)"} by ${e.violatedDirective}`));
// The full URL as the program asked for it, since the CSP event carries only the origin of a cross-origin request.
const foreign = (u) => {
  let url; try { url = new URL(String(u), location.href); } catch { return null; }
  if (!/^(https?|wss?):$/.test(url.protocol) || url.host === location.host) return null;
  return url.href;
};
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => { const u = foreign(input?.url ?? input); if (u) blocked(`blocked network request: ${u} (fetch)`); return realFetch(input, init); };
const realOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function (m, u, ...rest) { const x = foreign(u); if (x) blocked(`blocked network request: ${x} (xhr)`); return realOpen.call(this, m, u, ...rest); };
const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
Object.defineProperty(HTMLImageElement.prototype, "src", { ...srcDesc, set(v) { const x = foreign(v); if (x) blocked(`blocked network request: ${x} (img)`); srcDesc.set.call(this, v); } });
for (const name of ["error", "warn"]) {
  const orig = console[name].bind(console);
  console[name] = (...a) => { const s = a.map((x) => String(x?.message ?? x)).join(" "); if (/Content Security Policy|Refused to|ERR_BLOCKED|ERR_NAME_NOT_RESOLVED/.test(s)) blocked(`blocked by console: ${s}`); orig(...a); };
}

// Time and chance are not available to programs. Frames depend on nothing but their inputs.
const ban = (name) => () => { throw new Error(`${name} is not available to scene programs`); };
const realNow = performance.now.bind(performance);
Math.random = ban("Math.random"); Date.now = ban("Date.now");

const hash53 = (str, seed = 0) => { let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed; for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); } h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909); return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36); };
const rx = []; let wake = null;
ws.onmessage = (e) => { rx.push(typeof e.data === "string" ? JSON.parse(e.data) : e.data); wake?.(); wake = null; };
const next = async () => { while (!rx.length) await new Promise((r) => (wake = r)); return rx.shift(); };
// Violation events are queued as tasks. A few turns let them land before the server is told the plan or the draw is done.
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };

await opened;
say({ t: "hello" });
const job = await next();
// Dead keys: each score line's kv is wrapped, so the plan can name the keys no program reads in any frame.
const kvReads = {}, kvEnum = new Set();
const watchKv = (key, kv) => {
  if (!kv || typeof kv !== "object") return kv;
  const seen = (kvReads[key] ??= new Set());
  return new Proxy(kv, {
    get(t, k, r) { if (typeof k === "string") seen.add(k); return Reflect.get(t, k, r); },
    has(t, k) { if (typeof k === "string") seen.add(k); return Reflect.has(t, k); },
    getOwnPropertyDescriptor(t, k) { if (typeof k === "string") seen.add(k); return Reflect.getOwnPropertyDescriptor(t, k); },
    ownKeys(t) { kvEnum.add(key); return Reflect.ownKeys(t); },
  });
};
const S = job.solved;
for (const sc of Object.values(S.film?.scenes ?? {})) for (const l of sc.lines ?? []) if (l.id && l.kv) l.kv = watchKv(`${sc.id}.${l.id}`, l.kv);
for (const t of S.texts ?? []) if (t.kv) t.kv = watchKv(t.at, t.kv);
for (const m of S.media ?? []) if (m.kv) m.kv = watchKv(m.id, m.kv);
for (const k of Object.keys(S.kvOf ?? {})) S.kvOf[k] = watchKv(k, S.kvOf[k]);
for (const [sid, ps] of Object.entries(S.panels ?? {})) for (const name of Object.keys(ps)) ps[name] = watchKv(`${sid}.${name}`, ps[name]);
await Promise.all([document.fonts.load("600 50px Inter"), document.fonts.load("800 50px Inter")]);
const fmt = { ...job.format, id: job.formatId };
const canvas = document.getElementById("g"); canvas.width = fmt.w; canvas.height = fmt.h;
const gl = canvas.getContext("webgl2", { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" });
if (!gl) { say({ t: "error", msg: "no webgl2" }); throw new Error("no webgl2"); }
const dbg = gl.getExtension("WEBGL_debug_renderer_info");
const programs = {}; const extra = {};
for (const url of job.modules ?? []) { const m = await import(url); await m.install?.({ gl, programs, extra, solved: job.solved, fmt }); }
const comp = new Compositor(gl, fmt.w, fmt.h, programs, job.scale ?? 1);
const film = makeFilm(job.solved, comp, fmt, extra);
say({ t: "gl", renderer: dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL), version: gl.getParameter(gl.VERSION), readFormat: gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) });

// ---------- Plan: lists, hashes, boxes. No pixels. ----------
const frames = []; for (const s of job.segments) for (let f = s.from; f < s.to; f++) frames.push(f);
const t0 = realNow();
const hashes = new Map(); const textStats = {}; const pairs = new Map(); const occl = {}; const offFrame = {};
const drawn = new Map();
// Punch-group boxes in the frame where each punch lands, for the stability windows of `./movas windows`.
const landOf = new Map(); for (const [id, e] of Object.entries(S.events ?? {})) if (id.endsWith(".land")) landOf.set(id.slice(0, -5), e.frame);
const landBoxes = {};
// Every text op a frame draws, decor and id-less ones included. flatten() leaves those out, so the unregistered-text check reads them here.
const textOps = (list, op = 1, scene = null, out = []) => {
  for (const o of list) {
    if (!o) continue;
    const a = op * (o.opacity ?? 1);
    if (o.op === "group") textOps(o.children ?? [], o.filter?.brightness ? a * Math.min(1, o.filter.brightness) : a, o.scene ?? scene, out);
    else if (o.op === "text") out.push({ id: o.id ?? null, scene, decor: !!o.decor, text: String(o.text ?? (o.spans ?? []).map((s) => s.text ?? "").join("")), a });
    else if (o.op === "html") for (const r of comp.htmlMeasure(o)) if (r.vis > 0.05) out.push({ id: r.id, scene, decor: !!o.decor, text: r.text, a: a * r.a });
  }
  return out;
};
// A frame that draws nothing but background fills: the dead-air check reads this.
const drawsSomething = (list, op = 1) => list.some((o) => {
  if (!o) return false;
  const a = op * (o.opacity ?? 1);
  if (a <= 0.05) return false;
  return o.op === "group" ? drawsSomething(o.children ?? [], a) : o.op !== "fill" && o.op !== "shadow";
});
const deadAir = []; let emptyFrom = null;
const DEAD_MIN = Math.round(1.5 * job.solved.clock.fps); // Shorter gaps read as a beat.
for (const f of frames) {
  const list = film.frame(f);
  const j = JSON.stringify(list);
  let salt = ""; for (const k in job.programHash) if (j.includes(`"program":"${k}"`)) salt += job.programHash[k];
  hashes.set(f, hash53(j + salt));
  if (job.checks !== false) {
    if (drawsSomething(list)) { if (emptyFrom !== null && f - emptyFrom >= DEAD_MIN) deadAir.push({ first: emptyFrom, n: f - emptyFrom }); emptyFrom = null; } else if (emptyFrom === null) emptyFrom = f;
    for (const t of textOps(list)) {
      if (t.a < 0.5 || !t.text.trim()) continue;
      const k = JSON.stringify([t.id, t.scene, t.decor, t.text]);
      const d = drawn.get(k) ?? { id: t.id, scene: t.scene, decor: t.decor, text: t.text, first: f, last: f, frames: 0 };
      d.last = f; d.frames++; drawn.set(k, d);
    }
    const items = flatten(list, comp);
    for (const it of items) if (it.k === "text" && /\.g\d+$/.test(it.id)) { const eid = it.id.replace(/\.g\d+$/, ""); if (landOf.get(eid) === f) landBoxes[it.id] = { frame: f, box: it.box.map((v) => Math.round(v * 100) / 100) }; }
    const texts = [];
    items.forEach((it, idx) => {
      if (it.k !== "text" || it.a < 0.5 || it.vis < 0.05) return;
      const s = (textStats[it.id] ??= { id: it.id, text: it.text, scene: it.scene, first: f, last: f, frames: 0, full: 0, clipped: 0, covered: 0, off: 0, minPx: 1e9, maxPx: 0, margin: 1e9 });
      s.last = f; s.frames++; s.minPx = Math.min(s.minPx, it.px); s.maxPx = Math.max(s.maxPx, it.px);
      const [x0, y0, x1, y1] = it.box;
      // Only once the text has come in: a slam-in overshoots the frame for a frame or two while it is still fading up.
      const off = it.a >= 0.9 && (x0 < -2 || y0 < -2 || x1 > fmt.w + 2 || y1 > fmt.h + 2);
      if (off) { s.off++; (offFrame[it.id] ??= []).push(f); }
      if (it.vis < 0.98) s.clipped++;
      let cover = null;
      for (let k = idx + 1; k < items.length; k++) {
        const o = items[k]; if (o.k !== "rect" || !o.id) continue;
        if (o.box[0] > x1 || o.box[2] < x0 || o.box[1] > y1 || o.box[3] < y0) continue;
        const share = coveredBy(it, o);
        if (share > 0.05) { cover = { by: o.id, share, transition: o.scene !== it.scene }; break; }
      }
      if (cover) { s.covered++; const e = (occl[it.id] ??= { by: cover.by, frames: [], maxShare: 0, transition: cover.transition }); e.frames.push(f); e.maxShare = Math.max(e.maxShare, cover.share); }
      if (!off && !cover && it.vis >= 0.98 && it.a >= 0.9) { s.full++; s.margin = Math.min(s.margin, x0, y0, fmt.w - x1, fmt.h - y1); }
      texts.push(it);
    });
    for (let a = 0; a < texts.length; a++) for (let b = a + 1; b < texts.length; b++) {
      const A = texts[a], B = texts[b]; if (A.id === B.id) continue;
      const ix = Math.min(A.box[2], B.box[2]) - Math.max(A.box[0], B.box[0]), iy = Math.min(A.box[3], B.box[3]) - Math.max(A.box[1], B.box[1]);
      if (ix > 4 && iy > 4) { const k = `${A.id} x ${B.id}`; const e = pairs.get(k) ?? { a: A.id, b: B.id, frames: 0, first: f, transition: A.scene !== B.scene }; e.frames++; pairs.set(k, e); }
    }
  }
}
if (emptyFrom !== null && frames.length && frames[frames.length - 1] + 1 - emptyFrom >= DEAD_MIN) deadAir.push({ first: emptyFrom, n: frames[frames.length - 1] + 1 - emptyFrom });
const planMs = realNow() - t0;
// `./movas film` reads the list frame by frame. This pass draws nothing and stays out of the plan time and the hashes.
if (job.scan) { let batch = []; for (const f of frames) { batch.push([f, scanFrame(film.frame(f), comp)]); if (batch.length >= 120) { say({ t: "scan", rows: batch }); batch = []; await settle(); } } if (batch.length) say({ t: "scan", rows: batch }); }
const list = frames.map((f) => hashes.get(f));
await settle();
say({ t: "plan", kvReads: Object.fromEntries(Object.entries(kvReads).map(([k, s]) => [k, [...s]])), kvEnum: [...kvEnum], planMs, frames, hashes: list, checks: { texts: Object.values(textStats), collisions: [...pairs.values()], occluded: occl, offFrame: Object.fromEntries(Object.entries(offFrame).map(([k, v]) => [k, { n: v.length, first: v[0] }])), drawn: [...drawn.values()], landBoxes, deadAir }, bakes: comp.bakes });

// ---------- Draw only what is missing. ----------
const need = await next();
let drawMs = 0, readMs = 0, sendMs = 0, waitMs = 0, inflight = 0; const loop0 = realNow(); const WINDOW = job.window ?? 6;
const mc = new MessageChannel(); let mcWake = null; mc.port1.onmessage = () => { mcWake?.(); mcWake = null; };
const yieldTask = () => new Promise((r) => { mcWake = r; mc.port2.postMessage(0); });
// Each frame is read into a buffer of its own, which moves to the sender and comes back once sent.
const frameBuf = () => spare.pop() ?? new Uint8Array(comp.pack.length);
const emit = async (px, a0) => { sender.postMessage(px.buffer, [px.buffer]); const s0 = realNow(); sendMs += s0 - a0; if (++inflight >= WINDOW) { const ack = await next(); if (ack.t !== "ack") throw new Error("protocol"); inflight--; waitMs += realNow() - s0; } };
const ring = []; const RING = 6;
for (const c of need.chunks) {
  for (const f of c.frames) {
    const a = realNow(); const dl = film.frame(f); await comp.preload(dl); comp.frame(dl); const b = realNow();
    ring.push(comp.startRead()); readMs += realNow() - b; drawMs += b - a;
    if (ring.length > RING) { const r0 = realNow(); const px = await comp.finishRead(ring.shift(), yieldTask, frameBuf()); const r1 = realNow(); readMs += r1 - r0; await emit(px, r1); }
  }
}
while (ring.length) { const px = await comp.finishRead(ring.shift(), yieldTask, frameBuf()); await emit(px, realNow()); }
while (inflight > 0) { await next(); inflight--; }
await settle();
say({ t: "done", drawMs, readMs, sendMs, waitMs, loopMs: realNow() - loop0, drawCalls: comp.drawCalls, bakes: comp.bakes });
