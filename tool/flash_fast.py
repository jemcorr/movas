#!/usr/bin/env python3
"""General flash check for `./movas verify`: WCAG 2.2 SC 2.3.1, general flashes, the 30 cm phone field only.

Same formulas, sizes and limits as prototypes/checks/flash.py, on the same decoded frames. That script also computes red
flashes and four more fields, and it reads every frame in one process. `verify` only uses this one number, so this file
computes only that number, skips the area test when too few pixels changed, and splits the work across threads.
prototypes/v2/profile/flash_equal.py compares the two on the film and on the seeded control clips.

--ranges=a-b,c-d (b exclusive) checks those frames plus --margin frames on each side. A 1-second window that touches a
changed frame lies inside that margin, and a window that touches no changed frame gives the same count it gave before.

Prints one line that `verify` reads:
WCAG phone30 general changes=<n> max/1s=<n> (start <s>) verdict=PASS|FAIL
"""
import argparse
import concurrent.futures as cf
import json
import math
import os
import re
import subprocess
import sys

import numpy as np

AW, AH = 270, 480
LAG, DL, DARK, AREA, LIMIT, WIN = 10, 0.10, 0.80, 0.25, 6, 30
FRAME_BYTES = AW * AH * 3
VF = f"scale={AW}:{AH}:flags=area:in_color_matrix=bt709:in_range=tv,format=rgb24"
FIELD = int(round(2.0 * 300 * math.tan(math.radians(5.0)) * AW / 70.0))  # 10 degrees at 30 cm on a 70 mm wide screen
NEED = AREA * FIELD * FIELD  # fewer changed pixels than this cannot fill 25% of a field

_v = np.arange(256, dtype=np.float64) / 255.0
LUT = np.where(_v <= 0.04045, _v / 12.92, ((_v + 0.055) / 1.055) ** 2.4).astype(np.float32)
LR, LG, LB = LUT * 0.2126, LUT * 0.7152, LUT * 0.0722


def fills_field(mask):
    """True when some FIELD x FIELD window of the mask is at least 25% set."""
    if np.count_nonzero(mask) < NEED:
        return False
    s = np.zeros((AH + 1, AW + 1), np.int32)
    s[1:, 1:] = np.cumsum(np.cumsum(mask, axis=0, dtype=np.int32), axis=1)
    sums = s[FIELD:, FIELD:] - s[:-FIELD, FIELD:] - s[FIELD:, :-FIELD] + s[:-FIELD, :-FIELD]
    return float(sums.max()) / float(FIELD * FIELD) >= AREA


def analyse(path, lo, hi, fps):
    """Rise and fall per frame for frames lo-1 .. hi-1, as booleans. Frames before that only fill the lag window."""
    first = max(0, lo - 1 - LAG)
    cmd = ["ffmpeg", "-v", "error", "-nostdin"]
    if first > 0:
        cmd += ["-ss", f"{(first - 0.5) / fps:.6f}"]  # half a frame early: frame stamps sit about 1 ms before their grid point
    # Passthrough: a seek can otherwise repeat its first frame, and every frame index after it would be off by one.
    cmd += ["-i", path, "-map", "0:v:0", "-fps_mode", "passthrough", "-frames:v", str(hi - first), "-vf", VF, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=FRAME_BYTES * 4)
    ring = np.empty((LAG, AH, AW), np.float32)
    count, pos, f = 0, 0, first
    start = max(0, lo - 1)
    rise, fall = np.zeros(hi - start, bool), np.zeros(hi - start, bool)
    try:
        while f < hi:
            buf = proc.stdout.read(FRAME_BYTES)
            if len(buf) < FRAME_BYTES:
                break
            rgb = np.frombuffer(buf, np.uint8).reshape(AH, AW, 3)
            L = LR[rgb[..., 0]] + LG[rgb[..., 1]] + LB[rgb[..., 2]]
            if count and f >= start:
                held = ring[:count]
                lmin, lmax = held.min(axis=0), held.max(axis=0)
                rise[f - start] = fills_field((L - lmin >= DL) & (lmin < DARK))
                fall[f - start] = fills_field((lmax - L >= DL) & (L < DARK))
            ring[pos] = L
            pos = (pos + 1) % LAG
            count = min(LAG, count + 1)
            f += 1
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()
    if f < hi:
        raise RuntimeError(f"expected frames up to {hi}, the decoder stopped at {f}")
    return start, rise, fall


def onsets(q, base):
    """Frames where a run starts. Index 0 is one frame before the frames asked for, unless the span begins at frame 0."""
    prev = np.concatenate(([False], q[:-1]))
    frames = np.nonzero(q & ~prev)[0] + base
    return frames


def worst_window(frames):
    a = np.sort(np.asarray(frames, dtype=np.int64))
    if a.size == 0:
        return 0, None
    counts = np.searchsorted(a, a + WIN, side="left") - np.arange(a.size)
    k = int(np.argmax(counts))
    return int(counts[k]), int(a[k])


def spans_of(ranges, total, margin):
    out = []
    for lo, hi in sorted(ranges):
        lo, hi = max(0, lo - margin), min(total, hi + margin)
        if out and lo <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], hi))
        else:
            out.append((lo, hi))
    return out


def frames_of(path):
    info = json.loads(subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path], capture_output=True, text=True).stdout)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    num, den = (int(x) for x in v["r_frame_rate"].split("/"))
    fps = num / den
    n = int(v["nb_frames"]) if v.get("nb_frames") else round(float(info["format"]["duration"]) * fps)
    return n, fps


def general(path, ranges=None, margin=WIN, workers=None):
    """Onset frames of general changes, plus the worst 1-second count. The same answer as flash.py's field_report for this field."""
    total, fps = frames_of(path)
    spans = spans_of(ranges, total, margin) if ranges else [(0, total)]
    workers = workers or min(4, os.cpu_count() or 1)
    size = max(90, sum(h - l for l, h in spans) // workers + 1)
    parts = [(a, min(a + size, h)) for l, h in spans for a in range(l, h, size)]
    with cf.ThreadPoolExecutor(workers) as ex:
        done = list(ex.map(lambda p: analyse(path, p[0], p[1], fps), parts))
    results = []
    for (lo, hi), (start, rise, fall) in zip(parts, done):
        # Stitch: an onset needs the frame before it, so each part holds frame lo-1, and the onsets it reports start at lo.
        for q in (rise, fall):
            frames = onsets(q, start)
            results.append(frames[(frames >= lo) & (frames < hi)])
    all_onsets = np.sort(np.concatenate(results)) if results else np.zeros(0, np.int64)
    worst, at = worst_window(all_onsets)
    return all_onsets, worst, at, fps, sum(h - l for l, h in spans)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--ranges")
    ap.add_argument("--margin", type=int, default=WIN)
    a = ap.parse_args()
    ranges = None
    if a.ranges:
        ranges = [(int(m.group(1)), int(m.group(2))) for m in re.finditer(r"(\d+)-(\d+)", a.ranges)]
    all_onsets, worst, at, fps, seen = general(a.clip, ranges, a.margin)
    start = "none" if at is None else f"{at / fps:.3f}s"
    print(f"WCAG phone30 general changes={all_onsets.size} max/1s={worst} (start {start}) verdict={'PASS' if worst <= LIMIT else 'FAIL'}")
    print(f"frames checked: {seen}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
