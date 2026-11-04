#!/usr/bin/env python3
"""./movas purity: checks that a frame draws the same whatever the render started with.

The chunk cache serves a frame drawn in one render to every later render. That is only safe when a frame's pixels depend on
its display list alone, not on what the page drew before it (GL state, a bake, an image load). This check renders the whole
film once, then every scene alone, all with --nocache in a work folder of their own, and compares the raw frames' hashes,
taken before the encoder. A scene drawn alone that differs from the same frames in the full render is a defect: a note that
starts there would cache frames a full render never draws.

Exit 1 on any defect. --scenes=s03,s07 checks only those scenes against the full render. It takes about as long as two
full renders, with ultrafast encoding, and touches neither the film's cache nor its outputs.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
MOVAS = os.path.dirname(HERE)
FILM = os.environ.get("MOVAS_FILM") or MOVAS  # the film's root, which the launcher names
WORK = os.environ.get("MOVAS_WORK") or os.path.join(FILM, ".work")
PUBLIC = os.environ.get("MOVAS_PUBLIC") or sys.exit("MOVAS_PUBLIC is not set. Add MOVAS_PUBLIC=<folder holding fonts/ and sfx/> to .movasrc.")
PORT = os.environ.get("MOVAS_PORT") or "3517"


def scenes():
    out = []
    for name in sorted(os.listdir(os.path.join(FILM, "film"))):
        if name.endswith(".movas"):
            for line in open(os.path.join(FILM, "film", name), encoding="utf-8"):
                m = re.match(r"scene\s+(\S+)", line)
                if m:
                    out.append(m.group(1))
    return out


def render(dir, tag, flags):
    """One --nocache render into dir. Returns {frame: raw-frame hash} for the frames it drew."""
    pix, out = os.path.join(dir, f"{tag}.pix.json"), os.path.join(dir, "out", f"{tag}.mp4")
    args = [os.path.join(MOVAS, "render.sh"), f"--port={PORT}", f"--work={dir}", f"--public={PUBLIC}", "--preset=ultrafast",
            "--nocache", "--noaudio", f"--pixhash={pix}", f"--out={out}", *flags]
    t0 = time.time()
    p = subprocess.run(args, cwd=MOVAS, env={**os.environ, "MOVAS_WORK": dir, "MOVAS_FILM": FILM}, capture_output=True, text=True)
    if p.returncode != 0:
        sys.exit(f"purity: the {tag} render failed (exit {p.returncode}):\n{p.stderr[-2000:]}")
    hashes = json.load(open(pix))
    frames = [f for c in json.load(open(out + ".manifest.json"))["chunks"] for f in range(c["from"], c["from"] + c["frames"])]
    if len(frames) != len(hashes):
        sys.exit(f"purity: the {tag} render hashed {len(hashes)} frames but its manifest lists {len(frames)}.")
    print(f"{tag}: {len(hashes)} frames drawn in {time.time() - t0:.1f} s", flush=True)
    return dict(zip(frames, hashes))


def main():
    ap = argparse.ArgumentParser(description="Render every scene alone and compare its raw frames with a full render.")
    ap.add_argument("--scenes", help="comma-separated scene ids; default all")
    a = ap.parse_args()
    ids = a.scenes.split(",") if a.scenes else scenes()
    dir = os.path.join(WORK, "purity")
    shutil.rmtree(dir, ignore_errors=True)
    os.makedirs(os.path.join(dir, "out"))
    full = render(dir, "full", [])
    bad = 0
    for s in ids:
        alone = render(dir, s, [f"--scenes={s}"])
        diff = sorted(f for f, h in alone.items() if full.get(f) != h)
        bad += len(diff)
        if diff:
            print(f"  DEFECT {s}: {len(diff)} of {len(alone)} frames differ from the full render, frames {diff[0]}..{diff[-1]}")
    print(f"{'FAIL' if bad else 'PASS'} purity: {len(ids)} scenes, {bad} frames differ")
    shutil.rmtree(dir, ignore_errors=True)
    sys.exit(1 if bad else 0)


main()
