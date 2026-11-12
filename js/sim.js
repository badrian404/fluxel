// The world: flat typed arrays, one entry per cell, and the per-step update.
(function () {
  'use strict';
  const FX = (window.FX = window.FX || {});
  const { S, EL, ID, RX, NEL } = FX;
  const EMPTY = S.EMPTY, STATIC = S.STATIC, POWDER = S.POWDER, LIQUID = S.LIQUID, GAS = S.GAS, FIRE = S.FIRE, BEAM = S.BEAM;
  const AMBIENT = 20;
  const rnd = Math.random;
  const pick = (v) => (Array.isArray(v) ? v[(rnd() * v.length) | 0] : v);

  class World {
    constructor(W, H) {
      this.W = W; this.H = H;
      const N = (this.N = W * H);
      this.type = new Uint8Array(N);
      this.temp = new Float32Array(N).fill(AMBIENT);
      this.vx = new Float32Array(N);
      this.vy = new Float32Array(N);
      this.ax = new Float32Array(N);
      this.ay = new Float32Array(N);
      this.life = new Uint16Array(N);
      this.burn = new Uint16Array(N);
      this.shade = new Uint8Array(N);
      this.stamp = new Uint8Array(N);
      this.frame = 1;
      this.depth = 0;
      this.cur = 1;

      // Per-element lookup tables for the hot loops.
      this.stateOf = new Uint8Array(NEL);
      this.densOf = new Float32Array(NEL);
      this.condOf = new Float32Array(NEL);
      this.viscOf = new Float32Array(NEL);
      this.hiT = new Float32Array(NEL);
      this.loT = new Float32Array(NEL);
      this.igT = new Float32Array(NEL);
      for (const e of EL) {
        this.stateOf[e.id] = e.state === S.TOOL ? STATIC : e.state;
        this.densOf[e.id] = e.density;
        this.condOf[e.id] = e.cond;
        this.viscOf[e.id] = e.visc;
        this.hiT[e.id] = e.hiT == null ? Infinity : e.hiT;
        this.loT[e.id] = e.loT == null ? -Infinity : e.loT;
        this.igT[e.id] = e.igniteT == null ? Infinity : e.igniteT;
      }
      this.fixed = new Uint8Array(NEL); // cannot be pushed or destroyed by explosions
      for (const k of ['wall', 'cloner', 'drain', 'void', 'heater', 'cooler']) this.fixed[ID[k]] = 1;

      // Chunks of 32x32 cells sleep when nothing in them changed last step.
      const CS = 32, ccw = (this.ccw = Math.ceil(W / CS)), cch = (this.cch = Math.ceil(H / CS));
      this.CS = CS;
      const nch = ccw * cch;
      this.awake = new Uint8Array(nch).fill(1);
      this.awakeNext = new Uint8Array(nch).fill(1);
      this.heatAwake = new Uint8Array(nch).fill(1);
      this.heatNext = new Uint8Array(nch).fill(1);
      this.chunkOf = nch < 65536 ? new Uint16Array(N) : new Uint32Array(N);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) this.chunkOf[y * W + x] = ((y / CS) | 0) * ccw + ((x / CS) | 0);
      // Elements that need ticking even when nothing moves (reactions, timers, machines).
      this.reactive = new Uint8Array(NEL);
      for (const e of EL) {
        if (e.life || e.state === S.BEAM) this.reactive[e.id] = 1;
        // Only the first element of a reaction pair needs ticking; the check looks both ways.
        for (let b = 0; b < NEL; b++) if (RX[e.id * NEL + b]) { this.reactive[e.id] = 1; break; }
      }
      for (const k of ['cloner', 'drain', 'void', 'heater', 'cooler', 'plant', 'fire', 'plasma']) this.reactive[ID[k]] = 1;

      const scale = Math.max(2, Math.round(W / 110));
      this.fluid = new FX.Fluid(W, H, scale);
      this.count = 0;
      this.initBodies();
    }

    wakeAll() { this.awake.fill(1); this.awakeNext.fill(1); this.heatAwake.fill(1); this.heatNext.fill(1); }

    // Count non-empty cells (for the stats line).
    countCells() { let n = 0; const t = this.type; for (let i = 0; i < t.length; i++) if (t[i] !== 0) n++; return n; }

    clear() {
      this.wakeAll();
      this.bodies.length = 0; this.bodyId.fill(0);
      this.type.fill(0); this.temp.fill(AMBIENT); this.vx.fill(0); this.vy.fill(0);
      this.ax.fill(0); this.ay.fill(0); this.life.fill(0); this.burn.fill(0);
    }

    // ---------- cell helpers ----------
    set(i, id, keepTemp) {
      const e = EL[id];
      this.type[i] = id;
      this.awakeNext[this.chunkOf[i]] = 1;
      if (!keepTemp || id === 0) this.temp[i] = id === 0 ? this.temp[i] : e.temp;
      this.vx[i] = 0; this.vy[i] = 0; this.ax[i] = 0; this.ay[i] = 0;
      this.life[i] = e.life ? e.life[0] + ((rnd() * (e.life[1] - e.life[0])) | 0) : 0;
      this.burn[i] = 0;
      this.shade[i] = (rnd() * 256) | 0;
    }

    // Become another element but keep temperature and motion (melting, freezing...).
    change(i, id) {
      const vx = this.vx[i], vy = this.vy[i], t = this.temp[i];
      this.set(i, id);
      if (id !== 0) {
        this.temp[i] = t;
        if (this.stateOf[id] !== STATIC) { this.vx[i] = vx; this.vy[i] = vy; }
        const pop = EL[id].pop;
        if (pop) { this.vy[i] = -pop * (0.6 + rnd() * 0.8); this.vx[i] = (rnd() - 0.5) * pop; }
      }
    }

    swap(i, j) {
      let t;
      const ty = this.type; t = ty[i]; ty[i] = ty[j]; ty[j] = t;
      const tp = this.temp; t = tp[i]; tp[i] = tp[j]; tp[j] = t;
      const vx = this.vx; t = vx[i]; vx[i] = vx[j]; vx[j] = t;
      const vy = this.vy; t = vy[i]; vy[i] = vy[j]; vy[j] = t;
      const ax = this.ax; t = ax[i]; ax[i] = ax[j]; ax[j] = t;
      const ay = this.ay; t = ay[i]; ay[i] = ay[j]; ay[j] = t;
      const lf = this.life; t = lf[i]; lf[i] = lf[j]; lf[j] = t;
      const bn = this.burn; t = bn[i]; bn[i] = bn[j]; bn[j] = t;
      const sh = this.shade; t = sh[i]; sh[i] = sh[j]; sh[j] = t;
      this.stamp[i] = this.cur; this.stamp[j] = this.cur;
      this.awakeNext[this.chunkOf[i]] = 1; this.awakeNext[this.chunkOf[j]] = 1;
    }

    // Can the cell at i move into j (dy = vertical direction of the move)?
    canEnter(i, j, dy) {
      const b = this.type[j];
      if (b === 0) return true;
      const a = this.type[i];
      const sa = this.stateOf[a], sb = this.stateOf[b];
      if (sb === EMPTY) return true; // beam glow
      if (sb === STATIC || sb === BEAM) return false;
      const da = this.densOf[a], db = this.densOf[b];
      if (sa === POWDER) {
        if (sb === LIQUID) return dy > 0 && da > db && rnd() < 0.3;
        return sb === GAS || sb === FIRE;
      }
      if (sa === LIQUID) {
        if (sb === GAS || sb === FIRE) return true;
        if (sb === LIQUID && a !== b) {
          if (dy > 0 && da > db) return rnd() < (2 * (da - db)) / (da + db) + 0.05;
          if (dy < 0 && da < db) return rnd() < (2 * (db - da)) / (da + db) + 0.05;
        }
        return false;
      }
      // gas / fire
      if (sb === GAS || sb === FIRE) return a !== b && rnd() < 0.25;
      if (sb === LIQUID) return dy < 0 && rnd() < 0.5; // bubbles rise
      return false;
    }

    // Move cell i toward (x+tx, y+ty) one cell at a time. Returns final index.
    travel(i, x, y, tx, ty, st) {
      const W = this.W, H = this.H;
      const n = Math.max(Math.abs(tx), Math.abs(ty));
      let cx = x, cy = y, ci = i;
      for (let k = 1; k <= n; k++) {
        const nx = x + Math.round((tx * k) / n), ny = y + Math.round((ty * k) / n);
        const dx = nx - cx, dy = ny - cy;
        if (dx === 0 && dy === 0) continue;
        let ok = nx >= 0 && nx < W && ny >= 0 && ny < H;
        let j = ny * W + nx;
        if (ok) {
          ok = this.canEnter(ci, j, dy);
          // Blocked by liquid that has not moved yet this step: let it move first.
          if (!ok && st === LIQUID && this.depth < 32 && this.stamp[j] !== this.cur && this.stateOf[this.type[j]] === LIQUID) {
            this.depth++;
            this.stamp[j] = this.cur;
            this.updateLiquid(j, nx, ny);
            this.depth--;
            ok = this.canEnter(ci, j, dy);
          }
        }
        if (ok) {
          const displaced = this.type[j];
          this.swap(ci, j);
          if (st === POWDER && displaced !== 0 && this.stateOf[displaced] === LIQUID) {
            this.vy[ci] -= 0.4; this.vy[j] *= 0.6; // sinking grains push liquid up
          }
          ci = j; cx = nx; cy = ny;
          continue;
        }
        // Blocked.
        const blockedType = nx >= 0 && nx < W && ny >= 0 && ny < H ? this.type[j] : -1;
        if (st === LIQUID && blockedType >= 0 && this.stateOf[blockedType] === LIQUID) {
          // Bulk flow: keep most momentum, but slip around the blocker when there is room.
          this.vx[ci] *= 0.95; this.vy[ci] *= 0.95;
          if (dy > 0) {
            const s2 = rnd() < 0.5 ? 1 : -1;
            for (let t = 0; t < 4; t++) {
              const ddx = t & 1 ? -s2 : s2, ddy = t < 2 ? 1 : 0;
              const ex = cx + ddx, ey = cy + ddy;
              if (ex < 0 || ex >= W || ey >= H) continue;
              const e = ey * W + ex;
              if (this.type[e] === 0 || this.stateOf[this.type[e]] === GAS) {
                this.swap(ci, e);
                this.vx[e] += ddx * Math.min(2, Math.abs(this.vy[e]) * 0.25);
                return e;
              }
            }
          }
          return ci;
        }
        if ((st === LIQUID || st === POWDER) && dy > 0) {
          const s = rnd() < 0.5 ? 1 : -1;
          for (let t = 0; t < 2; t++) {
            const ddx = t === 0 ? s : -s, ex = cx + ddx, ey = cy + 1;
            if (ex < 0 || ex >= W || ey >= H) continue;
            const e = ey * W + ex;
            if (this.canEnter(ci, e, 1)) {
              this.swap(ci, e);
              if (st === LIQUID) { this.vx[e] += ddx * Math.abs(this.vy[e]) * 0.35; this.vy[e] *= 0.6; }
              else { this.vy[e] *= 0.7; this.vx[e] += ddx * 0.3; }
              return e;
            }
          }
        }
        if ((st === GAS || st === FIRE) && dy < 0) {
          const s = rnd() < 0.5 ? 1 : -1;
          const ex = cx + s, ey = cy - 1;
          if (ex >= 0 && ex < W && ey >= 0) {
            const e = ey * W + ex;
            if (this.canEnter(ci, e, -1)) { this.swap(ci, e); return e; }
          }
        }
        if (dx !== 0) { this.vx[ci] *= st === LIQUID ? -0.15 : 0; this.ax[ci] = 0; }
        if (dy !== 0) {
          if (st === LIQUID && dy > 0 && this.vy[ci] > 1.2) {
            this.vx[ci] += (rnd() < 0.5 ? -1 : 1) * this.vy[ci] * 0.4; // splash sideways
          }
          this.vy[ci] = 0; this.ay[ci] = 0;
        }
        return ci;
      }
      return ci;
    }

    tryStep(i, x, y, dx, dy) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= this.W || ny < 0 || ny >= this.H) return -1;
      const j = ny * this.W + nx;
      if (!this.canEnter(i, j, dy)) return -1;
      this.swap(i, j);
      return j;
    }

    updateLiquid(i, x, y) {
      const visc = this.viscOf[this.type[i]];
      const slow = 1 - 0.75 * visc;
      const W = this.W;
      // Air pockets inside liquid bubble up: fill a hole directly below.
      if (y + 1 < this.H && this.type[i + W] === 0 && y > 0 && this.type[i - W] !== 0 && rnd() < 0.5) {
        this.swap(i, i + W); i += W; y++;
      }
      // Wall friction stops liquid from creeping up walls.
      if (this.vy[i] < 0) {
        this.vy[i] *= 0.97; // air drag on upward motion
        if (x === 0 || x === W - 1 || this.stateOf[this.type[i - 1]] === STATIC || this.stateOf[this.type[i + 1]] === STATIC) this.vy[i] *= 0.85;
      }
      let ax = this.ax[i] + this.vx[i] * slow, ay = this.ay[i] + this.vy[i] * slow;
      const tx = ax | 0, ty = ay | 0;
      this.ax[i] = ax - tx; this.ay[i] = ay - ty;
      if (tx !== 0 || ty !== 0) { this.travel(i, x, y, tx, ty, LIQUID); return; }
      if (visc > 0 && rnd() < visc * 0.9) return;
      // Idle: settle and level out at the fine scale.
      if (this.tryStep(i, x, y, 0, 1) >= 0) return;
      const s = rnd() < 0.5 ? 1 : -1;
      if (this.tryStep(i, x, y, s, 1) >= 0 || this.tryStep(i, x, y, -s, 1) >= 0) return;
      const nx = x + s;
      if (nx < 0 || nx >= W) return;
      const j = y * W + nx;
      if (this.type[j] !== 0 && this.stateOf[this.type[j]] !== GAS) return;
      const below = y + 1 < this.H ? this.type[j + W] : 1;
      if (below === 0 || rnd() < 0.12) this.tryStep(i, x, y, s, 0);
    }

    updatePowder(i, x, y) {
      let vy = this.vy[i] + 0.2, vx = this.vx[i] * 0.9;
      if (vy > 5) vy = 5;
      this.vx[i] = vx; this.vy[i] = vy;
      let ax = this.ax[i] + vx, ay = this.ay[i] + vy;
      const tx = ax | 0, ty = ay | 0;
      this.ax[i] = ax - tx; this.ay[i] = ay - ty;
      if (tx !== 0 || ty !== 0) { this.travel(i, x, y, tx, ty, POWDER); return; }
      // Not enough speed to move a whole cell yet: still slide off slopes.
      const below = y + 1 < this.H ? y * this.W + x + this.W : -1;
      if (below >= 0 && !this.canEnterPeek(i, below)) {
        this.vy[i] = 0; this.ay[i] = 0;
        const s = rnd() < 0.5 ? 1 : -1;
        if (this.tryStep(i, x, y, s, 1) < 0) this.tryStep(i, x, y, -s, 1);
      }
    }

    canEnterPeek(i, j) {
      const b = this.type[j];
      if (b === 0) return true;
      const sb = this.stateOf[b];
      return sb === GAS || sb === FIRE || (sb === LIQUID && this.densOf[this.type[i]] > this.densOf[b]);
    }

    updateGas(i, x, y, st) {
      const buoy = st === FIRE ? 0.1 : this.densOf[this.type[i]] < 1.2 ? 0.05 : -0.02;
      let vx = (this.vx[i] + (rnd() - 0.5) * 0.5) * 0.9;
      let vy = (this.vy[i] - buoy) * 0.94;
      if (vy < -3) vy = -3;
      this.vx[i] = vx; this.vy[i] = vy;
      let ax = this.ax[i] + vx, ay = this.ay[i] + vy;
      const tx = ax | 0, ty = ay | 0;
      this.ax[i] = ax - tx; this.ay[i] = ay - ty;
      if (tx !== 0 || ty !== 0) { this.travel(i, x, y, tx, ty, st); return; }
      const s = rnd() < 0.5 ? 1 : -1;
      // Gas held under a ceiling (or under other gas) spreads out flat instead of heaping up.
      const capped = y === 0 || this.type[i - this.W] !== 0;
      if (capped) { let j = this.tryStep(i, x, y, s, 0); if (j >= 0 && rnd() < 0.7) this.tryStep(j, x + s, y, s, 0); }
      else if (rnd() < 0.3) this.tryStep(i, x, y, s, 0);
    }

    // ---------- the step ----------
    step() {
      this.frame++;
      this.cur = this.frame & 255 || 1;
      if (this.cur === 1) this.stamp.fill(0);
      this.fluid.step(this);
      if (this.bodies.length) this.stepBodies();
      this.movePass();
      this.heatPass();
      this.tickPass();
      // Chunks touched this step (and their neighbours) stay awake next step.
      this.dilate(this.awakeNext, this.awake);
      this.dilate(this.heatNext, this.heatAwake);
      for (let c = 0; c < this.awake.length; c++) if (this.awake[c]) this.heatAwake[c] = 1;
      this.awakeNext.fill(0); this.heatNext.fill(0);
      if (this.frame % 30 === 0) this.count = this.countCells();
    }

    dilate(src, dst) {
      const ccw = this.ccw, cch = this.cch;
      dst.fill(0);
      for (let cy = 0; cy < cch; cy++) for (let cx = 0; cx < ccw; cx++) {
        if (!src[cy * ccw + cx]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const y = cy + dy; if (y < 0 || y >= cch) continue;
          for (let dx = -1; dx <= 1; dx++) { const x = cx + dx; if (x >= 0 && x < ccw) dst[y * ccw + x] = 1; }
        }
      }
    }

    movePass() {
      const W = this.W, H = this.H, type = this.type, stateOf = this.stateOf, stamp = this.stamp, cur = this.cur;
      const CS = this.CS, ccw = this.ccw, awake = this.awake;
      const ltr = (this.frame & 1) === 0;
      // Falling things: bottom-up.
      for (let y = H - 1; y >= 0; y--) {
        const row = y * W, crow = ((y / CS) | 0) * ccw;
        for (let kc = 0; kc < ccw; kc++) {
          const cx = ltr ? kc : ccw - 1 - kc;
          if (!awake[crow + cx]) continue;
          const x0 = cx * CS, x1 = Math.min(W, x0 + CS);
          for (let k = x0; k < x1; k++) {
            const x = ltr ? k : x1 - 1 - (k - x0), i = row + x;
            const st = stateOf[type[i]];
            if (st !== LIQUID && st !== POWDER) continue;
            if (stamp[i] === cur) continue;
            stamp[i] = cur;
            if (st === LIQUID) this.updateLiquid(i, x, y); else this.updatePowder(i, x, y);
          }
        }
      }
      // Rising things: top-down.
      for (let y = 0; y < H; y++) {
        const row = y * W, crow = ((y / CS) | 0) * ccw;
        for (let kc = 0; kc < ccw; kc++) {
          const cx = ltr ? kc : ccw - 1 - kc;
          if (!awake[crow + cx]) continue;
          const x0 = cx * CS, x1 = Math.min(W, x0 + CS);
          for (let k = x0; k < x1; k++) {
            const x = ltr ? k : x1 - 1 - (k - x0), i = row + x;
            const st = stateOf[type[i]];
            if (st === GAS || st === FIRE) {
              if (stamp[i] === cur) continue;
              stamp[i] = cur;
              this.updateGas(i, x, y, st);
            } else if (st === BEAM) {
              if (stamp[i] === cur) continue;
              stamp[i] = cur;
              this.moveBeam(i);
            }
          }
        }
      }
    }

    // Beams travel fast in a straight line and act on the first thing they hit.
    moveBeam(i) {
      const W = this.W, H = this.H, a = this.type[i], e = EL[a];
      const bolt = a === ID.lightning;
      let vx = this.vx[i], vy = this.vy[i];
      if (bolt) vx = (rnd() - 0.5) * 3; // lightning zigzags down
      const n = Math.max(1, Math.ceil(Math.max(Math.abs(vx), Math.abs(vy))));
      let fx = (i % W) + 0.5 + this.ax[i], fy = ((i / W) | 0) + 0.5 + this.ay[i];
      let ci = i;
      for (let k = 0; k < n; k++) {
        fx += vx / n; fy += vy / n;
        const nx = Math.floor(fx), ny = Math.floor(fy);
        const cx = ci % W, cy = (ci / W) | 0;
        if (nx === cx && ny === cy) continue;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) { this.set(ci, 0); return; }
        const j = ny * W + nx, b = this.type[j];
        if (b === 0 || this.stateOf[b] === EMPTY || this.stateOf[b] === BEAM) {
          this.swap(ci, j);
          if (e.trail >= 0) { this.set(ci, e.trail); this.stamp[ci] = this.cur; } else this.set(ci, 0);
          ci = j;
          continue;
        }
        // Hit.
        if (a === ID.laser) {
          this.temp[j] = Math.min(4000, this.temp[j] + 350);
          if (EL[b].burn > 0 && this.burn[j] === 0) this.ignite(j, nx, ny);
        } else if (a === ID.freeze_ray) {
          this.temp[j] = Math.max(-273, this.temp[j] - 180);
          if (this.burn[j] > 0) this.burn[j] = 0;
        } else if (bolt) {
          this.temp[j] = Math.min(6000, this.temp[j] + 2500);
          if (EL[b].burn > 0 && this.burn[j] === 0) this.ignite(j, nx, ny);
          if (!this.fixed[b] && this.stateOf[b] !== LIQUID) { this.set(j, ID.plasma); }
        }
        this.set(ci, 0);
        return;
      }
      this.ax[ci] = fx - Math.floor(fx) - 0.5; this.ay[ci] = fy - Math.floor(fy) - 0.5;
    }

    heatPass() {
      const W = this.W, H = this.H, type = this.type, temp = this.temp, condOf = this.condOf;
      const CS = this.CS, ccw = this.ccw, cch = this.cch, act = this.heatAwake, next = this.heatNext, wake = this.awakeNext;
      for (let cy = 0; cy < cch; cy++) {
        const y0 = cy * CS, y1 = Math.min(H, y0 + CS);
        for (let cx = 0; cx < ccw; cx++) {
          const c = cy * ccw + cx;
          if (!act[c]) continue;
          const x0 = cx * CS, x1 = Math.min(W, x0 + CS);
          let busy = false;
          for (let y = y0; y < y1; y++) {
            const row = y * W;
            for (let x = x0; x < x1; x++) {
              const i = row + x, a = type[i], ca = condOf[a];
              let t = temp[i];
              if (x < W - 1) {
                const j = i + 1, k = Math.min(ca, condOf[type[j]]);
                if (k > 0) { const d = (temp[j] - t) * k * 0.22; if (d > 0.02 || d < -0.02) busy = true; t += d; temp[j] -= d; }
              }
              if (y < H - 1) {
                const j = i + W, k = Math.min(ca, condOf[type[j]]);
                if (k > 0) { const d = (temp[j] - t) * k * 0.22; if (d > 0.02 || d < -0.02) busy = true; t += d; temp[j] -= d; }
              }
              if (a === 0) { const d = (AMBIENT - t) * 0.015; if (d > 0.02 || d < -0.02) busy = true; t += d; }
              temp[i] = t;
            }
          }
          if (busy) { next[c] = 1; wake[c] = 1; }
        }
      }
    }

    neighbor(i, x, y, r) {
      // r in 0..3 -> right, left, down, up; -1 if out of bounds
      const W = this.W;
      switch (r) {
        case 0: return x < W - 1 ? i + 1 : -1;
        case 1: return x > 0 ? i - 1 : -1;
        case 2: return y < this.H - 1 ? i + W : -1;
        default: return y > 0 ? i - W : -1;
      }
    }

    ignite(i, x, y) {
      const e = EL[this.type[i]];
      if (e.explode) { this.explode(x, y, e.explode); return; }
      if (this.burn[i] === 0) this.burn[i] = Math.max(1, (e.burnTime * (0.6 + rnd() * 0.8)) | 0);
    }

    explode(cx, cy, R) {
      const W = this.W, H = this.H, R2 = R * 2;
      if (this.bodies.length) this.pushBodiesNear(cx, cy, R2 + 6, 5);
      for (let dy = -R2; dy <= R2; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= H) continue;
        for (let dx = -R2; dx <= R2; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= W) continue;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d > R2) continue;
          const i = y * W + x, a = this.type[i];
          if (this.fixed[a]) continue;
          if (d <= R) {
            if (EL[a].explode && d > 0) { this.burn[i] = 1; continue; } // chain reaction next tick
            this.set(i, ID.fire);
            this.temp[i] = 1400;
            this.vx[i] = (dx / (d || 1)) * 2; this.vy[i] = (dy / (d || 1)) * 2 - 1;
          } else if (a !== 0) {
            const f = 4 * (1 - d / R2);
            this.vx[i] += (dx / d) * f; this.vy[i] += (dy / d) * f - 0.5;
            this.temp[i] += 200 * (1 - d / R2);
          }
        }
      }
    }

    tickPass() {
      const W = this.W, H = this.H, type = this.type, temp = this.temp, stateOf = this.stateOf;
      const hiT = this.hiT, loT = this.loT, igT = this.igT;
      const CS = this.CS, ccw = this.ccw, cch = this.cch, awake = this.awake, wake = this.awakeNext, reactive = this.reactive, chunkOf = this.chunkOf;
      for (let cy = 0; cy < cch; cy++) {
       const y0 = cy * CS, y1 = Math.min(H, y0 + CS);
       for (let cx = 0; cx < ccw; cx++) {
        if (!awake[cy * ccw + cx]) continue;
        const x0 = cx * CS, x1 = Math.min(W, x0 + CS);
        for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * W + x;
          const a = type[i];
          if (a === 0) continue;
          const t = temp[i];
          if (!reactive[a] && this.burn[i] === 0) {
            // Fast path: inert cells only need temperature checks.
            if (t >= hiT[a]) this.change(i, pick(EL[a].hiTo));
            else if (t <= loT[a]) this.change(i, pick(EL[a].loTo));
            else if (t >= igT[a]) this.ignite(i, x, y);
            continue;
          }
          wake[chunkOf[i]] = 1;
          const e = EL[a];

          // State changes from temperature.
          if (t >= hiT[a]) { this.change(i, pick(e.hiTo)); continue; }
          if (t <= loT[a]) { this.change(i, pick(e.loTo)); continue; }

          // Lifetimes (gases, fire).
          if (e.life) {
            if (--this.life[i] === 0) { this.change(i, pick(e.lifeTo)); if (type[i] === 0) temp[i] = t; continue; }
          }

          const st = stateOf[a];
          if (a === ID.fire) { if (t < 500) temp[i] = 500 + rnd() * 400; }
          else if (a === ID.heater || a === ID.cooler) temp[i] = e.temp;

          // Burning.
          if (this.burn[i] > 0) {
            if (e.explode) { this.explode(x, y, e.explode); continue; }
            if (temp[i] < 450) temp[i] = 450;
            const r = (rnd() * 4) | 0, j = this.neighbor(i, x, y, r);
            if (j >= 0) {
              const b = type[j];
              if (b === 0 && rnd() < 0.35) { this.set(j, ID.fire); this.vy[j] = -0.5; }
              else if (b === ID.water || b === ID.salt_water) { this.burn[i] = 0; temp[i] = 120; continue; }
            }
            if (--this.burn[i] === 0) { this.change(i, pick(e.burnTo)); continue; }
          } else if (e.igniteT !== null && t >= e.igniteT) {
            this.ignite(i, x, y);
            if (type[i] !== a) continue;
          }

          // Contact: reactions, fire spreading, specials.
          const r = (rnd() * 4) | 0, j = this.neighbor(i, x, y, r);
          if (j < 0) continue;
          const b = type[j];

          if (a === ID.fire || this.burn[i] > 0) {
            // Flames check every side, so fire passing by catches easily.
            for (let q = 0; q < 4; q++) {
              const k = this.neighbor(i, x, y, q);
              if (k < 0) continue;
              const eb = EL[type[k]];
              if (eb.burn > 0 && this.burn[k] === 0 && rnd() < eb.burn * 2) this.ignite(k, k % W, (k / W) | 0);
            }
            if (type[i] !== a) continue;
          }

          if (b !== 0) {
            let rr = RX[a * NEL + b], ii = i, jj = j;
            if (!rr) { rr = RX[b * NEL + a]; ii = j; jj = i; }
            if (rr && rnd() < rr.p) {
              if (rr.a >= 0) this.change(ii, rr.a);
              if (rr.b >= 0) this.change(jj, rr.b);
              if (rr.heat) { temp[ii] += rr.heat; temp[jj] += rr.heat; }
              continue;
            }
          }

          if (st === STATIC) {
            if (a === ID.cloner) {
              const held = this.life[i];
              if (held === 0) {
                if (b !== 0 && !this.fixed[b] && stateOf[b] !== STATIC) this.life[i] = b;
                else if (b !== 0 && stateOf[b] === STATIC && !this.fixed[b]) this.life[i] = b;
              } else if (b === 0 && rnd() < 0.5) {
                this.set(j, held);
                if (r === 2) this.vy[j] = 0.5;
              }
            } else if (a === ID.drain || a === ID.void) {
              // Swallow from every side: Drain takes liquids, Void takes anything that moves.
              for (let q = 0; q < 4; q++) {
                const k = this.neighbor(i, x, y, q);
                if (k < 0) continue;
                const sk = stateOf[type[k]];
                if (a === ID.drain ? sk === LIQUID : (type[k] !== 0 && !this.fixed[type[k]] && sk !== STATIC)) this.set(k, 0);
              }
            } else if (a === ID.plant) {
              if ((b === ID.water || b === ID.salt_water) && rnd() < 0.04) {
                if (rnd() < 0.35) this.set(j, ID.plant);
                else this.set(j, 0);
              } else if (b === 0 && rnd() < 0.0015 && (r === 3 || rnd() < 0.3)) {
                this.set(j, ID.plant);
              }
            }
          }
        }
        }
       }
      }
    }

    // ---------- painting ----------
    // A block of cells for the Scope (same layout as the GPU engine's region()).
    region(x0, y0, w, h) {
      const n = w * h, out = { id: new Uint16Array(n), shade: new Uint8Array(n), temp: new Float32Array(n), obj: new Uint16Array(n) };
      const objs = new Map(this.bodies.map((o) => [o.id, o.el]));
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = j * w + i, g = (y0 + j) * this.W + x0 + i;
        out.id[k] = this.type[g]; out.shade[k] = this.shade[g]; out.temp[k] = this.temp[g];
        if (this.bodyId[g]) out.obj[k] = objs.get(this.bodyId[g]) || 0;
      }
      return out;
    }

    paint(cx, cy, radius, elId, pvx, pvy, replace) {
      const W = this.W, H = this.H, e = EL[elId];
      const r2 = radius * radius;
      for (let dy = -radius; dy <= radius; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= H) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > r2) continue;
          const x = cx + dx;
          if (x < 0 || x >= W) continue;
          const i = y * W + x, cur = this.type[i];
          if (this.bodyId[i]) {
            const b = this.bodies.find((o) => o.id === this.bodyId[i]);
            if (b && e.key === 'erase') this.removeBody(b);
            else if (b && e.key === 'push') { b.vx += pvx * 0.02; b.vy += pvy * 0.02; }
            continue;
          }
          if (e.state === S.OBJECT) continue;
          if (e.state === S.TOOL) {
            if (e.key === 'erase') { if (cur !== 0) this.set(i, 0); this.temp[i] = AMBIENT; }
            else if (e.key === 'heat') this.temp[i] = Math.min(3000, this.temp[i] + 12);
            else if (e.key === 'cool') this.temp[i] = Math.max(-273, this.temp[i] - 12);
            else if (e.key === 'push' && cur !== 0 && !this.fixed[cur] && this.stateOf[cur] !== STATIC) {
              this.vx[i] += pvx * 0.35; this.vy[i] += pvy * 0.35;
            }
            continue;
          }
          if (e.state === BEAM) {
            if (dx !== 0 || dy !== 0) continue; // one beam per brush dab
            if (cur !== 0 && this.stateOf[cur] !== EMPTY) continue;
            this.set(i, elId);
            const len = Math.hypot(pvx, pvy);
            const speed = elId === ID.lightning ? 7 : 6;
            if (elId === ID.lightning || len < 0.5) { this.vx[i] = 0; this.vy[i] = speed; }
            else { this.vx[i] = (pvx / len) * speed; this.vy[i] = (pvy / len) * speed; }
            continue;
          }
          if (cur !== 0 && !replace) continue;
          if (e.state === S.POWDER || e.state === S.LIQUID || e.state === S.GAS || e.state === S.FIRE) {
            if (rnd() < 0.35) continue; // sprinkle, looks more natural
          }
          this.set(i, elId);
          if (e.state !== STATIC) { this.vx[i] = pvx * 0.3; this.vy[i] = pvy * 0.3; }
        }
      }
    }
  }

  FX.World = World;
})();
