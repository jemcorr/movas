# Writing a scene program

A scene program is a pure JavaScript function from a local frame number to a display list of drawing operations. One WebGL2 compositor draws the list. There is no React. HTML and CSS exist through one op, `html`, below. `Math.random` and `Date.now` throw. three.js calls `Math.random`, so load it with `const { THREE, addons } = await loadThree(1, ["three/addons/loaders/GLTFLoader.js"])` from `../lib.js`, and build objects inside `withSeeded(1, () => ...)`. Elsewhere, use `rand(n)` from `programs/lib.js` for chance.

A module lives at `film/programs/scenes/<name>.js` and joins the film by being there. It imports `../lib.js` as written below, and the renderer finds the tool's `programs/lib.js`. A file in `film/programs/` wins over one of the same name in `programs/`:

```js
import { punch, dock, dimFilter, prog, pop, leave, lerp, clamp01, bezier, EXPO_OUT, BACK_OUT, EXPO_IN, IN_OUT, rand, mul3, translate3, scale3, rotate3, about3, persp3, wrap, clipOp, INK } from "../lib.js";
export async function install({ gl, programs, extra, solved, fmt }) {
  extra.s02 = (v, f, ctx) => [ /* ops */ ];
}
```

`film.js` calls `extra.sNN(v, f, ctx)` for each frame of that scene. A scene with no entry plays as blocking.

- `f` is the scene-local frame. It runs from `-pre` to `length + post`.
- `v.start` is the scene's absolute start frame, `v.end` its length, plus `v.id` and `v.title`.
- `v.ev("name")` is the local frame of an event and throws on an unknown id. `v.has(name)` tests. `./movas brief s02` prints a scene's source and derived times.
- `v.text("name")` returns `{ id, text, verb, words, kv }`. `v.texts` lists them all, with sub-rows such as `s02.status.flip`: a loop that draws each line once skips ids with more than 2 parts. `kv` holds the line's `key=value` pairs, so numbers and data can live in the score: `cue chart @t values=12,40,31`.
- `v.comp.measure({ text, size, weight, tracking })` returns `{ width }`.
- `ctx.W`, `ctx.H` and `ctx.fmt` are the format. Derive layout from them, so a format change does not need a rewrite.

Times come from `v.ev`. Durations of an animation, in frames, are fine (`prog(f, at, 9)`). Every on-screen string comes from the score through `v.text(name).text`. Give each meaningful `text` op `id: v.text(name).id`, because the checks read that id. Mark decoration `decor: true`.

## Drawing operations

`frame coordinates are design pixels, y down`. Colors are CSS strings. `m` is a 3x3 row-major matrix: use `mul3(translate3(x, y), about3(cx, cy, scale3(s)))`. `about3(cx, cy, M)` applies M around a point. `rotate3(radians)`. `persp3(cx, cy, d, ryDeg, rxDeg)` matches CSS `perspective(d) rotateY() rotateX()` around (cx, cy).

- `{op:"fill", stops:[[0,"#000"],[1,"#111"]], g:[x0,y0,x1,y1], kind:"linear"|"radial", opacity, screen:true}`. Radial `g` is `[cx,cy,rx,ry]`. Fills the whole frame.
- `{op:"shadow", x,y,w,h, r, blur, dy, dx, color}`. CSS box-shadow of a rounded rect. `blur` as in CSS.
- `{op:"rect", x,y,w,h, r or radii:[tl,tr,br,bl], color, stroke:{w,color}, opacity, id}`.
- `{op:"text", id, text, spans, weight:600|800, size, tracking, family, color, align:"left"|"center"|"right", x, y, opacity, m, blur, shadow:{blur,dy,dx,color}, decor}`. `y` is the baseline. `tracking` is in em. For CSS text in a line box of height L at top T, the baseline is about `T + (L - size) / 2 + size * 0.86` for Inter. Check against the master. `spans:[{text,color},...]` colours parts of a line.
- `{op:"image", key, bake, x,y,w,h}`. `bake` is a function returning a canvas, called once for a `key`. `ICONS` in lib.js holds the ported icons by key.
- `{op:"html", html, x,y,w,h, scale, decor}`. Real HTML and CSS in a box of `w` by `h`: flex, grid, gradient, radius, shadow, rotate, opacity. It bakes once per distinct `html` string, at 2x (`scale`), about 4 to 16 ms, then moves as a texture under `m`, `opacity` and groups, so animate it from outside and keep the string still. Fonts: Inter at weights 600 and 800 only. No outside files: an image needs a `data:` URL. Put score words in with `htmlText(v, "name", "font:800 80px Inter;color:#fff")` from lib.js, so `report` and `truth` read them, with `esc()` for anything else. An element with `data-id="<score id>"` reports words and box as a text op does. Words with no `data-id` are still read, and they count as unregistered unless the score holds them. The bake clips at its box, so a CSS `box-shadow` needs padding inside the box, or a `shadow` op behind it. The checks do not see words drawn as images, and they read a CSS transform inside the HTML by its box only.
- `{op:"gl", program, params}`. Draws a GL program: GL programs a film installs in `programs`.
- `{op:"group", m, opacity, isolate:true, clip:{x,y,w,h,r,fadeTop}, filter:{brightness, blur, blurX, shift:[dx,dy], split:[dx,dy]}, children:[...]}`. `isolate` makes the opacity apply to the group as a whole, like CSS opacity. A `filter` isolates too.

Helpers in `programs/lib.js`:
- `punch(v, name, {size, top, highlight, out, W, lineHeight})`: a headline with word groups that slam in.
- `dock(v, name, {size, dockLeft, dockTop, W, H, centerY, highlight, comp})`: the DOCK caption.
- In a group filter, `blurX` is a one-direction blur that runs before `blur`, up to sigma 70, for whip moves. `shift` moves the filtered result after the blur, as CSS translate moves a filtered element. A rect, gradient or image op with `screen:true` blends as CSS `mix-blend-mode: screen`.
- `dimFilter(v)`: the filter for the action layer while a headline is up. Put it on a group around the action, and keep headlines outside of it.
- `wrap(comp, text, o, maxW)`: greedy line wrap. `prog(f, from, dur, easing)`, `pop(f, at, dur)`, `leave(f, at, dur)`, `lerp`, `clamp01`, `bezier`, the easings `EXPO_OUT, BACK_OUT, EXPO_IN, IN_OUT`, `smoothDim`.

- `clipOp(v, name, f, W, H)`: one frame of a `clip` line as an image op, or null outside its time.
