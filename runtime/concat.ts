// Joins the chunk files into one video-only mp4 that hands ffmpeg's muxer the packets its concat demuxer would hand it.
// The concat demuxer probes every file it opens, and the probe decodes one 1080x1920 IDR per chunk: about 10 ms a chunk,
// 1.1 s for a 109-chunk film. One input is probed once.
// Same packets means: the same sample bytes (the demuxer's auto-inserted h264_mp4toannexb puts the SPS and PPS in front of
// every IDR, and the muxer turns them back into length-prefixed NAL units), and the same timestamps (the demuxer moves each
// file by the sum of the earlier files' durations, which their edit lists keep in milliseconds).
// Anything this reader does not expect throws, and the caller falls back to the concat demuxer.

type Box = { type: string; start: number; body: number; end: number };
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const i32 = (b: Uint8Array, o: number) => (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o), hdr = 8;
    const type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
    if (size === 1) { size = u64(b, o + 8); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) throw new Error(`bad box ${type} at ${o}`);
    out.push({ type, start: o, body: o + hdr, end: o + size });
    o += size;
  }
  return out;
}
const one = (b: Uint8Array, parent: Box | null, type: string): Box => {
  const all = boxes(b, parent ? parent.body : 0, parent ? parent.end : b.length).filter((x) => x.type === type);
  if (all.length !== 1) throw new Error(`expected one ${type}, found ${all.length}`);
  return all[0];
};
const maybe = (b: Uint8Array, parent: Box, type: string): Box | null => boxes(b, parent.body, parent.end).find((x) => x.type === type) ?? null;
const bytesOf = (b: Uint8Array, x: Box) => b.subarray(x.start, x.end);

type Chunk = { ftyp: Uint8Array; mvhd: Uint8Array; mdhd: Uint8Array; stsd: Uint8Array; tkhd: Uint8Array; hdlr: Uint8Array; vmhd: Uint8Array; dinf: Uint8Array; mvhdTs: number; segDur: number; mdhdTs: number; mediaTime: number; deltas: number[]; cts: number[]; sync: Set<number>; samples: Uint8Array[] };

function readChunk(b: Uint8Array): Chunk {
  const ftyp = one(b, null, "ftyp"), moov = one(b, null, "moov");
  const mvhd = one(b, moov, "mvhd"), trak = one(b, moov, "trak");
  const mv = b[mvhd.body];
  const mvhdTs = mv === 1 ? u32(b, mvhd.body + 20) : u32(b, mvhd.body + 12);
  const tkhd = one(b, trak, "tkhd"), edts = one(b, trak, "edts"), elst = one(b, edts, "elst");
  if (b[elst.body] !== 0 || u32(b, elst.body + 4) !== 1) throw new Error("expected one version-0 edit");
  const segDur = u32(b, elst.body + 8), mediaTime = i32(b, elst.body + 12);
  if (u32(b, elst.body + 16) !== 0x10000) throw new Error("edit rate is not 1");
  const mdia = one(b, trak, "mdia"), mdhd = one(b, mdia, "mdhd"), hdlr = one(b, mdia, "hdlr"), minf = one(b, mdia, "minf");
  if (b[mdhd.body] !== 0 || mv !== 0 || b[tkhd.body] !== 0) throw new Error("version-1 header box");
  const mdhdTs = u32(b, mdhd.body + 12);
  const vmhd = one(b, minf, "vmhd"), dinf = one(b, minf, "dinf"), stbl = one(b, minf, "stbl");
  const stsd = one(b, stbl, "stsd"), stts = one(b, stbl, "stts"), stsc = one(b, stbl, "stsc"), stsz = one(b, stbl, "stsz");
  const ctts = maybe(b, stbl, "ctts"), stss = maybe(b, stbl, "stss"), stco = maybe(b, stbl, "stco"), co64 = maybe(b, stbl, "co64");
  for (const t of ["sdtp", "sbgp", "sgpd", "subs", "saiz", "saio"]) if (maybe(b, stbl, t)) throw new Error(`unexpected ${t}`);
  if (u32(b, stsd.body + 4) !== 1) throw new Error("expected one sample description");
  const n = u32(b, stsz.body + 8), fixed = u32(b, stsz.body + 4);
  const sizes: number[] = []; for (let i = 0; i < n; i++) sizes.push(fixed || u32(b, stsz.body + 12 + 4 * i));
  const deltas: number[] = []; for (let e = 0, m = u32(b, stts.body + 4); e < m; e++) { const c = u32(b, stts.body + 8 + 8 * e), d = u32(b, stts.body + 12 + 8 * e); for (let k = 0; k < c; k++) deltas.push(d); }
  const cts: number[] = [];
  if (ctts) { const v = b[ctts.body]; for (let e = 0, m = u32(b, ctts.body + 4); e < m; e++) { const c = u32(b, ctts.body + 8 + 8 * e), d = v === 1 ? i32(b, ctts.body + 12 + 8 * e) : u32(b, ctts.body + 12 + 8 * e); for (let k = 0; k < c; k++) cts.push(d); } }
  else for (let i = 0; i < n; i++) cts.push(0);
  const sync = new Set<number>();
  if (stss) for (let e = 0, m = u32(b, stss.body + 4); e < m; e++) sync.add(u32(b, stss.body + 8 + 4 * e) - 1);
  else for (let i = 0; i < n; i++) sync.add(i);
  const offs: number[] = [];
  if (stco) for (let e = 0, m = u32(b, stco.body + 4); e < m; e++) offs.push(u32(b, stco.body + 8 + 4 * e));
  else if (co64) for (let e = 0, m = u32(b, co64.body + 4); e < m; e++) offs.push(u64(b, co64.body + 8 + 8 * e));
  else throw new Error("no chunk offsets");
  const runs: [number, number][] = []; for (let e = 0, m = u32(b, stsc.body + 4); e < m; e++) runs.push([u32(b, stsc.body + 8 + 12 * e), u32(b, stsc.body + 12 + 12 * e)]);
  const samples: Uint8Array[] = []; let si = 0;
  for (let ci = 0; ci < offs.length; ci++) {
    let per = 0; for (const [first, spc] of runs) if (first <= ci + 1) per = spc;
    let o = offs[ci];
    for (let k = 0; k < per && si < n; k++, si++) { if (o + sizes[si] > b.length) throw new Error("sample past end of file"); samples.push(b.subarray(o, o + sizes[si])); o += sizes[si]; }
  }
  if (samples.length !== n || deltas.length !== n || cts.length !== n) throw new Error("sample tables disagree");
  return { ftyp: bytesOf(b, ftyp), mvhd: bytesOf(b, mvhd), mdhd: bytesOf(b, mdhd), stsd: bytesOf(b, stsd), tkhd: bytesOf(b, tkhd), hdlr: bytesOf(b, hdlr), vmhd: bytesOf(b, vmhd), dinf: bytesOf(b, dinf), mvhdTs, segDur, mdhdTs, mediaTime, deltas, cts, sync, samples };
}

/** The sample description with its btrt payload zeroed: btrt carries each chunk's own bit rate, and the concat demuxer keeps the first file's codec parameters anyway. */
function descKey(stsd: Uint8Array): Uint8Array {
  const c = stsd.slice(), avc1 = boxes(c, 16, c.length)[0];
  if (avc1.type !== "avc1") throw new Error(`sample entry is ${avc1.type}`);
  for (const x of boxes(c, avc1.body + 78, avc1.end)) if (x.type === "btrt") c.fill(0, x.body, x.end);
  return c;
}

/** SPS and PPS from an avcC box body, each as a 4-byte length plus the NAL unit: what h264_mp4toannexb inserts, once the muxer has turned start codes back into lengths. */
function paramSets(stsd: Uint8Array): Uint8Array {
  const b = stsd, entry = 16; // stsd header 8 + version/flags 4 + count 4
  const avc1 = boxes(b, entry, b.length)[0];
  if (avc1.type !== "avc1") throw new Error(`sample entry is ${avc1.type}`);
  const avcC = boxes(b, avc1.body + 78, avc1.end).find((x) => x.type === "avcC");
  if (!avcC) throw new Error("no avcC");
  let o = avcC.body;
  if (b[o] !== 1 || (b[o + 4] & 3) !== 3) throw new Error("avcC is not version 1 with 4-byte lengths");
  const parts: Uint8Array[] = [];
  const nSps = b[o + 5] & 31; o += 6;
  for (let i = 0; i < nSps; i++) { const l = u16(b, o); parts.push(b.subarray(o + 2, o + 2 + l)); o += 2 + l; }
  const nPps = b[o]; o += 1;
  for (let i = 0; i < nPps; i++) { const l = u16(b, o); parts.push(b.subarray(o + 2, o + 2 + l)); o += 2 + l; }
  const out = new Uint8Array(parts.reduce((a, p) => a + 4 + p.length, 0)); let w = 0;
  for (const p of parts) { new DataView(out.buffer).setUint32(w, p.length); out.set(p, w + 4); w += 4 + p.length; }
  return out;
}

/** h264_mp4toannexb's state machine over length-prefixed samples: the parameter sets go in front of the first IDR slice of each IDR picture that carries none. */
function withParamSets(samples: Uint8Array[], ps: Uint8Array): Uint8Array[] {
  let newIdr = true, spsSeen = false, ppsSeen = false;
  return samples.map((s) => {
    const parts: Uint8Array[] = []; let o = 0, last = 0, changed = false;
    while (o < s.length) {
      if (o + 4 > s.length) throw new Error("truncated NAL length");
      const len = u32(s, o), type = s[o + 4] & 31;
      if (o + 4 + len > s.length || len < 2) throw new Error("bad NAL length");
      if (type === 7) { spsSeen = newIdr = true; }
      else if (type === 8) { ppsSeen = newIdr = true; if (!spsSeen) throw new Error("PPS before SPS in a sample"); }
      if (type === 5 && !newIdr && (s[o + 5] & 0x80)) newIdr = true;
      if (newIdr && type === 5 && !spsSeen && !ppsSeen) { parts.push(s.subarray(last, o), ps); last = o; changed = true; newIdr = false; }
      else if (newIdr && type === 5 && spsSeen && !ppsSeen) throw new Error("SPS without PPS in a sample");
      if (type === 1) { newIdr = true; spsSeen = false; ppsSeen = false; }
      o += 4 + len;
    }
    if (!changed) return s;
    parts.push(s.subarray(last));
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let w = 0; for (const p of parts) { out.set(p, w); w += p.length; }
    return out;
  });
}

class W {
  buf = new Uint8Array(1 << 16); n = 0;
  need(k: number) { if (this.n + k > this.buf.length) { const nb = new Uint8Array(Math.max(this.buf.length * 2, this.n + k)); nb.set(this.buf.subarray(0, this.n)); this.buf = nb; } }
  u8(v: number) { this.need(1); this.buf[this.n++] = v; }
  u32(v: number) { this.need(4); new DataView(this.buf.buffer).setUint32(this.n, v >>> 0); this.n += 4; }
  i32(v: number) { this.need(4); new DataView(this.buf.buffer).setInt32(this.n, v); this.n += 4; }
  bytes(b: Uint8Array) { this.need(b.length); this.buf.set(b, this.n); this.n += b.length; }
  box(type: string, f: () => void) { const at = this.n; this.u32(0); for (const c of type) this.u8(c.charCodeAt(0)); f(); new DataView(this.buf.buffer).setUint32(at, this.n - at); }
  out() { return this.buf.subarray(0, this.n); }
}
const patched = (src: Uint8Array, at: number, v: number) => { const c = src.slice(); new DataView(c.buffer).setUint32(at, v >>> 0); return c; };

/**
 * Writes `out`. Returns the frame count and the bit rate the concat demuxer would report: its stream keeps the first file's
 * codec parameters, whose bit rate the mov demuxer computes from that file's bytes and media duration. The muxer writes it
 * into the output's btrt box, so the caller passes it on with -b:v (in a stream copy that sets only the copied parameters).
 * Throws on any chunk this reader does not expect, before writing. `files` are the chunk files' bytes, as read.
 */
export async function joinChunks(paths: string[], out: string): Promise<{ frames: number; bytes: number; firstBitRate: number; files: Uint8Array<ArrayBuffer>[] }> {
  const files = await Promise.all(paths.map((p) => Deno.readFile(p)));
  const chunks = files.map(readChunk);
  const c0 = chunks[0];
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  const key0 = descKey(c0.stsd);
  for (const c of chunks) {
    if (!same(descKey(c.stsd), key0)) throw new Error("chunks do not share one sample description");
    if (c.mdhdTs !== c0.mdhdTs || c.mediaTime !== c0.mediaTime) throw new Error("chunks do not share timescale and edit");
  }
  const ps = paramSets(c0.stsd);
  const d0 = c0.deltas.reduce((a, b) => a + b, 0), b0 = c0.samples.reduce((a, x) => a + x.length, 0);
  const firstBitRate = Number((BigInt(b0) * 8n * BigInt(c0.mdhdTs) * 2n + BigInt(d0)) / (2n * BigInt(d0))); // av_rescale(data_size, time_scale * 8, duration)
  // Timestamps the concat demuxer gives: each file moves by the earlier files' durations in microseconds, rescaled to the track's time base and rounded to nearest.
  const media: number[] = [], sizes: number[] = [], cts: number[] = [], sync: number[] = [], data: Uint8Array[] = [];
  let startUs = 0n, total = 0;
  for (const c of chunks) {
    const shift = Number((startUs * BigInt(c0.mdhdTs) * 2n + 1000000n) / 2000000n); // round(startUs * ts / 1e6), startUs >= 0
    let d = 0;
    const smp = withParamSets(c.samples, ps);
    for (let i = 0; i < smp.length; i++) {
      if (c.sync.has(i)) sync.push(total + i + 1);
      media.push(shift + d); d += c.deltas[i]; cts.push(c.cts[i]); sizes.push(smp[i].length); data.push(smp[i]);
    }
    total += smp.length;
    // The file's duration as the demuxer reads it: the edit's segment, in the movie time scale. mvhd keeps one 1 ms longer on partial chunks.
    startUs += (BigInt(c.segDur) * 1000000n * 2n + BigInt(c.mvhdTs)) / (2n * BigInt(c.mvhdTs));
  }
  for (let i = 1; i < media.length; i++) if (media[i] <= media[i - 1]) throw new Error("timestamps would not rise");
  const deltas = media.map((m, i) => (i + 1 < media.length ? media[i + 1] - m : chunks[chunks.length - 1].deltas.at(-1)!));
  const mediaDur = media[media.length - 1] + deltas[deltas.length - 1];
  const seg = mediaDur; // presentation span: every sample's pts lies inside [mediaTime, mediaTime + seg)
  const ts = c0.mdhdTs, payload = sizes.reduce((a, s) => a + s, 0);
  if (mediaDur >= 2 ** 32 || payload + 4096 >= 2 ** 32) throw new Error("too long for 32-bit boxes");
  const rle = (v: number[]) => { const r: [number, number][] = []; for (const x of v) { const l = r[r.length - 1]; if (l && l[1] === x) l[0]++; else r.push([1, x]); } return r; };
  const build = (chunkOffset: number) => {
    const w = new W();
    w.bytes(c0.ftyp);
    w.box("moov", () => {
      w.bytes(patched(patched(c0.mvhd, 20, ts), 24, seg)); // mvhd time scale and duration: the movie uses the track's scale, so the edit needs no rounding
      w.box("trak", () => {
        w.bytes(patched(c0.tkhd, 28, seg)); // tkhd duration, in the movie time scale
        w.box("edts", () => w.box("elst", () => { w.u32(0); w.u32(1); w.u32(seg); w.i32(c0.mediaTime); w.u32(0x10000); }));
        w.box("mdia", () => {
          w.bytes(patched(c0.mdhd, 24, mediaDur));
          w.bytes(c0.hdlr);
          w.box("minf", () => {
            w.bytes(c0.vmhd); w.bytes(c0.dinf);
            w.box("stbl", () => {
              w.bytes(c0.stsd);
              const st = rle(deltas); w.box("stts", () => { w.u32(0); w.u32(st.length); for (const [c, d] of st) { w.u32(c); w.u32(d); } });
              w.box("stss", () => { w.u32(0); w.u32(sync.length); for (const s of sync) w.u32(s); });
              const neg = cts.some((x) => x < 0), ct = rle(cts);
              w.box("ctts", () => { w.u32(neg ? 0x01000000 : 0); w.u32(ct.length); for (const [c, d] of ct) { w.u32(c); w.i32(d); } });
              w.box("stsc", () => { w.u32(0); w.u32(1); w.u32(1); w.u32(sizes.length); w.u32(1); });
              w.box("stsz", () => { w.u32(0); w.u32(0); w.u32(sizes.length); for (const s of sizes) w.u32(s); });
              w.box("stco", () => { w.u32(0); w.u32(1); w.u32(chunkOffset); });
            });
          });
        });
      });
    });
    w.u32(8 + payload); for (const c of "mdat") w.u8(c.charCodeAt(0));
    return w.out();
  };
  const head0 = build(0), head = build(head0.length);
  if (head.length !== head0.length) throw new Error("header size moved");
  const f = await Deno.open(out, { write: true, create: true, truncate: true });
  try {
    const all = async (b: Uint8Array) => { let o = 0; while (o < b.length) o += await f.write(b.subarray(o)); };
    await all(head);
    // Coalesce into ~4 MB writes: the samples are views into the files read above.
    let buf = new Uint8Array(4 << 20), n = 0;
    for (const d of data) {
      if (n + d.length > buf.length) { await all(buf.subarray(0, n)); n = 0; if (d.length > buf.length) buf = new Uint8Array(d.length); }
      buf.set(d, n); n += d.length;
    }
    if (n) await all(buf.subarray(0, n));
  } finally { f.close(); }
  return { frames: sizes.length, bytes: head.length + payload, firstBitRate, files };
}
