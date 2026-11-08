// movas do: one command turns a director's note into a finished edit. See prototypes/v2/spec-do-pipeline.md.
// Edit, time fit, checks, panel fit, one frame, optional preview, decisions, one output block.
import { type Clock, impact, keysPhrase, loadFilm, parseLine, solve, type Solved, WORD_KEYS } from "./movas.ts";
import { unchanged } from "./options.ts";
import {
  applyAccent, atOfRaw, costSentences, formatAt, hasMarkup, isCommentLine, nextId, parseAt, parseValue, plainText, rankSplits,
  replaceRepeats, sentencePairs, type Shape, shapeOf, STOP_DEFAULT, TEXT_KEYS, textOfRaw, unquote, withAt, withKey, withText, wordsProof,
} from "./do_edit.ts";

export type DoCtx = {
  HERE: string; FILM: string; WORK: string; PUBLIC: string; PORT: string; // HERE: the film's root
  TOOL?: string; // the install, for its programs and tool/verify.py. Without it, HERE holds both.
  render: (args: string[]) => Promise<{ success: boolean; stdout: Uint8Array; stderr: Uint8Array }>;
  planFor: (film: string | null, tag: string, extra?: string[], quiet?: boolean) => Promise<any | null>;
  planError: () => string; // why the last plan pass that returned null did not run
  meaningDelta?: () => Promise<{ lines: string[]; newValidated: number }>; // the film's meaning-rule misses against the last save
  analyse: (s: Solved, c: any) => { defects: Map<string, string>; warns: Map<string, string>; rows: Map<string, any> };
  compile: (dir?: string) => Solved;
  readDirection: () => { date: string; id: string; appliesTo: string[]; decision: string; words?: string }[];
  readKnown: () => any | null;
  git: (...a: string[]) => Promise<{ ok: boolean; out: string; err: string }>;
  ensureHistory: () => Promise<void>;
  pictureNow?: () => Promise<any | null>; // the plan of the tree as it stands, before an edit
};

// Same loops as options.ts (Family T, Family L). Kept as copies so options.ts changes only by export keywords.
const L_DY = [0, -10, -25, -45];

const KEY_RE = /^([A-Za-z][A-Za-z0-9]*)=(.*)$/;
const isKey = (a: string) => KEY_RE.test(a);

/** Splits argv into flags, the ref and the rest. Flags start with --. A word=value argument is a key. */
export const parseArgs = (args: string[]) => {
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const pos = args.filter((a) => !a.startsWith("--"));
  return { flags, pos };
};

/** Resolves a ref to one line of the solved film, or the list of rows to print. */
export const resolveRef = (s: Solved, ref: string): { line?: any; scene?: string; rows?: string[]; n: number } => {
  const scenes = s.film.scenes;
  // 1. scene.id, or scene.<line id>
  const dot = ref.indexOf(".");
  if (dot > 0) {
    const sc = ref.slice(0, dot), lid = ref.slice(dot + 1);
    const lines = scenes[sc]?.lines ?? [];
    const line = lid === "end" ? lines.find((l: any) => l.verb === "end") : lines.find((l: any) => l.id === lid);
    if (line) return { line, scene: sc, n: 1 };
  }
  // 2. A bare id unique across scenes
  const byId = Object.values(scenes).flatMap((sc: any) => sc.lines.filter((l: any) => l.id === ref).map((l: any) => ({ l, sc: sc.id })));
  if (byId.length === 1) return { line: byId[0].l, scene: byId[0].sc, n: 1 };
  // 3. Words: exact plain text first, then contained. Must be unique.
  const norm = (x: string) => x.replace(/\s+/g, " ").trim();
  const all = Object.values(scenes).flatMap((sc: any) => sc.lines.filter((l: any) => l.text !== undefined).map((l: any) => ({ l, sc: sc.id, p: norm(plainText(l.text)) })));
  const want = norm(ref);
  let hits = all.filter((x) => x.p === want);
  if (hits.length === 0) hits = all.filter((x) => x.p.includes(want));
  if (hits.length === 1) return { line: hits[0].l, scene: hits[0].sc, n: 1 };
  return { rows: hits.slice(0, 6).map((x) => `  ${x.sc}.${x.l.id}: "${x.l.text}"`), n: hits.length };
};

/** Remembers the first content of each file a do writes, so a failure can put every file back. */
export class Tx {
  readonly old = new Map<string, string>();
  private readonly ctx: DoCtx;
  constructor(ctx: DoCtx) {
    this.ctx = ctx;
  }
  async write(path: string, content: string): Promise<void> {
    if (!this.old.has(path)) this.old.set(path, await Deno.readTextFile(path));
    await Deno.writeTextFile(path, content);
  }
  async rollback(): Promise<void> {
    for (const [p, c] of this.old) await Deno.writeTextFile(p, c).catch(() => {});
    this.old.clear();
  }
  /** Writes the undo map the way the spec names it: { path: oldContent }. */
  async saveUndo(): Promise<void> {
    const map = Object.fromEntries(this.old);
    await Deno.writeTextFile(`${this.ctx.HERE}/.movas/do-undo.json`, JSON.stringify(map, null, 1));
  }
}

/** A file of the score: under film/ and not under film/programs/. */
const isScoreFile = (ctx: DoCtx, p: string) => p.startsWith(`${ctx.FILM}/`) && !p.startsWith(`${ctx.FILM}/programs/`);

/** A temp copy of film/, one per operation. Each compile rewrites only the file it changes. */
export const tempFilm = async (ctx: DoCtx): Promise<{ dir: string; clean: () => Promise<void> }> => {
  await Deno.mkdir(ctx.WORK, { recursive: true });
  const dir = await Deno.makeTempDir({ dir: ctx.WORK, prefix: "do-" });
  const work = `${dir}/film`;
  await Deno.mkdir(work);
  for (const e of Deno.readDirSync(ctx.FILM)) if (e.isFile) await Deno.copyFile(`${ctx.FILM}/${e.name}`, `${work}/${e.name}`);
  return { dir: work, clean: () => Deno.remove(dir, { recursive: true }).catch(() => {}) };
};

/** Restores every file in an undo map, then removes the map and the baseline file. */
export const undoLast = async (ctx: DoCtx): Promise<number> => {
  const path = `${ctx.HERE}/.movas/do-undo.json`;
  let map: Record<string, string>;
  try { map = JSON.parse(await Deno.readTextFile(path)); } catch {
    console.log("NOT DONE: nothing to undo. No do has written here since the last undo.");
    return 1;
  }
  const files = Object.keys(map);
  for (const f of files) await Deno.writeTextFile(f, map[f]);
  await Deno.remove(path).catch(() => {});
  await Deno.remove(`${ctx.HERE}/.movas/do-last.json`).catch(() => {});
  console.log(`undone: ${files.map((f) => f.replace(`${ctx.HERE}/`, "")).join(", ") || "(no files)"}`);
  return 0;
};

type Analysis = { defects: Map<string, string>; warns: Map<string, string>; rows: Map<string, any> };
type Cost = { errors: number; frames: number; moved: number; phase: number; kick: string[] };
type Scratch = { dir: string; clean: () => Promise<void> };
/** One `do` in progress: the lines of every file it changes, and what it reports. Nothing is written until commit. */
type Run = {
  ctx: DoCtx;
  before: Solved;
  files: Map<string, string[]>; // absolute path -> lines after this do's edits
  scratch: Scratch | null; // one temp copy of film/ for candidate compiles
  ownGroups?: boolean; // the command wrote the word groups by hand
  tx: Tx; // remembers the first content of every file written
  scene: string;
  lid: string; // the edited line's id (the new id for insert)
  verb: string; // the edited line's verb
  path: string; // absolute path of the scene file
  idx: number; // index of the edited line in files.get(path)
  notes: string[];
  also: string[]; // repeat edits, file:line relative to HERE
  timeChange?: { from: string; to: string };
  alt?: { cmd: string; cost: Cost };
  split?: { text: string; margin: number | null; rejected?: { text: string; margin: number | null } };
  panel?: string;
  holdKind?: "A" | "B" | "C"; // which hold candidate won
  hold?: { cand: Cand; want: number; proof: string }; // the winner of a hold, the frames it had to add, and what the film showed
  followerId?: string; // the follower of a hold (B) or of an insert
  altAt?: string; // an insert's other time, the full gap
  words: Words[]; // each change of words, for the proof on screen
};
/** One change of words: the old and new plain text, the repeat pairs that were applied, and whether the old words may stay elsewhere. */
type Words = { key: string; oldPlain: string; newPlain: string; pairs: { from: string; to: string }[]; here: boolean };

const costOf = (before: Solved, s: Solved): Cost => {
  const i = impact(before, s);
  return {
    errors: s.problems.filter((p) => p.level === "error").length,
    frames: s.durationFrames - before.durationFrames,
    moved: i.moved.length,
    phase: i.phaseChanged.length,
    kick: i.moved.filter((m) => m.phaseFrom === 0 && m.phaseTo !== 0).map((m) => m.id),
  };
};
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n}`;
const fmt = (x: number) => String(Number(x.toFixed(4)));
const rel = (ctx: DoCtx, p: string) => p.replace(`${ctx.HERE}/`, "").replace(`${ctx.TOOL ?? ctx.HERE}/`, "");
/** The compiler's unit conversions, as options.ts has them. */
const toBeats = (c: Clock, v: number, unit?: string) =>
  unit === "bar" ? v * c.beatsPerBar : unit === "s" ? (v * c.fps) / c.fpb : unit === "f" ? v / c.fpb : v;
const fromBeats = (c: Clock, b: number, unit: string) =>
  unit === "bar" ? b / c.beatsPerBar : unit === "s" ? (b * c.fpb) / c.fps : unit === "f" ? b * c.fpb : b;

/** The lines of a file as this do sees them: the edited copy when one exists, else the file on disk. */
const linesOf = async (run: Run, path: string): Promise<string[]> => {
  let l = run.files.get(path);
  if (!l) {
    l = (await Deno.readTextFile(path)).split("\n");
    run.files.set(path, l);
  }
  return l;
};

type Over = { path: string; idx: number; raw: string };
/** Writes every edited film file into a temp copy, with the given lines replaced. */
const stageFilm = async (run: Run, dir: string, overs: Over[] = []) => {
  for (const [path, lines] of run.files) {
    if (!isScoreFile(run.ctx, path)) continue;
    const ls = lines.map((l, i) => overs.find((o) => o.path === path && o.idx === i)?.raw ?? l);
    await Deno.writeTextFile(`${dir}/${path.slice(run.ctx.FILM.length + 1)}`, ls.join("\n"));
  }
};

/** Compiles the edits of this do, in the run's temp copy, with some lines replaced. Nothing in film/ changes. */
const compileStage = async (run: Run, overs: Over[] = []): Promise<Solved> => {
  if (!run.scratch) run.scratch = await tempFilm(run.ctx);
  await stageFilm(run, run.scratch.dir, overs);
  return solve(loadFilm(run.scratch.dir), run.ctx.PUBLIC);
};

const T_LIST = (c: Clock) => (c.isBeat ? [-2, -1.5, -1, -0.75, -0.5, -0.25, 0.25, 0.5, 1, 2] : [-1, -0.5, -0.25, 0.25, 0.5, 1]);

/** Family T from options.ts: the line's own time moved by each delta in the unit it is written in. */
const familyT = (c: Clock, raw: string): { at: string; raw: string }[] => {
  const cur = atOfRaw(raw);
  const m = cur ? /^@([^+~]+?)(?:([+-][\d.]+)(b|bar|s|f)?)?(~.+)?$/.exec(cur) : null;
  if (!cur || !m || m[1].startsWith("max(")) return [];
  const unit = m[2] === undefined ? "b" : (m[3] ?? "");
  const off = toBeats(c, m[2] === undefined ? 0 : parseFloat(m[2]), m[3]);
  const out: { at: string; raw: string }[] = [];
  for (const d of T_LIST(c)) {
    const nb = off + (c.isBeat ? d : (d * c.fps) / c.fpb);
    if (nb < -1e-9) continue;
    const at = `@${m[1]}+${fmt(fromBeats(c, nb, unit))}${unit}${m[4] ?? ""}`;
    out.push({ at, raw: withAt(raw, at) });
  }
  return out;
};

/** Step 2, time fit: the line's time by Family T, the cheapest row wins. Returns the raw line to keep. */
const timeFit = async (run: Run, raw: string): Promise<string> => {
  const now = await compileStage(run);
  const c0 = costOf(run.before, now);
  if (c0.frames === 0 && c0.phase === 0) return raw;
  type Row = { at: string | null; raw: string; cost: Cost; order: number };
  const rows: Row[] = [{ at: null, raw, cost: c0, order: -1 }];
  let order = 0;
  for (const v of familyT(now.clock, raw)) {
    const s = await compileStage(run, [{ path: run.path, idx: run.idx, raw: v.raw }]);
    if (s.problems.some((p) => p.level === "error")) continue;
    rows.push({ at: v.at, raw: v.raw, cost: costOf(run.before, s), order: order++ });
  }
  rows.sort((a, b) => a.cost.phase - b.cost.phase || Math.abs(a.cost.frames) - Math.abs(b.cost.frames) || a.cost.moved - b.cost.moved || a.order - b.order);
  const win = rows[0];
  const noChange = rows.find((r) => r.at === null)!;
  // The alternative is the no-change row when it lost, else the second row.
  const other = win.at === null ? rows[1] : noChange;
  if (other) run.alt = { cmd: `./movas do ${run.scene}.${run.lid} at=${other.at ?? atOfRaw(raw)}`, cost: other.cost };
  return win.raw;
};
/** Stop words: the rule `rule split.avoid words=...` in film/rules.movas when present, else the default list. */
const stopWords = async (ctx: DoCtx): Promise<Set<string>> => {
  try {
    const line = (await Deno.readTextFile(`${ctx.FILM}/rules.movas`)).split("\n").find((l) => /^rule\s+split\.avoid\b/.test(l));
    const m = line ? /\bwords=(\S+)/.exec(line) : null;
    if (m) return new Set(m[1].split(",").filter(Boolean).map((w) => w.toLowerCase()));
  } catch { /* no rules file: the default list */ }
  return STOP_DEFAULT;
};

/** The smallest margin, in px, of a text id or of one of its sub-texts. Null when no text has one. */
const marginOf = (an: Analysis, id: string): number | null => {
  let best: number | null = null;
  for (const [k, r] of an.rows) {
    if (k !== id && !k.startsWith(`${id}.`)) continue;
    const m = (r as any).margin;
    if (typeof m === "number" && m < 1e8 && (best === null || m < best)) best = m;
  }
  return best;
};

/** The margin.edge and clip warnings of a text id and its sub-texts. */
const edgeWarns = (an: Analysis, id: string): string[] => {
  const hit = (k: string) => [`margin.edge ${id}`, `clip ${id}`].some((p) => k === p || k.startsWith(`${p}.`));
  return [...an.warns].filter(([k]) => hit(k)).map(([, msg]) => msg);
};

/**
 * One plan pass, and one more when it fails: a pass can fail on a good edit under load, and the second often passes. The first
 * try waits 60 s, so a page that never answers costs a minute and not three. Returns the plan, or why the pass did not run.
 * A pass that needed its second try says so in `notes`.
 */
const planPass = async (ctx: DoCtx, film: string | null, tag: string, notes: string[]): Promise<{ plan: any } | { fail: string }> => {
  const first = await ctx.planFor(film, tag, ["--timeout=60"], true);
  if (first) return { plan: first };
  const why = ctx.planError();
  await new Promise((r) => setTimeout(r, 1500));
  const again = await ctx.planFor(film, tag, [], true);
  if (again) {
    const note = `the plan pass failed once (${why}) and passed when it ran again`;
    if (!notes.includes(note)) notes.push(note);
    return { plan: again };
  }
  const why2 = ctx.planError();
  return { fail: `${why2 || why}${why2 && why2 !== why ? ` (first try: ${why})` : ""}` };
};

/** The plan and analysis of a copy of film/ with the edits given plus one line replaced. Null when the plan does not run. */
const analyseWith = async (run: Run, over: { path: string; idx: number; raw: string }, tag: string): Promise<{ an: Analysis; plan: any } | null> => {
  await linesOf(run, over.path);
  const copy = await tempFilm(run.ctx);
  try {
    await stageFilm(run, copy.dir, [over]);
    const got = await planPass(run.ctx, copy.dir, tag, run.notes);
    if ("fail" in got) return null;
    return { an: run.ctx.analyse(solve(loadFilm(copy.dir), run.ctx.PUBLIC), got.plan), plan: got.plan };
  } finally {
    await copy.clean();
  }
};

type Picked = { text: string; margin: number | null; rejected?: { text: string; margin: number | null }; note?: string };

/** The split step of a punch or dock: the best word split whose text has no margin or clip warning, in rank order. */
const splitStep = async (run: Run, oldRaw: string, shape: Shape, newText: string): Promise<Picked | null> => {
  const words = newText.split(" ").filter((w) => w !== "");
  const rows = rankSplits(words, shape.groups.length, await stopWords(run.ctx));
  if (rows.length === 0) return null;
  const oldWidest = Math.max(...shape.groups.map((g) => [...g].length));
  const eligible = rows.filter((r) => r.widest <= 1.25 * oldWidest);
  const pool = (eligible.length ? eligible : rows).slice(0, 6);
  const id = `${run.scene}.${run.lid}`;
  const tried: { text: string; margin: number | null; bad: string[] }[] = [];
  let chosen = -1;
  for (const r of pool) {
    const text = applyAccent(r.groups, shape.sep ?? " / ", shape.accent);
    const got = await analyseWith(run, { path: run.path, idx: run.idx, raw: withText(oldRaw, text) }, "do-split");
    if (!got) {
      tried.push({ text, margin: null, bad: ["the plan pass did not run"] });
      continue;
    }
    const bad = edgeWarns(got.an, id);
    tried.push({ text, margin: marginOf(got.an, id), bad });
    if (bad.length === 0) {
      chosen = tried.length - 1;
      break;
    }
  }
  let note: string | undefined;
  if (chosen < 0) {
    chosen = 0;
    tried.forEach((t, i) => {
      if ((t.margin ?? -Infinity) > (tried[chosen].margin ?? -Infinity)) chosen = i;
    });
    note = `margin warning stays: ${tried[chosen].bad[0]}`;
  }
  const loser = tried.find((_, i) => i !== chosen);
  return {
    text: tried[chosen].text,
    margin: tried[chosen].margin,
    rejected: loser ? { text: loser.text, margin: loser.margin } : undefined,
    note,
  };
};

const walkJs = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory) out.push(...(await walkJs(p)));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out.sort();
};

/** Every program file: the film's own, then the tool's. A tree may lack one of the roots. */
const programsJs = async (here: string, tool = here): Promise<string[]> => {
  const out: string[] = [];
  for (const root of [`${here}/film/programs`, `${tool}/programs`]) out.push(...(await walkJs(root).catch(() => [] as string[])));
  return out;
};
/** The film's own program files: the only programs a do writes. The install's programs are shared by every film. */
const filmProgramsJs = (here: string): Promise<string[]> => walkJs(`${here}/film/programs`).catch(() => [] as string[]);

/** The span's new words after a word change: the words that now stand where the span stood. Null when nothing of it is left. */
export const moveSpan = (span: string, oldText: string, newText: string): string | null => {
  if (newText.includes(span)) return span;
  const words = (t: string) => t.split(/\s+/).filter((w) => w !== "");
  const norm = (w: string) => w.toLowerCase().replace(/^[.,!?;:"'()…]+/, "").replace(/[.,!?;:"'()…]+$/, "");
  const oldW = words(oldText), newW = words(newText), spanW = words(span);
  const k = spanW.length;
  if (k === 0) return null;
  const on = oldW.map(norm), nn = newW.map(norm), sn = spanW.map(norm);
  let i = -1;
  for (let s = 0; s + k <= on.length && i < 0; s++) if (sn.every((w, t) => on[s + t] === w)) i = s;
  if (i < 0) return null;
  // LCS table, then one walk that pairs the matched old and new words.
  const n = on.length, m = nn.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let a = n - 1; a >= 0; a--) {
    for (let b = m - 1; b >= 0; b--) dp[a][b] = on[a] === nn[b] ? dp[a + 1][b + 1] + 1 : Math.max(dp[a + 1][b], dp[a][b + 1]);
  }
  const match = new Map<number, number>();
  for (let a = 0, b = 0; a < n && b < m;) {
    if (on[a] === nn[b]) { match.set(a, b); a++; b++; }
    else if (dp[a + 1][b] >= dp[a][b + 1]) a++;
    else b++;
  }
  const j = i + k - 1;
  let start: number;
  if (match.has(i)) start = match.get(i)!;
  else {
    let before = -1;
    for (let x = i - 1; x >= 0 && before < 0; x--) if (match.has(x)) before = match.get(x)!;
    start = before + 1;
  }
  let end: number;
  if (match.has(j)) end = match.get(j)!;
  else {
    let after = -1;
    for (let x = j + 1; x < n && after < 0; x++) if (match.has(x)) after = match.get(x)!;
    end = after < 0 ? m - 1 : after - 1;
  }
  if (start > end) return null;
  const result = newW.slice(start, end + 1).join(" ").replace(/^["'(]+/, "").replace(/[.,!?;:"')…]+$/, "");
  return result !== "" && newText.includes(result) ? result : null;
};

/** The repeat rules: mark spans on the edited id, then 3-word pairs in the other lines and files. Returns the 3-word pairs. */
const repeats = async (run: Run, oldPlain: string, newPlain: string): Promise<{ from: string; to: string }[]> => {
  const { ctx } = run;
  const note = (path: string, i: number) => run.also.push(`${rel(ctx, path)}:${i + 1}`);
  const p1 = sentencePairs(oldPlain, newPlain, 1);
  const scene = await linesOf(run, run.path);
  // 0. Mark spans on the edited id: keep when still on screen, else the one-word pairs, else the words that now stand there.
  // Runs before the early return below, so a mark follows its line even when no 3-word pair exists.
  scene.forEach((raw, i) => {
    if (i === run.idx) return;
    const parsed = parseLine(raw, { file: run.path, line: i + 1 });
    if (parsed?.verb !== "mark" || parsed.kv.on !== run.lid) return;
    const m = /span="((?:[^"\\]|\\.)*)"/.exec(raw);
    if (!m) return;
    const body = m[1];
    let want: string | null = body;
    if (!newPlain.includes(body)) {
      const viaPairs = replaceRepeats(body, p1);
      want = newPlain.includes(viaPairs) ? viaPairs : moveSpan(body, oldPlain, newPlain);
    }
    if (want === null || want === body) return;
    scene[i] = raw.replace(/span="((?:[^"\\]|\\.)*)"/, () => `span="${want}"`);
    note(run.path, i);
  });
  const p3 = sentencePairs(oldPlain, newPlain, 3);
  if (p3.length === 0) return p3;
  // 1. The scene file: every other line with the 3-word pairs.
  scene.forEach((raw, i) => {
    if (i === run.idx) return;
    const parsed = parseLine(raw, { file: run.path, line: i + 1 });
    if (parsed?.verb === "mark" && parsed.kv.on === run.lid) return;
    if (isCommentLine(raw)) return;
    const next = replaceRepeats(raw, p3);
    if (next !== raw) { scene[i] = next; note(run.path, i); }
  });
  // 2. Every other film file, then the film's program files. Comment lines are skipped.
  const others: string[] = [];
  for await (const e of Deno.readDir(ctx.FILM)) {
    if (e.isFile && e.name.endsWith(".movas") && `${ctx.FILM}/${e.name}` !== run.path) others.push(`${ctx.FILM}/${e.name}`);
  }
  for (const path of [...others.sort(), ...(await filmProgramsJs(ctx.HERE))]) {
    const lines = await linesOf(run, path);
    lines.forEach((raw, i) => {
      if (isCommentLine(raw)) return;
      const next = replaceRepeats(raw, p3);
      if (next !== raw) { lines[i] = next; note(path, i); }
    });
  }
  return p3;
};

/** A key's short old words, under 3: the film's programs' whole quoted strings that hold exactly them draw the same words, so they change too. A new text holding the quote stays out, and the proof on screen then refuses. */
const programLiterals = async (run: Run, oldPlain: string, newPlain: string): Promise<void> => {
  if (oldPlain.trim().split(/\s+/).length >= 3) return;
  for (const path of await filmProgramsJs(run.ctx.HERE)) {
    const lines = await linesOf(run, path);
    lines.forEach((raw, i) => {
      if (isCommentLine(raw)) return;
      const next = ['"', "'", "`"].filter((q) => !newPlain.includes(q)).reduce((l, q) => l.split(`${q}${oldPlain}${q}`).join(`${q}${newPlain}${q}`), raw);
      if (next !== raw) { lines[i] = next; run.also.push(`${rel(run.ctx, path)}:${i + 1}`); }
    });
  }
};

/** Text form: the new on-screen text of the edited line, split and accented, then its repeats. Returns the final text. */
const textEdit = async (run: Run, newText: string, verb: string, noRepeats: boolean): Promise<string> => {
  const ln = await linesOf(run, run.path);
  const oldRaw = ln[run.idx];
  const oldText = textOfRaw(oldRaw)?.text ?? "";
  const shape = shapeOf(oldText);
  let finalText = newText;
  const splittable = (verb === "punch" || verb === "dock") && shape.sep !== null && shape.groups.length >= 2;
  if (hasMarkup(newText)) {
    finalText = newText;
    run.ownGroups = splittable;
    // Word groups given with no accent keep the old accent. A different group count stays as written and is said out loud.
    const given = shapeOf(newText);
    if (!newText.includes("*") && given.sep !== null) {
      const same = given.groups.length === shape.groups.length;
      if (shape.accent === "whole") finalText = applyAccent(given.groups, given.sep, "whole");
      else if (Array.isArray(shape.accent) && same) finalText = applyAccent(given.groups, given.sep, shape.accent);
    }
    if (shape.sep !== null && given.groups.length !== shape.groups.length) run.notes.push(`${given.groups.length} word groups, was ${shape.groups.length}`);
  }
  else if (splittable) {
    const picked = await splitStep(run, oldRaw, shape, newText);
    if (picked) {
      finalText = picked.text;
      run.split = picked;
      if (picked.note) run.notes.push(picked.note);
    } else if (shape.accent === "whole") finalText = `*${newText}*`;
  } else if (shape.accent === "whole") finalText = `*${newText}*`;
  if (shape.partial) run.notes.push("accent not kept: it covered part of the old text");
  ln[run.idx] = withText(oldRaw, finalText);
  const oldPlain = plainText(oldText), newPlain = plainText(finalText);
  const pairs = noRepeats ? sentencePairs(oldPlain, newPlain, 3) : await repeats(run, oldPlain, newPlain);
  if (oldPlain !== newPlain) run.words.push({ key: "", oldPlain, newPlain, pairs, here: noRepeats });
  return finalText;
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes keys from the head of a line, never from its on-screen text. Quoted key values (flip="...") go too. */
const dropKeys = (raw: string, keys: string[]): string => {
  const hit = textOfRaw(raw);
  const cut = hit ? hit.start - 1 : raw.length;
  let head = raw.slice(0, cut);
  for (const k of keys) {
    head = head.replace(new RegExp(`\\s${k}="(?:[^"\\\\]|\\\\.)*"`, "g"), "").replace(new RegExp(`\\s${k}=\\S*`, "g"), "");
  }
  return head + raw.slice(cut);
};

/**
 * Keys form: each k=v. `at` replaces the time token, any other key replaces the whole value of the key. A key that holds
 * words on screen (q=, a=) is a change of words: its repeats are replaced as for text, and the proof on screen follows.
 * No time fit runs for these.
 */
const keysEdit = async (run: Run, pairs: [string, string][], noRepeats: boolean): Promise<void> => {
  const ln = await linesOf(run, run.path);
  let raw = ln[run.idx];
  const from = atOfRaw(raw);
  const valueOf = (r: string, k: string) => plainText(parseLine(r, { file: run.path, line: run.idx + 1 })?.kv[k] ?? "");
  const changed: { key: string; oldPlain: string; newPlain: string }[] = [];
  for (const [k, v] of pairs) {
    if (k === "at") { raw = withAt(raw, v); continue; }
    const next = withKey(raw, k, v);
    if (TEXT_KEYS.includes(k) && valueOf(raw, k) !== valueOf(next, k)) changed.push({ key: k, oldPlain: valueOf(raw, k), newPlain: valueOf(next, k) });
    raw = next;
  }
  ln[run.idx] = raw;
  const to = atOfRaw(raw);
  if (from !== to) run.timeChange = { from: from ?? "", to: to ?? "" };
  for (const w of changed) {
    if (!noRepeats) await programLiterals(run, w.oldPlain, w.newPlain);
    run.words.push({ ...w, pairs: noRepeats ? sentencePairs(w.oldPlain, w.newPlain, 3) : await repeats(run, w.oldPlain, w.newPlain), here: noRepeats });
  }
};

type Cand = { kind: "A" | "B" | "C"; overs: Over[]; cmd: string; cost?: Cost; order: number; timeChange?: { from: string; to: string }; followerId?: string; followerChange?: { from: string; to: string }; ender?: string; slack?: number };

/**
 * What a hold candidate gained in frames: the line's start moved earlier (A), or the thing that ends the hold moved later (B,
 * the follower or the scene end; C, the out). `need` is what the note asked for, less the slack an implicit out already had.
 */
const holdGot = (run: Run, cand: Cand, s: Solved, want: number): { id: string; got: number; need: number; ok: boolean } | null => {
  const id = cand.kind === "A" ? `${run.scene}.${run.lid}` : cand.ender!;
  const a = run.before.events[id]?.frame, b = s.events[id]?.frame;
  if (a === undefined || b === undefined) return null;
  const got = cand.kind === "A" ? a - b : b - a;
  const need = want - (cand.slack ?? 0);
  return { id, got, need, ok: need >= 0 ? got >= need - 1 : got <= need + 1 };
};

/** What a candidate's measure says, as a clause: `s11.end moved 15f later`, `s06.d starts 30f earlier`. */
const holdSays = (cand: Cand, g: { id: string; got: number }): string =>
  cand.kind === "A" ? `${g.id} starts ${Math.abs(g.got)}f ${g.got >= 0 ? "earlier" : "later"}` : `${g.id} moved ${Math.abs(g.got)}f ${g.got >= 0 ? "later" : "earlier"}`;

/** True when the scene's end moves with this line: the line's time pushed one bar later moves the end. Nothing in the film changes. */
const endFollows = async (run: Run, lineRaw: string, pa: NonNullable<ReturnType<typeof parseAt>> | null): Promise<boolean> => {
  if (!pa) return false;
  const c = run.before.clock, end = `${run.scene}.end`;
  const s = await compileStage(run, [{ path: run.path, idx: run.idx, raw: withAt(lineRaw, formatAt({ ...pa, offset: pa.offset + fromBeats(c, c.beatsPerBar, pa.unit) })) }]);
  return errorsOf(s).length === 0 && s.events[end]?.frame !== run.before.events[end]?.frame;
};

/**
 * Hold form: the candidates A (earlier start), B (later follower, or the scene end when it moves with the line) and C (longer
 * out). A follower whose offset is in frames is part of the line's entrance and moves with it, so it never ends the hold.
 * A candidate counts only when the film shows the hold: the start or the ender moved by the amount asked. The cheapest wins.
 */
const holdEdit = async (run: Run, value: { value: number; unit: string }): Promise<{ reason: string } | null> => {
  const c = run.before.clock;
  const ln = await linesOf(run, run.path);
  const lineRaw = ln[run.idx];
  const me = parseLine(lineRaw, { file: run.path, line: run.idx + 1 });
  const cands: Cand[] = [];
  const at = atOfRaw(lineRaw);
  const pa = at ? parseAt(at) : null;
  const want = toBeats(c, value.value, value.unit) * c.fpb;
  // A: the line starts earlier by N, in its own unit. Kept only when the offset stays at or above 0.
  if (pa) {
    const offset = pa.offset - fromBeats(c, toBeats(c, value.value, value.unit), pa.unit);
    if (offset >= -1e-9) {
      const newAt = formatAt({ cause: pa.cause, offset, unit: pa.unit, snap: pa.snap });
      cands.push({ kind: "A", overs: [{ path: run.path, idx: run.idx, raw: withAt(lineRaw, newAt) }], cmd: `./movas do ${run.scene}.${run.lid} at=${newAt}`, order: 0, timeChange: { from: at!, to: newAt } });
    }
  }
  // B: the first later line (file order) whose time hangs on this line, in beats or seconds. It moves by N.
  const hangsOn = (cause: string) => cause === run.lid || ["docked", "floor", "out", "undock"].some((s) => cause === `${run.lid}.${s}`) || new RegExp(`^${escapeRe(run.lid)}\\.g\\d+$`).test(cause);
  type Follower = { i: number; pf: NonNullable<ReturnType<typeof parseAt>>; fid: string };
  let fo: Follower | null = null;
  for (let i = 0; i < ln.length && !fo; i++) {
    if (i === run.idx) continue;
    const p = parseLine(ln[i], { file: run.path, line: i + 1 });
    if (!p || p.verb === "mark" || p.verb === "sfx" || p.kv.with !== undefined) continue;
    const at2 = atOfRaw(ln[i]);
    const pf = at2 ? parseAt(at2) : null;
    if (!pf || !hangsOn(pf.cause) || pf.unit === "f") continue;
    // A line that starts with this one, on its cause at no offset, is part of the same row. It ends nothing.
    if (pf.cause === run.lid && pf.offset <= 0) continue;
    fo = { i, pf, fid: p.id ?? (p.verb === "end" ? "end" : "") };
  }
  // No such line: the scene's end ends the hold when it moves with this line. An end that does not follow it holds nothing.
  if (!fo && run.verb !== "end") {
    const e = ln.findIndex((l, i) => i !== run.idx && parseLine(l, { file: run.path, line: i + 1 })?.verb === "end");
    const ea = e >= 0 ? atOfRaw(ln[e]) : null;
    const pe = ea ? parseAt(ea) : null;
    if (pe && (await endFollows(run, lineRaw, pa))) fo = { i: e, pf: pe, fid: "end" };
  }
  if (fo) {
    const { i, pf, fid } = fo;
    const at2 = atOfRaw(ln[i])!;
    const newAt = formatAt({ ...pf, offset: pf.offset + fromBeats(c, toBeats(c, value.value, value.unit), pf.unit) });
    // With a follower, a start that moves earlier only lengthens the hold when the follower's offset grows by the same amount, which leaves the follower and all later events in place.
    const early = cands.find((x) => x.kind === "A");
    if (early) {
      cands.splice(cands.indexOf(early), 1);
      cands.push({ ...early, overs: [...early.overs, { path: run.path, idx: i, raw: withAt(ln[i], newAt) }], cmd: `./movas do ${run.scene}.${run.lid} at=${early.timeChange!.to}; ./movas do ${run.scene}.${fid} at=${newAt}`, followerId: fid, followerChange: { from: at2, to: newAt } });
    }
    cands.push({ kind: "B", overs: [{ path: run.path, idx: i, raw: withAt(ln[i], newAt) }], cmd: `./movas do ${run.scene}.${fid} at=${newAt}`, order: 1, followerId: fid, ender: `${run.scene}.${fid}` });
  }
  // C: a punch with no with= key holds its out longer, on its own floor.
  if (run.verb === "punch" && me && me.kv.with === undefined) {
    const outNow = me.kv.out;
    const m = outNow ? new RegExp(`^@${escapeRe(run.lid)}\\.floor\\+([+-]?[\\d.]+)(b|bar|s|f)?$`).exec(outNow) : null;
    let outValue: string;
    if (m) {
      const u = m[2] ?? "b";
      outValue = `@${run.lid}.floor+${fmt(parseFloat(m[1]) + fromBeats(c, toBeats(c, value.value, value.unit), u))}${u}`;
    } else outValue = `@${run.lid}.floor+${fmt(value.value)}${value.unit}`;
    // The new out sits N after the floor, so an out that sat past its floor already moves by less than N.
    const out0 = run.before.events[`${run.scene}.${run.lid}.out`]?.frame, floor0 = run.before.events[`${run.scene}.${run.lid}.floor`]?.frame;
    const slack = m || out0 === undefined || floor0 === undefined ? 0 : out0 - floor0;
    cands.push({ kind: "C", overs: [{ path: run.path, idx: run.idx, raw: withKey(lineRaw, "out", outValue) }], cmd: `./movas do ${run.scene}.${run.lid} out=${outValue}`, order: 2, ender: `${run.scene}.${run.lid}.out`, slack });
  }
  const evaluated: Cand[] = [];
  const misses: string[] = [];
  const proofs = new Map<Cand, string>();
  for (const cand of cands) {
    const s = await compileStage(run, cand.overs);
    if (s.problems.some((p) => p.level === "error") || unchanged(run.before, s)) continue;
    const g = holdGot(run, cand, s, want);
    if (!g || !g.ok) {
      misses.push(g ? `${holdSays(cand, g)}, and the hold needs ${g.need}f` : `${cand.kind === "A" ? `${run.scene}.${run.lid}` : cand.ender} has no time to measure`);
      continue;
    }
    proofs.set(cand, holdSays(cand, g));
    cand.cost = costOf(run.before, s);
    evaluated.push(cand);
  }
  if (evaluated.length === 0) {
    if (misses.length) return { reason: `every candidate fails the measure: ${misses[0]}` };
    return { reason: cands.length ? "every candidate changes nothing or fails to compile" : "the line has no time to lengthen, no later line ends its hold, the scene's end does not move with it, and it is not a punch" };
  }
  evaluated.sort((a, b) => a.cost!.phase - b.cost!.phase || Math.abs(a.cost!.frames) - Math.abs(b.cost!.frames) || a.cost!.moved - b.cost!.moved || a.order - b.order);
  const win = evaluated[0];
  for (const o of win.overs) (await linesOf(run, o.path))[o.idx] = o.raw;
  run.timeChange = win.timeChange;
  run.holdKind = win.kind;
  run.followerId = win.followerId;
  run.hold = { cand: win, want, proof: proofs.get(win)! };
  if (win.followerChange) run.notes.push(`${win.followerId} ${win.followerChange.from} -> ${win.followerChange.to}, so it and all later events stay where they were`);
  if (evaluated[1]) run.alt = { cmd: evaluated[1].cmd, cost: evaluated[1].cost! };
  return null;
};

/** Insert form: a copy of the line after `after`, with the new id, its own time and the follower moved onto it. */
const insertEdit = async (run: Run, text: string, digits = ""): Promise<void> => {
  const ln = await linesOf(run, run.path);
  const afterIdx = run.idx, afterId = run.lid;
  const ids = new Set(run.before.film.scenes[run.scene].lines.map((l: any) => l.id).filter(Boolean));
  const newId = nextId(afterId, ids);
  let newRaw = ln[afterIdx].replace(new RegExp(`^(\\s*\\S+\\s+)${escapeRe(afterId)}(?=\\s|$)`), `$1${newId}`);
  newRaw = withText(dropKeys(newRaw, ["flip", "span", "with"]), text);
  if (digits) newRaw = withKey(newRaw, "digits", digits);
  let follower: { idx: number; raw: string; pf: NonNullable<ReturnType<typeof parseAt>> } | null = null;
  for (let i = afterIdx + 1; i < ln.length; i++) {
    const p = parseLine(ln[i], { file: run.path, line: i + 1 });
    if (!p || ["mark", "sfx", "text", "tag"].includes(p.verb) || p.kv.on === afterId) continue;
    const at2 = atOfRaw(ln[i]);
    const q = at2 ? parseAt(at2) : null;
    if (q && q.cause === afterId) {
      follower = { idx: i, raw: ln[i], pf: q };
      break;
    }
  }
  let newAt: string;
  if (follower) {
    // The new line takes half the gap and the follower keeps the rest, so nothing later moves. The full gap is the printed alternative.
    const gap = follower.pf.offset;
    const first = follower.pf.unit === "b" ? Math.round((gap / 2) * 4) / 4 : gap / 2;
    newAt = gap > 0 ? formatAt({ cause: afterId, offset: first, unit: follower.pf.unit, snap: "" }) : `@${afterId}+2b`;
    ln[follower.idx] = withAt(follower.raw, formatAt({ ...follower.pf, cause: newId, offset: gap > 0 ? gap - first : gap }));
    run.followerId = parseLine(follower.raw, { file: run.path, line: follower.idx + 1 })?.id;
    if (gap > 0) run.altAt = formatAt({ cause: afterId, offset: gap, unit: follower.pf.unit, snap: "" });
  } else {
    newAt = `@${afterId}+2b`;
    run.notes.push(`no line followed ${afterId}, so it sits 2 beats after it`);
  }
  ln.splice(afterIdx + 1, 0, withAt(newRaw, newAt));
  run.idx = afterIdx + 1;
  run.lid = newId;
  run.words.push({ key: "", oldPlain: "", newPlain: plainText(text), pairs: [], here: true });
};

/** Remove form: the line and its mark lines go; each line that hangs on it moves onto the removed line's own time. */
const removeEdit = async (run: Run): Promise<string | null> => {
  const ln = await linesOf(run, run.path);
  const id = run.lid;
  const at0 = atOfRaw(ln[run.idx]);
  const rp = at0 ? parseAt(at0) : null;
  const drop = new Set<number>([run.idx]);
  ln.forEach((raw, i) => {
    const p = parseLine(raw, { file: run.path, line: i + 1 });
    if (p?.verb === "mark" && p.kv.on === id) drop.add(i);
  });
  const kept: string[] = [];
  for (let i = 0; i < ln.length; i++) {
    if (drop.has(i)) continue;
    let raw = ln[i];
    const at2 = atOfRaw(raw);
    const dp = at2 ? parseAt(at2) : null;
    if (dp && dp.cause === id) {
      if (!rp) return `${id} has no time of its own, edit by hand`;
      if (rp.unit !== dp.unit) return "units differ, edit by hand";
      raw = withAt(raw, formatAt({ cause: rp.cause, offset: rp.offset + dp.offset, unit: dp.unit, snap: dp.snap }));
    }
    kept.push(raw);
  }
  ln.splice(0, ln.length, ...kept);
  return null;
};
type Keys = { defects: Set<string>; warns: Set<string> };
type Check = { an: Analysis; plan: any; newD: string[]; newW: string[]; gone: number };
type Form = "text" | "insert" | "remove" | "keys" | "hold" | "hand";

/** The keys to compare with: the last do's, else the saved version's known issues. */
const baselineKeys = async (ctx: DoCtx): Promise<Keys> => {
  try {
    const j = JSON.parse(await Deno.readTextFile(`${ctx.HERE}/.movas/do-last.json`));
    return { defects: new Set(j.defects ?? []), warns: new Set(j.warnings ?? []) };
  } catch { /* no do yet in this tree */ }
  const head = (await ctx.git("rev-parse", "--short=12", "--verify", "--quiet", "HEAD")).out.trim();
  const v = head ? ctx.readKnown()?.versions?.[head] : undefined;
  return { defects: new Set(Object.keys(v?.defects ?? {})), warns: new Set(Object.keys(v?.warnings ?? {})) };
};

/** Step 3: one plan pass on the real tree, and the keys that are new or gone against the baseline. `fail` names why the plan did not run. */
const checkNow = async (ctx: DoCtx, base: Keys, notes: string[]): Promise<Check | { fail: string }> => {
  const got = await planPass(ctx, null, "do", notes);
  if ("fail" in got) return got;
  const plan = got.plan;
  const an = ctx.analyse(ctx.compile(), plan);
  return {
    an, plan,
    newD: [...an.defects.keys()].filter((k) => !base.defects.has(k)),
    newW: [...an.warns.keys()].filter((k) => !base.warns.has(k)),
    gone: [...base.defects].filter((k) => !an.defects.has(k)).length + [...base.warns].filter((k) => !an.warns.has(k)).length,
  };
};

/** Writes every edited file whose text differs from the disk. Each first write is remembered by the Tx. */
const commit = async (run: Run): Promise<void> => {
  for (const [path, lines] of run.files) {
    const next = lines.join("\n");
    if ((await Deno.readTextFile(path)) !== next) await run.tx.write(path, next);
  }
};

const errorsOf = (s: Solved) => s.problems.filter((p) => p.level === "error");
const scopedTo = (key: string, scene: string) => key.split(/[\s|]+/).some((t) => t === scene || t.startsWith(`${scene}.`));

/** Step 4, panel fit: Family L on the panel the edited line sits in, the first candidate with no new issue in this scene wins. */
const panelFit = async (run: Run, base: Keys, res: Check): Promise<boolean> => {
  const lines = await linesOf(run, run.path);
  const panelId = parseLine(lines[run.idx], { file: run.path, line: run.idx + 1 })?.kv.in;
  if (!panelId) return false;
  const triggered = [...res.newD, ...res.newW].some((k) =>
    ["clip ", "margin.edge ", "occluded ", "off "].some((p) => k.startsWith(p)) && (k.split(" ")[1] ?? "").startsWith(`${run.scene}.`),
  );
  if (!triggered) return false;
  const pIdx = lines.findIndex((l, i) => {
    const p = parseLine(l, { file: run.path, line: i + 1 });
    return p?.verb === "panel" && p.id === panelId;
  });
  if (pIdx < 0) return false;
  const praw = lines[pIdx];
  const kv = parseLine(praw, { file: run.path, line: pIdx + 1 })!.kv;
  const k = kv.keep === undefined ? undefined : parseFloat(kv.keep);
  const y0 = parseFloat(kv.y), h0 = parseFloat(kv.h);
  const tag0 = kv.tagY === undefined ? undefined : parseFloat(kv.tagY);
  if (Number.isNaN(y0) || Number.isNaN(h0)) return false;
  let best: { raw: string; parts: string[]; count: number; first: string } | null = null;
  outer: for (const keep of k === undefined ? [undefined] : [k, k + 1]) {
    for (const dy of L_DY) {
      if (keep === k && dy === 0) continue;
      let raw = praw;
      const parts: string[] = [];
      if (dy !== 0) {
        raw = withKey(withKey(raw, "y", fmt(y0 + dy)), "h", fmt(h0 - dy));
        parts.push(`y=${fmt(y0 + dy)}`, `h=${fmt(h0 - dy)}`);
      }
      if (keep !== k) {
        raw = withKey(raw, "keep", String(keep));
        parts.push(`keep=${keep}`);
      }
      if (dy !== 0 && tag0 !== undefined) {
        raw = withKey(raw, "tagY", fmt(tag0 + dy));
        parts.push(`tagY=${fmt(tag0 + dy)}`);
      }
      const got = await analyseWith(run, { path: run.path, idx: pIdx, raw }, "do-panel");
      if (!got) continue;
      const nd = [...got.an.defects.keys()].filter((x) => !base.defects.has(x) && scopedTo(x, run.scene));
      const nw = [...got.an.warns.keys()].filter((x) => !base.warns.has(x) && scopedTo(x, run.scene));
      const count = nd.length + nw.length;
      if (best === null || count < best.count) best = { raw, parts, count, first: [...nd, ...nw][0] ?? "" };
      if (count === 0) break outer;
    }
  }
  if (!best) return false;
  if (best.count > 0) run.notes.push(`still new: ${best.first}`);
  lines[pIdx] = best.raw;
  run.panel = best.parts.join(" ");
  return true;
};

/** The frame to look at: the punch's floor, the hold's follower minus 5 frames, or the line's event plus 20 (30 for a dock hold). */
const frameOf = (run: Run, form: Form, now: Solved): number | undefined => {
  const sc = now.scenes.find((s: any) => s.id === run.scene);
  const end = (f: number) => (sc ? Math.min(f, sc.endFrame - 1) : f);
  const at = (id: string) => now.events[id]?.frame ?? run.before.events[id]?.frame;
  const eid = `${run.scene}.${run.lid}`;
  if (form === "remove") {
    const f = run.before.events[eid]?.frame;
    return f === undefined ? undefined : end(f + 20);
  }
  if (form === "hold") {
    if (run.followerId) {
      const f = at(`${run.scene}.${run.followerId}`);
      if (f !== undefined) return end(f - 5);
    }
    const fl = at(`${eid}.floor`);
    if (fl !== undefined) return end(fl);
    const f = at(eid);
    return f === undefined ? undefined : end(f + 30);
  }
  if (form === "text") {
    const fl = at(`${eid}.floor`);
    if (fl !== undefined) return end(fl);
  }
  const f = at(eid) ?? at(`${eid}.reply`);
  return f === undefined ? undefined : end(f + 20);
};

/** Renders one still with the renderer's own stills path. A failure does not roll back. */
const frameRow = async (ctx: DoCtx, frame: number): Promise<string> => {
  const dir = `${ctx.WORK}/look`;
  await Deno.mkdir(dir, { recursive: true });
  // On its own port, since it runs beside the preview: the still and the preview take the same wall time as the preview alone.
  const o = await ctx.render([`--stills=${frame}`, `--out=${dir}`, "--timeout=120", "--nochecks", `--port=${parseInt(ctx.PORT) + 20000}`, `--dbg=${parseInt(ctx.PORT) + 26000}`]);
  if (!o.success) return `frame: failed: ${new TextDecoder().decode(o.stderr).trim().slice(-200)}`;
  return `frame: ${dir}/${String(frame).padStart(5, "0")}.png  Read this file to see it.`;
};

/** Step 6, the preview: a half-res render of the whole film, redrawn frames only. Returns the rows to print. */
const previewRows = async (ctx: DoCtx): Promise<string[]> => {
  const head = (await ctx.git("rev-parse", "--short=12", "--verify", "--quiet", "HEAD")).out.trim();
  const t0 = performance.now();
  const o = await ctx.render(["--preview", "--timeout=600", `--shadow=${head}`, "--dirty=1"]);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  if (!o.success) return [`  preview: failed: ${new TextDecoder().decode(o.stderr).trim().slice(-200)}`];
  const text = new TextDecoder().decode(o.stdout);
  let s: any;
  try {
    s = JSON.parse(text.slice(text.lastIndexOf("\n{") + 1));
  } catch {
    return ["  preview: failed: the render printed no summary"];
  }
  const drawn = s.framesDrawn ?? 0, total = s.frames ?? 0;
  let verify = "";
  if (drawn === 0) verify = "verify: nothing redrawn";
  else if (Array.isArray(s.drawnRanges) && s.drawnRanges.length) {
    const ranges = s.drawnRanges.map((r: number[]) => `${r[0]}-${r[1]}`).join(",");
    const tv = performance.now();
    const v = await new Deno.Command("python3", { args: ["-B", `${ctx.TOOL ?? ctx.HERE}/tool/verify.py`, "--preview", `--ranges=${ranges}`], cwd: ctx.HERE, stdout: "piped", stderr: "piped" }).output();
    const traceFile = Deno.env.get("MOVAS_TRACE");
    if (traceFile) Deno.writeTextFileSync(traceFile, JSON.stringify({ step: "verify", ms: Math.round(performance.now() - tv) }) + "\n", { append: true });
    const last = new TextDecoder().decode(v.stdout).trim().split("\n").pop() ?? "";
    const m = /defects: (\d+)/.exec(last);
    verify = m ? `verify: defects ${m[1]}.` : `verify: failed: ${last.slice(0, 160)}`;
  }
  const mib = s.bytes / 1048576;
  const rows = [`  preview: ${s.out} (${mib.toFixed(1)} MiB, ${drawn} of ${total} frames redrawn, ${secs} s).${verify ? ` ${verify}` : ""}`];
  if (s.bytes > 30 * 1048576) rows.push("  warning: over the 30 MiB phone limit.");
  return rows;
};

/** Step 7, decisions: each direction.log entry that names one of the ids, one row each. */
const decisionsFor = (ctx: DoCtx, ids: string[]): { rows: string[]; report: string[]; decisionIds: string[] } => {
  const hits = ctx.readDirection().filter((d) => d.appliesTo.some((a) => ids.some((id) => a === id || a.startsWith(`${id}.`))));
  return {
    rows: hits.map((d) => `  decision: ${d.id} ${d.date}: "${d.decision.slice(0, 180)}". This edit touches it, so the director must confirm it.`),
    report: hits.map((d) => `Decision ${d.id} needs your confirmation.`),
    decisionIds: hits.map((d) => d.id),
  };
};

const margin = (m: number | null) => (m === null ? "unknown" : String(Math.round(m)));
const compileRefused = (s: Solved): number => {
  console.log("NOT DONE: the edit does not compile");
  for (const p of errorsOf(s).slice(0, 5)) console.log(`  ${p.code} ${p.msg}`);
  if (errorsOf(s).some((p) => p.code === "sfx.hits")) console.log("  Give the plain words with no / or *, and do picks the word groups and keeps their count and accent.");
  if (errorsOf(s).some((p) => p.code === "truth.digits")) console.log('  If the director gave this number, tag it in the same command: ./movas do <ref> "words" digits=clock. Do not add a number the director did not give.');
  return 1;
};

/** The refusal for a plan pass that did not run, with its cause. The rollback is the caller's. */
const planRefused = (why: string): number => {
  console.log("NOT DONE: the plan pass did not run");
  if (why) console.log(`  cause: ${why}`);
  console.log("  The pass ran twice and failed both times.");
  return 1;
};

/** Step 5, words: what the plan says about each change of words. The old words still on screen refuse the edit. */
const wordsCheck = async (run: Run, plan: any): Promise<{ refuse?: string; keep?: boolean; rows: string[]; sure: boolean }> => {
  const rows: string[] = [];
  if (run.words.length === 0) return { rows, sure: true };
  const literals: { where: string; line: string; changed: boolean }[] = [];
  for (const path of await programsJs(run.ctx.HERE, run.ctx.TOOL)) {
    (await linesOf(run, path)).forEach((line, i) => {
      const where = `${rel(run.ctx, path)}:${i + 1}`;
      if (!isCommentLine(line)) literals.push({ where, line, changed: run.also.includes(where) });
    });
  }
  let sure = true;
  for (const w of run.words) {
    const id = `${run.scene}.${run.lid}${w.key ? `.${w.key}` : ""}`;
    const got = wordsProof({ id, oldWords: w.oldPlain, newWords: w.newPlain, pairs: w.pairs, here: w.here, drawn: plan.drawn ?? [], literals });
    // --here keeps the old words in other places, so it is the way out when other places draw them.
    if (got.state === "refused") return { refuse: `the old words are still on screen, drawn by ${got.where.join(", ")}`, keep: !w.here && got.where.some((x) => x !== id), rows, sure: false };
    if (got.state === "drawn") rows.push(`  words: ${got.where} draws the new words.`);
    else if (got.state === "literal") rows.push(`  words: ${got.where} holds the new words. The plan cannot see this text, a program draws it.`);
    else {
      sure = false;
      rows.push(`  words: Not confirmed on screen: ${run.scene}.${run.lid} is drawn by a program. Check the frame.`);
    }
  }
  return { rows, sure };
};

/** The one-line report for the director and agent, from short sentences, only the parts that apply. */
const reportText = (parts: string[]): string => parts.join(" ");

/** Which frames changed picture between two plans. Null when either plan has no hashes. */
export const pictureChange = (a: any, b: any): { count: number; total: number; ranges: [number, number][] } | null => {
  if (!a?.picture || !b?.picture) return null;
  const before = new Map<number, string>(a.picture.frames.map((f: number, i: number) => [f, a.picture.hashes[i]]));
  const ranges: [number, number][] = [];
  let count = 0;
  b.picture.frames.forEach((f: number, i: number) => {
    if (before.get(f) === b.picture.hashes[i]) return;
    count++;
    const last = ranges.at(-1);
    if (last && last[1] === f - 1) last[1] = f;
    else ranges.push([f, f]);
  });
  return { count, total: b.picture.frames.length, ranges };
};
const rangesText = (r: [number, number][]): string => r.slice(0, 3).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ") + (r.length > 3 ? ` and ${r.length - 3} more` : "");
const SOUND_VERBS = ["sfx", "pulse", "vo", "music", "duck"];
/** The sound a viewer hears, as the score solves it. */
const soundOf = (s: Solved) => JSON.stringify([s.sfx, s.ducks, s.trimBeats, s.durationFrames]);
/** Where a line's words still live in programs/: a program that draws them does not read the score. */
const holdersOf = async (run: Run): Promise<string[]> => {
  const kv = run.before.kvOf[`${run.scene}.${run.lid}`] ?? {};
  const row = run.before.texts.find((t) => t.id === `${run.scene}.${run.lid}`);
  const words = [...TEXT_KEYS.map((k) => kv[k]), row ? plainText(row.text ?? "") : ""].filter((w) => w && w.length >= 6);
  const files: string[] = [];
  const walk = async (d: string) => {
    for await (const e of Deno.readDir(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.name.endsWith(".js")) files.push(p);
    }
  };
  await walk(`${run.ctx.HERE}/film/programs`).catch(() => {});
  await walk(`${run.ctx.TOOL ?? run.ctx.HERE}/programs`).catch(() => {});
  files.sort();
  const out: string[] = [];
  for (const w of words) {
    for (const f of files) {
      const i = (await Deno.readTextFile(f)).split("\n").findIndex((l) => l.includes(w));
      if (i >= 0) { out.push(`"${w}" stays in ${f.startsWith(`${run.ctx.HERE}/`) ? f.slice(run.ctx.HERE.length + 1) : f}:${i + 1}`); break; }
    }
  }
  return out;
};

/** Steps 1 to 8 for an edit: compile, time fit, write, checks, panel fit, frame, preview, decisions, then the block. */
/** True when film/programs differs from the last save. A failed git call reads as unchanged. */
const programsChanged = async (ctx: DoCtx): Promise<boolean> => {
  const r = await ctx.git("status", "--porcelain", "--", "film/programs").catch(() => null);
  return r !== null && r.ok && r.out.trim() !== "";
};

const finish = async (
  run: Run,
  form: Form,
  what: string,
  o: { preview: boolean; timeFitOn: boolean; panelOn: boolean; extraIds: string[]; holdValue?: string },
): Promise<number> => {
  const { ctx } = run;
  // Step 1: the edit compiles in the temp copy. Nothing in film/ has changed yet.
  const staged = await compileStage(run);
  if (errorsOf(staged).length) return compileRefused(staged);
  // Step 2: time fit for a text or an insert.
  if (o.timeFitOn) {
    const lines = await linesOf(run, run.path);
    const raw0 = lines[run.idx];
    const raw1 = await timeFit(run, raw0);
    lines[run.idx] = raw1;
    const from = atOfRaw(raw0), to = atOfRaw(raw1);
    if (from !== to) run.timeChange = { from: from ?? "", to: to ?? "" };
    if (!run.alt && run.altAt) {
      const sa = await compileStage(run, [{ path: run.path, idx: run.idx, raw: withAt(raw1, run.altAt) }]);
      if (!sa.problems.some((p) => p.level === "error")) run.alt = { cmd: `./movas do ${run.scene}.${run.lid} at=${run.altAt}`, cost: costOf(run.before, sa) };
    }
  }
  // An edit that leaves every file as it was is not done, whatever the command said.
  let differs = false;
  for (const [path, lines] of run.files) if ((await Deno.readTextFile(path)) !== lines.join("\n")) differs = true;
  if (!differs) {
    console.log(`NOT DONE: this changes nothing. ${run.scene}.${run.lid} already reads that way.`);
    return 1;
  }
  // The picture before the write. The plan cache answers this with no shell when the tree was planned before.
  const picBefore = ctx.pictureNow ? await ctx.pictureNow() : null;
  // Write, then compile the real tree. Any failure from here puts every file back.
  await commit(run);
  const now0 = ctx.compile();
  if (errorsOf(now0).length) {
    await run.tx.rollback();
    return compileRefused(now0);
  }
  // A hold is measured on the tree that was written: the start or the ender moved by what the note asked for.
  if (form === "hold" && run.hold) {
    const g = holdGot(run, run.hold.cand, now0, run.hold.want);
    if (!g || !g.ok) {
      await run.tx.rollback();
      console.log(`NOT DONE: the hold is not in the film, ${g ? `${holdSays(run.hold.cand, g)} and it needs ${g.need}f` : "its event has no time"}. Nothing was changed.`);
      return 1;
    }
  }
  const base = await baselineKeys(ctx);
  let res = await checkNow(ctx, base, run.notes);
  if ("fail" in res) {
    await run.tx.rollback();
    return planRefused(res.fail);
  }
  // Step 4: panel fit, then one more check on the real tree.
  if (o.panelOn && (await panelFit(run, base, res))) {
    await commit(run);
    res = await checkNow(ctx, base, run.notes);
    if ("fail" in res) {
      await run.tx.rollback();
      return planRefused(res.fail);
    }
  }
  // Step 5: the words are on screen, or the edit is refused.
  const words = await wordsCheck(run, res.plan);
  if (words.refuse) {
    await run.tx.rollback();
    console.log(`NOT DONE: ${words.refuse}`);
    console.log(`  Nothing was changed.${words.keep ? " To keep the old words in those places, add --here." : ""}`);
    return 1;
  }
  const now = ctx.compile();
  // Step 6: an edit that changes no frame and no sound did nothing a viewer can see, whatever the score says.
  // Picture hashes come from the display list, and a program's own code is outside them. So an edit that also wrote a program reports no count.
  const pic = [...run.tx.old.keys()].every((p) => isScoreFile(ctx, p)) ? pictureChange(picBefore, res.plan) : null;
  // Words and removed lines are about the picture, so a sound that moved does not count for them. A key can be about the sound alone.
  const aboutPicture = form === "text" || form === "insert" || (form === "remove" && !SOUND_VERBS.includes(run.verb));
  if (pic && pic.count === 0 && (aboutPicture || soundOf(run.before) === soundOf(now))) {
    const holders = await holdersOf(run);
    await run.tx.rollback();
    console.log(`NOT DONE: this changes no frame${aboutPicture ? "" : " and no sound"}. ${run.scene}.${run.lid} is not what the viewer sees.${holders.length ? ` ${holders.join("; ")}.` : ""}`);
    console.log("  Nothing was changed. A program draws this, so the note needs a program edit by an agent.");
    return 1;
  }
  const cost = costOf(run.before, now);
  const frame = frameOf(run, form, now);
  const [frame1, prev] = await Promise.all([frame === undefined ? null : frameRow(ctx, frame), o.preview ? previewRows(ctx) : null]);
  const dec = decisionsFor(ctx, [`${run.scene}.${run.lid}`, ...o.extraIds]);
  // Undo and the baseline for the next do.
  await run.tx.saveUndo();
  await Deno.writeTextFile(`${ctx.HERE}/.movas/do-last.json`, JSON.stringify({ defects: [...res.an.defects.keys()], warnings: [...res.an.warns.keys()] }, null, 1));
  // The block.
  const { newD, newW } = res;
  const md = ctx.meaningDelta ? await ctx.meaningDelta() : null;
  const out: string[] = [`${(newD.length || md?.newValidated) ? "DONE WITH NEW DEFECTS" : "DONE"} ${run.scene}.${run.lid} ${what}`];
  if (run.split) {
    const r = run.split.rejected;
    out.push(`  split: margin ${margin(run.split.margin)} px.${r ? ` Not taken: "${r.text}" margin ${margin(r.margin)} px. To take it: ./movas do ${run.scene}.${run.lid} "${r.text}"` : ""}`);
  }
  if (run.timeChange) out.push(`  time: ${run.timeChange.from} -> ${run.timeChange.to}`);
  if (run.hold) out.push(`  hold: ${run.hold.proof} (the note asked for ${fmt(run.hold.want)}f).`);
  const kick = cost.kick;
  out.push(`  length: film ${run.before.durationFrames}f -> ${now.durationFrames}f (${signed(cost.frames)}f). ${cost.moved} events move, ${cost.phase} change bar phase, ${kick.length} leave the kick${kick.length ? `: ${kick.slice(0, 3).join(", ")}` : ""}`);
  if (run.alt) out.push(`  other fit: ${run.alt.cmd}  (${signed(run.alt.cost.frames)}f, ${run.alt.cost.moved} move, ${run.alt.cost.phase} change bar phase)`);
  if (run.panel) out.push(`  panel: ${run.panel}`);
  if (run.also.length) out.push(`  also changed: ${run.also.join(", ")}`);
  out.push(...words.rows);
  if (pic) out.push(`  picture: ${pic.count} of ${pic.total} frames change${pic.count ? `: ${rangesText(pic.ranges)}` : ", only the sound does"}.`);
  out.push(`  checks: ${errorsOf(now).length} errors. ${newD.length} new defects, ${newW.length} new warnings, ${res.gone} gone.`);
  if (md) out.push(...md.lines.map((l) => `  ${l}`));
  const newMsgs = [...newD.map((k) => res.an.defects.get(k)!), ...newW.map((k) => res.an.warns.get(k)!)];
  for (const m of newMsgs.slice(0, 3)) out.push(`  new: ${m}`);
  out.push("  not checked: sound, motion, how it reads to a person.");
  if (await programsChanged(ctx)) out.push("programs changed since the last save: run ./movas purity before you report done.");
  const current = (await linesOf(run, run.path))[run.idx];
  const plain = plainText(textOfRaw(current)?.text ?? "");
  if (run.ownGroups && newMsgs.some((m) => m.startsWith("margin.edge"))) run.notes.push(`these word groups break the margin rule. With plain words do picks groups that fit: ./movas do ${run.scene}.${run.lid} "${plain}"`);
  if (run.notes.length) out.push(`  note: ${run.notes.join("; ")}`);
  out.push(...dec.rows);
  if (frame1) out.push(`  ${frame1}`);
  if (prev) out.push(...prev);
  out.push("  undo: ./movas do undo");
  // The report: short sentences, in the spec's order.
  const R: string[] = [];
  const who = `${run.scene.toUpperCase()} ${run.lid}`;
  // The words are claimed only with proof: drawn in the plan, or held by a program line.
  if (form === "text" || form === "insert" || run.words.length) {
    if (!words.sure) R.push(`${who} was edited in the score.`);
    else if (form === "keys") R.push(...run.words.map((w) => `${who} ${w.key} now "${w.newPlain}".`));
    else R.push(`${who} now "${plain}".`);
  }
  if (!words.sure) R.push(`Not confirmed on screen: ${run.scene}.${run.lid} is drawn by a program. Check the frame.`);
  if (form === "hold") R.push(`${who} held ${o.holdValue ?? ""} longer.`, `Measured: ${run.hold?.proof ?? "nothing"}.`);
  if (form === "remove") R.push(`${who} removed.`);
  if (form === "keys" && !run.words.length) R.push(`${who} ${what}.`);
  if (run.timeChange) R.push(`Moved ${run.timeChange.from} to ${run.timeChange.to}.`);
  R.push(...costSentences(cost));
  if (pic) R.push(pic.count ? `${pic.count} frames change on screen, ${rangesText(pic.ranges)}.` : "No frame changes on screen, only the sound.");
  if (run.also.length) R.push(`Also changed ${run.also.length} repeats.`);
  if (run.panel) R.push(`Panel ${run.panel}.`);
  if (md?.newValidated) R.push(`${md.newValidated} new meaning-rule misses: ${md.lines[1]?.replace(/^NEW rule /, "") ?? ""}.`);
  if (newD.length === 0 && newW.length === 0 && !md?.newValidated) R.push("Checks clean.");
  else {
    if (newW.length) R.push(`${newW.length} new warnings: ${newW[0]}.`);
    if (newD.length) R.push(`${newD.length} new defects: ${newD[0]}.`);
  }
  R.push(...dec.report, "Sound and motion not checked.");
  out.push(`report (send it after you read the frame): ${reportText(R)}`);
  console.log(out.join("\n"));
  return newD.length || md?.newValidated ? 1 : 0;
};

/** The saved version's film, checked out to a temp dir so that it compiles beside the working one. */
const scoreAtRef = async (ctx: DoCtx, ref: string): Promise<string> => {
  const dir = await Deno.makeTempDir({ dir: ctx.WORK, prefix: "ref-" });
  const a = await new Deno.Command("git", { args: [`--git-dir=${ctx.HERE}/.movas/history`, "archive", ref, "film"], stdout: "piped", stderr: "piped" }).output();
  if (!a.success) throw new Error(new TextDecoder().decode(a.stderr));
  const tar = new Deno.Command("tar", { args: ["-x", "-C", dir], stdin: "piped" }).spawn();
  const w = tar.stdin.getWriter();
  await w.write(a.stdout);
  await w.close();
  await tar.status;
  return `${dir}/film`;
};

/** The hand form: the working score against the saved version, with no edit. */
const handReport = async (ctx: DoCtx, preview: boolean): Promise<number> => {
  const head = (await ctx.git("rev-parse", "--short=12", "--verify", "--quiet", "HEAD")).out.trim();
  if (!head) {
    console.log("NOT DONE: there is no saved version to compare with. Run ./movas save first.");
    return 1;
  }
  const dir = await scoreAtRef(ctx, "HEAD");
  let before: Solved;
  try {
    before = solve(loadFilm(dir), ctx.PUBLIC);
  } finally {
    await Deno.remove(dir.replace(/\/film$/, ""), { recursive: true }).catch(() => {});
  }
  const now = ctx.compile();
  const cost = costOf(before, now);
  const i = impact(before, now);
  const base = await baselineKeys(ctx);
  const notes: string[] = [];
  const res = await checkNow(ctx, base, notes);
  if ("fail" in res) return planRefused(res.fail);
  const firstId = i.textChanged[0]?.id ?? i.moved[0]?.id ?? "hand";
  const focus = i.textChanged[0]?.id ?? i.moved[0]?.id;
  const focusFrame = focus === undefined ? undefined : now.events[focus]?.frame;
  const [frame1, prev] = await Promise.all([focusFrame === undefined ? null : frameRow(ctx, Math.min(focusFrame + 20, now.durationFrames - 1)), preview ? previewRows(ctx) : null]);
  await Deno.mkdir(`${ctx.HERE}/.movas`, { recursive: true });
  // A hand report writes nothing to the score, so it leaves the last do's undo as it was.
  await Deno.writeTextFile(`${ctx.HERE}/.movas/do-last.json`, JSON.stringify({ defects: [...res.an.defects.keys()], warnings: [...res.an.warns.keys()] }, null, 1));
  const { newD, newW } = res;
  const md = ctx.meaningDelta ? await ctx.meaningDelta() : null;
  const out: string[] = [`${(newD.length || md?.newValidated) ? "DONE WITH NEW DEFECTS" : "DONE"} ${firstId} hand edits checked`];
  out.push(`  length: film ${before.durationFrames}f -> ${now.durationFrames}f (${signed(cost.frames)}f). ${cost.moved} events move, ${cost.phase} change bar phase, ${cost.kick.length} leave the kick${cost.kick.length ? `: ${cost.kick.slice(0, 3).join(", ")}` : ""}`);
  out.push(`  checks: ${errorsOf(now).length} errors. ${newD.length} new defects, ${newW.length} new warnings, ${res.gone} gone.`);
  if (md) out.push(...md.lines.map((l) => `  ${l}`));
  const newMsgs = [...newD.map((k) => res.an.defects.get(k)!), ...newW.map((k) => res.an.warns.get(k)!)];
  for (const m of newMsgs.slice(0, 3)) out.push(`  new: ${m}`);
  out.push("  not checked: sound, motion, how it reads to a person. To see motion: ./movas look <a>..<b> puts 6 frames of a range on one sheet.");
  if (await programsChanged(ctx)) out.push("programs changed since the last save: run ./movas purity before you report done.");
  if (notes.length) out.push(`  note: ${notes.join("; ")}`);
  if (frame1) out.push(`  ${frame1}`);
  if (prev) out.push(...prev);
  out.push("  undo: hand edits have no do undo. ./movas undo restores film/ from the last saved version and leaves programs/ unchanged.");
  const R = costSentences(cost);
  if (md?.newValidated) R.push(`${md.newValidated} new meaning-rule misses: ${md.lines[1]?.replace(/^NEW rule /, "") ?? ""}.`);
  if (newD.length === 0 && newW.length === 0 && !md?.newValidated) R.push("Checks clean.");
  else {
    if (newW.length) R.push(`${newW.length} new warnings: ${newW[0]}.`);
    if (newD.length) R.push(`${newD.length} new defects: ${newD[0]}.`);
  }
  R.push("Sound and motion not checked.");
  out.push(`report (send it after you read the frame): ${reportText(R)}`);
  console.log(out.join("\n"));
  return newD.length || md?.newValidated ? 1 : 0;
};

const usage = (msg: string): number => {
  console.log(`NOT DONE: ${msg}`);
  console.log('usage: ./movas do <ref> "new text" | <ref> key=value... | <ref> hold=+2b | insert <ref> "text" | remove <ref> | undo | (no args: hand edits)');
  return 1;
};

const runDo = async (args: string[], ctx: DoCtx): Promise<number> => {
  const { flags, pos } = parseArgs(args);
  const preview = flags.has("--preview");
  if (flags.has("--help") || pos[0] === "-h" || pos[0] === "help") {
    usage("this prints help and changes nothing.");
    return 0;
  }
  await Deno.mkdir(`${ctx.HERE}/.movas`, { recursive: true });
  if (pos[0] === "undo") return undoLast(ctx);
  await ctx.ensureHistory();
  if (pos.length === 0) return handReport(ctx, preview);
  let form: Exclude<Form, "hand">;
  let ref: string;
  let text = "";
  let pairs: [string, string][] = [];
  let holdArg = "";
  // A digits tag goes with the words it is about, since the compiler refuses digits with no tag.
  let digits = "";
  if (pos[0] === "insert" || pos[0] === "remove") {
    form = pos[0] === "insert" ? "insert" : "remove";
    ref = pos[1] ?? "";
    text = pos.slice(2).filter((a) => !isKey(a)).join(" ");
    digits = pos.slice(2).find((a) => a.startsWith("digits="))?.slice("digits=".length) ?? "";
  } else {
    ref = pos[0];
    const rest = pos.slice(1);
    const keyArgs = rest.filter(isKey);
    let textArgs = rest.filter((a) => !isKey(a));
    // A text key first, then words that the shell split off its value (q=Is there a photo?): they are the rest of the value.
    if (keyArgs.length === 1 && rest[0] === keyArgs[0] && textArgs.length && TEXT_KEYS.includes(KEY_RE.exec(keyArgs[0])![1])) {
      keyArgs[0] = [keyArgs[0], ...textArgs].join(" ");
      textArgs = [];
    }
    if (keyArgs.length === 1 && keyArgs[0].startsWith("digits=") && textArgs.length) digits = keyArgs.splice(0, 1)[0].slice("digits=".length);
    if (keyArgs.length && textArgs.length) return usage("give new text or key=value, not both");
    // A key path, s07.c4.a "words", is the key form of the same edit.
    const path = /^([^.]+\.[^.]+)\.([A-Za-z]+)$/.exec(ref);
    if (path && TEXT_KEYS.includes(path[2]) && textArgs.length) {
      ref = path[1];
      keyArgs.push(`${path[2]}=${textArgs.join(" ")}`);
      textArgs = [];
    }
    if (keyArgs.some((a) => a.startsWith("hold="))) {
      if (keyArgs.length > 1) return usage("hold= goes alone");
      form = "hold";
      holdArg = keyArgs[0].slice("hold=".length);
    } else if (keyArgs.length) {
      form = "keys";
      pairs = keyArgs.map((a) => { const m = KEY_RE.exec(a)!; return [m[1], unquote(m[2])] as [string, string]; });
      const empty = pairs.find(([k, v]) => TEXT_KEYS.includes(k) && v.trim() === "");
      if (empty) return usage(`${empty[0]}= needs the new words`);
    } else if (textArgs.length) {
      form = "text";
      text = textArgs.join(" ");
    } else return usage("nothing to change");
  }
  if ((form === "text" || form === "insert") && text.trim() === "") return usage("the new text is empty");
  const s0 = ctx.compile();
  const r = resolveRef(s0, ref);
  if (!r.line) {
    console.log(`NOT DONE: ${ref} matches ${r.n} lines:`);
    for (const row of r.rows ?? []) console.log(row);
    return 1;
  }
  const line = r.line;
  // A verb that keeps its words in keys has no text to change: a quoted string would only be left on the line, drawn by nothing.
  const keys = WORD_KEYS[line.verb];
  if ((form === "text" || form === "insert") && keys !== undefined) {
    const to = `${r.scene}.${line.id ?? line.verb}`;
    console.log(`NOT DONE: ${!keys.length ? `${line.verb} lines take no text.` : form === "text" ? `${line.verb} lines keep their words in ${keysPhrase(keys)}. Use: ./movas do ${to} ${keys.map((k) => `${k}="..."`).join(" or ")}` : `${line.verb} lines keep their words in ${keysPhrase(keys)}, so insert cannot give one new text. Add the line by hand.`}`);
    return 1;
  }
  const run: Run = {
    ctx, before: s0, files: new Map(), scratch: null, tx: new Tx(ctx),
    scene: r.scene!, lid: line.id ?? (line.verb === "end" ? "end" : ""), verb: line.verb,
    path: `${ctx.FILM}/${line.loc.file}`, idx: line.loc.line - 1, notes: [], also: [], words: [],
  };
  try {
    if (form === "text") {
      if (digits) {
        const ln = await linesOf(run, run.path);
        ln[run.idx] = withKey(ln[run.idx], "digits", digits);
      }
      const finalText = await textEdit(run, text, line.verb, flags.has("--here"));
      return await finish(run, "text", `"${finalText}"`, { preview, timeFitOn: true, panelOn: true, extraIds: [] });
    }
    if (form === "keys") {
      await keysEdit(run, pairs, flags.has("--here"));
      return await finish(run, "keys", pairs.map(([k, v]) => `${k}=${TEXT_KEYS.includes(k) || /\s/.test(v) ? `"${v}"` : v}`).join(" "), { preview, timeFitOn: false, panelOn: true, extraIds: [] });
    }
    if (form === "hold") {
      const v = parseValue(holdArg);
      if (!v) return usage(`hold= needs a value such as hold=+2b, got "${holdArg}"`);
      const stop = await holdEdit(run, v);
      if (stop) {
        console.log(`NOT DONE: nothing holds this line, ${stop.reason}.`);
        return 1;
      }
      return await finish(run, "hold", `held ${holdArg} longer`, { preview, holdValue: holdArg, timeFitOn: false, panelOn: false, extraIds: run.followerId ? [`${run.scene}.${run.followerId}`] : [] });
    }
    if (form === "insert") {
      const afterId = run.lid;
      await insertEdit(run, text, digits);
      return await finish(run, "insert", `added "${text}" as ${run.lid}`, { preview, timeFitOn: true, panelOn: true, extraIds: [`${run.scene}.${afterId}`, ...(run.followerId ? [`${run.scene}.${run.followerId}`] : [])] });
    }
    const err = await removeEdit(run);
    if (err) {
      console.log(`NOT DONE: ${err}`);
      return 1;
    }
    return await finish(run, "remove", "removed", { preview, timeFitOn: false, panelOn: false, extraIds: [] });
  } catch (e) {
    await run.tx.rollback();
    console.log(`NOT DONE: ${(e as Error).message ?? String(e)}`);
    return 1;
  } finally {
    if (run.scratch) await run.scratch.clean();
  }
};

/** The `do` command. Returns the exit code. An error nothing expected is reported as NOT DONE, never as a stack trace. */
export const doCmd = async (args: string[], ctx: DoCtx): Promise<number> => {
  try {
    return await runDo(args, ctx);
  } catch (e) {
    console.log(`NOT DONE: ${(e as Error).message ?? String(e)}`);
    return 1;
  }
};
