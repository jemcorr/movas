// The rule language of `./movas film`. One parser and one evaluator serve all three layers: craft (always on), format packs (a film opts in) and a film's own rules.
// A rule never passes by silence. Each selected line ends as pass, miss or cannot-check, and every refusal is printed and counted.

export class MeaningError extends Error {}

export type Term = { key: string; op: "=" | "!=" | ">=" | "<=" | "~" | "!~"; vals: string[]; num: number; re: RegExp | null; raw: string };
export type Anchor = "at" | "first" | "last";
export type Link = { same: string[]; before: Anchor | null; after: Anchor | null; during: boolean; grace: number; within: number | null };
export type Rule = { id: string; kind: "expect" | "forbid" | "need"; where: Term[]; terms: Term[]; link: Link; say: string; note: string; from: string };
export type Alike = { id: string; a: Term[]; b: Term[]; say: string; note: string; from: string };
export type Exempt = { rule: string; where: Term[]; say: string; from: string };
export type Limit = { value: number; note: string; from: string };
export type FactLine = { name: string; key: string; value: string; result: string; from: string };
export type Meaning = {
  rules: Rule[]; alikes: Alike[]; exempts: Exempt[]; limits: Map<string, Limit>; words: Map<string, RegExp>; facts: FactLine[]; claims: Term[] | null; packs: string[];
};

/** Facts every line has, whatever its verb. A bare key that is not in this list and not a `fact` name reads the score line's own key=value. */
export const FIXED_FACTS = ["verb", "id", "scene", "text", "words", "panel", "speaker", "at", "first", "last", "seen", "full", "need", "read_ratio", "clip_frames"];
export const DRAWN_FACTS = ["align", "family", "fill", "ink", "inkFamily", "contrast", "px", "text", "boxed", "inPanel"];
export const SCENE_FACTS = ["words_cut", "jitter_elements", "spikes", "flow_jitter", "group_snap"];
export const FILM_FACTS = ["clip_samples", "silence_s", "cue_lag_frames", "bed_off_ms"];

// ---------- parsing ----------
const FORMS = 'Lines: use <pack>; limit <name> <number> [note="..."]; words <name> /regex/flags; fact <name> <key>=<value> <result>; rule <id> where <terms> expect|forbid|need <terms> [links] [say="..."] [note="..."]; alike <id> <terms> vs <terms> [say="..."] [note="..."]; exempt <rule> where <terms> [say="..."]; off <rule>; claims where <terms>; verb <name> ... (tool format packs only)';

/** Splits a line on spaces. A "quoted" part and a /regex/flags part keep their spaces. */
export const tokens = (line: string, where: string): string[] => {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && line[i] === " ") i++;
    if (i >= line.length) break;
    let t = "";
    while (i < line.length && line[i] !== " ") {
      const c = line[i];
      if (c === '"') {
        const j = line.indexOf('"', i + 1);
        if (j < 0) throw new MeaningError(`${where}: a quote is not closed`);
        t += line.slice(i, j + 1); i = j + 1;
      } else if (c === "/" && (t === "" || t.endsWith("~"))) {
        let j = i + 1;
        while (j < line.length && (line[j] !== "/" || line[j - 1] === "\\")) j++;
        if (j >= line.length) throw new MeaningError(`${where}: a /regex/ is not closed`);
        j++;
        while (j < line.length && /[a-z]/.test(line[j])) j++;
        t += line.slice(i, j); i = j;
      } else { t += c; i++; }
    }
    out.push(t);
  }
  return out;
};
const regexOf = (s: string, where: string, extra = ""): RegExp => {
  const m = /^\/(.*)\/([a-z]*)$/.exec(s);
  if (!m) throw new MeaningError(`${where}: expected /regex/flags, got ${s}`);
  try { return new RegExp(m[1], [...new Set(m[2] + "u" + extra)].join("")); } catch (e) { throw new MeaningError(`${where}: bad regex ${s}: ${(e as Error).message}`); }
};
const termOf = (tok: string, where: string): Term => {
  const m = /^([A-Za-z_][\w.]*)(!=|>=|<=|!~|=|~)(.*)$/.exec(tok);
  if (!m) throw new MeaningError(`${where}: cannot read the term "${tok}". A term is key=a|b, key!=a|b, key>=n, key<=n, key~/re/flags or key!~/re/flags.`);
  const [, key, op, val] = m, t: Term = { key, op: op as Term["op"], vals: [], num: NaN, re: null, raw: tok };
  if (op === "~" || op === "!~") t.re = regexOf(val, where);
  else if (op === ">=" || op === "<=") { t.num = parseFloat(val); if (Number.isNaN(t.num)) throw new MeaningError(`${where}: "${tok}" needs a number`); }
  else t.vals = val.split("|");
  return t;
};
const seconds = (tok: string, where: string): number => {
  const m = /^(\d+(?:\.\d+)?)s$/.exec(tok);
  if (!m) throw new MeaningError(`${where}: expected seconds such as 2s, got ${tok}`);
  return parseFloat(m[1]);
};
const noLink = (): Link => ({ same: [], before: null, after: null, during: false, grace: 0, within: null });
/** Link names. A forbid or need rule reads them; anywhere else they are an error, so a link never turns into a fact term. */
const LINK = /^(?:(same|before|after|grace|within)=|during$)/;
/** The tail of a rule: terms and links, then say= and note=. */
const tailOf = (toks: string[], where: string, links: boolean) => {
  const terms: Term[] = [], link = noLink();
  let say = "", note = "";
  for (const t of toks) {
    if (t.startsWith('say="')) { say = t.slice(5, -1); continue; }
    if (t.startsWith('note="')) { note = t.slice(6, -1); continue; }
    if (links) {
      if (t.startsWith("same=")) {
        link.same = t.slice(5).split(",");
        for (const s of link.same) if (!["panel", "scene", "speaker", "text"].includes(s)) throw new MeaningError(`${where}: same= takes panel, scene, speaker or text, got ${s}`);
        continue;
      }
      if (t.startsWith("before=") || t.startsWith("after=")) {
        const [k, a] = t.split("=");
        if (a !== "at" && a !== "first" && a !== "last") throw new MeaningError(`${where}: ${k}= takes at, first or last, got ${a}`);
        link[k as "before" | "after"] = a;
        continue;
      }
      if (t === "during") { link.during = true; continue; }
      if (t.startsWith("grace=")) { link.grace = seconds(t.slice(6), where); continue; }
      if (t.startsWith("within=")) { link.within = seconds(t.slice(7), where); continue; }
    }
    if (LINK.test(t)) throw new MeaningError(`${where}: ${t} is a link. Links (same=, before=, after=, during, grace=, within=) belong to forbid and need rules.`);
    const like = /^([A-Za-z_]+)=\d+(?:\.\d+)?s$/.exec(t);
    if (like) throw new MeaningError(`${where}: ${t} reads as a link, and there is no link ${like[1]}=. Links are same=, before=, after=, during, grace= and within=.`);
    terms.push(termOf(t, where));
  }
  if (link.within !== null && !link.before && !link.after) throw new MeaningError(`${where}: within= needs before= or after=, the moment it counts from.`);
  return { terms, link, say, note };
};

/** Reads film/meaning.txt with the packs it names, on top of the craft pack. A film's own lines win over any pack's, and a later pack wins over an earlier one. */
export const readMeaning = (filmDir: string, toolDir: string): Meaning => {
  const M: Meaning = { rules: [], alikes: [], exempts: [], limits: new Map(), words: new Map(), facts: [], claims: null, packs: [] };
  // Every rule and alike id any file declared, and the file:line of each rule, alike and exempt, for the errors after the merge.
  const declared = new Set<string>(), lineOf = new Map<object, string>();
  const putRule = (r: Rule) => { M.rules = M.rules.filter((x) => x.id !== r.id); M.rules.push(r); declared.add(r.id); };
  const packPath = (name: string) => {
    for (const dir of [`${filmDir}/packs`, `${toolDir}/packs`]) { const p = `${dir}/${name}.meaning`; try { Deno.statSync(p); return { p, own: dir !== `${toolDir}/packs` }; } catch { /* next */ } }
    return null;
  };
  const eat = (text: string, from: string, isFormatFile: boolean, phase: "packs" | "own") => {
    text.split("\n").forEach((raw, n) => {
      const l = raw.trim(), where = `${from}:${n + 1}`;
      if (!l || l.startsWith("#")) return;
      const toks = tokens(l, where), head = toks[0];
      if (head === "use") {
        if (toks.length !== 2) throw new MeaningError(`${where}: use takes one pack name`);
        if (phase === "own" && from.startsWith("film/")) return; // film/meaning.txt names its packs in the first pass.
        const name = toks[1];
        if (M.packs.includes(name)) return;
        const found = packPath(name);
        if (!found) throw new MeaningError(`${where}: no pack ${name}. Looked in film/packs/${name}.meaning and tool/packs/${name}.meaning.`);
        M.packs.push(name);
        eat(Deno.readTextFileSync(found.p), found.own ? `film/packs/${name}.meaning` : `pack ${name}`, !found.own, "packs");
        return;
      }
      if (phase === "packs" && from === "film/meaning.txt") return; // A film's own lines come after every pack.
      if (head === "verb") { if (!isFormatFile) throw new MeaningError(`${where}: verb lines belong to a format pack in tool/packs. ${FORMS}`); return; }
      if (head === "limit") {
        const value = parseFloat(toks[2]);
        if (toks.length < 3 || Number.isNaN(value)) throw new MeaningError(`${where}: limit takes a name and a number`);
        const note = toks.find((t) => t.startsWith('note="'))?.slice(6, -1) ?? "";
        M.limits.set(toks[1], { value, note, from });
      } else if (head === "words") {
        if (toks.length !== 3) throw new MeaningError(`${where}: words takes a name and a /regex/`);
        M.words.set(toks[1], regexOf(toks[2], where, "g"));
      } else if (head === "fact") {
        const m = toks.length === 4 ? /^([\w.]+)=(.+)$/.exec(toks[2]) : null;
        if (!m) throw new MeaningError(`${where}: fact takes a name, key=value and a result, as in: fact role side=out sent`);
        M.facts = M.facts.filter((x) => !(x.name === toks[1] && x.key === m[1] && x.value === m[2]));
        M.facts.push({ name: toks[1], key: m[1], value: m[2], result: toks[3], from });
      } else if (head === "off") {
        if (toks.length !== 2) throw new MeaningError(`${where}: off takes one rule id`);
        // off acts here, in file order: a rule the same film declares again after it stays.
        if (!M.rules.some((x) => x.id === toks[1]) && !M.alikes.some((x) => x.id === toks[1])) throw new MeaningError(`${where}: off ${toks[1]}: no rule or alike ${toks[1]} is declared before this line.`);
        M.rules = M.rules.filter((x) => x.id !== toks[1]);
        M.alikes = M.alikes.filter((x) => x.id !== toks[1]);
      } else if (head === "claims") {
        if (toks[1] !== "where") throw new MeaningError(`${where}: claims where <terms>`);
        M.claims = toks.slice(2).map((t) => termOf(t, where));
      } else if (head === "exempt") {
        if (toks[2] !== "where") throw new MeaningError(`${where}: exempt <rule> where <terms> [say="..."]`);
        const tail = tailOf(toks.slice(3), where, false);
        M.exempts.push({ rule: toks[1], where: tail.terms, say: tail.say, from });
        lineOf.set(M.exempts[M.exempts.length - 1], where);
      } else if (head === "alike") {
        const vs = toks.indexOf("vs");
        if (vs < 3) throw new MeaningError(`${where}: alike <id> <terms> vs <terms> [say="..."] [note="..."]`);
        const tail = tailOf(toks.slice(vs + 1), where, false);
        M.alikes = M.alikes.filter((x) => x.id !== toks[1]);
        M.alikes.push({ id: toks[1], a: toks.slice(2, vs).map((t) => termOf(t, where)), b: tail.terms, say: tail.say, note: tail.note, from });
        declared.add(toks[1]); lineOf.set(M.alikes[M.alikes.length - 1], where);
      } else if (head === "rule") {
        const w = toks[2] === "where" ? 3 : -1;
        const kindAt = toks.findIndex((t) => t === "expect" || t === "forbid" || t === "need");
        if (w < 0 || kindAt <= w) throw new MeaningError(`${where}: cannot read this rule. Write: rule <id> where <terms> expect|forbid|need <terms> [links] [say="..."] [note="..."].`);
        const kind = toks[kindAt] as Rule["kind"], tail = tailOf(toks.slice(kindAt + 1), where, kind !== "expect");
        if (!tail.terms.length) throw new MeaningError(`${where}: ${kind} needs at least one term`);
        putRule({ id: toks[1], kind, where: toks.slice(w, kindAt).map((t) => termOf(t, where)), terms: tail.terms, link: tail.link, say: tail.say, note: tail.note, from });
        lineOf.set(M.rules[M.rules.length - 1], where);
      } else if (head === "tension") throw new MeaningError(`${where}: tension is gone. Write it as a rule with forbid or need, which can scope to a panel and a moment. ${FORMS}`);
      else throw new MeaningError(`${where}: cannot read "${l}". ${FORMS}`);
    });
  };
  eat(Deno.readTextFileSync(`${toolDir}/packs/craft.meaning`), "pack craft", true, "packs");
  let own = "";
  try { own = Deno.readTextFileSync(`${filmDir}/meaning.txt`); } catch (e) { if (!(e instanceof Deno.errors.NotFound)) throw e; }
  eat(own, "film/meaning.txt", false, "packs");
  eat(own, "film/meaning.txt", false, "own");
  for (const e of M.exempts) if (!declared.has(e.rule)) throw new MeaningError(`${lineOf.get(e)}: exempt ${e.rule}: no file declares a rule ${e.rule}.`);
  // Every count.<list> names a declared word list, and every drawn.<x> a real drawn fact. A typo must not read as "no line matched".
  const check = (t: Term, from: string) => {
    if (t.key.startsWith("count.") && !M.words.has(t.key.slice(6))) throw new MeaningError(`${from}: ${t.raw} names no words line. Declared: ${[...M.words.keys()].join(", ") || "none"}.`);
    if (t.key.startsWith("drawn.") && !DRAWN_FACTS.includes(t.key.slice(6))) throw new MeaningError(`${from}: ${t.raw}: drawn facts are ${DRAWN_FACTS.join(", ")}.`);
  };
  for (const r of M.rules) for (const t of [...r.where, ...r.terms]) check(t, `${lineOf.get(r)}: rule ${r.id}`);
  for (const r of M.alikes) for (const t of [...r.a, ...r.b]) check(t, `${lineOf.get(r)}: alike ${r.id}`);
  for (const r of M.exempts) for (const t of r.where) check(t, `${lineOf.get(r)}: exempt ${r.rule}`);
  // {name} in a say text is the limit's value, and {name%} the value as a percent, so the words follow a film's own limit.
  const fill = (say: string, from: string) => say.replace(/\{([\w.]+)(%?)\}/g, (_, name: string, pct: string) => {
    const l = M.limits.get(name);
    if (!l) throw new MeaningError(`${from}: say names {${name}}, and no limit ${name} is declared.`);
    return pct ? `${Math.round(l.value * 100)}%` : String(l.value);
  });
  for (const r of M.rules) r.say = fill(r.say, `${lineOf.get(r)}: rule ${r.id}`);
  for (const r of M.alikes) r.say = fill(r.say, `${lineOf.get(r)}: alike ${r.id}`);
  return M;
};
/** A limit from the merged files. A name no file declares is a bug in the tool, so it throws. */
export const limitOf = (M: Meaning, name: string): number => {
  const l = M.limits.get(name);
  if (!l) throw new MeaningError(`no limit ${name}: tool/packs/craft.meaning must declare it`);
  return l.value;
};

// ---------- lines ----------
export type TextRun = { text: string; ink: string; first: number; last: number };
export type Row = {
  id: string; scene: string; verb: string; text: string; words: number; kv: Record<string, string>; at: number;
  first?: number; last?: number; full?: number; read?: number; drawn?: Record<string, any>; legible?: number; clip?: number;
  runs?: TextRun[]; panel?: string | null; panelWhy?: string; facts?: Record<string, number | null>; partial?: Record<string, string>; details?: Record<string, string>;
};
type Got = { state: "value"; value: string | number } | { state: "absent" } | { state: "unknown"; why: string };
const VALUE = (value: string | number): Got => ({ state: "value", value }), ABSENT: Got = { state: "absent" };
const UNKNOWN = (why: string): Got => ({ state: "unknown", why });
const plainText = (s: string) => s.replace(/\*/g, "").replace(/\s+\/\s+/g, " ").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
const normal = (s: string) => plainText(s).toLowerCase();
const notDrawn = (r: Row) => r.runs?.length ? "it is drawn but never at full opacity, so its box was not read" : "the display list has no element with its id";

/** One fact of one line. A fact the film has no way to give is unknown, which is a refusal and never a pass. */
/** A measured number for a reader: at most 2 decimals. The comparison uses the full value. */
const num2 = (s: string) => /^-?\d+\.\d{3,}$/.test(s) ? String(Math.round(parseFloat(s) * 100) / 100) : s;
export const readFact = (M: Meaning, r: Row, key: string, fps: number): Got => {
  if (r.verb === "scene" || r.verb === "film") {
    if (key === "verb") return VALUE(r.verb);
    if (key === "id" || key === "scene") return VALUE(r.id);
    const list = r.verb === "scene" ? SCENE_FACTS : FILM_FACTS;
    if (!list.includes(key)) return ABSENT;
    const v = r.facts?.[key];
    return v === null || v === undefined ? UNKNOWN(r.details?.[`${key}.why`] ?? "no encoded file was given, so this was not measured") : VALUE(v);
  }
  switch (key) {
    case "verb": return VALUE(r.verb);
    case "id": return VALUE(r.id);
    case "scene": return VALUE(r.scene);
    case "text": return VALUE(plainText(r.text));
    case "words": return VALUE(r.words);
    case "panel": return r.panel === undefined ? UNKNOWN(r.panelWhy ?? "its panel is not known") : r.panel === null ? ABSENT : VALUE(r.panel);
    case "speaker": { const v = r.kv?.speaker ?? r.kv?.side; return v === undefined ? ABSENT : VALUE(v); }
    case "at": return VALUE(r.at / fps);
    case "first": return r.first === undefined ? UNKNOWN(notDrawn(r)) : VALUE(r.first / fps);
    case "last": return r.last === undefined ? UNKNOWN(notDrawn(r)) : VALUE(r.last / fps);
    case "seen": return r.first === undefined ? UNKNOWN(notDrawn(r)) : VALUE((r.last! - r.first + 1) / fps);
    case "full": return r.first === undefined ? UNKNOWN(notDrawn(r)) : VALUE((r.full ?? 0) / fps);
    case "need": return r.read === undefined ? ABSENT : VALUE(r.read);
    case "read_ratio": return r.first === undefined || !r.read ? UNKNOWN(notDrawn(r)) : VALUE(Math.round(((r.legible ?? 0) / fps / r.read) * 100) / 100);
    case "clip_frames": return r.first === undefined ? UNKNOWN(notDrawn(r)) : VALUE(r.clip ?? 0);
  }
  if (key.startsWith("count.")) {
    const re = M.words.get(key.slice(6))!;
    return VALUE(new Set([...plainText(r.text).matchAll(re)].map((x) => x[0].toLowerCase())).size);
  }
  if (key === "drawn.text") return r.runs?.length ? VALUE(r.runs.map((x) => x.text).join(" | ")) : UNKNOWN(notDrawn(r));
  if (key.startsWith("drawn.")) {
    if (!r.drawn) return UNKNOWN(notDrawn(r));
    const v = r.drawn[key.slice(6)];
    return v === undefined || v === null ? ABSENT : VALUE(v);
  }
  const fact = M.facts.filter((x) => x.name === key);
  if (fact.length) {
    const hit = fact.find((x) => String(r.kv?.[x.key]) === x.value);
    if (hit) return VALUE(hit.result);
    const keys = [...new Set(fact.map((x) => x.key))], has = keys.find((k) => r.kv?.[k] !== undefined);
    return has ? UNKNOWN(`${has}=${r.kv[has]} has no ${key}. Add: fact ${key} ${has}=${r.kv[has]} <value>`) : ABSENT;
  }
  const v = r.kv?.[key];
  return v === undefined ? ABSENT : VALUE(v);
};
type Tri = { ok: boolean | null; why?: string; got?: string };
const compare = (t: Term, g: Got): Tri => {
  if (g.state === "unknown") return { ok: null, why: g.why };
  if (g.state === "absent") return { ok: t.op === "!=" || t.op === "!~", got: "none" };
  const s = String(g.value);
  switch (t.op) {
    case "=": return { ok: t.vals.includes(s), got: s };
    case "!=": return { ok: !t.vals.includes(s), got: s };
    case ">=": return { ok: parseFloat(s) >= t.num, got: num2(s) };
    case "<=": return { ok: parseFloat(s) <= t.num, got: num2(s) };
    case "~": t.re!.lastIndex = 0; return { ok: t.re!.test(s), got: s };
    case "!~": t.re!.lastIndex = 0; return { ok: !t.re!.test(s), got: s };
  }
};
/** The moment a line's chosen state holds. `drawn.text~/re/` narrows first and last to the runs whose words match, which is how a rule reads a label's value over time. */
const windowOf = (terms: Term[], r: Row): { first?: number; last?: number } => {
  const t = terms.find((x) => x.key === "drawn.text" && x.op === "~");
  if (!t || !r.runs?.length) return { first: r.first, last: r.last };
  const hit = r.runs.filter((x) => { t.re!.lastIndex = 0; return t.re!.test(x.text); });
  return hit.length ? { first: hit[0].first, last: hit[hit.length - 1].last } : { first: r.first, last: r.last };
};
const termOn = (M: Meaning, t: Term, r: Row, fps: number): Tri => {
  // A drawn.text term on a line with no drawn id falls back on the score's words: a match there is a refusal, no match is a plain no.
  if (t.key === "drawn.text" && !r.runs?.length) {
    const declared = `${r.text} ${r.kv?.flip ?? ""}`;
    t.re!.lastIndex = 0;
    const hit = t.re!.test(declared);
    if (t.op === "~") return hit ? { ok: null, why: notDrawn(r) } : { ok: false, got: "not drawn" };
    return { ok: null, why: notDrawn(r) };
  }
  if (t.key === "drawn.text" && t.op === "~") {
    const hit = r.runs!.filter((x) => { t.re!.lastIndex = 0; return t.re!.test(x.text); });
    // Words that hold two colours for 15 frames or more can be a lit and an unlit step of a scale, so the words alone do not say when the value holds. A short fade from one colour to another is one state.
    const held = new Map<string, number>();
    for (const x of hit) held.set(x.ink, (held.get(x.ink) ?? 0) + x.last - x.first + 1);
    if ([...held.values()].filter((n) => n >= 15).length > 1) return { ok: null, why: `its words "${hit[0].text}" stay on screen in two colours, so the words alone do not say when that value holds` };
    return { ok: hit.length > 0, got: r.runs!.map((x) => x.text).join(" | ") };
  }
  return compare(t, readFact(M, r, t.key, fps));
};
export const allOf = (M: Meaning, terms: Term[], r: Row, fps: number): Tri => {
  let why: string | undefined;
  for (const t of terms) { const x = termOn(M, t, r, fps); if (x.ok === false) return { ok: false }; if (x.ok === null) why ??= x.why; }
  return why ? { ok: null, why } : { ok: true };
};

// ---------- panels ----------
type Item = { k: string; id: string | null; tx?: string; c?: string | null; b: number[]; a: number; v: number };
const alphaOf = (c: string | null | undefined) => { const m = /^rgba?\(([^)]+)\)$/.exec((c ?? "").trim()); if (m) return parseFloat(m[1].split(",")[3] ?? "1"); const h = /^#[0-9a-f]{8}$/i.exec((c ?? "").trim()); return h ? parseInt(h[0].slice(7), 16) / 255 : 1; };
const inBox = (o: number[], x: number, y: number) => x >= o[0] && x <= o[2] && y >= o[1] && y <= o[3];
/** Gives every line its panel: `in=`, then `on=`, then the scene's only panel, then the panel whose drawn box holds the line. A panel name that runs through consecutive scenes is one conversation. With several panels and no box the panel stays unknown, which is a refusal. */
export const assignPanels = (rows: Row[], frames: Map<number, Item[]>, sceneIds: string[], declaredPanels: Record<string, Record<string, unknown>>, W: number, H: number) => {
  const names = new Map<string, Set<string>>(sceneIds.map((s) => [s, new Set(Object.keys(declaredPanels?.[s] ?? {}))]));
  for (const r of rows) if (r.kv?.in !== undefined) names.get(r.scene)?.add(r.kv.in);
  const inst = new Map<string, string>(); // scene|name -> panel identity
  sceneIds.forEach((s, i) => { for (const n of names.get(s) ?? []) { const prev = i > 0 ? inst.get(`${sceneIds[i - 1]}|${n}`) : undefined; inst.set(`${s}|${n}`, prev ?? `${n}@${s}`); } });
  const boxOf = (scene: string, name: string, f: number): number[] | null => {
    const items = frames.get(f) ?? [];
    const own = items.find((x) => x.k === "r" && x.id?.endsWith(`.${name}.bg`));
    if (own) return own.b;
    let best: number[] | null = null, bestA = 0;
    for (const m of rows) {
      if (m.scene !== scene || m.kv?.in !== name) continue;
      const idx = items.findIndex((x) => x.k === "t" && x.id === m.id);
      if (idx < 0) continue;
      const t = items[idx];
      for (let j = idx - 1; j >= 0; j--) {
        const o = items[j];
        if (o.k !== "r" || alphaOf(o.c) <= 0.3) continue;
        if (!(o.b[0] - 4 <= t.b[0] && o.b[1] - 4 <= t.b[1] && o.b[2] + 4 >= t.b[2] && o.b[3] + 4 >= t.b[3])) continue;
        const a = (o.b[2] - o.b[0]) * (o.b[3] - o.b[1]);
        if (a < 0.75 * W * H && a > bestA) { bestA = a; best = o.b; }
      }
    }
    return best;
  };
  for (const r of rows) {
    if (r.verb === "scene" || r.verb === "film") { r.panel = null; continue; }
    const set = names.get(r.scene) ?? new Set<string>();
    const declared = r.kv?.in ?? r.kv?.on;
    if (declared !== undefined) { r.panel = inst.get(`${r.scene}|${declared}`) ?? `${declared}@${r.scene}`; continue; }
    if (set.size === 0) { r.panel = null; continue; }
    if (set.size === 1) { r.panel = inst.get(`${r.scene}|${[...set][0]}`)!; continue; }
    r.panel = undefined;
    if (!r.runs?.length) { r.panelWhy = `${set.size} panels in ${r.scene}, no on= on the line, and the display list has no element with its id`; continue; }
    const a = r.runs[0].first, z = r.runs[r.runs.length - 1].last, samples = [a, a + 15, Math.round((a + z) / 2), z];
    for (const f of samples) {
      const it = (frames.get(f) ?? []).find((x) => x.k === "t" && (x.id === r.id || x.id?.startsWith(`${r.id}.`)));
      if (!it) continue;
      const cx = (it.b[0] + it.b[2]) / 2, cy = (it.b[1] + it.b[3]) / 2;
      const holders = [...set].filter((n) => { const b = boxOf(r.scene, n, f); return b && inBox(b, cx, cy); });
      if (holders.length === 1) { r.panel = inst.get(`${r.scene}|${holders[0]}`)!; break; }
    }
    if (r.panel === undefined) r.panelWhy = `${set.size} panels in ${r.scene}, no on= on the line, and no single drawn panel box holds it. Add on=<panel> to the line`;
  }
};

// ---------- evaluation ----------
export type Hit = { rule: string; say: string; note: string; from: string; row: Row; field?: string; got?: string; want?: string; evidence?: Row[] };
export type Refusal = { rule: string; from: string; row: Row; why: string };
export type Stat = { id: string; from: string; selected: number; miss: number; cannot: number };
export type Evaluation = { hits: Hit[]; refused: Refusal[]; stats: Stat[] };
const timeOf = (r: Row, fps: number) => (r.first ?? r.at) / fps;
/** Does the other line stand in this relation to the line? null when a fact it needs is missing. */
const related = (rule: Rule, r: Row, o: Row, fps: number): Tri => {
  const L = rule.link;
  let why: string | undefined;
  for (const s of L.same) {
    if (s === "scene") { if (r.scene !== o.scene) return { ok: false }; }
    else if (s === "text") { if (normal(r.text) !== normal(o.text)) return { ok: false }; }
    else if (s === "speaker") { const a = r.kv?.speaker ?? r.kv?.side, b = o.kv?.speaker ?? o.kv?.side; if (a === undefined || a !== b) return { ok: false }; }
    else if (s === "panel") {
      if (r.panel === undefined) why ??= r.panelWhy ?? "its panel is not known";
      else if (o.panel === undefined) { if (o.scene === r.scene) why ??= `${o.id}: ${o.panelWhy ?? "its panel is not known"}`; else return { ok: false }; }
      else if (r.panel === null || r.panel !== o.panel) return { ok: false };
    }
  }
  const W = windowOf(rule.where, r), anchor = (a: Anchor) => a === "at" ? r.at / fps : a === "first" ? (W.first === undefined ? null : W.first / fps) : (W.last === undefined ? null : W.last / fps);
  const T = timeOf(o, fps);
  if (L.before) { const x = anchor(L.before); if (x === null) why ??= notDrawn(r); else if (!(T + L.grace <= x)) return { ok: false }; if (x !== null && L.within !== null && x - T > L.within) return { ok: false }; }
  if (L.after) { const x = anchor(L.after); if (x === null) why ??= notDrawn(r); else if (!(T >= x + L.grace)) return { ok: false }; if (x !== null && L.within !== null && T - x > L.within) return { ok: false }; }
  if (L.during) { if (W.first === undefined) why ??= notDrawn(r); else if (!(T >= W.first / fps && T <= W.last! / fps)) return { ok: false }; }
  return why ? { ok: null, why } : { ok: true };
};
export const evaluate = (M: Meaning, rows: Row[], fps: number): Evaluation => {
  const hits: Hit[] = [], refused: Refusal[] = [], stats: Stat[] = [];
  for (const rule of M.rules) {
    const st: Stat = { id: rule.id, from: rule.from, selected: 0, miss: 0, cannot: 0 };
    stats.push(st);
    const exempts = M.exempts.filter((e) => e.rule === rule.id);
    const refuse = (row: Row, why: string) => { st.cannot++; refused.push({ rule: rule.id, from: rule.from, row, why }); };
    for (const r of rows) {
      const sel = allOf(M, rule.where, r, fps);
      if (sel.ok === false) continue;
      if (exempts.some((e) => allOf(M, e.where, r, fps).ok === true)) continue;
      st.selected++;
      if (sel.ok === null) { refuse(r, sel.why!); continue; }
      if (rule.kind === "expect") {
        const miss: Hit[] = [];
        let why: string | undefined;
        for (const t of rule.terms) {
          const x = termOn(M, t, r, fps);
          if (x.ok === false) miss.push({ rule: rule.id, say: rule.say, note: rule.note, from: rule.from, row: r, field: t.key, got: x.got, want: t.raw });
          else if (x.ok === null) why ??= x.why;
          else if (r.partial?.[t.key]) why ??= r.partial[t.key];
        }
        if (miss.length) { st.miss++; hits.push(...miss); } else if (why) refuse(r, why);
        continue;
      }
      // A relation over panels has nothing to say on a line in a scene with no panel.
      if (rule.link.same.includes("panel") && r.panel === null) { st.selected--; continue; }
      const matches: Row[] = [];
      let why: string | undefined;
      for (const o of rows) {
        if (o === r) continue;
        const a = allOf(M, rule.terms, o, fps);
        if (a.ok === false) continue;
        const b = related(rule, r, o, fps);
        if (b.ok === false) continue;
        if (a.ok === true && b.ok === true) matches.push(o); else why ??= a.why ?? b.why;
      }
      if (rule.kind === "forbid") {
        if (matches.length) { st.miss++; hits.push({ rule: rule.id, say: rule.say, note: rule.note, from: rule.from, row: r, evidence: matches }); }
        else if (why) refuse(r, why);
      } else if (!matches.length) {
        if (why) refuse(r, why);
        else { st.miss++; hits.push({ rule: rule.id, say: rule.say, note: rule.note, from: rule.from, row: r, evidence: [] }); }
      }
    }
  }
  return { hits, refused, stats };
};
