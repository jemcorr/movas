// Helpers for the ops commands: content hashes with a cache keyed by file stat, copy-on-write clones for the
// runtime store, and the dead-key rule. Deno only. Used by cli.ts, doctor.ts and runtime/render.ts.

export const sha256Hex = async (bytes: BufferSource): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * File hashes keyed by path, size, times and inode. A file whose stat has not moved is not read again, so a warm
 * cache costs a stat per file. A file that changes moves its ctime, which a copy with the old mtime cannot fake.
 * Each save keeps only the entries used in that run, so the cache does not grow without bound.
 */
export class HashCache {
  private prev: Record<string, string> = {};
  private used: Record<string, string> = {};
  constructor(private file: string) {
    try { this.prev = JSON.parse(Deno.readTextFileSync(file)); } catch { /* first run */ }
  }
  async of(path: string): Promise<string> {
    const st = await Deno.stat(path);
    const key = `${path}|${st.size}|${st.mtime?.getTime() ?? 0}|${st.ctime?.getTime() ?? 0}|${st.ino ?? 0}`;
    const hit = this.used[key] ?? this.prev[key] ?? (await sha256Hex(await Deno.readFile(path)));
    this.used[key] = hit;
    return hit;
  }
  save(): void {
    Deno.mkdirSync(this.file.replace(/\/[^/]*$/, ""), { recursive: true });
    Deno.writeTextFileSync(this.file, JSON.stringify(this.used));
  }
}

/** A copy-on-write clone (APFS): instant, and no extra space until one side changes. */
export const cloneFile = async (src: string, dst: string): Promise<void> => {
  Deno.mkdirSync(dst.replace(/\/[^/]*$/, ""), { recursive: true });
  try { Deno.removeSync(dst); } catch { /* not there yet */ }
  const o = await new Deno.Command("cp", { args: ["-c", src, dst], stderr: "piped" }).output();
  if (!o.success) throw new Error(`cp -c ${src} ${dst}: ${new TextDecoder().decode(o.stderr).trim()}`);
};

/**
 * Score keys that no program read in any frame of the plan and that the compiler does not read. Only lines with an
 * id are checked, because programs can reach a line only through its id. A line whose kv was enumerated counts as
 * fully read, so a program that lists its keys cannot produce a false report.
 */
export const unreadKeys = (
  film: any, reads: Record<string, string[]>, enumerated: string[], compiler: Set<string>,
): { id: string; key: string }[] => {
  const skip = new Set(enumerated), out: { id: string; key: string }[] = [];
  for (const sc of Object.values<any>(film.scenes ?? {})) for (const l of sc.lines ?? []) {
    if (!l.id) continue;
    const id = `${sc.id}.${l.id}`;
    if (skip.has(id)) continue;
    const seen = new Set(reads[id] ?? []);
    for (const key of Object.keys(l.kv ?? {})) if (!seen.has(key) && !compiler.has(key)) out.push({ id, key });
  }
  return out;
};
