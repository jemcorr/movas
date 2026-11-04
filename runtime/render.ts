// movas render: compiles the score, opens the pinned shell on a local page, gets display-list hashes back with no pixels,
// draws only frames whose chunk is not cached, encodes closed-GOP chunks, and concatenates. No npm, no Remotion.
// Deno flags make the suite's own network rule real: only 127.0.0.1 is reachable.
//   deno run --allow-net=127.0.0.1 --allow-read --allow-write=<work> --allow-run=ffmpeg,ffprobe,<shell> --allow-env runtime/render.ts ...
import { compilerKeys, hashTree, loadFilm, solve } from "../tool/movas.ts";
import { HashCache, unreadKeys } from "../tool/ops.ts";
import { joinChunks } from "./concat.ts";
import { mix } from "./mix.ts";

const args = Object.fromEntries(Deno.args.filter((a) => a.startsWith("--")).map((a) => { const m = /^--([^=]+)(?:=(.*))?$/.exec(a)!; return [m[1], m[2] ?? "1"]; }));
if ("like-master" in args) { console.error("--like-master is gone: the bed starts on its score cue, with no extra delay. Remove the flag."); Deno.exit(2); }
const HERE = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// The film's root: its score in film/, its own programs in film/programs. The launcher sets MOVAS_FILM.
const ROOT = Deno.env.get("MOVAS_FILM") ?? HERE;
const PUBLIC = args.public ?? Deno.env.get("MOVAS_PUBLIC") ?? "";
if (!PUBLIC) { console.error("MOVAS_PUBLIC is not set. Add MOVAS_PUBLIC=<folder holding fonts/ and sfx/> to .movasrc."); Deno.exit(2); }
const RT = Deno.env.get("MOVAS_RUNTIME_ROOT") ?? ""; // Serves fonts, assets and three from a runtime root when one is set (tests and restores).
const SHELL = args.shell ?? Deno.env.get("MOVAS_SHELL") ?? "";
if (!SHELL) { console.error("MOVAS_SHELL is not set. Add MOVAS_SHELL=<path of the headless shell binary> to .movasrc."); Deno.exit(2); }
const THREE = Deno.env.get("MOVAS_THREE") ?? ""; // The three.js package folder. Only a film that imports three needs it.
const WORK = args.work ?? `${ROOT}/.work`;
const PORT = parseInt(args.port ?? "3517"), DBG = parseInt(args.dbg ?? "9334");
const filmDir = args.film ? (args.film.startsWith("/") ? args.film : `${Deno.cwd()}/${args.film}`) : `${ROOT}/film`;
const preview = "preview" in args, scale = parseFloat(args.scale ?? (preview ? "0.5" : "1"));
const preset = args.preset ?? (preview ? "veryfast" : "medium"), crf = args.crf ?? (preview ? "24" : "16"), threads = args.threads ?? "3", maxEnc = parseInt(args.encoders ?? "6");
const CHUNK = parseInt(args.chunk ?? "30"), outPath = args.out ?? `${WORK}/out/${preview ? "preview" : "master"}.mp4`;
const t = { start: performance.now() } as Record<string, number>;
const lap = (k: string) => { t[k] = performance.now() - t.start; };
// MOVAS_TRACE names a file inside the work directory. Each render appends its stage times there. It never stops a render.
const TRACE = Deno.env.get("MOVAS_TRACE");
const traceOut = (mode: string, extra: Record<string, unknown> = {}) => {
  if (!TRACE) return;
  const o: Record<string, unknown> = { step: "render.ts", mode, ...extra };
  for (const k of Object.keys(t)) if (k !== "start") o[k] = Math.round(t[k]);
  o.end = Math.round(performance.now() - t.start);
  try { Deno.writeTextFileSync(TRACE, JSON.stringify(o) + "\n", { append: true }); } catch { /* ignored */ }
};
// Frame numbers as merged [from, to) ranges, to exclusive: the redrawn spans that the summary reports as drawnRanges.
const mergeFrames = (frames: number[]): [number, number][] => {
  const out: [number, number][] = [];
  for (const f of [...frames].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && f <= last[1]) last[1] = Math.max(last[1], f + 1);
    else out.push([f, f + 1]);
  }
  return out;
};

// ---------- compile ----------
const film = await loadFilm(filmDir);
const solved: any = solve(film, PUBLIC);
const errs = solved.problems.filter((p: any) => p.level === "error");
if (errs.length) { for (const e of errs) console.error(`error ${e.code} ${e.loc ? `${e.loc.file}:${e.loc.line} ` : ""}${e.msg}`); if (!("force" in args)) Deno.exit(2); }
lap("compile");
const formatId = args.format ?? film.defaultFormat, format = film.formats[formatId];
if (!format) throw new Error(`no format ${formatId}`);
const scenesSorted = [...solved.scenes].sort((a: any, b: any) => a.startFrame - b.startFrame);

// Frames: whole film, chosen scenes, a range, or single stills.
let segments: { from: number; to: number }[] = [{ from: 0, to: solved.durationFrames }];
if (args.scenes) segments = args.scenes.split(",").map((id: string) => { const s = solved.scenes.find((x: any) => x.id === id); return { from: s.startFrame, to: s.endFrame }; });
if (args.range) { const [a, b] = args.range.split("-").map(Number); segments = [{ from: a, to: b }]; }
const stills: number[] | null = args.stills ? args.stills.split(",").map(Number) : null;
if (stills) segments = stills.map((f) => ({ from: f, to: f + 1 }));

// Chunks start on scene starts plus multiples of 30, so a scene that only moves keeps its cached frames.
const boundaries = new Set<number>([0, solved.durationFrames]);
scenesSorted.forEach((s: any, i: number) => { const next = scenesSorted[i + 1]?.startFrame ?? solved.durationFrames; for (let f = s.startFrame; f < next; f += CHUNK) boundaries.add(f); });
const bounds = [...boundaries].sort((a, b) => a - b);

// ---------- static server ----------
const MIME: Record<string, string> = { html: "text/html", js: "text/javascript", json: "application/json", woff2: "font/woff2", glb: "model/gltf-binary", png: "image/png", jpg: "image/jpeg", wasm: "application/wasm" };
let onSocket: ((s: WebSocket) => void) | null = null;
const early: { ws: WebSocket; msgs: MessageEvent[] }[] = [];
// Network block, the page side: the page may load only from its own origin and talk on its own websocket.
const CSP = "default-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:; connect-src 'self' ws://127.0.0.1:*";
// A program URL resolves to the film's own programs first, then to the tool's. The film's programs are always the root's: a temp copy of the score has no programs.
const programFile = (p: string) => { const own = `${ROOT}/film${p}`; try { Deno.statSync(own); return own; } catch { return `${HERE}${p}`; } };
const files = (p: string) => p.startsWith("/frames/") ? `${WORK}${p}` : p.startsWith("/runtime/") ? `${HERE}${p}` : p.startsWith("/programs/") ? programFile(p) : p.startsWith("/fonts/") || p.startsWith("/assets/") ? `${RT}${PUBLIC}${p.replace("/assets", "")}` : p.startsWith("/three/") ? (THREE ? `${RT}${THREE}${p.slice(6)}` : null) : null;
const server = Deno.serve({ port: PORT, hostname: "127.0.0.1", onListen() {} }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/pipe") {
    const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 0 });
    if (onSocket) onSocket(socket);
    else { const e = { ws: socket, msgs: [] as MessageEvent[] }; socket.binaryType = "arraybuffer"; socket.onmessage = (m) => e.msgs.push(m); early.push(e); }
    return response;
  }
  if (u.pathname === "/") return new Response(await Deno.readFile(`${HERE}/runtime/page.html`), { headers: { "content-type": "text/html", "content-security-policy": CSP } });
  const f = files(decodeURIComponent(u.pathname));
  if (!f && u.pathname.startsWith("/three/")) console.error("MOVAS_THREE is not set. Add MOVAS_THREE=<the three package folder> to .movasrc: a program imports three.");
  if (!f) return new Response("no", { status: 404 });
  try { return new Response(await Deno.readFile(f), { headers: { "content-type": MIME[f.split(".").pop()!] ?? "application/octet-stream", "cache-control": "no-store" } }); } catch { return new Response("missing", { status: 404 }); }
});

// ---------- shell ----------
// One profile per port, since `do` draws its still beside the preview.
const profile = `${WORK}/shell-profile-${PORT}`; await Deno.mkdir(profile, { recursive: true });
const shell = new Deno.Command(SHELL, { args: [`--remote-debugging-port=${DBG}`, "--use-angle=metal", `--window-size=${format.w},${format.h}`, "--force-device-scale-factor=1", "--hide-scrollbars", "--no-first-run", "--disable-gpu-vsync", "--disable-accelerated-2d-canvas", "--disable-frame-rate-limit", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", `--user-data-dir=${profile}`, "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1", `http://127.0.0.1:${PORT}/`], stdout: "null", stderr: "null" }).spawn();

// ---------- source hash: anything that can change pixels without changing a list ----------
const sha = async (b: BufferSource) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
// Lists hash what scene code decides. Only the compositor and GL programs can change pixels without changing a list.
const hashFiles = async (files: string[]) => { let acc = ""; for (const f of files.sort()) acc += await sha(await Deno.readFile(f)); return (await sha(new TextEncoder().encode(acc))).slice(0, 16); };
const runtimeKey = await hashFiles([`${HERE}/runtime/reelrt.js`, programFile("/programs/lib.js")]);
// Both program roots. A folder in the film's own programs replaces one of the same name in the tool's. Names run in descending order on every file system: a frame that holds two GL programs hashes both, in this order.
const PROGRAM_ROOTS = [`${HERE}/programs`, `${ROOT}/film/programs`];
const dirsOf = async (root: string) => { const out: string[] = []; try { for await (const e of Deno.readDir(root)) if (e.isDirectory) out.push(e.name); } catch { /* a tree may have only one root */ } return out; };
const programHash: Record<string, string> = {};
for (const root of PROGRAM_ROOTS) for (const name of (await dirsOf(root)).sort().reverse()) {
  if (name === "scenes" || name === "formats") continue;
  const fl: string[] = []; for await (const g of Deno.readDir(`${root}/${name}`)) if (g.name.endsWith(".js")) fl.push(`${root}/${name}/${g.name}`);
  if (fl.length) programHash[name] = await hashFiles(fl);
}
const encKey = (await sha(new TextEncoder().encode(`${runtimeKey}|${formatId}|${scale}|${preset}|${crf}|${CHUNK}|${film.fps}|${threads}`))).slice(0, 16);
const cacheDir = `${WORK}/cache/${formatId}-${scale}-${preset}-${crf}`; await Deno.mkdir(cacheDir, { recursive: true });
// Cache key completeness: the page's fonts and every clip, image and model the score names join the chunk key by content
// hash. A warm hash cache costs one stat per file. The GL renderer joins the key at plan time, once the page reports it.
const hc = new HashCache(`${WORK}/sha-cache.json`);
const contentOf = async (p: string) => { try { return await hc.of(p); } catch { return `missing:${p}`; } };
const fontUrls = [...new Set([...(await Deno.readTextFile(`${HERE}/runtime/page.html`)).matchAll(/url\((\/fonts\/[^)]+)\)/g)].map((m) => m[1]))].sort();
const fontKey = (await sha(new TextEncoder().encode((await Promise.all(fontUrls.map((u) => contentOf(`${PUBLIC}${u}`)))).join(",")))).slice(0, 16);
const mediaFiles = [...new Set([...solved.media.filter((m: any) => m.verb === "clip").map((m: any) => m.file), ...film.assets.filter((a: any) => a.kv.file && a.kv.kind !== "music").map((a: any) => a.kv.file)])].sort() as string[];
const mediaKey = (await sha(new TextEncoder().encode((await Promise.all(mediaFiles.map((f) => contentOf(`${PUBLIC}/${f}`)))).join(",")))).slice(0, 16);
hc.save();
const keyBase = (await sha(new TextEncoder().encode(`${encKey}|${fontKey}|${mediaKey}`))).slice(0, 16);
// Version id: a hash of every file the render reads, from the score, the programs, the runtime and the compiler. It goes into the mp4 comment.
// Thread count is not part of it: it changes the x264 bytes, so the manifest records it instead.
const versionTree = { film: hashTree(filmDir), programs: hashTree(`${HERE}/programs`), runtime: hashTree(`${HERE}/runtime`), tool: hashTree(`${HERE}/tool`) };
const versionId = (await sha(new TextEncoder().encode(JSON.stringify(versionTree)))).slice(0, 16);

// Every program directory with an install.js and every scene module joins the film unless --modules names a subset.
const moduleSet = new Set<string>();
for (const root of PROGRAM_ROOTS) for (const name of await dirsOf(root)) {
  if (name === "formats") continue;
  if (name === "scenes") { for await (const g of Deno.readDir(`${root}/scenes`)) if (g.name.endsWith(".js")) moduleSet.add(`/programs/scenes/${g.name}`); continue; }
  try { await Deno.stat(`${root}/${name}/install.js`); moduleSet.add(`/programs/${name}/install.js`); } catch { /* not a module */ }
}
for (const name of film.uses ?? []) { try { await Deno.stat(`${HERE}/programs/formats/${name}.js`); moduleSet.add(`/programs/formats/${name}.js`); } catch { /* a pack with no drawing */ } }
const autoModules = [...moduleSet].sort();
// ---------- protocol ----------
const tw = Math.round((format.w * scale) / 2) * 2, th = Math.round((format.h * scale) / 2) * 2;
const finish = (code = 0) => { try { shell.kill("SIGKILL"); } catch { /* gone */ } server.shutdown(); if (code) Deno.exit(code); };
const failTimer = setTimeout(() => { console.error("page did not answer"); finish(3); }, parseInt(args.timeout ?? "600") * 1000);

const encoder = (out: string) => {
  const c = new Deno.Command("ffmpeg", { args: ["-v", "error", "-nostdin", "-y", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", `${tw}x${th}`, "-r", String(film.fps), "-i", "-", "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv", ...(preset === "vt" ? ["-c:v", "h264_videotoolbox", "-q:v", crf, "-allow_sw", "0", "-g", String(CHUNK), "-profile:v", "high"] : ["-c:v", "libx264", "-preset", preset, "-crf", crf, "-g", String(CHUNK), "-keyint_min", String(CHUNK), "-sc_threshold", "0", "-threads", threads]), "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-an", out], stdin: "piped", stdout: "null", stderr: "piped" }).spawn();
  return c;
};

let plan: any = null, report: any = {};
const blocked: string[] = [], renames: [string, string][] = []; // Chunks land in the cache only after the run is known to be clean.
lap("keys");
const result = await new Promise<any>((resolve, reject) => {
  onSocket = (ws) => {
    ws.binaryType = "arraybuffer";
    let chunks: { id: string; frames: number[]; path: string }[] = [], ci = 0, fi = 0;
    let cur: { child: Deno.ChildProcess; writer: WritableStreamDefaultWriter<Uint8Array>; tmp: string; path: string } | null = null;
    const running: Promise<void>[] = []; let frameCount = 0; const pixHashes: string[] = [];
    const open = async () => {
      while (running.length >= maxEnc) await Promise.race(running);
      const c = chunks[ci], tmp = `${c.path}.tmp.mp4`, child = encoder(tmp), writer = child.stdin.getWriter();
      cur = { child, writer, tmp, path: c.path };
    };
    const close = () => {
      const k = cur!; cur = null;
      const p: Promise<void> = (async () => {
        await k.writer.close();
        const st = await k.child.output(); if (!st.success) throw new Error(new TextDecoder().decode(st.stderr));
        renames.push([k.tmp, k.path]);
      })().finally(() => { running.splice(running.indexOf(p), 1); });
      running.push(p);
    };
    let chain: Promise<void> = Promise.resolve();
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") {
        const buf = new Uint8Array(e.data);
        chain = chain.then(async () => {
          if (!cur) await open();
          if ("pixhash" in args) pixHashes.push((await sha(buf)).slice(0, 16));
          await cur!.writer.write(buf); frameCount++;
          fi++; if (fi >= chunks[ci].frames.length) { close(); fi = 0; ci++; }
          ws.send('{"t":"ack"}');
        }).catch(reject);
        return;
      }
      const m = JSON.parse(e.data);
      if (m.t === "hello") {
        lap("hello");
        ws.send(JSON.stringify({ t: "job", solved, format, formatId, scale, segments, salt: 0, checks: !("nochecks" in args) && !stills, programHash, scan: !!args.scanOut, window: parseInt(args.window ?? "12"), ring: parseInt(args.ring ?? "6"), modules: args.modules !== undefined ? args.modules.split(",").filter(Boolean) : autoModules }));
      } else if (m.t === "gl") report.gl = m;
      else if (m.t === "blocked") blocked.push(m.msg);
      else if (m.t === "error") reject(new Error([m.msg, ...new Set(blocked)].join("\n")));
      else if (m.t === "scan") { for (const [f, items] of m.rows) Deno.writeTextFileSync(args.scanOut, JSON.stringify([f, items]) + "\n", { append: true }); }
      else if (m.t === "plan") {
        if (blocked.length) { reject(new Error(`render stopped, network blocked: ${blocked.join("; ")}`)); return; }
        lap("plan"); plan = m; report.planMs = m.planMs;
        m.checks.deadKeys = unreadKeys(solved.film, m.kvReads ?? {}, m.kvEnum ?? [], compilerKeys());
        if (args.planOut) Deno.writeTextFileSync(args.planOut, JSON.stringify({ frames: m.frames, hashes: m.hashes, irLengths: m.irLengths, planMs: m.planMs }));
        if ("planOnly" in args && args.checksOut) Deno.writeTextFileSync(args.checksOut, JSON.stringify(m.checks));
        if ("planOnly" in args) { console.log(JSON.stringify({ frames: m.frames.length, irBytes: m.irLengths.reduce((a: number, b: number) => a + b, 0), planMs: m.planMs })); traceOut("plan", { planMs: Math.round(m.planMs) }); try { shell.kill("SIGKILL"); } catch { /* gone */ } Deno.exit(0); }
        const byFrame = new Map<number, string>(m.frames.map((f: number, i: number) => [f, m.hashes[i]]));
        const need: any[] = [], all: any[] = [], seen = new Set<string>();
        (async () => {
          if (stills) { for (const f of stills) need.push({ frames: [f] }); chunks = stills.map((f) => ({ id: `still${f}`, frames: [f], path: `${WORK}/stills/${f}.h264.mp4` })); await Deno.mkdir(`${WORK}/stills`, { recursive: true }); ws.send(JSON.stringify({ t: "need", chunks: need })); return; }
          for (let b = 0; b < bounds.length - 1; b++) {
            const frames: number[] = []; for (let f = bounds[b]; f < bounds[b + 1]; f++) if (byFrame.has(f)) frames.push(f);
            if (!frames.length) continue;
            const id = (await sha(new TextEncoder().encode(`${keyBase}|${report.gl?.renderer ?? ""}|${frames.map((f) => byFrame.get(f)).join(",")}`))).slice(0, 32);
            const path = `${cacheDir}/${id}.mp4`; const chunk = { id, frames, path };
            all.push(chunk);
            if (seen.has(id)) continue; seen.add(id); // Identical frames share one chunk file.
            try { if ("nocache" in args) throw 0; await Deno.stat(path); } catch { need.push(chunk); }
          }
          report.chunks = all.length; report.chunksDrawn = need.length; report.framesDrawn = need.reduce((a, c) => a + c.frames.length, 0); report.framesTotal = m.frames.length;
          report.drawnRanges = mergeFrames(need.flatMap((c) => c.frames));
          chunks = need; report.all = all;
          ws.send(JSON.stringify({ t: "need", chunks: need.map((c) => ({ frames: c.frames })) }));
        })().catch(reject);
      } else if (m.t === "done") {
        chain.then(async () => {
          await Promise.all(running);
          if (blocked.length) { for (const [t] of renames) await Deno.remove(t).catch(() => {}); throw new Error(`render stopped, network blocked: ${blocked.join("; ")}`); }
          for (const [t, p] of renames) await Deno.rename(t, p);
          lap("frames"); report.draw = m; report.pixHashes = pixHashes; resolve(report);
        }).catch(reject);
      }
    };
  };
  // A fast shell can reach /pipe before this handler exists (15 ms against about 200 ms of file hashing). Those sockets wait in `early`, with their messages kept.
  for (const e of early.splice(0)) { onSocket(e.ws); for (const m of e.msgs) e.ws.onmessage?.(m); }
}).catch((e) => { console.error(String(e?.stack ?? e)); finish(4); throw e; });
clearTimeout(failTimer);
try { shell.kill("SIGKILL"); } catch { /* gone */ }
server.shutdown();

const checks = plan.checks;
if (args.checksOut) await Deno.writeTextFile(args.checksOut, JSON.stringify(checks, null, 1));
if (stills) {
  const dir = args.out ?? `${WORK}/stills`; await Deno.mkdir(dir, { recursive: true });
  for (const f of stills) await new Deno.Command("ffmpeg", { args: ["-v", "error", "-nostdin", "-y", "-i", `${WORK}/stills/${f}.h264.mp4`, "-frames:v", "1", `${dir}/${String(f).padStart(5, "0")}.png`] }).output();
  console.log(JSON.stringify({ stills: dir, gl: report.gl?.renderer, ms: Math.round(performance.now() - t.start) }));
  traceOut("stills", { planMs: Math.round(report.planMs ?? 0) });
  Deno.exit(0);
}

// ---------- audio ----------
const audioOut = `${WORK}/audio.m4a`;
let audioMs = 0;
if (!("noaudio" in args) && !args.scenes && !args.range) {
  const a0 = performance.now();
  const f32 = `${WORK}/mix.f32`;
  const mixOpts = { root: PUBLIC, cache: `${WORK}/clips`, music: film.music, sfxGain: parseFloat(args.sfxgain ?? String(film.sfxGain)), duckFloor: film.duck?.gain ?? 0.6, release: 8, capFrames: 90, bedDelay: parseFloat(args.beddelay ?? "0") };
  // The mix is a pure function of the sound rows, the clip files and these options. The same inputs reuse the same file, so a note that moves no sound does not mix again.
  const sized = await Promise.all([...new Set([...solved.sfx.map((r: any) => r.file), film.music?.file].filter(Boolean))].sort().map(async (f) => `${f}:${(await Deno.stat(`${PUBLIC}/${f}`)).size}`));
  const audioKey = (await sha(new TextEncoder().encode(JSON.stringify({ sfx: solved.sfx, ducks: solved.ducks, duckSpans: solved.duckSpans ?? [], clock: solved.clock, trim: solved.trimBeats, n: solved.durationFrames, o: { ...mixOpts, root: "", cache: "" }, preview, sized, mix: await sha(await Deno.readFile(`${HERE}/runtime/mix.ts`)) })))).slice(0, 24);
  const keptAudio = `${WORK}/audio-cache/${audioKey}.m4a`;
  const samples = Math.round(solved.durationFrames * (48000 / (solved.clock.fps ?? 30)));
  let audioHit = false;
  try { await Deno.copyFile(keptAudio, audioOut); audioHit = true; } catch { /* mix below */ }
  if (!audioHit) {
    const { sum, L } = await mix(solved, mixOpts);
    await Deno.writeFile(f32, new Uint8Array(sum.buffer));
    const p = await new Deno.Command("ffmpeg", { args: ["-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", f32, "-c:a", "aac_at", "-b:a", preview ? "128k" : "320k", audioOut], stderr: "piped" }).output();
    if (!p.success) throw new Error(new TextDecoder().decode(p.stderr));
    if (L !== samples) throw new Error(`mix length ${L} is not the expected ${samples}`);
    await Deno.mkdir(`${WORK}/audio-cache`, { recursive: true });
    await Deno.copyFile(audioOut, keptAudio);
  }
  audioMs = performance.now() - a0; report.samples = samples;
}
lap("audio");

// ---------- concat ----------
await Deno.mkdir(outPath.replace(/\/[^/]*$/, ""), { recursive: true });
// The chunks join in this process: concat.ts writes the packets the concat demuxer would, which costs that demuxer about 10 ms a file
// (it decodes a frame to probe each one). One ffmpeg call then muxes the audio and moves the index to the front, as before.
// Any chunk the joiner does not expect falls back to the demuxer.
const joinedPath = `${WORK}/joined.mp4`;
let inputs: string[], outOpts: string[] = [];
try { const j = await joinChunks(report.all.map((c: any) => c.path), joinedPath); inputs = ["-i", joinedPath]; outOpts = ["-b:v", String(j.firstBitRate)]; }
catch (e) {
  console.error(`note concat.fallback ${(e as Error).message}`);
  const list = `${WORK}/concat.txt`;
  await Deno.writeTextFile(list, report.all.map((c: any) => `file '${c.path}'`).join("\n") + "\n");
  inputs = ["-f", "concat", "-safe", "0", "-i", list];
}
const hasAudio = !("noaudio" in args) && !args.scenes && !args.range;
const c = await new Deno.Command("ffmpeg", { args: ["-v", "error", "-nostdin", "-y", ...inputs, ...(hasAudio ? ["-i", audioOut] : []), "-c", "copy", ...outOpts, "-movflags", "+faststart", "-metadata", `comment=movas:${versionId}`, outPath], stderr: "piped" }).output();
if (!c.success) throw new Error(new TextDecoder().decode(c.stderr));
if (outOpts.length) Deno.remove(joinedPath).catch(() => {});
lap("concat");
const stat = await Deno.stat(outPath);
// Read the output back. A render that reports success must have written what it was asked to write.
const conform = async () => {
  const p = await new Deno.Command("ffprobe", { args: ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,width,height,avg_frame_rate,nb_read_packets,duration,color_primaries,color_transfer,color_space,color_range", "-of", "json", outPath], stdout: "piped", stderr: "piped" }).output();
  if (!p.success) return { ok: false, problems: [`ffprobe: ${new TextDecoder().decode(p.stderr).trim()}`] };
  const streams = JSON.parse(new TextDecoder().decode(p.stdout)).streams as any[];
  const v = streams.find((x) => x.codec_type === "video"), a = streams.find((x) => x.codec_type === "audio");
  const problems: string[] = [];
  if (!v) return { ok: false, problems: ["no video stream"] };
  const [n, d] = String(v.avg_frame_rate).split("/").map(Number), fps = n / (d || 1);
  const want = report.framesTotal, durWant = want / film.fps, vDur = parseFloat(v.duration);
  if (v.width !== tw || v.height !== th) problems.push(`size ${v.width}x${v.height}, expected ${tw}x${th}`);
  if (Math.abs(fps - film.fps) > 0.01) problems.push(`frame rate ${fps}, expected ${film.fps}`);
  if (parseInt(v.nb_read_packets) !== want) problems.push(`${v.nb_read_packets} video frames, expected ${want}`);
  if (Math.abs(vDur - durWant) > 1 / film.fps + 1e-3) problems.push(`video lasts ${vDur} s, expected ${durWant} s`);
  if (hasAudio) {
    if (!a) problems.push("no audio stream");
    else if (Math.abs(parseFloat(a.duration) - durWant) > 0.1) problems.push(`audio lasts ${a.duration} s, video ${durWant} s`);
  }
  for (const [k, w] of [["color_primaries", "bt709"], ["color_transfer", "bt709"], ["color_space", "bt709"], ["color_range", "tv"]]) if (v[k] !== w) problems.push(`${k} is ${v[k]}, expected ${w}`);
  return { ok: problems.length === 0, problems, read: { w: v.width, h: v.height, fps, frames: parseInt(v.nb_read_packets), videoSec: vDur, audioSec: a ? parseFloat(a.duration) : null } };
};
const conformance = await conform();
lap("conform");
const summary = {
  out: outPath, bytes: stat.size, renderer: report.gl?.renderer, frames: report.framesTotal, framesDrawn: report.framesDrawn, drawnRanges: report.drawnRanges, chunks: report.chunks, chunksDrawn: report.chunksDrawn,
  ms: { compile: Math.round(t.compile), plan: Math.round(t.plan - t.compile), planInPage: Math.round(report.planMs), frames: Math.round(t.frames - t.plan), audio: Math.round(audioMs), concat: Math.round(t.concat - t.audio), total: Math.round(t.concat) },
  page: report.draw ? { drawMs: Math.round(report.draw.drawMs), readMs: Math.round(report.draw.readMs), sendMs: Math.round(report.draw.sendMs), waitMs: Math.round(report.draw.waitMs ?? 0), loopMs: Math.round(report.draw.loopMs ?? 0), drawCalls: report.draw.drawCalls, bakes: report.draw.bakes } : null,
  problems: solved.problems.length, conformance,
  checks: { texts: checks.texts?.length, belowMin: (checks.texts ?? []).filter((x: any) => x.minPx < parseFloat(film.rules?.find((r: any) => r.id === "min.text")?.kv.px ?? "NaN")).length, collisions: checks.collisions?.length, occluded: Object.keys(checks.occluded ?? {}).length, offFrame: Object.keys(checks.offFrame ?? {}).length, deadKeys: checks.deadKeys?.length },
};
// Manifest beside the file: what made it, so a rebuild can check its bytes against this record.
const firstLine = async (cmd: string, a: string[]) => new TextDecoder().decode((await new Deno.Command(cmd, { args: a, stdout: "piped", stderr: "null" }).output()).stdout).split("\n")[0].trim();
const manifest = {
  out: outPath, bytes: stat.size, sha256: await sha(await Deno.readFile(outPath)), comment: `movas:${versionId}`,
  version: { id: versionId, trees: versionTree, shadowHead: args.shadow || null, dirty: args.dirty === undefined ? null : args.dirty === "1" },
  shell: { path: SHELL, version: await firstLine(SHELL, ["--version"]) }, gl: report.gl ?? null, ffmpeg: await firstLine("ffmpeg", ["-version"]),
  encoder: { format: formatId, w: tw, h: th, fps: film.fps, scale, preset, crf, threads, chunk: CHUNK, pixFmt: "yuv420p", encKey, keyBase, audio: hasAudio ? "aac_at" : "none", audioBitrate: preview ? "128k" : "320k" },
  range: args.range ?? null, nocache: "nocache" in args, frames: report.framesTotal, framesDrawn: report.framesDrawn,
  chunks: await Promise.all(report.all.map(async (c: any) => ({ id: c.id, from: c.frames[0], frames: c.frames.length, sha256: await sha(await Deno.readFile(c.path)) }))),
};
await Deno.writeTextFile(`${outPath}.manifest.json`, JSON.stringify(manifest, null, 1));
if ("pixhash" in args) await Deno.writeTextFile(args.pixhash === "1" ? `${WORK}/pixhash.json` : args.pixhash, JSON.stringify(report.pixHashes));
console.log(JSON.stringify(summary, null, 1));
if (!conformance.ok) { for (const m of conformance.problems) console.error(`error output.conformance ${m}`); Deno.exit(5); }
traceOut("render", { framesDrawn: report.framesDrawn, frames: report.framesTotal, chunksDrawn: report.chunksDrawn, audioMs: Math.round(audioMs), planMs: Math.round(report.planMs ?? 0), page: summary.page });
Deno.exit(0);
