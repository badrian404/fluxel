// Draws the world into one pixel buffer, then scales it onto the screen canvas.
(function () {
  'use strict';
  const FX = (window.FX = window.FX || {});
  const { EL, S, ID } = FX;

  const SHADES = 32;
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
  const pack = (r, g, b) => (255 << 24) | (clamp(b) << 16) | (clamp(g) << 8) | clamp(r);

  // palette[id * SHADES + s] -> packed color, and the same split into channels.
  const pal = new Uint32Array(EL.length * SHADES);
  const palR = new Uint8Array(EL.length * SHADES), palG = new Uint8Array(EL.length * SHADES), palB = new Uint8Array(EL.length * SHADES);
  for (const e of EL) {
    const [r, g, b] = hexRgb(e.color);
    for (let s = 0; s < SHADES; s++) {
      const k = ((s / (SHADES - 1)) * 2 - 1) * e.vary;
      const k2 = e.id === ID.fire ? 0 : k;
      const rr = e.id === ID.fire ? r : r + k, gg = e.id === ID.fire ? g + k * 1.6 : g + k2, bb = b + k2;
      const idx = e.id * SHADES + s;
      pal[idx] = pack(rr, gg, bb); palR[idx] = clamp(rr); palG[idx] = clamp(gg); palB[idx] = clamp(bb);
    }
  }

  // Heat view ramp, indexed by temperature from -60C to 1600C.
  const RAMP = 256, TMIN = -60, TMAX = 1600;
  const ramp = new Uint32Array(RAMP);
  const stops = [[-60, [60, 120, 255]], [0, [40, 60, 150]], [20, [28, 30, 44]], [60, [90, 40, 120]], [150, [190, 50, 60]], [500, [255, 140, 30]], [1000, [255, 230, 90]], [1600, [255, 255, 255]]];
  for (let i = 0; i < RAMP; i++) {
    const T = TMIN + (i / (RAMP - 1)) * (TMAX - TMIN);
    let k = 0; while (k < stops.length - 2 && stops[k + 1][0] < T) k++;
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1];
    const t = Math.min(1, Math.max(0, (T - t0) / (t1 - t0)));
    ramp[i] = pack(c0[0] + (c1[0] - c0[0]) * t, c0[1] + (c1[1] - c0[1]) * t, c0[2] + (c1[2] - c0[2]) * t);
  }

  class Renderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false });
      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');
      this.view = 'normal';
    }

    resize(world) {
      this.off.width = world.W; this.off.height = world.H;
      this.img = this.offCtx.createImageData(world.W, world.H);
      this.buf = new Uint32Array(this.img.data.buffer);
      this.bg = new Uint32Array(world.H);
      for (let y = 0; y < world.H; y++) {
        const f = y / world.H;
        this.bg[y] = pack(14 + 8 * f, 16 + 10 * f, 24 + 14 * f);
      }
    }

    draw(world, layout) {
      const { W, H, type, temp, vx, vy, shade, burn, stateOf } = world;
      const buf = this.buf, bg = this.bg, heat = this.view === 'heat';
      const LIQ = S.LIQUID, FIRE_ID = ID.fire, flick = (Math.random() * 1e6) | 0;
      if (!this.depth || this.depth.length !== W) this.depth = new Int16Array(W);
      const depth = this.depth; depth.fill(0);
      for (let y = 0; y < H; y++) {
        const row = y * W, bgc = bg[y];
        for (let x = 0; x < W; x++) {
          const i = row + x, a = type[i];
          if (stateOf[a] === LIQ) depth[x]++;
          else if (a === 0) { if (depth[x] > 0) depth[x] -= 2; if (depth[x] < 0) depth[x] = 0; }
          else depth[x] = 0;
          if (heat) {
            let f = (temp[i] - TMIN) / (TMAX - TMIN); f = f < 0 ? 0 : f > 1 ? 1 : f;
            const c = ramp[(f * (RAMP - 1)) | 0];
            buf[i] = a === 0 && temp[i] < 30 && temp[i] > 10 ? bgc : c;
            continue;
          }
          if (a === 0) { buf[i] = bgc; continue; }
          let s = shade[i] >> 3;
          if (a === FIRE_ID) s = ((i * 7 + flick) * 2654435761 >>> 27) & 31;
          const idx = a * SHADES + s;
          const st = stateOf[a], t = temp[i];
          const e = EL[a];
          if (st === LIQ || e.glow || t > 400 || burn[i] > 0) {
            let r = palR[idx], g = palG[idx], b = palB[idx];
            if (e.glow) {
              let k = (t - 700) / 900; k = k < 0.3 ? 0.3 : k > 1.15 ? 1.15 : k;
              r *= k; g *= k * k; b *= k * k;
            } else if (t > 400) {
              const h = Math.min(1, (t - 400) / 900);
              r += (255 - r) * h; g += (120 - g) * h * 0.6; b *= 1 - h;
            }
            if (st === LIQ && !e.glow) {
              const sp = vx[i] * vx[i] + vy[i] * vy[i];
              const open = (y > 0 && type[i - W] === 0) || (x > 0 && type[i - 1] === 0) || (x < W - 1 && type[i + 1] === 0) || (y < H - 1 && type[i + W] === 0);
              if (sp > 0.6) {
                const f = Math.min(open ? 0.7 : 0.18, (sp - 0.6) * (open ? 0.12 : 0.03));
                r += (235 - r) * f; g += (245 - g) * f; b += (255 - b) * f;
              }
              if (y > 0 && type[i - W] === 0) { r += 22; g += 22; b += 22; }
              const f = 1 - Math.min(0.35, depth[x] * 0.006); r *= f; g *= f; b *= f;
            }
            if (burn[i] > 0) {
              const f = 0.35 + (((i * 13 + flick) * 2654435761 >>> 28) & 15) / 40;
              r += (255 - r) * f; g += (140 - g) * f; b *= 1 - f;
            }
            buf[i] = pack(r, g, b);
          } else {
            buf[i] = pal[idx];
          }
        }
      }
      this.offCtx.putImageData(this.img, 0, 0);
      const ctx = this.ctx;
      ctx.imageSmoothingEnabled = false;
      ctx.fillStyle = '#07080b';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.drawImage(this.off, layout.ox, layout.oy, layout.w, layout.h);
    }
  }

  FX.Renderer = Renderer;
  FX.hexRgb = hexRgb;
})();
