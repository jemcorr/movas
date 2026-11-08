# Motion check: the gate failures, traced (2026-11-08)

This file follows `docs/gate-motion.md`. It traces each failure of that gate to its cause, and records the fix or why there is none. Section 2's thresholds in `docs/plan-motion.md` are unchanged. Logs, scripts and the tracker dump are in `.work/fix-motion-2026-11-08/`. Every run used a fresh `cp -c` clone of the base film that runs this branch's install. One movas process ran at a time.

## Commits

| Commit | Change |
|---|---|
| `da3593b` | split an inserted punch into word groups, one per hit |
| `274f1f0` | name where the program reads the copied line when an insert draws nothing |
| `0cd7e1a` | record which program module draws each motion event (`runtime/page.js`, `runtime/motion.js`) |
| `8b2f0c3` | name the drawing program and the usual fix on motion defects (`tool/cli.ts`, `tool/do.ts`) |

## 1. C1, s07 wall plant: f1944 and f2144 missed. Not a bug; open as a gate-design fact

Method: the tracker was given temporary instrumentation (not committed). For every sampled planted tile (`c2`, `c7`, ... `col % 5 == 2`) tested at f1944, f1994, f2094 and f2144, it dumped the six samples (x, y, opacity), `lit()`, `seen()` and the track length. It also logged program cuts and new tracks from f1930 to the end of s07. Dump: `c1-tracker-dbg.json`, reader `dbg.py`.

What the tracker saw:
- Identity: every planted tile had a full 6-sample track at each tested frame. No cut and no new wall track occurred from f1930 to f2161. Linking did not lose a tile.
- Visibility: `seen()` was false only for tiles that really are off screen (x from -5455 to -916, or 2471 to 2525, on a 1080 px frame). `lit()` failed only for tiles fading during the rush (opacity under 0.5).
- **f2144**: after the rush starts (f2139), most planted tiles fall at 10 to 85 px a frame, so their paths are not steady. Two on-screen tiles hold a steady path. `c17.r36` steps -9.30 px off its path, and `c17.r42` steps -8.81 px. Their vertical drift is 0.60 and 0.51 px a frame. The still path needs 0.5 px or less, so both are classed as steady, and a steady step needs 10 px. Both miss by 0.7 to 1.2 px.
- **f2094**, the twin that fired: `c17.r42` steps 8.64 px with a drift of 0.47 px a frame, which is still, so the 4 px floor applies. `c17.r36` steps 9.12 px with a drift of 0.55 and was missed there too.
- **f1944**: the plant moves tiles 3.9 to 5.2 px. The steady-path tiles drift 0.85 to 4.4 px a frame. A 10 px floor applies, so the frame cannot fire.

Cause: both misses follow from the frozen rules, applied as written. f2094 against f2144 is a knife edge on the 0.5 px still bound, with a camera drift of 0.47 against 0.51 to 0.60 px a frame. The C1 clause counts every frame with sampled tiles on screen and a camera under 20 px a frame. That clause is stricter than the rules it tests, because the plant (0.09 row pitch, about 5 px on screen) is below the 10 px steady floor.

Threshold probe, not adopted: with `STILL = 1.0`, f2144 would fire (drift 0.60 is under 1.0, and 9.3 px is over 4). On the approved film the same pass gave 10 events instead of 2. The 8 new events are false: 6 in s01 (zoom punches: `s01.q0`, the stage `hb20` and `argo`, 4.1 to 5.5 px) and 2 in s05 (`s05.lblArgo`, the stage `argo`, 8.2 to 8.5 px). That would fail gate A, so the threshold stays. C1 stays at 4 of 6 counted frames. A later gate should plant above the floors it tests, or count only frames the rules can see.

## 2. B, the s09 insert

**Compile failure (bug, fixed in `da3593b`).** `insert` copied the line it follows, `hits=` included, and put the new words in as one group. For a punch with 3 hits, that is 1 word group against 3 hits, which is `sfx.hits`. Its accent was lost too. Now an inserted punch or dock line takes the copied line's shape. It gets one group per hit, chosen by the same split step as a text edit (`splitStep`, margin-checked), and keeps the accent. With fewer words than hits, it keeps one group per word and the first hits, and says so in a note.

| Command | Before | After |
|---|---|---|
| `insert s09.l2 "Simples assim."` | NOT DONE, `sfx.hits s09.l3: 1 word groups but 3 hits` | DONE, `*Simples / assim.*`, `hits=` cut to 2, note "2 words for 3 word groups, so 2 groups and the first 2 hits" |
| `insert s09.l2 "O lead chega pronto para fechar a venda."` | NOT DONE, same compile error | DONE, 3 groups, 3 hits, 55 frames change |

The s09 program still does not draw `l3`'s words (`key.dead s09.l3 top/size/accent`, and the frame shows only l1 and l2). The changed frames come from the program reacting to the new event. `do` says so: "Not confirmed on screen: s09.l3 is drawn by a program. Check the frame."

**"Changes no frame" (refusal right, message fixed in `274f1f0`).** `film/programs/scenes/ficha.js:465-466` draws exactly two chat messages, by id (`v.text("seller")`, `v.text("reply")`), and `pending` is read by id at `:217`. A new id such as `seller2` reaches no frame, so the refusal is correct. The old text said only "A program draws this". Now it names the place:

```
NOT DONE: this changes no frame. s09.seller2 is not what the viewer sees.
  Nothing was changed. No program draws a line with the new id seller2: the scene's program draws the lines it names, and it names seller at film/programs/T.js:11, film/programs/scenes/ficha.js:298.
  To add this line, add s09.seller2 to the score and to that program by hand, then run plain ./movas do.
```

The search is generic. It returns the first line of each program file (film or install) that quotes the copied line's id, at most 3 files. It found `ficha.js:298` (`m.tone === "seller"`) before `:465` because it matches the first quoted occurrence, so it points to the right file but not always to the exact line.

Gate B slot 18 is now filled with `insert s09.l2 "O lead chega pronto para fechar a venda."`: DONE, 0 new and 0 gone motion keys.

## 3. D, chat trap: the defect line now names the program (fixed in `0cd7e1a` and `8b2f0c3`)

The page records which module installed each scene function (`extra[sid]`) and each GL program (`programs[name]`). Each tracked element takes the module that draws its scene group (its own scene function, else its program, else the tool's `programs/film.js` blocking). A GL item takes the module that installed its program. Events carry it as `by`. `motionLines` turns the most common `by` of a frame into a path (`film/...` when the film owns the file, else `<path> in the movas install`). `do` adds one hint line under the new defects when any is a motion key. Nothing in it is film-specific.

```
  new: motion.step s12 s12.m1: 3 elements step 67 px off a still path at f3226, drawn by film/programs/scenes/thread.js
  motion: a step is an element that jumps off its own smooth path in one frame; a spike leaves it for one frame. The fix is usually in the program the line names: ease the move over a few frames (a scroll eases its offset), keep a wrap or a reset off screen, or make the jump a cut.
```

Attribution on the gate films: s06 `tempLabel` is drawn by `film/programs/scenes/conversa.js` (the s05 function spans s06), the C1 wall by `film/programs/wall/install.js`, the C2 cars by `film/programs/stage/install.js`, and the s12 bench by `film/programs/scenes/tiles.js`.

**K rerun (agent A/B harness, arm F = this branch, `dgate/instF`).** The setup is the same as arm C: Sonnet, low effort, the same prompt and base `base/K`, n=3, one run at a time, graded by `grade.py` on instC. The plan and gate docs were removed from the install copy.

| Arm | Snaps | Wrong edits | Done |
|---|---|---|---|
| B (recorded, `ec7d14c`) | 3/3 | 0 | 3/3 |
| C (recorded, `ad03b2b`) | 3/3 | 0 | 3/3 |
| F (this branch) | **0/3** | 0 | 3/3 |

All three F runs read the new line, eased the scroll in `film/programs/scenes/thread.js` (over 7 or 8 frames), ran `purity`, and reported the remaining `clip s12.m1` as scrolling under the header. Each subagent used 77 to 78k tokens in total. That is the harness's tool total, not the transcript peak that `metrics.py` measures, so it is not comparable to D's peak-context column. n=3, one note, one film, one model setting. W, H and T were not rerun.

## 4. D, wall-note ambiguity

One arm C run of W read "tile wall" as the s07 three.js wall. The note text is ambiguous in a film with two walls. This is a harness flaw. The tool needs no change. A rerun should name the scene ("the s12 tile wall").

## 5. Cost

Profile (`prof.sh`, `perf.sh`, `twice.sh`, clone of the approved film with hooks; s07 is 367 frames, and the hook is called twice a frame, for the stage and the wall):

| s07 tracked | Wall hook ms | s07 run ms |
|---|---|---|
| after s01 to s06 in a full pass | 77 to 80 | 168 to 170 |
| alone (base = every other run) | 254 to 258 | 359 to 367 |
| alone, the same run tracked a second time | 274 to 280 | 369 to 376 |
| alone, after an untimed track of s02 (frames 196 to 450) | 74 to 79 | 178 to 183 |

The slow pass is uniformly slow from its first to its last frame, and a second pass does not speed up, so this is not JIT warm-up. It is the order of type feedback: when V8 first sees the wall hook on s07 frames, the code it builds runs 3.3 times slower than when s02 frames come first. Calling the hook on s02 first restores the speed. The tracker's own time does not change (the run total minus the hook is 90 to 110 ms in every row). The cause is in the film's hook code (`wall.js` `track` and the `tileAt` it calls), which is not tool code. A tool-side warm-up would have to call a film's hook on frames it does not track, chosen by knowing which other scene uses the same program. That is not general and not cheap to make safe, so it was not built. Expected gain if the film hook were fixed: about 0.18 s on an s07 note.

Store read and write (`storetime.ts`, medians of 20): the real store (13 runs, 983 bytes) takes 0.09 ms to read in `render.ts`, and 0.08 ms to read plus 0.32 ms to write in the CLI. A synthetic store at the 600-run cap (169 kB) takes 0.64, 0.66 and 0.73 ms. This is negligible.

Paired cost of the n7 note (`s07.sort hold=+1b`), master install against this branch, alternating, 5 rounds (`pair.sh`): master adds +0.50 s (0.44 to 0.89), this branch +0.49 s (0.44 to 0.52). The `by` field costs nothing measurable. The wall note sits at the +0.5 s budget on both builds today (gate-motion.md recorded +0.46 s on master earlier the same day), so the cost clause is borderline, not met with margin.

## Gates on this branch

| Gate | Result |
|---|---|
| `deno check tool/*.ts runtime/*.ts` | 0 errors |
| Full `--nocache` render, fresh base clone | video `a24adcc7f8315f58a523e03db19ec181`, audio `ea01a46ba6f204d9acb7d68b71b68717`: match |
| Cached render | the same two md5s |
| `./movas purity` | PASS, 11 scenes, 0 frames differ |
| `test-rules` (`MOVAS_PUBLIC` = the clone's `assets`) | 78 of 78. A first run gave 35 of 78 because the worktree had no `vendor/`; a symlink to the repo's `vendor/`, as instB and instC use, fixed it |
| `./movas leak` | 0 machine paths |

Clause table, before (`docs/gate-motion.md`, master `17b9c82`) and after (this branch):

| Clause | Before | After |
|---|---|---|
| A. Approved film | PASS: only the two s06 `tempLabel` steps | PASS: the same two keys |
| B. Clean notes | 17 of 17 at 0 new; slot 18 not filled (s09 insert refused) | **18 of 18** at 0 new and 0 gone. n17 is `insert s09.l2 "O lead chega pronto para fechar a venda."`. n8 is still DONE WITH NEW DEFECTS (occlusion, non-motion), as before |
| C1. s07 wall | FAIL: f1844, 1894, 1994, 2094 flagged; f1944, 2144 missed; reverse 0 new | FAIL, unchanged: the same 4 frames; reverse 0 new, 4 gone. Cause in section 1 |
| C2. s05 cars | PASS 4 of 4, reverse 0 new | PASS 4 of 4 (13 to 14 px), reverse 0 new, 4 gone |
| C3. s03 conversation | PASS: 28 px 11/11, 12 px 11/11, 3 px 0, reverses 0 new | the same: 153 keys each for 28 and 12 px, 0 for 3 px, reverses 0 new |
| C4. s12 bench | PASS: wrap400 f3218, 3240, 3285; wrap428 f3223, 3247, 3294; reverses 0 new | the same frames, reverses 0 new |
| Cost, scoped | n3 +0.10 s, n7 +0.46 s | n3 +0.16 s (0.04 to 0.18), n7 +0.51 s (0.47 to 0.69) in the gate run; paired against master: +0.49 s against +0.50 s |
| D, K trap | C 3/3 snaps | F 0/3 snaps, 0 wrong edits |

## Still open

- C1 fails as written. The misses are below the frozen floors, and widening the still bound breaks A.
- The wall note's cost is at the +0.5 s budget. The cause is in the film hook's V8 profile, not in the tool.
- The s09 program draws a fixed set of lines. A note that adds a visible s09 line needs a program edit, and `do` now says where.
- The K effect is n=3 on one note. W, H and T were not rerun on this branch.
