// Solid objects (tennis ball, rubber duck...) that move as one piece.
// Each step an object lifts itself out of the grid, feels gravity, buoyancy and
// the current of the liquid around it, moves until it hits something, then is
// stamped back in, pushing liquid and gas out of the way.
(function () {
  'use strict';
  const FX = window.FX;
  const { S, EL, ID } = FX;
  const G = 0.2;

  // ---------- shapes (built on a grid, scaled to the world size) ----------
  function shape(kind, r) {
    const cells = [];
    const add = (dx, dy, el) => cells.push({ dx, dy, el: ID[el] });
    const R = r;
    if (kind === 'tennis' || kind === 'bowling' || kind === 'beach') {
      for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
        const d = Math.hypot(x, y);
        if (d > R + 0.3) continue;
        let el;
        if (kind === 'tennis') {
          const s1 = Math.abs(Math.hypot(x - R * 1.35, y) - R), s2 = Math.abs(Math.hypot(x + R * 1.35, y) - R);
          el = (s1 < 0.6 || s2 < 0.6) && d < R - 0.5 ? 'seam' : 'felt';
        } else if (kind === 'bowling') {
          const hole = (hx, hy) => Math.hypot(x - hx * R, y - hy * R) < Math.max(0.6, R * 0.13);
          el = hole(0.25, -0.45) || hole(0.5, -0.2) || hole(0.05, -0.15) ? 'bowl_hole' : 'bowl';
        } else {
          const a = Math.atan2(y, x), seg = ((a + Math.PI) / (Math.PI * 2) * 6) | 0;
          el = d < R * 0.22 ? 'bb_white' : ['bb_red', 'bb_white', 'bb_blue', 'bb_yellow', 'bb_red', 'bb_white'][seg % 6];
        }
        add(x, y, el);
      }
    } else if (kind === 'crate') {
      const n = Math.max(3, Math.round(R * 1.6));
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
        const diag = Math.abs(x - y) <= 0.6 || Math.abs(x - (n - 1 - y)) <= 0.6;
        add(x - (n >> 1), y - (n >> 1), edge || diag ? 'plank_dark' : 'plank');
      }
    } else if (kind === 'duck') {
      // body, head, beak, eye, wing; facing right
      for (let y = -R * 1.5; y <= R; y++) for (let x = -R * 1.4; x <= R * 1.6; x++) {
        const xi = Math.round(x), yi = Math.round(y);
        const inBody = ((xi) / (R * 1.3)) ** 2 + ((yi - R * 0.15) / (R * 0.8)) ** 2 <= 1;
        const inTail = xi < -R * 0.9 && yi < R * 0.1 && yi > -R * 0.7 + (xi + R * 1.4) * 0.3 && ((xi + R * 1.0) / (R * 0.45)) ** 2 + ((yi + R * 0.3) / (R * 0.45)) ** 2 <= 1;
        const hx = R * 0.6, hy = -R * 0.85, hr = R * 0.62;
        const inHead = (xi - hx) ** 2 + (yi - hy) ** 2 <= hr * hr;
        const inBeak = xi > hx + hr * 0.6 && xi <= hx + hr * 1.55 && yi >= hy - hr * 0.05 && yi <= hy + hr * 0.4;
        if (!(inBody || inTail || inHead || inBeak)) continue;
        let el = 'duck';
        if (inBeak && !inHead) el = 'beak';
        else if (inHead && Math.hypot(xi - (hx + hr * 0.3), yi - (hy - hr * 0.2)) < Math.max(0.7, hr * 0.18)) el = 'eye';
        else if (inBody && ((xi + R * 0.15) / (R * 0.6)) ** 2 + ((yi - R * 0.1) / (R * 0.35)) ** 2 <= 1) el = 'duck_wing';
        add(xi, yi, el);
      }
      // de-duplicate
      const seen = new Set();
      for (let k = cells.length - 1; k >= 0; k--) { const key = cells[k].dx + ',' + cells[k].dy; if (seen.has(key)) cells.splice(k, 1); else seen.add(key); }
    }
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (const c of cells) { minX = Math.min(minX, c.dx); maxX = Math.max(maxX, c.dx); minY = Math.min(minY, c.dy); maxY = Math.max(maxY, c.dy); }
    // Rows for buoyancy: left- and right-most cell of each row.
    const rows = new Map();
    for (const c of cells) {
      const r = rows.get(c.dy) || { y: c.dy, l: c.dx, r: c.dx };
      r.l = Math.min(r.l, c.dx); r.r = Math.max(r.r, c.dx); rows.set(c.dy, r);
    }
    return { cells, minX, maxX, minY, maxY, rows: [...rows.values()] };
  }

  FX.objectShape = shape;

  const W_ = FX.World.prototype;

  W_.initBodies = function () {
    this.bodies = [];
    this.bodyId = new Int32Array(this.N);
    this.nextBody = 1;
    this.partOf = new Uint8Array(EL.length);
    for (const e of EL) if (e.part) { this.partOf[e.id] = 1; this.fixed[e.id] = 1; }
  };

  W_.objectSize = function () { return Math.max(3, Math.round(Math.min(this.W, this.H) / 34)); };

  W_.spawnBody = function (elId, x, y) {
    const e = EL[elId], spec = e.body;
    const r = Math.max(2, Math.round(this.objectSize() * spec.size));
    const sh = shape(spec.shape, r);
    const b = { id: this.nextBody++, el: elId, sh, x: Math.round(x), y: Math.round(y), fx: 0, fy: 0, vx: 0, vy: 0,
      density: spec.density, bounce: spec.bounce, placed: [], grab: null, temp: 20 };
    if (this.nextBody > 2e9) this.nextBody = 1;
    // keep inside the world
    b.x = Math.min(this.W - 1 - sh.maxX, Math.max(-sh.minX, b.x));
    b.y = Math.min(this.H - 1 - sh.maxY, Math.max(-sh.minY, b.y));
    this.bodies.push(b);
    this.stampBody(b);
    return b;
  };

  W_.bodyAt = function (x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return null;
    const id = this.bodyId[y * this.W + x];
    return id ? this.bodies.find((b) => b.id === id) || null : null;
  };

  W_.removeBody = function (b) {
    this.liftBody(b);
    const k = this.bodies.indexOf(b);
    if (k >= 0) this.bodies.splice(k, 1);
  };

  W_.liftBody = function (b) {
    for (const i of b.placed) {
      if (this.bodyId[i] === b.id) { this.bodyId[i] = 0; this.type[i] = 0; this.temp[i] = 20; this.awakeNext[this.chunkOf[i]] = 1; }
    }
    b.placed.length = 0;
  };

  // Would the body fit at (x, y)? Liquids, gases and empty space give way; solids, powders and other objects do not.
  W_.bodyFits = function (b, x, y) {
    const W = this.W, H = this.H;
    for (const c of b.sh.cells) {
      const px = x + c.dx, py = y + c.dy;
      if (px < 0 || py < 0 || px >= W || py >= H) return false;
      const t = this.type[py * W + px];
      if (t === 0) continue;
      const st = this.stateOf[t];
      if (st === S.STATIC || st === S.POWDER) return false;
    }
    return true;
  };

  // Push whatever is in cell i out to the nearest free cell, searching through the
  // surrounding liquid or gas, so a sinking object raises the water level instead of deleting it.
  W_.displace = function (i, b) {
    const W = this.W, H = this.H, type = this.type, stateOf = this.stateOf, bodyId = this.bodyId;
    if (!this.visit || this.visit.length !== this.N) { this.visit = new Uint32Array(this.N); this.visitGen = 0; }
    const visit = this.visit, gen = ++this.visitGen;
    if (gen === 0xffffffff) { visit.fill(0); this.visitGen = 1; }
    const queue = this.dq || (this.dq = new Int32Array(4096));
    let head = 0, tail = 0;
    queue[tail++] = i; visit[i] = gen;
    const dirs = [-W, -1, 1, W]; // up first
    while (head < tail) {
      const c = queue[head++], cx = c % W;
      for (let k = 0; k < 4; k++) {
        const n = c + dirs[k];
        if (n < 0 || n >= this.N) continue;
        if ((k === 1 && cx === 0) || (k === 2 && cx === W - 1)) continue;
        if (visit[n] === gen) continue;
        visit[n] = gen;
        if (bodyId[n]) continue;
        const t = type[n];
        if (t === 0) {
          this.swap(i, n);
          this.vx[n] += b.vx * 0.4; this.vy[n] += -Math.abs(b.vy) * 0.3 - 0.2;
          return;
        }
        const st = stateOf[t];
        if ((st === S.LIQUID || st === S.GAS || st === S.FIRE || st === S.EMPTY) && tail < queue.length) queue[tail++] = n;
      }
    }
    this.set(i, 0);
  };

  W_.stampBody = function (b) {
    const W = this.W;
    for (const c of b.sh.cells) {
      const i = (b.y + c.dy) * W + (b.x + c.dx);
      if (this.type[i] !== 0 && !this.partOf[this.type[i]]) this.displace(i, b);
      this.type[i] = c.el;
      this.bodyId[i] = b.id;
      this.temp[i] = b.temp;
      this.shade[i] = ((c.dx * 37 + c.dy * 91) & 255);
      this.vx[i] = 0; this.vy[i] = 0;
      this.awakeNext[this.chunkOf[i]] = 1;
      b.placed.push(i);
    }
  };

  W_.stepBodies = function () {
    const W = this.W, H = this.H, type = this.type, stateOf = this.stateOf;
    for (const b of this.bodies) {
      this.liftBody(b);
      // Forces.
      if (b.grab) {
        b.vx = Math.max(-8, Math.min(8, (b.grab.x - b.x) * 0.4));
        b.vy = Math.max(-8, Math.min(8, (b.grab.y - b.y) * 0.4));
      } else {
        b.vy += G;
        // Buoyancy: fraction of rows with liquid beside them, and the liquid's flow.
        let sub = 0, dens = 0, flowX = 0, flowY = 0, nl = 0;
        for (const r of b.sh.rows) {
          const y = b.y + r.y;
          if (y < 0 || y >= H) continue;
          let wet = false;
          for (const x of [b.x + r.l - 1, b.x + r.r + 1]) {
            if (x < 0 || x >= W) continue;
            const i = y * W + x, t = type[i];
            if (t && stateOf[t] === S.LIQUID) { wet = true; dens += this.densOf[t]; flowX += this.vx[i]; flowY += this.vy[i]; nl++; }
          }
          // also the cell just below the lowest row
          if (wet) sub++;
        }
        const below = b.y + b.sh.maxY + 1;
        if (below < H) {
          const t = type[below * W + b.x];
          if (t && stateOf[t] === S.LIQUID && sub === 0) { sub = 0.5; dens += this.densOf[t]; nl++; }
        }
        if (nl > 0) {
          const f = Math.min(1, sub / b.sh.rows.length), rho = dens / nl;
          b.vy -= Math.min(4 * G, G * f * (rho / b.density)); // buoyancy
          // Water resistance, and the current carries the object along.
          const drag = 0.14 * f;
          b.vx += (flowX / nl - b.vx) * drag;
          b.vy += (flowY / nl * 0.3 - b.vy) * drag;
        }
        b.vx *= 0.995;
      }
      const maxV = 7;
      b.vx = Math.max(-maxV, Math.min(maxV, b.vx));
      b.vy = Math.max(-maxV, Math.min(maxV, b.vy));

      // Move one cell at a time; bounce off what we hit.
      b.fx += b.vx; b.fy += b.vy;
      let mx = Math.trunc(b.fx), my = Math.trunc(b.fy);
      b.fx -= mx; b.fy -= my;
      let onGround = false;
      while (mx !== 0 || my !== 0) {
        if (my !== 0) {
          const sy = Math.sign(my);
          if (this.bodyFits(b, b.x, b.y + sy)) { b.y += sy; my -= sy; }
          else {
            if (sy > 0) onGround = true;
            b.vy = Math.abs(b.vy) > 0.8 ? -b.vy * b.bounce : 0; b.fy = 0; my = 0;
          }
        }
        if (mx !== 0) {
          const sx = Math.sign(mx);
          if (this.bodyFits(b, b.x + sx, b.y)) { b.x += sx; mx -= sx; }
          else if (this.bodyFits(b, b.x + sx, b.y - 1)) { b.x += sx; b.y -= 1; mx -= sx; } // step up small ledges
          else { b.vx = -b.vx * b.bounce; b.fx = 0; mx = 0; }
        }
      }
      if (!onGround && !this.bodyFits(b, b.x, b.y + 1)) onGround = true;
      if (onGround && !b.grab) {
        b.vx *= 0.96; // rolling / sliding friction
        // Slide off edges: if one side below is free, drift that way.
        if (Math.abs(b.vx) < 0.05) {
          const l = this.bodyFits(b, b.x - 1, b.y + 1), r = this.bodyFits(b, b.x + 1, b.y + 1);
          if (l && !r) b.vx -= 0.15; else if (r && !l) b.vx += 0.15;
        }
      }
      this.stampBody(b);
    }
  };

  W_.pushBodiesNear = function (cx, cy, R, power) {
    for (const b of this.bodies) {
      const dx = b.x - cx, dy = b.y - cy, d = Math.hypot(dx, dy);
      if (d > R) continue;
      const f = power * (1 - d / R);
      b.vx += (dx / (d || 1)) * f; b.vy += (dy / (d || 1)) * f - 0.5;
    }
  };
})();
