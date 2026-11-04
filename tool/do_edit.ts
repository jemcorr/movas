// Pure score-text functions for `movas do`: the word groups and accent of a line's on-screen text, the @time token,
// and sentence pairs for repeated text. No file or process access, so every function is unit-testable.

export type Shape = { sep: " / " | "\\n" | null; groups: string[]; accent: "none" | "whole" | number[]; partial: boolean };
export type SplitRank = { groups: string[]; insidePunct: number; badEnds: number; widest: number; spread: number };

/** The words as a reader hears them: no asterisks, no group or line marks, single spaces. */
export const plainText = (t: string): string =>
  t
    .replace(/\*/g, "")
    .split("\\n")
    .join(" ")
    .replace(/\s*\/\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const countOf = (s: string, ch: string) => s.split(ch).length - 1;

/** Group split and accent of an on-screen text. `partial` marks an accent that the array form cannot express. */
export const shapeOf = (t: string): Shape => {
  const sep = t.includes(" / ") ? " / " : t.includes("\\n") ? "\\n" : null;
  const raw = sep === null ? [t] : t.split(sep);
  const groups = sep === null ? [t.replace(/\*/g, "")] : raw.map((p) => p.replace(/\*/g, "").trim());
  if (!t.includes("*")) return { sep, groups, accent: "none", partial: false };
  if (t.startsWith("*") && t.endsWith("*") && countOf(t, "*") === 2) return { sep, groups, accent: "whole", partial: false };
  const pieces = raw.map((p) => p.trim());
  // A star that is not at a piece edge opens or closes an accent inside a group.
  if (pieces.some((p) => p.slice(1, -1).includes("*"))) return { sep, groups, accent: "none", partial: true };
  const accent: number[] = [];
  let on = false;
  pieces.forEach((p, i) => {
    if (p.startsWith("*")) on = true;
    if (on) accent.push(i);
    if (p.endsWith("*")) on = false;
  });
  return { sep, groups, accent, partial: false };
};

export const hasMarkup = (t: string): boolean => t.includes("*") || t.includes(" / ") || t.includes("\\n");

/** Joins the groups with `sep` and adds the accent. An array wraps each run of consecutive indexes in one pair of stars. */
export const applyAccent = (groups: string[], sep: string, accent: Shape["accent"]): string => {
  if (accent === "none") return groups.join(sep);
  if (accent === "whole") return `*${groups.join(sep)}*`;
  const out: string[] = [];
  let i = 0;
  while (i < groups.length) {
    if (!accent.includes(i)) {
      out.push(groups[i]);
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < groups.length && accent.includes(j + 1)) j++;
    out.push(`*${groups.slice(i, j + 1).join(sep)}*`);
    i = j + 1;
  }
  return out.join(sep);
};

/** Cut lists [0, c1, ..., len] for n non-empty runs over len words, in lexicographic order of the cuts. */
const cutLists = (len: number, n: number): number[][] => {
  const pick = (from: number, k: number): number[][] => {
    if (k === 0) return [[]];
    const out: number[][] = [];
    for (let c = from; c <= len - k; c++) for (const rest of pick(c + 1, k - 1)) out.push([c, ...rest]);
    return out;
  };
  return pick(1, n - 1).map((cuts) => [0, ...cuts, len]);
};
/** The cut lists for words in n groups. None when n < 1 or there are fewer words than groups. */
const cutsFor = (words: string[], n: number): number[][] => (n < 1 || words.length < n ? [] : cutLists(words.length, n));
const runsOf = (words: string[], cuts: number[]): string[][] => cuts.slice(0, -1).map((from, i) => words.slice(from, cuts[i + 1]));

/** Every split of words into n consecutive non-empty groups, in lexicographic order of the cut positions. */
export const splitCandidates = (words: string[], n: number): string[][] =>
  cutsFor(words, n).map((cuts) => runsOf(words, cuts).map((r) => r.join(" ")));

const ENDS_PUNCT = /[,.;:!?]$/;
/** The word lowercased, with leading and trailing punctuation removed. */
const bare = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** Every split of words into n groups, best first: fewest punctuation breaks inside groups, then fewest stop-word ends, then narrowest. */
export const rankSplits = (words: string[], n: number, stop: Set<string>): SplitRank[] =>
  cutsFor(words, n)
    .map((cuts) => {
      const runs = runsOf(words, cuts);
      const lens = runs.map((r) => [...r.join(" ")].length);
      return {
        groups: runs.map((r) => r.join(" ")),
        insidePunct: runs.reduce((sum, r) => sum + r.slice(0, -1).filter((w) => ENDS_PUNCT.test(w)).length, 0),
        badEnds: runs.slice(0, -1).filter((r) => stop.has(bare(r[r.length - 1]))).length,
        widest: Math.max(...lens),
        spread: Math.max(...lens) - Math.min(...lens),
      };
    })
    .sort((a, b) => a.insidePunct - b.insidePunct || a.badEnds - b.badEnds || a.widest - b.widest || a.spread - b.spread);

export const STOP_DEFAULT: Set<string> = new Set(
  "e o a os as de do da dos das um uma com em no na nos nas por para que é se seu sua ou mas ao à the an of to and or in on at for with is".split(" "),
);

/**
 * Reads one score line left to right: its quoted strings (each marked on-screen unless the quote follows `=`), its
 * whitespace-delimited tokens outside quotes, and where a `#` comment starts. A `#` starts a comment only at the start
 * of a token, so `accent=#7ee08f` is not one. An unterminated quote is ignored.
 */
const lex = (raw: string) => {
  const quotes: { start: number; end: number; onScreen: boolean }[] = [];
  const tokens: { s: number; e: number }[] = [];
  let comment = raw.length;
  let s = -1; // start of the token being read, -1 between tokens
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') {
      if (s < 0) s = i;
      let j = i + 1;
      while (j < raw.length && (raw[j] !== '"' || raw[j - 1] === "\\")) j++;
      if (j === raw.length) break;
      quotes.push({ start: i + 1, end: j, onScreen: i === 0 || raw[i - 1] !== "=" });
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (s >= 0) tokens.push({ s, e: i });
      s = -1;
    } else if (c === "#" && (i === 0 || /\s/.test(raw[i - 1]))) {
      comment = i;
      break;
    } else if (s < 0) {
      s = i;
    }
    i++;
  }
  if (s >= 0) tokens.push({ s, e: comment });
  return { quotes, tokens, comment };
};

/** The on-screen text of a line: its last quoted string that is not a key's value. Null when there is none. */
export const textOfRaw = (raw: string): { start: number; end: number; text: string } | null => {
  const on = lex(raw).quotes.filter((q) => q.onScreen);
  const last = on[on.length - 1];
  return last ? { start: last.start, end: last.end, text: raw.slice(last.start, last.end) } : null;
};

/** Replaces the on-screen text, verbatim. A line without text gets ` "text"` after the trimmed line, before a trailing comment. */
export const withText = (raw: string, text: string): string => {
  const hit = textOfRaw(raw);
  if (hit) return raw.slice(0, hit.start) + text + raw.slice(hit.end);
  const { comment } = lex(raw);
  return [raw.slice(0, comment).trim(), `"${text}"`, raw.slice(comment).trim()].filter((x) => x !== "").join(" ");
};

/** Keys whose values are words on screen. A change of one is a change of words, so it is quoted and proven like text. */
export const TEXT_KEYS: string[] = ["q", "a", "title", "flip", "by", "license"];

/** A value given with its quotes, `"Nova pergunta?"`, means the words inside them. */
export const unquote = (v: string): string => /^"((?:[^"\\]|\\.)*)"$/.exec(v)?.[1] ?? v;
/** Escapes each bare quote, leaves escapes that are there, and doubles a last backslash so it cannot escape the closing quote. */
const escapeQuotes = (s: string): string => {
  const e = s.replace(/\\.|"/g, (m) => (m === '"' ? '\\"' : m));
  return (/\\*$/.exec(e)?.[0].length ?? 0) % 2 === 1 ? `${e}\\` : e;
};

/**
 * Sets key=value, replacing the whole old value, quoted or not. A text key, a value with spaces or quotes, and a key whose
 * value was quoted get quotes. Without the key, it goes before the on-screen text, else at the end before a comment.
 */
export const withKey = (raw: string, key: string, value: string): string => {
  const { tokens, quotes, comment } = lex(raw);
  const hit = tokens.find((k) => raw.startsWith(`${key}=`, k.s));
  const words = unquote(value);
  const quoted = TEXT_KEYS.includes(key) || /[\s"]/.test(words) || (hit !== undefined && raw[hit.s + key.length + 1] === '"');
  const form = `${key}=${quoted ? `"${escapeQuotes(words)}"` : words}`;
  if (hit) return raw.slice(0, hit.s) + form + raw.slice(hit.e);
  const text = quotes.find((q) => q.onScreen);
  if (text) return `${raw.slice(0, text.start - 1).trimEnd()} ${form} ${raw.slice(text.start - 1)}`;
  return [raw.slice(0, comment).trimEnd(), form, raw.slice(comment).trim()].filter((x) => x !== "").join(" ");
};

/** The first whitespace-delimited token outside quotes that starts with `@`. */
export const atOfRaw = (raw: string): string | null => {
  const t = lex(raw).tokens.find((k) => raw[k.s] === "@");
  return t ? raw.slice(t.s, t.e) : null;
};

/** Replaces the @ token. Without one, inserts ` <at>` after the id, the second token. */
export const withAt = (raw: string, at: string): string => {
  const { tokens } = lex(raw);
  const hit = tokens.find((k) => raw[k.s] === "@");
  if (hit) return raw.slice(0, hit.s) + at + raw.slice(hit.e);
  const id = tokens.length > 1 ? tokens[1] : tokens[0];
  return id ? raw.slice(0, id.e) + " " + at + raw.slice(id.e) : [raw.trim(), at].filter((x) => x !== "").join(" ");
};

const AT_RE = /^@([^+~]+?)(?:([+-][\d.]+)(b|bar|s|f)?)?(~.+)?$/;

/** `@cause`, `@cause+1.5b`, `@cause-20f`, `@cause+2`, `@start+0.5b~kick`. Offset 0 and unit `b` when absent. */
export const parseAt = (at: string): { cause: string; offset: number; unit: string; snap: string; bare: boolean } | null => {
  const m = AT_RE.exec(at);
  if (!m || m[1].startsWith("max(")) return null;
  const offset = m[2] === undefined ? 0 : Number(m[2]);
  if (Number.isNaN(offset)) return null;
  return { cause: m[1], offset, unit: m[3] ?? "b", snap: m[4] ?? "", bare: m[2] === undefined };
};

/** `@cause+N<unit><snap>`: a sign always, at most 4 decimals, trailing zeros trimmed. Offset 0 writes `+0<unit>`. */
export const formatAt = (p: { cause: string; offset: number; unit: string; snap: string }): string => {
  const abs = Math.round(Math.abs(p.offset) * 1e4) / 1e4;
  const digits = abs === 0 ? "0" : abs.toFixed(4).replace(/\.?0+$/, "");
  const sign = p.offset < 0 && abs !== 0 ? "-" : "+";
  return `@${p.cause}${sign}${digits}${p.unit}${p.snap}`;
};

/** Adds delta to the offset in the unit already written. Null when `at` does not parse. */
export const addOffset = (at: string, delta: number): string | null => {
  const p = parseAt(at);
  return p ? formatAt({ cause: p.cause, offset: p.offset + delta, unit: p.unit, snap: p.snap }) : null;
};

const wordCount = (s: string) => (s.trim() === "" ? 0 : s.trim().split(/\s+/).length);
const sentencesOf = (s: string) => s.split(/(?<=[.?!])\s+/);

/** The whole line when it changed, then each changed sentence when both texts have the same sentence count. No duplicates. */
export const sentencePairs = (oldPlain: string, newPlain: string, minWords: number): { from: string; to: string }[] => {
  const pairs: { from: string; to: string }[] = [];
  const add = (from: string, to: string) => {
    if (!pairs.some((p) => p.from === from && p.to === to)) pairs.push({ from, to });
  };
  if (oldPlain !== newPlain && wordCount(oldPlain) >= minWords) add(oldPlain, newPlain);
  const olds = sentencesOf(oldPlain);
  const news = sentencesOf(newPlain);
  if (olds.length === news.length) {
    olds.forEach((o, i) => {
      if (o !== news[i] && wordCount(o) >= minWords) add(o, news[i]);
    });
  }
  return pairs;
};

/** Replaces each pair's `from` with its `to`, longest `from` first, every occurrence, as literal text. */
export const replaceRepeats = (lineText: string, pairs: { from: string; to: string }[]): string =>
  pairs
    .filter((p) => p.from !== "")
    .sort((a, b) => b.from.length - a.from.length)
    .reduce((line, p) => line.split(p.from).join(p.to), lineText);

export const isCommentLine = (line: string): boolean => /^(\/\/|\/\*|\*|#)/.test(line.trim());

/** The first `stem + number` not in taken, counting from the trailing digits plus 1, or from 2 when there are none. */
export const nextId = (afterId: string, taken: Set<string>): string => {
  const stem = afterId.replace(/\d+$/, "");
  const digits = afterId.slice(stem.length);
  let n = digits === "" ? 2 : Number(digits) + 1;
  while (taken.has(stem + n)) n++;
  return stem + n;
};

/** `+2b`, `2b`, `-0.5s`, `1bar`, `30f`, `2`: a signed value and its unit, `b` when absent. */
export const parseValue = (s: string): { value: number; unit: string } | null => {
  const m = /^([+-]?[\d.]+)(b|bar|s|f)?$/.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  return Number.isNaN(value) ? null : { value, unit: m[2] ?? "b" };
};

/** The line of an error text that says what went wrong: the first that names an error, else the first that is not a stack frame or a source excerpt. */
export const firstErrorLine = (text: string): string => {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !/^at\s/.test(l) && !/^\^+$/.test(l));
  const hit = lines.find((l) => /error/i.test(l)) ?? lines[0] ?? "";
  return hit.length > 200 ? `${hit.slice(0, 197)}...` : hit;
};

/** The cost of an edit as report sentences: film length, events moved, and up to 3 events that left the kick. Length says when it did not change. */
export const costSentences = (c: { frames: number; moved: number; kick: string[] }): string[] => {
  const out = [c.frames === 0 ? "Film length unchanged." : `Film ${c.frames > 0 ? "+" : ""}${c.frames} frames.`];
  if (c.moved > 0) out.push(`${c.moved} event${c.moved === 1 ? "" : "s"} moved.`);
  if (c.kick.length) out.push(`${c.kick.length} event${c.kick.length === 1 ? "" : "s"} left the kick: ${c.kick.slice(0, 3).join(", ")}${c.kick.length > 3 ? ` and ${c.kick.length - 3} more` : ""}.`);
  return out;
};

// ---------- Proof that a change of words is on screen ----------

/** One entry of the plan's drawn list: a string the frames draw, with the score id and scene that drew it, when they have one. */
export type Drawn = { id?: string | null; scene?: string | null; text: string };
export type WordsProof = { state: "refused"; where: string[] } | { state: "drawn" | "literal"; where: string } | { state: "none" };

const lower = (s: string): string => s.replace(/[*/]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const wordsIn = (s: string): number => (s === "" ? 0 : s.split(" ").length);

/** One string per drawn text and scene: a text drawn in pieces (`s06.c7`, `s06.c7.2`, `s09.l2.g1`) is joined in the order the plan met them. Texts with no id stay apart. */
export const drawnWhole = (drawn: Drawn[]): { id: string | null; scene: string; text: string }[] => {
  const out = new Map<string, { id: string | null; scene: string; text: string }>();
  drawn.forEach((d, i) => {
    const id = d.id ? d.id.replace(/\.(?:\d+|[gl]\d+)$/, "") : null, scene = d.scene ?? "";
    const key = id === null ? `\u0001${i}` : `${id}\u0000${scene}`;
    const cur = out.get(key);
    if (cur) cur.text = `${cur.text} ${d.text}`;
    else out.set(key, { id, scene, text: d.text });
  });
  return [...out.values()].map((g) => ({ ...g, text: lower(g.text) }));
};

/**
 * What the plan says about a change of words. `refused`: the old words are still on screen, and `where` names who draws
 * them. A text of 3 words or more is looked for in every drawn text and every program line, as the repeat rule replaces it;
 * a shorter one in the edited text itself, and, when the plan does not see the new words drawn, as a whole string literal
 * of a program. `drawn`: the edited text draws the new words. `literal`: a program line holds them, which proves a text
 * that a program draws as a texture: a phrase of 3 words or more anywhere, or any new words in a line that this edit
 * changed. `none`: no proof either way.
 */
export const wordsProof = (o: {
  id: string; oldWords: string; newWords: string; pairs: { from: string; to: string }[]; here: boolean;
  drawn: Drawn[]; literals: { where: string; line: string; changed?: boolean }[];
}): WordsProof => {
  const whole = drawnWhole(o.drawn), now = lower(o.newWords);
  const olds = [...new Set([o.oldWords, ...o.pairs.map((p) => p.from)].map(lower))].filter((f) => f !== "" && !now.includes(f));
  const where: string[] = [];
  for (const f of olds) {
    const wide = wordsIn(f) >= 3 && !o.here;
    for (const g of whole) if ((wide || g.id === o.id) && g.text.includes(f)) where.push(g.id ?? `a program in ${g.scene}`);
    if (wide) for (const l of o.literals) if (lower(l.line).includes(f)) where.push(l.where);
  }
  if (where.length) return { state: "refused", where: [...new Set(where)].slice(0, 3) };
  if (whole.some((g) => g.id === o.id && g.text.includes(now))) return { state: "drawn", where: o.id };
  // The plan cannot see this text. A short old text that a program still holds as a whole string is still drawn by it.
  if (!o.here) for (const f of olds) for (const l of o.literals) if (wordsIn(f) < 3 && ["\"", "'", "`"].some((q) => lower(l.line).includes(`${q}${f}${q}`))) where.push(l.where);
  if (where.length) return { state: "refused", where: [...new Set(where)].slice(0, 3) };
  const tos = o.pairs.map((p) => lower(p.to)).filter((t) => t !== "");
  const news = [now, ...tos].filter((t) => wordsIn(t) >= 3);
  const lit = o.literals.find((l) => news.some((t) => lower(l.line).includes(t)) || (l.changed && tos.some((t) => lower(l.line).includes(t))));
  return lit ? { state: "literal", where: lit.where } : { state: "none" };
};
