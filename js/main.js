// UI, input, quality selection and the main loop.
(function () {
  'use strict';
  const FX = window.FX;
  const { EL, ID, S, CATS } = FX;

  const QUALITY = {
    low: { label: 'Low', cells: 24000 },
    medium: { label: 'Medium', cells: 50000 },
    high: { label: 'High', cells: 100000 },
    ultra: { label: 'Ultra', cells: 180000 },
    hd: { label: '1280×720', w: 1280, h: 720 },
    tall: { label: '1280×1200', w: 1280, h: 1200 },
    fhd: { label: '1920×1080', w: 1920, h: 1080 },
    car: { label: '1920×1200', w: 1920, h: 1200 },
  };
  const store = {
    get(k) { try { return localStorage.getItem('fluxel.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('fluxel.' + k, v); } catch (e) { /* private mode */ } },
  };

  // GPU presets: the shaders handle far more cells than the CPU engine.
  const GPU_CELLS = { low: 100000, medium: 200000, high: 400000, ultra: 800000 };

  const $ = (s) => document.querySelector(s);
  const canvas = $('#screen');
  const stage = $('#stage');

  // Engine: GPU (WebGL2) when the browser supports it, else the CPU engine.
  let engine = store.get('engine') === 'cpu' ? 'cpu' : 'gpu';
  let gl = null;
  if (engine === 'gpu' && FX.GPU && FX.GPU.supported()) gl = FX.GPU.context(canvas);
  if (!gl) engine = 'cpu';
  const renderer = engine === 'cpu' ? new FX.Renderer(canvas) : null;
  let view = 'normal';
  if (gl) {
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); });
    canvas.addEventListener('webglcontextrestored', () => location.reload());
  }

  let world = null;
  let layout = { ox: 0, oy: 0, w: 1, h: 1, scale: 1 };
  let paused = false, stepOnce = false;
  let current = ID.water, brush = 4, replace = false;
  let qualityKey = 'auto', autoPick = null;

  // ---------- quality ----------
  function benchmark() {
    const cells = 40000, W = Math.round(Math.sqrt(cells * 16 / 9)), H = Math.round(cells / W);
    const w = new FX.World(W, H);
    for (let y = (H * 0.35) | 0; y < H; y++) for (let x = 0; x < W; x++) w.set(y * W + x, x < W * 0.6 ? ID.water : ID.sand);
    for (let k = 0; k < 4; k++) w.step();
    const t0 = performance.now(), n = 12;
    for (let k = 0; k < n; k++) w.step();
    const msPerCell = (performance.now() - t0) / n / (W * H);
    const budget = 9; // ms per step, leaves room for drawing at 60 fps
    const affordable = budget / msPerCell;
    let pick = 'low';
    for (const k of ['medium', 'high', 'ultra']) if (QUALITY[k].cells <= affordable) pick = k;
    return { pick, affordable: Math.round(affordable) };
  }

  function stageSize() {
    const r = stage.getBoundingClientRect();
    return { w: Math.max(50, r.width), h: Math.max(50, r.height) };
  }

  function createWorld() {
    let key = qualityKey;
    if (key === 'auto') {
      if (!autoPick) autoPick = engine === 'gpu' ? { pick: 'ultra' } : benchmark();
      key = autoPick.pick;
    }
    const q = Object.assign({}, QUALITY[key]);
    if (engine === 'gpu' && GPU_CELLS[key]) q.cells = GPU_CELLS[key];
    let W, H;
    if (q.w) { W = q.w; H = q.h; } // exact pixel size, letterboxed to fit the screen
    else {
      const { w, h } = stageSize();
      // Never use cells smaller than 2 CSS pixels; phones get a smaller grid naturally.
      const cells = Math.min(q.cells, Math.floor((w * h) / 4));
      const aspect = w / h;
      W = Math.max(60, Math.round(Math.sqrt(cells * aspect)));
      H = Math.max(40, Math.round(cells / W));
    }
    if (engine === 'gpu') {
      if (world && world.dispose) world.dispose();
      world = new FX.GPUWorld(gl, W, H);
    } else {
      world = new FX.World(W, H);
      renderer.resize(world);
    }
    setBrush(Math.max(2, Math.round(Math.max(W, H) / 64)));
    fit();
    updateInfo();
  }

  function fit() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const { w, h } = stageSize();
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (!world) return;
    const scale = Math.min(canvas.width / world.W, canvas.height / world.H);
    const dw = world.W * scale, dh = world.H * scale;
    layout = { ox: Math.round((canvas.width - dw) / 2), oy: Math.round((canvas.height - dh) / 2), w: Math.round(dw), h: Math.round(dh), scale, dpr };
  }

  // ---------- palette ----------
  let activeCat = 'Liquids';
  function buildPalette() {
    const cats = $('#cats'), els = $('#els');
    cats.innerHTML = '';
    for (const c of CATS) {
      const b = document.createElement('button');
      b.className = 'cat' + (c === activeCat ? ' on' : '');
      b.textContent = c;
      b.onclick = () => { activeCat = c; buildPalette(); };
      cats.appendChild(b);
    }
    els.innerHTML = '';
    for (const e of EL) {
      if (e.cat !== activeCat || e.hidden) continue;
      const b = document.createElement('button');
      b.className = 'el' + (e.id === current ? ' on' : '');
      b.style.setProperty('--c', e.color);
      const [r, g, bl] = FX.hexRgb(e.color);
      b.style.color = r * 0.3 + g * 0.59 + bl * 0.11 > 150 ? '#111' : '#fff';
      b.textContent = e.label;
      b.onclick = () => { current = e.id; buildPalette(); updateInfo(); scopeShow(); };
      els.appendChild(b);
    }
  }

  // ---------- input ----------
  let pointer = null; // { id, x, y, erase }
  let hover = null;
  function toCell(ev) {
    const r = canvas.getBoundingClientRect();
    const dpr = layout.dpr || 1;
    const px = (ev.clientX - r.left) * dpr, py = (ev.clientY - r.top) * dpr;
    return { x: (px - layout.ox) / layout.scale, y: (py - layout.oy) / layout.scale };
  }
  function paintLine(a, b, erase) {
    const el = erase ? ID.erase : current;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.ceil(dist / Math.max(1, brush * 0.5)));
    for (let k = 1; k <= steps; k++) {
      const x = Math.round(a.x + (dx * k) / steps), y = Math.round(a.y + (dy * k) / steps);
      // Stroke speed gives what is painted a push, capped so a fast swipe cannot fling it.
      const sp = Math.hypot(dx, dy), k2 = sp > 12 ? 12 / sp : 1;
      world.paint(x, y, brush, el, dx * k2, dy * k2, replace);
    }
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (pointer) return; // one finger paints; extra fingers are ignored
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const c = toCell(e);
    pointer = { id: e.pointerId, x: c.x, y: c.y, lx: c.x, ly: c.y, erase: e.button === 2, grab: null };
    if (current === ID.scope && !pointer.erase) { pointer.scope = true; scopeAim(c); return; }
    // Objects: tap one to pick it up and throw it; with an object selected, tap empty space to drop a new one.
    if (!pointer.erase && current !== ID.erase) {
      const cx = Math.round(c.x), cy = Math.round(c.y);
      let b = world.bodyAt(cx, cy);
      if (!b && EL[current].state === S.OBJECT) b = world.spawnBody(current, cx, cy);
      if (b) { pointer.grab = b; b.grab = { x: b.x, y: b.y }; pointer.ox = b.x - c.x; pointer.oy = b.y - c.y; return; }
    }
    world.paint(Math.round(c.x), Math.round(c.y), brush, pointer.erase ? ID.erase : current, 0, 0, replace);
  });
  canvas.addEventListener('pointermove', (e) => {
    const c = toCell(e);
    hover = c;
    if (!pointer || e.pointerId !== pointer.id) return;
    if (pointer.scope) { scopeAim(c); return; }
    pointer.x = c.x; pointer.y = c.y;
    if (pointer.grab) pointer.grab.grab = { x: Math.round(c.x + pointer.ox), y: Math.round(c.y + pointer.oy) };
  });
  const end = (e) => {
    if (!pointer || e.pointerId !== pointer.id) return;
    if (pointer.grab) pointer.grab.grab = null; // let go: it keeps its speed, so a flick throws it
    pointer = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { hover = null; });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (current === ID.scope) scopeZoom(e.deltaY < 0 ? 1 : -1);
    else setBrush(brush + (e.deltaY < 0 ? 1 : -1));
  }, { passive: false });

  function setBrush(v) { brush = Math.max(0, Math.min(80, v)); $('#brushVal').textContent = brush + 1; $('#brush').value = brush; }

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePause(); }
    else if (e.code === 'KeyS') { stepOnce = true; }
    else if (e.code === 'KeyV') toggleView();
    else if (e.code === 'BracketLeft' || e.code === 'Minus') setBrush(brush - 1);
    else if (e.code === 'BracketRight' || e.code === 'Equal') setBrush(brush + 1);
    else if (e.code === 'Delete') world.clear();
    else if (e.code === 'KeyR') toggleReplace();
  });

  // ---------- toolbar ----------
  function togglePause() { paused = !paused; $('#pause').textContent = paused ? 'Play' : 'Pause'; $('#pause').classList.toggle('on', paused); }
  function toggleView() { view = view === 'heat' ? 'normal' : 'heat'; if (renderer) renderer.view = view; $('#view').classList.toggle('on', view === 'heat'); }
  function toggleReplace() { replace = !replace; $('#replace').classList.toggle('on', replace); }
  $('#pause').onclick = togglePause;
  $('#step').onclick = () => { stepOnce = true; };
  $('#view').onclick = toggleView;
  $('#replace').onclick = toggleReplace;
  $('#clear').onclick = () => world.clear();
  $('#demo').onclick = () => demo();
  $('#brush').oninput = (e) => setBrush(+e.target.value);
  const qSel = $('#quality');
  const eSel = $('#engine');
  eSel.value = engine;
  if (!gl && !(FX.GPU && FX.GPU.supported())) { const o = eSel.querySelector('option[value="gpu"]'); o.disabled = true; o.textContent = 'GPU (not supported)'; }
  eSel.onchange = () => { store.set('engine', eSel.value); location.reload(); };
  if (engine === 'gpu') for (const o of qSel.options) o.textContent = o.textContent.replace(' (heavy)', '');
  qSel.onchange = () => {
    qualityKey = qSel.value; store.set('quality', qualityKey);
    createWorld(); demo();
  };

  function updateInfo() {
    if (!world) return;
    const q = qualityKey === 'auto' ? 'Auto: ' + QUALITY[autoPick.pick].label : QUALITY[qualityKey].label;
    $('#grid').textContent = world.W + '×' + world.H + ' (' + q + ')';
    $('#grid').title = engine === 'gpu' ? 'Simulated on the GPU' : 'Simulated on the CPU';
  }

  // ---------- demo scene: a dam break ----------
  function demo() {
    world.clear();
    const W = world.W, H = world.H;
    const fill = (x0, y0, x1, y1, id) => {
      for (let y = Math.max(0, y0 | 0); y < Math.min(H, y1 | 0); y++)
        for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1 | 0); x++) world.set(y * W + x, id);
    };
    // floor and walls
    fill(0, H - 3, W, H, ID.wall);
    fill(0, 0, 2, H, ID.wall);
    fill(W - 2, 0, W, H, ID.wall);
    // the water column (dam break)
    fill(2, H * 0.25, W * 0.28, H - 3, ID.water);
    // obstacle
    fill(W * 0.52, H * 0.78, W * 0.56, H - 3, ID.stone);
    // a layer of oil on top and a sand pile on the right
    fill(2, H * 0.2, W * 0.28, H * 0.25, ID.oil);
    for (let y = 0; y < H * 0.25; y++) {
      const half = y * 1.6;
      fill(W * 0.82 - half, H - 3 - y, Math.min(W - 2, W * 0.82 + half), H - 2 - y, ID.sand);
    }
    // a little shelf of wood with gunpowder
    fill(W * 0.62, H * 0.45, W * 0.75, H * 0.47, ID.wood);
    fill(W * 0.64, H * 0.41, W * 0.73, H * 0.45, ID.gunpowder);
  }

  // ---------- scope: a magnifier with a crosshair and a count of what is in view ----------
  const ZOOMS = [9, 13, 17, 25, 33, 49, 65]; // cells across the lens (odd, so the crosshair sits on one cell)
  const scope = { x: -1, y: -1, zi: 3, t: 0 };
  const STATE_NAME = { [S.EMPTY]: 'air', [S.STATIC]: 'solid', [S.POWDER]: 'powder', [S.LIQUID]: 'liquid', [S.GAS]: 'gas', [S.FIRE]: 'fire', [S.TOOL]: 'tool', [S.BEAM]: 'energy', [S.OBJECT]: 'object' };
  const RGB = EL.map((e) => FX.hexRgb(e.color));
  const lens = $('#lens'), lctx = lens.getContext('2d');
  const lensImg = { n: 0, c: document.createElement('canvas') };
  function scopeShow() {
    const on = current === ID.scope;
    $('#scope').hidden = !on; $('#scopeBox').hidden = !on || scope.x < 0;
    if (on && scope.x < 0 && world) scopeAim({ x: world.W / 2, y: world.H / 2 });
  }
  function scopeAim(c) {
    if (!world) return;
    scope.x = Math.max(0, Math.min(world.W - 1, Math.floor(c.x)));
    scope.y = Math.max(0, Math.min(world.H - 1, Math.floor(c.y)));
    scope.t = 0; // refresh on the next frame
  }
  function scopeZoom(d) { scope.zi = Math.max(0, Math.min(ZOOMS.length - 1, scope.zi + d)); scope.t = 0; }
  $('#zoomIn').onclick = () => scopeZoom(-1); // fewer cells across = more magnified
  $('#zoomOut').onclick = () => scopeZoom(1);
  function cellColor(id, shade, t) {
    if (id === 0) return [14, 16, 24];
    const e = EL[id], [r0, g0, b0] = RGB[id];
    const k = (((shade >> 3) / 31) * 2 - 1) * e.vary;
    let r = r0 + k, g = g0 + k, b = b0 + k;
    if (e.glow) { const q = Math.min(1.15, Math.max(0.3, (t - 700) / 900)); r *= q; g *= q * q; b *= q * q; }
    else if (t > 400) { const h = Math.min(1, (t - 400) / 900); r += (255 - r) * h; g += (120 - g) * h * 0.6; b *= 1 - h; }
    return [r, g, b];
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
  function scopeUpdate() {
    if (!world || scope.x < 0) return;
    const n = ZOOMS[scope.zi], half = n >> 1, W = world.W, H = world.H;
    scope.x = Math.min(scope.x, W - 1); scope.y = Math.min(scope.y, H - 1); // the grid can shrink
    const x0 = scope.x - half, y0 = scope.y - half;
    // Only the part inside the world is read; the rest of the lens is drawn as out of bounds.
    const rx0 = Math.max(0, x0), ry0 = Math.max(0, y0), rx1 = Math.min(W, x0 + n), ry1 = Math.min(H, y0 + n);
    const rw = rx1 - rx0, rh = ry1 - ry0;
    const reg = world.region(rx0, ry0, rw, rh);
    // Lens image: one pixel per cell, scaled up without smoothing.
    if (lensImg.n !== n) { lensImg.n = n; lensImg.c.width = n; lensImg.c.height = n; lensImg.ctx = lensImg.c.getContext('2d'); lensImg.img = lensImg.ctx.createImageData(n, n); }
    const d = lensImg.img.data, counts = new Map();
    let total = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const o = (j * n + i) * 4, x = x0 + i, y = y0 + j;
      let rgb = [7, 8, 11];
      if (x >= rx0 && x < rx1 && y >= ry0 && y < ry1) {
        const k = (y - ry0) * rw + (x - rx0), id = reg.id[k];
        rgb = cellColor(id, reg.shade[k], reg.temp[k]);
        const key = reg.obj[k] || id;
        if (key) { total++; counts.set(key, (counts.get(key) || 0) + 1); }
      }
      d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
    }
    lensImg.ctx.putImageData(lensImg.img, 0, 0);
    const L = lens.width, cs = L / n;
    lctx.imageSmoothingEnabled = false;
    lctx.drawImage(lensImg.c, 0, 0, L, L);
    // Grid lines when zoomed in far enough, then the crosshair around the centre cell.
    if (cs >= 10) {
      lctx.strokeStyle = 'rgba(0,0,0,0.25)'; lctx.lineWidth = 1; lctx.beginPath();
      for (let k = 1; k < n; k++) { const v = Math.round(k * cs) + 0.5; lctx.moveTo(v, 0); lctx.lineTo(v, L); lctx.moveTo(0, v); lctx.lineTo(L, v); }
      lctx.stroke();
    }
    const c0 = half * cs, mid = c0 + cs / 2;
    lctx.strokeStyle = 'rgba(255,209,102,0.95)'; lctx.lineWidth = 2;
    lctx.strokeRect(c0, c0, cs, cs);
    lctx.beginPath();
    lctx.moveTo(mid, 0); lctx.lineTo(mid, c0 - 2); lctx.moveTo(mid, c0 + cs + 2); lctx.lineTo(mid, L);
    lctx.moveTo(0, mid); lctx.lineTo(c0 - 2, mid); lctx.moveTo(c0 + cs + 2, mid); lctx.lineTo(L, mid);
    lctx.stroke();
    // What is under the crosshair.
    const ck = (scope.y - ry0) * rw + (scope.x - rx0), cid = reg.id[ck], cobj = reg.obj[ck], ce = EL[cid];
    let html;
    if (cobj) html = '<b>' + esc(EL[cobj].label) + '</b> · object<br>made of ' + esc(ce.label.toLowerCase());
    else html = (cid ? '<b>' + esc(ce.label) + '</b> · ' + STATE_NAME[ce.state] : '<b>Nothing</b> · empty air') + '<br>' + Math.round(reg.temp[ck]) + ' °C';
    $('#scopeCenter').innerHTML = html + ' <span style="color:var(--muted)">at ' + scope.x + ', ' + scope.y + '</span>';
    // Counts of everything in view, most common first.
    const cells = rw * rh;
    $('#scopeSum').textContent = total + ' particle' + (total === 1 ? '' : 's') + ' in ' + n + '×' + n + ' · ' + counts.size + ' kind' + (counts.size === 1 ? '' : 's');
    const rows = [...counts].sort((a, b) => b[1] - a[1]);
    $('#scopeList').innerHTML = rows.map(([id, c]) => '<li><span class="sw" style="--c:' + EL[id].color + '"></span><span>' + esc(EL[id].label) + '</span><span class="n">' + c + '</span><span class="pc">' + Math.round((c * 100) / cells) + '%</span></li>').join('');
    $('#zoomVal').textContent = n + '×' + n;
    // Panel on the side away from the target; box on the stage around what the lens shows.
    const dpr = layout.dpr || 1, sx = layout.scale / dpr;
    const bx = (layout.ox / dpr) + x0 * sx, by = (layout.oy / dpr) + y0 * sx;
    const box = $('#scopeBox');
    box.hidden = false;
    Object.assign(box.style, { left: bx + 'px', top: by + 'px', width: n * sx + 'px', height: n * sx + 'px' });
    $('#scope').classList.toggle('left', scope.x > W * 0.55);
  }

  // ---------- loop ----------
  let last = performance.now(), acc = 0, frames = 0, fpsT = last, simMs = 0;
  const STEP = 1000 / 60;
  function frame(now) {
    const dt = Math.min(100, now - last); last = now;
    if (pointer && !pointer.grab && !pointer.scope) {
      const a = { x: pointer.lx, y: pointer.ly }, b = { x: pointer.x, y: pointer.y };
      paintLine(a, b, pointer.erase);
      pointer.lx = pointer.x; pointer.ly = pointer.y;
    }
    const t0 = performance.now();
    if (!paused) {
      acc += dt;
      let n = 0;
      while (acc >= STEP && n < 2) { world.step(); acc -= STEP; n++; }
      if (n === 2) acc = 0; // too slow: run in slow motion instead of spiralling
    } else if (stepOnce) { world.step(); }
    stepOnce = false;
    simMs = simMs * 0.9 + (performance.now() - t0) * 0.1;
    if (renderer) renderer.draw(world, layout);
    else world.draw(layout, view);
    if (current === ID.scope && now - scope.t > 100) { scope.t = now; scopeUpdate(); }
    frames++;
    if (now - fpsT > 500) {
      const fps = Math.round((frames * 1000) / (now - fpsT));
      $('#fps').textContent = engine === 'gpu' ? fps + ' fps · GPU' : fps + ' fps · sim ' + simMs.toFixed(1) + ' ms · ' + world.count + ' px';
      frames = 0; fpsT = now;
      if (hover) {
        const x = Math.floor(hover.x), y = Math.floor(hover.y);
        if (x >= 0 && y >= 0 && x < world.W && y < world.H) {
          let id, t;
          if (world.probe) { const c = world.probe(x, y); id = c.id; t = c.temp; }
          else { const i = y * world.W + x; id = world.type[i]; t = world.temp[i]; }
          $('#hover').textContent = EL[id].label + ' ' + Math.round(t) + '°C';
        }
      } else $('#hover').textContent = '';
    }
    requestAnimationFrame(frame);
  }

  // ---------- start ----------
  if (store.get('hint') === 'off') $('#hint').classList.add('hide');
  $('#hintClose').onclick = () => { $('#hint').classList.add('hide'); store.set('hint', 'off'); };
  canvas.addEventListener('pointerdown', () => $('#hint').classList.add('hide'), { once: true });
  const saved = store.get('quality');
  if (saved && (saved === 'auto' || QUALITY[saved])) qualityKey = saved;
  qSel.value = qualityKey;
  buildPalette();
  setBrush(brush);
  createWorld();
  demo();
  scopeShow();
  if (window.ResizeObserver) new ResizeObserver(() => fit()).observe(stage);
  else window.addEventListener('resize', fit);
  requestAnimationFrame(frame);
  FX.debug = { get world() { return world; }, benchmark, engine };
})();
