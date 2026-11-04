// Two account cards, each with a status label and its lines. Every word comes from the score. SEED turns on one fault, for the tests.
import { INK, pop, prog } from "../lib.js";

const SEED = "";

export async function install({ gl, programs, extra, fmt }) {
  const W = fmt.w, H = fmt.h;
  if (SEED === "gl") {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
    programs.plain = { texture: () => tex };
  }
  const cardW = (W - 150) / 2, cardH = H - 200, Y = 100;
  const CARD = { A: 50, B: 100 + cardW };
  const ink = { label: "#ffffff", box: "#a33a2a" };
  extra.s02 = (v, f) => {
    const flipAt = v.ev("flipA");
    const ops = [{ op: "fill", stops: [[0, "#10141c"], [1, "#04060a"]], g: [0, 0, 0, H] }];
    if (SEED === "flow") for (let i = 0; i < 16; i++) ops.push({ op: "rect", x: i * 80 + (f % 2 ? 3 : -3), y: 0, w: 40, h: H, color: i % 2 ? "#cccccc" : "#333333" });
    for (const [p, x] of Object.entries(CARD)) {
      const kids = [{ op: "rect", id: `${v.id}.${p}.bg`, x, y: Y, w: cardW, h: cardH, r: 28, color: "#f4f1ea" }];
      let y = Y + 150;
      for (const t of v.texts.filter((q) => q.kv.on === p && q.id.split(".").length === 2).sort((a, b) => v.ev(a.id.split(".")[1]) - v.ev(b.id.split(".")[1]))) {
        const name = t.id.split(".")[1], at = v.ev(name), o = Math.min(1, pop(f, at, 7) * 1.5);
        if (f < at) continue;
        if (t.verb === "tag") {
          const flipped = t.kv.flip && f >= flipAt, words = flipped ? t.kv.flip : t.text;
          const box = SEED === "contrast" ? "#8a8a8a" : ink.box, inkC = SEED === "contrast" ? "#9a9a9a" : ink.label;
          kids.push({ op: "rect", x: x + 30, y: Y + 40, w: 260, h: 72, r: 20, color: flipped ? "#1f7a45" : box, opacity: o });
          kids.push({ op: "text", id: flipped ? `${t.id}.flip` : t.id, text: words, size: 44, weight: 800, color: inkC, x: x + 160, y: Y + 92, align: "center", opacity: o });
        } else {
          let lx = x + 30, ly = y + 40;
          if (SEED === "jitter") lx += (f % 2 ? 2 : -2);
          if (SEED === "spike" && f === at + 30) ly += 200;
          const line = { op: "text", id: t.id, text: t.text, size: 34, weight: 600, color: "#14181f", x: lx, y: ly, align: "left", opacity: o };
          kids.push(SEED === "clip" ? { op: "group", clip: { x, y: ly - 14, w: cardW, h: 40 }, children: [line] } : line);
          y += 70;
        }
      }
      ops.push(...kids);
    }
    if (SEED === "snap") for (let i = 0; i < 8; i++) ops.push({ op: "rect", decor: true, x: 20 + i * 150, y: 690 - f * 0.5 + (f >= 120 ? 28 : 0), w: 120, h: 20, color: "#39424f" });
    if (SEED === "gl") ops.push({ op: "gl", program: "plain", params: {} });
    if (SEED === "cover") {
      for (let i = 0; i < 12; i++) ops.push({ op: "text", decor: true, text: `word${i}`, size: 30, weight: 600, color: "#ffffff", x: 40 + i * 100, y: 60, align: "left" });
      if (f > 10) ops.push({ op: "rect", x: 0, y: 0, w: W, h: 80, color: "#202833" });
    }
    return ops;
  };
}
