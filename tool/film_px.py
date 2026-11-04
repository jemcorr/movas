#!/usr/bin/env python3
"""Deterministic pixel and sound measures of an encoded film, for `./movas film`. It reads the file only: no model, no score semantics.
Usage: film_px.py <file.mp4> [--spec=<json>] [--out=<json>] [--text]
The spec holds {fps, scenes:[{id,from,to}], sfx:[{frame,cls}], beat:{first,fpb,perBar}}. With no spec, scenes come from hard cuts in the file."""
import json, re, subprocess, sys
import numpy as np

SR = 48000
opt = lambda k, d=None: next((a.split("=", 1)[1] for a in sys.argv[2:] if a.startswith(f"--{k}=")), d)
FILE = sys.argv[1]
spec = json.load(open(opt("spec"))) if opt("spec") else {}
FPS = int(round(spec.get("fps", 30)))


def grid(w, h):
    """The analysis size: long side 480 px, even numbers, cells of about 90 by 96 px. A portrait 9:16 file gets 270x480 and 3x5 cells."""
    s = 480 / max(w, h)
    gw, gh = int(round(w * s / 2)) * 2, int(round(h * s / 2)) * 2
    return gw, gh, max(1, round(gw / 90)), max(1, round(gh / 96))


def probe_size():
    o = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", FILE], capture_output=True, text=True, check=True).stdout.strip()
    w, h = o.split(",")[:2]
    return int(w), int(h)


W, H, CX, CY = grid(*probe_size())


def decode_gray():
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", FILE, "-vf", f"scale={W}:{H}:flags=area", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H, W).astype(np.float32)


def keyframes():
    o = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", FILE], capture_output=True, text=True, check=True).stdout
    return np.array([i for i, l in enumerate(o.split()) if l.startswith("K")])


def phase(a, b, win):
    """Shift of b against a, in pixels, by phase correlation, with the peak's height as confidence."""
    A = np.fft.rfft2((a - a.mean()) * win); B = np.fft.rfft2((b - b.mean()) * win)
    F = A * np.conj(B); F /= np.abs(F) + 1e-6
    c = np.fft.irfft2(F, s=a.shape)
    y, x = np.unravel_index(c.argmax(), c.shape); n, m = c.shape
    def sub(l, v, r):
        d = l - 2 * v + r
        return 0.0 if abs(d) < 1e-9 else 0.5 * (l - r) / d
    dy = y + sub(c[(y - 1) % n, x], c[y, x], c[(y + 1) % n, x]); dx = x + sub(c[y, (x - 1) % m], c[y, x], c[y, (x + 1) % m])
    if dy > n / 2: dy -= n
    if dx > m / 2: dx -= m
    return dx, dy, float(c[y, x])


def video():
    fr = decode_gray(); n = len(fr)
    diff = np.abs(fr[1:] - fr[:-1]); mad = np.concatenate([[0.0], diff.mean(axis=(1, 2))])
    ch, cw = H // CY, W // CX
    cellmad = np.zeros((n, CY, CX), np.float32); flow = np.zeros((n, CY, CX, 2), np.float32); conf = np.zeros((n, CY, CX), np.float32)
    win = np.outer(np.hanning(ch), np.hanning(cw)).astype(np.float32)
    for f in range(1, n):
        for j in range(CY):
            for i in range(CX):
                a, b = fr[f - 1, j * ch:(j + 1) * ch, i * cw:(i + 1) * cw], fr[f, j * ch:(j + 1) * ch, i * cw:(i + 1) * cw]
                cellmad[f, j, i] = np.abs(b - a).mean()
                # A cell with no change has no flow to read.
                if cellmad[f, j, i] < 0.02: continue
                dx, dy, k = phase(a, b, win); flow[f, j, i] = (dx, dy); conf[f, j, i] = k
    return n, mad, cellmad, flow, conf, keyframes()


def scene_video(a, b, n, mad, cellmad, flow, conf, kf):
    a = max(a, 1); b = min(b, n)
    if b - a < 3: return None
    seg = mad[a:b]
    out = {"mad": round(float(np.median(seg)), 2), "mad95": round(float(np.percentile(seg, 95)), 2)}
    # Keyframe steps: what the picture does at a keyframe against the frames just around it, inside the scene and away from hard cuts.
    ks = [int(k) for k in kf if a + 3 <= k < b - 3]
    excess, ratio = [], []
    for k in ks:
        around = np.median(np.r_[mad[k - 3:k], mad[k + 1:k + 4]])
        excess.append(float(mad[k] - around)); ratio.append(float(mad[k] / (around + 0.02)))
    out["kf"] = len(ks)
    if ks:
        out["kfExcess"] = round(float(np.median(excess)), 2); out["kfRatio"] = round(float(np.median(ratio)), 1)
        best, bestv = None, 0.0
        for j in range(CY):
            for i in range(CX):
                e = [float(cellmad[k, j, i] - np.median(np.r_[cellmad[k - 3:k, j, i], cellmad[k + 1:k + 4, j, i]])) for k in ks]
                v = float(np.median(e))
                if v > bestv: bestv, best = v, (i, j)
        out["kfCell"] = {"cell": best, "excess": round(bestv, 2)} if best else None
    # Flow: reversals per second in a cell, counted only where a cell moved at least 0.3 px both ways at a readable peak.
    worst, jit_secs = 0, 0
    wcell = None
    secs = max(1, (b - a) // FPS)
    for j in range(CY):
        for i in range(CX):
            for ax in (0, 1):
                v = flow[a:b, j, i, ax].copy(); v[conf[a:b, j, i] < 0.08] = 0
                big = np.abs(v) >= 0.3
                rev = np.zeros(len(v), bool)
                idx = np.nonzero(big)[0]
                for p, q in zip(idx, idx[1:]):
                    if q - p <= 2 and v[p] * v[q] < 0: rev[q] = True
                for s in range(secs):
                    c = int(rev[s * FPS:(s + 1) * FPS].sum())
                    if c > worst: worst, wcell = c, (i, j)
                    if c >= 6: jit_secs += 1
    out["revMax"] = worst; out["revCell"] = wcell; out["jitCellSecs"] = jit_secs
    # Stepping: the share of a slow drift's distance that lands on keyframes. Even drift puts about 1/gap there.
    if ks:
        keys = set(ks); total = stepped = 0.0
        for j in range(CY):
            for i in range(CX):
                mag = np.abs(flow[a:b, j, i, :]).sum(axis=1)
                slow = mag < 3
                total += float(mag[slow].sum())
                stepped += float(sum(mag[k - a] for k in keys if slow[k - a]))
        out["stepShare"] = round(stepped / total, 2) if total > 1 else None
        out["stepEven"] = round(len(ks) / (b - a), 3)
    return out


def hard_cuts(mad, fps):
    cuts = [0]
    for f in np.nonzero(mad > max(8.0, float(np.median(mad)) * 6))[0]:
        if f - cuts[-1] >= fps / 2: cuts.append(int(f))
    return cuts


def audio():
    raw = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-i", FILE, "-vn", "-ar", str(SR), "-ac", "2", "-f", "f32le", "-"], capture_output=True).stdout
    if not raw: return None
    x = np.frombuffer(raw, np.float32).reshape(-1, 2)
    e = subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-v", "verbose", "-i", FILE, "-vn", "-af", "ebur128=framelog=verbose:peak=true", "-f", "null", "-"], capture_output=True, text=True).stderr
    rows = [(float(m[0]), float(m[1]), float(m[2])) for m in re.findall(r"t:\s*([\d.]+).*?M:\s*(-?[\d.]+)\s+S:\s*(-?[\d.]+)", e)]
    I = re.search(r"I:\s+(-?[\d.]+) LUFS", e[e.rfind("Summary"):]); LRA = re.search(r"LRA:\s+(-?[\d.]+) LU", e[e.rfind("Summary"):]); TP = re.search(r"Peak:\s+(-?[\d.]+) dBFS", e[e.rfind("Summary"):])
    return x, np.array(rows), dict(I=float(I[1]) if I else None, LRA=float(LRA[1]) if LRA else None, peak=float(TP[1]) if TP else None)


def envelope(m, hop=400):
    # 120 Hz energy envelope with a first difference on a broadband, pre-emphasised signal: sharp attacks stand out from the bed.
    d = np.diff(m, prepend=m[:1])
    n = len(d) // hop
    return np.array([float(np.mean(d[i * hop:(i + 1) * hop] ** 2)) for i in range(n)]) + 1e-12


def low_env(m, hop=400):
    k = np.ones(160) / 160  # About 300 Hz low-pass by moving average.
    low = np.convolve(m, k, mode="same")
    n = len(low) // hop
    return np.array([float(np.mean(low[i * hop:(i + 1) * hop] ** 2)) for i in range(n)]) + 1e-12


def sound(fps):
    got = audio()
    if got is None: return {"none": True}
    x, rows, sum_ = got
    m = x.mean(axis=1); n = len(m); hop = 400; rate = SR / hop
    out = {"I": sum_["I"], "LRA": sum_["LRA"], "peak": sum_["peak"], "secs": round(n / SR, 2)}
    clip = np.abs(x).max(axis=1) >= 0.999
    out["clipSamples"] = int(clip.sum())
    clip_frames = sorted({int(i / SR * fps) for i in np.nonzero(clip)[0]})
    runs = []
    for f in clip_frames:
        if runs and f - runs[-1][1] <= fps: runs[-1][1] = f
        else: runs.append([f, f])
    out["clipRuns"] = runs[:12]
    rms = np.sqrt(np.array([np.mean(m[i:i + 1600] ** 2) for i in range(0, n, 1600)]) + 1e-12)
    db = 20 * np.log10(rms)
    q = db < -55
    sil, i = [], 0
    while i < len(q):
        if q[i]:
            j = i
            while j < len(q) and q[j]: j += 1
            if j - i >= 15: sil.append([i, j])
            i = j
        else: i += 1
    out["silence"] = sil
    env = envelope(m)
    # Rise at a time: mean energy just after against just before, in dB.
    def rise(t):
        a = int(t); w = 3
        if a - w < 0 or a + w >= len(env): return 0.0
        return 10 * float(np.log10(env[a:a + w].mean() / env[a - w:a].mean()))
    ev = spec.get("sfx") or []
    if ev:
        k = rate / fps
        lags = list(range(-40, 41))
        scores = [float(np.mean([rise(e["frame"] * k + l * k / 4 ) for e in ev])) for l in lags]
        b = int(np.argmax(scores))
        out["sfxLagFrames"] = round(lags[b] / 4, 2); out["sfxLagGain"] = round(scores[b] - float(np.median(scores)), 1); out["sfxLagOver0"] = round(scores[b] - scores[lags.index(0)], 1)
        rows_ = []
        for e in ev:
            bestr = max(rise(e["frame"] * k + l * k / 4) for l in range(-4, 13))
            rows_.append((e, bestr))
        out["sfxN"] = len(ev)
        out["sfxBuried"] = [{"frame": e["frame"], "cls": e.get("cls"), "file": e.get("file"), "rise": round(r, 1)} for e, r in rows_ if r < 3]
        cls = {}
        for e, r in rows_: cls.setdefault(e.get("cls"), []).append(r)
        out["sfxByClass"] = {c: {"n": len(v), "riseMed": round(float(np.median(v)), 1), "buried": int(sum(1 for r in v if r < 3))} for c, v in cls.items()}
    # Beat phase of the low band, against the film's grid when it has one.
    low = low_env(m); on = np.maximum(0, np.diff(np.log10(low), prepend=np.log10(low[0])))
    bt = spec.get("beat")
    if bt:
        step = bt["fpb"] / fps * rate; phases = np.arange(0, step, 1.0); scores = []
        for p in phases:
            pos = (p + (bt["first"] / fps * rate) + np.arange(0, (len(on) - p) / step - 2) * step).astype(int)
            pos = pos[pos < len(on)]
            scores.append(float(on[pos].mean()) if len(pos) else 0.0)
        scores = np.array(scores); p = int(scores.argmax()); off = phases[p] / rate * 1000
        if off > step / rate * 500: off -= step / rate * 1000
        out["bedPhaseMs"] = round(float(off), 0); out["bedPhasePeak"] = round(float(scores[p] / (np.median(scores) + 1e-9)), 1)
    else:
        ac = np.correlate(on - on.mean(), on - on.mean(), "full")[len(on) - 1:]
        lo, hi = int(rate * 60 / 200), int(rate * 60 / 60)
        lag = lo + int(np.argmax(ac[lo:hi])); out["bpmGuess"] = round(60 * rate / lag, 1); out["bpmPeak"] = round(float(ac[lag] / ac[0]), 2)
    # Scene table. Momentary loudness from ebur128 at 10 Hz, onset count from the broadband attack.
    atk = np.maximum(0, np.diff(10 * np.log10(env), prepend=10 * np.log10(env[0])))
    def per(a, b):
        if not len(rows): return {}
        t0, t1 = a / fps, b / fps; r = rows[(rows[:, 0] >= t0) & (rows[:, 0] < t1)]; ok = r[r[:, 1] > -70] if len(r) else r
        p = {"M": round(float(np.median(ok[:, 1])), 1) if len(ok) else None, "Mmax": round(float(ok[:, 1].max()), 1) if len(ok) else None}
        s = atk[int(t0 * rate):int(t1 * rate)]; p["hits"] = int(((s > 9) & (np.r_[0, s[:-1]] <= 9)).sum())
        return p
    out["per"] = per
    return out


def main():
    fps = spec.get("fps", 30)
    n, mad, cellmad, flow, conf, kf = video()
    scenes = spec.get("scenes")
    if not scenes:
        cuts = hard_cuts(mad, fps) + [n]
        scenes = [{"id": f"shot{i + 1}", "from": cuts[i], "to": cuts[i + 1]} for i in range(len(cuts) - 1)]
    a = sound(fps)
    per = a.pop("per", None)
    table = []
    for s in scenes:
        v = scene_video(s["from"], s["to"], n, mad, cellmad, flow, conf, kf) or {}
        table.append({"id": s["id"], "from": s["from"], "to": s["to"], **v, **(per(s["from"], s["to"]) if per else {})})
    gaps = np.diff(kf).tolist() if len(kf) > 1 else []
    res = {"file": FILE, "frames": n, "kfGap": int(np.median(gaps)) if gaps else None, "scenes": table, "audio": a, "cellGrid": [CX, CY]}
    if opt("out"): json.dump(res, open(opt("out"), "w"))
    if "--text" in sys.argv:
        print(f"{n} frames, keyframe every {res['kfGap']} frames, {len(table)} shots by hard cut. Cells {CX} across, {CY} down. No score: nothing here is list-derived.")
        print("| shot | s | MAD med/p95 | kf excess/ratio | stepShare/even | rev max | M LUFS | hits |")
        print("|---|---|---|---|---|---|---|---|")
        for t in table:
            print(f"| {t['id']} | {t['from'] / fps:.1f}+{(t['to'] - t['from']) / fps:.1f} | {t.get('mad')}/{t.get('mad95')} | {t.get('kfExcess')}/{t.get('kfRatio')} | {t.get('stepShare')}/{t.get('stepEven')} | {t.get('revMax')} | {t.get('M')} | {t.get('hits')} |")
        print(f"sound: I {a.get('I')} LUFS, LRA {a.get('LRA')}, peak {a.get('peak')} dBFS, clipped samples {a.get('clipSamples')}, silence {a.get('silence')}, bpm guess {a.get('bpmGuess')}")


main()
