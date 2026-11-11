// Coarse staggered-grid (MAC) fluid solver that gives liquid cells momentum.
// Each step: splat liquid cell velocities to the grid, add gravity, make the
// flow incompressible with a pressure solve, then blend the change back into
// the cells (FLIP style). Cells then travel along their own velocity in sim.js.
(function () {
  'use strict';
  const FX = (window.FX = window.FX || {});

  const AIR = 0, LIQ = 1, SOLID = 2;

  class Fluid {
    constructor(W, H, S) {
      this.W = W; this.H = H; this.S = S;
      const cw = (this.cw = Math.ceil(W / S));
      const ch = (this.ch = Math.ceil(H / S));
      const nu = (cw + 1) * ch, nv = cw * (ch + 1), nc = cw * ch;
      this.u = new Float32Array(nu); this.uw = new Float32Array(nu); this.u0 = new Float32Array(nu);
      this.v = new Float32Array(nv); this.vw = new Float32Array(nv); this.v0 = new Float32Array(nv);
      this.kind = new Uint8Array(nc);
      this.nl = new Uint16Array(nc);
      this.ns = new Uint16Array(nc);
      this.p = new Float32Array(nc);
      this.div = new Float32Array(nc);
      this.gravity = 0.2;
      this.iterations = 40;
      this.flip = 0.95;
      this.maxSpeed = 5;
      this.fillPull = 0.6;
      // Precompute fine -> coarse lookups.
      this.cxOf = new Uint16Array(W); this.fxOf = new Float32Array(W);
      for (let x = 0; x < W; x++) { this.cxOf[x] = (x / S) | 0; this.fxOf[x] = ((x % S) + 0.5) / S; }
      this.cyOf = new Uint16Array(H); this.fyOf = new Float32Array(H);
      for (let y = 0; y < H; y++) { this.cyOf[y] = (y / S) | 0; this.fyOf[y] = ((y % S) + 0.5) / S; }
      // Number of fine cells inside each coarse cell (edge cells can be partial).
      this.cap = new Uint16Array(nc);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.cap[this.cyOf[y] * cw + this.cxOf[x]]++;
    }

    step(w) {
      const { W, H, S, cw, ch, u, uw, u0, v, vw, v0, kind, nl, ns, p, div, cxOf, fxOf, cyOf, fyOf } = this;
      const type = w.type, vx = w.vx, vy = w.vy, stateOf = w.stateOf;
      const LIQUID = FX.S.LIQUID, STATIC = FX.S.STATIC, POWDER = FX.S.POWDER;
      u.fill(0); uw.fill(0); v.fill(0); vw.fill(0); nl.fill(0); ns.fill(0);
      const cw1 = cw + 1;

      // 1. Particle (cell) -> grid.
      let anyLiquid = false;
      for (let y = 0; y < H; y++) {
        const cy = cyOf[y], fy = fyOf[y], row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x, st = stateOf[type[i]];
          if (st === 0) continue;
          const cx = cxOf[x], c = cy * cw + cx;
          if (st === LIQUID) {
            anyLiquid = true;
            nl[c]++;
            const fx = fxOf[x];
            const ui = cy * cw1 + cx, a = vx[i];
            u[ui] += a * (1 - fx); uw[ui] += 1 - fx;
            u[ui + 1] += a * fx; uw[ui + 1] += fx;
            const vi = cy * cw + cx, b = vy[i];
            v[vi] += b * (1 - fy); vw[vi] += 1 - fy;
            v[vi + cw] += b * fy; vw[vi + cw] += fy;
          } else if (st === STATIC || st === POWDER) {
            ns[c]++;
          }
        }
      }
      if (!anyLiquid) return;
      const cap = this.cap;
      for (let c = 0; c < kind.length; c++) kind[c] = ns[c] * 2 >= cap[c] ? SOLID : nl[c] > 0 ? LIQ : AIR;
      for (let k = 0; k < u.length; k++) { if (uw[k] > 0) u[k] /= uw[k]; u0[k] = u[k]; }
      for (let k = 0; k < v.length; k++) { if (vw[k] > 0) v[k] /= vw[k]; v0[k] = v[k]; }

      // 2. Gravity on faces touching liquid.
      const g = this.gravity;
      for (let j = 1; j < ch; j++) {
        for (let i = 0; i < cw; i++) {
          const up = kind[(j - 1) * cw + i], dn = kind[j * cw + i];
          if (up === LIQ || dn === LIQ) v[j * cw + i] += g;
        }
      }

      // 3. Solid and border faces carry no flow.
      for (let j = 0; j < ch; j++) {
        for (let i = 0; i <= cw; i++) {
          const k = j * cw1 + i;
          if (i === 0 || i === cw || kind[j * cw + i - 1] === SOLID || kind[j * cw + i] === SOLID) u[k] = 0;
        }
      }
      for (let j = 0; j <= ch; j++) {
        for (let i = 0; i < cw; i++) {
          const k = j * cw + i;
          if (j === 0 || j === ch || kind[(j - 1) * cw + i] === SOLID || kind[j * cw + i] === SOLID) v[k] = 0;
        }
      }

      // 4. Pressure solve (Gauss-Seidel, alternating sweep direction).
      for (let j = 0; j < ch; j++) {
        for (let i = 0; i < cw; i++) {
          const c = j * cw + i;
          if (kind[c] !== LIQ) { p[c] = 0; continue; }
          let d = u[j * cw1 + i + 1] - u[j * cw1 + i] + v[(j + 1) * cw + i] - v[j * cw + i];
          // Under-filled interior cells pull neighbours in, closing holes in the bulk.
          const room = this.cap[c] - ns[c];
          if (room > 0 && nl[c] < room &&
              (i === 0 || kind[c - 1] !== AIR) && (i === cw - 1 || kind[c + 1] !== AIR) &&
              (j === 0 || kind[c - cw] !== AIR) && (j === ch - 1 || kind[c + cw] !== AIR)) {
            d += this.fillPull * (1 - nl[c] / room);
          }
          div[c] = d;
        }
      }
      for (let it = 0; it < this.iterations; it++) {
        const fwd = (it & 1) === 0;
        for (let jj = 0; jj < ch; jj++) {
          const j = fwd ? jj : ch - 1 - jj;
          for (let ii = 0; ii < cw; ii++) {
            const i = fwd ? ii : cw - 1 - ii;
            const c = j * cw + i;
            if (kind[c] !== LIQ) continue;
            let sum = 0, cnt = 0, n;
            if (i > 0) { n = kind[c - 1]; if (n !== SOLID) { cnt++; sum += p[c - 1]; } }
            if (i < cw - 1) { n = kind[c + 1]; if (n !== SOLID) { cnt++; sum += p[c + 1]; } }
            if (j > 0) { n = kind[c - cw]; if (n !== SOLID) { cnt++; sum += p[c - cw]; } }
            if (j < ch - 1) { n = kind[c + cw]; if (n !== SOLID) { cnt++; sum += p[c + cw]; } }
            p[c] = cnt ? (sum - div[c]) / cnt : 0;
          }
        }
      }

      // 5. Subtract the pressure gradient.
      for (let j = 0; j < ch; j++) {
        for (let i = 1; i < cw; i++) {
          const a = kind[j * cw + i - 1], b = kind[j * cw + i];
          if (a === SOLID || b === SOLID) continue;
          if (a === LIQ || b === LIQ) u[j * cw1 + i] -= p[j * cw + i] - p[j * cw + i - 1];
        }
      }
      for (let j = 1; j < ch; j++) {
        for (let i = 0; i < cw; i++) {
          const a = kind[(j - 1) * cw + i], b = kind[j * cw + i];
          if (a === SOLID || b === SOLID) continue;
          if (a === LIQ || b === LIQ) v[j * cw + i] -= p[j * cw + i] - p[(j - 1) * cw + i];
        }
      }

      // 6. Grid -> cells (FLIP/PIC blend), with per-element viscosity.
      const flip = this.flip, pic = 1 - flip, maxV = this.maxSpeed, viscOf = w.viscOf;
      for (let y = 0; y < H; y++) {
        const cy = cyOf[y], fy = fyOf[y], row = y * W;
        for (let x = 0; x < W; x++) {
          const i = row + x;
          if (stateOf[type[i]] !== LIQUID) continue;
          const cx = cxOf[x], fx = fxOf[x];
          if (kind[cy * cw + cx] === SOLID) {
            // Liquid squeezed into a mostly-solid coarse cell (next to walls): plain free fall.
            let b = vy[i] + g; if (b > maxV) b = maxV;
            vy[i] = b; vx[i] *= 0.95;
            continue;
          }
          const ui = cy * cw1 + cx, vi = cy * cw + cx;
          const un = u[ui] * (1 - fx) + u[ui + 1] * fx;
          const uo = u0[ui] * (1 - fx) + u0[ui + 1] * fx;
          const vn = v[vi] * (1 - fy) + v[vi + cw] * fy;
          const vo = v0[vi] * (1 - fy) + v0[vi + cw] * fy;
          const visc = viscOf[type[i]];
          let a = flip * (vx[i] + un - uo) + pic * un;
          let b = flip * (vy[i] + vn - vo) + pic * vn;
          if (visc > 0) { const d = 1 - 0.25 * visc; a *= d; b *= d; }
          if (a > maxV) a = maxV; else if (a < -maxV) a = -maxV;
          if (b > maxV) b = maxV; else if (b < -maxV) b = -maxV;
          vx[i] = a; vy[i] = b;
        }
      }
    }
  }

  FX.Fluid = Fluid;
})();
