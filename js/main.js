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
  };
  const store = {
    get(k) { try { return localStorage.getItem('fluxel.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('fluxel.' + k, v); } catch (e) { /* private mode */ } },
  };

  const $ = (s) => document.querySelector(s);
  const canvas = $('#screen');
  const stage = $('#stage');
  const renderer = new FX.Renderer(canvas);

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
      if (!autoPick) autoPick = benchmark();
      key = autoPick.pick;
    }
    let cells = QUALITY[key].cells;
    const { w, h } = stageSize();
    // Never use cells smaller than 2 CSS pixels; phones get a smaller grid naturally.
    cells = Math.min(cells, Math.floor((w * h) / 4));
    const aspect = w / h;
    const W = Math.max(60, Math.round(Math.sqrt(cells * aspect)));
    const H = Math.max(40, Math.round(cells / W));
    world = new FX.World(W, H);
    renderer.resize(world);
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
      b.onclick = () => { current = e.id; buildPalette(); updateInfo(); };
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
      world.paint(x, y, brush, el, dx, dy, replace);
    }
  }
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (pointer) return; // one finger paints; extra fingers are ignored
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const c = toCell(e);
    pointer = { id: e.pointerId, x: c.x, y: c.y, lx: c.x, ly: c.y, erase: e.button === 2 };
    world.paint(Math.round(c.x), Math.round(c.y), brush, pointer.erase ? ID.erase : current, 0, 0, replace);
  });
  canvas.addEventListener('pointermove', (e) => {
    const c = toCell(e);
    hover = c;
    if (!pointer || e.pointerId !== pointer.id) return;
    pointer.x = c.x; pointer.y = c.y;
  });
  const end = (e) => { if (pointer && e.pointerId === pointer.id) pointer = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { hover = null; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); setBrush(brush + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

  function setBrush(v) { brush = Math.max(0, Math.min(40, v)); $('#brushVal').textContent = brush + 1; $('#brush').value = brush; }

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
  function toggleView() { renderer.view = renderer.view === 'heat' ? 'normal' : 'heat'; $('#view').classList.toggle('on', renderer.view === 'heat'); }
  function toggleReplace() { replace = !replace; $('#replace').classList.toggle('on', replace); }
  $('#pause').onclick = togglePause;
  $('#step').onclick = () => { stepOnce = true; };
  $('#view').onclick = toggleView;
  $('#replace').onclick = toggleReplace;
  $('#clear').onclick = () => world.clear();
  $('#demo').onclick = () => demo();
  $('#brush').oninput = (e) => setBrush(+e.target.value);
  const qSel = $('#quality');
  qSel.onchange = () => {
    qualityKey = qSel.value; store.set('quality', qualityKey);
    createWorld(); demo();
  };

  function updateInfo() {
    if (!world) return;
    const q = qualityKey === 'auto' ? 'Auto: ' + QUALITY[autoPick.pick].label : QUALITY[qualityKey].label;
    $('#grid').textContent = world.W + '×' + world.H + ' (' + q + ')';
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

  // ---------- loop ----------
  let last = performance.now(), acc = 0, frames = 0, fpsT = last, simMs = 0;
  const STEP = 1000 / 60;
  function frame(now) {
    const dt = Math.min(100, now - last); last = now;
    if (pointer) {
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
    renderer.draw(world, layout);
    frames++;
    if (now - fpsT > 500) {
      $('#fps').textContent = Math.round((frames * 1000) / (now - fpsT)) + ' fps · sim ' + simMs.toFixed(1) + ' ms · ' + world.count + ' px';
      frames = 0; fpsT = now;
      if (hover) {
        const x = Math.floor(hover.x), y = Math.floor(hover.y);
        if (x >= 0 && y >= 0 && x < world.W && y < world.H) {
          const i = y * world.W + x;
          $('#hover').textContent = EL[world.type[i]].label + ' ' + Math.round(world.temp[i]) + '°C';
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
  if (window.ResizeObserver) new ResizeObserver(() => fit()).observe(stage);
  else window.addEventListener('resize', fit);
  requestAnimationFrame(frame);
  FX.debug = { get world() { return world; }, benchmark };
})();
