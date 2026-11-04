#!/bin/bash
# A film's own ./movas. It runs the install that MOVAS_HOME in this folder's .movasrc names, on this folder.
HERE="$(cd "$(dirname "$0")" && pwd)"
home="$(. "$HERE/.movasrc"; printf '%s' "${MOVAS_HOME:-}")"
[ -n "$home" ] || { echo "MOVAS_HOME is not set. Add MOVAS_HOME=<the movas install> to $HERE/.movasrc." >&2; exit 2; }
MOVAS_FILM="$HERE" exec "$home/movas" "$@"
