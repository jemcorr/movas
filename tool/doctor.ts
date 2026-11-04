// movas doctor: checks every file the render needs against the film's runtime.lock.json.
//   doctor            verify; one line per problem, each with its fix; exit 1 on a problem
//   doctor --freeze   write the lock from the files as they are now, and clone them into the store
//   doctor --restore  put back what is missing or changed, from the store
// MOVAS_RUNTIME_ROOT maps every locked path under a directory, so a test can run the whole check on a copy.
import { HashCache, cloneFile } from "./ops.ts";
import { loadFilm } from "./movas.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FILM_ROOT = Deno.env.get("MOVAS_FILM") ?? ROOT;
const WORK = Deno.env.get("MOVAS_WORK") ?? `${FILM_ROOT}/.work`;
const PUBLIC = Deno.env.get("MOVAS_PUBLIC") ?? "";
const RT = Deno.env.get("MOVAS_RUNTIME_ROOT") ?? "";
const LOCK = `${FILM_ROOT}/runtime.lock.json`, STORE = `${WORK}/store`;
// The whole build folder: three.module.js imports ./three.core.js from it, so the module alone does not load.
const THREE_ROOT = Deno.env.get("MOVAS_THREE") ?? "";
const THREE = THREE_ROOT ? `${THREE_ROOT}/build` : "";
const FIX = "./movas doctor --restore";

type Locked = { role: string; path: string; kind: "file"; sha256: string } | { role: string; path: string; kind: "folder"; files: Record<string, string> };
const real = (p: string) => `${RT}${p}`;
const decode = (b: Uint8Array) => new TextDecoder().decode(b).trim();

/** Finder writes .DS_Store into folders it shows, so it is never part of a locked folder. */
const skipped = (path: string) => path === ".DS_Store" || path.endsWith("/.DS_Store");
export const listFiles = async (dir: string, rel = ""): Promise<string[]> => {
  const out: string[] = [];
  for await (const e of Deno.readDir(rel ? `${dir}/${rel}` : dir)) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (skipped(r)) continue;
    if (e.isDirectory) out.push(...(await listFiles(dir, r)));
    else if (e.isFile) out.push(r);
  }
  return out.sort();
};

/** What the render needs, at the logical paths. A folder item covers every file in it. */
const wanted = async (): Promise<{ role: string; path: string; kind: "file" | "folder" }[]> => {
  const shell = Deno.env.get("MOVAS_SHELL");
  if (!shell) throw new Error("MOVAS_SHELL is not set. Add MOVAS_SHELL=<path of the headless shell binary> to .movasrc.");
  const items: { role: string; path: string; kind: "file" | "folder" }[] = [{ role: "shell", path: shell.replace(/\/[^/]*$/, ""), kind: "folder" }];
  for (const bin of ["ffmpeg", "ffprobe", "deno"]) {
    const p = decode((await new Deno.Command("which", { args: [bin], stdout: "piped", stderr: "null" }).output()).stdout);
    if (p) items.push({ role: bin, path: p, kind: "file" });
  }
  // The addons the programs import through the importmap (GLTFLoader, RoomEnvironment, Reflector, meshopt). A film with no three leaves MOVAS_THREE unset.
  if (THREE) {
    items.push({ role: "three", path: THREE, kind: "folder" });
    items.push({ role: "three-addons", path: `${THREE_ROOT}/examples/jsm`, kind: "folder" });
  }
  const page = await Deno.readTextFile(`${ROOT}/runtime/page.html`);
  for (const m of new Set([...page.matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((x) => x[1]))) items.push({ role: "font", path: `${PUBLIC}${m}`, kind: "file" });
  items.push({ role: "sfx", path: `${PUBLIC}/sfx`, kind: "folder" });
  const music = loadFilm(`${FILM_ROOT}/film`).music?.file;
  if (music) items.push({ role: "music", path: `${PUBLIC}/${music}`, kind: "file" });
  // Every model the score names: the page fetches them at install, so a missing one stops the render.
  for (const a of loadFilm(`${FILM_ROOT}/film`).assets) if (a.kv.file && a.kv.kind === "model") items.push({ role: "model", path: `${PUBLIC}/${a.kv.file}`, kind: "file" });
  return items;
};

const freeze = async (): Promise<number> => {
  const hc = new HashCache(`${WORK}/sha-cache.json`);
  const locked: Locked[] = []; let stored = 0;
  const keep = async (src: string, sha: string) => {
    try { await Deno.stat(`${STORE}/${sha}`); } catch { await cloneFile(src, `${STORE}/${sha}`); stored++; }
  };
  for (const it of await wanted()) {
    if (it.kind === "file") {
      const sha256 = await hc.of(real(it.path));
      await keep(real(it.path), sha256);
      locked.push({ role: it.role, path: it.path, kind: "file", sha256 });
    } else {
      const files: Record<string, string> = {};
      for (const rel of await listFiles(real(it.path))) {
        const sha = await hc.of(`${real(it.path)}/${rel}`);
        await keep(`${real(it.path)}/${rel}`, sha);
        files[rel] = sha;
      }
      locked.push({ role: it.role, path: it.path, kind: "folder", files });
    }
  }
  hc.save();
  Deno.writeTextFileSync(LOCK, JSON.stringify({ items: locked }, null, 1) + "\n");
  console.log(`froze ${locked.length} items; ${stored} new files in ${STORE}; lock ${LOCK}`);
  return 0;
};

type Missing = { role: string; file: string; sha: string; why: "MISSING" | "CHANGED" };
/** Every locked file that is missing or differs. */
const problems = async (): Promise<Missing[] | null> => {
  let lock: { items: Locked[] };
  try { lock = JSON.parse(Deno.readTextFileSync(LOCK)); } catch { return null; }
  const hc = new HashCache(`${WORK}/sha-cache.json`), out: Missing[] = [];
  const check = async (role: string, file: string, sha: string) => {
    try { if ((await hc.of(file)) !== sha) out.push({ role, file, sha, why: "CHANGED" }); }
    catch { out.push({ role, file, sha, why: "MISSING" }); }
  };
  for (const it of lock.items) {
    if (it.kind === "file") await check(it.role, real(it.path), it.sha256);
    else for (const [rel, sha] of Object.entries(it.files)) if (!skipped(rel)) await check(it.role, `${real(it.path)}/${rel}`, sha);
  }
  hc.save();
  return out;
};

/** One line per item with problems, and the fix. */
const report = (ps: Missing[]): void => {
  const byRole = new Map<string, Missing[]>();
  for (const p of ps) byRole.set(p.role, [...(byRole.get(p.role) ?? []), p]);
  for (const [role, list] of byRole) {
    const why = list.every((p) => p.why === "MISSING") ? "MISSING" : "CHANGED";
    const names = list.slice(0, 3).map((p) => p.file).join(", ") + (list.length > 3 ? `, and ${list.length - 3} more` : "");
    console.log(`${why} ${role}: ${list.length} ${list.length === 1 ? "file" : "files"}: ${names}. fix: ${FIX}`);
  }
};

const check = async (): Promise<number> => {
  const ps = await problems();
  if (ps === null) { console.log(`NO LOCK ${LOCK}. fix: ./movas doctor --freeze`); return 2; }
  if (ps.length) { report(ps); return 1; }
  console.log(`doctor: OK, ${(JSON.parse(Deno.readTextFileSync(LOCK)) as { items: unknown[] }).items.length} items verified`);
  return 0;
};

const restore = async (): Promise<number> => {
  const ps = await problems();
  if (ps === null) { console.log(`NO LOCK ${LOCK}. fix: ./movas doctor --freeze`); return 2; }
  let failed = 0;
  for (const p of ps) {
    try { await Deno.stat(`${STORE}/${p.sha}`); } catch {
      console.log(`CANNOT RESTORE ${p.role}: ${p.file} has no copy in ${STORE}. fix: put the original back, then ./movas doctor --freeze`);
      failed++; continue;
    }
    await cloneFile(`${STORE}/${p.sha}`, p.file);
    console.log(`restored ${p.file}`);
  }
  if (failed) return 1;
  const left = await problems();
  if (left?.length) { report(left); return 1; }
  console.log(`doctor: restored ${ps.length} ${ps.length === 1 ? "file" : "files"}; all items verify`);
  return 0;
};

export const doctor = async (args: string[]): Promise<number> => {
  if (args.includes("--freeze")) return freeze();
  if (args.includes("--restore")) return restore();
  return check();
};
