#!/bin/bash
# The renderer's whole permission set: only 127.0.0.1, read-only outside .work, and three named programs.
HERE="$(cd "$(dirname "$0")" && pwd)"
# The film is the folder MOVAS_FILM names, or the current folder. Its work folder defaults to its own .work.
FILM="${MOVAS_FILM:-$PWD}"; FILM="$(cd "$FILM" && pwd)"; export MOVAS_FILM="$FILM"
WORK="${MOVAS_WORK:-$FILM/.work}"; mkdir -p "$WORK"; WORK="$(cd "$WORK" && pwd)"
# Machine paths live in the film's .movasrc. A value already in the environment wins, so a test can point one run elsewhere.
for v in MOVAS_PUBLIC MOVAS_SHELL MOVAS_THREE; do
  if [ -z "${!v:-}" ] && [ -f "$FILM/.movasrc" ]; then export "$v=$(. "$FILM/.movasrc"; printf '%s' "${!v:-}")"; fi
done
if [ -z "${MOVAS_SHELL:-}" ]; then echo "MOVAS_SHELL is not set. Add MOVAS_SHELL=<path of the headless shell binary> to .movasrc." >&2; exit 2; fi
SHELL_BIN="$MOVAS_SHELL"
exec deno run --no-prompt --allow-net=127.0.0.1 --allow-read --allow-write="$WORK" --allow-run=ffmpeg,ffprobe,"$SHELL_BIN" --allow-env "$HERE/runtime/render.ts" --shell="$SHELL_BIN" "$@"
