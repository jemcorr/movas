// reelrt: draws one display list per frame on one WebGL2 context. No DOM text, no layout engine, no dependencies.
// A display list is plain JSON, so it can be hashed, diffed and checked with no pixels.
// Coordinates are frame pixels, y down. All colors are premultiplied when they reach the blend stage.

export const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const mul3 = (a, b) => [
  a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
  a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
  a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
];
export const apply3 = (m, x, y) => { const w = m[6] * x + m[7] * y + m[8]; return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w]; };
export const translate3 = (x, y) => [1, 0, x, 0, 1, y, 0, 0, 1];
export const scale3 = (s, sy = s) => [s, 0, 0, 0, sy, 0, 0, 0, 1];
export const rotate3 = (rad) => { const c = Math.cos(rad), s = Math.sin(rad); return [c, -s, 0, s, c, 0, 0, 0, 1]; };
/** Scale, rotate about an origin. */
export const about3 = (ox, oy, m) => mul3(mul3(translate3(ox, oy), m), translate3(-ox, -oy));
/** CSS "perspective: d" on a parent plus rotateY then rotateX on a child, both centered on (cx, cy), reduced to the z=0 plane. */
export const persp3 = (cx, cy, d, ryDeg, rxDeg) => {
  const ry = (ryDeg * Math.PI) / 180, rx = (rxDeg * Math.PI) / 180;
  const cY = Math.cos(ry), sY = Math.sin(ry), cX = Math.cos(rx), sX = Math.sin(rx);
  // rotateY * rotateX applied to (x, y, 0): x' = cY x + sY sX y, y' = cX y, z' = -sY x + cY sX y.
  const a = cY, b = sY * sX, c = cX, e = -sY, f = cY * sX;
  return about3(cx, cy, [a, b, 0, 0, c, 0, -e / d, -f / d, 1]);
};

export const parseColor = (s) => {
  if (Array.isArray(s)) return s;
  if (s[0] === "#") {
    const h = s.slice(1);
    const v = h.length === 3 ? h.split("").map((c) => parseInt(c + c, 16)) : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length > 6 ? parseInt(h.slice(6, 8), 16) : 255];
    return [v[0] / 255, v[1] / 255, v[2] / 255, (v[3] ?? 255) / 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(s);
  const v = m[1].split(",").map(parseFloat);
  return [v[0] / 255, v[1] / 255, v[2] / 255, v[3] ?? 1];
};
const pm = (c, o = 1) => [c[0] * c[3] * o, c[1] * c[3] * o, c[2] * c[3] * o, c[3] * o];

const VS = `#version 300 es
layout(location=0) in vec2 p;
uniform mat3 uM; uniform mat3 uCM; uniform vec4 uRect; uniform vec2 uRes;
out vec2 vLocal; out vec2 vUV; out vec2 vClip;
void main(){ vec2 l=uRect.xy+p*uRect.zw; vec3 h=uM*vec3(l,1.);
 vec2 n=vec2(h.x/h.z/uRes.x*2.-1.,1.-h.y/h.z/uRes.y*2.);
 gl_Position=vec4(n*h.z,0.,h.z); vLocal=l; vUV=p; vClip=(uCM*vec3(l,1.)).xy; }`;
const CLIP = `
uniform vec4 uClip; uniform vec4 uClipR; uniform float uClipFade; uniform float uHasClip; in vec2 vClip;
float sdRR(vec2 q,vec2 b,vec4 r){ float k=q.x>0.?(q.y>0.?r.z:r.y):(q.y>0.?r.w:r.x); vec2 d=abs(q)-b+k; return min(max(d.x,d.y),0.)+length(max(d,0.))-k; }
float clipA(){ if(uHasClip<.5) return 1.; vec2 c=uClip.xy+uClip.zw*.5; float d=sdRR(vClip-c,uClip.zw*.5,uClipR); float a=clamp(.5-d/max(fwidth(d),1e-4),0.,1.);
 if(uClipFade>0.) a*=clamp((vClip.y-uClip.y)/uClipFade,0.,1.); return a; }`;
const FS_RR = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o;
uniform vec4 uBox; uniform vec4 uRad; uniform vec4 uCol; uniform vec4 uStrokeCol; uniform float uStroke;${CLIP}
void main(){ vec2 c=uBox.xy+uBox.zw*.5; float d=sdRR(vLocal-c,uBox.zw*.5,uRad); float w=max(fwidth(d),1e-4); float a=clamp(.5-d/w,0.,1.);
 vec4 col=uCol; if(uStroke>0.){ float s=clamp(.5-(d+uStroke)/w,0.,1.); col=mix(uStrokeCol,uCol,s); }
 o=col*a*clipA(); }`;
// Blurred rounded box, after Evan Wallace, "Fast rounded rectangle shadows".
const FS_SHADOW = `#version 300 es
precision highp float; in vec2 vLocal; out vec4 o;
uniform vec4 uBox; uniform float uR; uniform float uSigma; uniform vec4 uCol; uniform vec4 uHole; uniform float uHoleR;${CLIP}
float gs(float x,float s){ return exp(-(x*x)/(2.*s*s))/(sqrt(6.2831853)*s); }
vec2 erf2(vec2 x){ vec2 s=sign(x),a=abs(x); x=1.+(.278393+(.230389+.078108*(a*a))*a)*a; x*=x; return s-s/(x*x); }
float rowX(float x,float y,float s,float cr,vec2 hs){ float d=min(hs.y-cr-abs(y),0.); float cu=hs.x-cr+sqrt(max(0.,cr*cr-d*d)); vec2 i=.5+.5*erf2((x+vec2(-cu,cu))*(sqrt(.5)/s)); return i.y-i.x; }
float shadowA(vec2 p,vec2 hs,float cr,float s){ float lo=clamp(-3.*s,p.y-hs.y,p.y+hs.y),hi=clamp(3.*s,p.y-hs.y,p.y+hs.y),st=(hi-lo)/4.,y=lo+st*.5,v=0.; for(int i=0;i<4;i++){ v+=rowX(p.x,p.y-y,s,cr,hs)*gs(y,s)*st; y+=st; } return v; }
void main(){ vec2 c=uBox.xy+uBox.zw*.5; float a=shadowA(vLocal-c,uBox.zw*.5,uR,max(uSigma,.5));
 if(uHole.z>0.){ vec2 hc=uHole.xy+uHole.zw*.5; float d=sdRR(vLocal-hc,uHole.zw*.5,vec4(uHoleR)); a*=clamp(.5+d/max(fwidth(d),1e-4),0.,1.); }
 o=uCol*a*clipA(); }`;
const FS_TEX = `#version 300 es
precision highp float; in vec2 vUV; out vec4 o;
uniform sampler2D uT; uniform float uOp; uniform float uLod; uniform float uSS; uniform vec4 uTint; uniform float uFlip;${CLIP}
void main(){ vec2 uv=uFlip>.5?vec2(vUV.x,1.-vUV.y):vUV; vec4 a;
 if(uLod>.01) a=textureLod(uT,uv,uLod);
 else if(uSS>.5){ vec2 dx=dFdx(uv),dy=dFdy(uv); a=(texture(uT,uv+.25*dx+.125*dy,-1.)+texture(uT,uv-.25*dx-.125*dy,-1.)+texture(uT,uv+.125*dx-.25*dy,-1.)+texture(uT,uv-.125*dx+.25*dy,-1.))*.25; }
 else a=texture(uT,uv);
 if(uTint.a>=0.) a=vec4(uTint.rgb,1.)*a.a*uTint.a;
 o=a*uOp*clipA(); }`;
const FS_GRAD = `#version 300 es
precision highp float; in vec2 vUV; out vec4 o;
uniform float uKind; uniform vec4 uStops[6]; uniform float uPos[6]; uniform int uN; uniform vec4 uG; uniform float uOp; uniform vec2 uRes;
void main(){ float t; vec2 px=vUV*uRes;
 if(uKind<.5){ vec2 d=uG.zw-uG.xy; t=dot(px-uG.xy,d)/dot(d,d); } else { t=length((px-uG.xy)/uG.zw); }
 t=clamp(t,0.,1.); vec4 c=uStops[0]; for(int i=1;i<uN;i++){ float a=uPos[i-1],b=uPos[i]; if(t>=a){ c=mix(uStops[i-1],uStops[i],clamp((t-a)/max(b-a,1e-5),0.,1.)); } }
 o=c*uOp; }`;
const FS_BLUR = `#version 300 es
precision highp float; in vec2 vUV; out vec4 o; uniform sampler2D uT; uniform vec2 uDir; uniform float uSigma; uniform int uN;
void main(){ vec2 uv=vec2(vUV.x,1.-vUV.y); vec4 s=texture(uT,uv); float w=1.; int n=uN; for(int i=1;i<=n;i++){ float g=exp(-float(i*i)/(2.*uSigma*uSigma)); s+=(texture(uT,uv+uDir*float(i))+texture(uT,uv-uDir*float(i)))*g; w+=2.*g; } o=s/w; }`;
const FS_FILTER = `#version 300 es
precision highp float; in vec2 vUV; out vec4 o; uniform sampler2D uT; uniform float uOp; uniform float uBright; uniform vec2 uSplit;
void main(){ vec4 a; vec2 uv=vec2(vUV.x,1.-vUV.y);
 if(uSplit.x!=0.||uSplit.y!=0.){ vec4 r=texture(uT,uv+uSplit); vec4 g=texture(uT,uv-uSplit); a=vec4(r.r,g.g,g.b,max(r.a,g.a)); } else a=texture(uT,uv);
 a.rgb*=uBright; o=a*uOp; }`;
// RGB to Y'CbCr, BT.709 limited range, written directly so no later stage guesses the matrix.
// A plane's row 0 holds the frame's top row, so readPixels returns the frame top first. Chroma is left-cosited with a 1-2-1 filter.
const FS_Y = `#version 300 es
precision highp float; in vec2 vUV; out vec4 o; uniform sampler2D uT;
void main(){ vec3 c=texture(uT,vUV).rgb; o=vec4((16.+219.*dot(c,vec3(.2126,.7152,.0722)))/255.,0.,0.,1.); }`;
const FS_C = `#version 300 es
precision highp float; in vec2 vUV; out vec4 o; uniform sampler2D uT; uniform vec2 uPx; uniform float uWhich;
void main(){ vec2 uv=vUV; vec3 c=.25*texture(uT,uv+vec2(-1.5,0.)*uPx).rgb+.5*texture(uT,uv+vec2(-.5,0.)*uPx).rgb+.25*texture(uT,uv+vec2(.5,0.)*uPx).rgb;
 float y=dot(c,vec3(.2126,.7152,.0722)); float v=uWhich<.5?(c.b-y)/1.8556:(c.r-y)/1.5748; o=vec4((128.+224.*v)/255.,0.,0.,1.); }`;

export class Compositor {
  constructor(gl, W, H, programs = {}, scale = 1) {
    this.gl = gl; this.W = W; this.H = H; this.programs = programs; this.scale = scale;
    this.tw = Math.round((W * scale) / 2) * 2; this.th = Math.round((H * scale) / 2) * 2;
    const q = gl.createVertexArray(); gl.bindVertexArray(q);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.quad = q;
    this.p = { rr: this.mk(FS_RR), shadow: this.mk(FS_SHADOW), tex: this.mk(FS_TEX), grad: this.mk(FS_GRAD), blur: this.mk(FS_BLUR), filter: this.mk(FS_FILTER), y: this.mk(FS_Y), c: this.mk(FS_C) };
    this.textCache = new Map(); this.images = new Map(); this.pool = [];
    this.bakeCanvas = document.createElement("canvas");
    this.bakes = 0; this.drawCalls = 0;
    const tw = this.tw, th = this.th;
    this.main = this.fbo(tw, th, gl.RGBA8, gl.RGBA, true);
    this.yT = this.fbo(tw, th, gl.R8, gl.RED); this.uT = this.fbo(tw >> 1, th >> 1, gl.R8, gl.RED); this.vT = this.fbo(tw >> 1, th >> 1, gl.R8, gl.RED);
    this.target = this.main;
    this.pack = new Uint8Array(tw * th + 2 * (tw >> 1) * (th >> 1));
    this.measureCache = new Map();
  }
  mk(fs) {
    const gl = this.gl;
    const sh = (t, s) => { const x = gl.createShader(t); gl.shaderSource(x, s); gl.compileShader(x); if (!gl.getShaderParameter(x, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(x) + "\n" + s); return x; };
    const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, "p"); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name.replace(/\[0\]$/, "")] = gl.getUniformLocation(p, a.name); }
    return { p, u };
  }
  fbo(w, h, ifmt, fmt, depth = false) {
    const gl = this.gl;
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, ifmt, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    let rb = null;
    if (depth) { rb = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, rb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb); }
    return { f, t, w, h };
  }
  acquire(w = this.tw, h = this.th) { const i = this.pool.findIndex((x) => x.w === w && x.h === h); return i >= 0 ? this.pool.splice(i, 1)[0] : this.fbo(w, h, this.gl.RGBA8, this.gl.RGBA, true); }
  release(x) { this.pool.push(x); }
  bind(t) { const gl = this.gl; this.target = t; gl.bindFramebuffer(gl.FRAMEBUFFER, t.f); gl.viewport(0, 0, t.w, t.h); }
  use(prog, rect, M, CM, clip) {
    const gl = this.gl, u = prog.u; gl.useProgram(prog.p); gl.bindVertexArray(this.quad);
    gl.uniform4f(u.uRect, rect[0], rect[1], rect[2], rect[3]); gl.uniformMatrix3fv(u.uM, true, M); gl.uniformMatrix3fv(u.uCM, true, CM); gl.uniform2f(u.uRes, this.W, this.H);
    if (u.uHasClip) { if (clip) { gl.uniform1f(u.uHasClip, 1); gl.uniform4f(u.uClip, clip.x, clip.y, clip.w, clip.h); const r = clip.r ?? 0; gl.uniform4f(u.uClipR, r, r, r, r); gl.uniform1f(u.uClipFade, clip.fadeTop ?? 0); } else gl.uniform1f(u.uHasClip, 0); }
    this.drawCalls++;
  }
  blendNormal() { const gl = this.gl; gl.enable(gl.BLEND); gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.blendEquation(gl.FUNC_ADD); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.depthMask(false); }
  // ---------- text ----------
  fontStr(o) { return `${o.weight ?? 600} ${o.size}px ${o.family ?? "Inter"}`; }
  setCtx(x, o) { x.font = this.fontStr(o); x.letterSpacing = `${(o.tracking ?? 0) * o.size}px`; x.fontKerning = "normal"; x.textRendering = "geometricPrecision"; x.textAlign = "left"; x.textBaseline = "alphabetic"; }
  measure(o) {
    const k = `${o.weight}|${o.size}|${o.tracking}|${o.text}`; let m = this.measureCache.get(k); if (m) return m;
    const x = this.bakeCanvas.getContext("2d"); this.setCtx(x, o); const r = x.measureText(o.text); m = { width: r.width }; this.measureCache.set(k, m); return m;
  }
  /** Bakes one text run (spans keep their color) once, at 2x, with mips. A shadow is a second, blurred texture. */
  bakeText(o) {
    const key = JSON.stringify([o.text, o.spans, o.weight, o.size, o.tracking, o.color, o.family]);
    let e = this.textCache.get(key); if (e) return e;
    const gl = this.gl, k = 2, c = document.createElement("canvas"), x = c.getContext("2d", { willReadFrequently: true });
    this.setCtx(x, o);
    const parts = o.spans ?? [{ text: o.text, color: o.color }];
    const widths = parts.map((p) => x.measureText(p.text).width);
    const w = widths.reduce((a, b) => a + b, 0), asc = o.size * 1.05, desc = o.size * 0.35, pad = Math.ceil(o.size * 0.25);
    c.width = Math.ceil((w + pad * 2) * k); c.height = Math.ceil((asc + desc + pad * 2) * k);
    this.setCtx(x, o); x.setTransform(k, 0, 0, k, 0, 0);
    let cx = pad; parts.forEach((p, i) => { x.fillStyle = p.color; x.fillText(p.text, cx, pad + asc); cx += widths[i]; });
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    e = { t, w, asc, pad, tw: c.width / k, th: c.height / k, shadows: new Map() };
    this.textCache.set(key, e); this.bakes++;
    return e;
  }
  bakeShadow(o, e, blur) {
    let s = e.shadows.get(blur); if (s) return s;
    const gl = this.gl, c = document.createElement("canvas"), x = c.getContext("2d", { willReadFrequently: true }), pad = Math.ceil(blur * 1.5) + e.pad;
    c.width = Math.ceil(e.w + pad * 2); c.height = Math.ceil(e.th + pad * 2 - e.pad * 2);
    this.setCtx(x, o); x.filter = `blur(${blur / 2}px)`; x.fillStyle = "#000";
    x.fillText(o.text, pad, pad + e.asc);
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    s = { t, pad, tw: c.width, th: c.height }; e.shadows.set(blur, s); return s;
  }
  drawTexQuad(t, rect, M, CM, clip, op = 1, lod = 0, ss = 0, tint = null, flip = 0) {
    const gl = this.gl, P = this.p.tex; this.use(P, rect, M, CM, clip);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(P.u.uT, 0);
    gl.uniform1f(P.u.uOp, op); gl.uniform1f(P.u.uLod, lod); gl.uniform1f(P.u.uSS, ss); gl.uniform1f(P.u.uFlip, flip);
    if (tint) gl.uniform4f(P.u.uTint, tint[0], tint[1], tint[2], tint[3]); else gl.uniform4f(P.u.uTint, 0, 0, 0, -1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  // ---------- ops ----------
  run(list, M = I3, CM = I3, clip = null, op = 1) { for (const o of list) { if (o) this.draw1(o, M, CM, clip, op); } }
  draw1(o, M0, CM0, clip, op0) {
    const gl = this.gl;
    const M = o.m ? mul3(M0, o.m) : M0, CM = o.m ? mul3(CM0, o.m) : CM0, op = op0 * (o.opacity ?? 1);
    if (op <= 0.0005 && o.op !== "group") return;
    switch (o.op) {
      case "fill": {
        const P = this.p.grad; this.use(P, [0, 0, this.W, this.H], I3, I3, null);
        const stops = o.stops ?? [[0, o.color], [1, o.color]];
        const flat = []; const pos = []; for (const [t, c] of stops) { flat.push(...pm(parseColor(c))); pos.push(t); }
        while (pos.length < 6) { pos.push(1); flat.push(0, 0, 0, 0); }
        gl.uniform4fv(P.u.uStops, flat); gl.uniform1fv(P.u.uPos, pos); gl.uniform1i(P.u.uN, stops.length); gl.uniform1f(P.u.uOp, op);
        gl.uniform1f(P.u.uKind, o.kind === "radial" ? 1 : 0); gl.uniform2f(P.u.uRes, this.W, this.H);
        if (o.screen) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        const g = o.g ?? [0, 0, 0, this.H]; gl.uniform4f(P.u.uG, g[0], g[1], g[2], g[3]);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); if (o.screen) this.blendNormal(); return;
      }
      case "shadow": {
        const sigma = (o.blur ?? 0) / 2, pad = sigma * 3 + 2, P = this.p.shadow, ox = o.dx ?? 0, oy = o.dy ?? 0, sp = o.spread ?? 0;
        const box = [o.x + ox - sp, o.y + oy - sp, o.w + sp * 2, o.h + sp * 2];
        this.use(P, [box[0] - pad, box[1] - pad, box[2] + pad * 2, box[3] + pad * 2], M, CM, clip);
        gl.uniform4f(P.u.uBox, ...box); gl.uniform1f(P.u.uR, Math.min(o.r ?? 0, box[2] / 2, box[3] / 2)); gl.uniform1f(P.u.uSigma, sigma);
        gl.uniform4fv(P.u.uCol, pm(parseColor(o.color), op)); gl.uniform4f(P.u.uHole, o.x, o.y, o.w, o.h); gl.uniform1f(P.u.uHoleR, o.r ?? 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); return;
      }
      case "rect": {
        const P = this.p.rr, s = o.stroke?.w ?? 0, pad = 1.5;
        this.use(P, [o.x - pad, o.y - pad, o.w + pad * 2, o.h + pad * 2], M, CM, clip);
        gl.uniform4f(P.u.uBox, o.x, o.y, o.w, o.h);
        const r = o.radii ?? [o.r ?? 0, o.r ?? 0, o.r ?? 0, o.r ?? 0]; gl.uniform4f(P.u.uRad, r[0], r[1], r[2], r[3]);
        gl.uniform4fv(P.u.uCol, pm(parseColor(o.color), op)); gl.uniform1f(P.u.uStroke, s);
        if (s) gl.uniform4fv(P.u.uStrokeCol, pm(parseColor(o.stroke.color), op));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); return;
      }
      case "text": {
        const e = this.bakeText(o);
        const ax = o.align === "center" ? e.w / 2 : o.align === "right" ? e.w : 0;
        const x0 = o.x - ax - e.pad, y0 = o.y - e.asc - e.pad;
        if (o.shadow) {
          const s = this.bakeShadow(o, e, o.shadow.blur);
          const a = parseColor(o.shadow.color)[3] * (o.shadow.fade ?? 1);
          this.drawTexQuad(s.t, [o.x - ax - s.pad + (o.shadow.dx ?? 0), o.y - e.asc - s.pad + (o.shadow.dy ?? 0), s.tw, s.th], M, CM, clip, op * a);
        }
        const lod = o.blur > 0.05 ? Math.log2(1 + o.blur * 2 * 2) : 0;
        this.drawTexQuad(e.t, [x0, y0, e.tw, e.th], M, CM, clip, op, lod, 1);
        return;
      }
      case "image": {
        const t = this.imageTex(o);
        // screen: the premultiplied color screens onto what is drawn already, as CSS mix-blend-mode: screen does.
        if (o.screen) gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_COLOR, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        this.drawTexQuad(t, [o.x, o.y, o.w, o.h], M, CM, clip, op, 0, 1);
        if (o.screen) this.blendNormal();
        return;
      }
      case "html": {
        const t = this.images.get(this.htmlKey(o)); if (!t) throw new Error(`html not baked: "${o.html.slice(0, 80)}"`);
        this.drawTexQuad(t, [o.x, o.y, o.w, o.h], M, CM, clip, op, 0, 1);
        return;
      }
      case "gl": {
        const prog = this.programs[o.program]; if (!prog) throw new Error(`no gl program ${o.program}`);
        const prev = this.target;
        if (prog.texture) {
          // A program with its own renderer, three.js for one, draws wherever it likes and hands back a y-up texture.
          const tex = prog.texture(o.params);
          gl.bindVertexArray(this.quad); gl.disable(gl.SCISSOR_TEST); gl.disable(gl.STENCIL_TEST); gl.colorMask(true, true, true, true); gl.frontFace(gl.CCW);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          this.bind(prev); this.blendNormal(); this.drawTexQuad(tex, [0, 0, this.W, this.H], M, CM, clip, op, 0, 0, null, 1); return;
        }
        const tmp = this.acquire(); this.bind(tmp);
        gl.clearColor(0, 0, 0, 0); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        prog.draw(o.params);
        gl.bindVertexArray(this.quad);
        this.bind(prev); this.blendNormal(); this.drawTexQuad(tmp.t, [0, 0, this.W, this.H], M, CM, clip, op, 0, 0, null, 1); this.release(tmp); return;
      }
      case "group": {
        const needIso = o.filter || (o.isolate && (o.opacity ?? 1) < 0.999);
        const clip2 = o.clip ? o.clip : clip;
        const CM2 = o.clip ? I3 : CM;
        if (!needIso) { if (op > 0.0005) this.run(o.children, M, CM2, clip2, op); return; }
        const prev = this.target, tmp = this.acquire(); this.bind(tmp); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
        this.run(o.children, M, CM2, clip2, 1);
        let src = tmp; const extra = [];
        const f = o.filter ?? {};
        // blurX runs first, as the production's SVG whip filter does, then the isotropic blur. One-direction taps reach 3 sigma up to sigma 70.
        if (f.blurX > 0.05) { const t = this.blurFbo(src, f.blurX, { y: false, cap: 128 }); extra.push(t); src = t; }
        if (f.blur > 0.05) { const t = this.blurFbo(src, f.blur); extra.push(t); src = t; }
        this.bind(prev); this.blendNormal();
        // shift moves the blurred result after the blur, as CSS translate moves a filtered element. The blur never sees the shift.
        const P = this.p.filter, sh = f.shift ?? [0, 0]; this.use(P, [0, 0, this.W, this.H], translate3(sh[0], sh[1]), I3, null);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.t); gl.uniform1i(P.u.uT, 0); gl.uniform1f(P.u.uOp, op); gl.uniform1f(P.u.uBright, f.brightness ?? 1);
        const sp = f.split ?? [0, 0]; gl.uniform2f(P.u.uSplit, sp[0] / this.W, sp[1] / this.H);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.release(tmp); for (const t of extra) this.release(t);
        return;
      }
      default: throw new Error(`unknown op ${o.op}`);
    }
  }
  /** Gaussian blur, sigma in design pixels, at half resolution. Both passes by default; x or y alone gives a one-direction kernel. cap bounds the taps per side, 2 design px apart. */
  blurFbo(src, sigma, { x = true, y = true, cap = 32 } = {}) {
    const gl = this.gl, w = this.tw >> 1, h = this.th >> 1, P = this.p.blur;
    const s = Math.max(0.3, sigma / 2), n = Math.min(Math.ceil(s * 3), cap);
    gl.disable(gl.BLEND);
    const pass = (from, to, dx, dy) => {
      this.bind(to); this.use(P, [0, 0, this.W, this.H], I3, I3, null);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, from.t); gl.uniform1i(P.u.uT, 0); gl.uniform2f(P.u.uDir, dx, dy); gl.uniform1f(P.u.uSigma, s); gl.uniform1i(P.u.uN, n);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    let out;
    if (x && y) { const a = this.acquire(w, h); out = this.acquire(w, h); pass(src, a, 2 / this.W, 0); pass(a, out, 0, 2 / this.H); this.release(a); }
    else { out = this.acquire(w, h); pass(src, out, x ? 2 / this.W : 0, y ? 2 / this.H : 0); }
    this.blendNormal();
    return out;
  }
  /** Decodes every image a list names by url, before the frame draws. Video frames arrive this way, one file per frame. */
  async preload(list) {
    const walk = async (ops) => { for (const o of ops) { if (!o) continue; if (o.op === "image" && o.src && !this.images.has(o.src) && !this.decoded?.has(o.src)) { const b = await (await fetch(o.src)).blob(); (this.decoded ??= new Map()).set(o.src, await createImageBitmap(b, { colorSpaceConversion: "none" })); } if (o.op === "html") await this.htmlBake(o); if (o.children) await walk(o.children); } };
    await walk(list);
  }
  // ---------- HTML and CSS, baked once into a texture. A hidden DOM copy of the same HTML gives the words and boxes the checks read. ----------
  htmlKey(o) { return `html:${o.w}x${o.h}:${o.scale ?? 2}:${o.html}`; }
  htmlHost(o) {
    const d = document.createElement("div");
    d.setAttribute("style", `box-sizing:border-box;position:relative;overflow:hidden;width:${o.w}px;height:${o.h}px;margin:0;font:600 40px Inter,sans-serif;color:#fff`);
    d.innerHTML = o.html;
    return d;
  }
  /** The words and boxes inside a bake, local to the op: one row per block or per data-id, in document order. Synchronous, so the plan pass can read it with no pixels. */
  htmlMeasure(o) {
    const key = this.htmlKey(o); this.htmlRuns ??= new Map();
    let runs = this.htmlRuns.get(key); if (runs) return runs;
    const host = this.htmlHost(o), wrap = document.createElement("div");
    wrap.setAttribute("style", "position:fixed;left:0;top:0;opacity:0;pointer-events:none;z-index:-1");
    wrap.appendChild(host); document.body.appendChild(wrap);
    const H = host.getBoundingClientRect(), owners = new Map();
    const inlineDisplay = (el) => { const d = getComputedStyle(el).display; return d === "inline" || d === "contents"; };
    const ownerOf = (el) => { const tagged = el.closest("[data-id]"); if (tagged && host.contains(tagged)) return tagged; let e = el; while (e !== host && inlineDisplay(e)) e = e.parentElement; return e; };
    const tw = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const el = n.parentElement; if (el.closest("style,script,template") || !n.nodeValue.trim()) continue;
      const cs = getComputedStyle(el); if (cs.visibility !== "visible") continue;
      const range = document.createRange(); range.selectNodeContents(n);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0); if (!rects.length) continue;
      // CSS opacity multiplies down the tree, and each overflow ancestor clips: both change what a viewer can read.
      let a = 1, clip = [0, 0, o.w, o.h];
      for (let e = el; e && e !== host; e = e.parentElement) {
        const c = getComputedStyle(e); a *= Number(c.opacity);
        if (c.overflowX !== "visible" || c.overflowY !== "visible") { const b = e.getBoundingClientRect(); clip = [Math.max(clip[0], b.left - H.left), Math.max(clip[1], b.top - H.top), Math.min(clip[2], b.right - H.left), Math.min(clip[3], b.bottom - H.top)]; }
      }
      if (/(, 0\)|transparent)$/.test(cs.color)) a = 0;
      let inside = 0, area = 0, box = null;
      for (const r of rects) {
        const b = [r.left - H.left, r.top - H.top, r.right - H.left, r.bottom - H.top], ar = (b[2] - b[0]) * (b[3] - b[1]);
        area += ar; inside += Math.max(0, Math.min(b[2], clip[2]) - Math.max(b[0], clip[0])) * Math.max(0, Math.min(b[3], clip[3]) - Math.max(b[1], clip[1]));
        box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
      }
      const owner = ownerOf(el);
      const row = owners.get(owner) ?? { id: owner.getAttribute("data-id"), text: "", box: null, size: 0, a: 0, area: 0, inside: 0 };
      row.text += n.nodeValue; row.size = Math.max(row.size, parseFloat(cs.fontSize)); row.a = Math.max(row.a, a); row.area += area; row.inside += inside;
      row.box = row.box ? [Math.min(row.box[0], box[0]), Math.min(row.box[1], box[1]), Math.max(row.box[2], box[2]), Math.max(row.box[3], box[3])] : box;
      owners.set(owner, row);
    }
    wrap.remove();
    runs = [...owners.values()].map((r) => ({ id: r.id, text: r.text.replace(/\s+/g, " ").trim(), box: r.box, size: r.size, a: r.a, vis: r.area > 0 ? r.inside / r.area : 0 }));
    this.htmlRuns.set(key, runs);
    return runs;
  }
  async htmlFontCss() {
    if (this.fontCss) return this.fontCss;
    const face = async (w) => { const b = new Uint8Array(await (await fetch(`/fonts/inter-latin-${w}-normal.woff2`)).arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192)); return `@font-face{font-family:Inter;font-weight:${w};src:url(data:font/woff2;base64,${btoa(s)}) format("woff2")}`; };
    return (this.fontCss = (await Promise.all([600, 800].map(face))).join(""));
  }
  /** Bakes once per distinct HTML. foreignObject loads no outside file, so the fonts travel inside the SVG. */
  async htmlBake(o) {
    const key = this.htmlKey(o); if (this.images.has(key)) return;
    const k = o.scale ?? 2, css = await this.htmlFontCss();
    const body = new XMLSerializer().serializeToString(this.htmlHost(o));
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${o.w}" height="${o.h}"><foreignObject x="0" y="0" width="${o.w}" height="${o.h}"><style xmlns="http://www.w3.org/1999/xhtml">${css}</style>${body}</foreignObject></svg>`;
    const img = new Image(); img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    try { await img.decode(); } catch (e) { throw new Error(`html bake failed for "${o.html.slice(0, 80)}": ${e.message}`); }
    const c = document.createElement("canvas"); c.width = Math.round(o.w * k); c.height = Math.round(o.h * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    this.imageTex({ key, bake: () => c }); this.bakes++;
    // Text that changes per frame would otherwise hold a texture per frame.
    (this.htmlOrder ??= []).push(key);
    if (this.htmlOrder.length > 64) { const old = this.htmlOrder.shift(); this.gl.deleteTexture(this.images.get(old)); this.images.delete(old); }
  }
  imageTex(o) {
    const key = o.src ?? o.key;
    let t = this.images.get(key); if (t) return t;
    const gl = this.gl, c = o.src ? this.decoded.get(o.src) : (o.bake ?? this.bakers?.[o.key])(); t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    if (o.src) { this.decoded.delete(o.src); this.urlOrder = this.urlOrder ?? []; this.urlOrder.push(o.src); if (this.urlOrder.length > 48) { const old = this.urlOrder.shift(); gl.deleteTexture(this.images.get(old)); this.images.delete(old); } }
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c); gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.images.set(key, t); return t;
  }
  /** Draws a list into the main target. */
  frame(list) {
    const gl = this.gl; this.bind(this.main); gl.clearColor(0, 0, 0, 1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.blendNormal(); this.run(list);
  }
  /** Same result as readYUV, split in two so the GPU can run ahead: start now, collect a few frames later, in order. */
  startRead() {
    const gl = this.gl, W = this.tw, H = this.th, cw = W >> 1, ch = H >> 1; gl.disable(gl.BLEND);
    const pass = (dst, prog, set) => { this.bind(dst); this.use(prog, [0, 0, this.W, this.H], I3, I3, null); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.main.t); gl.uniform1i(prog.u.uT, 0); set?.(prog.u); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
    pass(this.yT, this.p.y);
    pass(this.uT, this.p.c, (u) => { gl.uniform2f(u.uPx, 1 / W, 1 / H); gl.uniform1f(u.uWhich, 0); });
    pass(this.vT, this.p.c, (u) => { gl.uniform2f(u.uPx, 1 / W, 1 / H); gl.uniform1f(u.uWhich, 1); });
    this.pbos ??= []; const size = this.pack.length;
    let e = this.pbos.pop(); if (!e) { e = { pbo: gl.createBuffer() }; gl.bindBuffer(gl.PIXEL_PACK_BUFFER, e.pbo); gl.bufferData(gl.PIXEL_PACK_BUFFER, size, gl.STREAM_READ); }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, e.pbo); gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.yT.f); gl.readPixels(0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.uT.f); gl.readPixels(0, 0, cw, ch, gl.RED, gl.UNSIGNED_BYTE, W * H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vT.f); gl.readPixels(0, 0, cw, ch, gl.RED, gl.UNSIGNED_BYTE, W * H + cw * ch);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    e.sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0); gl.flush(); this.blendNormal();
    return e;
  }
  async finishRead(e, yieldTask) {
    const gl = this.gl;
    for (;;) { const st = gl.clientWaitSync(e.sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0); if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) break; if (st === gl.WAIT_FAILED) throw new Error("fence failed"); await yieldTask(); }
    gl.deleteSync(e.sync); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, e.pbo); gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pack); gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.pbos.push(e); return this.pack;
  }
  /** The composed frame as planar YUV 4:2:0, top row first, ready for a rawvideo pipe. */
  readYUV() {
    const gl = this.gl, W = this.tw, H = this.th, cw = W >> 1, ch = H >> 1; gl.disable(gl.BLEND);
    const pass = (dst, prog, set) => { this.bind(dst); this.use(prog, [0, 0, this.W, this.H], I3, I3, null); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.main.t); gl.uniform1i(prog.u.uT, 0); set?.(prog.u); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); };
    pass(this.yT, this.p.y);
    pass(this.uT, this.p.c, (u) => { gl.uniform2f(u.uPx, 1 / W, 1 / H); gl.uniform1f(u.uWhich, 0); });
    pass(this.vT, this.p.c, (u) => { gl.uniform2f(u.uPx, 1 / W, 1 / H); gl.uniform1f(u.uWhich, 1); });
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.yT.f); gl.readPixels(0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, this.pack, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.uT.f); gl.readPixels(0, 0, cw, ch, gl.RED, gl.UNSIGNED_BYTE, this.pack, W * H);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.vT.f); gl.readPixels(0, 0, cw, ch, gl.RED, gl.UNSIGNED_BYTE, this.pack, W * H + cw * ch);
    this.blendNormal();
    return this.pack;
  }
}

/** Flattens a list into boxes for the checks: every text with its frame-space box, size and effective opacity, and opaque rects. */
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = c * h - b * i, C = b * f - c * e, D = f * g - d * i, E = a * i - c * g, F = c * d - a * f, G = d * h - e * g, H = b * g - a * h, I = a * e - b * d;
  const det = a * A + b * D + c * G;
  return [A / det, B / det, C / det, D / det, E / det, F / det, G / det, H / det, I / det];
};
const aabb = (pts) => { const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]); return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]; };
const overlap = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

/**
 * What a frame's list puts on screen, for checks that need no pixels. Each text gets its screen box, its true projected
 * size at the worse edge, the share left after its clips, and its scene. Text marked `decor` is skipped.
 */
export function flatten(list, comp, M = I3, op = 1, clips = [], out = [], scene = null) {
  for (const o of list) {
    if (!o) continue;
    const m = o.m ? mul3(M, o.m) : M, a = op * (o.opacity ?? 1);
    if (o.op === "group") {
      flatten(o.children, comp, m, o.filter?.brightness ? a * Math.min(1, o.filter.brightness) : a, o.clip ? [...clips, { ...o.clip, m }] : clips, out, o.scene ?? scene);
      continue;
    }
    if (o.op === "html" && !o.decor) {
      // Words inside a bake read like text ops: same fields, same checks. A row with no data-id stays out here, as an id-less text op does.
      for (const r of comp.htmlMeasure(o)) {
        if (!r.id) continue;
        const [bx0, by0, bx1, by1] = [o.x + r.box[0], o.y + r.box[1], o.x + r.box[2], o.y + r.box[3]];
        const corners = [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]], pts = corners.map((p) => apply3(m, p[0], p[1]));
        const edge = (t, b) => Math.hypot(t[0] - b[0], t[1] - b[1]);
        const px = r.size * Math.min(edge(pts[0], pts[3]), edge(pts[1], pts[2])) / Math.max(1e-6, by1 - by0);
        let vis = r.vis;
        for (const c of clips) {
          const toClip = mul3(inv3(c.m), m), box = aabb(corners.map((p) => apply3(toClip, p[0], p[1])));
          const clipBox = [c.x, c.y + (c.fadeTop ?? 0), c.x + c.w, c.y + c.h], area = (box[2] - box[0]) * (box[3] - box[1]);
          vis = Math.min(vis, area > 0 ? overlap(box, clipBox) / area : 0);
        }
        out.push({ k: "text", id: r.id, text: r.text, box: aabb(pts), corners: pts, px, a: a * r.a, vis, scene, html: true });
      }
    } else if (o.op === "text" && o.id && !o.decor) {
      const w = comp.measure(o).width, ax = o.align === "center" ? w / 2 : o.align === "right" ? w : 0;
      const x0 = o.x - ax, x1 = x0 + w, y0 = o.y - o.size * 0.76, y1 = o.y + o.size * 0.2;
      const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
      const pts = corners.map((p) => apply3(m, p[0], p[1]));
      const edge = (t, b) => Math.hypot(t[0] - b[0], t[1] - b[1]);
      const px = (o.size * Math.min(edge(pts[0], pts[3]), edge(pts[1], pts[2]))) / (y1 - y0);
      let vis = 1;
      for (const c of clips) {
        const toClip = mul3(inv3(c.m), m), box = aabb(corners.map((p) => apply3(toClip, p[0], p[1])));
        const clipBox = [c.x, c.y + (c.fadeTop ?? 0), c.x + c.w, c.y + c.h], area = (box[2] - box[0]) * (box[3] - box[1]);
        vis = Math.min(vis, area > 0 ? overlap(box, clipBox) / area : 0);
      }
      out.push({ k: "text", id: o.id, text: o.text, box: aabb(pts), corners: pts, px, a: o.blur > 2 ? a * 0.3 : a, vis, scene });
    } else if (o.op === "rect" && o.id && (parseColor(o.color)[3] * a) > 0.9) {
      const local = [o.x, o.y, o.x + o.w, o.y + o.h], pts = [[local[0], local[1]], [local[2], local[1]], [local[2], local[3]], [local[0], local[3]]].map((p) => apply3(m, p[0], p[1]));
      out.push({ k: "rect", id: o.id, box: aabb(pts), local, inv: inv3(m), a, scene });
    } else if (o.op === "inventory") { for (const it of o.items ?? []) out.push({ vis: 1, scene, ...it }); }
  }
  return out;
}
/** The share of a text's screen corners that fall inside a rect, measured in the rect's own space. */
export const coveredBy = (text, rect) => {
  const box = aabb(text.corners.map((p) => apply3(rect.inv, p[0], p[1]))), area = (box[2] - box[0]) * (box[3] - box[1]);
  return area > 0 ? overlap(box, rect.local) / area : 0;
};
