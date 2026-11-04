"""Shared helpers for the video checks: ffmpeg frame streaming, timeline, results file.

Only numpy, PIL and the ffmpeg/ffprobe binaries are used.
"""
import bisect
import json
import os
import subprocess

import numpy as np

# movas runs these checks from MOVAS_CHECKS, with the film's MOVAS_WORK in the environment. They write under that work folder only.
CHECKS = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.join(os.environ.get("MOVAS_WORK") or os.path.join(os.getcwd(), ".work"), "checks")
CONTROLS = os.path.join(WORK, "controls")
MANIFEST = os.path.join(CONTROLS, "manifest.json")
RESULTS = os.path.join(WORK, "results-video.json")
SOLVED = os.path.join(WORK, "solved.json")
# --master and --preview read these; movas verify passes --file, so it needs neither.
MASTER = os.environ.get("MOVAS_MASTER", "")
PREVIEW = os.environ.get("MOVAS_PREVIEW", "")
FPS = 30
MASTER_WH = (1080, 1920)
PREVIEW_WH = (540, 960)
AW, AH = 270, 480  # analysis size (portrait, 1/4 of master)


def stream(path, vf, frame_bytes, pix_fmt):
    """Yield raw frames (bytes, frame_bytes long) decoded by ffmpeg from video stream 0."""
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", path, "-map", "0:v:0"]
    if vf:
        cmd += ["-vf", vf]
    cmd += ["-f", "rawvideo", "-pix_fmt", pix_fmt, "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            bufsize=max(4 * frame_bytes, 1 << 20))
    complete = False
    try:
        while True:
            buf = proc.stdout.read(frame_bytes)
            if len(buf) < frame_bytes:
                break
            yield buf
        complete = True
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace")
        rc = proc.wait()
        if complete and rc != 0:
            raise RuntimeError(f"ffmpeg exited {rc}: {err[-800:]}")


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json",
                          "-show_format", "-show_streams", path],
                         capture_output=True, check=True).stdout
    return json.loads(out)


def load_timeline():
    with open(SOLVED) as fh:
        doc = json.load(fh)
    scenes = doc["scenes"]
    starts = [s["startFrame"] for s in scenes]
    return doc, scenes, starts


def scene_index(starts, frame):
    """Scene partition by scene start frames (the overlapping s06/s07 frames go to s07)."""
    return max(0, bisect.bisect_right(starts, frame) - 1)


def load_manifest(check=None):
    with open(MANIFEST) as fh:
        items = json.load(fh)
    return [it for it in items if check is None or it["check"] == check]


def _jsonable(obj):
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if isinstance(obj, np.floating):
        return float(obj)
    if isinstance(obj, np.ndarray):
        return obj.tolist()
    raise TypeError(f"not JSON serializable: {type(obj)}")


def update_results(section, payload):
    """Write payload under results-video.json[section]; other sections are kept."""
    os.makedirs(WORK, exist_ok=True)
    data = {}
    if os.path.exists(RESULTS):
        with open(RESULTS) as fh:
            data = json.load(fh)
    data[section] = payload
    tmp = RESULTS + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False, default=_jsonable)
    os.replace(tmp, RESULTS)
