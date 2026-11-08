// movas: compile a film's score files into a solved timeline. Zero dependencies.
// Runs under Deno, Bun or Node 26 (type stripping). Prototype, 2026-10-31.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

export type Loc = { file: string; line: number };
export type Line = { loc: Loc; verb: string; id?: string; at?: string; kv: Record<string, string>; text?: string; words: string[] };
export type Problem = { level: "error" | "warn"; code: string; msg: string; loc?: Loc; id?: string };

// ---------- Parsing: one cue per line ----------
const TOKEN = /(?:([^\s"=]+)=)?"((?:[^"\\]|\\.)*)"|(\S+)/g;

export const parseLine = (src: string, loc: Loc): Line | null => {
  // A comment is "#" at line start or after a space, followed by a space. Colors such as #ff6a4a are values.
  const hash = (() => { let q = false; for (let i = 0; i < src.length; i++) { if (src[i] === '"') q = !q; if (src[i] === "#" && !q && (i === 0 || /\s/.test(src[i - 1])) && (i + 1 === src.length || /\s/.test(src[i + 1]))) return i; } return -1; })();
  const s = (hash >= 0 ? src.slice(0, hash) : src).trim();
  if (!s) return null;
  const unq = (x: string) => x.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
  const out: Line = { loc, verb: "", kv: {}, words: [] };
  let first = true;
  for (const m of s.matchAll(TOKEN)) {
    if (m[2] !== undefined) {
      if (m[1]) out.kv[m[1]] = unq(m[2]);
      else out.text = unq(m[2]);
      continue;
    }
    const t = m[3];
    if (first) { out.verb = t; first = false; continue; }
    if (t.startsWith("@") || /^[+-]\d/.test(t)) { out.at = t; continue; }
    const eq = t.indexOf("=");
    if (eq > 0) { out.kv[t.slice(0, eq)] = t.slice(eq + 1); continue; }
    if (out.id === undefined) out.id = t;
    else out.words.push(t);
  }
  return out;
};

export const parseFile = (file: string, text: string): Line[] => {
  const lines: Line[] = [];
  text.split("\n").forEach((src, i) => { const l = parseLine(src, { file, line: i + 1 }); if (l) lines.push(l); });
  return lines;
};

// ---------- Film model ----------
export type Grid = { kind: "beat"; bpm: number; firstFrame: number } | { kind: "seconds" };
export type Ev = { id: string; beat: number; frame: number; sec: number; bar: number; beatInBar: number; onKick: boolean; srcLoc?: Loc; verb?: string };

export type Scene = { id: string; title: string; file: string; lines: Line[]; args: Record<string, string> };
export type Film = {
  uses: string[]; roles: Record<string, Record<string, string>>;
  name: string; fps: number; grid: Grid; formats: Record<string, { w: number; h: number }>; defaultFormat: string;
  music?: { id: string; file: string; trim: number; gain: number; fadein: number; fadeout: number; marks: Record<string, string>; align?: string };
  duck?: { target: string; gain: number; on: string[]; releaseFrames: number };
  sfxGain: number; sfxCap: string; soundRoots: Record<string, { dir: string; ext: string; license?: string; source?: string }>;
  order: string[]; scenes: Record<string, Scene>;
  rules: Line[]; styles: Line[]; assets: Line[];
};

const num = (s: string | undefined, d: number) => (s === undefined ? d : parseFloat(s));

const envSets = (): Record<string, string> => { try { const g = globalThis as any; return JSON.parse((g.Deno ? g.Deno.env.get("MOVAS_SET") : g.process?.env?.MOVAS_SET) ?? "{}"); } catch { return {}; } };

export const loadFilm = (dir: string, sets: Record<string, string> = envSets()): Film => {
  const film: Film = { uses: [], roles: {}, name: "film", fps: 30, grid: { kind: "seconds" }, formats: {}, defaultFormat: "", order: [], scenes: {}, rules: [], styles: [], assets: [], sfxGain: 1, sfxCap: "6b", soundRoots: {} };
  const fmts = readFormats(dir); film.uses = fmts.used; film.roles = fmts.roles;
  const files = readdirSync(dir).filter((f) => f.endsWith(".movas")).sort();
  // `var name "value"` declares a value, ${name} uses it, and MOVAS_SET overrides it. This is how one score makes many variants.
  const raw = files.map((f) => [f, readFileSync(join(dir, f), "utf8")] as const), vars: Record<string, string> = {};
  for (const [, t] of raw) for (const m of t.matchAll(/^var\s+(\w+)\s+"?([^"\n]*)"?\s*$/gm)) vars[m[1]] = m[2];
  Object.assign(vars, sets);
  (film as any).vars = vars; (film as any).unresolved = [];
  try { (film as any).probe = JSON.parse(readFileSync(join(dir, "probe.json"), "utf8")); } catch { (film as any).probe = {}; }
  const subst = (t: string) => t.replace(/\$\{(\w+)\}/g, (m, k) => { if (k in vars) return vars[k]; (film as any).unresolved.push(k); return m; });
  const marks: Record<string, string> = {};
  for (const [f, text] of raw) {
    const lines = parseFile(f, subst(text));
    if (lines[0]?.verb === "scene") {
      const h = lines[0];
      film.scenes[h.id!] = { id: h.id!, title: h.text ?? h.id!, file: f, lines: lines.slice(1), args: h.kv };
      continue;
    }
    for (const l of lines) {
      switch (l.verb) {
        case "film": film.name = l.id ?? "film"; film.fps = num(l.kv.fps, 30); break;
        case "format": { const [w, h] = (l.words[0] ?? "").split("x").map(Number); film.formats[l.id!] = { w, h }; if ("default" in l.kv || l.words.includes("default") || !film.defaultFormat) film.defaultFormat = l.words.includes("default") ? l.id! : film.defaultFormat || l.id!; break; }
        case "grid": film.grid = l.id === "beat" ? { kind: "beat", bpm: num(l.kv.bpm, 120), firstFrame: parseFloat(l.kv.first ?? "0") } : { kind: "seconds" }; break;
        case "music": film.music = { id: l.id!, file: l.kv.file, trim: parseFloat(l.kv.trim ?? "0"), gain: num(l.kv.gain, 1), fadein: parseFloat(l.kv.fadein ?? "0"), fadeout: parseFloat(l.kv.fadeout ?? "0"), marks: {}, align: l.kv.align }; break;
        case "mark": marks[l.id!] = l.words[0] ?? l.kv.every ?? ""; break;
        case "duck": film.duck = { target: l.id!, gain: parseFloat(l.kv.gain), on: (l.kv.on ?? "").split(","), releaseFrames: parseFloat(l.kv.release ?? "8") }; break;
        case "bus": if (l.id === "sfx") film.sfxGain = parseFloat(l.kv.gain); break;
        case "sfxcap": film.sfxCap = l.id ?? "6b"; break;
        case "soundroot": film.soundRoots[l.id!] = { dir: l.kv.dir, ext: l.kv.ext, license: l.kv.license, source: l.kv.source }; break;
        case "order": film.order = [l.id!, ...l.words]; break;
        case "rule": film.rules.push(l); break;
        case "style": film.styles.push(l); break;
        case "asset": film.assets.push(l); break;
      }
    }
  }
  // Marks are read in any order, so a mark line may come before the music line it belongs to.
  if (film.music) film.music.marks = { ...film.music.marks, ...marks };
  return film;
};

// ---------- Time ----------
export type Clock = { fpb: number; first: number; fps: number; isBeat: boolean; beatsPerBar: number };
export const clockOf = (film: Film): Clock => film.grid.kind === "beat"
  ? { fpb: (film.fps * 60) / film.grid.bpm, first: film.grid.firstFrame, fps: film.fps, isBeat: true, beatsPerBar: 4 }
  : { fpb: film.fps, first: 0, fps: film.fps, isBeat: false, beatsPerBar: 4 };
export const frameOf = (c: Clock, b: number) => (b <= 0 ? 0 : Math.round(c.first + b * c.fpb));
export const beatOfFrame = (c: Clock, f: number) => (f - c.first) / c.fpb;

const durToBeats = (c: Clock, tok: string): number => {
  const m = /^([0-9]*\.?[0-9]+)(bar|b|s|f)?$/.exec(tok);
  if (!m) throw new Error(`bad duration "${tok}"`);
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case "bar": return v * c.beatsPerBar;
    case "b": case undefined: return v;
    case "s": return (v * c.fps) / c.fpb;
    case "f": return v / c.fpb;
  }
  return v;
};
const framesOfDur = (c: Clock, tok: string): number => {
  const m = /^([0-9]*\.?[0-9]+)(bar|b|s|f)?$/.exec(tok)!;
  const v = parseFloat(m[1]);
  return m[2] === "f" ? v : m[2] === "s" ? v * c.fps : v * c.fpb * (m[2] === "bar" ? c.beatsPerBar : 1);
};

const snapUp = (c: Clock, v: number, snap: string): number => {
  const EPS = 1e-9;
  if (snap === "kick" || snap === "bar") { const q = c.beatsPerBar; return Math.ceil(v / q - EPS) * q; }
  const q = durToBeats(c, snap);
  return Math.ceil(v / q - EPS) * q;
};

// ---------- Words and reading ----------
export const plain = (s: string) => s.replace(/\*/g, "").replace(/\s\/\s/g, " ");
export const wordCount = (s: string) => plain(s).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Verbs that take no quoted text of their own, with the keys that hold their words. An empty list means the verb has none. */
export const WORD_KEYS: Record<string, string[]> = {
  mark: ["span"], panel: ["title"], credits: ["title", "by", "license"],
  sfx: [], pulse: [], end: [], assert: [], clip: [],
};

// ---------- Formats: a pack in tool/packs that a film opts into with `use <pack>` in film/meaning.txt ----------
export type VerbDef = { pack: string; words: string[]; needs: string[]; time?: string; ref?: string };
const PACKS_DIR = new URL("./packs/", import.meta.url).pathname;
/** Every format verb in tool/packs. `verb msg needs=in,side`, `verb chat words=q,a time=reply ref=chat`. */
export const FORMAT_VERBS: Record<string, VerbDef> = (() => {
  const out: Record<string, VerbDef> = {};
  for (const f of readdirSync(PACKS_DIR).filter((x) => x.endsWith(".meaning")).sort()) {
    for (const raw of readFileSync(join(PACKS_DIR, f), "utf8").split("\n")) {
      const m = /^verb\s+(\S+)(.*)$/.exec(raw.trim());
      if (!m) continue;
      const kv = Object.fromEntries(m[2].trim().split(/\s+/).filter(Boolean).map((p) => p.split("=")));
      out[m[1]] = { pack: f.replace(/\.meaning$/, ""), words: kv.words ? kv.words.split(",") : [], needs: kv.needs ? kv.needs.split(",") : [], time: kv.time, ref: kv.ref };
    }
  }
  for (const [v, d] of Object.entries(out)) if (d.words.length) WORD_KEYS[v] = d.words;
  return out;
})();
/** The packs a film names and its `fact` lines, read from film/meaning.txt and from the tool's packs it names. A film's own pack in film/packs can add rules, not verbs. */
export const readFormats = (dir: string): { used: string[]; roles: Record<string, Record<string, string>> } => {
  let text = "";
  try { text = readFileSync(join(dir, "meaning.txt"), "utf8"); } catch { /* a film with no meaning file uses no format */ }
  const used: string[] = [], roles: Record<string, Record<string, string>> = {};
  const facts = (t: string) => { for (const raw of t.split("\n")) { const m = /^fact\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(raw.trim()); if (m) (roles[m[1]] ??= {})[m[2]] = m[3]; } };
  for (const raw of text.split("\n")) {
    const m = /^use\s+(\S+)\s*$/.exec(raw.trim());
    if (!m) continue;
    used.push(m[1]);
    if (existsSync(join(PACKS_DIR, `${m[1]}.meaning`))) facts(readFileSync(join(PACKS_DIR, `${m[1]}.meaning`), "utf8"));
  }
  facts(text);
  return { used, roles };
};
/** `q=`, `q= and a=`, `title=, by= and license=`. */
export const keysPhrase = (keys: string[]): string => (keys.length < 2 ? keys.map((k) => `${k}=`).join("") : `${keys.slice(0, -1).map((k) => `${k}=`).join(", ")} and ${keys[keys.length - 1]}=`);

// ---------- Solve: every event is a pure function of earlier events ----------
export type Solved = {
  film: Film; clock: Clock; events: Record<string, Ev>; texts: TextRow[]; sfx: SfxRow[]; floors: FloorRow[]; problems: Problem[]; scenes: SceneRow[]; durationFrames: number; snaps: SnapRow[]; ducks: number[]; duckSpans: { from: number; to: number }[]; media: any[]; style: Record<string, Record<string, string>>; defaultFormat: string; trimBeats: number; flashes: { id: string; frame: number; color: string; peak: number; len: number }[]; kvOf: Record<string, Record<string, string>>; panels: Record<string, Record<string, Record<string, string>>>;
};
export type TextRow = { id: string; scene: string; verb: string; text: string; words: number; at: string; out?: string; kv: Record<string, string>; loc: Loc };
export type SfxRow = { key: string; scene: string; at: string; beat: number; frame: number; file: string; vol: number; cls: string; loc: Loc };
export type FloorRow = { id: string; rule: string; words: number; needFrame: number; gotFrame: number; slackFrames: number };
export type SceneRow = { id: string; title: string; startFrame: number; endFrame: number; startBeat: number; endBeat: number; program?: string; pre: number; post: number };
export type SnapRow = { id: string; addedBeats: number; snap: string };

export const solve = (film: Film, publicDir?: string): Solved => {
  const c = clockOf(film);
  const P: Problem[] = [];
  const beats: Record<string, number> = {};
  const lineOf: Record<string, Line> = {};
  const defs: Record<string, () => number> = {};
  const memo: Record<string, number> = {};
  const stack: string[] = [];
  const texts: TextRow[] = [];
  const media: any[] = [];
  const floors: FloorRow[] = [];
  const snaps: SnapRow[] = [];
  const sfxLines: { scene: string; l: Line; prev: string; idx: number }[] = [];

  const ruleOf = (id: string) => film.rules.find((r) => r.id === id);
  const readFrames = (ruleId: string, words: number): number => {
    const r = ruleOf(ruleId);
    if (!r) { P.push({ level: "error", code: "rule.missing", msg: `rule ${ruleId} is not defined` }); return 0; }
    const perWord = Math.round(parseFloat(r.kv.per_word) * 1000);
    const base = Math.round(parseFloat(r.kv.base) * 1000);
    return Math.ceil(((perWord * words + base) * film.fps) / 1000);
  };
  const styleVal = (verb: string, key: string, d: string) => film.styles.find((s) => s.id === verb)?.kv[key] ?? d;

  const get = (id: string): number => {
    if (id in memo) return memo[id];
    if (stack.includes(id)) throw new Error(`time cycle: ${[...stack, id].join(" -> ")}`);
    const f = defs[id];
    if (!f) throw new Error(`unknown event "${id}"`);
    stack.push(id);
    const v = f();
    stack.pop();
    memo[id] = v;
    return v;
  };

  const resolveRef = (scene: string, ref: string): string => {
    if (ref.includes(".") && ref.split(".")[0] in film.scenes) return ref;
    return `${scene}.${ref}`;
  };

  // "@ref+1.5b~0.5b", "+2b", "@max(a,b)+1b"
  const evalAt = (scene: string, expr: string, prev: string | null, owner: string): number => {
    let e = expr;
    let snap: string | undefined;
    const ti = e.indexOf("~");
    if (ti >= 0) { snap = e.slice(ti + 1); e = e.slice(0, ti); }
    let base: number;
    let rest: string;
    if (e.startsWith("@")) {
      const m = /^@(max\([^)]*\)|[^+\-]+)(.*)$/.exec(e)!;
      const r = m[1];
      rest = m[2];
      if (r.startsWith("max(")) base = Math.max(...r.slice(4, -1).split(",").map((x) => get(resolveRef(scene, x.trim()))));
      else base = get(resolveRef(scene, r));
    } else {
      if (!prev) throw new Error(`relative time without a previous event at ${owner}`);
      base = get(prev);
      rest = e;
    }
    for (const m of rest.matchAll(/([+\-])([0-9.]+(?:bar|b|s|f)?)/g)) base += (m[1] === "+" ? 1 : -1) * durToBeats(c, m[2]);
    if (snap) {
      const s = snapUp(c, base, snap);
      if (s - base > 1e-9) snaps.push({ id: owner, addedBeats: +(s - base).toFixed(4), snap });
      base = s;
    }
    return base;
  };

  // Scene starts: each scene starts at the previous scene's end unless it says otherwise.
  film.order.forEach((sid, i) => {
    const s = film.scenes[sid];
    if (!s) { P.push({ level: "error", code: "scene.missing", msg: `order names scene ${sid}, which has no file` }); return; }
    defs[`${sid}.start`] = () => {
      if (s.args.start) return evalAt(sid, s.args.start, null, `${sid}.start`);
      return i === 0 ? 0 : get(`${film.order[i - 1]}.end`);
    };
  });

  for (const sid of film.order) {
    const s = film.scenes[sid];
    if (!s) continue;
    let prev: string = `${sid}.start`;
    const seen = new Set<string>();
    for (let idx = 0; idx < s.lines.length; idx++) {
      const l = s.lines[idx];
      if (l.verb === "sfx" || l.verb === "pulse") { sfxLines.push({ scene: sid, l, prev, idx }); continue; }
      if (l.verb === "assert") continue;
      if (l.verb === "end") {
        const p = prev;
        defs[`${sid}.end`] = () => evalAt(sid, l.at!, p, `${sid}.end`);
        lineOf[`${sid}.end`] = l;
        continue;
      }
      if (!l.id) { if (l.at) P.push({ level: "error", code: "cue.noid", msg: `${l.verb} has a time but no id`, loc: l.loc }); continue; }
      const eid = `${sid}.${l.id}`;
      if (seen.has(l.id)) P.push({ level: "error", code: "cue.dup", msg: `duplicate id ${eid}`, loc: l.loc, id: eid });
      seen.add(l.id);
      lineOf[eid] = l;
      const p = prev;
      if (l.at) defs[eid] = () => evalAt(sid, l.at!, p, eid);
      if (l.text !== undefined) texts.push({ id: eid, scene: sid, verb: l.verb, text: l.text, words: wordCount(l.text), at: eid, kv: l.kv, loc: l.loc });
      for (const k of ["title", "flip", "by", "license", ...Object.values(FORMAT_VERBS).flatMap((d) => d.words)]) {
        if (l.kv[k] !== undefined && (l.verb !== "panel")) texts.push({ id: `${eid}.${k}`, scene: sid, verb: l.verb, text: l.kv[k], words: wordCount(l.kv[k]), at: eid, kv: l.kv, loc: l.loc });
      }
      const fmtVerb = FORMAT_VERBS[l.verb];
      if (fmtVerb && !film.uses.includes(fmtVerb.pack)) P.push({ level: "error", code: "format.needed", msg: `${eid}: ${l.verb} belongs to the ${fmtVerb.pack} format. Add this line to film/meaning.txt: use ${fmtVerb.pack}`, loc: l.loc, id: eid });
      if (fmtVerb && film.uses.includes(fmtVerb.pack)) for (const k of fmtVerb.needs) if (l.kv[k] === undefined) P.push({ level: "error", code: "format.key", msg: `${eid}: ${l.verb} needs ${k}=`, loc: l.loc, id: eid });
      if (fmtVerb?.time && l.kv[fmtVerb.time]) { const rp = p, key = fmtVerb.time; defs[`${eid}.${key}`] = () => evalAt(sid, l.kv[key], rp, `${eid}.${key}`); lineOf[`${eid}.${key}`] = l; }

      if (l.verb === "punch") {
        const groups = (l.text ?? "").split(/\s\/\s/);
        const offsets = l.kv.offsets ? l.kv.offsets.split(",").map(parseFloat) : groups.map((_, i) => i * durToBeats(c, l.kv.step ?? "0.5b"));
        groups.forEach((_, i) => { defs[`${eid}.g${i + 1}`] = () => get(eid) + (offsets[i] ?? 0); });
        const inF = parseFloat(styleVal("punch", "in", "7f"));
        defs[`${eid}.land`] = () => beatOfFrame(c, frameOf(c, get(`${eid}.g${groups.length}`)) + inF);
        // A block read together: floor counts every word and starts from the last landing.
        const partners = () => Object.keys(lineOf).filter((k) => k !== eid && lineOf[k].verb === "punch" && lineOf[k].kv.with === l.id && k.startsWith(`${sid}.`));
        defs[`${eid}.floor`] = () => {
          if (l.kv.with) return get(`${sid}.${l.kv.with}.floor`);
          const ps = partners();
          const words = wordCount(l.text ?? "") + ps.reduce((n, k) => n + wordCount(lineOf[k].text ?? ""), 0);
          const land = Math.max(frameOf(c, get(`${eid}.land`)), ...ps.map((k) => frameOf(c, get(`${k}.land`))));
          const need = land + readFrames(l.kv.rule ?? "read.punch", words);
          return beatOfFrame(c, need);
        };
        defs[`${eid}.out`] = () => {
          if (l.kv.with) return get(`${sid}.${l.kv.with}.out`);
          if (l.kv.out === "none") return get(`${sid}.end`);
          if (l.kv.out) return evalAt(sid, l.kv.out, null, `${eid}.out`);
          return snapUp(c, get(`${eid}.floor`), l.kv.snap ?? styleVal("punch", "snap", "0.25b"));
        };
        prev = `${eid}.out`;
        continue;
      }
      if (l.verb === "dock") {
        const lines = (l.text ?? "").split("\n").length;
        const lineIn = parseFloat(styleVal("dock", "line", "8f")), stagger = parseFloat(styleVal("dock", "stagger", "3f")), dockF = parseFloat(styleVal("dock", "dock", "10f"));
        const fullyOn = lineIn + stagger * (lines - 1);
        defs[`${eid}.on`] = () => beatOfFrame(c, frameOf(c, get(eid)) + fullyOn);
        defs[`${eid}.undock`] = () => beatOfFrame(c, frameOf(c, get(`${eid}.on`)) + readFrames(l.kv.rule ?? "read.dock", wordCount(l.text ?? "")));
        defs[`${eid}.docked`] = () => beatOfFrame(c, frameOf(c, get(`${eid}.undock`)) + dockF);
        defs[`${eid}.out`] = () => (l.kv.out ? evalAt(sid, l.kv.out, null, `${eid}.out`) : get(`${eid}.docked`));
        prev = l.at ? eid : prev;
        continue;
      }
      if (l.verb === "typed") {
        const step = parseFloat(l.kv.step ?? "2f");
        const chars = (l.text ?? "").length;
        defs[`${eid}.done`] = () => beatOfFrame(c, frameOf(c, get(eid)) + (chars - 1) * step);
        defs[`${eid}.floor`] = () => beatOfFrame(c, frameOf(c, get(`${eid}.done`)) + framesOfDur(c, l.kv.hold ?? "0f"));
        prev = `${eid}.floor`;
        continue;
      }
      if (l.verb === "vo" || l.verb === "clip") {
        // Length comes from the media itself, through the ledger that `./movas probe` writes. The next line can follow @id.out.
        const info = (film as any).probe?.[l.kv.file];
        if (!info) P.push({ level: "error", code: "probe.missing", msg: `${eid}: no length known for ${l.kv.file}. Run ./movas probe`, loc: l.loc });
        const from = parseFloat(l.kv.in ?? "0");
        const durF = l.kv.dur ? framesOfDur(c, l.kv.dur) : Math.round(Math.max(0, (info?.duration ?? 0) - from) * c.fps);
        defs[`${eid}.out`] = () => beatOfFrame(c, frameOf(c, get(eid)) + durF + (l.kv.gap ? framesOfDur(c, l.kv.gap) : 0));
        media.push({ id: eid, scene: sid, verb: l.verb, file: l.kv.file, inSec: from, durFrames: durF, srcFps: info?.fps ?? c.fps, framesUrl: info?.frames, w: info?.w, h: info?.h, kv: l.kv });
        prev = `${eid}.out`;
        continue;
      }
      if (l.verb === "credits") {
        // Duration from the asset ledger's words: reading rule plus entrance, minus any beats the human gave away.
        defs[`${eid}.floor`] = () => {
          const words = creditWords(film, l);
          const secs = parseFloat(l.kv.entrance ?? "1.05") + (parseFloat(ruleOf(l.kv.rule ?? "read.credits")?.kv.per_word ?? "0.2") * words + parseFloat(ruleOf(l.kv.rule ?? "read.credits")?.kv.base ?? "2"));
          return get(eid) + Math.ceil((secs * c.fps) / c.fpb - 1e-9) - durToBeats(c, l.kv.give ?? "0b");
        };
        prev = `${eid}.floor`;
        continue;
      }
      if (l.at) prev = eid;
    }
    if (!defs[`${sid}.end`]) P.push({ level: "error", code: "scene.noend", msg: `scene ${sid} has no end line`, loc: s.lines[0]?.loc });
  }

  // Evaluate everything; collect precise errors rather than stopping at the first.
  for (const id of Object.keys(defs)) {
    try { beats[id] = get(id); } catch (e) {
      stack.length = 0;
      P.push({ level: "error", code: "time.eval", msg: `${id}: ${(e as Error).message}`, loc: lineOf[id]?.loc, id });
    }
  }

  // Reading floors, always checked.
  for (const [id, l] of Object.entries(lineOf)) {
    if (l.verb === "punch" && !l.kv.with && beats[`${id}.floor`] !== undefined && beats[`${id}.out`] !== undefined) {
      const need = frameOf(c, beats[`${id}.floor`]);
      const got = frameOf(c, beats[`${id}.out`]);
      const partners = Object.keys(lineOf).filter((k) => lineOf[k].kv.with === l.id && lineOf[k].verb === "punch" && k.split(".")[0] === id.split(".")[0]);
      const words = wordCount(l.text ?? "") + partners.reduce((n, k) => n + wordCount(lineOf[k].text ?? ""), 0);
      floors.push({ id, rule: l.kv.rule ?? "read.punch", words, needFrame: need, gotFrame: got, slackFrames: got - need });
      if (got < need) P.push({ level: "error", code: "read.floor", msg: `${id} leaves at frame ${got}, its reading rule needs ${need}`, loc: l.loc, id });
    }
    if (l.verb === "dock" && beats[`${id}.docked`] !== undefined) {
      const need = frameOf(c, beats[`${id}.docked`]);
      const got = frameOf(c, beats[`${id}.out`]);
      floors.push({ id, rule: l.kv.rule ?? "read.dock", words: wordCount(l.text ?? ""), needFrame: need, gotFrame: got, slackFrames: got - need });
      if (got < need) P.push({ level: "error", code: "read.floor", msg: `${id} leaves at frame ${got} before docking at ${need}`, loc: l.loc, id });
      if (l.kv.resume) { const r = evalAt(id.split(".")[0], l.kv.resume, null, `${id}.resume`); if (frameOf(c, r) < need) P.push({ level: "error", code: "read.floor", msg: `${id}: action resumes at frame ${frameOf(c, r)} before docking at ${need}`, loc: l.loc, id }); }
    }
  }

  // References inside text: a mark must point at a span that exists in its target's text.
  for (const sid of film.order) {
    const s = film.scenes[sid];
    if (!s) continue;
    for (const l of s.lines) {
      if (l.verb === "mark") {
        const tgt = texts.find((t) => t.id === `${sid}.${l.kv.on}`);
        if (!tgt) P.push({ level: "error", code: "ref.missing", msg: `mark ${l.id}: no text with id ${l.kv.on}`, loc: l.loc });
        else if (l.kv.span && !plain(tgt.text).includes(l.kv.span)) P.push({ level: "error", code: "ref.span", msg: `mark ${l.id}: span "${l.kv.span}" is not in ${tgt.id}: "${plain(tgt.text)}"`, loc: l.loc });
      }
      for (const [k, v] of Object.entries(l.kv)) {
        const owner = Object.entries(FORMAT_VERBS).find(([, d]) => d.ref === k)?.[0];
        if (owner && !s.lines.some((o) => o.verb === owner && o.id === v)) P.push({ level: "error", code: "ref.missing", msg: `${l.verb} ${l.id}: no ${owner} ${v}`, loc: l.loc });
      }
    }
  }

  // Sound rows: explicit lines, patterns, and sounds attached to a cue. A row has one cause and no time of its own.
  const sfx: SfxRow[] = [];
  const pathOf = (tok: string): string => {
    const i = tok.indexOf("/");
    const root = i > 0 ? film.soundRoots[tok.slice(0, i)] : undefined;
    return root ? `${root.dir}/${tok.slice(i + 1)}${root.ext}` : tok;
  };
  const pushRow = (key: string, scene: string, at: string, b: number, tok: string, vol: number, loc: Loc) => {
    const file = pathOf(tok);
    sfx.push({ key, scene, at, beat: b, frame: frameOf(c, b), file, vol, cls: classOfFile(file), loc });
    if (publicDir && !existsSync(join(publicDir, file))) P.push({ level: "error", code: "asset.missing", msg: `${key}: sound file ${file} does not exist`, loc });
  };
  const evalVol = (spec: string, i: number): number => {
    const m = /^ramp\((.*)\)$/.exec(spec);
    if (!m) return parseFloat(spec);
    const knots = m[1].split(",").map((k) => k.split(":").map(parseFloat));
    for (let j = 0; j < knots.length - 1; j++) {
      const [i0, v0] = knots[j], [i1, v1] = knots[j + 1];
      if (i >= i0 && i <= i1) return v0 + ((v1 - v0) * (i - i0)) / (i1 - i0);
    }
    return knots[knots.length - 1][1];
  };
  const attach = (sid: string, eid: string, spec: string, loc: Loc) => {
    spec.split(",").forEach((one, i) => {
      const m = /^([^:]+):([0-9.]+)(?:([+-])([0-9.]+(?:bar|b|s|f)?))?$/.exec(one);
      if (!m) { P.push({ level: "error", code: "sfx.syntax", msg: `bad sound "${one}"`, loc }); return; }
      if (beats[eid] === undefined) return;
      const off = m[3] ? (m[3] === "+" ? 1 : -1) * durToBeats(c, m[4]) : 0;
      pushRow(`${eid}#${i}`, sid, `@${eid}`, beats[eid] + off, m[1], parseFloat(m[2]), loc);
    });
  };
  for (const { scene, l, prev, idx } of sfxLines) {
    let base = NaN;
    try { base = evalAt(scene, l.at ?? "+0b", prev, `${scene}.${l.verb}${idx}`); } catch (e) { P.push({ level: "error", code: "time.eval", msg: `${scene}.${l.verb}${idx}: ${(e as Error).message}`, loc: l.loc }); continue; }
    if (l.verb === "sfx") { pushRow(`${scene}.sfx${idx}`, scene, l.at ?? "", base, l.id ?? "", parseFloat(l.kv.vol ?? "1"), l.loc); continue; }
    const files = (l.kv.files ?? "").split(",").filter(Boolean);
    const times: number[] = [];
    if (l.kv.offs) for (const o of l.kv.offs.split(",")) times.push(base + parseFloat(o));
    else if (l.kv.gaps) { let f = 0; for (const g of l.kv.gaps.split(",")) { times.push(base + f / c.fpb); f += parseFloat(g); } }
    else {
      const every = durToBeats(c, l.kv.every ?? "1b");
      const n = l.kv.n ? parseInt(l.kv.n) : Infinity;
      let lim = Infinity, inclusive = false;
      try {
        if (l.kv.until) lim = evalAt(scene, l.kv.until, null, `${scene}.pulse${idx}`);
        if (l.kv.thru) { lim = evalAt(scene, l.kv.thru, null, `${scene}.pulse${idx}`); inclusive = true; }
      } catch (e) { P.push({ level: "error", code: "time.eval", msg: `pulse: ${(e as Error).message}`, loc: l.loc }); continue; }
      for (let i = 0; i < n && (inclusive ? base + i * every <= lim + 1e-9 : base + i * every < lim - 1e-9) && i < 4096; i++) times.push(base + i * every);
    }
    times.forEach((b, i) => pushRow(`${scene}.pulse${idx}.${i}`, scene, l.at ?? "", b, files[i % files.length], evalVol(l.kv.vol ?? "1", i), l.loc));
  }
  for (const sid of film.order) {
    for (const l of film.scenes[sid]?.lines ?? []) {
      if (l.verb === "sfx" || l.verb === "pulse") continue;
      const eid = l.verb === "end" ? `${sid}.end` : l.id ? `${sid}.${l.id}` : undefined;
      if (!eid) continue;
      if (l.kv.sfx && l.kv.sfx !== "none") attach(sid, eid, l.kv.sfx, l.loc);
      if (l.kv.hits && l.verb === "punch") {
        const groups = (l.text ?? "").split(/\s\/\s/);
        const hs = l.kv.hits.split(",");
        if (hs.length !== groups.length) P.push({ level: "error", code: "sfx.hits", msg: `${eid}: ${groups.length} word groups but ${hs.length} hits`, loc: l.loc });
        hs.forEach((h, i) => attach(sid, `${eid}.g${i + 1}`, h, l.loc));
      }
    }
  }

  // Flashes: light on a cut, declared on the cue that causes it.
  const flashes: { id: string; frame: number; color: string; peak: number; len: number }[] = [];
  const flashLoc = new Map<string, Loc>();
  for (const sid of film.order) for (const l of film.scenes[sid]?.lines ?? []) {
    if (!l.kv.flash || !l.id || beats[`${sid}.${l.id}`] === undefined) continue;
    const [col, peak, len] = l.kv.flash.split(":");
    flashes.push({ id: `${sid}.${l.id}`, frame: frameOf(c, beats[`${sid}.${l.id}`]), color: col, peak: parseFloat(peak), len: parseFloat(len) });
    flashLoc.set(`${sid}.${l.id}`, l.loc);
  }
  // Flash rate: no more than `max` flash starts in any window of `window` frames (WCAG 2.3.1: three flashes a second).
  const flashRule = ruleOf("flash.rate");
  if (flashRule) {
    const max = parseInt(flashRule.kv.max ?? "3"), win = framesOfDur(c, flashRule.kv.window ?? "30f");
    const byFrame = [...flashes].sort((a, b) => a.frame - b.frame), named = new Set<string>();
    for (const start of byFrame) {
      const inWindow = byFrame.filter((x) => x.frame >= start.frame && x.frame < start.frame + win);
      const ids = inWindow.map((x) => x.id).join(", ");
      if (inWindow.length > max && !named.has(ids)) {
        named.add(ids);
        P.push({ level: "error", code: "flash.rate", msg: `${inWindow.length} flashes in ${win} frames, the rule allows ${max}: ${ids}, first at f${start.frame}`, loc: flashLoc.get(start.id) });
      }
    }
  }
  // Which frames duck the bed: every PUNCH group and every cue marked duck=yes.
  const ducks: number[] = [];
  for (const sid of film.order) for (const l of film.scenes[sid]?.lines ?? []) {
    if (!l.id) continue;
    const eid = `${sid}.${l.id}`;
    if (l.verb === "punch" && film.duck?.on.includes("punch")) (l.text ?? "").split(/\s\/\s/).forEach((_, i) => { if (beats[`${eid}.g${i + 1}`] !== undefined) ducks.push(frameOf(c, beats[`${eid}.g${i + 1}`])); });
    if (l.kv.duck === "yes" && beats[eid] !== undefined) ducks.push(frameOf(c, beats[eid]));
  }
  ducks.sort((x, y) => x - y);
  // Speech plays whole, and the bed stays down for its full length when the film says `duck bed on=vo`.
  const duckSpans: { from: number; to: number }[] = [];
  for (const m of media.filter((x) => x.verb === "vo")) {
    const b = beats[m.id]; if (b === undefined) continue;
    pushRow(`${m.id}#vo`, m.scene, `@${m.id}`, b, m.file, parseFloat(m.kv.gain ?? "1"), lineOf[m.id].loc);
    if (film.duck?.on.includes("vo")) duckSpans.push({ from: frameOf(c, b), to: frameOf(c, b) + m.durFrames });
  }

  // Music alignment: the human's musical decision is an equation, and the trim is its solution.
  let trimBeats = film.music?.trim ?? 0;
  if (film.music?.align) {
    const m = /^([^.]+)\.(start|end)@(.+)$/.exec(film.music.align);
    const range = m && film.music.marks[m[1]];
    if (!m) P.push({ level: "error", code: "music.align", msg: `bad music align "${film.music.align}": write mark.start@event or mark.end@event` });
    else if (!range) P.push({ level: "error", code: "music.align", msg: `music align "${film.music.align}" names mark ${m[1]}, but no mark line defines ${m[1]} (marks: ${Object.keys(film.music.marks).join(", ") || "none"})` });
    else {
      const [a0, b0] = range.split("..").map(parseFloat);
      const point = m[2] === "end" ? b0 : a0;
      const ev = beats[m[3]];
      if (ev === undefined) P.push({ level: "error", code: "music.align", msg: `music align names unknown event ${m[3]}` });
      else {
        trimBeats = point - ev;
        if (trimBeats < 0) P.push({ level: "error", code: "music.align", msg: `aligning needs a negative trim of ${trimBeats} beats: ${m[3]} is too late for the music mark` });
        if (Math.abs(trimBeats / c.beatsPerBar - Math.round(trimBeats / c.beatsPerBar)) > 1e-6) P.push({ level: "error", code: "music.align", msg: `trim ${trimBeats} beats is not whole bars, so the kicks would not line up with ${m[3]}. Move ${m[3]} on a kick.` });
      }
    }
  }

  // Events table.
  const events: Record<string, Ev> = {};
  for (const [id, b] of Object.entries(beats)) {
    const f = frameOf(c, b);
    const l = lineOf[id];
    events[id] = { id, beat: +b.toFixed(5), frame: f, sec: +(f / c.fps).toFixed(3), bar: Math.floor(b / c.beatsPerBar + 1e-9), beatInBar: +(b - Math.floor(b / c.beatsPerBar + 1e-9) * c.beatsPerBar).toFixed(4), onKick: Math.abs(b / c.beatsPerBar - Math.round(b / c.beatsPerBar)) < 1e-6, srcLoc: l?.loc, verb: l?.verb };
  }

  // Assertions: "assert hit on=kick", "assert hit near=music.break.end tol=0.25b".
  for (const sid of film.order) {
    for (const l of film.scenes[sid]?.lines ?? []) {
      if (l.verb !== "assert" || !l.id) continue;
      const eid = resolveRef(sid, l.id);
      const e = events[eid];
      if (!e) { P.push({ level: "error", code: "assert.ref", msg: `assert names unknown event ${eid}`, loc: l.loc }); continue; }
      if (l.kv.on === "kick" && !e.onKick) P.push({ level: "error", code: "assert.phase", msg: `${eid} must land on a kick, it is at beat ${e.beat} (bar phase ${e.beatInBar})`, loc: l.loc, id: eid });
      if (l.kv.near && film.music) {
        const mk = l.kv.near.replace("music.", "");
        const [mid, edge] = mk.split(".");
        const range = film.music.marks[mid];
        if (range && range.includes("..")) {
          const [a, b] = range.split("..").map((x) => parseFloat(x));
          const target = (edge === "end" ? b : a) - trimBeats;
          const tol = durToBeats(c, l.kv.tol ?? "0.25b");
          if (Math.abs(e.beat - target) > tol) P.push({ level: l.kv.level === "warn" ? "warn" : "error", code: "assert.music", msg: `${eid} is at film beat ${e.beat}; music ${mid}.${edge} is at film beat ${target}`, loc: l.loc, id: eid });
        }
      }
    }
  }

  // Licences: a film that is sold may use only assets whose licence has no forbidden term. A licence kept in another file is a warning.
  const forbidden = (ruleOf("asset.license")?.kv.forbid ?? "").split(",").filter(Boolean).map((t) => t.toUpperCase());
  const licenceOf = (kind: string, id: string, lic: string | undefined, loc?: Loc) => {
    if (!lic) { P.push({ level: "error", code: "asset.license", msg: `${kind} ${id} has no license`, loc, id }); return; }
    if (lic.startsWith("see-")) { P.push({ level: "warn", code: "asset.license.indirect", msg: `${kind} ${id}: license "${lic}" is in another file, so it is not checked here`, loc, id }); return; }
    const terms = lic.toUpperCase().split(/[^A-Z0-9]+/), hit = forbidden.filter((t) => terms.includes(t));
    if (hit.length) P.push({ level: "error", code: "asset.license", msg: `${kind} ${id}: license "${lic}" has ${hit.join(", ")}, which rule asset.license forbids`, loc, id });
  };
  for (const a of film.assets) licenceOf("asset", a.id ?? "", a.kv.license, a.loc);
  for (const [id, r] of Object.entries(film.soundRoots)) licenceOf("soundroot", id, r.license);
  // Credits: each asset with credit=yes needs, in a credits scene, a text row with its title, and an author row anchored to that row.
  const creditScenes = film.order.filter((sid) => film.scenes[sid]?.lines.some((l) => l.verb === "credits"));
  for (const a of film.assets.filter((x) => x.kv.credit === "yes" && x.kv.shown !== "no")) {
    const { title, author } = a.kv;
    const found = creditScenes.some((sid) => {
      const rows = film.scenes[sid].lines.filter((l) => l.verb === "text");
      const row = rows.find((l) => l.text === title);
      return !!row && rows.some((l) => l.text === author && (l.at ?? "").replace(/^@/, "").split(/[+-]/)[0] === row.id);
    });
    if (!found) P.push({ level: "error", code: "credits.missing", msg: `asset ${a.id ?? ""}: no credits row pairs title "${title}" with author "${author}"`, loc: a.loc, id: a.id });
  }

  // A quoted string on a verb that takes no text belongs to no key. A wrong `movas do` or a hand edit leaves one behind.
  for (const sid of film.order) for (const l of film.scenes[sid]?.lines ?? []) {
    const keys = WORD_KEYS[l.verb];
    if (keys === undefined || l.text === undefined) continue;
    const id = l.id ? `${sid}.${l.id}` : `${sid}.${l.verb}`;
    const where = keys.length ? `${l.verb} lines keep their words in ${keysPhrase(keys)}` : `${l.verb} lines take no text`;
    P.push({ level: "warn", code: "text.stray", msg: `${id}: ${where}, and the quoted string "${l.text}" on this line belongs to no key`, loc: l.loc, id: l.id ? id : undefined });
  }
  // Truth lint on every string in the score, from human-owned rules.
  const digitAllow = (ruleOf("truth.digits")?.kv.allow ?? "").split(",").filter(Boolean);
  const banned = (ruleOf("truth.banned")?.kv.words ?? "").split(",").filter(Boolean);
  // A rule with words= and scope= bans words on the lines its scope names. scope=verb:msg,in:conv/verb:chat,part:a lists alternatives split by /, and part is the key a line's words came from.
  const scoped = (film.rules ?? []).filter((r) => r.kv.scope && r.kv.words).map((r) => ({ id: r.id!, say: r.kv.say ?? "banned word", words: r.kv.words.split(",").filter(Boolean), alts: r.kv.scope.split("/").map((a) => a.split(",").map((x) => x.split(":"))) }));
  for (const t of texts) {
    const p = plain(t.text);
    const parts = t.id.split("."), part = parts.length > 2 ? parts[parts.length - 1] : "";
    for (const r of scoped) if (r.alts.some((alt: string[][]) => alt.every(([k, v]) => (k === "verb" ? t.verb : k === "part" ? part : t.kv[k]) === v))) for (const w of r.words) if (p.toLowerCase().includes(w.toLowerCase())) P.push({ level: "error", code: r.id, msg: `${t.id}: ${r.say} "${w}": "${p}"`, loc: t.loc, id: t.id });
    if (ruleOf("truth.digits") && /\d/.test(p) && !digitAllow.includes(t.kv.digits ?? "") ) P.push({ level: "error", code: "truth.digits", msg: `${t.id}: digits in "${p}" (allowed only when tagged digits=${digitAllow.join("|")})`, loc: t.loc, id: t.id });
    for (const w of banned) if (p.toLowerCase().includes(w.toLowerCase())) P.push({ level: "error", code: "truth.banned", msg: `${t.id}: banned word "${w}" in "${p}"`, loc: t.loc, id: t.id });
  }

  const scenes: SceneRow[] = film.order.filter((s) => film.scenes[s]).map((s) => ({ id: s, title: film.scenes[s].title, startBeat: beats[`${s}.start`], endBeat: beats[`${s}.end`], startFrame: frameOf(c, beats[`${s}.start`]), endFrame: frameOf(c, beats[`${s}.end`]), program: film.scenes[s].args.program, pre: parseInt(film.scenes[s].args.pre ?? "0"), post: parseInt(film.scenes[s].args.post ?? "0") }));
  const last = scenes[scenes.length - 1];
  const durationFrames = last ? last.endFrame : 0;
  for (const r of sfx) if (r.frame > durationFrames) P.push({ level: "error", code: "sfx.past_end", msg: `${r.key} starts at frame ${r.frame}, after the film ends at ${durationFrames}`, loc: r.loc });
  const keys = new Set<string>();
  for (const r of sfx) { if (keys.has(r.key)) P.push({ level: "error", code: "sfx.dup", msg: `duplicate sound key ${r.key}`, loc: r.loc }); keys.add(r.key); }
  for (const s of snaps) if (s.addedBeats >= 2) P.push({ level: "warn", code: "snap.large", msg: `${s.id}: snapping to ${s.snap} added ${s.addedBeats} beats` });

  for (const k of new Set<string>((film as any).unresolved ?? [])) P.push({ level: "error", code: "var.missing", msg: `\${${k}} is used and no var line or --set gives it a value` });
  const style = Object.fromEntries(film.styles.map((l) => [l.id!, l.kv]));
  for (const m of media) { const b = beats[m.id]; m.frame = b === undefined ? 0 : frameOf(c, b); }
  return { film, clock: c, events, texts, sfx: sfx.sort((a, b) => a.frame - b.frame), floors, problems: P, scenes, durationFrames, snaps, ducks, duckSpans, media, style, defaultFormat: film.defaultFormat, trimBeats, flashes, kvOf: Object.fromEntries(film.order.filter((id) => film.scenes[id]).flatMap((id) => film.scenes[id].lines.filter((l) => l.id).map((l) => [`${id}.${l.id}`, l.kv]))), panels: Object.fromEntries(film.order.filter((id) => film.scenes[id]).map((id) => [id, Object.fromEntries(film.scenes[id].lines.filter((l) => l.verb === "panel" && l.id).map((l) => [l.id, l.kv]))])) };
};

const creditWords = (film: Film, l: Line): number => {
  const wc = (s: string) => s.split(/\s+/).filter(Boolean).length;
  const models = film.assets.filter((a) => a.kv.credit === "yes" && a.kv.shown !== "no");
  const extra = (l.kv.title ? wc(l.kv.title) : 0) + (l.kv.license ? wc(l.kv.license) : 0);
  return extra + models.reduce((n, a) => n + wc(a.kv.title ?? "") + wc(l.kv.by ?? "de") + wc(a.kv.author ?? ""), 0);
};

const classOfFile = (f: string) => (f.startsWith("vo/") ? "vo" : f.includes("impact") ? "impact" : f.includes("interface") ? "ui" : f.includes("synth") ? "synth" : "other");

// ---------- Reports ----------
export const timelineMd = (s: Solved): string => {
  const rows = s.scenes.map((r) => `| ${r.id} | ${r.title} | ${r.startBeat}-${r.endBeat} | ${fmt(r.startFrame / s.clock.fps)}-${fmt(r.endFrame / s.clock.fps)} | ${r.startFrame}-${r.endFrame} |`);
  return ["| Scene | Title | Beats | Time | Frames |", "|---|---|---|---|---|", ...rows].join("\n") + `\n\nTotal: ${s.durationFrames} frames, ${fmt(s.durationFrames / s.clock.fps)}.\n`;
};
const fmt = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, "0")}`;

/** Every file under dir, by relative path and bytes, in a fixed order. A render's version id is built from these. */
export const hashTree = (dir: string): string => {
  const h = createHash("sha256");
  const walk = (d: string, rel: string) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name === ".DS_Store" || e.name === "node_modules") continue;
      const p = join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) h.update(r).update("\0").update(readFileSync(p)).update("\0");
    }
  };
  walk(dir, "");
  return h.digest("hex").slice(0, 16);
};

/** Score keys the compiler reads, found in this file's own source. A key on this list is used, so it is never dead. */
export const compilerKeys = (): Set<string> => {
  const src = readFileSync(new URL(import.meta.url), "utf8");
  const keys = new Set<string>();
  for (const d of Object.values(FORMAT_VERBS)) for (const k of [...d.words, ...d.needs, d.time, d.ref]) if (k) keys.add(k);
  for (const m of src.matchAll(/\bkv\.([A-Za-z_]\w*)/g)) keys.add(m[1]);
  for (const m of src.matchAll(/\bkv\[["']([^"']+)["']\]/g)) keys.add(m[1]);
  for (const m of src.matchAll(/for \(const k of \[([^\]]*)\]\)/g)) for (const s of m[1].matchAll(/"([^"]+)"/g)) keys.add(s[1]);
  return keys;
};

// Impact: what changes between two solved films. Keyed by event id, not by time.
export const impact = (a: Solved, b: Solved) => {
  const moved: { id: string; from: number; to: number; df: number; phaseFrom: number; phaseTo: number }[] = [];
  const added: string[] = [], removed: string[] = [], phaseChanged: string[] = [];
  for (const id of Object.keys(b.events)) {
    const ea = a.events[id], eb = b.events[id];
    if (!ea) { added.push(id); continue; }
    if (ea.frame !== eb.frame) {
      moved.push({ id, from: ea.frame, to: eb.frame, df: eb.frame - ea.frame, phaseFrom: ea.beatInBar, phaseTo: eb.beatInBar });
      if (ea.beatInBar !== eb.beatInBar) phaseChanged.push(id);
    }
  }
  for (const id of Object.keys(a.events)) if (!b.events[id]) removed.push(id);
  const textChanged = b.texts.filter((t) => { const o = a.texts.find((x) => x.id === t.id); return o && o.text !== t.text; }).map((t) => ({ id: t.id, from: a.texts.find((x) => x.id === t.id)!.text, to: t.text }));
  const textAdded = b.texts.filter((t) => !a.texts.find((x) => x.id === t.id)).map((t) => t.id);
  const textRemoved = a.texts.filter((t) => !b.texts.find((x) => x.id === t.id)).map((t) => t.id);
  // Sound rows compare by scene, file and volume: a row's key holds a line index, which renumbers when a line is added.
  const sfxSig = (r: SfxRow) => `${r.scene} ${r.file} ${r.vol}`;
  const extra = (x: SfxRow[], y: SfxRow[]) => { const left = new Map<string, number>(); for (const r of y) left.set(sfxSig(r), (left.get(sfxSig(r)) ?? 0) + 1); return x.filter((r) => { const n = left.get(sfxSig(r)) ?? 0; if (n) left.set(sfxSig(r), n - 1); return !n; }).map(sfxSig); };
  const sfxAdded = extra(b.sfx, a.sfx), sfxRemoved = extra(a.sfx, b.sfx);
  const slack = b.floors.map((f) => { const o = a.floors.find((x) => x.id === f.id); return o && o.slackFrames !== f.slackFrames ? { id: f.id, from: o.slackFrames, to: f.slackFrames } : null; }).filter(Boolean);
  const sceneDur = b.scenes.map((s) => { const o = a.scenes.find((x) => x.id === s.id); const d = s.endFrame - s.startFrame; const od = o ? o.endFrame - o.startFrame : 0; return { id: s.id, durFrom: od, durTo: d, shift: o ? s.startFrame - o.startFrame : 0 }; }).filter((s) => s.durFrom !== s.durTo || s.shift !== 0);
  return { durationFrom: a.durationFrames, durationTo: b.durationFrames, moved, phaseChanged, added, removed, textChanged, textAdded, textRemoved, sfxAdded, sfxRemoved, slack, sceneDur };
};

/** The answer an agent needs before an edit: what it costs, what moves, and which musical phase changes. */
export const impactText = (i: ReturnType<typeof impact>) => {
  const L: string[] = [`film ${i.durationFrom}f -> ${i.durationTo}f (${i.durationTo - i.durationFrom >= 0 ? "+" : ""}${i.durationTo - i.durationFrom}f); ${i.moved.length} events move, ${i.phaseChanged.length} change bar phase`];
  for (const s of i.sceneDur) if (s.durTo !== s.durFrom || s.shift) L.push(`  ${s.id}: length ${s.durFrom}f -> ${s.durTo}f, start shifts ${s.shift >= 0 ? "+" : ""}${s.shift}f`);
  for (const t of i.textChanged) L.push(`  text ${t.id}: "${t.from}" -> "${t.to}"`);
  if (i.textAdded.length) L.push(`  text added: ${i.textAdded.join(", ")}`);
  if (i.textRemoved.length) L.push(`  text removed: ${i.textRemoved.join(", ")}`);
  if (i.sfxAdded.length || i.sfxRemoved.length) L.push(`  sound rows: +${i.sfxAdded.length} -${i.sfxRemoved.length}`);
  if (i.added.length || i.removed.length) L.push(`  events: +${i.added.length} -${i.removed.length}`);
  for (const f of i.slack as any[]) L.push(`  reading slack ${f.id}: ${f.from}f -> ${f.to}f`);
  const onKick = i.moved.filter((m) => m.phaseFrom === 0 && m.phaseTo !== 0).map((m) => m.id);
  if (onKick.length) L.push(`  left the kick: ${onKick.slice(0, 12).join(", ")}${onKick.length > 12 ? ` and ${onKick.length - 12} more` : ""}`);
  return L.join("\n");
};

// ---------- CLI ----------
if ((import.meta as any).main) {
  const args = (globalThis as any).Deno ? (globalThis as any).Deno.args : (globalThis as any).process.argv.slice(2);
  const [cmd, ...rest] = args;
  const dir = resolve(rest.find((a: string) => a.startsWith("--film="))?.slice(7) ?? "film");
  const publicDir = rest.find((a: string) => a.startsWith("--public="))?.slice(9);
  const t0 = performance.now();
  const film = loadFilm(dir);
  const s = solve(film, publicDir);
  const ms = performance.now() - t0;
  const errs = s.problems.filter((p) => p.level === "error");
  const say = (o: unknown) => console.log(typeof o === "string" ? o : JSON.stringify(o, null, 1));
  if (cmd === "check") {
    for (const p of s.problems) say(`${p.level} ${p.code} ${p.loc ? `${p.loc.file}:${p.loc.line} ` : ""}${p.msg}`);
    say(`${errs.length} errors, ${s.problems.length - errs.length} warnings; ${Object.keys(s.events).length} events, ${s.texts.length} texts, ${s.sfx.length} sounds, ${s.durationFrames} frames, ${ms.toFixed(1)} ms`);
    (globalThis as any).process?.exit?.(errs.length ? 1 : 0);
  } else if (cmd === "timeline") say(timelineMd(s));
  else if (cmd === "at") {
    const q = rest[0];
    if (/^\d+:\d/.test(q) || /^\d+$/.test(q)) {
      const f = q.includes(":") ? Math.round((parseInt(q) * 60 + parseFloat(q.split(":")[1])) * s.clock.fps) : parseInt(q);
      const near = Object.values(s.events).sort((a, b) => Math.abs(a.frame - f) - Math.abs(b.frame - f)).slice(0, 5).map((e) => `${e.id} (${e.frame - f >= 0 ? "+" : ""}${e.frame - f}f)`);
      const sc = s.scenes.find((x) => f >= x.startFrame && f < x.endFrame);
      say(`frame ${f} is in ${sc?.id ?? "?"} "${sc?.title ?? ""}"; nearest: ${near.join(", ")}`);
    } else say(s.events[q] ?? `no event ${q}`);
  } else if (cmd === "json") {
    const { film: _f, ...o } = s;
    const out = rest.find((a: string) => a.startsWith("--out="))?.slice(6);
    if (out) writeFileSync(out, JSON.stringify(o)); else say(o);
  } else if (cmd === "impact") {
    const other = resolve(rest.find((a: string) => a.startsWith("--to="))!.slice(5));
    const b = solve(loadFilm(other), publicDir);
    if (rest.includes("--json")) say(impact(s, b)); else console.log(impactText(impact(s, b)));
  } else say("usage: movas check|timeline|at <event|m:ss|frame>|json|impact --to=<dir> [--film=dir] [--public=dir]");
}
