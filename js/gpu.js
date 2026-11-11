// GPU engine: the whole simulation runs in WebGL2 fragment shaders.
//
// State lives in two ping-pong pairs of textures, one texel per cell:
//   A (RGBA16UI): element id, shade, life timer, burn timer
//   B (RGBA32F):  temperature, velocity x, velocity y, blast power
// Each step: a coarse MAC-grid fluid solve (splat, pressure, project), one physics
// pass (heat, velocities, state changes, fire, reactions, explosions, machines),
// beam passes, and several 2x2 block (Margolus) movement passes that move every
// cell at most one step per pass, so nothing is ever duplicated or lost.
// Objects (balls, ducks...) keep their physics on the CPU, using an asynchronous
// read back of the area around them, and are drawn into a mask texture.
(function () {
  'use strict';
  const FX = window.FX;
  const { S, EL, ID, RX, NEL } = FX;

  const MOVES = 6; // movement passes per step: the top speed in cells per step
  const BEAM_PASSES = 6;
  const MAX_DABS = 32;
  const EL_ROWS = 10;

  // ---------- capability ----------
  let support = null;
  function supported() {
    if (support !== null) return support;
    support = false;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      if (gl) {
        support = !!gl.getExtension('EXT_color_buffer_float');
        const lose = gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      }
    } catch (e) { support = false; }
    return support;
  }

  function context(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.bindVertexArray(gl.createVertexArray());
    return gl;
  }

  // ---------- element tables ----------
  const stateNum = (st) => (st === S.TOOL || st === S.OBJECT ? S.STATIC : st);
  const FIXED = new Set(['wall', 'cloner', 'drain', 'void', 'heater', 'cooler']);
  function slots(v) {
    if (v == null || v === -1) return [-1, -1, -1, -1];
    if (!Array.isArray(v)) return [v, v, v, v];
    return [0, 1, 2, 3].map((s) => v[Math.floor((s * v.length) / 4)]);
  }
  function elementData() {
    const d = new Float32Array(NEL * EL_ROWS * 4);
    const put = (id, row, v) => d.set(v, (row * NEL + id) * 4);
    for (const e of EL) {
      const hex = parseInt(e.color.slice(1), 16);
      put(e.id, 0, [stateNum(e.state), e.density, e.cond, e.visc]);
      put(e.id, 1, [e.hiT == null ? 1e9 : e.hiT, e.loT == null ? -1e9 : e.loT, e.igniteT == null ? 1e9 : e.igniteT, e.explode || 0]);
      put(e.id, 2, slots(e.hiTo));
      put(e.id, 3, slots(e.loTo));
      put(e.id, 4, slots(e.lifeTo));
      put(e.id, 5, slots(e.burnTo));
      put(e.id, 6, [e.life ? e.life[0] : 0, e.life ? e.life[1] : 0, e.burn || 0, e.burnTime || 0]);
      put(e.id, 7, [e.temp, FIXED.has(e.key) || e.part ? 1 : 0, e.glow ? 1 : 0, e.pop || 0]);
      put(e.id, 8, [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, e.vary]);
      put(e.id, 9, [e.trail == null ? -1 : e.trail, e.part ? 1 : 0, 0, 0]);
    }
    return d;
  }
  function reactionData() {
    const d = new Float32Array(NEL * NEL * 4);
    for (let a = 0; a < NEL; a++) for (let b = 0; b < NEL; b++) {
      const r = RX[a * NEL + b];
      if (r) d.set([r.a, r.b, r.p, r.heat], (a * NEL + b) * 4); // texel (b, a)
    }
    return d;
  }

  // ---------- shaders ----------
  const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

  const COMMON = `
uniform sampler2D uEl;
uniform int uFrame;
vec4 el(int id, int row) { return texelFetch(uEl, ivec2(id, row), 0); }
int stOf(int id) { return int(el(id, 0).x); }
bool fixedEl(int id) { return el(id, 7).y > 0.5; }
int pick(int id, int row, float r) { return int(el(id, row)[min(3, int(r * 4.0))]); }
uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}
vec3 rnd3(ivec2 p, int salt) { return vec3(pcg3d(uvec3(uvec2(p + 4096), uint(uFrame) * 128u + uint(salt)))) * (1.0 / 4294967296.0); }
bool inside(ivec2 q) { return q.x >= 0 && q.y >= 0 && q.x < W && q.y < H; }
bool movableSt(int s) { return s == ST_POWDER || s == ST_LIQUID || s == ST_GAS || s == ST_FIRE; }
// World.set: a fresh cell of this element.
void setCell(inout uvec4 A, inout vec4 B, int id, vec3 r) {
  vec4 e6 = el(id, 6);
  uint life = e6.y > 0.0 ? uint(e6.x + floor(r.y * (e6.y - e6.x))) : 0u;
  A = uvec4(uint(id), uint(r.x * 255.99), max(life, e6.y > 0.0 ? 1u : 0u), 0u);
  if (id != 0) B.x = el(id, 7).x;
  B.y = 0.0; B.z = 0.0;
}
// World.change: become another element, keeping temperature and motion.
void changeCell(inout uvec4 A, inout vec4 B, int id, vec3 r) {
  float t = B.x; vec2 v = B.yz;
  setCell(A, B, id, r);
  if (id != 0) {
    B.x = t;
    if (stOf(id) != ST_STATIC) B.yz = v;
    float pop = el(id, 7).w;
    if (pop > 0.0) { B.z = -pop * (0.6 + 0.8 * r.z); B.y = (r.x - 0.5) * pop; }
  }
}
// Catch fire, or blow up.
bool ignite(inout uvec4 A, inout vec4 B, int id, vec3 r) {
  float ex = el(id, 1).w;
  if (ex > 0.0) { setCell(A, B, ID_FIRE, r); B.x = 1400.0; B.w = ex + 3.0; return true; }
  if (A.w == 0u) A.w = uint(max(1.0, el(id, 6).w * (0.6 + 0.8 * r.z)));
  return false;
}
const ivec2 D4[4] = ivec2[4](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1));
const ivec2 D8[8] = ivec2[8](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1), ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1));
`;

  const STATE_OUT = `
uniform usampler2D uA;
uniform sampler2D uB;
layout(location = 0) out uvec4 oA;
layout(location = 1) out vec4 oB;
`;

  // Coarse cell classification: kind (0 air, 1 liquid, 2 solid), liquid count, solid count, capacity.
  const FS_KIND = `
uniform usampler2D uA;
uniform usampler2D uMask;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int nl = 0, ns = 0, cap = 0;
  for (int j = 0; j < SC; j++) for (int i = 0; i < SC; i++) {
    ivec2 q = c * SC + ivec2(i, j);
    if (q.x >= W || q.y >= H) continue;
    cap++;
    if (texelFetch(uMask, q, 0).r > 0u) { ns++; continue; }
    int s = stOf(int(texelFetch(uA, q, 0).x));
    if (s == ST_LIQUID) nl++;
    else if (s == ST_STATIC || s == ST_POWDER) ns++;
  }
  // Any liquid makes it a fluid cell, even beside walls, so narrow pipes still carry pressure.
  float kind = nl > 0 ? 1.0 : ns * 2 >= cap ? 2.0 : 0.0;
  o = vec4(kind, float(nl), float(ns), float(cap));
}`;

  // Liquid cell velocities -> grid faces. Texel (i, j): u on the left face, v on the top face of cell (i, j).
  // Output (u, v) after gravity and solid boundaries, and (u0, v0) before, for the FLIP update.
  const FS_P2G = `
uniform usampler2D uA;
uniform sampler2D uB;
uniform usampler2D uMask;
uniform sampler2D uK;
uniform float uG;
out vec4 o;
float kindAt(ivec2 c) { return texelFetch(uK, c, 0).x; }
bool liq(ivec2 q) { return texelFetch(uMask, q, 0).r == 0u && stOf(int(texelFetch(uA, q, 0).x)) == ST_LIQUID; }
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  float u = 0.0, uw = 0.0, v = 0.0, vw = 0.0;
  if (f.y < CH) {
    for (int j = 0; j < SC; j++) for (int i = 0; i < 2 * SC; i++) {
      ivec2 q = ivec2((f.x - 1) * SC + i, f.y * SC + j);
      if (q.x < 0 || q.x >= W || q.y >= H || !liq(q)) continue;
      float fx = (float(q.x - (q.x / SC) * SC) + 0.5) / float(SC);
      float w = i < SC ? fx : 1.0 - fx;
      u += texelFetch(uB, q, 0).y * w; uw += w;
    }
  }
  if (f.x < CW) {
    for (int j = 0; j < 2 * SC; j++) for (int i = 0; i < SC; i++) {
      ivec2 q = ivec2(f.x * SC + i, (f.y - 1) * SC + j);
      if (q.y < 0 || q.y >= H || q.x >= W || !liq(q)) continue;
      float fy = (float(q.y - (q.y / SC) * SC) + 0.5) / float(SC);
      float w = j < SC ? fy : 1.0 - fy;
      v += texelFetch(uB, q, 0).z * w; vw += w;
    }
  }
  u = uw > 0.0 ? u / uw : 0.0;
  v = vw > 0.0 ? v / vw : 0.0;
  float u0 = u, v0 = v;
  if (f.x < CW && f.y >= 1 && f.y < CH && (kindAt(f - ivec2(0, 1)) == 1.0 || kindAt(f) == 1.0)) v += uG;
  if (f.y >= CH || f.x == 0 || f.x >= CW || kindAt(f - ivec2(1, 0)) == 2.0 || kindAt(f) == 2.0) u = 0.0;
  if (f.x >= CW || f.y == 0 || f.y >= CH || kindAt(f - ivec2(0, 1)) == 2.0 || kindAt(f) == 2.0) v = 0.0;
  o = vec4(u, v, u0, v0);
}`;

  // Open air: 1 at the top of the world, spread along rows and columns of air cells, fading a little
  // with every hop. Air sealed in by liquid and walls (a bubble in a pipe) fades to 0 within a few steps.
  const FS_OPEN = `
uniform sampler2D uK;
uniform sampler2D uO;
uniform ivec2 uAxis;
out vec4 o;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (texelFetch(uK, c, 0).x != 0.0) { o = vec4(0.0); return; }
  if (c.y == 0) { o = vec4(1.0, 0.0, 0.0, 0.0); return; }
  float m = texelFetch(uO, c, 0).x;
  for (int s = -1; s <= 1; s += 2) for (int j = 1; j <= 48; j++) {
    ivec2 q = c + uAxis * (j * s);
    if (q.x < 0 || q.y < 0 || q.x >= CW || q.y >= CH || texelFetch(uK, q, 0).x != 0.0) break;
    m = max(m, texelFetch(uO, q, 0).x);
  }
  o = vec4(m * 0.96, 0.0, 0.0, 0.0);
}`;

  const FS_DIV = `
uniform sampler2D uK;
uniform sampler2D uF;
uniform sampler2D uO;
uniform float uFill;
out vec4 o;
float kindAt(ivec2 c) { return texelFetch(uK, c, 0).x; }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 k = texelFetch(uK, c, 0);
  vec4 f = texelFetch(uF, c, 0);
  float d = texelFetch(uF, c + ivec2(1, 0), 0).x - f.x + texelFetch(uF, c + ivec2(0, 1), 0).y - f.y;
  // Sealed air (a bubble) carries pressure like the liquid around it, so it does not act as a drain.
  if (k.x == 0.0 && texelFetch(uO, c, 0).x < 0.08) { o = vec4(1.0, d, 0.0, 0.0); return; }
  if (k.x != 1.0) { o = vec4(k.x, 0.0, 0.0, 0.0); return; }
  // Under-filled interior cells pull their neighbours in, closing holes in the bulk.
  float room = k.w - k.z;
  if (room > 0.0 && k.y < room &&
      (c.x == 0 || kindAt(c - ivec2(1, 0)) != 0.0) && (c.x == CW - 1 || kindAt(c + ivec2(1, 0)) != 0.0) &&
      (c.y == 0 || kindAt(c - ivec2(0, 1)) != 0.0) && (c.y == CH - 1 || kindAt(c + ivec2(0, 1)) != 0.0))
    d += uFill * (1.0 - k.y / room);
  o = vec4(1.0, d, 0.0, 0.0);
}`;

  // Pressure: a multigrid solve. Every level stores (kind, right hand side) in KR; kind 0 air (p = 0),
  // 1 fluid, 2 solid (no flow). The same stencil works on every level because the coarse right hand
  // side is half the sum of the fine residuals.
  const MG_HEAD = `
uniform sampler2D uKR;
uniform ivec2 uDim;
out vec4 o;
bool inDim(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < uDim.x && c.y < uDim.y; }
`;
  const FS_SMOOTH = MG_HEAD + `
uniform sampler2D uP;
uniform float uOmega;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 kr = texelFetch(uKR, c, 0);
  if (kr.x != 1.0) { o = vec4(0.0); return; }
  float sum = 0.0, cnt = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 n = c + D4[k];
    if (!inDim(n) || texelFetch(uKR, n, 0).x == 2.0) continue;
    sum += texelFetch(uP, n, 0).x; cnt += 1.0;
  }
  float p = texelFetch(uP, c, 0).x;
  o = vec4(cnt > 0.0 ? mix(p, (sum - kr.y) / cnt, uOmega) : 0.0, 0.0, 0.0, 0.0);
}`;
  const FS_RESID = MG_HEAD + `
uniform sampler2D uP;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 kr = texelFetch(uKR, c, 0);
  if (kr.x != 1.0) { o = vec4(0.0); return; }
  float sum = 0.0, cnt = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 n = c + D4[k];
    if (!inDim(n) || texelFetch(uKR, n, 0).x == 2.0) continue;
    sum += texelFetch(uP, n, 0).x; cnt += 1.0;
  }
  o = vec4(kr.y - (sum - cnt * texelFetch(uP, c, 0).x), 0.0, 0.0, 0.0);
}`;
  // uDim is the fine size here; the output is the coarse level.
  const FS_RESTRICT = MG_HEAD + `
uniform sampler2D uRes;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  bool liq = false, air = false; float r = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 q = c * 2 + ivec2(k & 1, k >> 1);
    if (!inDim(q)) continue;
    float kind = texelFetch(uKR, q, 0).x;
    if (kind == 1.0) { liq = true; r += texelFetch(uRes, q, 0).x; }
    else if (kind == 0.0) air = true;
  }
  // A coarse face spans two fine faces, so the summed fine equations are twice the coarse stencil.
  o = vec4(liq ? 1.0 : air ? 0.0 : 2.0, r * 0.5, 0.0, 0.0);
}`;
  const FS_PROLONG = MG_HEAD + `
uniform sampler2D uP;
uniform sampler2D uE;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (texelFetch(uKR, c, 0).x != 1.0) { o = vec4(0.0); return; }
  o = vec4(texelFetch(uP, c, 0).x + texelFetch(uE, c / 2, 0).x, 0.0, 0.0, 0.0);
}`;

  const FS_PROJECT = `
uniform sampler2D uK;
uniform sampler2D uF;
uniform sampler2D uP;
out vec4 o;
float kindAt(ivec2 c) { return texelFetch(uK, c, 0).x; }
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  vec4 F = texelFetch(uF, f, 0);
  float u = F.x, v = F.y;
  if (f.y < CH && f.x >= 1 && f.x < CW) {
    float a = kindAt(f - ivec2(1, 0)), b = kindAt(f);
    if (a != 2.0 && b != 2.0 && (a == 1.0 || b == 1.0)) u -= texelFetch(uP, f, 0).x - texelFetch(uP, f - ivec2(1, 0), 0).x;
  }
  if (f.x < CW && f.y >= 1 && f.y < CH) {
    float a = kindAt(f - ivec2(0, 1)), b = kindAt(f);
    if (a != 2.0 && b != 2.0 && (a == 1.0 || b == 1.0)) v -= texelFetch(uP, f, 0).x - texelFetch(uP, f - ivec2(0, 1), 0).x;
  }
  o = vec4(u, v, 0.0, 0.0);
}`;

  // Everything that happens to a cell in place, once per step.
  const FS_PHYSICS = STATE_OUT + `
uniform sampler2D uRx;
uniform sampler2D uK;
uniform sampler2D uF;
uniform sampler2D uFp;
uniform float uFlip;
uniform float uG;
uniform float uMaxV;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 A = texelFetch(uA, p, 0);
  vec4 B = texelFetch(uB, p, 0);
  int id = int(A.x);
  vec4 e0 = el(id, 0);
  int st = int(e0.x);
  vec3 r0 = rnd3(p, 1), r1 = rnd3(p, 2), r2 = rnd3(p, 3);
  vec4 rk = vec4(rnd3(p, 4), r2.x);

  // Neighbours, and heat flowing between them.
  int nid[4]; uvec4 nA[4]; vec4 nB[4];
  float t = B.x, dT = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 q = p + D4[k];
    if (inside(q)) {
      nA[k] = texelFetch(uA, q, 0); nB[k] = texelFetch(uB, q, 0); nid[k] = int(nA[k].x);
      dT += min(e0.z, el(nid[k], 0).z) * 0.22 * (nB[k].x - t);
    } else { nA[k] = uvec4(0u); nB[k] = vec4(0.0); nid[k] = -1; }
  }
  t += dT;
  if (id == 0) t += (20.0 - t) * 0.015;
  B.x = t;

  // Velocities.
  vec2 v = B.yz;
  if (st == ST_LIQUID) {
    ivec2 c = p / SC;
    vec2 fr = (vec2(p - c * SC) + 0.5) / float(SC);
    if (texelFetch(uK, c, 0).x == 2.0) {
      // Squeezed into a mostly solid coarse cell (next to walls): plain free fall.
      v.y = min(v.y + uG, uMaxV); v.x *= 0.95;
    } else {
      vec4 f00 = texelFetch(uF, c, 0), f10 = texelFetch(uF, c + ivec2(1, 0), 0), f01 = texelFetch(uF, c + ivec2(0, 1), 0);
      vec4 g00 = texelFetch(uFp, c, 0), g10 = texelFetch(uFp, c + ivec2(1, 0), 0), g01 = texelFetch(uFp, c + ivec2(0, 1), 0);
      vec2 vn = vec2(mix(g00.x, g10.x, fr.x), mix(g00.y, g01.y, fr.y));
      vec2 vo = vec2(mix(f00.z, f10.z, fr.x), mix(f00.w, f01.w, fr.y));
      v = uFlip * (v + vn - vo) + (1.0 - uFlip) * vn;
      if (e0.w > 0.0) v *= 1.0 - 0.25 * e0.w;
      v = clamp(v, -uMaxV, uMaxV);
    }
    // At a free surface (air above), drag and wall friction on upward motion stop liquid creeping up
    // walls. Liquid pushed up a full pipe by pressure keeps its speed.
    bool openAbove = nid[3] >= 0 && stOf(nid[3]) == ST_EMPTY;
    if (v.y < 0.0 && openAbove) {
      v.y *= 0.97;
      bool wallL = nid[1] < 0 || stOf(nid[1]) == ST_STATIC, wallR = nid[0] < 0 || stOf(nid[0]) == ST_STATIC;
      if (wallL || wallR) v.y *= 0.85; // and wall friction, so liquid does not creep up walls
    }
  } else if (st == ST_POWDER) {
    v.y = min(v.y + 0.2, 5.0); v.x *= 0.9;
  } else if (st == ST_GAS || st == ST_FIRE) {
    float buoy = st == ST_FIRE ? 0.1 : e0.y < 1.2 ? 0.05 : -0.02;
    v.x = (v.x + (r0.x - 0.5) * 0.5) * 0.9;
    v.y = max((v.y - buoy) * 0.94, -3.0);
  } else if (st == ST_STATIC) v = vec2(0.0);
  B.yz = v;

  bool done = false;

  // Explosions spread as a ring of blast power, one cell per step.
  float aux = B.w;
  B.w = aux > 0.0 ? -3.0 : aux < 0.0 ? min(0.0, aux + 1.0) : 0.0;
  if (aux == 0.0 && !fixedEl(id)) {
    float q = 0.0; vec2 from = vec2(0.0);
    for (int k = 0; k < 8; k++) {
      ivec2 n = p + D8[k];
      if (!inside(n)) continue;
      float w = (k < 4 ? nB[min(k, 3)].w : texelFetch(uB, n, 0).w) - (k < 4 ? 1.0 : 1.4142);
      if (w > q) { q = w; from = vec2(D8[k]); }
    }
    if (q > 0.0) {
      vec2 dir = -normalize(from);
      float ex = el(id, 1).w;
      if (ex > 0.0) { setCell(A, B, ID_FIRE, r1); B.x = 1400.0; B.w = ex + 3.0; B.yz = dir * 2.0 - vec2(0.0, 1.0); }
      else if (q > 3.0) { setCell(A, B, ID_FIRE, r1); B.x = 1400.0; B.w = q; B.yz = dir * 2.0 - vec2(0.0, 1.0); }
      else { if (id != 0) { B.yz += dir * q * 1.5 - vec2(0.0, 0.5); B.x += 70.0 * q; } B.w = q; }
      done = true;
    }
  }

  // Reactions between pairs of cells. Pairs alternate between horizontal and vertical
  // neighbours, and both cells of a pair make the same decision.
  if (!done) {
    int mode = uFrame & 3;
    ivec2 pp = mode < 2 ? p + ivec2(((p.x + mode) & 1) == 0 ? 1 : -1, 0) : p + ivec2(0, ((p.y + mode) & 1) == 0 ? 1 : -1);
    if (inside(pp)) {
      int o = int(texelFetch(uA, pp, 0).x);
      vec4 f = texelFetch(uRx, ivec2(o, id), 0);
      vec4 g = texelFetch(uRx, ivec2(id, o), 0);
      vec4 rx = vec4(0.0); int mine = -1;
      if (f.z > 0.0 && (g.z <= 0.0 || id < o)) { rx = f; mine = int(f.x); }
      else if (g.z > 0.0) { rx = g; mine = int(g.y); }
      if (rx.z > 0.0 && rnd3(min(p, pp), 9).x < rx.z) {
        if (mine >= 0) { changeCell(A, B, mine, r1); done = true; }
        B.x += rx.w;
      }
    }
  }

  // Melting, freezing, boiling.
  if (!done && id != 0) {
    vec4 e1 = el(id, 1);
    int to = -2;
    if (t >= e1.x) to = pick(id, 2, r0.y);
    else if (t <= e1.y) to = pick(id, 3, r0.y);
    if (to >= 0) { changeCell(A, B, to, r1); done = true; }
  }

  // Lifetimes (gases, fire, glow).
  if (!done && A.z > 0u && el(id, 6).y > 0.0) {
    A.z -= 1u;
    if (A.z == 0u) { changeCell(A, B, pick(id, 4, r0.z), r1); done = true; }
  }

  if (!done) {
    if (id == ID_FIRE && B.x < 500.0) B.x = 500.0 + r2.y * 400.0;
    else if (id == ID_HEATER || id == ID_COOLER) B.x = el(id, 7).x;
  }

  // Burning.
  if (!done && id != 0) {
    vec4 e1 = el(id, 1);
    if (A.w > 0u) {
      if (e1.w > 0.0) done = ignite(A, B, id, r1);
      else {
        B.x = max(B.x, 450.0);
        int n = nid[min(3, int(r2.z * 4.0))];
        if (n == ID_WATER || n == ID_SALT_WATER) { A.w = 0u; B.x = 120.0; }
        else {
          A.w -= 1u;
          if (A.w == 0u) { changeCell(A, B, pick(id, 5, r0.z), r1); done = true; }
        }
      }
    } else if (e1.z < 1e8 && B.x >= e1.z) done = ignite(A, B, id, r1);
  }

  // Catching fire from flames next door.
  if (!done && A.w == 0u) {
    float bc = el(id, 6).z;
    if (bc > 0.0) for (int k = 0; k < 4; k++) {
      if (nid[k] < 0) continue;
      if ((stOf(nid[k]) == ST_FIRE || nA[k].w > 0u) && rk[k] < bc * 2.0) { done = ignite(A, B, id, r1); break; }
    }
  }

  // Machines and growth (each cell only changes itself).
  if (!done) {
    if (id == 0) {
      for (int k = 0; k < 4; k++) {
        int n = nid[k];
        if (n < 0) continue;
        if (nA[k].w > 0u && n != ID_WATER && rk[k] < 0.0875) { setCell(A, B, ID_FIRE, r1); B.z = -0.5; break; }
        if (n == ID_CLONER && nA[k].z > 0u && rk[k] < 0.125) { setCell(A, B, int(nA[k].z), r1); if (k == 3) B.z = 0.5; break; }
        if (n == ID_PLANT && rk[k] < (k == 2 ? 0.000375 : 0.0001125)) { setCell(A, B, ID_PLANT, r1); break; }
      }
    } else {
      bool mov = movableSt(st);
      for (int k = 0; k < 4; k++) {
        int n = nid[k];
        if ((n == ID_DRAIN && st == ST_LIQUID) || (n == ID_VOID && mov)) { setCell(A, B, 0, r1); break; }
        if ((id == ID_WATER || id == ID_SALT_WATER) && n == ID_PLANT && rk[k] < 0.01) { setCell(A, B, r1.z < 0.35 ? ID_PLANT : 0, r1); break; }
      }
      if (id == ID_CLONER && A.z == 0u) {
        int k = min(3, int(r2.x * 4.0)), n = nid[k];
        if (n > 0 && !fixedEl(n) && stOf(n) != ST_EMPTY && stOf(n) != ST_BEAM) A.z = uint(n);
        else if (n == ID_CLONER && nA[k].z > 0u) A.z = nA[k].z; // a thick cloner learns through itself
      }
    }
  }
  oA = A; oB = B;
}`;

  // One 2x2 block movement pass. All four cells of a block compute the same result.
  const FS_MOVE = STATE_OUT + `
uniform usampler2D uMask;
uniform ivec2 uOff;
uniform int uPass;
uvec4 cA[4]; vec4 cB[4]; int cid[4]; int cst[4]; float cden[4]; float cvis[4]; bool cm[4]; bool cup[4];
vec2 vel[4]; int perm[4]; bool mv[4];
const float NPf = float(NP);

void swapPos(int a, int b) { int t = perm[a]; perm[a] = perm[b]; perm[b] = t; mv[a] = true; mv[b] = true; }
bool emptyLike(int c) { return cst[c] == ST_EMPTY; }
bool gasLike(int c) { return cst[c] == ST_GAS || cst[c] == ST_FIRE; }
float slow(int c) { return 1.0 - 0.75 * cvis[c]; }
float pDown(int c) {
  int s = cst[c]; float vy = vel[c].y;
  if (s == ST_POWDER) return vy >= -0.5 ? clamp((vy + 1.0) / NPf, 0.1, 1.0) : 0.0;
  if (s == ST_LIQUID) return vy >= -0.5 ? clamp((max(vy, 0.0) + 1.0) / NPf * slow(c), 0.1, 1.0) : 0.0;
  if (s == ST_GAS || s == ST_FIRE) return vy > 0.0 ? clamp(vy / NPf, 0.0, 1.0) : 0.0;
  return 0.0;
}
float pUp(int c) {
  int s = cst[c]; float vy = vel[c].y;
  if (s == ST_POWDER || s == ST_LIQUID) return vy < -0.5 ? clamp(-vy / NPf * slow(c), 0.0, 1.0) : 0.0;
  if (s == ST_GAS || s == ST_FIRE) return vy <= 0.0 ? clamp(-vy / NPf + 0.05, 0.0, 1.0) : 0.0;
  return 0.0;
}
// Chance per pass of moving sideways: velocity plus spreading out.
float pBase(int c, float dir) { return movableSt(cst[c]) ? clamp(vel[c].x * dir / NPf * slow(c), 0.0, 1.0) : 0.0; }
// Liquid that rests on something, or has liquid on top pressing down, fills gaps beside it quickly.
float pDisp(int c, bool pressed) {
  int s = cst[c];
  if (s == ST_LIQUID) return (1.0 - 0.9 * cvis[c]) * (pressed ? 0.95 : abs(vel[c].y) < 1.0 ? 0.5 : 0.1);
  if (s == ST_GAS || s == ST_FIRE) return 0.25;
  return 0.0;
}
// Can content s take the place of content d, moving vertically by dy?
bool canEnter(int s, int d, int dy, float r) {
  if (emptyLike(d)) return true;
  int sd = cst[d], ss = cst[s];
  if (sd == ST_STATIC || sd == ST_BEAM) return false;
  float da = cden[s], db = cden[d];
  if (ss == ST_POWDER) {
    if (sd == ST_LIQUID) return dy > 0 && da > db && r < 0.3;
    return sd == ST_GAS || sd == ST_FIRE;
  }
  if (ss == ST_LIQUID) {
    if (sd == ST_GAS || sd == ST_FIRE) return true;
    if (sd == ST_LIQUID && cid[s] != cid[d]) {
      if (dy > 0 && da > db) return r < 2.0 * (da - db) / (da + db) + 0.05;
      if (dy < 0 && da < db) return r < 2.0 * (db - da) / (da + db) + 0.05;
    }
    return false;
  }
  if (ss == ST_GAS || ss == ST_FIRE) {
    if (sd == ST_GAS || sd == ST_FIRE) return cid[s] != cid[d] && r < 0.25;
    if (sd == ST_LIQUID) return dy < 0 && r < 0.5;
  }
  return false;
}
bool canEnterH(int s, int d, float r) {
  if (emptyLike(d)) return true;
  int sd = cst[d], ss = cst[s];
  if (ss == ST_LIQUID || ss == ST_POWDER) return sd == ST_GAS || sd == ST_FIRE;
  if (ss == ST_GAS || ss == ST_FIRE) return (sd == ST_GAS || sd == ST_FIRE) && cid[s] != cid[d] && r < 0.25;
  return false;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 o = p - ((p - uOff) & 1);
  for (int k = 0; k < 4; k++) {
    ivec2 q = o + ivec2(k & 1, k >> 1);
    if (inside(q)) { cA[k] = texelFetch(uA, q, 0); cB[k] = texelFetch(uB, q, 0); uvec4 m = texelFetch(uMask, q, 0); cm[k] = m.r > 0u; cup[k] = m.b == 1u; }
    else { cA[k] = uvec4(uint(ID_WALL), 0u, 0u, 0u); cB[k] = vec4(20.0, 0.0, 0.0, 0.0); cm[k] = false; cup[k] = false; }
    cid[k] = int(cA[k].x);
    vec4 e0 = el(cid[k], 0);
    cst[k] = int(e0.x); cden[k] = e0.y; cvis[k] = e0.w;
    vel[k] = cB[k].yz; perm[k] = k; mv[k] = false;
  }
  vec3 r0 = rnd3(o, 16 + uPass * 4), r1 = rnd3(o, 17 + uPass * 4), r2 = rnd3(o, 18 + uPass * 4), r3 = rnd3(o, 19 + uPass * 4);

  // 0. Anything inside an object is pushed out: up first (down first when the object rises), then sideways.
  for (int k = 0; k < 4; k++) {
    if (!cm[k] || mv[k]) continue;
    int c = perm[k];
    if (!movableSt(cst[c])) continue;
    int up = cup[k] ? k + 2 : k - 2, side = k ^ 1;
    if (up > 3) up = -1;
    if (up >= 0 && !mv[up] && (emptyLike(perm[up]) || (gasLike(perm[up]) && !gasLike(c)))) { swapPos(k, up); continue; }
    if (!mv[side] && (emptyLike(perm[side]) || (gasLike(perm[side]) && !gasLike(c)))) swapPos(k, side);
  }

  // 1. Falling and rising.
  int first = r0.x < 0.5 ? 0 : 1;
  for (int n = 0; n < 2; n++) {
    int col = n == 0 ? first : 1 - first;
    int T = col, Bo = col + 2;
    if (mv[T] || mv[Bo] || cm[T] || cm[Bo]) continue;
    int ct = perm[T], cb = perm[Bo];
    float rr = n == 0 ? r0.y : r0.z, rr2 = n == 0 ? r1.x : r1.y;
    float pd = pDown(ct);
    // Liquid drops into an empty cell below quickly, so air pockets rise out of the bulk.
    if (cst[ct] == ST_LIQUID && pd > 0.0 && (emptyLike(cb) || gasLike(cb))) pd = max(pd, 0.9 * slow(ct));
    if (pd > 0.0 && rr < pd) {
      if (canEnter(ct, cb, 1, rr2)) { swapPos(T, Bo); continue; }
      int sb = cst[cb];
      if (cst[ct] == ST_POWDER && (sb == ST_STATIC || sb == ST_POWDER || sb == ST_BEAM)) vel[ct].y = 0.0;
      else if (cst[ct] == ST_LIQUID && sb == ST_STATIC) {
        if (vel[ct].y > 1.2) vel[ct].x += (rr2 < 0.5 ? -1.0 : 1.0) * vel[ct].y * 0.4; // splash sideways
        vel[ct].y = 0.0;
      }
    }
    float pu = pUp(cb);
    if (pu > 0.0 && rr < pu) {
      if (canEnter(cb, ct, -1, rr2)) { swapPos(T, Bo); continue; }
      if (cst[ct] == ST_STATIC || cst[ct] == ST_POWDER) vel[cb].y = 0.0;
    }
  }

  // 2. Sliding off slopes (diagonal), and gas slipping round obstacles.
  first = r1.z < 0.5 ? 0 : 1;
  for (int n = 0; n < 2; n++) {
    int col = n == 0 ? first : 1 - first;
    int T = col, D = (1 - col) + 2, Bo = col + 2, U = 1 - col;
    float dx = col == 0 ? 1.0 : -1.0;
    float rr = n == 0 ? r2.x : r2.y, rr2 = n == 0 ? r2.z : r3.x;
    if (!mv[T] && !mv[D] && !cm[T] && !cm[D]) {
      int ct = perm[T], below = perm[Bo];
      int s = cst[ct];
      if ((s == ST_POWDER || s == ST_LIQUID) && vel[ct].y >= -0.5 && !emptyLike(below) && !gasLike(below)) {
        float pd = s == ST_POWDER ? 0.6 : 0.8 * (1.0 - 0.8 * cvis[ct]);
        if (rr < pd && canEnter(ct, perm[D], 1, rr2)) {
          swapPos(T, D);
          if (s == ST_LIQUID) { vel[ct].x += dx * abs(vel[ct].y) * 0.35; vel[ct].y *= 0.6; }
          else { vel[ct].y *= 0.7; vel[ct].x += dx * 0.3; }
          continue;
        }
      }
    }
    if (!mv[Bo] && !mv[U] && !cm[Bo] && !cm[U]) {
      int cb = perm[Bo], above = perm[T];
      if (gasLike(cb) && vel[cb].y <= 0.0 && !emptyLike(above) && rr < 0.5 && canEnter(cb, perm[U], -1, rr2)) swapPos(Bo, U);
    }
  }

  // 3. Sideways: momentum, and liquids levelling out.
  for (int row = 0; row < 2; row++) {
    int L = row * 2, R = L + 1;
    if (mv[L] || mv[R] || cm[L] || cm[R]) continue;
    int cl = perm[L], cr = perm[R];
    float rr = row == 0 ? r3.y : r3.z, rr2 = row == 0 ? r0.x : r1.z;
    float bl = pBase(cl, 1.0), br = pBase(cr, -1.0);
    // pressed: top row resting on something, bottom row with liquid above it.
    bool pl = row == 0 ? !emptyLike(perm[2]) && !gasLike(perm[2]) : cst[perm[0]] == ST_LIQUID;
    bool pr = row == 0 ? !emptyLike(perm[3]) && !gasLike(perm[3]) : cst[perm[1]] == ST_LIQUID;
    bool wl = rr < bl + pDisp(cl, pl) * 0.5, wr = (1.0 - rr) < br + pDisp(cr, pr) * 0.5;
    if (wl && canEnterH(cl, cr, rr2)) { swapPos(L, R); continue; }
    if (wr && canEnterH(cr, cl, rr2)) { swapPos(L, R); continue; }
    if (wl && rr < bl && cst[cr] == ST_STATIC) vel[cl].x *= cst[cl] == ST_LIQUID ? -0.15 : 0.0;
    if (wr && (1.0 - rr) < br && cst[cl] == ST_STATIC) vel[cr].x *= cst[cr] == ST_LIQUID ? -0.15 : 0.0;
  }

  int me = (p.x - o.x) + 2 * (p.y - o.y);
  int c = perm[me];
  oA = cA[c];
  oB = vec4(cB[c].x, vel[c], cB[c].w);
}`;

  // Bulk flow: a run of up to RUN liquid cells (or falling grains) slides up to MAXM cells along uDir
  // into the empty cells at its front, as one piece; the empty cells move to the back of the run.
  // Block moves alone can only move liquid at its surface; this lets a whole column fall, a layer
  // flow or a pipe run full, so the bulk keeps up with the pressure solver.
  const FS_SHIFT = STATE_OUT + `
uniform usampler2D uMask;
uniform ivec2 uDir;
uniform float uPer; // shift passes per step in this direction
uniform int uSub;
#define RUN 12
#define MAXM 3
bool runner(ivec2 q) {
  if (!inside(q) || texelFetch(uMask, q, 0).r > 0u) return false;
  int s = stOf(int(texelFetch(uA, q, 0).x));
  return s == ST_LIQUID || (uDir.y > 0 && s == ST_POWDER);
}
bool hole(ivec2 q) {
  if (!inside(q) || texelFetch(uMask, q, 0).r > 0u) return false;
  return stOf(int(texelFetch(uA, q, 0).x)) == ST_EMPTY;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  oA = texelFetch(uA, p, 0); oB = texelFetch(uB, p, 0);
  // e: the first empty cell in front of the run this cell belongs to; pos: this cell's place relative to e.
  ivec2 e = ivec2(-1); int pos = 0;
  if (runner(p)) {
    for (int j = 1; j <= RUN; j++) {
      ivec2 q = p + uDir * j;
      if (runner(q)) continue;
      if (hole(q)) { e = q; pos = -j; }
      break;
    }
  } else if (hole(p)) {
    for (int k = 0; k < MAXM; k++) {
      ivec2 q = p - uDir * (k + 1);
      if (runner(q)) { e = p - uDir * k; pos = k; break; }
      if (!hole(q)) break;
    }
  }
  if (e.x < 0) return;
  int hc = 0;
  for (int k = 0; k < MAXM; k++) { if (!hole(e + uDir * k)) break; hc++; }
  ivec2 f = e - uDir;
  vec4 fe = el(int(texelFetch(uA, f, 0).x), 0);
  float sp = dot(texelFetch(uB, f, 0).yz, vec2(uDir));
  if (uDir.y > 0) sp += int(fe.x) == ST_POWDER ? 1.0 : 0.5;
  sp = clamp(sp / uPer * (1.0 - 0.75 * fe.w), 0.0, float(MAXM));
  int m = min(hc, int(floor(sp + rnd3(e, 90 + uSub).x)));
  if (m <= 0 || pos >= m) return;
  // Is the cell m behind this one still part of the same run (and inside the window)?
  bool ok = pos - m >= -RUN;
  for (int j = 1; j <= MAXM && ok; j++) {
    if (j > m) break;
    int q = pos - j;
    if (q < 0 && !runner(e + uDir * q)) ok = false;
  }
  ivec2 src;
  if (ok) src = e + uDir * (pos - m);
  else {
    // One of the m cells at the back of the window: it takes one of the empty cells.
    int st = -RUN;
    for (int j = 1; j <= MAXM; j++) {
      if (j > m) break;
      int q = pos - j;
      if (q >= 0) continue;
      if (q < -RUN) break;
      if (!runner(e + uDir * q)) { st = max(st, q + 1); break; }
    }
    src = e + uDir * (pos - st);
  }
  oA = texelFetch(uA, src, 0); oB = texelFetch(uB, src, 0);
}`;

  // Displacement: liquid trapped inside an object (pushed up to its top) swaps places with the
  // air above the column of liquid over it, so a sunken object raises the water level by its volume.
  const FS_LIFT = STATE_OUT + `
uniform usampler2D uMask;
uniform vec4 uCols[32]; // x0, x1, lowest row of the object
uniform int uNC;
#define LIFT 128
bool masked(ivec2 q) { return texelFetch(uMask, q, 0).r > 0u; }
bool liq(ivec2 q) { return inside(q) && !masked(q) && stOf(int(texelFetch(uA, q, 0).x)) == ST_LIQUID; }
bool pump(ivec2 q) { return inside(q) && masked(q) && stOf(int(texelFetch(uA, q, 0).x)) == ST_LIQUID && liq(q - ivec2(0, 1)); }
bool hole(ivec2 q) { return inside(q) && !masked(q) && stOf(int(texelFetch(uA, q, 0).x)) == ST_EMPTY; }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  oA = texelFetch(uA, p, 0); oB = texelFetch(uB, p, 0);
  bool col = false;
  for (int k = 0; k < 32; k++) {
    if (k >= uNC) break;
    if (float(p.x) >= uCols[k].x && float(p.x) <= uCols[k].y && float(p.y) <= uCols[k].z) { col = true; break; }
  }
  if (!col) return;
  ivec2 pu = ivec2(-1), ho = ivec2(-1);
  if (pump(p)) pu = p;
  else if (liq(p) || hole(p)) {
    for (int j = 1; j <= LIFT; j++) {
      ivec2 q = p + ivec2(0, j);
      if (liq(q)) continue;
      if (pump(q)) pu = q;
      break;
    }
    if (pu.x >= 0 && hole(p)) ho = p;
  }
  if (pu.x < 0) return;
  if (ho.x < 0) {
    for (int j = 1; j <= LIFT; j++) {
      ivec2 q = pu - ivec2(0, j);
      if (liq(q)) continue;
      if (hole(q)) ho = q;
      break;
    }
  }
  if (ho.x < 0 || p.y < ho.y) return;
  oA = texelFetch(uA, p == pu ? ho : p + ivec2(0, 1), 0);
  oB = texelFetch(uB, p == pu ? ho : p + ivec2(0, 1), 0);
}`;

  // Beams move one cell per pass in a straight line and act on what they hit.
  const FS_BEAM = STATE_OUT + `
uniform usampler2D uMask;
uniform int uSub;
ivec2 beamStep(ivec2 q, int bid, vec2 v) {
  vec3 r = rnd3(q, 40 + uSub);
  if (bid == ID_LIGHTNING) return ivec2(int(floor(r.x * 3.0)) - 1, 1);
  vec2 a = abs(v); float m = max(a.x, a.y);
  if (m < 1e-4) return ivec2(0, 1);
  return ivec2(r.x < a.x / m ? int(sign(v.x)) : 0, r.y < a.y / m ? int(sign(v.y)) : 0);
}
bool passable(ivec2 q) {
  if (!inside(q) || texelFetch(uMask, q, 0).r > 0u) return false;
  int id = int(texelFetch(uA, q, 0).x); int s = stOf(id);
  return id == 0 || s == ST_EMPTY || s == ST_BEAM;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 A = texelFetch(uA, p, 0);
  vec4 B = texelFetch(uB, p, 0);
  int id = int(A.x), st = stOf(id);
  vec3 r = rnd3(p, 60 + uSub);
  int inId = -1; vec2 inV = vec2(0.0);
  for (int k = 0; k < 8; k++) {
    ivec2 q = p + D8[k];
    if (!inside(q)) continue;
    int qid = int(texelFetch(uA, q, 0).x);
    if (stOf(qid) != ST_BEAM) continue;
    vec2 qv = texelFetch(uB, q, 0).yz;
    if (q + beamStep(q, qid, qv) == p) { inId = qid; inV = qv; break; }
  }
  bool masked = texelFetch(uMask, p, 0).r > 0u;
  if (st == ST_BEAM) {
    bool moves = passable(p + beamStep(p, id, B.yz));
    if (inId >= 0) { A.x = uint(inId); B.yz = inV; }
    else {
      int tr = int(el(id, 9).x);
      setCell(A, B, moves && tr >= 0 ? tr : 0, r);
    }
  } else if (inId >= 0 && !masked) {
    if (id == 0 || st == ST_EMPTY) { A = uvec4(uint(inId), 0u, 0u, 0u); B.yz = inV; }
    else if (inId == ID_LASER) {
      B.x = min(4000.0, B.x + 350.0);
      if (el(id, 6).z > 0.0) ignite(A, B, id, r);
    } else if (inId == ID_FREEZE_RAY) {
      B.x = max(-273.0, B.x - 180.0); A.w = 0u;
    } else {
      B.x = min(6000.0, B.x + 2500.0);
      bool blew = el(id, 6).z > 0.0 && ignite(A, B, id, r);
      if (!blew && !fixedEl(id) && st != ST_LIQUID) setCell(A, B, ID_PLASMA, r);
    }
  }
  oA = A; oB = B;
}`;

  // The brush: up to MAX_DABS circles per pass.
  const FS_BRUSH = STATE_OUT + `
uniform usampler2D uMask;
uniform vec4 uDabs[${MAX_DABS}];
uniform int uN;
uniform float uR2;
uniform int uElId;
uniform int uRep;
uniform int uKind; // 0 material, 1 erase, 2 heat, 3 cool, 4 stir, 5 beam
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 A = texelFetch(uA, p, 0);
  vec4 B = texelFetch(uB, p, 0);
  oA = A; oB = B;
  int hit = -1;
  for (int k = 0; k < ${MAX_DABS}; k++) {
    if (k >= uN) break;
    vec2 d = vec2(p) - uDabs[k].xy;
    if (uKind == 5 ? d == vec2(0.0) : dot(d, d) <= uR2) { hit = k; break; }
  }
  if (hit < 0 || texelFetch(uMask, p, 0).r > 0u) return;
  vec2 pv = uDabs[hit].zw;
  int id = int(A.x), st = stOf(id);
  vec3 r = rnd3(p, 50 + hit);
  if (uKind == 1) { setCell(A, B, 0, r); B.x = 20.0; B.w = 0.0; }
  else if (uKind == 2) B.x = min(3000.0, B.x + 12.0);
  else if (uKind == 3) B.x = max(-273.0, B.x - 12.0);
  else if (uKind == 4) { if (id != 0 && !fixedEl(id) && st != ST_STATIC) B.yz += pv * 0.35; }
  else if (uKind == 5) {
    if (id != 0 && st != ST_EMPTY) return;
    setCell(A, B, uElId, r);
    float sp = uElId == ID_LIGHTNING ? 7.0 : 6.0, len = length(pv);
    B.yz = uElId == ID_LIGHTNING || len < 0.5 ? vec2(0.0, sp) : pv / len * sp;
  } else {
    if (id != 0 && uRep == 0) return;
    int es = stOf(uElId);
    if (movableSt(es) && r.y < 0.35) return; // sprinkle, looks more natural
    setCell(A, B, uElId, r);
    if (es != ST_STATIC) B.yz = pv * 0.3;
  }
  oA = A; oB = B;
}`;

  // Bulk edits from the CPU (the demo scene): 65535 means leave alone.
  const FS_EDIT = STATE_OUT + `
uniform usampler2D uE;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  uvec4 A = texelFetch(uA, p, 0);
  vec4 B = texelFetch(uB, p, 0);
  uint e = texelFetch(uE, p, 0).r;
  if (e != 65535u) { setCell(A, B, int(e), rnd3(p, 70)); B.w = 0.0; }
  oA = A; oB = B;
}`;

  const FS_CLEAR = `
layout(location = 0) out uvec4 oA;
layout(location = 1) out vec4 oB;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  oA = uvec4(0u, uint(rnd3(p, 80).x * 255.99), 0u, 0u);
  oB = vec4(20.0, 0.0, 0.0, 0.0);
}`;

  const FS_RENDER = `
uniform usampler2D uA;
uniform sampler2D uB;
uniform usampler2D uMask;
uniform vec4 uRect;
uniform int uHeat;
uniform int uFlick;
out vec4 o;
vec3 ramp(float T) {
  const float ts[8] = float[8](-60.0, 0.0, 20.0, 60.0, 150.0, 500.0, 1000.0, 1600.0);
  const vec3 cs[8] = vec3[8](vec3(60, 120, 255), vec3(40, 60, 150), vec3(28, 30, 44), vec3(90, 40, 120), vec3(190, 50, 60), vec3(255, 140, 30), vec3(255, 230, 90), vec3(255));
  T = clamp(T, -60.0, 1600.0);
  for (int k = 0; k < 7; k++) if (T <= ts[k + 1]) return mix(cs[k], cs[k + 1], (T - ts[k]) / (ts[k + 1] - ts[k]));
  return cs[7];
}
int idAt(ivec2 q) { return inside(q) ? int(texelFetch(uA, q, 0).x) : -1; }
void main() {
  vec2 f = (gl_FragCoord.xy - uRect.xy) / uRect.zw;
  if (f.x < 0.0 || f.y < 0.0 || f.x >= 1.0 || f.y >= 1.0) { o = vec4(7.0, 8.0, 11.0, 255.0) / 255.0; return; }
  ivec2 p = ivec2(min(W - 1, int(f.x * float(W))), H - 1 - min(H - 1, int(f.y * float(H))));
  uvec4 A = texelFetch(uA, p, 0);
  vec4 B = texelFetch(uB, p, 0);
  int id = int(A.x);
  float fy = float(p.y) / float(H);
  vec3 bg = vec3(14.0 + 8.0 * fy, 16.0 + 10.0 * fy, 24.0 + 14.0 * fy);
  uvec2 m = texelFetch(uMask, p, 0).rg;
  bool body = m.r > 0u;
  if (body) { id = int(m.r); A.y = m.g; A.w = 0u; B.x = 20.0; }
  vec3 c;
  if (uHeat == 1) c = !body && id == 0 && B.x < 30.0 && B.x > 10.0 ? bg : ramp(B.x);
  else if (id == 0) c = bg;
  else {
    vec4 col = el(id, 8);
    float s = float(A.y >> 3u);
    if (id == ID_FIRE) s = float(pcg3d(uvec3(uvec2(p), uint(uFlick))).x >> 27u);
    float k = (s / 31.0 * 2.0 - 1.0) * col.w;
    c = clamp(id == ID_FIRE ? vec3(col.r, col.g + k * 1.6, col.b) : col.rgb + k, 0.0, 255.0);
    int st = stOf(id);
    float t = B.x;
    bool glow = el(id, 7).z > 0.5;
    if (glow) {
      float kk = clamp((t - 700.0) / 900.0, 0.3, 1.15);
      c *= vec3(kk, kk * kk, kk * kk);
    } else if (t > 400.0) {
      float h = min(1.0, (t - 400.0) / 900.0);
      c.r += (255.0 - c.r) * h; c.g += (120.0 - c.g) * h * 0.6; c.b *= 1.0 - h;
    }
    if (st == ST_LIQUID && !glow) {
      float sp = dot(B.yz, B.yz);
      bool up = idAt(p - ivec2(0, 1)) == 0;
      bool open = up || idAt(p - ivec2(1, 0)) == 0 || idAt(p + ivec2(1, 0)) == 0 || idAt(p + ivec2(0, 1)) == 0;
      if (sp > 0.6 && open) { float fo = min(0.7, (sp - 0.6) * 0.12); c += (vec3(235, 245, 255) - c) * fo; }
      if (up) c += 22.0;
      float depth = 0.0;
      for (int j = 1; j <= 16; j++) {
        ivec2 q = p - ivec2(0, j * 4);
        if (q.y < 0) break;
        if (stOf(int(texelFetch(uA, q, 0).x)) == ST_LIQUID) depth += 4.0;
      }
      c *= 1.0 - min(0.35, depth * 0.006);
    }
    if (A.w > 0u) {
      float fl = 0.35 + float((pcg3d(uvec3(uvec2(p), uint(uFlick) + 7u)).x >> 28u)) / 40.0;
      c.r += (255.0 - c.r) * fl; c.g += (140.0 - c.g) * fl; c.b *= 1.0 - fl;
    }
  }
  o = vec4(clamp(c, 0.0, 255.0) / 255.0, 1.0);
}`;

  // ---------- GL helpers ----------
  function makeTex(gl, w, h, ifmt, fmt, type, data) {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data || null);
    return t;
  }
  function makeFbo(gl, texs) {
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    texs.forEach((t, k) => gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + k, gl.TEXTURE_2D, t, 0));
    gl.drawBuffers(texs.map((_, k) => gl.COLOR_ATTACHMENT0 + k));
    const s = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (s !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Framebuffer incomplete: 0x' + s.toString(16));
    return f;
  }
  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const lines = src.split('\n').map((l, i) => i + 1 + ': ' + l);
      const m = /0:(\d+)/.exec(log || '');
      const at = m ? lines.slice(Math.max(0, m[1] - 3), +m[1] + 2).join('\n') : '';
      throw new Error('Shader error: ' + log + '\n' + at);
    }
    return s;
  }
  function makeProgram(gl, fs) {
    if (!gl.__fxVS) gl.__fxVS = compile(gl, gl.VERTEX_SHADER, VS);
    const p = gl.createProgram();
    const f = compile(gl, gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, gl.__fxVS);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    gl.deleteShader(f);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      u[info.name.replace(/\[0\]$/, '')] = { loc: gl.getUniformLocation(p, info.name), type: info.type };
    }
    return { p, u };
  }

  // ---------- the world ----------
  class GPUWorld {
    constructor(gl, W, H) {
      this.gpu = true;
      this.gl = gl;
      this.W = W; this.H = H; this.N = W * H;
      this.frame = 1;
      this.flick = 0;
      this.count = null;
      const SC = (this.S = Math.max(2, Math.round(W / 320)));
      const cw = (this.cw = Math.ceil(W / SC)), ch = (this.ch = Math.ceil(H / SC));
      this.gravity = 0.2; this.flip = 0.95; this.maxSpeed = 5; this.fillPull = 0.6;

      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (W > max || H > max) throw new Error('Grid larger than the GPU texture limit (' + max + ')');

      const res = (this.res = { tex: [], fbo: [], prog: [], buf: [] });
      const T = (w, h, i, f, t, d) => { const x = makeTex(gl, w, h, i, f, t, d); res.tex.push(x); return x; };
      const F = (texs) => { const x = makeFbo(gl, texs); res.fbo.push(x); return x; };
      const RGBA32F = [gl.RGBA32F, gl.RGBA, gl.FLOAT];

      this.elTex = T(NEL, EL_ROWS, ...RGBA32F, elementData());
      this.rxTex = T(NEL, NEL, ...RGBA32F, reactionData());
      this.A = [0, 1].map(() => T(W, H, gl.RGBA16UI, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT));
      this.B = [0, 1].map(() => T(W, H, ...RGBA32F));
      this.fbo = [0, 1].map((k) => F([this.A[k], this.B[k]]));
      this.cur = 0;
      this.maskBuf = new Uint8Array(this.N * 4);
      this.maskTex = T(W, H, gl.RGBA8UI, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, this.maskBuf); // part, shade, 1 = rising
      this.editTex = null;

      this.K = T(cw, ch, ...RGBA32F); this.kFbo = F([this.K]);
      this.Fv = T(cw + 1, ch + 1, ...RGBA32F); this.fFbo = F([this.Fv]);
      this.Fp = T(cw + 1, ch + 1, ...RGBA32F); this.fpFbo = F([this.Fp]);
      this.D = T(cw, ch, ...RGBA32F); this.dFbo = F([this.D]);
      this.O = [0, 1].map(() => T(cw, ch, ...RGBA32F));
      this.oFbo = this.O.map((t) => F([t]));
      this.oc = 0;
      // Multigrid levels: level 0 is the solver grid, each next one half the size.
      this.levels = [];
      for (let w = cw, h = ch, l = 0; ; l++) {
        const L = { w, h, kr: l === 0 ? this.D : T(w, h, ...RGBA32F), p: [0, 1].map(() => T(w, h, ...RGBA32F)), res: T(w, h, ...RGBA32F), pc: 0 };
        L.krFbo = l === 0 ? this.dFbo : F([L.kr]);
        L.pFbo = L.p.map((t) => F([t]));
        L.resFbo = F([L.res]);
        this.levels.push(L);
        if (w <= 4 || h <= 4) break;
        w = Math.ceil(w / 2); h = Math.ceil(h / 2);
      }
      this.vcycles = 2;

      let head = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp usampler2D;\nprecision highp sampler2D;\n';
      head += `#define W ${W}\n#define H ${H}\n#define SC ${SC}\n#define CW ${cw}\n#define CH ${ch}\n#define NP ${MOVES}\n`;
      for (const k in S) head += `#define ST_${k} ${S[k]}\n`;
      for (const k in ID) head += `#define ID_${k.toUpperCase()} ${ID[k]}\n`;
      head += COMMON;
      const P = (src) => { const x = makeProgram(gl, head + src); res.prog.push(x.p); return x; };
      this.prog = {
        kind: P(FS_KIND), p2g: P(FS_P2G), div: P(FS_DIV), open: P(FS_OPEN), smooth: P(FS_SMOOTH), resid: P(FS_RESID), restrict: P(FS_RESTRICT), prolong: P(FS_PROLONG), project: P(FS_PROJECT),
        physics: P(FS_PHYSICS), move: P(FS_MOVE), shift: P(FS_SHIFT), lift: P(FS_LIFT), beam: P(FS_BEAM), brush: P(FS_BRUSH),
        edit: P(FS_EDIT), clear: P(FS_CLEAR), render: P(FS_RENDER),
      };

      // Objects.
      this.bodies = [];
      this.bodyId = new Int32Array(this.N);
      this.nextBody = 1;
      this.dirty = null;
      this.snap = new Map();
      this.pending = null;
      this.pbo = [gl.createBuffer(), gl.createBuffer()];
      res.buf.push(...this.pbo);
      this.pboSize = 0;
      this.stateOf = new Uint8Array(NEL);
      this.densOf = new Float32Array(NEL);
      for (const e of EL) { this.stateOf[e.id] = stateNum(e.state); this.densOf[e.id] = e.density; }

      this.dabs = []; this.dabKey = null; this.dabParams = null;
      this.edit = null;
      this.beamUntil = 0;
      this.clear();
    }

    dispose() {
      const gl = this.gl, r = this.res;
      if (this.pending) { gl.deleteSync(this.pending.fence); this.pending = null; }
      r.tex.forEach((t) => gl.deleteTexture(t));
      r.fbo.forEach((f) => gl.deleteFramebuffer(f));
      r.prog.forEach((p) => gl.deleteProgram(p));
      r.buf.forEach((b) => gl.deleteBuffer(b));
      if (this.editTex) gl.deleteTexture(this.editTex);
    }

    run(prog, fbo, w, h, uniforms) {
      const gl = this.gl;
      gl.useProgram(prog.p);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.viewport(0, 0, w, h);
      let unit = 0;
      const all = Object.assign({ uEl: this.elTex, uFrame: this.frame }, uniforms);
      for (const k in all) {
        const info = prog.u[k];
        if (!info) continue;
        const v = all[k];
        switch (info.type) {
          case gl.SAMPLER_2D: case gl.UNSIGNED_INT_SAMPLER_2D: case gl.INT_SAMPLER_2D:
            gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v); gl.uniform1i(info.loc, unit++); break;
          case gl.INT: gl.uniform1i(info.loc, v); break;
          case gl.FLOAT: gl.uniform1f(info.loc, v); break;
          case gl.INT_VEC2: gl.uniform2iv(info.loc, v); break;
          case gl.FLOAT_VEC4: gl.uniform4fv(info.loc, v); break;
          default: throw new Error('Unhandled uniform type for ' + k);
        }
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // A pass over the state: reads the current pair, writes the other, then flips.
    statePass(prog, uniforms) {
      const n = 1 - this.cur;
      this.run(prog, this.fbo[n], this.W, this.H, Object.assign({ uA: this.A[this.cur], uB: this.B[this.cur], uMask: this.maskTex }, uniforms));
      this.cur = n;
    }

    // ---------- the step ----------
    step() {
      this.frame++;
      this.flushEdits();
      this.flushDabs();
      if (this.bodies.length) { this.pollReadback(); this.stepBodies(); }
      this.uploadMask();
      this.fluidStep();
      this.statePass(this.prog.physics, {
        uRx: this.rxTex, uK: this.K, uF: this.Fv, uFp: this.Fp,
        uFlip: this.flip, uG: this.gravity, uMaxV: this.maxSpeed,
      });
      if (this.frame < this.beamUntil) for (let k = 0; k < BEAM_PASSES; k++) this.statePass(this.prog.beam, { uSub: k });
      for (let k = 0; k < MOVES; k++) {
        const o = (k + this.frame) & 1;
        this.statePass(this.prog.move, { uOff: [o, o], uPass: k });
        this.shiftPass(k);
      }
      this.shiftPass(6); this.shiftPass(7);
      if (this.bodies.length) this.liftPass();
      if (this.bodies.length) this.issueReadback();
    }

    // Runs of liquid slide twice per step in each direction (down, right, up, left, in turn).
    shiftPass(k) {
      const flip = this.frame & 1 ? 1 : -1;
      const dir = [[0, 1], [flip, 0], [0, -1], [-flip, 0]][k & 3];
      this.statePass(this.prog.shift, { uDir: dir, uPer: 2, uSub: k });
    }

    liftPass() {
      const cols = new Float32Array(32 * 4);
      const n = Math.min(32, this.bodies.length);
      for (let k = 0; k < n; k++) {
        const b = this.bodies[k], s = b.sh;
        cols.set([b.x + s.minX, b.x + s.maxX, b.y + s.maxY, 0], k * 4);
      }
      for (let r = 0; r < 2; r++) this.statePass(this.prog.lift, { uCols: cols, uNC: n });
    }

    fluidStep() {
      const { cw, ch, prog } = this;
      const A = this.A[this.cur], B = this.B[this.cur];
      this.run(prog.kind, this.kFbo, cw, ch, { uA: A, uMask: this.maskTex });
      this.run(prog.p2g, this.fFbo, cw + 1, ch + 1, { uA: A, uB: B, uMask: this.maskTex, uK: this.K, uG: this.gravity });
      for (let k = 0; k < 6; k++) {
        const n = 1 - this.oc;
        this.run(prog.open, this.oFbo[n], cw, ch, { uK: this.K, uO: this.O[this.oc], uAxis: k & 1 ? [1, 0] : [0, 1] });
        this.oc = n;
      }
      this.run(prog.div, this.dFbo, cw, ch, { uK: this.K, uF: this.Fv, uO: this.O[this.oc], uFill: this.fillPull });
      for (let k = 0; k < this.vcycles; k++) this.vcycle(0);
      const L0 = this.levels[0];
      this.run(prog.project, this.fpFbo, cw + 1, ch + 1, { uK: this.D, uF: this.Fv, uP: L0.p[L0.pc] });
    }

    smooth(L, n, omega) {
      for (let i = 0; i < n; i++) {
        const t = 1 - L.pc;
        this.run(this.prog.smooth, L.pFbo[t], L.w, L.h, { uKR: L.kr, uP: L.p[L.pc], uDim: [L.w, L.h], uOmega: omega });
        L.pc = t;
      }
    }

    vcycle(l) {
      const gl = this.gl, L = this.levels[l], C = this.levels[l + 1], prog = this.prog;
      if (!C) { this.smooth(L, 40, 1); return; }
      this.smooth(L, 3, 0.8);
      this.run(prog.resid, L.resFbo, L.w, L.h, { uKR: L.kr, uP: L.p[L.pc], uDim: [L.w, L.h] });
      this.run(prog.restrict, C.krFbo, C.w, C.h, { uKR: L.kr, uRes: L.res, uDim: [L.w, L.h] });
      gl.bindFramebuffer(gl.FRAMEBUFFER, C.pFbo[C.pc]);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      this.vcycle(l + 1);
      const t = 1 - L.pc;
      this.run(prog.prolong, L.pFbo[t], L.w, L.h, { uKR: L.kr, uP: L.p[L.pc], uE: C.p[C.pc], uDim: [L.w, L.h] });
      L.pc = t;
      this.smooth(L, 3, 0.8);
    }

    draw(layout, view) {
      const gl = this.gl;
      this.flushEdits();
      this.flushDabs();
      this.uploadMask();
      const cw = gl.drawingBufferWidth, chh = gl.drawingBufferHeight;
      this.flick = (this.flick + 1) & 0xffffff;
      this.run(this.prog.render, null, cw, chh, {
        uA: this.A[this.cur], uB: this.B[this.cur], uMask: this.maskTex,
        uRect: [layout.ox, chh - layout.oy - layout.h, layout.w, layout.h],
        uHeat: view === 'heat' ? 1 : 0, uFlick: this.flick,
      });
    }

    clear() {
      const gl = this.gl;
      this.bodies.length = 0;
      this.bodyId.fill(0);
      this.maskBuf.fill(0);
      this.snap.clear();
      this.dirty = { x0: 0, y0: 0, x1: this.W, y1: this.H };
      this.uploadMask();
      this.dabs.length = 0;
      this.edit = null;
      this.run(this.prog.clear, this.fbo[this.cur], this.W, this.H, {});
      for (const f of this.oFbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearBufferfv(gl.COLOR, 0, [1, 0, 0, 0]); }
      for (const L of this.levels) for (const f of L.pFbo) { gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]); }
    }

    // ---------- edits from the CPU ----------
    set(i, id) {
      if (!this.edit) this.edit = new Uint16Array(this.N).fill(65535);
      this.edit[i] = id;
    }

    flushEdits() {
      if (!this.edit) return;
      const gl = this.gl;
      if (!this.editTex) this.editTex = makeTex(gl, this.W, this.H, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.edit);
      else {
        gl.bindTexture(gl.TEXTURE_2D, this.editTex);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.W, this.H, gl.RED_INTEGER, gl.UNSIGNED_SHORT, this.edit);
      }
      this.edit = null;
      this.statePass(this.prog.edit, { uE: this.editTex });
    }

    // ---------- painting ----------
    paint(cx, cy, radius, elId, pvx, pvy, replace) {
      const e = EL[elId];
      if (this.bodies.length && (e.key === 'erase' || e.key === 'push')) this.paintBodies(cx, cy, radius, e.key, pvx, pvy);
      if (e.state === S.OBJECT) return;
      const kind = e.key === 'erase' ? 1 : e.key === 'heat' ? 2 : e.key === 'cool' ? 3 : e.key === 'push' ? 4 : e.state === S.BEAM ? 5 : 0;
      const key = elId + ':' + radius + ':' + (replace ? 1 : 0);
      if (this.dabKey !== key || this.dabs.length >= MAX_DABS) { this.flushDabs(); this.dabKey = key; }
      this.dabParams = { r2: radius * radius, el: elId, rep: replace ? 1 : 0, kind };
      this.dabs.push(cx, cy, pvx, pvy);
      if (kind === 5) this.beamUntil = this.frame + Math.ceil((this.W + this.H) / BEAM_PASSES) + 60;
    }

    flushDabs() {
      const n = this.dabs.length / 4;
      if (!n) return;
      const arr = new Float32Array(MAX_DABS * 4);
      arr.set(this.dabs);
      const d = this.dabParams;
      this.statePass(this.prog.brush, { uDabs: arr, uN: n, uR2: d.r2, uElId: d.el, uRep: d.rep, uKind: d.kind });
      this.dabs.length = 0;
    }

    paintBodies(cx, cy, radius, tool, pvx, pvy) {
      const r2 = radius * radius;
      for (const b of this.bodies.slice()) {
        const s = b.sh;
        if (cx < b.x + s.minX - radius || cx > b.x + s.maxX + radius || cy < b.y + s.minY - radius || cy > b.y + s.maxY + radius) continue;
        let hit = false;
        for (const c of s.cells) { const dx = b.x + c.dx - cx, dy = b.y + c.dy - cy; if (dx * dx + dy * dy <= r2) { hit = true; break; } }
        if (!hit) continue;
        if (tool === 'erase') this.removeBody(b);
        else { b.vx += pvx * 0.02; b.vy += pvy * 0.02; }
      }
    }

    // What is at (x, y)? Synchronous, so only for the occasional hover readout.
    probe(x, y) {
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
      const part = this.maskBuf[(y * this.W + x) * 4];
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
      const a = new Uint32Array(4), b = new Float32Array(4);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.readPixels(x, y, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, a);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, b);
      if (part) { const bd = this.bodyAt(x, y); return { id: bd ? bd.el : part, temp: 20 }; }
      return { id: a[0], temp: b[0] };
    }

    // ---------- objects ----------
    objectSize() { return Math.max(3, Math.round(Math.min(this.W, this.H) / 34)); }

    spawnBody(elId, x, y) {
      const spec = EL[elId].body;
      const r = Math.max(2, Math.round(this.objectSize() * spec.size));
      const sh = FX.objectShape(spec.shape, r);
      const b = { id: this.nextBody++, el: elId, sh, x: Math.round(x), y: Math.round(y), fx: 0, fy: 0, vx: 0, vy: 0,
        density: spec.density, bounce: spec.bounce, placed: [], grab: null };
      if (this.nextBody > 2e9) this.nextBody = 1;
      b.x = Math.min(this.W - 1 - sh.maxX, Math.max(-sh.minX, b.x));
      b.y = Math.min(this.H - 1 - sh.maxY, Math.max(-sh.minY, b.y));
      this.bodies.push(b);
      this.stampBody(b);
      return b;
    }

    bodyAt(x, y) {
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
      const id = this.bodyId[y * this.W + x];
      return id ? this.bodies.find((b) => b.id === id) || null : null;
    }

    removeBody(b) {
      this.liftBody(b);
      const k = this.bodies.indexOf(b);
      if (k >= 0) this.bodies.splice(k, 1);
      this.snap.delete(b.id);
    }

    markDirty(b) {
      const s = b.sh;
      const x0 = Math.max(0, b.x + s.minX), y0 = Math.max(0, b.y + s.minY);
      const x1 = Math.min(this.W, b.x + s.maxX + 1), y1 = Math.min(this.H, b.y + s.maxY + 1);
      const d = this.dirty;
      if (!d) this.dirty = { x0, y0, x1, y1 };
      else { d.x0 = Math.min(d.x0, x0); d.y0 = Math.min(d.y0, y0); d.x1 = Math.max(d.x1, x1); d.y1 = Math.max(d.y1, y1); }
    }

    liftBody(b) {
      for (const i of b.placed) {
        if (this.bodyId[i] === b.id) { this.bodyId[i] = 0; this.maskBuf.fill(0, i * 4, i * 4 + 4); }
      }
      if (b.placed.length) this.markDirty(b);
      b.placed.length = 0;
    }

    stampBody(b) {
      const W = this.W, rising = b.vy < -0.3 ? 1 : 0;
      for (const c of b.sh.cells) {
        const i = (b.y + c.dy) * W + (b.x + c.dx);
        this.bodyId[i] = b.id;
        this.maskBuf[i * 4] = c.el;
        this.maskBuf[i * 4 + 1] = (c.dx * 37 + c.dy * 91) & 255;
        this.maskBuf[i * 4 + 2] = rising;
        b.placed.push(i);
      }
      this.markDirty(b);
    }

    uploadMask() {
      const d = this.dirty;
      if (!d) return;
      this.dirty = null;
      const w = d.x1 - d.x0, h = d.y1 - d.y0;
      if (w <= 0 || h <= 0) return;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, this.W);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, d.x0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, d.y0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, d.x0, d.y0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_BYTE, this.maskBuf);
      gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    }

    // Read back the cells around each object, without waiting for the GPU.
    issueReadback() {
      if (this.pending) return;
      const gl = this.gl, M = 16, regions = [];
      let total = 0;
      for (const b of this.bodies) {
        const s = b.sh;
        const x0 = Math.max(0, b.x + s.minX - M), y0 = Math.max(0, b.y + s.minY - M);
        const x1 = Math.min(this.W, b.x + s.maxX + 1 + M), y1 = Math.min(this.H, b.y + s.maxY + 1 + M);
        regions.push({ id: b.id, x0, y0, w: x1 - x0, h: y1 - y0, off: total });
        total += (x1 - x0) * (y1 - y0);
      }
      if (!total) return;
      const bytes = total * 16;
      if (bytes > this.pboSize) {
        this.pboSize = bytes;
        for (const p of this.pbo) { gl.bindBuffer(gl.PIXEL_PACK_BUFFER, p); gl.bufferData(gl.PIXEL_PACK_BUFFER, bytes, gl.STREAM_READ); }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo[this.cur]);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[0]);
      for (const r of regions) gl.readPixels(r.x0, r.y0, r.w, r.h, gl.RGBA_INTEGER, gl.UNSIGNED_INT, r.off * 16);
      gl.readBuffer(gl.COLOR_ATTACHMENT1);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[1]);
      for (const r of regions) gl.readPixels(r.x0, r.y0, r.w, r.h, gl.RGBA, gl.FLOAT, r.off * 16);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      this.pending = { regions, total, fence: gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) };
      gl.flush();
    }

    pollReadback() {
      const p = this.pending, gl = this.gl;
      if (!p) return;
      const st = gl.clientWaitSync(p.fence, 0, 0);
      if (st === gl.TIMEOUT_EXPIRED) return;
      gl.deleteSync(p.fence);
      this.pending = null;
      if (st === gl.WAIT_FAILED) return;
      const a = new Uint32Array(p.total * 4), f = new Float32Array(p.total * 4);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[0]);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, a);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[1]);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, f);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      for (const r of p.regions) {
        const n = r.w * r.h;
        this.snap.set(r.id, { x0: r.x0, y0: r.y0, w: r.w, h: r.h, a: a.subarray(r.off * 4, (r.off + n) * 4), b: f.subarray(r.off * 4, (r.off + n) * 4), fresh: true });
      }
    }

    // Index of (x, y) in a body's snapshot, or -1.
    look(s, x, y) {
      if (!s) return -1;
      const lx = x - s.x0, ly = y - s.y0;
      return lx < 0 || ly < 0 || lx >= s.w || ly >= s.h ? -1 : ly * s.w + lx;
    }

    bodyFits(b, x, y, s) {
      const W = this.W, H = this.H;
      for (const c of b.sh.cells) {
        const px = x + c.dx, py = y + c.dy;
        if (px < 0 || py < 0 || px >= W || py >= H) return false;
        const o = this.bodyId[py * W + px];
        if (o && o !== b.id) return false;
        const k = this.look(s, px, py);
        if (k >= 0) {
          const st = this.stateOf[s.a[k * 4]];
          if (st === S.STATIC || st === S.POWDER) return false;
        }
      }
      return true;
    }

    stepBodies() {
      const G = 0.2;
      for (const b of this.bodies) {
        const s = this.snap.get(b.id);
        this.liftBody(b);
        if (b.grab) {
          b.vx = Math.max(-8, Math.min(8, (b.grab.x - b.x) * 0.4));
          b.vy = Math.max(-8, Math.min(8, (b.grab.y - b.y) * 0.4));
        } else {
          b.vy += G;
          // Buoyancy from the rows with liquid beside them, and the current.
          let sub = 0, dens = 0, flowX = 0, flowY = 0, nl = 0;
          if (s) {
            for (const r of b.sh.rows) {
              const y = b.y + r.y;
              let wet = false;
              for (const x of [b.x + r.l - 1, b.x + r.r + 1]) {
                const k = this.look(s, x, y);
                if (k < 0) continue;
                const t = s.a[k * 4];
                if (t && this.stateOf[t] === S.LIQUID) { wet = true; dens += this.densOf[t]; flowX += s.b[k * 4 + 1]; flowY += s.b[k * 4 + 2]; nl++; }
              }
              if (wet) sub++;
            }
            const k = this.look(s, b.x, b.y + b.sh.maxY + 1);
            if (k >= 0) {
              const t = s.a[k * 4];
              if (t && this.stateOf[t] === S.LIQUID && sub === 0) { sub = 0.5; dens += this.densOf[t]; nl++; }
            }
            // Explosions nearby throw the object.
            if (s.fresh) {
              s.fresh = false;
              let px = 0, py = 0;
              for (let k2 = 0; k2 < s.w * s.h; k2++) {
                const q = s.b[k2 * 4 + 3];
                if (q <= 0) continue;
                const dx = b.x - (s.x0 + (k2 % s.w)), dy = b.y - (s.y0 + ((k2 / s.w) | 0)), d = Math.hypot(dx, dy) || 1;
                px += (dx / d) * q; py += (dy / d) * q;
              }
              const m = Math.hypot(px, py);
              if (m > 0) { const f = Math.min(6, m * 0.05) / m; b.vx += px * f; b.vy += py * f - 0.5; }
            }
          }
          if (nl > 0) {
            const f = Math.min(1, sub / b.sh.rows.length), rho = dens / nl;
            b.vy -= Math.min(4 * G, G * f * (rho / b.density));
            const drag = 0.14 * f;
            b.vx += (flowX / nl - b.vx) * drag;
            b.vy += ((flowY / nl) * 0.3 - b.vy) * drag;
          }
          b.vx *= 0.995;
        }
        const maxV = 7;
        b.vx = Math.max(-maxV, Math.min(maxV, b.vx));
        b.vy = Math.max(-maxV, Math.min(maxV, b.vy));

        b.fx += b.vx; b.fy += b.vy;
        let mx = Math.trunc(b.fx), my = Math.trunc(b.fy);
        b.fx -= mx; b.fy -= my;
        let onGround = false;
        while (mx !== 0 || my !== 0) {
          if (my !== 0) {
            const sy = Math.sign(my);
            if (this.bodyFits(b, b.x, b.y + sy, s)) { b.y += sy; my -= sy; }
            else {
              if (sy > 0) onGround = true;
              b.vy = Math.abs(b.vy) > 0.8 ? -b.vy * b.bounce : 0; b.fy = 0; my = 0;
            }
          }
          if (mx !== 0) {
            const sx = Math.sign(mx);
            if (this.bodyFits(b, b.x + sx, b.y, s)) { b.x += sx; mx -= sx; }
            else if (this.bodyFits(b, b.x + sx, b.y - 1, s)) { b.x += sx; b.y -= 1; mx -= sx; }
            else { b.vx = -b.vx * b.bounce; b.fx = 0; mx = 0; }
          }
        }
        if (!onGround && !this.bodyFits(b, b.x, b.y + 1, s)) onGround = true;
        if (onGround && !b.grab) {
          b.vx *= 0.96;
          if (Math.abs(b.vx) < 0.05) {
            const l = this.bodyFits(b, b.x - 1, b.y + 1, s), r = this.bodyFits(b, b.x + 1, b.y + 1, s);
            if (l && !r) b.vx -= 0.15; else if (r && !l) b.vx += 0.15;
          }
        }
        this.stampBody(b);
      }
    }
  }

  FX.GPU = { supported, context };
  FX.GPUWorld = GPUWorld;
})();
