// Element definitions and reactions. Everything here is data; the engine reads it.
(function () {
  'use strict';
  const FX = (window.FX = window.FX || {});

  const S = { EMPTY: 0, STATIC: 1, POWDER: 2, LIQUID: 3, GAS: 4, FIRE: 5, TOOL: 6 };
  const list = [];
  const id = {};

  function def(key, o) {
    const e = Object.assign(
      {
        key,
        label: key[0].toUpperCase() + key.slice(1).replace(/_/g, ' '),
        state: S.STATIC,
        color: '#ffffff',
        vary: 14,
        density: 1000,
        cond: 0.2, // heat conductivity 0..1
        visc: 0, // 0 = runny, 1 = barely moves
        temp: 20, // spawn temperature (C)
        hiT: null, hiTo: null, // above hiT becomes hiTo
        loT: null, loTo: null, // below loT becomes loTo
        burn: 0, // chance per tick to catch from adjacent fire
        igniteT: null, // catches fire at this temperature
        burnTime: 0,
        burnTo: 'empty',
        explode: 0, // explosion radius when ignited
        life: null, // [min,max] ticks before dying (gases, fire)
        lifeTo: 'empty',
        glow: false,
        cat: null,
        hidden: false,
        tick: null,
      },
      o
    );
    e.id = list.length;
    list.push(e);
    id[key] = e.id;
    return e;
  }

  // ---------- Air ----------
  def('empty', { label: 'Air', state: S.EMPTY, color: '#000000', density: 1.2, cond: 0.012, vary: 0 });

  // ---------- Solids ----------
  def('wall', { cat: 'Solids', color: '#6b6f78', vary: 6, cond: 0.05, density: 99999 });
  def('stone', { cat: 'Solids', color: '#8a8580', density: 2600, cond: 0.25, hiT: 1100, hiTo: 'lava' });
  def('metal', { cat: 'Solids', color: '#a9b4bf', vary: 8, density: 7800, cond: 0.9, hiT: 1500, hiTo: 'molten_metal' });
  def('wood', { cat: 'Solids', color: '#8b5a2b', density: 700, cond: 0.08, burn: 0.08, igniteT: 300, burnTime: 400, burnTo: 'ash' });
  def('glass', { cat: 'Solids', color: '#bfe6ee', vary: 6, density: 2500, cond: 0.2, hiT: 1400, hiTo: 'molten_glass' });
  def('ice', { cat: 'Solids', color: '#a8d8f0', vary: 8, temp: -5, density: 917, cond: 0.4, hiT: 2, hiTo: 'water' });
  def('plant', { cat: 'Solids', color: '#3f9a3a', density: 900, cond: 0.1, burn: 0.06, igniteT: 220, burnTime: 120, burnTo: 'ash', hiT: 260, hiTo: 'ash' });

  // ---------- Powders ----------
  def('sand', { cat: 'Powders', state: S.POWDER, color: '#e0c27a', density: 1600, cond: 0.15, hiT: 1700, hiTo: 'molten_glass' });
  def('dirt', { cat: 'Powders', state: S.POWDER, color: '#6e4b2f', density: 1300, cond: 0.1 });
  def('salt', { cat: 'Powders', state: S.POWDER, color: '#f2f0ea', vary: 8, density: 2160, cond: 0.2, hiT: 800, hiTo: 'lava' });
  def('basalt', { cat: 'Powders', state: S.POWDER, color: '#4b4746', vary: 10, density: 2900, cond: 0.25, hiT: 1100, hiTo: 'lava' });
  def('ash', { cat: 'Powders', state: S.POWDER, color: '#9c9894', density: 600, cond: 0.05 });
  def('snow', { cat: 'Powders', state: S.POWDER, color: '#f4f8ff', vary: 6, temp: -10, density: 300, cond: 0.15, hiT: 2, hiTo: 'water' });
  def('gunpowder', { cat: 'Powders', state: S.POWDER, color: '#4a4a52', density: 1700, cond: 0.1, burn: 0.5, igniteT: 180, explode: 4 });

  // ---------- Liquids ----------
  def('water', { cat: 'Liquids', state: S.LIQUID, color: '#2f6fd6', vary: 8, density: 1000, cond: 0.5, hiT: 100, hiTo: 'steam', loT: 0, loTo: 'ice' });
  def('salt_water', { cat: 'Liquids', state: S.LIQUID, color: '#3f86c9', vary: 8, density: 1030, cond: 0.5, hiT: 102, hiTo: ['steam', 'steam', 'salt'], loT: -18, loTo: 'ice' });
  def('oil', { cat: 'Liquids', state: S.LIQUID, color: '#5a3d1e', vary: 6, density: 850, cond: 0.15, visc: 0.15, burn: 0.08, igniteT: 220, burnTime: 90, burnTo: 'smoke' });
  def('honey', { cat: 'Liquids', state: S.LIQUID, color: '#e8a317', vary: 6, density: 1420, cond: 0.2, visc: 0.85, hiT: 300, hiTo: 'smoke' });
  def('acid', { cat: 'Liquids', state: S.LIQUID, color: '#7cff3a', vary: 10, density: 1100, cond: 0.4, hiT: 200, hiTo: 'smoke' });
  def('mud', { cat: 'Liquids', state: S.LIQUID, color: '#5b3f26', density: 1600, cond: 0.2, visc: 0.75, hiT: 100, hiTo: 'dirt' });
  def('lava', { cat: 'Liquids', state: S.LIQUID, color: '#ff5a14', vary: 20, temp: 1300, density: 2600, cond: 0.35, visc: 0.7, loT: 850, loTo: 'basalt', glow: true });
  def('molten_glass', { cat: 'Liquids', state: S.LIQUID, color: '#ff9a3c', vary: 14, temp: 1600, density: 2400, cond: 0.3, visc: 0.85, loT: 1200, loTo: 'glass', glow: true, hidden: true });
  def('molten_metal', { cat: 'Liquids', state: S.LIQUID, color: '#ffc46b', vary: 14, temp: 1700, density: 7000, cond: 0.8, visc: 0.3, loT: 1400, loTo: 'metal', glow: true, hidden: true });

  // ---------- Gases ----------
  def('steam', { cat: 'Gases', state: S.GAS, color: '#c9d3df', vary: 10, temp: 120, density: 0.6, cond: 0.06, loT: 95, loTo: 'water', life: [1500, 3000], lifeTo: 'water' });
  def('smoke', { cat: 'Gases', state: S.GAS, color: '#5c5c62', vary: 10, density: 0.9, cond: 0.05, life: [150, 400] });
  def('methane', { cat: 'Gases', state: S.GAS, color: '#9bb59a', vary: 6, density: 0.7, cond: 0.05, burn: 0.6, igniteT: 500, explode: 2 });

  // ---------- Energy ----------
  def('fire', { cat: 'Energy', state: S.FIRE, color: '#ff8a1e', vary: 40, temp: 900, density: 0.3, cond: 0.5, life: [12, 40], lifeTo: ['empty', 'empty', 'empty', 'smoke'], glow: true });

  // ---------- Special ----------
  def('cloner', { cat: 'Special', color: '#c9b03a', vary: 4, cond: 0, density: 99999 });
  def('drain', { cat: 'Special', color: '#202024', vary: 2, cond: 0, density: 99999 });
  def('heater', { cat: 'Special', color: '#c8463a', vary: 4, temp: 600, cond: 0.6, density: 99999 });
  def('cooler', { cat: 'Special', color: '#3a7ec8', vary: 4, temp: -60, cond: 0.6, density: 99999 });

  // ---------- Tools ----------
  def('erase', { cat: 'Tools', state: S.TOOL, color: '#e8e8e8', vary: 0 });
  def('heat', { cat: 'Tools', state: S.TOOL, color: '#ff4b3a', vary: 0 });
  def('cool', { cat: 'Tools', state: S.TOOL, color: '#4bc8ff', vary: 0 });
  def('push', { label: 'Stir', cat: 'Tools', state: S.TOOL, color: '#b88cff', vary: 0 });

  // Resolve string references to ids.
  const ref = (v) => (v == null ? -1 : Array.isArray(v) ? v.map((k) => id[k]) : id[v]);
  for (const e of list) {
    e.hiTo = ref(e.hiTo);
    e.loTo = ref(e.loTo);
    e.burnTo = ref(e.burnTo);
    e.lifeTo = ref(e.lifeTo);
  }

  // ---------- Reactions (on contact, checked both ways) ----------
  // a + b -> a becomes `a`, b becomes `b` (undefined = unchanged), with chance p.
  const N = list.length;
  const rx = new Array(N * N).fill(null);
  function react(a, b, r) {
    rx[id[a] * N + id[b]] = {
      p: r.p,
      a: r.a === undefined ? -1 : id[r.a],
      b: r.b === undefined ? -1 : id[r.b],
      heat: r.heat || 0,
    };
  }
  react('water', 'lava', { a: 'steam', b: 'basalt', p: 0.25 });
  react('water', 'molten_metal', { a: 'steam', b: 'metal', p: 0.25 });
  react('water', 'molten_glass', { a: 'steam', b: 'glass', p: 0.25 });
  react('salt_water', 'lava', { a: 'steam', b: 'basalt', p: 0.25 });
  react('salt', 'water', { a: 'salt_water', b: 'salt_water', p: 0.02 });
  react('salt', 'ice', { b: 'salt_water', p: 0.03 });
  react('salt', 'snow', { b: 'salt_water', p: 0.05 });
  react('dirt', 'water', { a: 'mud', b: 'empty', p: 0.02 });
  react('fire', 'water', { a: 'steam', p: 0.4 });
  react('fire', 'salt_water', { a: 'steam', p: 0.4 });
  react('fire', 'snow', { a: 'steam', b: 'water', p: 0.3 });
  react('fire', 'ice', { a: 'steam', p: 0.2 });
  react('lava', 'ice', { b: 'water', p: 0.3 });
  react('lava', 'snow', { b: 'water', p: 0.5 });
  react('steam', 'ice', { a: 'water', p: 0.05 });
  for (const t of ['stone', 'basalt', 'metal', 'wood', 'sand', 'dirt', 'salt', 'ash', 'plant', 'ice', 'snow', 'mud', 'honey', 'gunpowder']) {
    react('acid', t, { b: 'empty', p: 0.04 });
  }
  react('acid', 'water', { a: 'water', p: 0.002 });

  FX.S = S;
  FX.EL = list;
  FX.ID = id;
  FX.RX = rx;
  FX.NEL = N;
  FX.CATS = ['Powders', 'Liquids', 'Solids', 'Gases', 'Energy', 'Special', 'Tools'];
})();
