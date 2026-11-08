"""Shared helpers for the text-stability check: ffmpeg frame streaming and ffprobe.

Only the ffmpeg and ffprobe binaries are used.
"""
import json
import subprocess


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
