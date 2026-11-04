// Audio as data. The mix is arithmetic over decoded clips: one bed, stems by class, gains from the solved score.
// Numbers from the audio lab: mono sources play at 0 dB; SFX rows are cut at sfxcap; one bed gain per film frame.
const SR = 48000;
const run = async (cmd: string[]) => { const p = await new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "piped" }).output(); if (!p.success) throw new Error(new TextDecoder().decode(p.stderr)); return p.stdout; };
async function decode(file: string, cacheDir: string): Promise<Float32Array> {
  const stat = await Deno.stat(file);
  const key = `${file.replace(/[^a-z0-9._-]/gi, "_")}.${stat.size}.f32`;
  const cached = `${cacheDir}/${key}`;
  try { const b = await Deno.readFile(cached); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); } catch { /* decode below */ }
  const probe = new TextDecoder().decode(await run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=channels", "-of", "csv=p=0", file])).trim();
  const af = probe === "1" ? ["-af", "pan=stereo|c0=c0|c1=c0"] : [];
  const raw = await run(["ffmpeg", "-v", "error", "-nostdin", "-i", file, ...af, "-ar", String(SR), "-ac", "2", "-f", "f32le", "-"]);
  await Deno.mkdir(cacheDir, { recursive: true }); await Deno.writeFile(cached, raw);
  const copy = new Uint8Array(raw); return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
}
export type MixOpts = { root: string; cache: string; music: any; sfxGain: number; duckFloor: number; release: number; capFrames: number; gains?: Record<string, number>; bedDelay?: number };
/** Returns stems and their sum as interleaved float32 stereo. A changed row costs only its own addition. */
export async function mix(solved: any, o: MixOpts) {
  const fps = solved.clock.fps ?? 30, spf = SR / fps, n = solved.durationFrames, L = Math.round(n * spf);
  const stems: Record<string, Float32Array> = { bed: new Float32Array(L * 2), impact: new Float32Array(L * 2), ui: new Float32Array(L * 2), synth: new Float32Array(L * 2), vo: new Float32Array(L * 2) };
  // Bed: one gain per frame. A film may have no music at all.
  const bed = o.music ? await decode(`${o.root}/${o.music.file}`, o.cache) : new Float32Array(0);
  const fin = Math.round((o.music?.fadein ?? 0) * fps), fout = Math.round((o.music?.fadeout ?? 0) * fps);
  const duck = new Float64Array(n); for (const h of solved.ducks) for (let f = Math.max(0, h - 1); f < Math.min(n, h + o.release * 5); f++) { const t = f - h; duck[f] = Math.max(duck[f], t < 1 ? 1 : Math.exp(-(t - 1) / o.release)); }
  for (const sp of solved.duckSpans ?? []) for (let f = Math.max(0, sp.from - 3); f < Math.min(n, sp.to + o.release); f++) duck[f] = 1;
  const trim = Math.round(solved.trimBeats * (spf * (solved.clock.fpb ?? 15)));
  const delay = o.bedDelay ?? 0, B = stems.bed;
  for (let f = 0; f < n; f++) {
    const fade = Math.min(1, fin ? f / fin : 1) * Math.min(1, fout ? (n - 1 - f) / (fout - 1) : 1);
    const g = (o.music?.gain ?? 1) * fade * (1 - (1 - o.duckFloor) * duck[f]);
    const a = Math.round(f * spf), z = Math.round((f + 1) * spf);
    for (let s = a; s < z; s++) { const j = (s - delay + trim) * 2; if (j >= 0 && j + 1 < bed.length) { B[s * 2] = bed[j] * g; B[s * 2 + 1] = bed[j + 1] * g; } }
  }
  // Rows.
  const capS = Math.round(o.capFrames * spf);
  const clips = new Map<string, Float32Array>();
  for (const r of solved.sfx) {
    let c = clips.get(r.file); if (!c) { c = await decode(`${o.root}/${r.file}`, o.cache); clips.set(r.file, c); }
    const T = stems[r.cls] ?? stems.ui, s = Math.round(r.frame * spf), len = Math.min(r.cls === "vo" ? Infinity : capS, c.length / 2, L - s), g = r.vol * o.sfxGain * (o.gains?.[r.cls] ?? 1);
    for (let i = 0; i < len * 2; i++) T[s * 2 + i] += c[i] * g;
  }
  const sum = new Float32Array(L * 2); for (const k in stems) { const t = stems[k]; for (let i = 0; i < L * 2; i++) sum[i] += t[i]; }
  return { stems, sum, L };
}
