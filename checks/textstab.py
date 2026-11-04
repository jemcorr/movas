#!/usr/bin/env python3
"""Text stability over consecutive full-resolution frames (sub-pixel translation of headline crops).

Per window (frames land..out, from .work/solved.json):
  1. bbox: at land+10, bright luma (raw limited-range code >= 222) inside a ROI hint is cleaned
     (3x3 open), grouped into blobs (11x11 close on a 1/4 grid, 8-connected labelling), and the
     blob with the most bright ink is kept; the crop is the ink bbox + 12 px.
  2. per consecutive frame pair: phase correlation (Hann window, phase-only surface, integer peak),
     refined to 0.02 px by a matrix-DFT upsampling of the same surface.
     Displacement d_t = (dy, dx): content moved from frame t-1 to frame t (+ = down/right).
  3. jitter_t = max over axes of |d_t - median(d over frames t-4..t+4)|: the departure of each
     step from the local velocity. A whole-pixel snap shows as ~1 px. Snap = jitter >= 0.5 px.
     Stability score = 1 - snaps / steps. Max jitter is the headline number.
  4. NCC at the refined shift is the fit quality (~1 for a pure translation).
Pre-declared control criteria: smooth 10x (0.1 px/frame exact) max jitter <= 0.20; smooth 4x
(0.25 px quantized) <= 0.30; whole-pixel snap >= 0.70; busy static background variants likewise.

usage:
  python3 -B textstab.py --controls
  python3 -B textstab.py --master      (writes a bbox montage to .work/checks/inspect/)
  python3 -B textstab.py --preview
"""
import argparse
import json
import os
import sys
import time

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vcommon as vc  # noqa: E402

THR = 222
PAD = 12
UP = 50
WINUP = 0.6
SNAP_PX = 0.5
HALF_MED = 4
MASTER_ROI = {
    "s01.p": (0, 1080, 780, 1200),
    "s03.p": (0, 1080, 840, 1200),
    "s04.p": (0, 1080, 560, 1160),
    "s07.p": (0, 1080, 200, 600),
    "s08.p": (0, 1080, 600, 1100),
    "s09.l1": (0, 1080, 480, 960),
    "s10.p": (0, 1080, 120, 600),
}


def label_grid(mask):
    H, W = mask.shape
    lab = np.zeros((H, W), np.int32)
    n = 0
    ys, xs = np.nonzero(mask)
    for y, x in zip(ys, xs):
        if lab[y, x]:
            continue
        n += 1
        lab[y, x] = n
        stack = [(y, x)]
        while stack:
            cy, cx = stack.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = cy + dy, cx + dx
                    if 0 <= ny < H and 0 <= nx < W and mask[ny, nx] and not lab[ny, nx]:
                        lab[ny, nx] = n
                        stack.append((ny, nx))
    return lab, n


def find_bbox(roi, thr=THR):
    ink = Image.fromarray(((roi >= thr) * 255).astype(np.uint8))
    clean = np.asarray(ink.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))) > 0
    dil = np.asarray(Image.fromarray((clean * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(41))) > 0
    small = dil[::4, ::4]
    lab, n = label_grid(small)
    cs = clean[::4, ::4]
    best, best_ink = 0, 0
    for k in range(1, n + 1):
        c = int(cs[lab == k].sum())
        if c > best_ink:
            best, best_ink = k, c
    if best == 0 or best_ink < 150:
        raise RuntimeError(f"no text blob found (best ink {best_ink})")
    ys, xs = np.nonzero(lab == best)
    y0, y1, x0, x1 = ys.min() * 4, (ys.max() + 1) * 4, xs.min() * 4, (xs.max() + 1) * 4
    yy, xx = np.nonzero(clean[y0:y1, x0:x1])
    by0, by1 = yy.min() + y0, yy.max() + 1 + y0
    bx0, bx1 = xx.min() + x0, xx.max() + 1 + x0
    H, W = roi.shape
    box = (max(0, bx0 - PAD), max(0, by0 - PAD), min(W, bx1 + PAD), min(H, by1 + PAD))
    return box, {"roi_ink_px": int(clean.sum()), "blob_ink_px": best_ink, "blobs": int(n)}


def prep(a):
    a = a - a.mean()
    a = a * np.outer(np.hanning(a.shape[0]), np.hanning(a.shape[1]))
    return np.fft.fft2(a), float(np.sqrt((a * a).sum()))


def ift_grid(R, ys, xs):
    ny, nx = R.shape
    ky = np.fft.fftfreq(ny, d=1.0 / ny)
    kx = np.fft.fftfreq(nx, d=1.0 / nx)
    Ey = np.exp(2j * np.pi * np.outer(ys, ky) / ny)
    Ex = np.exp(2j * np.pi * np.outer(kx, xs) / nx)
    return (Ey @ R @ Ex) / (ny * nx)


def pair(Fa, na, Fb, nb):
    R = Fb * np.conj(Fa)
    Rn = R / np.maximum(np.abs(R), 1e-12)
    r = np.fft.ifft2(Rn).real
    iy, ix = np.unravel_index(np.argmax(r), r.shape)
    ny, nx = r.shape
    sy = iy - ny if iy > ny // 2 else iy
    sx = ix - nx if ix > nx // 2 else ix
    g = np.arange(-WINUP, WINUP + 1e-9, 1.0 / UP)
    ys, xs = sy + g, sx + g
    C = ift_grid(Rn, ys, xs)
    k = np.unravel_index(np.argmax(C.real), C.shape)
    dy, dx = float(ys[k[0]]), float(xs[k[1]])
    ncc = float(ift_grid(R, np.array([dy]), np.array([dx]))[0, 0].real / (na * nb + 1e-12))
    return dy, dx, ncc


class Track:
    def __init__(self, tid, land, out, floor, roi):
        self.id, self.land, self.out, self.floor, self.roi = tid, land, out, floor, roi
        self.bbox = None
        self.bbox_info = None
        self.buf = []
        self.prev = None
        self.frames, self.dy, self.dx, self.ncc = [], [], [], []
        self.snap = None


def step(t, n, roi):
    bx0, by0, bx1, by1 = t.bbox
    F, na = prep(roi[by0:by1, bx0:bx1].astype(np.float64))
    if t.prev is not None:
        dy, dx, ncc = pair(t.prev[0], t.prev[1], F, na)
        t.frames.append(n)
        t.dy.append(dy)
        t.dx.append(dx)
        t.ncc.append(ncc)
    t.prev = (F, na)


def feed(t, n, Y):
    x0, x1, y0, y1 = t.roi
    roi = Y[y0:y1, x0:x1]
    if t.bbox is None:
        if n < t.land + 10:
            t.buf.append((n, roi.copy()))
            return
        t.bbox, t.bbox_info = find_bbox(roi)
        t.snap = roi.copy()
        pending, t.buf = t.buf, []
        for m, r in pending:
            step(t, m, r)
    step(t, n, roi)


def jitter(dy, dx):
    dy, dx = np.asarray(dy), np.asarray(dx)
    out = np.zeros(len(dy))
    for i in range(len(dy)):
        lo, hi = max(0, i - HALF_MED), min(len(dy), i + HALF_MED + 1)
        out[i] = max(abs(dy[i] - np.median(dy[lo:hi])), abs(dx[i] - np.median(dx[lo:hi])))
    return out


def metrics(t):
    f = np.asarray(t.frames)
    dy, dx, nc = np.asarray(t.dy), np.asarray(t.dx), np.asarray(t.ncc)
    j = jitter(dy, dx)
    hold = (f > t.land) & (f <= t.floor)
    snaps = int((j >= SNAP_PX).sum())
    return {
        "id": t.id, "land": t.land, "out": t.out, "floor": t.floor,
        "bbox_roi_px_x0y0x1y1": [int(v) for v in t.bbox], "bbox_info": t.bbox_info,
        "pairs": int(len(dy)),
        "max_jitter_px": round(float(j.max()), 4),
        "p95_jitter_px": round(float(np.percentile(j, 95)), 4),
        "snaps_ge_0p5px": snaps,
        "stability_score": round(1.0 - snaps / len(j), 4),
        "max_abs_step_px": round(float(np.max(np.hypot(dy, dx))), 3),
        "median_dy_px": round(float(np.median(dy)), 4),
        "mean_dy_px": round(float(dy.mean()), 4),
        "mean_dx_px": round(float(dx.mean()), 4),
        "ncc_min": round(float(nc.min()), 4), "ncc_median": round(float(np.median(nc)), 4),
        "pairs_ncc_below_0p9": int((nc < 0.9).sum()),
        "hold_land_to_floor": {"pairs": int(hold.sum()),
                               "max_jitter_px": round(float(j[hold].max()), 4) if hold.any() else None,
                               "snaps": int((j[hold] >= SNAP_PX).sum())},
        "series": {"frame": f.tolist(), "dy": np.round(dy, 4).tolist(), "dx": np.round(dx, 4).tolist(),
                   "jitter": np.round(j, 4).tolist(), "ncc": np.round(nc, 4).tolist()},
    }


def run(path, specs, wh, roi_scale=1.0):
    W_, H_ = wh
    fb, yb = W_ * H_ * 3 // 2, W_ * H_
    tracks = []
    for s in specs:
        x0, x1, y0, y1 = s["roi"]
        roi = tuple(int(round(v * roi_scale)) for v in (x0, x1, y0, y1))
        t = Track(s["id"], s["land"], s["out"], s["floor"], roi)
        if "box" in s:
            # The text's box from the display list is exact, so it replaces the ink search, which misses accent colours.
            bx0, by0, bx1, by1 = (int(round(v * roi_scale)) for v in s["box"])
            t.bbox = (max(0, bx0 - PAD - roi[0]), max(0, by0 - PAD - roi[2]),
                      min(roi[1] - roi[0], bx1 + PAD - roi[0]), min(roi[3] - roi[2], by1 + PAD - roi[2]))
            t.bbox_info = {"source": "display list box"}
        tracks.append(t)
    last = max(t.out for t in tracks)
    t0 = time.perf_counter()
    for n, buf in enumerate(vc.stream(path, None, fb, "yuv420p")):
        if n > last:
            break
        Y = np.frombuffer(buf, np.uint8, count=yb).reshape(H_, W_)
        for t in tracks:
            if t.land <= n <= t.out:
                feed(t, n, Y)
    return tracks, time.perf_counter() - t0


def control_specs():
    specs, exp = [], {}
    for it in vc.load_manifest("textstab"):
        specs.append({"id": it["name"], "land": 0, "out": 59, "floor": 59, "roi": it["params"]["roi"]})
        exp[it["name"]] = it["expect"]
    return specs, exp


def master_specs():
    doc, _, _ = vc.load_timeline()
    ev = doc["events"]
    specs = []
    for hid, roi in MASTER_ROI.items():
        specs.append({"id": hid, "land": ev[f"{hid}.land"]["frame"], "out": ev[f"{hid}.out"]["frame"],
                      "floor": ev[f"{hid}.floor"]["frame"], "roi": roi})
    return specs


def montage(tracks, path):
    tiles = []
    for t in tracks:
        if t.snap is None:
            continue
        im = Image.fromarray(t.snap).convert("RGB")
        d = ImageDraw.Draw(im)
        x0, y0, x1, y1 = t.bbox
        d.rectangle([x0, y0, x1 - 1, y1 - 1], outline=(255, 0, 0), width=max(2, im.width // 200))
        d.text((8, 8), t.id, fill=(255, 255, 0))
        tiles.append(im)
    if not tiles:
        return
    h = max(im.height for im in tiles)
    sheet = Image.new("RGB", (sum(im.width for im in tiles) + 10 * (len(tiles) - 1), h), (30, 30, 30))
    x = 0
    for im in tiles:
        sheet.paste(im, (x, 0))
        x += im.width + 10
    sheet = sheet.resize((sheet.width // 2, sheet.height // 2))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sheet.save(path)


def windows_run(a):
    """One row per window from `./reel windows`: the jitter and snaps between land and floor. Half-res files scale the ROIs."""
    if not a.file:
        raise SystemExit("--windows needs --file")
    doc = json.load(open(a.windows))
    specs = doc["windows"] if isinstance(doc, dict) else doc
    v = next(s for s in vc.probe(a.file)["streams"] if s["codec_type"] == "video")
    w, h = int(v["width"]), int(v["height"])
    sc = w / vc.MASTER_WH[0]
    tr, secs = run(a.file, specs, (w, h), roi_scale=sc)
    print(f"file {a.file} {w}x{h}, ROI scale {sc:g}, decode and measure {secs:.1f} s")
    for t in tr:
        m = metrics(t)
        hold = m["hold_land_to_floor"]
        print(f"WINDOW id={t.id} frames={m['pairs']} max_jitter_land_floor_px={hold['max_jitter_px']} "
              f"snaps_land_floor={hold['snaps']} land={t.land} floor={t.floor} out={t.out}", flush=True)
    if sc < 1:
        print("NOTE half-res file: it under-reports jitter below a quarter pixel.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--controls", action="store_true")
    ap.add_argument("--master", action="store_true")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--file", help="a full-size render with the master's timeline, for example the remake")
    ap.add_argument("--label", default="file")
    ap.add_argument("--windows", help="JSON from ./reel windows: [{id, land, floor, out, roi:[x0,x1,y0,y1]}] in master pixels, with --file")
    a = ap.parse_args()
    if a.windows:
        windows_run(a)
        return
    if a.controls:
        specs, exp = control_specs()
        out, ok_all = {}, True
        for it in vc.load_manifest("textstab"):
            tr, secs = run(it["path"], [s for s in specs if s["id"] == it["name"]], vc.MASTER_WH)
            m = metrics(tr[0])
            m.pop("series")
            e = exp[it["name"]]
            ok = True
            if "max_jitter_le" in e:
                ok = m["max_jitter_px"] <= e["max_jitter_le"]
            if "max_jitter_ge" in e:
                ok = m["max_jitter_px"] >= e["max_jitter_ge"]
            m["ok"] = ok
            m["mean_dy_px"] = m["mean_dy_px"]
            m["wall_s"] = round(secs, 2)
            ok_all = ok_all and ok
            out[it["name"]] = m
            print(f"{it['name']:18s} max_jitter={m['max_jitter_px']:.3f} p95={m['p95_jitter_px']:.3f} "
                  f"snaps={m['snaps_ge_0p5px']} score={m['stability_score']} mean_dy={m['mean_dy_px']:.4f} "
                  f"ncc_min={m['ncc_min']} bbox={m['bbox_roi_px_x0y0x1y1']} ok={ok}", flush=True)
        smooth = [out[k]["max_jitter_px"] for k in out if "smooth" in k]
        snap = [out[k]["max_jitter_px"] for k in out if "snap" in k]
        margin = round(min(snap) - max(smooth), 4)
        vc.update_results("textstab_controls", {"all_expectations_met": ok_all,
                                                "separation_margin_px_min_snap_minus_max_smooth": margin,
                                                "rows": out})
        print(f"separation margin (min snap - max smooth) = {margin} px")
        print("TEXTSTAB CONTROLS:", "ALL EXPECTATIONS MET" if ok_all else "AT LEAST ONE CONTROL FAILED")
        return
    if a.master or a.preview or a.file:
        t0 = time.perf_counter()
        if a.file:
            path, wh, sc, label = a.file, vc.MASTER_WH, 1.0, a.label
        elif a.master:
            path, wh, sc, label = vc.MASTER, vc.MASTER_WH, 1.0, "master"
        else:
            path, wh, sc, label = vc.PREVIEW, vc.PREVIEW_WH, 0.5, "preview"
        specs = master_specs()
        tr, secs = run(path, specs, wh, roi_scale=sc)
        res = {"clip": path, "roi_scale": sc, "decode_and_check_s": round(secs, 2),
               "windows": []}
        for t in tr:
            m = metrics(t)
            m["max_jitter_master_px_equiv"] = round(m["max_jitter_px"] / sc, 4)
            res["windows"].append(m)
            print(f"{t.id:7s} land={t.land} out={t.out} floor={t.floor} pairs={m['pairs']} "
                  f"max_jitter={m['max_jitter_px']} p95={m['p95_jitter_px']} snaps={m['snaps_ge_0p5px']} "
                  f"score={m['stability_score']} hold_max={m['hold_land_to_floor']['max_jitter_px']} "
                  f"ncc_min={m['ncc_min']} bbox={m['bbox_roi_px_x0y0x1y1']}", flush=True)
        res["wall_seconds_total"] = round(time.perf_counter() - t0, 2)
        vc.update_results(f"textstab_{label}", res)
        if a.master:
            montage(tr, os.path.join(vc.WORK, "inspect", "textstab_bbox_master.png"))
    return


if __name__ == "__main__":
    main()
