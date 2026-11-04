// movas options <scene>.<line id> [--take=X]: the choices for one line, each with its cost against the last saved
// version. A choice is the score with one source line changed, compiled from a temporary copy of film/. Nothing is saved.
import { type Clock, impact, loadFilm, type Solved, solve } from "./movas.ts";

type Analysis = { defects: Map<string, string>; warns: Map<string, string>; rows: Map<string, unknown> };
/** What cli.ts passes in: the film and temp roots, the saved version, and the display-list pass with its analysis. */
export type OptionsCtx = {
  FILM: string;
  WORK: string;
  PUBLIC: string;
  hasSaved: () => Promise<boolean>;
  scoreAt: (ref: string) => Promise<string>;
  planFor: (film: string | null, tag: string, extra?: string[], quiet?: boolean) => Promise<any>;
  analyse: (s: Solved, c: any) => Analysis;
};

type Choice = {
  label: string; // what changes, only
  text: string; // the scene file with this choice applied
  order: number; // generation order, the last sort key
  frames: number; // against the baseline
  moved: number;
  phase: number;
  errors: number;
  notes: string[];
  newDefects?: number; // family L and now, when the display-list pass ran
  newWarns?: number;
};
type Counts = { newDefects?: number; newWarns?: number; extra: string[] };

const T_BEATS = [-2, -1.5, -1, -0.75, -0.5, -0.25, 0.25, 0.5, 1, 2];
const T_SECS = [-1, -0.5, -0.25, 0.25, 0.5, 1];
const H_BEATS = [0.5, 1, 2, 3, 4, 8];
const H_SECS = [0.5, 1, 2];
const L_DY = [0, -10, -25, -45];
const SHOWN = 8;
const EMPTY: Analysis = { defects: new Map(), warns: new Map(), rows: new Map() };

const letter = (i: number) => String.fromCharCode(65 + i);
const fmt = (x: number) => String(Number(x.toFixed(4)));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The line before its first quote: verb, id, time and keys. Edits act there, never in the text. */
export const split = (raw: string): [string, string] => {
  const q = raw.indexOf('"');
  return q < 0 ? [raw, ""] : [raw.slice(0, q), raw.slice(q)];
};
/** Replaces one whole token of the head with `to`. Null when the token is not there. */
const swapToken = (raw: string, from: string, to: string): string | null => {
  const [head, tail] = split(raw);
  const re = new RegExp(`(^|\\s)${escapeRe(from)}(?=\\s|$)`);
  return re.test(head) ? head.replace(re, (_, p: string) => p + to) + tail : null;
};
/** Sets key=value in the head: replaces the key when the line has it, adds it before the text otherwise. */
export const setKey = (raw: string, key: string, value: string): string => {
  const [head, tail] = split(raw);
  const re = new RegExp(`(^|\\s)${key}=\\S*`);
  if (re.test(head)) return head.replace(re, (_, p: string) => `${p}${key}=${value}`) + tail;
  const added = `${head.trimEnd()} ${key}=${value}`;
  return tail ? `${added} ${tail}` : added;
};
// The compiler's unit conversions (durToBeats) and their inverse.
const toBeats = (c: Clock, v: number, unit?: string) =>
  unit === "bar" ? v * c.beatsPerBar : unit === "s" ? (v * c.fps) / c.fpb : unit === "f" ? v / c.fpb : v;
const fromBeats = (c: Clock, b: number, unit: string) =>
  unit === "bar" ? b / c.beatsPerBar : unit === "s" ? (b * c.fpb) / c.fps : unit === "f" ? b * c.fpb : b;
/** True when two solved scores have the same length, events, texts and sounds. */
export const unchanged = (a: Solved, b: Solved) => {
  const i = impact(a, b);
  return a.durationFrames === b.durationFrames && [i.moved, i.added, i.removed, i.textChanged, i.textAdded, i.textRemoved, i.sfxAdded, i.sfxRemoved].every((x) => x.length === 0);
};
const row = (name: string, ch: Choice, phaseOn: boolean) => {
  const frames = `${ch.frames >= 0 ? "+" : ""}${ch.frames}f`;
  const cols = [`${ch.moved} moved`, ...(phaseOn ? [`${ch.phase} phase`] : []), `${ch.errors} errors`];
  return `${name.padEnd(5)}${ch.label.padEnd(34)}${frames.padStart(6)}  ${cols.map((x) => x.padEnd(12)).join("")}${ch.notes.join("  ")}`.trimEnd();
};

export const options = async (args: string[], ctx: OptionsCtx): Promise<number> => {
  const id = args.find((a) => !a.startsWith("--")) ?? "";
  const take = args.find((a) => a.startsWith("--take="))?.slice("--take=".length);
  const dot = id.indexOf(".");
  if (dot < 1 || dot === id.length - 1) throw new Error("usage: ./movas options <scene>.<line id> [--take=X]");
  const scene = id.slice(0, dot), lineId = id.slice(dot + 1);
  const now = solve(loadFilm(ctx.FILM), ctx.PUBLIC);
  const lines = now.film.scenes[scene]?.lines ?? [];
  const line = lines.find((l) => (lineId === "end" ? l.verb === "end" : l.id === lineId));
  if (!line) {
    const ids = lines.filter((l) => l.id || l.verb === "end").map((l) => l.id ?? "end");
    console.log(`no line ${id}. ${lines.length ? `Lines in ${scene}: ${ids.join(" ")}` : `No scene ${scene}.`}`);
    return 1;
  }
  const c = now.clock, file = line.loc.file, idx = line.loc.line - 1;
  const srcLines = (await Deno.readTextFile(`${ctx.FILM}/${file}`)).split("\n");
  const raw = srcLines[idx];
  const fullText = (newRaw: string) => srcLines.map((l, i) => (i === idx ? newRaw : l)).join("\n");
  const prevId = [...lines.slice(0, lines.indexOf(line))].reverse().find((l) => l.id)?.id;
  const saved = await ctx.hasSaved();
  await Deno.mkdir(ctx.WORK, { recursive: true });
  const tmp = await Deno.makeTempDir({ dir: ctx.WORK, prefix: "options-" });
  const work = `${tmp}/film`;
  let baseDir: string | null = null;
  try {
    await Deno.mkdir(work);
    for (const e of Deno.readDirSync(ctx.FILM)) if (e.isFile) await Deno.copyFile(`${ctx.FILM}/${e.name}`, `${work}/${e.name}`);
    if (saved) baseDir = await ctx.scoreAt("HEAD");
    const base = baseDir ? solve(loadFilm(baseDir), ctx.PUBLIC) : now;
    // One temporary copy serves every choice: each compile rewrites only this line's file.
    const compileWith = (newRaw: string): Solved => {
      Deno.writeTextFileSync(`${work}/${file}`, fullText(newRaw));
      return solve(loadFilm(work), ctx.PUBLIC);
    };
    const choiceOf = (label: string, text: string, s: Solved, order: number, extra: string[] = []): Choice => {
      const i = impact(base, s), errs = s.problems.filter((p) => p.level === "error");
      const kick = i.moved.filter((m) => m.phaseFrom === 0 && m.phaseTo !== 0).map((m) => m.id);
      const slack = [lineId, prevId].flatMap((k) => {
        const f = k === undefined ? undefined : s.floors.find((x) => x.id === `${scene}.${k}`);
        return f ? [`${k} slack ${f.slackFrames}f`] : [];
      });
      const notes = [
        slack.join(", "),
        kick.length ? `left the kick: ${kick.slice(0, 3).join(", ")}${kick.length > 3 ? ` and ${kick.length - 3} more` : ""}` : "",
        errs.length ? `first error ${errs[0].code}` : "",
        ...extra,
      ].filter(Boolean);
      return { label, text, order, frames: s.durationFrames - base.durationFrames, moved: i.moved.length, phase: i.phaseChanged.length, errors: errs.length, notes };
    };
    // The display-list pass of a film, the one `./movas report` uses. Null when the pass does not run.
    const planOf = async (s: Solved, film: string | null, tag: string): Promise<Analysis | null> => {
      const plan = await ctx.planFor(film, tag, [], true);
      return plan ? ctx.analyse(s, plan) : null;
    };
    const scoped = (k: string) => k.split(/[\s|]+/).some((t) => t === scene || t.startsWith(`${scene}.`));
    const choices: Choice[] = [];
    let order = 0;

    // Family T: the time of the line, moved by each delta in the unit it is written in.
    const m = line.at ? /^@([^+~]+?)(?:([+-][\d.]+)(b|bar|s|f)?)?(~.+)?$/.exec(line.at) : null;
    if (line.at && m && !m[1].startsWith("max(")) {
      const unit = m[2] === undefined ? "b" : (m[3] ?? "");
      const off = toBeats(c, m[2] === undefined ? 0 : parseFloat(m[2]), m[3]);
      for (const d of c.isBeat ? T_BEATS : T_SECS) {
        const nb = off + (c.isBeat ? d : (d * c.fps) / c.fpb);
        if (nb < -1e-9) continue;
        const at = `@${m[1]}+${fmt(fromBeats(c, nb, unit))}${unit}${m[4] ?? ""}`;
        const newRaw = swapToken(raw, line.at, at);
        if (newRaw === null) break;
        const s = compileWith(newRaw);
        if (!unchanged(now, s)) choices.push(choiceOf(at, fullText(newRaw), s, order++));
      }
    }

    // Family H: a hold, out=@<id>.floor+N. A dock or typed line with its own out= is left alone.
    if (["punch", "dock", "typed"].includes(line.verb) && (line.verb === "punch" || !line.kv.out?.startsWith("@"))) {
      const unit = c.isBeat ? "b" : "s";
      for (const n of c.isBeat ? H_BEATS : H_SECS) {
        const value = `@${lineId}.floor+${fmt(n)}${unit}`;
        const newRaw = setKey(raw, "out", value);
        if (newRaw === raw) continue;
        const s = compileWith(newRaw);
        // A self reference that does not compile, such as the floor of a dock, is dropped without a word.
        if (s.problems.some((p) => p.code === "time.eval" && p.msg.includes(`"${scene}.${lineId}.floor"`))) continue;
        // A line whose out the compiler does not read (typed, or a punch with with=) changes nothing, so it is not a choice.
        if (!unchanged(now, s)) choices.push(choiceOf(`out=${value}`, fullText(newRaw), s, order++));
      }
    }

    // Family L: a panel's layout. keep moves to the next value, and y, h and tagY move by dy. Stops at the first zero.
    let nowCounts: Counts = { extra: [] };
    if (line.verb === "panel") {
      const baseRaw = baseDir ? await planOf(base, baseDir, "options-base") : await planOf(now, null, "options-now");
      const baseAn = baseRaw ?? EMPTY;
      const nowRaw = baseDir ? await planOf(now, null, "options-now") : baseRaw;
      const countsOf = (an: Analysis | null): Counts => {
        if (!an) return { extra: ["the plan pass did not run, so new defects and warnings are unknown"] };
        const nd = [...an.defects.keys()].filter((k) => scoped(k) && !baseAn.defects.has(k));
        const nw = [...an.warns.keys()].filter((k) => scoped(k) && !baseAn.warns.has(k));
        const first = [...nd, ...nw][0];
        return { newDefects: nd.length, newWarns: nw.length, extra: [`new defects ${nd.length}, new warnings ${nw.length}${first ? ` (first: ${first})` : ""}`] };
      };
      nowCounts = countsOf(nowRaw);
      const k = line.kv.keep === undefined ? undefined : parseFloat(line.kv.keep);
      const y0 = parseFloat(line.kv.y), h0 = parseFloat(line.kv.h);
      const tag0 = line.kv.tagY === undefined ? undefined : parseFloat(line.kv.tagY);
      if (!Number.isNaN(y0) && !Number.isNaN(h0)) {
        outer: for (const keep of k === undefined ? [undefined] : [k, k + 1]) {
          for (const dy of L_DY) {
            if (keep === k && dy === 0) continue;
            let newRaw = raw;
            const parts: string[] = [];
            if (dy !== 0) {
              newRaw = setKey(setKey(newRaw, "y", fmt(y0 + dy)), "h", fmt(h0 - dy));
              parts.push(`y=${fmt(y0 + dy)}`, `h=${fmt(h0 - dy)}`);
            }
            if (keep !== k) {
              newRaw = setKey(newRaw, "keep", String(keep));
              parts.push(`keep=${keep}`);
            }
            if (dy !== 0 && tag0 !== undefined) {
              newRaw = setKey(newRaw, "tagY", fmt(tag0 + dy));
              parts.push(`tagY=${fmt(tag0 + dy)}`);
            }
            const s = compileWith(newRaw);
            const cnt = countsOf(await planOf(s, work, "options-cand"));
            choices.push({ ...choiceOf(parts.join(" "), fullText(newRaw), s, order++, cnt.extra), newDefects: cnt.newDefects, newWarns: cnt.newWarns });
            if (cnt.newDefects === 0 && cnt.newWarns === 0) break outer;
          }
        }
      }
    }

    const nowChoice: Choice = {
      ...choiceOf([line.verb, line.id, line.at].filter(Boolean).join(" "), fullText(raw), now, -1, nowCounts.extra),
      newDefects: nowCounts.newDefects,
      newWarns: nowCounts.newWarns,
    };
    const nd = (ch: Choice) => ch.newDefects ?? 1e9;
    choices.sort((a, b) => a.errors - b.errors || nd(a) - nd(b) || a.phase - b.phase || Math.abs(a.frames) - Math.abs(b.frames) || a.moved - b.moved || a.order - b.order);
    const top = choices.slice(0, SHOWN);

    if (take !== undefined) {
      const pick = /^[A-Z]$/.test(take) ? top[take.charCodeAt(0) - 65] : undefined;
      if (!pick) {
        console.log(`no option ${take} for ${id}. The rows are ${top.map((_, i) => letter(i)).join(" ") || "none"}.`);
        return 1;
      }
      Deno.writeTextFileSync(`${ctx.FILM}/${file}`, pick.text);
      console.log(`took ${take}: ${pick.label} on ${id}`);
      const t0 = performance.now(), after = solve(loadFilm(ctx.FILM), ctx.PUBLIC), ms = performance.now() - t0;
      const errs = after.problems.filter((p) => p.level === "error").length;
      console.log(`${errs} errors, ${after.problems.length - errs} warnings; ${Object.keys(after.events).length} events, ${after.texts.length} texts, ${after.sfx.length} sounds, ${after.durationFrames} frames, ${ms.toFixed(1)} ms`);
      return errs ? 1 : 0;
    }

    const phaseOn = c.isBeat;
    console.log(`options for ${id}, costs against ${saved ? "the last saved version" : "the working score (no saved version yet)"}. Times are computed. What reads well is the director's call.`);
    console.log(row("now", nowChoice, phaseOn));
    top.forEach((ch, i) => console.log(row(letter(i), ch, phaseOn)));
    console.log(top.length ? `Take one with: ./movas options ${id} --take=${letter(0)}` : `No choice changes ${id}.`);
    return 0;
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    if (baseDir) await Deno.remove(baseDir.replace(/\/film$/, ""), { recursive: true }).catch(() => {});
  }
};
