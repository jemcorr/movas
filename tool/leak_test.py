#!/usr/bin/env python3
"""Fails when the tool, the runtime or the starter programs name a machine path, so the install runs on any machine. Run with ./movas leak.
Usage: tool/leak_test.py [tree] [--self-test]. --self-test proves the test fires on a planted path and stays quiet on clean code."""
import os, re, sys, tempfile
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TREE = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), HERE))
MACHINE = re.compile("|".join([r"/Users/", r"dev" + r"_sandbox", r"\.remotion"]))
ROOTS = ["tool", "runtime", "programs"]
# Each entry states why it may hold a hit. A path here is skipped whole, so the list stays short.
ALLOW = {"tool/leak_test.py": "holds the machine patterns"}
SKIP_ENDINGS = (".png", ".jpg", ".mp4", ".woff2", ".wasm", ".DS_Store")


def scan(tree):
    hits = []
    for root in ROOTS:
        for dirpath, _, names in os.walk(os.path.join(tree, root)):
            for name in sorted(names):
                p = os.path.join(dirpath, name)
                rel = os.path.relpath(p, tree)
                if rel in ALLOW or name.endswith(SKIP_ENDINGS) or "__pycache__" in rel:
                    continue
                try:
                    lines = open(p, encoding="utf-8").read().split("\n")
                except UnicodeDecodeError:
                    continue
                for i, line in enumerate(lines):
                    for m in MACHINE.finditer(line):
                        hits.append(f"{rel}:{i + 1}: {m.group(0)}: {line.strip()[:100]}")
    return hits


if "--self-test" in sys.argv:
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "tool"))
        open(os.path.join(d, "tool", "x.ts"), "w").write('const a = "fonts/inter.woff2";\n')
        if scan(d):
            print("FAIL self-test: clean code fired"); sys.exit(1)
        open(os.path.join(d, "tool", "x.ts"), "w").write('const a = "/Users/someone/film";\n')
        if not scan(d):
            print("FAIL self-test: a planted path did not fire"); sys.exit(1)
    print("PASS self-test"); sys.exit(0)
hits = scan(TREE)
for h in hits:
    print(h)
print(f"{len(hits)} machine paths in {', '.join(ROOTS)}; {len(ALLOW)} file allowed")
sys.exit(1 if hits else 0)
