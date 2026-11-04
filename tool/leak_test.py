#!/usr/bin/env python3
"""Fails when the tool, the runtime or the starter programs name a machine path or one of this film's product words. Run with ./movas leak.
Usage: tool/leak_test.py [tree] [--words=<file>] [--self-test]. The words come from film/leak_words.txt, one a line, so the tool itself names no product.
--self-test proves the test fires on a planted word and stays quiet on a word inside a longer word."""
import os, re, sys, tempfile
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TREE = os.path.abspath(next((a for a in sys.argv[1:] if not a.startswith("--")), HERE))
MACHINE = [r"/Users/", r"dev" + r"_sandbox", r"\.remotion"]
ROOTS = ["tool", "runtime", "programs"]
# Each entry states why it may hold a hit. A path here is skipped whole, so the list stays short.
ALLOW = {"tool/leak_test.py": "holds the machine patterns"}
SKIP_ENDINGS = (".png", ".jpg", ".mp4", ".woff2", ".wasm", ".DS_Store")


def words_of(path):
    try:
        return [w.strip() for w in open(path, encoding="utf-8") if w.strip() and not w.startswith("#")]
    except FileNotFoundError:
        return []


def pattern(words):
    # Whole words, so "harbors" does not read as the word "harbor". Case does not matter.
    whole = [r"(?<![\w-])" + re.escape(w) + r"(?![\w-])" for w in words]
    return re.compile("|".join(whole + MACHINE), re.I)


def scan(tree, pat):
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
                    for m in pat.finditer(line):
                        hits.append(f"{rel}:{i + 1}: {m.group(0)}: {line.strip()[:100]}")
    return hits


if "--self-test" in sys.argv:
    pat = pattern(["harbor", "Zebra"])
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, "tool"))
        open(os.path.join(d, "tool", "x.ts"), "w").write('const a = "harbors and unharbored";\n')
        if scan(d, pat):
            print("FAIL self-test: a word inside a longer word fired"); sys.exit(1)
        open(os.path.join(d, "tool", "x.ts"), "w").write('const a = "a zebra";\n')
        if not scan(d, pat):
            print("FAIL self-test: a planted word did not fire"); sys.exit(1)
    print("PASS self-test"); sys.exit(0)
words_file = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--words=")), os.path.join(os.environ.get("MOVAS_FILM") or TREE, "film", "leak_words.txt"))
words = words_of(words_file)
hits = scan(TREE, pattern(words))
for h in hits:
    print(h)
print(f"{len(hits)} hits in {', '.join(ROOTS)}; {len(words)} words from {os.path.relpath(words_file, os.environ.get("MOVAS_FILM") or TREE)}; {len(ALLOW)} file allowed")
sys.exit(1 if hits else 0)
