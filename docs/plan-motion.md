# Motion check in the note loop: plan (2026-11-08)

Status: draft with measurements. Section 5 holds kill tests run on a scratch prototype; the repo is unchanged. The gate (section 4) runs after the build. Line numbers predate the build now editing `page.js`, `cli.ts` and `film.ts`.

## 1. Why the pixel delta failed

The measure saw the plants (17 of 19 planted frames over T); the delta dropped them. Its "explained" rule (`.work/settle-2026-11-08/snap.py:105`) excused a new spike if the saved render had any candidate in the same scene and cell or a neighbour, at any frame, with half its excess. That merges different elements in a cell, different times, and different kinds of change (MAD cannot tell a step from a colour flip, a pop or a flash).

Busy scenes fill that excuse. On the replay's clean render, 72 to 100% of moving cells per scene hold an explaining candidate. A new spike there flags only above twice the local maximum: median 124 to 407 per scene (s07: 233), while gray MAD peaks near 250. The excuse was broad because the measure was noisy (4,368 clean candidates).

## 2. Design A (recommended): per-element path test in the plan pass

The plan pass already builds every frame's list (`runtime/page.js:113-155`). A tracker in that loop reads leaf-op boxes as `runtime/scan.js` does, id-less ops included (`flatten()` drops them, `runtime/reelrt.js:452-496`), keeps 6 positions per track, and writes events into the plan's `checks` (`page.js:162`). The before side comes from the plan cache (`tool/cli.ts:113-117`) and the `save` record.

**Identity.** The key is the op's `id`, else its kind, colour and text or image key. An id that occurs once in the frame links to its own track at any distance. Look-alikes and repeated ids link nearest-first to each track's predicted position 2p(f-1) - p(f-2), within 80 px and an area ratio of 0.5 to 2. The `film.ts` matcher (`tool/film.ts:75-77`, last position, first come) made 13 false events in s01; this one makes 0.

**Tests.**
- Step: velocity steady within 1.5 px for 2 frames before and 2 after, and frame f off that path by 10 px or more, or by 4 px on a still path (0.5 px a frame or less on both sides). Base: `film.ts:221-229`.
- Spike: velocities before and after agree within 1.5 px, and p(f) is 10 px or more off the midpoint of p(f-1) and p(f+1). The 30 px spike at `film.ts:219` misses the car plant.
- Both count only while the centre is in frame at opacity 0.5 or more.

Scene starts close all tracks. Pops form no step. Eases, shakes and zoom punches are never steady. Off-screen wraps fail visibility. There is no "near any event" excuse (`film.ts:189`); a designed jump passes only through an event whose id names the element, or a film's `off` rule.

**Keys.** `motion.<kind> <scene> <owner> <n>`: the owner is the first two id segments, the GL program, or `-`; n counts that owner's event frames. As with `dead.air` (`cli.ts:237-241`), a retime keeps the key and one more event is new. `do` prints one line per frame: "s07 wall: 39 elements step 7 px off a still path at f1954".

**GL stages.** A `gl` op is one image (`reelrt.js:269-283`). The tool defines an optional hook, `track(params)`, returning `{items: [{id, x, y, w, h, a}], cut}` in the op's frame space, with `cut` true where the program's own camera cuts. Film programs implement it; the plan pass applies the group matrix and keeps the result out of the hash. In the benchmark film:
- Stage: `params` already hold the camera and each car's x and z (`film/programs/stage/stage.js:303-335`). The prototype hook projects each car with the same `setCamera`: 14 lines.
- Wall: `params` are only `{f}` (`wall/install.js:31,63`). The hook repeats `fill()`'s position maths (`wall/wall.js:345`) for every 6th main-layer row, 360 of about 6,600 tiles, and flags the wall's cuts: 30 lines. Every 12th row misses the close framing.
- With no hook, `do` prints "motion inside <program> not checked". Shader-side defects stay invisible.

Design B, second: the pixel measure with no delta, limited to GL boxes. It needs an extra render (6 to 10 s a note) and is noisy, so it stays post-cut.

## 3. Cost per note

Measured, 3 paired plan passes of the full film (3,151 frames): tracker on 1,664 to 1,695 ms, off 786 to 795 ms, so +0.87 to 0.91 s. Split: reading boxes 132 to 149 ms, wall hook 293 to 310 ms, tracking about 440 ms for 264k items. My estimate before measuring was 3 times too low, and the cost is over the +0.5 s budget. The build must:
- track only scenes whose picture hashes changed against the cached before plan (`tool/do.ts:971` loads it). `save` pays +0.9 s once. Expected per note: about 0.05 s for s03 (list only), about 0.35 s for s07 (wall hook).
- replace the prototype's per-frame arrays and maps with ring buffers. Expected: tracking time halved.

## 4. Gate, pre-registered for the build

Section 2's rules are frozen. They were tuned on the s07 and s05 plants, so the gate plants are new. Each run: fresh `cp -c` clone, `save`, edit, plain `./movas do`, key diff.

- **A. Approved film, absolute, both hooks on.** PASS: no event besides the two s06 steps (section 5). Eduardo rules on those: known, or a defect to fix.
- **B. Clean notes.** The replay's 12 plus holds on a s07 wall beat and a s05 car cue, a s02 wall-cut retime, a s03 word change that reflows the scroll, a s09 insert, a s10 remove. PASS: 0 new keys in 18 of 18.
- **C. New plants,** each reversed too (0 new keys):
  1. s07 wall, columns with `col % 5 == 2`, 0.09 row pitch, 50-frame half-periods: every planted frame where sampled tiles are on screen and the camera moves under 20 px a frame.
  2. s05 cars, +0.18 units for one frame at 4 new frames: 4 of 4.
  3. s03 conversation group, 28 px steps in 40-frame half-periods: 9 of 10; 12 px must flag; 3 px should not (records the floor).
  4. s12: wrap400 and wrap428 flagged, per-tile silent.
- PASS needs A to C and the scoped cost under +0.5 s a note. One miss fails; no retry with new rules.
- **D. Then an agent A/B.** Sonnet low, n=3 per arm, one run at a time, model and effort matched. Arm B: the meaning-rule delta; arm C adds motion keys. Two trap notes expose a snap when done the obvious way (the s12 wall with a `% 400` scroll that never wraps today, note "run the wall 3 s longer"; a chat scroll that steps on an insert), and two are clean. C must ship fewer snaps (expected B 2 or 3 of 3 per trap, C 0 or 1), with no more wrong edits and at most 10% more peak tokens.

## 5. Expected gain and the kill tests

Expected: the loop goes from 0 motion catches to steps and spikes on list elements and hooked GL objects (the G1 class), for about +0.05 to 0.35 s a note once scoped. The gain for agents is unproven until D.

Kill test 1, offline: a Python port over the saved list scan of an older cut (3,091 frames) and simulated s12 lists. 0 events on the film; list plants of 28 px (s03) and 20 px (s05) caught on 10 of 10 and 5 of 5 frames; s12 caught, per-tile 0.

Kill test 2, plan-pass prototype on today's film with both hooks, no pixels:

| Run | Result |
|---|---|
| Approved film, absolute | 2 events in s06: the "Temperatura do lead" label steps 21 px left at f1426 and 19 px back at f1674 when its panel widens for a new word. Real steps. 0 events in s02 and s07, with no event excuse |
| Replay notes n1 to n12, key delta | 0 new, 0 gone, 12 of 12 (n6, n7 touch the s07 wall; n7 adds 60 frames) |
| s07 wall plant (`plant.py`) | 7 of 9 planted frames, steps of 6 to 80 px. Missed f2034 and f2154, inside camera moves of 50 to 370 px a frame |
| s05 car plant | 5 of 5 |
| s12 G1 wall | wrap400 at local f67, 89, 134; wrap428 at f72, 96, 143; per-tile 0 |

Draft kill criteria: clean s07 at 0 with no any-event excuse, met; wall hook under 0.3 s, missed narrowly (293 to 310 ms). The idea survives; cost is the open risk.

Two rules changed after the first planted-wall run: an id seen once links at any distance (the 85 px jump at f1834 broke its track), and the 4 px floor on still paths (f1954 and f1994 were 6 to 7 px). Tried and dropped: steadiness relative to jump size, which added 7 false events at the s01 zoom punches and caught nothing more.

Prototype: `/private/tmp/claude-501/-Users-eduardocorrea-git-movas/c5f27bc6-9e53-42be-918f-39bf4a6a2178/scratchpad/mplan/` (`install/runtime/motion.js`, hooks in `film_clean_s6/film/programs/`, `mrun.sh`, `keys.py`). The scratchpad can be wiped; this section is the record.

## 6. Risks and blind spots

- One film set the thresholds and the quiet baseline. Films that step elements by design will fire; the remedy is `off` or an own event.
- Fast camera moves hide steps. Look-alikes faster than 80 px a frame lose their tracks.
- A hook can drift from `draw` and covers only what it samples.
- Ordinal keys hide one edit that both removes and adds an event on the same owner.
- A new defect line can push agents into wrong edits; D measures this.
- Motion keys inherit the plan-cache key bug (T3) until that fix lands.

Not seen: sound, slow jitter, steps under the floors, wrong speed, easing, pacing, pops with no fade, flicker, shader-side or unhooked GL defects, encoder keyframe pops, taste. `do` keeps "not checked: sound, motion other than steps and spikes, how it reads to a person".
