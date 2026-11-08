// Tests for the rule language and its packs. Run with ./movas test-rules. Every rule has a seeded case that must fire and a clean case that must not, on real output of the two films in fixtures/.
// Each test works on a new film under .work/, and never on this tree's film/. Prints PASS name, or FAIL name: reason.
import { evaluate, MeaningError, readMeaning, tokens, type Meaning, type Row } from "./rules.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const WORK = Deno.env.get("MOVAS_WORK") ?? `${ROOT}/.work`;
const MACHINE_PUBLIC = Deno.env.get("MOVAS_PUBLIC") ?? "";
// The fixtures read this machine's fonts and sounds. Without them every render fails and the failures read as rule bugs.
for (const sub of ["fonts", "sfx"]) {
  try { if (!MACHINE_PUBLIC || !Deno.statSync(`${MACHINE_PUBLIC}/${sub}`).isDirectory) throw 0; } catch {
    console.error(`test-rules needs MOVAS_PUBLIC set to a folder with fonts/ and sfx/ (now ${MACHINE_PUBLIC ? `"${MACHINE_PUBLIC}", which has no ${sub}/` : "unset"}). Run it from a film, or set MOVAS_PUBLIC.`);
    Deno.exit(2);
  }
}
const PORT = parseInt(Deno.env.get("MOVAS_PORT") ?? "4871") + 100;
const only = Deno.args.filter((a) => !a.startsWith("--"));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
// A test film reads its own .movasrc, so the machine paths this run was given do not pass down.
const NO_MACHINE = { MOVAS_PUBLIC: "", MOVAS_SHELL: "", MOVAS_THREE: "", MOVAS_CHECKS: "", MOVAS_FILM: "", MOVAS_HOME: "" };
const sh = async (cmd: string, args: string[], cwd?: string) => {
  const o = await new Deno.Command(cmd, { args, cwd, env: NO_MACHINE, stdout: "piped", stderr: "piped" }).output();
  return { ok: o.success, code: o.code, out: dec(o.stdout), err: dec(o.stderr), text: dec(o.stdout) + dec(o.stderr) };
};
const PUB = `${WORK}/t-rules-public`;
/** The public folder a test film reads: the machine's fonts and sounds, and a plain tone as the bed. */
const publicFolder = async () => {
  await Deno.mkdir(`${PUB}/audio`, { recursive: true });
  // Relink every run: a link left by an earlier run may point at a folder that moved.
  for (const sub of ["fonts", "sfx"]) { await Deno.remove(`${PUB}/${sub}`).catch(() => {}); await Deno.symlink(`${MACHINE_PUBLIC}/${sub}`, `${PUB}/${sub}`); }
  const r = await sh("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=110:duration=40", "-ar", "48000", "-ac", "2", `${PUB}/audio/tone.wav`]);
  if (!r.ok) throw new Error(r.err);
};
type Edit = [file: string, from: string, to: string];
const edit = async (d: string, [file, from, to]: Edit) => {
  const p = `${d}/${file}`, s = await Deno.readTextFile(p);
  if (s.split(from).length !== 2) throw new Error(`expected 1 "${from}" in ${file}`);
  await Deno.writeTextFile(p, s.replace(from, () => to));
};
/** A new film holding a fixture's film/ with these edits. An edit outside film/ goes to a copy of the install that only this film names. */
const filmOf = async (fixture: string, name: string, edits: Edit[] = []) => {
  const d = `${WORK}/t-rules-${name}`, toolEdits = edits.filter(([f]) => !f.startsWith("film/"));
  let home = ROOT;
  if (toolEdits.length) {
    home = `${WORK}/t-rules-${name}-install`;
    await Deno.remove(home, { recursive: true }).catch(() => {});
    await Deno.mkdir(home, { recursive: true });
    for (const f of ["programs", "runtime", "tool", "fixtures", "movas", "render.sh", ".movasrc"]) {
      try { await Deno.stat(`${ROOT}/${f}`); } catch { continue; }
      const c = await sh("cp", ["-cR", `${ROOT}/${f}`, `${home}/${f}`]);
      if (!c.ok) throw new Error(c.err);
    }
    // The machine folders stay shared: a link, not a copy, so the copy's films find the same shell, three.js and checks.
    for (const f of ["vendor", "checks"]) {
      try { await Deno.stat(`${ROOT}/${f}`); } catch { continue; }
      await Deno.symlink(`${ROOT}/${f}`, `${home}/${f}`);
    }
    for (const e of toolEdits) await edit(home, e);
  }
  await Deno.remove(d, { recursive: true }).catch(() => {});
  const r = await sh("python3", ["-B", `${home}/tool/new_film.py`, d, `--port=${PORT}`, `--public=${PUB}`]);
  if (!r.ok) throw new Error(r.text);
  await Deno.remove(`${d}/film`, { recursive: true });
  const c = await sh("cp", ["-cR", `${ROOT}/fixtures/${fixture}/film`, `${d}/film`]);
  if (!c.ok) throw new Error(c.err);
  for (const e of edits.filter(([f]) => f.startsWith("film/"))) await edit(d, e);
  return d;
};
const movas = (d: string, args: string[]) => sh(`${d}/movas`, args, d);
/** The rule ids in the Flags section, each with its text, and the Cannot check section. */
const report = async (d: string, args: string[] = ["--nofile"]) => {
  const r = await movas(d, ["film", "--section=flags", ...args]);
  if (!r.ok) throw new Error(`film failed: ${r.text.slice(-500)}`);
  const lines = r.out.split("\n");
  const flags = lines.filter((l) => /^\d+\. (?:warn \(unvalidated\) )?rule /.test(l)).map((l) => ({ id: /^\d+\. (?:warn \(unvalidated\) )?rule ([^:]+):/.exec(l)![1], text: l }));
  const cannot = lines.filter((l) => l.startsWith("- "));
  return { flags, cannot, text: r.out };
};
const fires = (r: { flags: { id: string; text: string }[] }, id: string, on?: string) => r.flags.some((f) => f.id === id && (!on || f.text.includes(on)));
const ids = (r: { flags: { id: string }[] }) => r.flags.map((f) => f.id).join(", ") || "none";
/** The debt film with a rendered preview, made once by the first test that needs it, so any of them runs alone or in any order. */
let debtOnce: Promise<string> | null = null;
const debtFilm = () => debtOnce ??= (async () => {
  const d = await filmOf("debt", "debt");
  const p = await movas(d, ["render", "--preview"]);
  if (!p.ok) throw new Error(`preview failed: ${p.text.slice(-300)}`);
  return d;
})();
const SEED = (kind: string): Edit => ["film/programs/scenes/accounts.js", 'const SEED = "";', `const SEED = "${kind}";`];

// ---------- the language, with no film ----------
const parseFails = async (lines: string, want: string): Promise<string | null> => {
  const d = await Deno.makeTempDir({ dir: WORK, prefix: "t-rules-parse-" });
  try {
    await Deno.writeTextFile(`${d}/meaning.txt`, lines);
    try { readMeaning(d, `${ROOT}/tool`); return `no error for: ${lines}`; } catch (e) {
      if (!(e instanceof MeaningError)) throw e;
      return e.message.includes(want) ? null : `wrong message: ${e.message.slice(0, 200)}`;
    }
  } finally { await Deno.remove(d, { recursive: true }); }
};
const meaningOf = async (lines: string): Promise<Meaning> => {
  const d = await Deno.makeTempDir({ dir: WORK, prefix: "t-rules-parse-" });
  try { await Deno.writeTextFile(`${d}/meaning.txt`, lines); return readMeaning(d, `${ROOT}/tool`); } finally { await Deno.remove(d, { recursive: true }); }
};
const row = (o: Partial<Row>): Row => ({ id: "s01.a", scene: "s01", verb: "text", text: "", words: 0, kv: {}, at: 0, panel: null, ...o });
const G: [string, () => Promise<string | null>][] = [
  ["parse.tension", () => parseFails('tension x claim=/a/ evidence=/b/ min=1 say="y"\n', "tension is gone")],
  ["parse.unknown", () => parseFails("nonsense here\n", "film/meaning.txt:1")],
  ["parse.line", () => parseFails("# comment\n\nnonsense here\n", "film/meaning.txt:3")],
  ["parse.rule", () => parseFails("rule a verb=x\n", "cannot read this rule")],
  ["parse.term", () => parseFails("rule a where verb expect id=x\n", "cannot read the term")],
  ["parse.number", () => parseFails("rule a where words>=x expect id=x\n", "needs a number")],
  ["parse.regex", () => parseFails("rule a where text~/(/ expect id=x\n", "bad regex")],
  ["parse.quote", () => parseFails('rule a where verb=x expect id=y say="open\n', "not closed")],
  ["parse.pack", () => parseFails("use nothing-here\n", "no pack nothing-here")],
  ["parse.verb", () => parseFails("verb x words=a\n", "verb lines belong")],
  ["parse.count", () => parseFails("rule a where count.nope>=1 expect id=x\n", "names no words line")],
  ["parse.drawn", () => parseFails("rule a where drawn.nope=1 expect id=x\n", "drawn facts are")],
  ["parse.same", () => parseFails("rule a where verb=x forbid id=y same=nope\n", "same= takes")],
  ["parse.limit", () => parseFails("limit a\n", "limit takes")],
  ["parse.link-typo", () => parseFails("rule a where verb=x forbid id=y near=3s\n", "there is no link near=")],
  ["parse.within-alone", () => parseFails("rule a where verb=x forbid id=y within=2s\n", "within= needs before= or after=")],
  ["parse.expect-link", () => parseFails("rule a where verb=x expect id=y same=panel\n", "same=panel is a link")],
  ["parse.off-unknown", () => parseFails("off craft.nope\n", "no rule or alike craft.nope")],
  ["parse.exempt-unknown", () => parseFails("exempt craft.nope where verb=msg\n", "no file declares a rule craft.nope")],
  ["parse.count-line", () => parseFails("# one\n\nrule a where count.nope>=1 expect id=x\n", "film/meaning.txt:3: rule a")],
  ["parse.say-limit", () => parseFails('rule a where verb=x expect id=y say="over {nope.limit}"\n', "no limit nope.limit")],
  ["tokens.regex", async () => JSON.stringify(tokens("a text~/b c/i d", "x")) === '["a","text~/b c/i","d"]' ? null : "a regex with a space split"],
  ["layers.replace", async () => { const M = await meaningOf('rule craft.spike where verb=scene expect spikes<=5 say="own"\n'); const r = M.rules.filter((x) => x.id === "craft.spike"); return r.length === 1 && r[0].say === "own" && r[0].from === "film/meaning.txt" ? null : "the film's rule did not replace the pack's"; }],
  ["layers.off", async () => (await meaningOf("off craft.spike\n")).rules.some((x) => x.id === "craft.spike") ? "off left the rule" : null],
  ["layers.off-then-own", async () => { const M = await meaningOf('off craft.spike\nrule craft.spike where verb=scene expect spikes<=5 say="own"\n'); const r = M.rules.filter((x) => x.id === "craft.spike"); return r.length === 1 && r[0].say === "own" ? null : "the film's own rule after off was lost"; }],
  ["layers.say-limit", async () => { const a = (await meaningOf("")).rules.find((x) => x.id === "craft.words_cut")!.say, b = (await meaningOf("limit cover.share 0.5\nlimit cover.frames 9\n")).rules.find((x) => x.id === "craft.words_cut")!.say; return a.includes("at least 20% covered") && a.includes("for 15 frames") && b.includes("at least 50% covered") && b.includes("for 9 frames") ? null : `say texts: ${a} | ${b}`; }],
  ["layers.limit", async () => { const M = await meaningOf("limit spike.px 99\n"); return M.limits.get("spike.px")?.value === 99 ? null : "the film's limit did not win"; }],
  ["layers.pack-order", async () => { const M = await meaningOf("use chat\n"); return M.packs.join() === "chat" && M.rules[0].id.startsWith("craft.") ? null : "craft does not come first"; }],
  ["eval.absent", async () => { const M = await meaningOf('rule t where verb=text expect side=out\nrule u where verb=text expect side!=out\n'); const e = evaluate(M, [row({ kv: {} })], 30); const t = e.stats.find((x) => x.id === "t")!, u = e.stats.find((x) => x.id === "u")!; return t.miss === 1 && u.miss === 0 ? null : `= on an absent key must be false, != true: ${JSON.stringify([t, u])}`; }],
  ["eval.unknown", async () => { const M = await meaningOf('rule t where verb=text expect drawn.align=right\n'); const e = evaluate(M, [row({})], 30); const t = e.stats.find((x) => x.id === "t")!; return t.cannot === 1 && t.miss === 0 ? null : `a fact the film cannot give must refuse: ${JSON.stringify(t)}`; }],
  ["eval.partial", async () => { const M = await meaningOf(""); const scene = row({ id: "s01", verb: "scene", facts: { jitter_elements: 0, spikes: 3, words_cut: 0, flow_jitter: 0 }, partial: { jitter_elements: "gl", spikes: "gl" } }); const e = evaluate(M, [scene], 30); return e.stats.find((x) => x.id === "craft.jitter")!.cannot === 1 && e.stats.find((x) => x.id === "craft.spike")!.miss === 1 ? null : "a partial fact must refuse a pass and let a miss fire"; }],
  ["eval.fact-undeclared", async () => { const M = await meaningOf("use chat\n"); const e = evaluate(M, [row({ verb: "msg", kv: { side: "bot", in: "c" }, text: "a b c", words: 3 })], 30); return e.refused.some((x) => x.why.includes("Add: fact role side=bot")) ? null : `no refusal naming the fix: ${JSON.stringify(e.refused.map((x) => x.why))}`; }],
  ["eval.same-text-panel", async () => { const M = await meaningOf("use chat\n"); const a = row({ id: "s01.a", verb: "msg", kv: { side: "out", in: "c" }, text: "one two three", words: 3, at: 0, panel: "c@s01" }), b = row({ id: "s01.b", verb: "msg", kv: { side: "out", in: "c" }, text: "One two  three", words: 3, at: 30, panel: "c@s01" }), o = row({ id: "s01.o", verb: "msg", kv: { side: "out", in: "d" }, text: "one two three", words: 3, at: 60, panel: "d@s01" }); const e = evaluate(M, [a, b, o], 30); const h = e.hits.filter((x) => x.rule === "chat.repeat"); return h.length === 1 && h[0].row.id === "s01.b" ? null : `chat.repeat: ${h.map((x) => x.row.id)}`; }],
];

// ---------- the debt reminder: no chat, its own rules, real output ----------
const T: [string, () => Promise<string | null>][] = [
  ["debt.clean", async () => {
    const d = await debtFilm();
    const c = await movas(d, ["check"]);
    if (!c.ok) return `check failed: ${c.text.slice(-300)}`;
    const r = await report(d, [`--file=${d}/.work/out/preview.mp4`]);
    if (r.flags.length) return `the clean film has flags: ${ids(r)}`;
    if (/Selected no line[^\n]*(paid|overdue)/.test(r.text)) return `a project rule selected nothing: ${r.text.slice(0, 400)}`;
    return null;
  }],
  ["debt.paid-owes", async () => {
    const r = await report(await filmOf("debt", "owes", [["film/s02-accounts.movas", '"Payment received today"', '"Marina still owes R$ 340"']]));
    return fires(r, "paid.owes", "s02.statusA") && fires(r, "paid.received", "s02.statusA") ? null : `flags: ${ids(r)}`;
  }],
  ["debt.paid-early", async () => {
    const r = await report(await filmOf("debt", "early", [["film/s02-accounts.movas", "cue flipA @payA+1s", "cue flipA @statusA+1s"]]));
    return fires(r, "paid.received", "s02.statusA") && !fires(r, "paid.owes") ? null : `flags: ${ids(r)}`;
  }],
  ["debt.other-card", async () => {
    // "still owes" on the other card, on screen at the same moment, is not this card's. A word match over the film would fire here.
    const r = await report(await filmOf("debt", "other"));
    return !fires(r, "paid.owes") ? null : `flags: ${ids(r)}`;
  }],
  ["debt.overdue-amount", async () => {
    const r = await report(await filmOf("debt", "amount", [["film/s02-accounts.movas", '"Rui still owes R$ 90"', '"Rui still owes ninety"']]));
    return fires(r, "overdue.amount", "s02.statusB") && !fires(r, "overdue.amount", "s02.statusA") ? null : `flags: ${r.flags.map((f) => f.text).join(" | ").slice(0, 300)}`;
  }],
  ["debt.word-ban", async () => {
    const clean = await movas(await filmOf("debt", "ban0"), ["check"]);
    if (!clean.ok) return "the clean film fails check";
    const seeded = await movas(await filmOf("debt", "ban1", [["film/s03-plan.movas", '"A reminder, not a threat."', '"A reminder, not a lawsuit."']]), ["check"]);
    return !seeded.ok && seeded.text.includes("tone.threat") ? null : `check: ${seeded.text.slice(0, 300)}`;
  }],
  ["debt.no-chat-needed", async () => {
    const c = await movas(await filmOf("debt", "msg", [["film/s03-plan.movas", 'text calm @q.out "A reminder, not a threat."', 'msg calm in=c side=out @q.out "A reminder, not a threat."']]), ["check"]);
    return !c.ok && c.text.includes("format.needed") && c.text.includes("use chat") ? null : `check: ${c.text.slice(0, 300)}`;
  }],
  // Craft, each fault in the fixture's own program. debt.clean is the clean case of each.
  ["craft.jitter", async () => { const r = await report(await filmOf("debt", "jit", [SEED("jitter")])); return fires(r, "craft.jitter", "s02") ? null : `flags: ${ids(r)}`; }],
  ["craft.spike", async () => { const r = await report(await filmOf("debt", "spk", [SEED("spike")])); return fires(r, "craft.spike", "s02") ? null : `flags: ${ids(r)}`; }],
  ["craft.spike-limit", async () => { const r = await report(await filmOf("debt", "spk2", [SEED("spike"), ["film/meaning.txt", "use debt-reminder\n", "use debt-reminder\nlimit spike.px 500\n"]])); return !fires(r, "craft.spike") ? null : `a film's limit did not apply: ${ids(r)}`; }],
  ["craft.spike-off", async () => { const r = await report(await filmOf("debt", "spk3", [SEED("spike"), ["film/meaning.txt", "use debt-reminder\n", "use debt-reminder\noff craft.spike\n"]])); return !fires(r, "craft.spike") ? null : `off did not apply: ${ids(r)}`; }],
  ["craft.words-cut", async () => { const r = await report(await filmOf("debt", "cov", [SEED("cover")])); return fires(r, "craft.words_cut", "s02") ? null : `flags: ${ids(r)}`; }],
  ["craft.contrast", async () => { const r = await report(await filmOf("debt", "con", [SEED("contrast")])); return fires(r, "craft.contrast", "s02.status") ? null : `flags: ${ids(r)}`; }],
  ["craft.clip", async () => { const r = await report(await filmOf("debt", "clp", [SEED("clip")])); return fires(r, "craft.clip", "s02.note") ? null : `flags: ${ids(r)}`; }],
  ["craft.read", async () => { const r = await report(await filmOf("debt", "red", [["film/s01-notice.movas", "end @due+3s", "end @due+0.3s"]])); return fires(r, "craft.read", "s01.due") ? null : `flags: ${ids(r)}`; }],
  ["craft.snap", async () => { const r = await report(await filmOf("debt", "snp", [SEED("snap")])); return fires(r, "craft.snap", "s02") ? null : `flags: ${ids(r)}`; }],
  ["craft.flow", async () => {
    const d = await filmOf("debt", "flo", [SEED("flow")]);
    const p = await movas(d, ["render", "--preview"]);
    if (!p.ok) return `preview failed: ${p.text.slice(-300)}`;
    const r = await report(d, [`--file=${d}/.work/out/preview.mp4`]);
    return fires(r, "craft.flow", "s02") ? null : `flags: ${ids(r)}`;
  }],
  ["craft.sound", async () => {
    const d = await debtFilm();
    const clean = `${d}/.work/out/preview.mp4`;
    const seeded = async (name: string, af: string) => {
      const out = `${d}/.work/out/${name}.mp4`;
      const f = await sh("ffmpeg", ["-v", "error", "-y", "-i", clean, "-c:v", "copy", "-af", af, "-c:a", "aac", "-b:a", "192k", out]);
      if (!f.ok) throw new Error(f.err);
      return report(d, [`--file=${out}`]);
    };
    const loud = await seeded("loud", "volume=24dB");
    if (!fires(loud, "craft.clipping")) return `clipping: ${ids(loud)}`;
    const quiet = await seeded("quiet", "volume=enable='between(t,8,11)':volume=0");
    if (!fires(quiet, "craft.silence")) return `silence: ${ids(quiet)}`;
    const none = await report(d, ["--nofile"]);
    return none.cannot.some((l) => l.startsWith("- craft.clipping") && l.includes("no encoded file")) ? null : `no refusal without a file: ${none.cannot.join(" | ").slice(0, 300)}`;
  }],
  ["refuse.no-beat", async () => {
    const d = await debtFilm();
    const r = await report(d, [`--file=${d}/.work/out/preview.mp4`]);
    return r.cannot.some((l) => l.startsWith("- craft.bed") && l.includes("beat grid")) ? null : `craft.bed on a film with no beat grid must refuse: ${r.cannot.join(" | ").slice(0, 300)}`;
  }],
  ["refuse.no-sfx", async () => {
    // A film with a bed and no event sounds. craft.sync has nothing to measure, and says so.
    const d = await filmOf("debt", "nosfx", [["film/s01-notice.movas", " sfx=ui/drop_001:.5", ""], ["film/s02-accounts.movas", " sfx=ui/drop_002:.5", ""], ["film/s02-accounts.movas", " sfx=ui/drop_003:.5", ""], ["film/s03-plan.movas", " sfx=ui/drop_004:.5", ""]]);
    const p = await movas(d, ["render", "--preview"]);
    if (!p.ok) return `preview failed: ${p.text.slice(-300)}`;
    const r = await report(d, [`--file=${d}/.work/out/preview.mp4`]);
    return r.cannot.some((l) => l.startsWith("- craft.sync") && l.includes("no event sounds")) ? null : `no refusal: ${r.cannot.join(" | ").slice(0, 300)}`;
  }],
  ["refuse.gl", async () => {
    const r = await report(await filmOf("debt", "gl", [SEED("gl")]));
    return r.cannot.some((l) => l.startsWith("- craft.jitter") && l.includes("s02") && l.includes("GL content")) ? null : `no GL refusal: ${r.cannot.join(" | ").slice(0, 300)}`;
  }],
  ["runtime.seeded", async () => {
    const d = await filmOf("debt", "seeded");
    await Deno.writeTextFile(`${d}/film/programs/scenes/probe.js`, `import { loadThree, withSeeded } from "../lib.js";
export async function install({ extra }) {
  const { THREE } = await loadThree(7);
  let banned = false;
  try { new THREE.Object3D(); } catch { banned = true; }
  const uuid = withSeeded(7, () => new THREE.Object3D().uuid);
  extra.s01 = () => [{ op: "text", decor: true, text: (banned ? "banned " : "open ") + uuid, size: 40, weight: 600, color: "#ffffff", x: 40, y: 100, align: "left" }];
}
`);
    const scan = async () => {
      const r = await movas(d, ["film", "--nofile", "--section=flags"]);
      if (!r.ok) throw new Error(r.text.slice(-400));
      for await (const e of Deno.readDir(`${d}/.work`)) if (e.name.startsWith("film-scan-")) {
        const hit = /"tx":"((?:banned|open) [^"]+)"/.exec(await Deno.readTextFile(`${d}/.work/${e.name}`));
        await Deno.remove(`${d}/.work/${e.name}`);
        if (hit) return hit[1];
      }
      return "";
    };
    const a = await scan(), b = await scan();
    if (!a.startsWith("banned ")) return `the ban is not back after loadThree: ${a}`;
    if (a !== b) return `two runs differ: ${a} and ${b}`;
    const bad = await filmOf("debt", "seeded2");
    await Deno.writeTextFile(`${bad}/film/programs/scenes/probe.js`, `export async function install({ extra }) { extra.s01 = () => [{ op: "rect", x: Math.random() * 10, y: 0, w: 10, h: 10, color: "#fff" }]; }\n`);
    const f = await movas(bad, ["film", "--nofile", "--section=flags"]);
    return !f.ok && f.text.includes("Math.random is not available") ? null : `Math.random in a frame must fail: ${f.text.slice(-300)}`;
  }],
  ["runtime.seeded-overlap", async () => {
    // Two calls that overlap in time: the first to end must not put the ban back while the second still runs.
    const { withSeeded } = await import("../runtime/seeded.js");
    const keep = Math.random, ban = () => { throw new Error("banned"); };
    Math.random = ban;
    try {
      let endA = () => {}, endB = () => {};
      const a = withSeeded(1, () => new Promise<void>((r) => (endA = r))), b = withSeeded(2, () => new Promise<void>((r) => (endB = r)));
      endA(); await a;
      if (Math.random === ban) return "the first call to end put the ban back while the second still runs";
      endB(); await b;
      return Math.random === ban ? null : "the ban is not back after both ended";
    } finally { Math.random = keep; }
  }],
  ["doctor.skips-ds-store", async () => {
    const { listFiles } = await import("./doctor.ts");
    const d = await Deno.makeTempDir({ dir: WORK, prefix: "t-rules-ds-" });
    try {
      await Deno.mkdir(`${d}/sub`);
      for (const f of ["a.txt", ".DS_Store", "sub/.DS_Store", "sub/b.txt"]) await Deno.writeTextFile(`${d}/${f}`, "x");
      const got = (await listFiles(d)).join(",");
      return got === "a.txt,sub/b.txt" ? null : `listed: ${got}`;
    } finally { await Deno.remove(d, { recursive: true }); }
  }],
  ["check.meaning", async () => {
    const c = await movas(await filmOf("debt", "badm", [["film/meaning.txt", "use debt-reminder\n", "use debt-reminder\nnonsense here\n"]]), ["check"]);
    return !c.ok && c.text.includes("error meaning") && c.text.includes("film/meaning.txt:3") ? null : `check: ${c.text.slice(0, 300)}`;
  }],
  ["film.meaning-error", async () => {
    const f = await movas(await filmOf("debt", "badm2", [["film/meaning.txt", "use debt-reminder\n", "use debt-reminder\nnonsense here\n"]]), ["film", "--nofile"]);
    return f.code === 2 && f.text.includes("film/meaning.txt:3") ? null : `exit ${f.code}: ${f.text.slice(0, 300)}`;
  }],
  ["limits.min-text", async () => {
    const low = await movas(await filmOf("debt", "min0"), ["report", "--full"]);
    if (/min\.text s02\.note/.test(low.text)) return "the film's own 30 px rule was not read";
    const high = await movas(await filmOf("debt", "min1", [["film/rules.movas", "rule min.text px=30", "rule min.text px=48"]]), ["report", "--full"]);
    return /min\.text s02\.note/.test(high.text) ? null : `48 px did not fire: ${high.text.slice(-300)}`;
  }],
  ["limits.dead-air-fps", async () => {
    // 1.7 s at 24 fps is 41 frames: over 1.5 s, and under the 45 frames the old fixed number needed.
    const gap = async (name: string, secs: string) => {
      const d = await filmOf("debt", name, [["film/film.movas", "order s01 s02 s03", "order s01 s02 s03 s04"]]);
      await Deno.writeTextFile(`${d}/film/s04-gap.movas`, `scene s04 "Gap"\nend @start+${secs}s\n`);
      return (await movas(d, ["report", "--full"])).text;
    };
    if (!/dead\.air s04/.test(await gap("air1", "1.7"))) return "a 1.7 s gap at 24 fps did not fire";
    return /dead\.air s04/.test(await gap("air0", "1.2")) ? "a 1.2 s gap fired" : null;
  }],
  ["docs.pages", async () => {
    const chat = await movas(await filmOf("chat", "doc0"), ["brief"]);
    if (!chat.out.includes("The chat format")) return "a film with use chat has no chat page in its brief";
    const debt = await movas(await filmOf("debt", "doc1"), ["brief"]);
    if (debt.out.includes("The chat format") || /`msg/.test(debt.out)) return "a film with no chat reads about msg";
    const rules = await movas(`${WORK}/t-rules-doc1`, ["help", "rules"]);
    return rules.out.includes("A rule refuses rather than passes") ? null : "help rules";
  }],
  ["docs.no-rules-file", async () => {
    const d = await filmOf("debt", "norules");
    await Deno.remove(`${d}/film/rules.movas`);
    const h = await movas(d, ["help"]);
    return h.ok ? null : `help failed with no rules file: ${h.text.slice(-300)}`;
  }],
  // ---------- the chat pack, on the small chat film ----------
  ["chat.clean", async () => { const r = await report(await filmOf("chat", "chat")); return r.flags.length ? `flags: ${r.flags.map((f) => f.text).join(" | ").slice(0, 400)}` : null; }],
  ["chat.repeat", async () => {
    const r = await report(await filmOf("chat", "rep", [["film/s01-one.movas", '"Good. Anything else today?"', '"It is. Do you want the link?"']]));
    return fires(r, "chat.repeat", "s01.g") ? null : `flags: ${ids(r)}`;
  }],
  ["chat.repeat-two-panels", async () => {
    // The fixture repeats a reply in panel P and panel Q, and across scenes. Different conversations must not fire.
    const r = await report(await filmOf("chat", "rep2"));
    return !fires(r, "chat.repeat") ? null : `flags: ${ids(r)}`;
  }],
  ["chat.repeat-short", async () => {
    const r = await report(await filmOf("chat", "rep3", [["film/s01-one.movas", '"It is. Do you want the link?"', '"Yes, sure."'], ["film/s01-one.movas", '"Good. Anything else today?"', '"Yes, sure."']]));
    return !fires(r, "chat.repeat") ? null : `a repeat of 2 words must not fire: ${ids(r)}`;
  }],
  ["chat.sides", async () => {
    const r = await report(await filmOf("chat", "side", [["programs/formats/chat.js", "const bx = isOut ? x + innerW - met.w : x,", "const bx = isOut ? x : x + innerW - met.w,"]]));
    return fires(r, "sent.side") && fires(r, "recv.side") && !fires(r, "sent.fill") ? null : `flags: ${ids(r)}`;
  }],
  ["chat.sent-fill", async () => {
    const r = await report(await filmOf("chat", "fill", [["programs/formats/chat.js", 'out: "#d9fdd3"', 'out: "#58a6ff"']]));
    return fires(r, "sent.fill") && !fires(r, "recv.fill") ? null : `flags: ${ids(r)}`;
  }],
  ["chat.recv-fill", async () => {
    const r = await report(await filmOf("chat", "rfill", [["programs/formats/chat.js", 'in: "#ffffff"', 'in: "#58a6ff"']]));
    return fires(r, "recv.fill") && !fires(r, "sent.fill") ? null : `flags: ${ids(r)}`;
  }],
  ["chat.alike", async () => {
    const r = await report(await filmOf("chat", "alike", [["programs/formats/chat.js", 'in: "#ffffff"', 'in: "#d9fdd3"'], ["programs/formats/chat.js", "const bx = isOut ? x + innerW - met.w : x,", "const bx = x,"]]));
    return fires(r, "chat.sides") ? null : `flags: ${ids(r)}`;
  }],
  ["chat.second-speaker", async () => {
    // Two sent speakers, both green: no flag, since who speaks must not rest on bubble colour.
    const r = await report(await filmOf("chat", "spk", [["film/s01-one.movas", 'msg g in=conv side=out', 'msg g in=conv side=agent'], ["film/meaning.txt", "use chat\n", "use chat\nfact role side=agent sent\n"]]));
    if (r.flags.length) return `flags: ${ids(r)}`;
    // Without the fact line, s01.g lands under Cannot check (chat.undeclared-side). Here the rules must have read it.
    return r.cannot.some((l) => l.includes("s01.g")) ? `s01.g was refused, not checked: ${r.cannot.join(" | ").slice(0, 300)}` : null;
  }],
  ["chat.undeclared-side", async () => {
    const d = await filmOf("chat", "bot", [["film/s01-one.movas", "msg g in=conv side=out", "msg g in=conv side=bot"]]);
    const r = await report(d);
    return r.cannot.some((l) => l.includes("s01.g") && l.includes("Add: fact role side=bot")) ? null : `no refusal: ${r.cannot.join(" | ").slice(0, 300)}`;
  }],
  ["chat.scroll-is-not-clip", async () => {
    // The panel is short, so old lines scroll under the header. With the exempt line they do not flag. Without it, craft.clip fires, so the exemption is what passes them.
    const on = await report(await filmOf("chat", "scr"));
    if (fires(on, "craft.clip")) return `flagged with the exemption: ${ids(on)}`;
    const off = await report(await filmOf("chat", "scr2", [["tool/packs/chat.meaning", 'exempt craft.clip where verb=msg say="A line scrolling under a chat header is not clipping"\n', ""], ["tool/packs/chat.meaning", 'exempt craft.clip where panel~/./ drawn.inPanel=true say="A line inside a chat panel scrolls with it"\n', ""]]));
    return fires(off, "craft.clip") ? null : `no line in this film scrolls under the header, so this test proves nothing: ${ids(off)}`;
  }],
  ["chat.needs-use", async () => {
    const c = await movas(await filmOf("chat", "nouse", [["film/meaning.txt", "use chat\n", ""]]), ["check"]);
    return !c.ok && c.text.includes("format.needed") ? null : `check: ${c.text.slice(0, 300)}`;
  }],
  ["chat.needs-key", async () => {
    const c = await movas(await filmOf("chat", "nokey", [["film/s01-one.movas", "msg a in=conv side=in", "msg a in=conv"]]), ["check"]);
    return !c.ok && c.text.includes("format.key") ? null : `check: ${c.text.slice(0, 300)}`;
  }],
  ["chat.word-ban-scope", async () => {
    // The clean film has "Claro" on a received line in panel conv, out of the ban's scope.
    const clean = await movas(await filmOf("chat", "ban0"), ["check"]);
    if (!clean.ok) return `the clean film fails check: ${clean.text.slice(0, 300)}`;
    const seeded = await movas(await filmOf("chat", "ban1", [["film/s01-one.movas", '"Here it is, and thank you."', '"Claro, here it is."']]), ["check"]);
    return !seeded.ok && seeded.text.includes("voice.helper") ? null : `check: ${seeded.text.slice(0, 300)}`;
  }],
  ["refuse.two-panels", async () => {
    const d = await filmOf("chat", "pan", [["film/s02-two.movas", "tag label on=P @q2+1s", "tag label @q2+1s"], ["film/meaning.txt", "use chat\n", 'use chat\nrule t.panel where verb=tag need verb=msg same=panel say="x"\n']]);
    const r = await report(d);
    return r.cannot.some((l) => l.startsWith("- t.panel") && l.includes("s02.label")) ? null : `no refusal: ${r.cannot.join(" | ").slice(0, 400)}`;
  }],
];

await Deno.mkdir(WORK, { recursive: true });
await publicFolder();
let failed = 0, total = 0;
for (const [name, fn] of [...G, ...T]) {
  if (only.length && !only.includes(name)) continue;
  total++;
  try {
    const why = await fn();
    if (why === null) console.log(`PASS ${name}`); else { failed++; console.log(`FAIL ${name}: ${why}`); }
  } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message.slice(0, 400)}`); }
}
console.log(`${total - failed} of ${total} passed`);
Deno.exit(failed ? 1 : 0);
