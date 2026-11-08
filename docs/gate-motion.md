# Motion check: acceptance gate (2026-11-08)

The gate in `docs/plan-motion.md` section 4 was run against the uncommitted build (`runtime/motion.js`, `runtime/page.js`, `runtime/render.ts`, `tool/cli.ts`, `tool/do.ts`, `tool/programs.md`). No file in `tool/`, `runtime/` or `programs/` was edited, and no rule or threshold was changed. Every run used a fresh APFS clone of the base film with both GL hooks (`.work/motion-hooks/hooks.patch`) applied before its first save. Raw logs, key diffs and scripts are in `.work/gate-motion-2026-11-08/`.

## Verdict

| Clause | Verdict | Result |
|---|---|---|
| A. Approved film, absolute | PASS | Only the two s06 `tempLabel` steps (f1426, f1674) |
| B. Clean notes | 17 of 17 run notes PASS; slot 18 not filled | 0 new motion keys on every note that ran. No s09 insert could be made with `do` (4 attempts refused) |
| C1. s07 wall plant | **FAIL** | 4 of 6 qualifying planted frames flagged. f1944 and f2144 missed |
| C2. s05 car plant | PASS | 4 of 4, reverse 0 new |
| C3. s03 conversation plant | PASS | 28 px: 11 of 11. 12 px: 11 of 11. 3 px: 0 (floor recorded). Reverses 0 new |
| C4. s12 bench | PASS | wrap400 and wrap428 flagged; both reverses to per-tile silent |
| Cost, scoped | PASS (narrow on the wall note) | n3: +0.10 s. n7: +0.46 s (paired 0.46 to 0.49 s) |

**Overall: FAIL.** C1 misses two planted frames, and one miss fails the clause. B is also short of 18 of 18, because the s09 insert slot could not be filled.

## Setup

- Clone helper: `mk.sh <name> [base|bench]`. It copies `$S/t1/base` (or `$S/t2/wallbench`, without its `.movas` and `.work`), writes `.movasrc` (own `MOVAS_WORK`, `MOVAS_PUBLIC`, port 4901), applies `hooks.patch`, and refuses unless `track` is present in `stage/install.js`, `stage/stage.js`, `wall/install.js` and `wall/wall.js`, `cuts: CUTS` is present in `wall/choreo.js`, and no `.orig` or `.rej` file is left.
- One movas process at a time. Every batch ran as one sequential background job.
- No `Failed to fetch` failure occurred, and no run was repeated.

## A. Approved film, absolute

Clone `gmotion/A`, `./movas save`. Motion keys in `.movas/known_issues.json` (defects and warnings):

```
motion.step s06 s05.tempLabel 0   1 element steps 21 px off a still path at f1426
motion.step s06 s05.tempLabel 1   1 element steps 19 px off a still path at f1674
```

There are no other motion keys. The plan pass tracked 11 runs, with `stage` hooked in 10 and `wall` in 3. No program was reported blind. Evidence: `A-known_issues.json`, `A-report-full.txt`, `A-motion.json`.

## B. Clean notes

Each note: fresh clone, `save`, `./movas do <cmd>`, `./movas report --full`, then the motion keys were compared against the saved version (`keydiff.py`). Every clone's saved and current motion keys were the two s06 keys only.

| # | Command (`./movas do ...`) | do result | New / gone motion keys | Non-motion check delta (does not count) |
|---|---|---|---|---|
| n1 | `s02.answer "Disponível! Aceitamos troca e parcelamos."` | DONE | 0 / 0 | clean |
| n2 | `s03.b3 hold=+1b` | DONE | 0 / 0 | clean |
| n3 | `s03.b4 "Alô?"` | DONE | 0 / 0 | clean |
| n4 | `insert s03.b3 "Tem garantia?"` | DONE (as b7) | 0 / 0 | clean |
| n5 | `remove s03.a3` | DONE | 0 / 0 | 3 gone |
| n6 | `s07.c4 a="Que carro você procura?"` | DONE | 0 / 0 | 1 gone |
| n7 | `s07.sort hold=+1b` | DONE | 0 / 0 | clean |
| n8 | `s05.c3 "Quero um SUV automático e econômico."` | DONE WITH NEW DEFECTS | 0 / 0 | 3 new defects (`occluded s05.temp s05.c1.box`, `occluded s06.morno s05.c1.box`, `occluded s05.tempLabel s05.a2.box`), 2 new warnings (`clip s05.a2.2` and one more), 3 gone |
| n9 | `s09.reply "Hoje à tarde!"` | DONE | 0 / 0 | clean |
| n10 | `s01.slam2 "Financia direto?"` | DONE | 0 / 0 | clean |
| n11 | `s10.bar hold=+1b` | DONE | 0 / 0 | clean |
| n12 | `s08.temp "Comprador quente"` | DONE | 0 / 0 | 1 new warning: `margin.edge s08.temp: 21 px, rule 24` |
| n13 (s07 wall beat hold) | `s07.wide hold=+1b` | DONE, +60 f | 0 / 0 | clean |
| n14 (s05 car cue hold) | `s05.hb20Leaves hold=+1b` | DONE, +60 f | 0 / 0 | clean; 2 events leave the kick (`s06.d`, `s06.end`) |
| n15 (s02 wall-cut retime) | `s02.cut2 at=@cut1+1.5b` | DONE, frames 406 to 436 change | 0 / 0 | clean; `s02.cut3` leaves the kick |
| n16 (s03 reflow) | `s03.sellerA3 "Banco novinho, sem nenhum detalhe na pintura, revisões em dia na concessionária, tá liso!"` | DONE, `do` set panel `keep=8`, frames 564 to 921 change | 0 / 0 | 2 new warnings: `clip s03.sellerA3.3` (128 of 279 frames), `clip s03.sellerA3.4`; 2 gone |
| n17 (s09 insert) | not filled, see below | refused | — | — |
| n18 (s10 remove) | `remove s10.lineup` | DONE, frames 2656 to 2665 change | 0 / 0 | clean |

s09 insert attempts, all refused by `do` with nothing changed:

1. `insert s09.seller "Posso separar o carro para você."`: "this changes no frame. s09.seller2 is not what the viewer sees."
2. `insert s09.reply "Combinado, até já!"`: the same refusal for `s09.reply2`.
3. `insert s09.l2 "Simples assim."`: "the edit does not compile", `sfx.hits s09.l3: 1 word groups but 3 hits`.
4. `insert s09.l2 "O lead chega pronto para fechar a venda."`: the same compile refusal. `do` does not split the words into groups.
5. `insert s09.pending "Quer agendar um test drive"`: "changes no frame", `s09.pending2`.

The s09 program draws a fixed set of lines, so an inserted `msg` or `text` line draws nothing, and an inserted punch copies `hits=` with 3 sounds onto 1 word group. I did not fill the slot with a hand edit, because that would not be a clean `do` note. The B result is therefore 17 of 17 notes with 0 new motion keys, against a pre-registered 18 of 18.

Notes on scope: n14 changes no frame inside the old s05 range (the picture changes from f1411), so it tests the car hook on a lengthened s05 tail and the shifted scenes after it, not a retimed car cue mid-scene. n13 and n7 both shift the s07 wall timing.

## C. Plants

Each plant: fresh clone, `save`, plant, plain `./movas do`, `report --full`, key diff. Reverse: `save` the planted film, remove the plant, plain `./movas do`, key diff. `plant.py` makes an exact single-anchor text replacement and prints the diff.

### C1. s07 wall: FAIL

```diff
--- film/programs/wall/choreo.js
+++ film/programs/wall/choreo.js
@@ -342,2 +342,3 @@
 
+    if (t.layer === 0 && t.col % 5 === 2 && isS7(f) && Math.floor(f / 50) % 2 === 1) s.v += 0.09 * PITCH.y; // PLANT
     // Blue and amber drop out of the lot, from the far end to the camera.
```

`f` here is the wall's own clock. In s07 it is the scene-local frame, so the film frame is `f + 1794`. The plant is limited to `isS7(f)` so that the s02 wall stays clean. It sits after the sort's `s.v = sortV(...)`, so it applies through the whole of s07. Step frames, where `floor(f / 50)` changes: f1844, 1894, 1944, 1994, 2044, 2094 and 2144 (7 frames).

Camera motion comes from the wall's own maths (`camspeed.ts`). It imports the clone's unplanted `makeChoreo` with the score's T and uses `poseAt`, `tileAt` and the same projection as `track()`. For the sampled planted tiles (main layer, `row % 6 == 0`, `col % 5 == 2`, opacity 0.5 or more, centre on screen), it measures how far a fixed tile moves on screen between f-1 and f (camera only), and how far the plant moves it on screen. "Window max" is the largest camera move over f-3 to f+2, the frames the step test reads.

| Frame | Sampled planted tiles on screen | Camera px/frame, median / max at f | Window max | Plant on screen, median / max px | Classed | Flagged |
|---|---|---|---|---|---|---|
| 1844 | 1 | 10.8 / 10.8 | 11.9 | 52.9 / 52.9 | counted | yes, 53 px steady path |
| 1894 | 1 | 7.2 / 7.2 | 9.0 | 18.9 / 18.9 | counted | yes, 20 px steady path |
| 1944 | 28 | 5.9 / 10.9 | 15.5 | 4.7 / 5.3 | counted | **missed** |
| 1994 | 28 | 0.6 / 1.0 | 1.1 | 4.7 / 5.4 | counted | yes, 9 elements 5 px still path |
| 2044 | 30 | 0.3 / 0.5 | 86.8 (the hit's shove) | 0.9 / 10.3 | excluded, camera 86.8 px/frame in the window | no |
| 2094 | 30 | 0.3 / 0.6 | 0.6 | 0.9 / 9.2 | counted | yes, 1 element 9 px still path |
| 2144 | 30 | 0.3 / 0.6 | 0.6 | 1.0 / 9.4 | counted | **missed** |

Result: 4 of 6 counted frames were flagged. On reverse: 0 new keys, 4 gone.

Probable cause, a hypothesis that follows from the numbers and was not tested further: at f1944 the plant moves tiles about 5 px on a path the camera moves about 6 px a frame, which is below the frozen 10 px steady-path floor. At f2144 the camera tilt (-74 degrees after the fall) foreshortens the 0.111-unit offset to about 1 px for most tiles, and to 9.4 px at most, on a still path. Its twin, f2094 (9.2 px at most), was caught. The frozen floors decide both misses. Nothing here shows that the tracker lost the tiles. The clause as written counts every frame where sampled tiles are on screen and the camera moves under 20 px a frame, so it fails.

### C2. s05 cars: PASS

```diff
--- film/programs/stage/stage.js
+++ film/programs/stage/stage.js
@@ -314,3 +314,3 @@
         visible: s.visible,
-        x: s.x,
+        x: s.x + ([1052, 1145, 1205, 1255].includes(frame) ? 0.18 : 0), // PLANT
         z: s.z,
```

The frames are film frames inside s05 (f1021 to 1410), and none is an old plant frame. Flagged:

```
motion.spike s05 stage: 6 elements spike 13 px off their path at f1052
motion.spike s05 stage: 5 elements spike 14 px off their path at f1145
motion.spike s05 stage: 5 elements spike 14 px off their path at f1205
motion.spike s05 stage: 5 elements spike 13 px off their path at f1255
```

Result: 4 of 4. Reverse: 0 new, 4 gone. The spikes are 13 to 14 px against a 10 px floor, so this plant size has little margin.

### C3. s03 conversation group: PASS

```diff
--- film/programs/scenes/olho.js
+++ film/programs/scenes/olho.js
@@ -59,3 +59,3 @@
       { op: "fill", kind: "radial", g: [W / 2, H * 0.45, W * 0.8, H * 0.6], stops: [[0, "#111a26"], [0.75, "#04060a"], [1, "#04060a"]], opacity: bgIn },
-      { op: "group", filter: Object.keys(filter).length ? filter : undefined, children: action },
+      { op: "group", filter: Object.keys(filter).length ? filter : undefined, m: translate3(0, 28 * (Math.floor(f / 40) % 2)), children: action }, // PLANT
       ...ctx.headlines(v),
```

The 12 px and 3 px runs change only the number. The group holds both panels and both verdict tags. `f` is scene-local (film frame = f + 451), so the step frames are f491, 531, ... 891: 11 frames, not the plan's 10.

| Step | Flagged step frames | New keys | Reverse |
|---|---|---|---|
| 28 px | 11 of 11 (f491 to f891, every 40) | 153 (21 owners: `-`, `s03.A`, `s03.B` and others, up to 11 frames each) | 0 new, 153 gone |
| 12 px | 11 of 11 | 153 | 0 new, 153 gone |
| 3 px | 0 of 11 | 0 | 0 new, 0 gone |

The floor holds: 3 px falls under the 4 px still-path floor and is not flagged. One plant gives 153 keys, and `do` prints the first 3.

### C4. s12 bench: PASS

The bench clone was saved with `MODE = "tile"`: no s12 motion key, only the two s06 keys. The plant is a one-line `MODE` change in `film/programs/scenes/tiles.js` (`"tile"` to `"wrap400"` or `"wrap428"`). The reverse returns it to `"tile"`.

| Change | New keys | Frames (s12 starts at f3151) |
|---|---|---|
| per-tile to wrap400 | 3: `motion.step s12 - 0..2` | f3218, 3240, 3285 (local 67, 89, 134), 28 px steady path, 35 to 70 elements |
| wrap400 to per-tile | 0 (3 gone) | — |
| per-tile to wrap428 | 3 | f3223, 3247, 3294 (local 72, 96, 143), 25 px still path, 18 to 36 elements |
| wrap428 to per-tile | 0 (3 gone) | — |

The frames match the planner's prototype exactly.

## Cost

The CLI has no switch to turn motion off, so the cost was timed on `render.sh --planOnly` directly (`cost.sh`). For each note: fresh clone, `save` (this fills the motion store with the base film's runs), a copy of the store taken, the note applied with `./movas do`, then 6 timed plan passes, alternating motion on (`--motionBase=<base store copy>`) and off (`--nomotion`). `render.ts` only reads the store, so every "on" pass starts from the same warm base and tracks only the runs the note changed. Direct `render.sh` calls do not use `.work/plan-cache`.

| Note | Motion on, s (median, range) | Motion off, s (median, range) | Added, median | Paired differences | Tracker detail (on) |
|---|---|---|---|---|---|
| n3 `s03.b4 "Alô?"` | 1.573 (1.568 to 1.585) | 1.473 (1.469 to 1.475) | +0.10 s | 0.11, 0.10, 0.10 | 2 runs tracked, 9 reused, motion 112 to 113 ms, hook 0 ms |
| n7 `s07.sort hold=+1b` | 1.942 (1.941 to 1.970) | 1.482 (1.470 to 1.482) | +0.46 s | 0.49, 0.47, 0.46 | 2 runs tracked, 9 reused, motion 464 to 486 ms, of which wall hook 305 to 322 ms |

Both are under the +0.5 s budget. The wall note is 0.01 to 0.04 s under it, and the plan expected about 0.35 s for it. The timing does not include what the CLI adds around a pass: reading the store and writing it back (`keepMotion`), a JSON file of at most 600 runs. Those were not measured.

## Deviations and judgement calls

- B slot 18, the s09 insert, could not be filled. There were 5 refused attempts, listed above.
- C1 uses the wall's scene-local clock for `f / 50` and limits the plant to s07 with `isS7(f)`. A frame is excluded on the largest camera move over the step test's window (f-3 to f+2), which excludes only f2044. If the test used the frame alone, f2044 would count as one more miss.
- C3 counts 11 step frames, not 10, and applies the plant to the whole `action` group (both chats and their tags).
- C2 visibility was not measured before the run. The flags show 5 to 6 cars at each planted frame.
- Each C plant's `do` returned code 1 (new defects) on the plant and 0 on the reverse. This is expected.
- Each clone's full logs (`*-do*.txt`, `*-report*.txt`), key diffs (`*-keys-*.json`, `B.jsonl`), and cost data (`K.jsonl`) are in `.work/gate-motion-2026-11-08/`. The clones are in the session scratchpad under `gmotion/` and can be wiped.
