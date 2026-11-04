#!/usr/bin/env python3
"""Starts a new film that runs this install: a film folder with one scene, a .movasrc that names the install, and a ./movas that calls it. No copy of the tool, and no other film's names.
Usage: tool/new_film.py <dest> [--format=1080x1920] [--fps=30] [--port=4871] [--public=<dir>]
--public is the folder holding the film's fonts/ and sfx/. Without it, MOVAS_PUBLIC comes from this install's .movasrc.
The shell, three.js and the checks come from this install's .movasrc when it has one, otherwise from its vendor/ and checks/ folders. <dest> must be absent or empty."""
import os, re, shutil, sys
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
args = [a for a in sys.argv[1:] if not a.startswith("--")]
opt = lambda k, d: next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith(f"--{k}=")), d)
if len(args) != 1:
    print(__doc__); sys.exit(2)
dest = os.path.abspath(args[0])
if os.path.exists(dest) and os.listdir(dest):
    print(f"{dest} is not empty. new_film.py writes only to an absent or empty folder."); sys.exit(2)
try:
    w, h = (int(x) for x in opt("format", "1080x1920").split("x"))
    fps, port = int(opt("fps", "30")), int(opt("port", "4871"))
except ValueError:
    print("--format is WIDTHxHEIGHT, and --fps and --port are whole numbers."); sys.exit(2)
own = os.path.join(HERE, ".movasrc")
rc = dict(re.findall(r'^(\w+)="?([^"\n]*)"?$', open(own).read(), re.M)) if os.path.exists(own) else {}
machine = {
    "MOVAS_SHELL": rc.get("MOVAS_SHELL") or os.path.join(HERE, "vendor", "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    "MOVAS_THREE": rc.get("MOVAS_THREE") or os.path.join(HERE, "vendor", "three"),
    "MOVAS_CHECKS": rc.get("MOVAS_CHECKS") or os.path.join(HERE, "checks"),
}
for k, v in machine.items():
    if not os.path.exists(v):
        print(f"{k}: {v} does not exist. Set it in {own}, or put it in this install."); sys.exit(2)
public = opt("public", rc.get("MOVAS_PUBLIC", ""))
if not public:
    print("--public=<folder holding fonts/ and sfx/> is needed: this install's .movasrc names no MOVAS_PUBLIC."); sys.exit(2)
os.makedirs(os.path.join(dest, "film"), exist_ok=True)
os.makedirs(os.path.join(dest, ".work"), exist_ok=True)
FILES = {
    "film.movas": f"film new fps={fps}\nformat main {w}x{h} default\ngrid seconds\nbus sfx gain=1\nsfxcap 6s\norder s01\n",
    "rules.movas": 'rule read.punch per_word=0.17 base=0.85 owner=default why="reading time for a headline"\nrule read.dock per_word=0.17 base=1.7 owner=default why="reading time for a caption"\nrule min.text px=48 owner=default type=defect why="legible on a phone at 1080 wide"\nstyle punch in=7f snap=0.25b\nstyle dock line=8f stagger=3f dock=10f\n',
    "assets.movas": "soundroot ui  dir=sfx/kenney-interface ext=.ogg license=CC0 source=Kenney\nsoundroot hit dir=sfx/kenney-impact ext=.ogg license=CC0 source=Kenney\nsoundroot syn dir=sfx/synth ext=.wav license=own source=local\n",
    "s01-open.movas": 'scene s01 "Open"\npunch p @start+0.5s step=0.5s size=120 top=400 "First / line."\nend @p.out+0.5s\n',
    "meaning.txt": "# This film's rules. The craft rules are always on. `use chat` adds the phone chat format. ./movas help rules shows the language.\n",
}
for name, text in FILES.items():
    open(os.path.join(dest, "film", name), "w").write(text)
open(os.path.join(dest, ".movasrc"), "w").write(f'MOVAS_HOME="{HERE}"\nMOVAS_WORK="{dest}/.work"\nMOVAS_PORT={port}\nMOVAS_PUBLIC="{public}"\n' + "".join(f'{k}="{v}"\n' for k, v in machine.items()))
shutil.copy(os.path.join(HERE, "tool", "film_launcher.sh"), os.path.join(dest, "movas"))
os.chmod(os.path.join(dest, "movas"), 0o755)
print(dest)
