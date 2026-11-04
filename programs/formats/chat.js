// The chat format's drawing. It joins a film that says `use chat` in film/meaning.txt. Blocking draws one panel per `in=`, so a chat plays before any program exists.
import { about3, mul3, persp3, pop, prog, scale3, translate3, wrap } from "../lib.js";

const CHAT = { bg: "#ece6dd", header: "#f7f8fa", in: "#ffffff", out: "#d9fdd3", ink: "#111b21" };

const bubbleMetrics = (comp, m, size, maxW) => {
  const o = { size, weight: 600, tracking: -0.012 };
  const padX = size * 0.56, padT = size * 0.36, padB = size * 0.34;
  const lines = wrap(comp, m.text, o, maxW - padX * 2);
  const textW = Math.max(...lines.map((l) => comp.measure({ ...o, text: l }).width));
  const tail = m.side === "out" ? size * 0.5 + size * 0.06 : 0;
  const lh = size * 1.24;
  return { lines, w: Math.ceil(textW + padX * 2), h: padT + lines.length * lh + padB + tail, padX, padT, lh, o };
};
function bubbleOps(m, met, f, size, x, y, innerW) {
  const isOut = m.side === "out", p = pop(f, m.at, 7);
  const bx = isOut ? x + innerW - met.w : x, ox = isOut ? bx + met.w : bx;
  const M = mul3(translate3(0, (1 - p) * 18), about3(ox, y, scale3(0.82 + 0.18 * p)));
  const r = isOut ? [size * 0.56, size * 0.12, size * 0.56, size * 0.56] : [size * 0.12, size * 0.56, size * 0.56, size * 0.56];
  const kids = [
    { op: "shadow", x: bx, y, w: met.w, h: met.h, r: size * 0.4, blur: 30, dy: 10, color: "rgba(0,0,0,0.10)" },
    { op: "shadow", x: bx, y, w: met.w, h: met.h, r: size * 0.4, blur: 0.5, dy: 2, color: "rgba(17,27,33,0.10)" },
    { op: "rect", id: `${m.id}.box`, x: bx, y, w: met.w, h: met.h, radii: r, color: isOut ? CHAT.out : CHAT.in },
  ];
  met.lines.forEach((l, i) => kids.push({ op: "text", id: i === 0 ? m.id : `${m.id}.${i + 1}`, text: l, size, weight: 600, tracking: -0.012, color: CHAT.ink, x: bx + met.padX, y: y + met.padT + met.lh * i + size * 0.93 }));
  if (isOut) kids.push({ op: "image", key: "ticks", x: bx + met.w - met.padX + size * 0.12 - size * 0.675, y: y + met.h - size * 0.34 - size * 0.5, w: size * 0.675, h: size * 0.5 });
  return { op: "group", m: M, opacity: Math.min(1, p * 1.6), children: kids };
}
/** One panel: header, message stack with a push-up motion, composer. Heights come from text. name and composer are words on screen, so the score gives them. */
export function chatPanel(comp, { x, y, w, h, size = 50, msgs, f, name = "", composer: composerText = "", persp, keep = 7, id }) {
  const headerH = size * 2.7, composerH = size * 2.3, r = size * 0.9, padX = size * 0.5, innerW = w - padX * 2;
  const visible = msgs.filter((m) => f >= m.at).slice(-keep);
  const bodyBottom = y + h - composerH - size * 0.3;
  const stack = [];
  let bottom = bodyBottom; const pad = size * 0.3;
  for (let i = visible.length - 1; i >= 0; i--) {
    const m = visible[i], met = bubbleMetrics(comp, m, size, innerW * 0.84);
    const rowH = pad + met.h, g = prog(f, m.at, 6), t = Math.min((1 - g) * rowH, rowH - pad);
    const top = bottom - rowH + t;
    stack.unshift(bubbleOps(m, met, f, size, x + padX, top + pad, innerW));
    bottom = top;
  }
  const clipBody = { x, y: y + headerH, w, h: h - headerH - composerH, r: 0, fadeTop: 60 };
  const header = [
    { op: "rect", x, y, w, h: headerH, radii: [r, r, 0, 0], color: CHAT.header },
    { op: "rect", x, y: y + headerH - 2, w, h: 2, color: "rgba(17,27,33,0.06)" },
    { op: "image", key: "avatar", x: x + size * 0.6, y: y + (headerH - size * 1.7) / 2, w: size * 1.7, h: size * 1.7 },
    name ? { op: "text", id: `${id}.name`, text: name, size, weight: 800, tracking: -0.02, color: CHAT.ink, x: x + size * 0.6 + size * 1.7 + size * 0.4, y: y + headerH / 2 + size * 0.36 } : null,
  ];
  const cy = y + h - composerH, bh = size * 1.6, bx = x + size * 0.4, sendX = x + w - size * 0.4 - bh, by = cy + (composerH - bh) / 2;
  const composer = [
    { op: "rect", x: bx, y: by, w: sendX - size * 0.3 - bx, h: bh, r: bh / 2, color: "#ffffff" },
    composerText ? { op: "text", id: `${id}.composer`, text: composerText, size: size * 0.86, weight: 600, color: "#8696a0", x: bx + size * 0.5, y: by + bh / 2 + size * 0.31, decor: true } : null,
    { op: "rect", x: sendX, y: by, w: bh, h: bh, r: bh / 2, color: "#1faa59" },
    { op: "image", key: "send", x: sendX + size * 0.4, y: by + size * 0.4, w: size * 0.8, h: size * 0.8 },
  ];
  return {
    op: "group", isolate: true, m: persp ? persp3(x + w / 2, y + h / 2, persp.d, persp.ry, persp.rx) : undefined, children: [
      { op: "shadow", x, y, w, h, r, blur: 120, dy: 40, color: "rgba(0,0,0,0.55)" },
      { op: "rect", x: x - 2, y: y - 2, w: w + 4, h: h + 4, r: r + 2, color: "rgba(255,255,255,0.06)" },
      { op: "rect", id: `${id}.bg`, x, y, w, h, r, color: CHAT.bg },
      { op: "group", clip: clipBody, children: stack },
      ...header, ...composer,
    ],
  };
}

// One panel takes the lower part of the frame. Several share it, stacked on a tall format and side by side on a wide one, so no panel hides another.
// A `panel` line's title and keep always apply, and its x, y, w and h apply on the default format.
function chatBlocking(v, f, ctx) {
  const { comp, fmt, solved, W, H } = ctx, sy = H / 1920, roles = solved.film?.roles?.role ?? {};
  const panels = {}; for (const t of v.texts) if (t.verb === "msg") (panels[t.kv.in] ??= []).push(t);
  const list = Object.entries(panels), n = list.length, wide = W > H, mx = 80 * W / 1080, gap = 30 * sy, many = n > 1;
  const pw = many && wide ? (W - 2 * mx - gap * (n - 1)) / n : W - 2 * mx, ph = many && !wide ? (H - 570 * sy - gap * (n - 1)) / n : 1000 * sy;
  return list.map(([id, ts], i) => {
    const ms = ts.map((t) => ({ id: t.id, side: roles[`side=${t.kv.side}`] === "sent" ? "out" : "in", at: v.ev(t.id.split(".")[1]), text: t.text })).sort((a, b) => a.at - b.at);
    const k = (solved.panels ?? {})[v.id]?.[id] ?? {}, own = fmt.id === solved.defaultFormat ? k : {};
    const S = { x: +(own.x ?? (many && wide ? mx + i * (pw + gap) : mx)), y: +(own.y ?? (many && !wide ? 480 * sy + i * (ph + gap) : H - 1090 * sy)), w: +(own.w ?? pw), h: +(own.h ?? ph) };
    return chatPanel(comp, { ...S, size: 50 * Math.min(1, W / 1080, S.w / 920), msgs: ms, f, keep: +(k.keep ?? 6), name: k.title ?? "", composer: k.composer ?? "", id: `${v.id}.${id}` });
  });
}

export async function install({ extra }) {
  extra.blocking = [...(extra.blocking ?? []), chatBlocking];
}
