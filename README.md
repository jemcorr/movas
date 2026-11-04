# movas

movas makes videos from a text score that an AI agent edits. A film is a folder of `.movas` files: one line is one event, with its words, its time and its sound. The compiler solves every frame number and reading time. Programs in JavaScript draw the look, on Canvas 2D, WebGL, three.js or HTML and CSS, in a headless browser. A render is the same bytes every time on one machine.

The objective: a director's note to an existing cut should cost an agent a fraction of what the same note costs in Remotion, and the tool should prove what changed on screen instead of trusting the agent's report.

## What is in this folder

- `movas`: the launcher. It runs the film in the current folder, or the folder `MOVAS_FILM` names.
- `tool/`: the compiler, the CLI, the checks and the rule language. `tool/brief.md` is the page an agent reads first.
- `runtime/`: the page, the compositor and the renderer.
- `programs/`: the generic programs: blocking, the chat format, shared helpers.
- `fixtures/`: two small films that the rule tests run on.
- `checks/`: the text-stability check that `movas verify` runs.
- `vendor/`: the headless shell and three.js. Not in version control. Copy them in by hand: `vendor/chrome-headless-shell-mac-arm64/` and `vendor/three/`.

A film lives in its own folder, never in here. It holds `film/` (the score and its own programs), its assets (fonts, sounds, models, music), a `.movasrc` that names this install, and a `./movas` that calls it.

## Start a film

```
python3 -B tool/new_film.py ~/films/demo --public=<folder holding fonts/ and sfx/>
cd ~/films/demo && ./movas check && ./movas render --preview
```

`./movas doctor --freeze` records every file the render needs in the film's `runtime.lock.json`. After that, `./movas doctor` says what changed.

## How to use it with agents

Give the agent `./movas brief <scene>` and the note. Nothing else about the tool goes in the brief.

- `./movas check` after every edit. It compiles, runs the rules and says what moved. It checks timing only, and says so.
- `./movas do <scene>.<id> "new words"` (also `hold=`, `key=value`, `insert`, `remove`) makes the common edits and keeps repeated lines in sync. Run plain `./movas do` after any edit by hand, including any edit in `programs/`.
- `./movas look <event>` renders one frame; `./movas look <a>..<b>` puts six frames of a range on one sheet. One frame cannot show motion: use the sheet.
- `./movas render --preview` is the fast lane for watching a cut: half size, x264 `veryfast`, written to `.work/out/preview.mp4`. Use plain `./movas render` only for the file you send.
- A render redraws and re-encodes only the 30-frame chunks whose display lists changed. The rest come from a cache keyed by the encoder settings, so a preview never reuses master chunks. The audio mix runs in a worker beside the frames and is cached when no sound row changed. On the benchmark film (3,151 frames at 1080×1920, 30 fps, M3 Pro), a one-cue note re-rendered the master in 2.2–2.3 s, a render with nothing changed took 1.6 s, and a full redraw 37 s. About 1.4 s of every render is the plan: the page computes and hashes every frame's display list.
- Keep the default x264 encoder for the file you send. Frames are fed to ffmpeg without waiting on each write (`--feed=sync` restores the old path; same bytes). `--preset=vt` (Apple VideoToolbox) is faster on a full redraw, 30.5 s against 35.5 s, but needs `--crf=80` (its `-q:v`, which moves in steps) to match x264 on small text, at 70% more bytes. On a note it saves under 1 s.
- `./movas film` reports the cut as text: measured facts against stated limits, no model. Run it after a cut, for the reviewer. Never put it in a note's brief.

Models: Sonnet at low effort for notes on an existing cut. Opus at high or xhigh effort for a first cut, where quality matters more than time.

Do not take an agent's "done" as proof. Read the frame, or the sheet, yourself.

## Benchmarks

movas is not cheaper than Remotion across the board. On small notes to an existing cut it used 22% to 44% of Remotion's peak tokens, and under 30% on three of the four notes (Sonnet, low effort). On a follow-up note it used 16% of Remotion's wall time (Sonnet, low effort). On creative notes and first cuts it used 49% to 196% of Remotion's tokens and 44% to 103% of its wall time.

Every number below was measured on the prototype that became movas (named Reel 2 then), at numbered snapshots rd1 to rd18, not on this version. Each agent figure is movas's median divided by Remotion's median, with the same model and the same effort on both sides. Render figures are each movas run divided by Remotion's median. Lower is better for movas. Above 100% means movas cost more. The benchmark film is a 103-second vertical promo with chats, a three.js wall and music. Sources are the evaluation notes of that project, by file name. They are not in this repository.

Terms:

- **Small note:** a one-line change to an existing cut, sent to a fresh agent. Four notes: a headline line, a chat bubble edit, a sentence change, and a hold moved by 2 beats.
- **Follow-up note:** a second small note sent to the same agent after it finished a first one. Timed from the note's arrival. The Sonnet row ends at the agent's last transcript entry, the pre-registered end point. The Haiku row ends at the reply that holds the preview.
- **Creative note:** a note that needs new animation code. "Tile note" is a wider one: one tile on a wall of chats pops toward the camera.
- **First cut:** an agent builds a watchable film from a brief, from cold.
- **Peak:** the largest context in the run, minus the context of its first turn. **Output:** output tokens in the run. **Wall:** elapsed time.

| Task | Model and effort | n per arm | Measure | movas as % of Remotion | Source |
|---|---|---|---|---|---|
| Four small notes, rd18 | Sonnet, low | 3 per note | Peak / output / wall | 22% to 44% / 11% to 38% / 24% to 49% | `v2-effort.md` |
| Four small notes, rd3 and rd6 | Haiku, low | 3 per note (Remotion 6 on one note) | Peak / output / wall | 13% to 31% / 6% to 27% / 16% to 105% | `v2-effort.md` |
| Two small notes, rd1 | Haiku, effort not set on either arm | 3 | Peak / output / wall | 25% to 62% / 50% to 78% / 48% to 79% | `v2-effort.md` |
| Follow-up note, rd18 | Sonnet, low | 3, one note | Wall | 16% | `v2-effort.md` |
| Follow-up note, rd10 | Haiku, low | 3, one note | Wall | 21% | `v2-effort.md` |
| Three creative notes, rd16 | Sonnet, low | 9 (3 per note) | Peak / output / wall | 92% / 97% / 52% | `v2-effort.md` |
| Three creative notes, rd16 | Haiku, low | 9 (3 per note) | Peak / output / wall | 72% / 83% / 63% | `v2-effort.md` |
| Tile note, rd15, quiet Mac | Sonnet, low | 3 | Peak / output / wall | 109% / 128% / 75% | `v2-effort.md` |
| First cut, rd13 | Sonnet, low | 3 movas, 2 Remotion | Peak / output / wall | 108% / 49% / 44% | `v2-effort.md` |
| First cut, rd13 | Sonnet, medium | 2 | Peak / output / wall | 196% / 134% / 103% | `v2-effort.md` |
| Master render, whole film, no agent | none | movas 2 at the shipped setting, Remotion 4 | Wall | 47% and 51% | `v2-second-profile.md`, `frozen-baseline.md` |
| Half-size preview render, whole film, no agent | none | movas 2 at the shipped setting, Remotion 4 | Wall | 28% and 34% | `v2-second-profile.md`, `frozen-baseline.md` |

What changes how a row reads:

- Haiku low, small notes: on the sentence change movas took 105% of Remotion's wall time. It was slower there.
- Follow-up note, Haiku low: 2 of 3 movas agents on the first wording declined the note. The 3 counted runs include 2 on a reworded prompt. movas ran one agent at a time on an idle Mac; the Remotion runs came from earlier batches that ran with other agents, 9 to 12 at once for the first batch. The load favours movas.
- Tile note: movas ran 3 agents at once and Remotion ran 1 at a time. The load favours Remotion.
- First cut, low: every Remotion run lost time to a test-setup fault (a 404 on symlinked audio).
- Render rows: each movas run is divided by Remotion's median of 4 runs (master 74.9 s, preview 65.7 s). movas: master 35.0 and 37.9 s, preview 18.6 and 22.2 s, with audio on. The Remotion source does not say whether its renders mixed audio. The movas master misses its own 28 s target.
- Preview render: the Mac showed two states about 4 s apart, cause untested. 28% is the quiet state, 34% the other.
- Most agent rows ran with other agents on the same Mac, so wall times carry load.

## Limits

- No number above was measured on this version. The benchmarks ran on snapshots rd1 to rd18. This version is a later build, after a generalization pass and a cleanup. The cleanup kept the benchmark film's plan hashes and decoded preview equal to the build before it. No agent has run a benchmarked note on it.
- Most rows are n=3 per arm, on one Mac, one film and one director.
- The goal was a third of Remotion's cost. movas does not meet it overall. It meets it on small-note peak tokens (3 of 4 notes at Sonnet low) and on follow-up wall time. It does not meet it on creative notes, first cuts or the master render.
- Flexibility has no ratio. The honest claim is "caught up, with checks that can read inside layout". Remotion had HTML all along, and no test ran those checks against a Remotion counterpart.
- Quality is not in the table. Acceptance came from AI judges who read still frames. They do not hear sound or see motion.
- On the chat note (four seller bubbles, and chat A must not clip), judges accepted 0 of 3 movas runs and 1 of 3 Remotion runs at Sonnet low. They judged before the director ruled that a line scrolling under a chat header is not clipping, and the runs were not judged again.
- Agents' own reports are not reliable. On the three creative notes at Sonnet low, 5 of 9 movas reports were true, against 8 of 9 for Remotion.
- On the hold note the two tools' agents made different edits, so that ratio does not compare one identical edit.
- Effort moved the numbers more than the tool did. The table compares the tools at the same effort only.
- The director's blind review of four first cuts, one per tool at low effort and one per tool at medium, found no tool advantage. He would start over on both low-effort cuts (`PLAN-v2.md`).
- A later test compared first cuts made with the `film` report available and without it, both on movas's predecessor. It had no Remotion arm, so it says nothing about movas against Remotion. It ran n=2 per arm, and the project's rule file loaded into all 4 runs, so no run was cold. The director saw no major difference between its arms (`v3-testc.md`).
- Sound and motion are checked by a person, not by the tool. `movas verify` checks text stability and general flashes. Red flashes are not verified.
