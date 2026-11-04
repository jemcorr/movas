// The film as a pure function of the frame. A scene with a program draws itself. Any other scene falls back to
// blocking: real timing, real words and real headlines over plain backgrounds, so a full-length film exists from the first compile.
import { clipOp, actionDim, dimFilter, dock, ICONS, INK, leave, pop, prog, punch, about3, scale3, sceneView } from "./lib.js";

// `style page gradient=0:#111,1:#000 vignette=0.5` in the score sets the page. With no style the page is plain black.
const pageStops = (st) => st?.gradient ? st.gradient.split(",").map((x) => { const i = x.indexOf(":"); return [parseFloat(x.slice(0, i)), x.slice(i + 1)]; }) : [[0, "#000000"], [1, "#000000"]];

export function makeFilm(solved, comp, fmt, extra = {}) {
  comp.bakers = { ...ICONS, ...(comp.bakers ?? {}) };
  const W = fmt.w, H = fmt.h, sy = H / 1920;
  const views = {}; for (const s of solved.scenes) { views[s.id] = sceneView(solved, s.id); views[s.id].comp = comp; }
  const programs = extra.programs ?? {};
  const scenePunches = (v) => v.texts.filter((t) => t.verb === "punch");

  const headlines = (v) => {
    const punches = scenePunches(v);
    const blocks = [];
    for (const t of punches) {
      const name = t.id.split(".")[1], k = t.kv;
      let size = parseFloat(k.size ?? "124"), top = parseFloat(k.top ?? "700");
      if (fmt.id !== solved.defaultFormat) {
        // Other formats: stack blocks that are read together in the safe area and shrink to fit. No per-scene numbers.
        const rows = punches.reduce((n, x) => n + x.text.split(/\s\/\s/).length, 0);
        const before = punches.slice(0, punches.indexOf(t)).reduce((n, x) => n + x.text.split(/\s\/\s/).length, 0);
        const fit = Math.min(1, (H * 0.82) / (rows * size * 1.08), W / 1080);
        size = size * fit; top = (H - rows * size * 1.08) / 2 + before * size * 1.08;
      }
      // A word group never runs off the frame, whatever size the line asks for: the widest group sets the size. 1.035 is the settled push in punch().
      const widest = Math.max(...t.text.split(/\s\/\s/).map((g) => comp.measure({ text: g.replace(/\*/g, ""), size, weight: 800, tracking: -0.04 }).width));
      if (widest * 1.035 > W - 80) size *= (W - 80) / (widest * 1.035);
      blocks.push(punch(v, name, { size, top, highlight: k.accent ?? "#ff4a2a", W, lineHeight: parseFloat(k.lh ?? "1.02"), out: k.with ? v.ev(`${k.with}.out`) : undefined }));
    }
    for (const t of v.texts.filter((x) => x.verb === "dock")) {
      const name = t.id.split(".")[1], k = t.kv;
      blocks.push(dock(v, name, { size: parseFloat(k.size ?? "56"), dockLeft: parseFloat(k.left ?? "60"), dockTop: parseFloat(k.top ?? "70") * sy, highlight: k.accent ?? "#7ee08f", W, H, comp }));
    }
    return blocks;
  };

  // Plain blocking for any scene without a program yet.
  function blocking(v, f) {
    const hue = "#161a22";
    const action = [{ op: "fill", kind: "radial", g: [W / 2, H * 0.45, W * 0.9, H * 0.7], stops: [[0, hue], [1, "#04060a"]] }];
    for (const add of extra.blocking ?? []) action.push(...add(v, f, ctx));
    // Video: any clip in this scene, fitted to the frame unless the line gives x, y, w, h.
    for (const m of (solved.media ?? []).filter((x) => x.scene === v.id && x.verb === "clip")) { const op = clipOp(v, m.id.split(".")[1], f, W, H); if (op) action.push(op); }
    // Labels: one pill per cue with words. They stack in the upper part of the frame while they are live.
    let y = 300 * sy;
    for (const t of v.texts) {
      if (!["text", "cue", "tag", "typed"].includes(t.verb)) continue;
      const name = t.id.split(".")[1]; if (t.id.split(".").length > 2) continue;
      const at = v.ev(name);
      if (f < at) continue;
      const p = pop(f, at, 9), size0 = 56 * Math.min(1, W / 1080), tw0 = comp.measure({ text: t.text, size: size0, weight: 800, tracking: -0.02 }).width;
      const size = tw0 + 52 > W - 40 ? size0 * (W - 92) / tw0 : size0, tw = tw0 * size / size0;
      const o = 1 - leave(f, at + 150, 12); if (o <= 0) continue;
      action.push({ op: "group", opacity: Math.min(1, p * 1.5) * o, m: about3(W / 2, y, scale3(0.7 + 0.3 * p)), children: [
        { op: "rect", x: (W - tw) / 2 - 26, y: y - 8, w: tw + 52, h: size * 1.4, r: 18, color: "rgba(255,255,255,0.10)" },
        { op: "text", id: t.id, text: t.text, size, weight: 800, tracking: -0.02, color: INK, align: "center", x: W / 2, y: y + size * 0.95 },
      ] });
      y += size * 1.7;
    }
    // Credits: one block per `credits` line, stacked and centred, each from its own time.
    const creditRows = v.texts.filter((t) => t.verb === "credits"), blocksN = new Set(creditRows.map((t) => t.id.split(".")[1])).size;
    if (creditRows.length) {
      const gapC = 24 * sy, need = creditRows.length * 60 + (blocksN - 1) * gapC, cs = Math.min(1, (H - 160 * sy) / need);
      let cy = (H - need * cs) / 2, prev = null;
      for (const t of creditRows) {
        const name = t.id.split(".")[1];
        if (prev && prev !== name) cy += gapC * cs;
        prev = name;
        const at = v.ev(name), s0 = 48 * cs, wc = comp.measure({ text: t.text, size: s0, weight: 700 }).width, size = wc > W - 80 ? s0 * (W - 80) / wc : s0;
        if (f >= at) action.push({ op: "text", id: t.id, text: t.text, size, weight: 700, color: INK, align: "center", x: W / 2, y: cy + 48 * cs, opacity: Math.min(1, prog(f, at, 9) * 1.5) });
        cy += 60 * cs;
      }
    }
    return [{ op: "group", filter: dimFilter(v), children: action }, ...headlines(v)];
  }

  // Global dim: the stage sits under every headline, so it reads every scene's cues.
  const dimAt = (f) => { let best = { dim: 0, blur: 0 }; for (const s of solved.scenes) { const v = views[s.id]; const holds = v.texts.some((t) => t.kv.dimUntil === "end"); if (f < s.startFrame - 30 || (f > s.endFrame + 60 && !holds)) continue; v.f = f - s.startFrame; const d = actionDim(v); if (d.dim > best.dim) best = d; } return best; };
  const ctx = { comp, fmt, solved, views, dimAt, W, H, headlines };
  extra.context?.(ctx);
  for (const v of Object.values(views)) v.ctx = ctx;

  // Layers in the production's order. A scene with a port draws itself; any other falls back to blocking with real timing and words.
  const windowOf = (s) => {
    const p = extra[s.id], spanEnd = p?.span ? solved.scenes.find((x) => x.id === p.span).endFrame : s.endFrame;
    return [s.startFrame - s.pre, spanEnd + s.post];
  };
  const spanned = new Set(solved.scenes.map((s) => extra[s.id]?.span).filter(Boolean));
  const windows = new Map(solved.scenes.map((s) => [s.id, windowOf(s)]));

  /** Display list of one frame. Scene programs use local time; only this function knows absolute frames. */
  const PAGE = pageStops(solved.style?.page), VIGNETTE = parseFloat(solved.style?.page?.vignette ?? "0");
  const frame = (f) => {
    const list = [{ op: "fill", stops: PAGE, g: [0, 0, 0, H] }];
    if (extra.stage) list.push(extra.stage(f, ctx));
    for (const s of solved.scenes) {
      if (spanned.has(s.id)) continue;
      const [a, z] = windows.get(s.id); if (f < a || f >= z) continue;
      const v = views[s.id], lf = f - s.startFrame; v.f = lf;
      const body = extra[s.id] ? extra[s.id](v, lf, ctx) : programs[s.program] ? programs[s.program](v, lf, ctx) : blocking(v, lf);
      list.push({ op: "group", scene: s.id, children: body });
    }
    if (extra.replybar) list.push(extra.replybar(f, ctx));
    if (VIGNETTE > 0) list.push({ op: "fill", kind: "radial", g: [W / 2, H * 0.45, W * 1.2, H * 0.9], stops: [[0, "rgba(0,0,0,0)"], [0.55, "rgba(0,0,0,0)"], [1, `rgba(0,0,0,${VIGNETTE})`]] });
    let flash = 0, rgb = "#ffffff";
    for (const fl of solved.flashes) { const d = f - fl.frame; if (d >= 0 && d < fl.len) { const x = fl.peak * (1 - d / fl.len) ** 2; if (x > flash) { flash = x; rgb = fl.color; } } }
    if (flash > 0) list.push({ op: "fill", stops: [[0, rgb], [1, rgb]], opacity: flash, screen: true });
    return list;
  };
  return { frame, views };
}
