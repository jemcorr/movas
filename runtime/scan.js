// A per-frame reading of the display list for `./movas film`: leaf ops with frame-space boxes, effective opacity and colour.
// It reads the list and changes nothing, so it cannot change a plan hash. Text marked decor is read too, unlike flatten().
import { mul3 } from "./reelrt.js";
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const ap = (m, x, y) => { const w = m[6] * x + m[7] * y + m[8]; return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]; };
const box = (m, x0, y0, x1, y1) => { const p = [ap(m, x0, y0), ap(m, x1, y0), ap(m, x1, y1), ap(m, x0, y1)], xs = p.map((q) => q[0]), ys = p.map((q) => q[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const r2 = (v) => Math.round(v * 100) / 100;
const rb = (b) => b.map(r2);
const clipShare = (b, clips) => { let vis = 1; for (const c of clips) { const area = Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1])), ix = Math.max(0, Math.min(b[2], c[2]) - Math.max(b[0], c[0])), iy = Math.max(0, Math.min(b[3], c[3]) - Math.max(b[1], c[1])); vis = Math.min(vis, ix * iy / area); } return r2(vis); };
export function scanFrame(list, comp, out = [], M = I3, op = 1, clips = [], scene = null, bright = 1, gblur = 0) {
  for (const o of list) {
    if (!o) continue;
    const m = o.m ? mul3(M, o.m) : M, a = op * (o.opacity ?? 1);
    if (o.op === "group") {
      const f = o.filter; let cl = clips;
      if (o.clip) { const b = box(m, o.clip.x, o.clip.y + (o.clip.fadeTop ?? 0), o.clip.x + o.clip.w, o.clip.y + o.clip.h); cl = [...clips, b]; }
      const sc = o.scene ?? scene;
      if (f && (f.split || f.shift || f.blurX > 0.05)) out.push({ k: "F", sc, sp: f.split ?? f.shift ?? null, bx: f.blurX ?? 0 });
      scanFrame(o.children ?? [], comp, out, m, a, cl, sc, f?.brightness ? bright * Math.min(1, f.brightness) : bright, gblur + (f?.blur ?? 0) + (f?.blurX ?? 0));
    } else if (o.op === "text") {
      const text = String(o.text ?? (o.spans ?? []).map((s) => s.text ?? "").join(""));
      if (!text.trim()) continue;
      const w = comp.measure({ ...o, text }).width, ax = o.align === "center" ? w / 2 : o.align === "right" ? w : 0, x0 = o.x - ax, y0 = o.y - o.size * 0.76, b = box(m, x0, y0, x0 + w, o.y + o.size * 0.2);
      out.push({ k: "t", id: o.id ?? null, tx: text, ink: o.spans?.[0]?.color ?? o.color ?? "#000", b: rb(b), a: r2(a), v: clipShare(b, clips), px: r2((b[3] - b[1]) / 0.96), sc: scene, ...(o.decor ? { d: 1 } : {}), ...(bright < 1 ? { br: r2(bright) } : {}), ...(gblur + (o.blur ?? 0) > 0.05 ? { gb: r2(gblur + (o.blur ?? 0)) } : {}) });
    } else if (o.op === "rect") {
      const b = box(m, o.x, o.y, o.x + o.w, o.y + o.h);
      out.push({ k: "r", id: o.id ?? null, c: o.color ?? null, b: rb(b), a: r2(a), v: clipShare(b, clips), sc: scene });
    } else if (o.op === "image") {
      const b = box(m, o.x, o.y, o.x + o.w, o.y + o.h);
      out.push({ k: "i", id: String(o.key ?? "img"), b: rb(b), a: r2(a), v: clipShare(b, clips), sc: scene });
    } else if (o.op === "html") {
      const b = box(m, o.x, o.y, o.x + o.w, o.y + o.h);
      out.push({ k: "h", id: null, b: rb(b), a: r2(a), v: clipShare(b, clips), sc: scene, ...(o.decor ? { d: 1 } : {}) });
      for (const r of comp.htmlMeasure(o)) { if (r.vis <= 0.05) continue; const tb = box(m, o.x + r.box[0], o.y + r.box[1], o.x + r.box[2], o.y + r.box[3]); out.push({ k: "t", id: r.id ?? null, tx: r.text, ink: "#000", b: rb(tb), a: r2(a * r.a), v: clipShare(tb, clips), px: r2(r.size), sc: scene, ...(o.decor ? { d: 1 } : {}) }); }
    } else if (o.op === "gl") out.push({ k: "g", id: o.program, sc: scene });
    else if (o.op === "fill" && o.screen) out.push({ k: "s", a: r2(a), sc: scene });
  }
  return out;
}
