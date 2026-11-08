#!/usr/bin/env python3
"""./movas verify: checks one rendered file against the film it was made from.

1. Source version: a warning when the manifest beside the file names a source other than the tree's.
2. Timing: the file's frame count against the film's. A mismatch is a defect, since the windows would not line up.
3. Text stability: for every punch, the jitter and snaps between land and floor (textstab). A snap there is a defect.
4. Flashes: the general WCAG 2.3.1 limit of 3 per second (flash_fast.py). Red flashes are not checked.
Exit 1 on any defect.

--ranges=a-b,c-d (b exclusive; a render's drawnRanges has this shape) limits check 3 to the punch windows that overlap
those ranges. Check 4 reads each range plus 30 frames either side: a 1-second window that touches a changed frame lies inside
that, and any other window gives the count it gave before. Check 2 still covers the whole file.

The stability and flash checks live outside the tool, in the folder that MOVAS_CHECKS names in .movasrc.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MOVAS = os.path.dirname(HERE)
CHECKS = os.environ.get("MOVAS_CHECKS") or sys.exit("MOVAS_CHECKS is not set. Add MOVAS_CHECKS=<folder of textstab and flash> to .movasrc.")
FILM = os.environ.get("MOVAS_FILM") or MOVAS  # the film's root, which the launcher names
WORK = os.environ.get("MOVAS_WORK") or os.path.join(FILM, ".work")
FLASH_LIMIT = 3  # flashes in any one second (WCAG 2.3.1)


TRACE = os.environ.get("MOVAS_TRACE")
_last = [time.perf_counter()]
def stage(name):
    """Stage times for the profile, only when MOVAS_TRACE names a file."""
    now = time.perf_counter()
    if TRACE:
        with open(TRACE, "a") as fh:
            fh.write(json.dumps({"step": "verify." + name, "ms": round((now - _last[0]) * 1000)}) + "\n")
    _last[0] = now


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def tree_head():
    return run(["git", f"--git-dir={FILM}/.movas/history", "rev-parse", "--short=12", "HEAD"]).stdout.strip() or None


def video_frames(path):
    info = json.loads(run(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]).stdout)
    v = next(s for s in info["streams"] if s["codec_type"] == "video")
    if v.get("nb_frames"):
        return int(v["nb_frames"])
    num, den = (int(x) for x in v["r_frame_rate"].split("/"))
    return round(float(info["format"]["duration"]) * num / den)


def parse_ranges(text, total):
    """a-b,c-d with b exclusive: sorted, merged, and inside frames 0..total."""
    spans = []
    for part in text.split(","):
        m = re.fullmatch(r"\s*(\d+)-(\d+)\s*", part)
        if not m or not (int(m.group(1)) < int(m.group(2)) <= total):
            raise ValueError(f"--ranges wants a-b pairs, b exclusive, inside frames 0-{total}; got {part.strip()!r}")
        spans.append((int(m.group(1)), int(m.group(2))))
    merged = []
    for lo, hi in sorted(spans):
        if merged and lo <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], hi))
        else:
            merged.append((lo, hi))
    return merged


def overlaps(window, ranges):
    """A punch window runs from land to out, both frames included (textstab feeds land..out)."""
    return any(window["land"] < hi and window["out"] >= lo for lo, hi in ranges)


def main():
    ap = argparse.ArgumentParser(prog="./movas verify")
    ap.add_argument("--file", help="the file to check (default: the last master, or the preview with --preview)")
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--ranges", help="check only the frames a-b,c-d (b exclusive), for example a render's drawnRanges")
    a = ap.parse_args()
    t0 = time.perf_counter()
    path = os.path.abspath(a.file or os.path.join(WORK, "out", "preview.mp4" if a.preview else "master.mp4"))
    if not os.path.exists(path):
        print(f"verify: no file at {path}")
        return 2
    defects = []
    print(f"verify {path}")

    # 1. The manifest the renderer writes beside the file names the tree it was made from.
    head = tree_head()
    man = path + ".manifest.json"
    if not os.path.exists(man):
        print("manifest: none beside the file, so its source version is unknown")
    else:
        src = (json.load(open(man)).get("version") or {}).get("shadowHead")
        if src and head and src != head:
            print(f"WARNING: the file is older than the source. It was rendered from {src}; the tree is at {head}.")
        else:
            print(f"manifest: rendered from {src}; the tree is at {head}")

    # 2. Timing, and the windows of every punch, from the compiled film.
    movas = run([os.path.join(MOVAS, "movas"), "windows"], cwd=FILM)
    if movas.returncode != 0:
        print(movas.stdout + movas.stderr)
        return 2
    plan = json.loads(movas.stdout)
    stage("windows")
    frames = video_frames(path)
    print(f"timing: the file has {frames} video frames; the film has {plan['durationFrames']}")
    if frames != plan["durationFrames"]:
        defects.append(f"timing: the file has {frames} frames, the film {plan['durationFrames']}; its windows do not line up")
    ranges = None
    if a.ranges is not None:
        try:
            ranges = parse_ranges(a.ranges, plan["durationFrames"])
        except ValueError as e:
            print(f"verify: {e}")
            return 2
        print(f"scope: frames {','.join(f'{lo}-{hi}' for lo, hi in ranges)} of {plan['durationFrames']}; "
              "the rest of the file was not checked in this run")

    # 3. Text stability between land and floor, per punch window (textstab). With --ranges, only the windows in those frames.
    os.makedirs(os.path.join(WORK, "verify"), exist_ok=True)
    wf = os.path.join(WORK, "verify", "windows.json")
    doc = plan if ranges is None else dict(plan, windows=[w for w in plan["windows"] if overlaps(w, ranges)])
    if not plan["windows"]:
        print("text stability: not checked, the film has no punch windows")
    elif ranges is not None and not doc["windows"]:
        print("text stability: no window in the redrawn frames")
    else:
        with open(wf, "w") as fh:
            json.dump(doc, fh, indent=1)
        st = run(["python3", "-B", os.path.join(CHECKS, "textstab.py"), f"--windows={wf}", f"--file={path}"], cwd=CHECKS)
        if st.returncode != 0:
            defects.append(f"text stability did not run: {st.stderr.strip()[-300:]}")
        for line in st.stdout.splitlines():
            print(line)
            m = re.search(r"WINDOW id=(\S+) .*snaps_land_floor=(\d+)", line)
            if m and int(m.group(2)) > 0:
                defects.append(f"text stability: {m.group(1)} has {m.group(2)} snaps between land and floor")

    stage("textstab")
    # 4. Flashes: general flashes against the 3-per-second limit, by flash_fast.py.
    # With --ranges, it reads each redrawn range plus 30 frames on each side, straight from the file.
    where = "" if ranges is None else ", in the redrawn frames"
    cmd = ["python3", "-B", os.path.join(HERE, "flash_fast.py"), f"--clip={path}"]
    if ranges is not None:
        cmd.append("--ranges=" + ",".join(f"{lo}-{hi}" for lo, hi in ranges))
    fl = run(cmd)
    m = re.search(r"WCAG phone30 general changes=(\d+) max/1s=(\d+) \(start [^)]*\) verdict=(\w+)", fl.stdout)
    if not m:
        defects.append(f"flash check did not run: {fl.stderr.strip()[-300:]}")
    else:
        worst_changes, verdict = int(m.group(2)), m.group(3)
        worst = worst_changes // 2  # a flash is an opposing pair of changes
        over = worst > FLASH_LIMIT
        print(f"flash (WCAG 2.3.1, general, phone30{where}): worst second {worst} flashes ({worst_changes} changes); "
              f"limit {FLASH_LIMIT} per second: {'EXCEEDED' if over else 'within'}; verdict {verdict}")
        if over or verdict == "FAIL":
            defects.append(f"flash: {worst} flashes in one second, limit {FLASH_LIMIT}")
    stage("flash")

    for d in defects:
        print(f"DEFECT {d}")
    print(f"defects: {len(defects)}; total time {time.perf_counter() - t0:.1f} s")
    return 1 if defects else 0


if __name__ == "__main__":
    sys.exit(main())
