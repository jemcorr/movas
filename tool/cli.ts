// movas CLI: brief, check, timeline, at, impact, look, render, save, log, undo, diff, apply, film.
import { hashTree, impact, impactText, loadFilm, solve, timelineMd } from "./movas.ts";
import { sha256Hex } from "./ops.ts";
import { doctor } from "./doctor.ts";
import { firstErrorLine, isCommentLine } from "./do_edit.ts";

// HERE is the tool. ROOT is the film: the folder the launcher names in MOVAS_FILM. Before the split they were one folder.
const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ROOT = Deno.env.get("MOVAS_FILM") ?? HERE;
const PUBLIC = Deno.env.get("MOVAS_PUBLIC") ?? "";
const WORK = Deno.env.get("MOVAS_WORK") ?? `${ROOT}/.work`;
const PORT = Deno.env.get("MOVAS_PORT") ?? "3517", DBG = String(parseInt(PORT) + 6000);
const FILM = `${ROOT}/film`;
const HISTORY = `${ROOT}/.movas/history`;
const [cmd, ...rest] = Deno.args;
if (!PUBLIC && cmd !== "help") { console.error("MOVAS_PUBLIC is not set. Add MOVAS_PUBLIC=<folder holding fonts/ and sfx/> to .movasrc."); Deno.exit(2); }

const sh = async (bin: string, args: string[], opts: Deno.CommandOptions = {}) => {
  const o = await new Deno.Command(bin, { args, stdout: "piped", stderr: "piped", cwd: HERE, ...opts }).output();
  return { ok: o.success, out: new TextDecoder().decode(o.stdout), err: new TextDecoder().decode(o.stderr) };
};
const git = (...a: string[]) => sh("git", [`--git-dir=${HISTORY}`, `--work-tree=${ROOT}`, "-c", "user.name=movas", "-c", "user.email=movas@local", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a]);
const ensureHistory = async () => {
  try { await Deno.stat(`${HISTORY}/HEAD`); } catch {
    await Deno.mkdir(HISTORY, { recursive: true });
    await sh("git", ["init", "--quiet", "--bare", HISTORY]);
    await git("config", "core.bare", "false");
  }
};
// The history keeps the film. The tool has its own version control.
const TRACKED = ["film"];
const save = async (msg: string) => {
  await ensureHistory();
  await git("add", "-A", ...TRACKED);
  const r = await git("commit", "--quiet", "--allow-empty", "-m", msg);
  if (!r.ok) throw new Error(r.err);
  const id = (await git("rev-parse", "--short=12", "HEAD")).out.trim();
  // The analysis `report --full` runs, kept with this version. A film the plan pass refuses is saved with no known issues.
  const now = await analysisNow();
  const known = readKnown() ?? {};
  known.versions ??= {};
  known.versions[id] = now
    ? { message: msg, defects: Object.fromEntries(now.defects), warnings: Object.fromEntries(now.warns), texts: Object.fromEntries([...now.rows].map(([k, r]) => [k, { text: r.text, sec: r.sec, px: r.px, clipped: r.clipped }])) }
    : { message: msg, defects: null, warnings: null, texts: null };
  writeKnown(known);
  return id;
};
/** Checks a stored version's score out to a temp dir so that it can be compiled beside the working one. */
const scoreAt = async (ref: string) => {
  const dir = await Deno.makeTempDir({ dir: WORK, prefix: "ref-" });
  const a = await new Deno.Command("git", { args: [`--git-dir=${HISTORY}`, "archive", ref, "film"], stdout: "piped", stderr: "piped" }).output();
  if (!a.success) throw new Error(new TextDecoder().decode(a.stderr));
  const tar = new Deno.Command("tar", { args: ["-x", "-C", dir], stdin: "piped" }).spawn();
  const w = tar.stdin.getWriter(); await w.write(a.stdout); await w.close(); await tar.status;
  return `${dir}/film`;
};
const compile = (dir = FILM) => solve(loadFilm(dir), PUBLIC);
const resolveFrame = (s: any, q: string) => {
  if (/^\d+$/.test(q)) return parseInt(q);
  if (/^\d+:\d/.test(q)) return Math.round((parseInt(q) * 60 + parseFloat(q.split(":")[1])) * s.clock.fps);
  const m = /^(.+?)([+-]\d+)f$/.exec(q), id = m ? m[1] : q, e = s.events[id];
  if (!e) throw new Error(`no event ${id}. Run ./movas help <scene> for the scene's event ids.`);
  return e.frame + (m ? parseInt(m[2]) : 0);
};
// MOVAS_TRACE: stage times of a `do` for the profile. Unset, this does nothing.
const TRACE = Deno.env.get("MOVAS_TRACE");
const stamp = (o: Record<string, unknown>) => { if (TRACE) { try { Deno.writeTextFileSync(TRACE, JSON.stringify(o) + "\n", { append: true }); } catch { /* ignored */ } } };
stamp({ step: "cli.start", ms: Math.round(performance.now()) });
const render = async (args: string[]) => {
  const t0 = performance.now();
  const o = await new Deno.Command(`${HERE}/render.sh`, { args: [`--port=${PORT}`, `--dbg=${DBG}`, `--work=${WORK}`, `--public=${PUBLIC}`, ...args], cwd: HERE, stdout: "piped", stderr: "piped" }).output();
  stamp({ step: "render.cli", args: args.filter((a) => /planOnly|stills|preview|--film/.test(a)).map((a) => a.slice(0, 18)), ms: Math.round(performance.now() - t0), code: o.code });
  return o;
};

// Known issues: each saved version keeps its defects and warnings, and `report` compares the working tree with them.
const KNOWN = `${ROOT}/.movas/known_issues.json`;
const readKnown = (): any | null => { try { return JSON.parse(Deno.readTextFileSync(KNOWN)); } catch { return null; } };
const writeKnown = (k: any) => Deno.writeTextFileSync(KNOWN, JSON.stringify(k, null, 1));
// film/direction.log: a dated line `<date> <id> source= recorded_by= applies_to=`, then an indented decision: line and an optional words: line.
type Decision = { date: string; id: string; appliesTo: string[]; decision: string; words?: string };
const readDirection = (): Decision[] => {
  let text = "";
  try { text = Deno.readTextFileSync(`${FILM}/direction.log`); } catch { return []; }
  const out: Decision[] = [];
  let cur: Decision | null = null;
  for (const line of text.split("\n")) {
    const head = /^(\d{4}-\d{2}-\d{2}) (\S+) (.*)$/.exec(line);
    if (head) { cur = { date: head[1], id: head[2], appliesTo: (/applies_to=(\S+)/.exec(head[3])?.[1] ?? "").split(",").filter(Boolean), decision: "" }; out.push(cur); continue; }
    const dec = /^\s+decision:\s?(.*)$/.exec(line);
    if (dec && cur) { cur.decision = dec[1]; continue; }
    const words = /^\s+words:\s?(.*)$/.exec(line);
    if (words && cur) cur.words = words[1];
  }
  return out;
};
const planKey = async (film: string | null, extra: string[] = []) => {
  const trees = [film ?? FILM, `${ROOT}/film/programs`, `${HERE}/programs`, `${HERE}/runtime`, `${HERE}/tool`, `${PUBLIC}/fonts`].map((d) => { try { return hashTree(d); } catch { return "none"; } });
  let score = "nocompile";
  try { score = JSON.stringify(compile(film ?? FILM)); } catch { /* a film that does not compile fails its plan pass anyway */ }
  // A timeout changes how long the pass may run, not what it returns.
  const parts = [...trees, score, JSON.stringify(extra.filter((a) => !a.startsWith("--timeout="))), Deno.env.get("MOVAS_SET") ?? ""];
  return (await sha256Hex(new TextEncoder().encode(parts.join("|")))).slice(0, 32);
};
const keepPlan = (from: string, key: string) => {
  try {
    const dir = `${WORK}/plan-cache`;
    Deno.mkdirSync(dir, { recursive: true });
    Deno.copyFileSync(from, `${dir}/${key}.json`);
    const all = [...Deno.readDirSync(dir)].map((e) => ({ p: `${dir}/${e.name}`, t: Deno.statSync(`${dir}/${e.name}`).mtime?.getTime() ?? 0 })).sort((a, b) => b.t - a.t);
    for (const old of all.slice(40)) Deno.removeSync(old.p);
  } catch { /* the cache never stops a plan */ }
};
/** Why the last plan pass that returned null did not run: the first useful line of its error text. */
let planWhy = "";
/** One plan pass with no pixels. Returns null when it does not run, for example because the film has errors; quiet keeps the error text out. */
const planFor = async (film: string | null, tag: string, extra: string[] = [], quiet = false): Promise<any | null> => {
  const path = `${WORK}/checks-${PORT}-${tag}.json`;
  // A plan pass is a pure function of the film, the programs, the runtime, the compiler and the fonts. The same tree gives the same answer, with no shell.
  const key = await planKey(film, extra), kept = `${WORK}/plan-cache/${key}.json`;
  try { const j = JSON.parse(Deno.readTextFileSync(kept)); stamp({ step: "plan.hit", tag }); return j; } catch { /* run it */ }
  const o = await render(["--planOnly", `--checksOut=${path}`, `--planOut=${path}.pic`, "--timeout=180", ...(film ? [`--film=${film}`] : []), ...extra]);
  if (!o.success) {
    const err = new TextDecoder().decode(o.stderr);
    planWhy = firstErrorLine(err) || `the renderer stopped with code ${o.code} and printed nothing`;
    if (!quiet) console.error(err.slice(-1500));
    return null;
  }
  try {
    const j = JSON.parse(Deno.readTextFileSync(path));
    // The picture hash per frame lets do say which frames an edit changed, with no pixels drawn.
    try {
      const p = JSON.parse(Deno.readTextFileSync(`${path}.pic`));
      j.picture = { frames: p.frames, hashes: p.hashes };
      Deno.writeTextFileSync(path, JSON.stringify(j));
      Deno.removeSync(`${path}.pic`);
    } catch { /* the check that reads it is skipped */ }
    keepPlan(path, key);
    return j;
  } catch (e) {
    planWhy = `the plan result could not be read: ${(e as Error).message}`;
    return null;
  }
};

/** A scan pass (display-list rows per frame, no pixels), cached by the same key as the plan. */
const scanFor = async (film: string | null, extra: string[] = []): Promise<{ rows: Map<number, any[]>; checks: any } | null> => {
  const key = await planKey(film, extra), path = `${WORK}/film-scan-${key}.jsonl`, checksPath = `${WORK}/film-checks-${key}.json`;
  await Deno.mkdir(WORK, { recursive: true });
  try { await Deno.stat(path); await Deno.stat(checksPath); } catch {
    const o = await render(["--planOnly", `--scanOut=${path}.tmp`, `--checksOut=${checksPath}`, "--timeout=180", ...(film ? [`--film=${film}`] : []), ...extra]);
    if (!o.success) { await Deno.remove(`${path}.tmp`).catch(() => {}); planWhy = firstErrorLine(new TextDecoder().decode(o.stderr)) || "the scan pass stopped"; return null; }
    await Deno.rename(`${path}.tmp`, path);
  }
  const { readScan } = await import("./film.ts");
  return { rows: readScan(path), checks: JSON.parse(Deno.readTextFileSync(checksPath)) };
};
/** The meaning-rule delta against the last saved version, for do and report. */
const meaningDeltaLines = async (extra: string[] = []): Promise<{ lines: string[]; newValidated: number }> => {
  const { meaningHits, meaningDelta } = await import("./meaning_delta.ts");
  const { MeaningError, readMeaning } = await import("./rules.ts");
  const at = async (film: string | null) => {
    const dir = film ?? FILM, s = compile(dir), fm = s.film.formats[s.film.defaultFormat];
    const meaning = readMeaning(dir, `${HERE}/tool`);
    const sc = await scanFor(film, extra);
    return sc ? meaningHits({ s, checks: sc.checks, rows: sc.rows, meaning, W: fm.w, H: fm.h }) : null;
  };
  try {
    const now = await at(null);
    if (!now) return { lines: [`meaning rules: not checked, the scan pass did not run: ${planWhy}`], newValidated: 0 };
    await ensureHistory();
    const head = (await git("rev-parse", "--short=12", "--verify", "--quiet", "HEAD")).out.trim();
    if (!head) return { lines: ["meaning rules: no saved version to compare with."], newValidated: 0 };
    const dir = await scoreAt(head);
    let base: Awaited<ReturnType<typeof at>> = null;
    try { base = await at(dir); } catch { base = null; } finally { await Deno.remove(dir.replace(/\/film$/, ""), { recursive: true }).catch(() => {}); }
    if (!base) return { lines: ["meaning rules: the saved version does not scan, so there is no baseline."], newValidated: 0 };
    return meaningDelta(now, base);
  } catch (e) {
    // The delta is a report, never a reason for do or report to stop: any failure here prints as not checked.
    return { lines: [`meaning rules: not checked: ${e instanceof MeaningError ? "" : "error: "}${String((e as Error).message).split("\n")[0]}`], newValidated: 0 };
  }
};

// The two verbs whose reading floor the renderer holds, so a miss is a defect. Other verbs read their floor in the score.
const READ_VERBS = ["punch", "dock"];
const analyse = (s: any, c: any) => {
  const fps = s.clock.fps, defects = new Map<string, string>(), warns = new Map<string, string>(), rows = new Map<string, any>();
  const byId = new Map(s.texts.map((t: any) => [t.id, t]));
  const ruleOf = (id: string) => s.film.rules.find((r: any) => r.id === id);
  const edgePx = parseFloat(ruleOf("margin.edge")?.kv.px ?? "NaN"), minPx = parseFloat(ruleOf("min.text")?.kv.px ?? "NaN");
  for (const t of [...c.texts].sort((a: any, b: any) => a.first - b.first)) {
    const reg: any = byId.get(t.id), sec = t.full / fps;
    const read = reg && READ_VERBS.includes(reg.verb) ? ruleOf(`read.${reg.verb}`) : null;
    const need = read ? parseFloat(read.kv.base) + parseFloat(read.kv.per_word) * (reg.words ?? 0) : null;
    if (need !== null && sec < need - 0.02) defects.set(`read.visible ${t.id}`, `read.visible ${t.id}: fully visible ${sec.toFixed(2)} s, the rule needs ${need.toFixed(2)} s`);
    if (t.maxPx < minPx) warns.set(`min.text ${t.id}`, `min.text ${t.id}: largest ${t.maxPx.toFixed(1)} px, rule ${minPx}`);
    if (t.clipped) warns.set(`clip ${t.id}`, `clip ${t.id}: clipped in ${t.clipped} of ${t.frames} frames`);
    if (t.margin >= 0 && t.margin < edgePx && !c.offFrame?.[t.id]) warns.set(`margin.edge ${t.id}`, `margin.edge ${t.id}: ${t.margin.toFixed(0)} px, rule ${edgePx}`);
    rows.set(t.id, { sec, text: t.text, line: `${t.id}\tf${t.first}-${t.last}\tfull ${sec.toFixed(2)}s\t${t.minPx.toFixed(0)}-${t.maxPx.toFixed(0)}px\tmargin ${t.margin > 1e8 ? "-" : t.margin.toFixed(0)}px\t${String(t.text).slice(0, 40)}`, px: t.maxPx, margin: t.margin, clipped: t.clipped });
  }
  for (const [id, e] of Object.entries<any>(c.occluded)) (e.transition ? warns : defects).set(`${e.transition ? "cover" : "occluded"} ${id} ${e.by}`, `${e.transition ? "transition cover" : "occluded"} ${id} by ${e.by}: ${e.frames.length} frames from f${e.frames[0]}, up to ${(e.maxShare * 100).toFixed(0)}% covered`);
  for (const [id, e] of Object.entries<any>(c.offFrame)) defects.set(`off ${id}`, `off-frame ${id}: ${e.n ?? ""} frames from f${e.first ?? ""}`);
  for (const p of c.collisions) (p.transition ? warns : defects).set(`pair ${p.a} ${p.b}`, `${p.transition ? "transition overlap" : "collision"} ${p.a} x ${p.b}: ${p.frames} frames from f${p.first}`);
  for (const d of c.deadKeys ?? []) warns.set(`key.dead ${d.id} ${d.key}`, `key.dead ${d.id} ${d.key}`);
  // A quoted string on a verb that takes no text comes from the compile. A hand edit shows it here too.
  for (const p of s.problems) if (p.code === "text.stray") warns.set(`text.stray ${p.id ?? `${p.loc?.file}:${p.loc?.line}`}`, `${p.code} ${p.msg}`);
  // Every string the frames draw must be a piece of a score text once markup and spacing are gone. Decor is exempt.
  const norm = (x: string) => x.replace(/[*/]/g, "").replace(/\s+/g, " ").trim();
  const scoreTexts: string[] = s.texts.map((t: any) => norm(String(t.text ?? ""))).filter(Boolean);
  // A panel line's title is the score's own word for a chat header.
  for (const sc of Object.values<any>(s.panels ?? {})) for (const k of Object.values<any>(sc)) if (k.title) scoreTexts.push(norm(String(k.title)));
  const sceneAt = (f: number) => s.scenes.find((x: any) => f >= x.startFrame && f < x.endFrame)?.id;
  const unreg = new Map<string, { name: string; text: string; first: number }>();
  for (const d of c.drawn ?? []) {
    const text = norm(String(d.text ?? ""));
    if (d.decor || !text || scoreTexts.some((x) => x.includes(text))) continue;
    const name = d.id ?? d.scene ?? sceneAt(d.first) ?? "(no scene)", k = `${name}\u0000${text}`, cur = unreg.get(k);
    if (!cur || d.first < cur.first) unreg.set(k, { name, text, first: d.first });
  }
  const banned = (ruleOf("truth.banned")?.kv.words ?? "").split(",").filter(Boolean);
  // Keyed by the id and its count, not the words: changing the words of a known unregistered string is not a new defect. One more such string under the id is.
  const perName = new Map<string, number>();
  for (const u of unreg.values()) {
    const nth = perName.get(u.name) ?? 0;
    perName.set(u.name, nth + 1);
    defects.set(`text.unregistered|${u.name}|${nth}`, `text.unregistered ${u.name} f${u.first}: "${u.text}"${/\.name$/.test(u.name) ? `. A panel line's title= sets a chat header` : ""}`);
    if (banned.some((w: string) => u.text.toLowerCase().includes(w.toLowerCase()))) defects.set(`truth.banned|${u.name}|${u.text}`, `truth.banned ${u.name} f${u.first}: "${u.text}"`);
    if (ruleOf("truth.digits") && /\d/.test(u.text)) defects.set(`truth.digits|${u.name}|${u.text}`, `truth.digits ${u.name} f${u.first}: "${u.text}"`);
  }
  // A line in the score that no frame draws: the viewer never sees it, so a note on it changes nothing on screen. Text baked into an image reads as not drawn too.
  const drawnTexts: string[] = (c.drawn ?? []).map((d: any) => norm(String(d.text ?? ""))).filter(Boolean);
  for (const t of s.texts) {
    const x = norm(String(t.text ?? ""));
    if (x && !drawnTexts.some((d) => d.includes(x) || (d.length >= 3 && x.includes(d)))) warns.set(`text.notdrawn ${t.id}`, `text.notdrawn ${t.id}: no frame draws "${x.slice(0, 40)}"`);
  }
  // Spans with nothing on screen but the background. Keyed by scene and count, so a re-timing does not make them new.
  const deadPer = new Map<string, number>();
  for (const d of c.deadAir ?? []) {
    const sc = sceneAt(d.first) ?? "(no scene)", nth = deadPer.get(sc) ?? 0;
    deadPer.set(sc, nth + 1);
    warns.set(`dead.air ${sc} ${nth}`, `dead.air ${sc}: nothing on screen for ${(d.n / fps).toFixed(1)} s from f${d.first}`);
  }
  return { defects, warns, rows };
};

/** The analysis of the working tree: what `report --full` prints, and what `save` records with the version. Null when the plan does not run. */
const analysisNow = async () => { const c = await planFor(null, "now", [], true); return c ? analyse(compile(), c) : null; };

const sceneFile = (id: string) => [...Deno.readDirSync(FILM)].map((e) => e.name).find((n) => n.startsWith(`${id}-`));
// Helpers for changed, compare, rebuild and apply.
const sha256File = async (p: string) => sha256Hex(await Deno.readFile(p));
const archiveTo = async (ref: string, paths: string[], dir: string) => {
  const a = await new Deno.Command("git", { args: [`--git-dir=${HISTORY}`, "archive", ref, ...paths], stdout: "piped", stderr: "piped" }).output();
  if (!a.success) throw new Error(new TextDecoder().decode(a.stderr));
  const tar = new Deno.Command("tar", { args: ["-x", "-C", dir], stdin: "piped" }).spawn();
  const w = tar.stdin.getWriter(); await w.write(a.stdout); await w.close(); await tar.status;
};
const stills = async (film: string | null, frames: number[], out: string) => {
  await Deno.mkdir(out, { recursive: true });
  const o = await render([...(film ? [`--film=${film}`] : []), `--stills=${frames.join(",")}`, `--out=${out}`, "--timeout=120", "--nochecks"]);
  if (!o.success) { console.error(new TextDecoder().decode(o.stderr).slice(-1500)); Deno.exit(1); }
};

// A changed line's old words can repeat where nothing links them: another scene's chat, a wall's texture pool. Name those places, so a brief for one scene does not hide them.
const stillHolds = async (changed: { id: string; from: string; to: string }[]) => {
  const plain = (t: string) => t.replace(/\*|\\n/g, " ").replace(/\s*\/\s*/g, " ").replace(/\s+/g, " ").trim();
  const files: string[] = [];
  const walk = async (d: string) => { for await (const e of Deno.readDir(d)) { const p = `${d}/${e.name}`; if (e.isDirectory) await walk(p); else if (/\.(movas|js)$/.test(e.name)) files.push(p); } };
  for (const d of [`${ROOT}/film`, `${HERE}/programs`]) await walk(d).catch(() => {});
  const shown = (f: string) => f.startsWith(`${ROOT}/`) ? f.slice(ROOT.length + 1) : f.startsWith(`${HERE}/`) ? f.slice(HERE.length + 1) : f;
  files.sort();
  const out: string[] = [];
  for (const t of changed) {
    const to = plain(t.to), from = plain(t.from);
    const phrases = [from, ...from.split(/(?<=[.?!])\s+/)].filter((p, n, all) => p.split(" ").length >= 3 && !to.includes(p) && all.indexOf(p) === n);
    for (const p of phrases) {
      const hits: string[] = [];
      for (const f of files) (await Deno.readTextFile(f)).split("\n").forEach((l, n) => { if (!isCommentLine(l) && plain(l).includes(p)) hits.push(`${shown(f)}:${n + 1}`); });
      if (hits.length) out.push(`  old words of ${t.id} are still in other places, "${p}": ${hits.join(", ")}`);
    }
  }
  return out;
};
// A format's own page joins the brief of a film that uses the format.
const packPages = (s: any) => (s.film.uses ?? []).flatMap((u: string) => { try { return [Deno.readTextFileSync(`${HERE}/tool/packs/${u}.md`).trim()]; } catch { return []; } });
if (cmd === "help" && rest[0] === "rules") console.log(Deno.readTextFileSync(`${HERE}/tool/rules.md`).trim());
else if (cmd === "help" && rest[0] === "programs") {
  // The format pages come from the film's `use` lines. A film that does not load still gets the tool's page.
  let packs: string[];
  try { packs = packPages(compile()); } catch (e) { packs = [`The film does not load, so its format pages are left out: ${String((e as Error).message).split("\n")[0]}`]; }
  console.log([Deno.readTextFileSync(`${HERE}/tool/programs.md`).trim(), ...packs].join("\n\n"));
}
else if (cmd === "help") {
  const s = compile();
  const rulesText = (() => { try { return Deno.readTextFileSync(`${FILM}/rules.movas`); } catch { return ""; } })();
  const L: string[] = [Deno.readTextFileSync(`${HERE}/tool/syntax.md`).trim(), ...packPages(s).flatMap((x: string) => ["", x]), "", "## Rules", rulesText.split("\n").filter((l) => l.startsWith("rule")).join("\n") || "None.", "", "## Timeline", timelineMd(s)];
  const open = s.problems.map((p: any) => `${p.level} ${p.code} ${p.msg}`);
  if (open.length) L.push("", "## Open problems", ...open);
  const id = rest[0];
  if (id) {
    const f = sceneFile(id);
    if (!f) throw new Error(`no scene ${id}`);
    L.push("", `## film/${f}`, Deno.readTextFileSync(`${FILM}/${f}`).trim(), "", `## ${id}: derived times (frame, beat, position in bar)`);
    for (const e of Object.values<any>(s.events).filter((e) => e.id.startsWith(`${id}.`))) L.push(`${e.id} f${e.frame} b${e.beat} bar+${e.beatInBar}`);
    const fl = s.floors.filter((x: any) => x.id.startsWith(`${id}.`));
    if (fl.length) L.push("", "Reading slack:", ...fl.map((x: any) => `${x.id} ${x.slackFrames}f`));
    // Decisions in film/direction.log that name this scene, one of its events, or all scenes.
    const hits = readDirection().filter((d) => d.appliesTo.some((a) => a === "all" || a === id || a.startsWith(`${id}.`)));
    if (hits.length) {
      L.push("", "## Decisions touching this scene");
      for (const d of hits) L.push(`${d.date} ${d.id} (applies_to ${d.appliesTo.join(",")})`, `  decision: ${d.decision}`, ...(d.words ? [`  words: ${d.words}`] : []));
      L.push("", "A note that reverses one of these needs the director's confirmation. Say so in your report.");
    }
  } else {
    const n = readDirection().length;
    if (n) L.push("", "## Decisions", `${n} entries in ${FILM}/direction.log`);
  }
  console.log(L.join("\n"));
} else if (cmd === "brief") {
  // The short brief: the tool's page, then one scene's file and its decisions, or the scene list. `help` prints the score syntax.
  const s = compile(), parts = [Deno.readTextFileSync(`${HERE}/tool/brief_short.md`).trim(), ...packPages(s)];
  const id = rest[0];
  if (id) {
    const sc = s.scenes.find((x: any) => x.id === id), f = sc ? sceneFile(id) : undefined;
    if (!sc || !f) { console.error(`no scene ${id}. Scenes: ${s.scenes.map((x: any) => x.id).join(", ")}`); Deno.exit(1); }
    parts.push(`## film/${f}\n${Deno.readTextFileSync(`${FILM}/${f}`).trim()}`);
    const hits = readDirection().filter((d) => d.appliesTo.some((a) => a === "all" || a === id || a.startsWith(`${id}.`)));
    if (hits.length) {
      const L: string[] = ["## Decisions touching this scene"];
      for (const d of hits) L.push(`${d.date} ${d.id} applies to ${d.appliesTo.join(", ")}`, `  decision: ${d.decision.length > 240 ? `${d.decision.slice(0, 237)}...` : d.decision}`, ...(d.words && !d.decision.includes(d.words.replace(/^"|"$/g, "")) ? [`  words: ${d.words.length > 240 ? `${d.words.slice(0, 237)}...` : d.words}`] : []));
      L.push("A note that reverses one of these needs the director's confirmation. Say so in your report.");
      parts.push(L.join("\n"));
    }
  } else parts.push(`Scenes: ${s.scenes.map((x: any) => `${x.id} "${x.title}" ${((x.endFrame - x.startFrame) / s.clock.fps).toFixed(1)}s`).join(", ")}`);
  console.log(parts.join("\n\n"));
} else if (cmd === "check") {
  // Errors, then the warnings the last saved version does not have. --full prints every problem and the counts as before.
  const full = rest.includes("--full");
  const t0 = performance.now(), s = compile(), errs = s.problems.filter((p: any) => p.level === "error"), warns = s.problems.filter((p: any) => p.level !== "error");
  const { MeaningError, readMeaning } = await import("./rules.ts");
  try { readMeaning(FILM, `${HERE}/tool`); } catch (e) { if (!(e instanceof MeaningError)) throw e; errs.push({ level: "error", code: "meaning", msg: e.message }); }
  const ms = (performance.now() - t0).toFixed(1);
  await ensureHistory();
  // Compared with the last saved version, so one command answers "is it valid" and "what did it do".
  const old = (await git("rev-parse", "--verify", "--quiet", "HEAD")).ok ? await scoreAt("HEAD") : null;
  try {
    const sOld = old ? compile(old) : null;
    const saved = new Set((sOld?.problems ?? []).map((p: any) => `${p.code}\u0000${p.msg}`));
    const fresh = warns.filter((p: any) => !saved.has(`${p.code}\u0000${p.msg}`));
    const row = (p: any) => `${p.level} ${p.code} ${p.loc ? `${p.loc.file}:${p.loc.line} ` : ""}${p.msg}`;
    for (const p of full ? s.problems : [...errs, ...fresh]) console.log(row(p));
    const known = full ? "" : `${warns.length - fresh.length} known warnings, `;
    console.log(`${errs.length} errors, ${full ? warns.length : fresh.length} warnings; ${Object.keys(s.events).length} events, ${s.texts.length} texts, ${s.sfx.length} sounds, ${s.durationFrames} frames, ${known}${ms} ms`);
    if (sOld) {
      const i = impact(sOld, s);
      console.log(impactText(i));
      for (const line of await stillHolds(i.textChanged)) console.log(line);
    }
  } finally {
    if (old) await Deno.remove(old.replace(/\/film$/, ""), { recursive: true });
  }
  Deno.exit(errs.length ? 1 : 0);
} else if (cmd === "timeline") console.log(timelineMd(compile()));
else if (cmd === "at") {
  const s = compile(), q = rest[0];
  if (s.events[q]) console.log(JSON.stringify(s.events[q]));
  else {
    const f = resolveFrame(s, q), sc = s.scenes.find((x: any) => f >= x.startFrame && f < x.endFrame);
    const near = Object.values<any>(s.events).sort((a, b) => Math.abs(a.frame - f) - Math.abs(b.frame - f)).slice(0, 5).map((e) => `${e.id} (${e.frame - f >= 0 ? "+" : ""}${e.frame - f}f)`);
    const on = s.texts.filter((t: any) => t.scene === sc?.id).map((t: any) => t.id);
    console.log(`frame ${f} is in ${sc?.id} "${sc?.title}"; nearest events: ${near.join(", ")}; scene texts: ${on.join(", ")}`);
  }
} else if (cmd === "look") {
  const s = compile();
  // A bare event id shows the event landed: its reading floor when it has one, otherwise 20 frames in. A number or +Nf stays exact.
  const landed = (q: string) => {
    const e = s.events[q];
    if (!e || /^\d/.test(q)) return resolveFrame(s, q);
    const sc = s.scenes.find((x: any) => e.frame >= x.startFrame && e.frame < x.endFrame), f = s.events[`${q}.floor`]?.frame ?? e.frame + 20;
    return sc ? Math.min(f, sc.endFrame - 1) : f;
  };
  const dir = `${WORK}/look`; await Deno.mkdir(dir, { recursive: true });
  // `a..b` puts evenly spaced frames of a range on one image, since one frame cannot show which way something moved.
  const range = rest.find((q) => q.includes(".."));
  if (range) {
    const [a, b] = range.split("..");
    const fa = resolveFrame(s, a), fb = resolveFrame(s, b);
    if (fb <= fa) { console.error(`${range}: the end must come after the start (frames ${fa} and ${fb}).`); Deno.exit(1); }
    const n = Math.max(2, Math.min(12, parseInt(rest.find((q) => q.startsWith("--n="))?.slice(4) ?? "6") || 6));
    const picks = [...new Set(Array.from({ length: n }, (_, i) => Math.round(fa + (i * (fb - fa)) / (n - 1))))];
    const o = await render([`--stills=${picks.join(",")}`, `--out=${dir}`, "--timeout=120", "--nochecks"]);
    if (!o.success) { console.error(new TextDecoder().decode(o.stderr).slice(-1500)); Deno.exit(1); }
    const tmp = await Deno.makeTempDir({ dir, prefix: "sheet-" });
    for (const [i, f] of picks.entries()) await Deno.copyFile(`${dir}/${String(f).padStart(5, "0")}.png`, `${tmp}/${String(i).padStart(2, "0")}.png`);
    const fmt = s.film.formats[s.film.defaultFormat], cols = Math.min(3, picks.length), rows = Math.ceil(picks.length / cols);
    const out = `${dir}/sheet-${picks[0]}-${picks[picks.length - 1]}.png`;
    const ff = await new Deno.Command("ffmpeg", { args: ["-y", "-loglevel", "error", "-framerate", "1", "-i", `${tmp}/%02d.png`, "-vf", `scale=${fmt.w >= fmt.h ? 540 : 360}:-2,tile=${cols}x${rows}:padding=6:color=white`, "-frames:v", "1", "-update", "1", out], stdout: "piped", stderr: "piped" }).output();
    await Deno.remove(tmp, { recursive: true });
    if (!ff.success) { console.error(new TextDecoder().decode(ff.stderr).slice(-500)); Deno.exit(1); }
    console.log(`Sheet of ${picks.length} frames, left to right, then top to bottom: ${picks.join(", ")}. Read the PNG to see it. For one at full size: ./movas look <frame number>`);
    console.log(out);
    Deno.exit(0);
  }
  const frames = rest.map(landed);
  const o = await render([`--stills=${frames.join(",")}`, `--out=${dir}`, "--timeout=120", "--nochecks"]);
  if (!o.success) { console.error(new TextDecoder().decode(o.stderr).slice(-1500)); Deno.exit(1); }
  if (rest.some((q) => s.events[q] && !/^\d/.test(q))) console.log(`The frame shows the event landed. For its first frame: ./movas look <event>+0f`);
  for (const f of frames) console.log(`${dir}/${String(f).padStart(5, "0")}.png`);
} else if (cmd === "render") {
  // The shadow history's head and a dirty flag go into the manifest, so a file names the version it came from.
  await ensureHistory();
  const head = (await git("rev-parse", "--short=12", "--verify", "--quiet", "HEAD")).out.trim();
  const dirtyFlag = (await git("status", "--porcelain", "--", ...TRACKED)).out.trim() ? "1" : "0";
  const o = await render(["--timeout=600", `--shadow=${head}`, `--dirty=${dirtyFlag}`, ...rest]);
  const out = new TextDecoder().decode(o.stdout);
  console.log(out.slice(-1800));
  if (!o.success) { console.error(new TextDecoder().decode(o.stderr).slice(-1500)); Deno.exit(1); }
} else if (cmd === "report") {
  // What changed on screen since the last saved version, from a real plan pass with no pixels. --full prints every text.
  const full = rest.includes("--full"), flags = rest.filter((a) => a !== "--full");
  const planNow = await planFor(null, "now", flags);
  if (!planNow) { console.error("the plan pass did not run: fix the errors first (./movas check)"); Deno.exit(1); }
  const now = analyse(compile(), planNow);
  await ensureHistory();
  const head = (await git("rev-parse", "--short=12", "--verify", "--quiet", "HEAD")).out.trim();
  const known = readKnown();
  const rec = head && known?.versions?.[head]?.defects ? known.versions[head] : null;
  const mark = (_k: string, msg: string) => msg;
  const countsLine = (d: number, w: number, note = "") => `known issues: ${d} defects, ${w} warnings: ${KNOWN}${note}`;
  const listAll = (notes: string[]) => {
    const list = (m: Map<string, string>) => [...m].map(([k, msg]) => `${mark(k, msg)}   key: ${k}`);
    console.log([...notes, "## defects", ...list(now.defects), "", "## warnings", ...list(now.warns), "", "## texts", ...[...now.rows.values()].map((r) => r.line)].join("\n"));
    console.log(`${now.defects.size} defects, ${now.warns.size} warnings, ${now.rows.size} texts`);
    console.log(rec ? countsLine(Object.keys(rec.defects).length, Object.keys(rec.warnings).length) : countsLine(now.defects.size, now.warns.size, " (no record for this version: counts from the working tree)"));
  };
  if (full || !head) listAll([]);
  else {
    let base: any = null, note = "";
    if (rec) base = { defects: new Map<string, string>(Object.entries<string>(rec.defects)), warns: new Map<string, string>(Object.entries<string>(rec.warnings)), rows: new Map<string, any>(Object.entries<any>(rec.texts)) };
    else {
      const dir = await scoreAt(head), bp = await planFor(dir, "base", flags, true);
      if (bp) base = analyse(compile(dir), bp);
      await Deno.remove(dir.replace(/\/film$/, ""), { recursive: true });
      note = !bp ? `the saved version ${head} does not compile under the current rules, so there is no baseline: everything is listed.`
        : `${known ? `no known issues recorded for ${head}` : `no ${KNOWN}`}: the baseline is re-derived from the working programs (old behaviour).`;
    }
    if (!base) listAll([note]);
    else {
      const delta = (a: Map<string, string>, b: Map<string, string>) => [...a.keys()].filter((k) => !b.has(k));
      const newD = delta(now.defects, base.defects), goneD = delta(base.defects, now.defects), newW = delta(now.warns, base.warns), goneW = delta(base.warns, now.warns);
      const L: string[] = note ? [note] : [];
      L.push(`Against the last saved version: ${newD.length} new defects, ${goneD.length} gone, ${now.defects.size - newD.length} known. ${newW.length} new warnings, ${goneW.length} gone, ${now.warns.size - newW.length} known. --full lists everything.`);
      for (const k of newD) L.push(`NEW DEFECT ${mark(k, now.defects.get(k)!)}`);
      for (const k of goneD) L.push(`gone defect ${base.defects.get(k)}`);
      for (const k of newW) L.push(`new warning ${mark(k, now.warns.get(k)!)}`);
      for (const k of goneW) L.push(`gone warning ${base.warns.get(k)}`);
      const changed = [...now.rows.entries()].filter(([id, r]) => { const o = base.rows.get(id); return !o || o.text !== r.text || Math.abs(o.sec - r.sec) > 0.04 || Math.abs(o.px - r.px) > 0.5 || o.clipped !== r.clipped; });
      if (changed.length) L.push("Texts whose content, visible time or size changed:", ...changed.map(([id, r]) => { const o = base.rows.get(id); return r.line + (o ? `\t(was full ${o.sec.toFixed(2)}s)` : "\t(new)"); }));
      for (const id of base.rows.keys()) if (!now.rows.has(id)) L.push(`text removed: ${id}`);
      L.push(rec ? countsLine(Object.keys(rec.defects).length, Object.keys(rec.warnings).length) : countsLine(base.defects.size, base.warns.size));
      console.log(L.join("\n"));
    }
  }
  const md = await meaningDeltaLines(flags);
  console.log(md.lines.join("\n"));
} else if (cmd === "windows") {
  // Stability windows for `./movas verify`: every punch line, with land, floor and out from the compiled film, and an ROI from its groups' boxes at land plus 40 px.
  const s = compile(), c = await planFor(null, "windows", [], true);
  if (!c) { console.error("the plan pass did not run: fix the errors first (./movas check)"); Deno.exit(1); }
  const fmtDef = s.film.formats[s.film.defaultFormat], M = 40, windows: any[] = [];
  for (const sid of s.film.order) for (const l of s.film.scenes[sid]?.lines ?? []) {
    if (l.verb !== "punch" || !l.id) continue;
    const eid = `${sid}.${l.id}`, land = s.events[`${eid}.land`], floor = s.events[`${eid}.floor`], end = s.events[`${eid}.out`];
    const boxes: number[][] = Object.entries<any>(c.landBoxes ?? {}).filter(([k]) => k.startsWith(`${eid}.g`)).map(([, g]) => g.box);
    if (!land || !floor || !end || !boxes.length) { console.error(`skip ${eid}: no land, floor, out or group boxes`); continue; }
    const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1])), x1 = Math.max(...boxes.map((b) => b[2])), y1 = Math.max(...boxes.map((b) => b[3]));
    windows.push({ id: eid, land: land.frame, floor: floor.frame, out: end.frame, box: [Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1)], roi: [Math.max(0, Math.floor(x0 - M)), Math.min(fmtDef.w, Math.ceil(x1 + M)), Math.max(0, Math.floor(y0 - M)), Math.min(fmtDef.h, Math.ceil(y1 + M))] });
  }
  console.log(JSON.stringify({ durationFrames: s.durationFrames, fps: s.clock.fps, w: fmtDef.w, h: fmtDef.h, windows }, null, 1));
} else if (cmd === "compare") {
  // Same event, not same time: each version's own frame for the event id, shown side by side with the ref on the left.
  await ensureHistory();
  const [ref, ...ids] = rest;
  if (!ref || !ids.length) throw new Error("usage: ./movas compare <ref> <event>...");
  const old = await scoreAt(ref);
  try {
    const sOld = compile(old), sNow = compile();
    const pairs = ids.map((id) => {
      const a = sOld.events[id], b = sNow.events[id];
      if (!a) throw new Error(`no event ${id} in ${ref}`);
      if (!b) throw new Error(`no event ${id} in the working copy`);
      return { id, a: a.frame as number, b: b.frame as number };
    });
    await stills(old, pairs.map((p) => p.a), `${WORK}/compare/ref`);
    await stills(null, pairs.map((p) => p.b), `${WORK}/compare/now`);
    for (const p of pairs) {
      const out = `${WORK}/compare/${p.id}.png`;
      const x = await sh("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", `${WORK}/compare/ref/${String(p.a).padStart(5, "0")}.png`, "-i", `${WORK}/compare/now/${String(p.b).padStart(5, "0")}.png`, "-filter_complex", "hstack", "-frames:v", "1", out]);
      if (!x.ok) throw new Error(x.err.slice(0, 300));
      console.log(`${p.id}: ${ref} f${p.a}, now f${p.b}, ${out}`);
    }
  } finally { await Deno.remove(old.replace(/\/film$/, ""), { recursive: true }); }
} else if (cmd === "rebuild") {
  // Checks a saved version of the film out under .work, renders it with this tool and --nocache, and says whether the bytes equal --expect.
  await ensureHistory();
  const [ref, out, ...flags] = rest;
  if (!ref || !out) throw new Error("usage: ./movas rebuild <ref> <out> [--expect=sha256] [render flags]");
  const expect = flags.find((f) => f.startsWith("--expect="))?.slice("--expect=".length);
  const renderFlags = flags.filter((f) => !f.startsWith("--expect="));
  const commit = (await git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`)).out.trim();
  if (!commit) throw new Error(`no saved version ${ref}`);
  const dir = `${WORK}/rebuild/${commit.slice(0, 12)}`;
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  await Deno.mkdir(dir, { recursive: true });
  await archiveTo(commit, TRACKED, dir);
  const outAbs = out.startsWith("/") ? out : `${Deno.cwd()}/${out}`;
  const t0 = performance.now();
  const o = await new Deno.Command(`${HERE}/render.sh`, { args: [`--port=${PORT}`, `--dbg=${DBG}`, `--work=${WORK}`, `--public=${PUBLIC}`, "--nocache", "--timeout=600", `--out=${outAbs}`, ...renderFlags], cwd: dir, stdout: "piped", stderr: "piped", env: { MOVAS_WORK: WORK, MOVAS_FILM: dir } }).output();
  const secs = (performance.now() - t0) / 1000;
  if (!o.success) { console.error(new TextDecoder().decode(o.stderr).slice(-1500)); Deno.exit(1); }
  const got = await sha256File(outAbs);
  console.log(`rebuilt ${commit.slice(0, 12)} in ${secs.toFixed(1)} s: ${outAbs} sha256 ${got}`);
  if (expect !== undefined) {
    if (got === expect) console.log("MATCH: the bytes equal --expect.");
    else { console.log(`DIFFER: expected ${expect}.`); Deno.exit(1); }
  }
} else if (cmd === "doctor") {
  Deno.exit(await doctor(rest));
} else if (cmd === "probe") {
  // Writes film/probe.json: the length and size of every vo and clip file, read from the file. Clips also get their frames extracted.
  const film = loadFilm(FILM), out: Record<string, any> = {};
  const used = Object.values<any>(film.scenes).flatMap((sc: any) => sc.lines.filter((l: any) => (l.verb === "vo" || l.verb === "clip") && l.kv.file).map((l: any) => [l.verb, l.kv.file]));
  for (const [verb, file] of used as [string, string][]) {
    const full = `${PUBLIC}/${file}`, o = await sh("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate,codec_type", "-of", "json", full]);
    if (!o.ok) { console.error(`cannot read ${full}: ${o.err.slice(0, 200)}`); Deno.exit(1); }
    const j = JSON.parse(o.out), v = j.streams.find((x: any) => x.codec_type === "video");
    const e: any = { duration: parseFloat(j.format.duration) };
    if (v) {
      const [a, b] = v.r_frame_rate.split("/").map(Number);
      e.w = v.width; e.h = v.height; e.fps = a / (b || 1);
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await Deno.readFile(full)))].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
      const dir = `${WORK}/frames/${hash}`; e.frames = `/frames/${hash}`;
      try { await Deno.stat(`${dir}/00001.jpg`); } catch {
        await Deno.mkdir(dir, { recursive: true });
        const x = await sh("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", full, "-q:v", "2", "-fps_mode", "passthrough", `${dir}/%05d.jpg`]);
        if (!x.ok) { console.error(x.err.slice(0, 300)); Deno.exit(1); }
      }
    }
    out[file] = e;
  }
  Deno.writeTextFileSync(`${FILM}/probe.json`, JSON.stringify(out, null, 1));
  console.log(`probe.json: ${Object.keys(out).length} files, ${Object.values<any>(out).reduce((n, e) => n + e.duration, 0).toFixed(2)} s in all`);
} else if (cmd === "save") {
  const t0 = performance.now(), id = await save(rest.join(" ") || "save");
  console.log(`${id}   saved with its known issues in ${((performance.now() - t0) / 1000).toFixed(1)} s (${KNOWN})`);
}
else if (cmd === "log") { await ensureHistory(); console.log((await git("log", "--format=%h %cI %s", "-n", "20")).out.trim()); }
else if (cmd === "undo") {
  await ensureHistory();
  // The film, programs included, goes back to the last saved version. Uncommitted work is saved first, so undo cannot lose it.
  const keep = await save("autosave before undo");
  const r = await git("checkout", `${keep}~1`, "--", "film");
  if (!r.ok) throw new Error(r.err);
  console.log(`film is back at ${keep}~1, programs included. The undone state is ${keep}.`);
} else if (cmd === "diff") {
  await ensureHistory();
  const [a = "HEAD", b] = rest, da = await scoreAt(a), db = b ? await scoreAt(b) : FILM;
  console.log(impactText(impact(compile(da), compile(db))));
} else if (cmd === "options") {
  console.error("options is now ./movas do <scene>.<id> --why");
  Deno.exit(2);
} else if (cmd === "do" && rest.includes("--why")) {
  // The choices for one line, each with its cost against the saved version, ranked. Nothing changes unless --take= picks one. The logic is in options.ts.
  const { options } = await import("./options.ts");
  Deno.exit(await options(rest.filter((a) => a !== "--why"), { FILM, WORK, PUBLIC, hasSaved: async () => { await ensureHistory(); return (await git("rev-parse", "--verify", "--quiet", "HEAD")).ok; }, scoreAt, planFor, analyse }));
} else if (cmd === "film") {
  // The film as text: outline, meaning facts, motion, sound, claims. No model. --file= names the encoded film, otherwise the last preview. --section=outline,flags,facts,motion,sound,ledger.
  const { buildReport, readScan } = await import("./film.ts");
  const { MeaningError, readMeaning } = await import("./rules.ts");
  let meaning: any;
  try { meaning = readMeaning(FILM, `${HERE}/tool`); } catch (e) { if (e instanceof MeaningError) { console.error(`film/meaning.txt or a pack it names: ${e.message}`); Deno.exit(2); } throw e; }
  const opt = (k: string) => rest.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const s = compile(), errs = s.problems.filter((p: any) => p.level === "error");
  if (errs.length) { console.error("the film has errors: run ./movas check first"); Deno.exit(1); }
  const key = await planKey(null), scan = `${WORK}/film-scan-${key}.jsonl`, checksPath = `${WORK}/film-checks-${key}.json`;
  await Deno.mkdir(WORK, { recursive: true });
  try { await Deno.stat(scan); } catch {
    const o = await render(["--planOnly", `--scanOut=${scan}.tmp`, `--checksOut=${checksPath}`, "--timeout=180"]);
    if (!o.success) { await Deno.remove(`${scan}.tmp`).catch(() => {}); console.error(new TextDecoder().decode(o.stderr).slice(-1500)); Deno.exit(1); }
    await Deno.rename(`${scan}.tmp`, scan);
  }
  const fm = s.film.formats[s.film.defaultFormat], file = opt("file") ?? `${WORK}/out/preview.mp4`;
  let px: any = null;
  if (!rest.includes("--nofile")) {
    let fileOk = false; try { await Deno.stat(file); fileOk = true; } catch { /* none yet */ }
    if (fileOk) {
      const spec = { fps: s.clock.fps, scenes: s.scenes.map((x: any) => ({ id: x.id, from: x.startFrame, to: x.endFrame })), sfx: s.sfx.map((x: any) => ({ frame: x.frame, cls: x.cls, file: x.file })), ...(s.clock.isBeat ? { beat: { first: s.clock.first, fpb: s.clock.fpb, perBar: s.clock.beatsPerBar } } : {}) };
      const pxKey = (await sha256Hex(new TextEncoder().encode(JSON.stringify(spec) + await sha256File(file) + await sha256File(`${HERE}/tool/film_px.py`)))).slice(0, 24), out = `${WORK}/film-px-${pxKey}.json`;
      try { await Deno.stat(out); } catch {
        const specPath = `${out}.spec`; Deno.writeTextFileSync(specPath, JSON.stringify(spec));
        const r = await sh("python3", ["-B", `${HERE}/tool/film_px.py`, file, `--spec=${specPath}`, `--out=${out}`]);
        if (!r.ok) { console.error(`pixel and sound pass failed: ${r.err.slice(-600)}`); Deno.exit(1); }
      }
      px = JSON.parse(Deno.readTextFileSync(out));
    }
  }
  const sections = new Set((opt("section") ?? "all").split(","));
  const text = buildReport({ s, checks: JSON.parse(Deno.readTextFileSync(checksPath)), rows: readScan(scan), meaning, px, sections, W: fm.w, H: fm.h });
  console.log(text);
  console.error(`film report: ${text.length} characters, about ${Math.round(text.length / 3.5)} tokens by characters over 3.5.`);
} else if (cmd === "do") {
  const { doCmd } = await import("./do.ts");
  Deno.exit(await doCmd(rest, { HERE: ROOT, TOOL: HERE, FILM, WORK, PUBLIC, PORT, render, planFor, planError: () => planWhy, analyse, compile, readDirection, readKnown, git, ensureHistory, pictureNow: () => planFor(null, "pic0", [], true), meaningDelta: () => meaningDeltaLines([]) }));
} else console.log("usage: movas brief [scene] | help [scene|programs|rules] | check [--full] | report | probe | timeline | at <q> | look <q>... | render | save <msg> | log | undo | diff <a> [b] | do <scene>.<id> [words|key=value|--why] | compare <ref> <event>... | rebuild <ref> <out> [--expect=sha256] | doctor [--freeze|--restore] | windows | film [--section=] [--file=] | leak | test-rules | test-ops");
