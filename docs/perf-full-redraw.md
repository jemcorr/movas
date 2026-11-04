# Full-redraw performance: profile, changes and evidence

Machine: M3 Pro (5 performance and 6 efficiency cores), 18 GiB, macOS 26.7.2, Deno 2.9.8, ffmpeg 9.0.2, pinned shell Chromium 157.0.8080.0. Benchmark film: the one in the project notes, 3,151 frames, 1080x1920, 30 fps, 109 chunks. Baseline build: `afdfc3d`. All runs in APFS clones of the film under the session scratchpad, one render at a time under a lock file. Background load on the Mac was not controlled (other apps and a screen saver ran at times); every comparison below is time-paired, A and B alternating.

## Result

The batch moves the page's pixels to a worker with its own socket (`runtime/sender.js`). Measured against the baseline in time-paired rounds:

- Master full redraw (`--nocache`, the default x264 output): 98% of baseline wall time (35.06 s to 34.34 s, 3 rounds). That is inside the run-to-run spread: no loss, no proven gain.
- VideoToolbox full redraw (`--preset=vt --crf=80`): 83% (29.78 s to 24.78 s).
- Preview full redraw (`--preview`): 96% (18.30 s to 17.54 s).
- One-cue note and no-op renders: 100% (2.63 s and 1.79 s on both builds).

Every output is the same stream as the baseline's, and the six gates pass (section 5); `test-ops` fails the same 3 of 16 film-state tests on both builds. The master render does not get faster because it is bound by x264's CPU under contention: during the frames phase the Mac has 0 to 10% idle CPU and x264 takes about 75% of it (section 2, "Why the master render does not move"). Two other changes were built, measured and dropped: a WebGPU readback (no gain, slower previews, and one nondeterministic output) and more encoders or a deeper feed queue (no gain).

This file was written as the work went. Sections: baseline profile, ideas tried (expected gain first, then measured), final numbers, review, gates, opt-in options, open items, risks.

## 1. Baseline profile

### Wall and phases (baseline build, `--nocache`, full film)

Five baseline runs early in the session: 44.8 s (first, cold profile), 39.1, 37.8, 35.1, 35.4 s. Phases of a typical run: compile 12 ms, plan 1.4 s (page boot 0.6 s, plan pass 0.8 s), frames 33 to 36 s, concat 0.15 to 0.2 s, conform 0.07 s. The frames phase is about 94% of the wall.

Inside the frames phase the page reports, per film: draw 8.3 to 8.9 s, readback 9.0 to 9.6 s, socket send 1.0 s, waiting for acks 13.5 to 16.5 s.

### Where the CPU goes (one baseline run, 34.5 s wall)

| Process | CPU s | of which system |
|---|---|---|
| ffmpeg (all 109 encoders, from rusage) | about 217 | about 11.5 |
| Chrome renderer | 33.3 | 3.0 |
| Chrome network service | 7.8 | 2.9 |
| Chrome GPU process | 7.1 | 1.5 |
| Deno (render.ts) | 12.0 | 7.7 |
| Other apps on the Mac (WindowServer, Claude, Music, screen saver) | 20 to 45 | |

Machine idle averaged 16 to 18% over the run; 0 to 10% in the middle of the frames phase, 55 to 87% during the plan, 10 to 26% in the encoder tail.

### Decomposition experiments

A profiling copy of the install (scratchpad only, not part of the batch) added `--sink=null` (Deno acks frames and drops them, no ffmpeg) and `--exp=noread|nosend` (skip the readback, or read back but send one byte).

| Experiment | Frames phase | Notes |
|---|---|---|
| x264 alone: the 109 chunks fed from a raw YUV file, render's exact ffmpeg args, 6 encoders | 19.9 to 21.7 s | 175 to 185 CPU s. 4 encoders 23.1 s, 8 encoders 21.7 s, 11 encoders 23.8 s |
| x264 alone, ffmpeg reading chunk files instead of pipes | 19.5 to 19.7 s | same CPU; pipes are not the encoders' cost |
| x264 alone beside 2 busy-loop processes | 22.8 s | 4 busy loops: 24.9 s |
| Page alone, draw only | 12.3 s | renderer 13.5 CPU s |
| Page alone, draw and readback | 17.2 s | renderer 22.9 CPU s |
| Page alone, draw, readback and socket (null sink) | 26.0 s | waits 9.4 s for acks although Deno acks at once |
| x264 alone and null-sink page at the same time, not coupled | 30.3 s both | |
| x264 alone beside a draw-only page | 24.7 s | |
| x264 alone beside a draw-and-readback page | 27.5 s | |
| Real render (coupled) | 32.3 to 33.7 s | |

Reading: x264 alone needs about 20 s. Each stage of the page slows it: drawing by about 4.7 s, readback by about 2.8 s more, the socket by about 2.8 s more, and coupling the two (the page waiting on encoders, encoders waiting on the page) by about 2 s more. The page's own serial chain is 26 s. Both halves matter; neither alone sets the wall.

### What the page's main thread does (V8 CPU profile, 23 s of a null-sink render)

| Item | Time | Share |
|---|---|---|
| `getBufferSubData` (the readback copy) | 7.0 s | 30% |
| idle (waiting for acks) | 4.6 s | 20% |
| native, not JavaScript (socket pumping, tasks) | 3.5 s | 15% |
| three.js `getParameters`, `getProgram`, `getProgramCacheKey` (film's stage program) | 1.8 s | 8% |
| `WebSocket.send` copy | 0.9 s | 4% |
| everything else (scene programs, compositor JS, GL calls) | about 5 s | 22% |

A macOS `sample` of the renderer confirms it: inside `getBufferSubData` the time is a copy loop in `GLES2Implementation::GetBufferSubDataCHROMIUM`, not a wait for the GPU. The stack also shows `ThreadCheckerImpl`, `SequenceCheckerImpl`, `dcheck_unlock_result` and V8 register-allocator verifiers, which exist only in builds with DCHECKs on: the pinned shell appears to be such a build.

### Readback microbenchmark (pinned shell vs a release build)

A standalone page timed a 3,110,400-byte readback (the size of one I420 frame at 1080x1920):

| Path | Pinned Chromium 157 snapshot | Chrome for Testing 149 (release) |
|---|---|---|
| `getBufferSubData` from a pixel-pack buffer, after its fence | 3.0 to 3.5 ms | 0.26 to 0.46 ms |
| synchronous `readPixels` | 5.4 ms | 7.4 ms |
| WebGPU `mapAsync` plus copy out of the mapped range | 0.33 ms | 0.24 ms |
| WebGL canvas to WebGPU (`copyExternalImageToTexture`, copy to buffer, `mapAsync`), pipelined, main thread | 0.08 ms | not run |
| `VideoFrame(canvas).copyTo` | 22 ms | 11.5 ms |

The WebGL-canvas-to-WebGPU copy returned the drawn RGB bytes exactly (0 of 3,110,400 bytes differing) when the canvas has `alpha: false`; with `alpha: true` the copy premultiplies and loses values.

## 2. Ideas tried

(Each entry: expected gain written before building, then the measured result.)

### 2.1 More encoders, a deeper feed queue (flags only)

Expected: small. If the page waits because all 6 encoder slots are busy, more slots or a deeper write queue let it run ahead.
Measured (baseline build, 2 pairs each): `--encoders=10` 35.5 and 34.5 s against 35.1 and 35.4 s; `--feedq=240` 34.2 and 34.3 s against 34.2 and 34.4 s. No gain. The ack wait is not the slot count or the queue depth.

### 2.2 Frames through a worker's socket

Expected: the null-sink page waits 9.4 s for acks because Blink pumps a large WebSocket message from the thread that sent it, and the main thread is busy drawing. A worker with its own socket should cut most of that wait: page alone 26 s to about 18 s; full render 1 to 3 s.
Measured (first look, 2 pairs): 34.40 and 34.35 s against 34.69 and 35.50 s. Ack wait fell from 13.5 to 14.4 s to 10.4 to 10.5 s, readback time rose from 9.2 to 9.6 s to 12.2 s, and machine idle fell from 16.5% to 11%. Little net gain alone on the master render: the freed time went to other contention. It pays off where the page sets the pace (section 2.5); final numbers in section 3.

### 2.3 Readback through WebGPU

Expected (written before building): `getBufferSubData` costs 3.0 to 3.5 ms per frame on the page's main thread, about 10 s per film. A WebGPU buffer map plus a copy out of the mapped range costs about 0.4 ms per frame on the same shell. The page still draws the three planes with the current WebGL shaders. A new pass moves their bytes, three to a pixel, into the canvas (an opaque canvas keeps alpha at 255, so alpha cannot carry data). WebGPU copies the canvas into a texture. A compute pass writes the bytes back tight, in the pixel-pack path's order, into a buffer that is mapped. Each step moves 8-bit values only, so the bytes must equal the current path's. Expected gain: page readback 9.0 to 9.6 s down to about 1.5 s, renderer CPU about 7 s lower, and 2 to 4 s off the full render (about 89 to 94% of baseline wall time). The decoupled experiments put readback's cost to x264 at about 2.8 s; the gain is larger if the page's chain is the limit. When the browser has no WebGPU, the page keeps the pixel-pack path.

Measured, default master (`--nocache`, 3 time-paired rounds, this build includes 2.2): baseline 34.27, 35.48, 34.75 s; candidate 35.32, 35.06, 34.73 s. Medians 34.75 s and 35.06 s: 101% of baseline wall time, inside the run-to-run spread. Every run's output was the same stream as the baseline's (the mp4 bytes are equal once the install's version tag in the metadata is masked: `5d5a98b8…` for all six). The page's readback time rose (9.0 to 9.6 s before, 12.7 to 13.2 s after), because the page now waits for the map instead of copying; its socket send time fell from 1.0 s to 0.2 s. Renderer CPU fell by about 3 s (33 to 30 CPU s), the GPU process rose by about 3.6 s (7.0 to 10.6 CPU s). The work moved from one process to the other; the total did not fall.

### 2.4 A release build of the shell (experiment only, not part of the batch)

Question: the pinned shell appears to have DCHECKs on (section 1). Does a release build make the page cheap enough to move the wall? Playwright's Chrome for Testing 149.0.7827.55 headless shell (already on this Mac; nothing downloaded) ran the baseline build once. Output: the same stream as the pinned shell's (`5d5a98b8…`, frames and audio equal). Page-side CPU fell by about 15 CPU s (renderer 33 to 23, network service 7.8 to 4.6, GPU process 7.0 to 5.2), draw time 8.4 to 6.4 s. Wall: 35.69 s, with a cold-cache plan of 2.95 s; the frames phase took 32.3 s against 32.1 to 33.4 s on the pinned shell. One run, so this bounds the gain rather than measures it: a 25% cut in page-side CPU did not visibly shorten the master render.

### Why the master render does not move

During the frames phase the Mac has 0 to 10% idle CPU. The CPU goes to x264 (about 215 to 240 CPU s in a render; 175 to 185 CPU s when the same chunks are encoded alone), the page side (about 60 CPU s), and other apps on the Mac (50 to 75 CPU s in these runs). With the default output fixed (x264 medium, crf 16, 3 threads, 30-frame chunks), the x264 work cannot shrink, and page-side savings return roughly one second of wall per 9 to 10 CPU s saved, less when x264 slows from contention anyway. Changes that move page-side work between processes (2.2, 2.3) return nothing. The page-side changes matter only where the page, not x264, sets the pace: VideoToolbox renders and previews (next section).

### 2.5 Where the page sets the pace: VideoToolbox and preview

With `--preset=vt` the encoding moves to the media engine and the Mac sits at 50 to 55% idle; with `--preview` (half size, x264 veryfast) at about 60%. There the page's own chain sets the wall. Three time-paired rounds of three builds: the baseline, the candidate with only the worker socket (2.2, run as `--readback=webgl`), and the candidate with the WebGPU readback too (2.3).

| Render | Baseline | Worker socket only | Worker socket and WebGPU readback |
|---|---|---|---|
| `--nocache --preset=vt --crf=80` | 29.94 s (29.88 to 30.04) | 24.76 s (24.64 to 25.05), 83% | 26.75 s (26.75 to 26.78), 89% |
| `--nocache --preview` | 18.49 s (18.28 to 18.54) | 17.70 s (17.46 to 18.02), 96% | 20.42 s (20.23 to 20.63), 110% |

Medians, with the spread in brackets. In the VideoToolbox renders the page's wait for acks fell from 9.8 s to 0.9 s with the worker socket. The WebGPU readback made both renders slower than the worker socket alone: the page waits longer for each mapped frame (readback 11.9 s with the pixel-pack path, 12.3 s with WebGPU, in the VideoToolbox renders; 7.3 s and 9.6 s in the previews).

The WebGPU readback also failed the output check once: one of its three preview renders wrote a different stream (`1732625d…` against `f9b2dd92…` for every other preview render, 4 baseline and 3 worker-only). The cause is not established; a race between the WebGL drawing and the WebGPU copy of the canvas is the leading hypothesis. The earlier checks had passed (180 frames of raw-frame hashes, and three full master renders).

The WebGPU version of the three files is kept in the scratchpad (`gpu-reelrt.js`, `gpu-page.js`, `gpu-render.ts`, path at the end of this file).

Decision: the WebGPU readback is out of the batch: no gain on the master render, slower where the page sets the pace, and a nondeterministic output. The worker socket stays: 83% of baseline wall time for VideoToolbox renders, 96% for previews, and no loss on the master render (section 3 has the final paired numbers).

## 3. Final paired numbers (the batch: worker socket only)

Time-paired rounds, baseline build (`afdfc3d`) against this batch, each in its own clone of the film. Wall time of `./movas render`, as the batch's share of the baseline median.

| Render | Rounds | Baseline median (spread) | Batch median (spread) | Share of baseline |
|---|---|---|---|---|
| Master, `--nocache` | 3 | 35.06 s (34.66 to 35.30) | 34.34 s (34.12 to 34.61) | 98% |
| VideoToolbox, `--nocache --preset=vt --crf=80` | 2 | 29.78 s (29.69 to 29.86) | 24.78 s (24.66 to 24.90) | 83% |
| Preview, `--nocache --preview` | 2 | 18.30 s (18.26 to 18.35) | 17.54 s (17.45 to 17.63) | 96% |
| One-cue note (s10 flash opacity, a new value each round) | 3 | 2.63 s (2.63 to 2.64) | 2.63 s (2.60 to 2.65) | 100% |
| No-op (the same score again, all chunks cached) | 3 | 1.79 s (1.78 to 1.83) | 1.79 s (1.78 to 1.80) | 100% |

The same code path, run earlier as `--readback=webgl` (section 2.5), gave 83% for VideoToolbox and 96% for previews over 3 more rounds, and two earlier master rounds gave 34.40 and 34.35 s against 34.69 and 35.50 s. The master gain is about 0.7 s, inside the spread of single runs (about 1.2 s); the claim is "no loss", not "faster". The fixes from the review (section 4) landed during the second master round; they do not touch the frame path. The note renders took 2.6 s here, against 2.2 to 2.4 s in the project notes: a different note and a loaded Mac; both builds are equal.

Every pair wrote the same stream: master `5d5a98b8…`, VideoToolbox `8f7a22e5…`, preview `f9b2dd92…`, and for the notes one hash per opacity, the same on both builds (`41ecb76d…`, `c3936655…`, `e43ac0e8…`). These are md5s of the mp4 with the install's version tag (`movas:<16 hex>` in the metadata, which hashes the runtime files and so differs between builds by design) masked; outside those 16 bytes the files are equal.

What the worker socket costs: one module worker and one more socket per render. On a master render, renderer CPU rose about 3.5 CPU s (33.1 to 33.4 against 36.6 to 37.1: the send copies and the pumping now run on the worker's thread beside the main thread), the network service about 1 CPU s and the GPU process about 0.8 CPU s; the Mac's idle fell from about 15.5% to about 11%. Draw time rose about 0.9 s per master render, 0.5 s per preview and 1.2 s per VideoToolbox render, from that contention. One-time cost: `runtime/reelrt.js` changed (its readback methods take the destination buffer), and the chunk cache key hashes that file, so the first render of every film after this batch redraws in full.

## 4. Review

An independent review agent read the diff with the requirements (byte-identical output in every mode, failures fail the render, `done` only after every frame, no cost for cached renders, nothing that grows with film length). It found no defect in frame order, chunk boundaries or `done` ordering, and three failure-path risks:

1. A sender failure before the protocol socket opens: `say()` threw on a socket still connecting, the error was lost, and the render would hang until the 600 s timeout. Fixed: `say()` keeps messages until the socket opens (this also covers page errors that early, which had the same gap before this batch).
2. `WebSocket.send` must copy the buffer, because the worker hands the same buffer back to the page right after. The WebSocket API defines `send()` on the buffer's contents at the call, and Blink copies; every output check in this report passed. Not changed.
3. A closing frame socket was unhandled on both ends. Fixed: the worker reports a closed socket to the page, and `render.ts` fails the render when the frame socket closes before the render finished.

## 5. Gates

| Gate | Result | Evidence |
|---|---|---|
| 1. Full `--nocache` render decodes equal to a baseline render made the same way | Pass | Decoded video md5 `a24adcc7f8315f58a523e03db19ec181` and audio md5 `ea01a46ba6f204d9acb7d68b71b68717` on both builds (`ffmpeg -map 0:v -f md5`, `-map 0:a -f md5`). The streams are equal too: masked mp4 md5 `5d5a98b8…` on every master render of both builds in this session. The audio md5 matches the one in `doing.md`; its video hash `e8565127…` does not match this one, and this session did not establish how or on which score that one was made. |
| 2. A note render equals a `--nocache` render of the same score | Pass | s10 flash opacity set to .15: the cached render (2.61 s, one or two chunks drawn) and the `--nocache` render (33.85 s) wrote the same stream, `219d0822…`. |
| 3. `./movas purity` on the full film | Pass | "PASS purity: 11 scenes, 0 frames differ", 56 s. |
| 4. `test-rules`, `test-ops`, `leak` | Pass, with pre-existing failures named | `leak`: 0 hits. `test-rules`: 78 of 78 on both builds; the fixtures' renders take the shell from the install's own `vendor/`, so the worktree got a temporary symlink to the main checkout's `vendor/`, removed afterwards. `test-ops`: 13 of 16 on both builds, the same three failures on the baseline (`apply.undo`: the score no longer holds the word it edits; `options.take`; `options.panel`); they depend on the film's current score, not on this batch. |
| 5. Note and no-op renders not slower | Pass | Section 3: 100% and 100%, 3 rounds each. |
| 6. `--preview`, `--scenes=`, `--range`, `--noaudio`, manifest | Pass | Each on both builds with `--nocache`, same stream: preview `f9b2dd92…`, `--scenes=s01,s03` `454a8478…`, `--range=0-90` `24601c3b…`, `--noaudio` `9ee72728…`. Manifests of the full renders: the same keys and the same 109-chunk grid (`from`, `frames`); only `comment`, `version`, `sha256`, `out` and the encoder's `encKey` and `keyBase` differ, as they hash the runtime files. |

Found on the way, not caused by this batch: `--range=600-780` fails the output check on both builds ("frame rate 30.337…, expected 30", "video lasts 5.933333 s, expected 6 s"), after `concat.ts` falls back to the concat demuxer because the chunks "do not share timescale and edit". `--range=0-90` passes. Not investigated further.

## 6. Opt-in options (different output, so not defaults)

- `--preset=vt --crf=80` (VideoToolbox): 24.78 s with this batch, 71% of the default master's baseline wall time (35.06 s). The project notes put its file at about 180 MB against 106 MB, and say it needs about q80 to match x264 on small text. Quality was not judged again in this session.
- `--preset=faster --crf=14` (x264): not measured again in this session; the project notes have 31.7 s and 129.8 MB on the earlier build.
- A release build of the pinned shell's Chromium revision: one master run with a release 149 shell gave the same stream and 25% less page-side CPU, and no visible change in the master wall time (section 2.4). It was not measured on VideoToolbox renders or previews, where the page sets the pace and the gain could be larger. Pinning another shell changes the render lock; that is a decision for the project owner.

## 7. Not done, and what is left

- Previews and VideoToolbox renders still wait on the GPU side: about 12 s of each VideoToolbox render is the page waiting for its readback fences, about 4 ms per frame. Hypothesis, not measured: the cost is per render pass (the compositor switches render targets many times a frame on a tile-based GPU). GPU timer queries per pass would test it. This does not move the master render.
- Overlapping the plan pass with the first chunks: at most about 0.8 s of a full redraw, and a protocol change. `doing.md` item 3 (a persistent page and a plan memo) is the larger lever for notes and no-op renders.
- Film code, out of scope: the film's three.js stage program spends about 1.8 s of the page's main thread per film in `getParameters`, `getProgram` and `getProgramCacheKey`.
- Frames to ffmpeg through files instead of pipes: about 5 CPU s of Deno system time, against about 10 GB written to disk per full render. Not pursued.

## 8. Risks and what is not verified

- The frame socket depends on `WebSocket.send` copying the buffer at the call (the worker hands the buffer back right after). That is what the WebSocket API specifies and what Blink does; a browser that kept a reference would send wrong pixels, which the output checks would show.
- The protocol now has two sockets: text only on `/pipe`, pixels only on `/frames`; each side fails the render on the wrong kind.
- Every file response now carries the page's network policy, so the worker runs under it too.
- The first render of each film after this batch redraws every chunk (the cache key hashes `runtime/reelrt.js`).
- Not run: Linux (the bazzite Mesa path), other GPUs, `--stills` and `./movas look` (they use the same draw loop and transport), listening to the sound (the decoded audio md5 is equal).
- Not established: why the WebGPU readback wrote a different stream once.
- Background load on the Mac (50 to 75 CPU s of other apps per master render) was not controlled; all comparisons are time-paired, and the master result is inside the spread.

The scripts behind these numbers (`bench.py`, `rounds.sh`, `notes.sh`, `gate*.sh`, every run in `runs.jsonl`) are kept outside version control in `.work/perf-2026-11-04/` of the movas checkout (`runs.jsonl.gz`).
