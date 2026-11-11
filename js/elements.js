// Element definitions and reactions. Everything here is data; the engine reads it.
(function () {
  'use strict';
  const FX = (window.FX = window.FX || {});

  const S = { EMPTY: 0, STATIC: 1, POWDER: 2, LIQUID: 3, GAS: 4, FIRE: 5, TOOL: 6, BEAM: 7 };
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
        trail: -1, // beams: the glow they leave behind
        pop: 0, // upward kick when something turns into this (popcorn)
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

  def('liquid_nitrogen', { cat: 'Liquids', state: S.LIQUID, color: '#cfe8ff', vary: 6, temp: -196, density: 808, cond: 0.6, hiT: -150, hiTo: 'nitrogen' });

  // ---------- Gases ----------
  def('steam', { cat: 'Gases', state: S.GAS, color: '#c9d3df', vary: 10, temp: 120, density: 0.6, cond: 0.06, loT: 95, loTo: 'water', life: [1500, 3000], lifeTo: 'water' });
  def('smoke', { cat: 'Gases', state: S.GAS, color: '#5c5c62', vary: 10, density: 0.9, cond: 0.05, life: [150, 400] });
  def('nitrogen', { cat: 'Gases', state: S.GAS, color: '#9fb4d8', vary: 6, temp: -150, density: 1.1, cond: 0.1, life: [200, 500], hidden: true });
  def('methane', { cat: 'Gases', state: S.GAS, color: '#9bb59a', vary: 6, density: 0.7, cond: 0.05, burn: 0.6, igniteT: 500, explode: 2 });

  // ---------- Energy ----------
  def('fire', { cat: 'Energy', state: S.FIRE, color: '#ff8a1e', vary: 40, temp: 900, density: 0.3, cond: 0.5, life: [12, 40], lifeTo: ['empty', 'empty', 'empty', 'smoke'], glow: true });

  def('plasma', { cat: 'Energy', state: S.FIRE, color: '#c77dff', vary: 40, temp: 3500, density: 0.2, cond: 0.6, life: [20, 60], lifeTo: ['empty', 'empty', 'fire'], glow: true });
  // Beams fly in a straight line (the way you drag, or down) and act on what they hit.
  def('laser_glow', { state: S.EMPTY, color: '#ff4d6d', vary: 10, cond: 0, life: [8, 14], hidden: true });
  def('frost_glow', { state: S.EMPTY, color: '#8fe8ff', vary: 10, cond: 0, life: [8, 14], hidden: true });
  def('bolt_glow', { state: S.EMPTY, color: '#f4f1ff', vary: 10, cond: 0, life: [6, 12], hidden: true });
  def('laser', { cat: 'Energy', state: S.BEAM, color: '#ff2d55', vary: 0, cond: 0, trail: 'laser_glow' });
  def('freeze_ray', { cat: 'Energy', state: S.BEAM, color: '#5ad8ff', vary: 0, cond: 0, trail: 'frost_glow' });
  def('lightning', { cat: 'Energy', state: S.BEAM, color: '#ffffff', vary: 0, cond: 0, trail: 'bolt_glow' });

  // ---------- Food ----------
  def('flour', { cat: 'Food', state: S.POWDER, color: '#f3ead8', vary: 6, density: 600, cond: 0.1, burn: 0.02, igniteT: 400, burnTo: 'ash' });
  def('dough', { cat: 'Food', color: '#e8d2a6', vary: 6, density: 1100, cond: 0.15, hiT: 170, hiTo: 'bread' });
  def('bread', { cat: 'Food', color: '#c98b4a', vary: 10, density: 300, cond: 0.08, hiT: 230, hiTo: 'toast' });
  def('toast', { color: '#7a4a22', vary: 10, density: 300, cond: 0.08, burn: 0.05, igniteT: 330, burnTime: 150, burnTo: 'ash', hidden: true });
  def('egg', { cat: 'Food', state: S.POWDER, color: '#f6efe3', vary: 6, density: 1030, cond: 0.2, hiT: 75, hiTo: 'cooked_egg' });
  def('cooked_egg', { state: S.POWDER, color: '#fff4c2', vary: 10, density: 1000, cond: 0.2, hiT: 300, hiTo: 'ash', hidden: true });
  def('meat', { cat: 'Food', color: '#c4474f', vary: 12, density: 1050, cond: 0.2, hiT: 70, hiTo: 'cooked_meat' });
  def('cooked_meat', { color: '#8a4a32', vary: 12, density: 1000, cond: 0.2, hiT: 280, hiTo: 'ash', hidden: true });
  def('cheese', { cat: 'Food', color: '#f5c542', vary: 8, density: 1100, cond: 0.15, hiT: 60, hiTo: 'melted_cheese' });
  def('melted_cheese', { state: S.LIQUID, color: '#f7b733', vary: 8, density: 1050, cond: 0.15, visc: 0.9, loT: 45, loTo: 'cheese', hiT: 300, hiTo: 'smoke', hidden: true });
  def('butter', { cat: 'Food', color: '#f8e08e', vary: 6, density: 910, cond: 0.15, hiT: 35, hiTo: 'melted_butter' });
  def('melted_butter', { state: S.LIQUID, color: '#f2c94c', vary: 6, density: 900, cond: 0.15, visc: 0.2, loT: 25, loTo: 'butter', burn: 0.05, igniteT: 250, burnTime: 80, burnTo: 'smoke', hidden: true });
  def('chocolate', { cat: 'Food', color: '#5b3220', vary: 8, density: 1300, cond: 0.15, hiT: 36, hiTo: 'melted_chocolate' });
  def('melted_chocolate', { state: S.LIQUID, color: '#6e3b22', vary: 6, density: 1250, cond: 0.15, visc: 0.75, loT: 28, loTo: 'chocolate', hiT: 300, hiTo: 'smoke', hidden: true });
  def('sugar', { cat: 'Food', state: S.POWDER, color: '#fbfbf7', vary: 5, density: 1590, cond: 0.15, hiT: 186, hiTo: 'caramel' });
  def('caramel', { state: S.LIQUID, color: '#c97a1e', vary: 8, temp: 190, density: 1400, cond: 0.2, visc: 0.85, loT: 90, loTo: 'candy', hiT: 320, hiTo: 'smoke', hidden: true });
  def('candy', { color: '#e8a04a', vary: 10, density: 1500, cond: 0.2, hiT: 160, hiTo: 'caramel', hidden: true });
  def('sugar_water', { state: S.LIQUID, color: '#5a8fd6', vary: 8, density: 1060, cond: 0.5, hiT: 103, hiTo: ['steam', 'steam', 'sugar'], loT: -5, loTo: 'ice', hidden: true });
  def('milk', { cat: 'Food', state: S.LIQUID, color: '#f4f4ee', vary: 4, density: 1035, cond: 0.45, hiT: 100, hiTo: ['steam', 'steam', 'cheese'], loT: -2, loTo: 'ice_cream' });
  def('ice_cream', { color: '#fbe3ec', vary: 8, temp: -10, density: 600, cond: 0.25, hiT: 2, hiTo: 'milk', hidden: true });
  def('juice', { cat: 'Food', state: S.LIQUID, color: '#ff9f1c', vary: 8, density: 1050, cond: 0.45, hiT: 100, hiTo: ['steam', 'steam', 'sugar'], loT: -3, loTo: 'ice' });
  def('corn', { cat: 'Food', label: 'Popcorn kernel', state: S.POWDER, color: '#f2b705', vary: 10, density: 1200, cond: 0.2, hiT: 180, hiTo: 'popcorn' });
  def('popcorn', { state: S.POWDER, color: '#fffaf0', vary: 10, density: 100, cond: 0.05, burn: 0.05, igniteT: 300, burnTime: 40, burnTo: 'ash', pop: 3.5, hidden: true });

  // ---------- Special ----------
  def('cloner', { cat: 'Special', color: '#c9b03a', vary: 4, cond: 0, density: 99999 });
  def('drain', { cat: 'Special', color: '#202024', vary: 2, cond: 0, density: 99999 }); // swallows liquids
  def('void', { cat: 'Special', color: '#0a0610', vary: 3, cond: 0, density: 99999 }); // swallows anything that moves
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
    e.trail = ref(e.trail === -1 ? null : e.trail);
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
  react('flour', 'water', { a: 'dough', b: 'empty', p: 0.05 });
  react('sugar', 'water', { a: 'sugar_water', b: 'sugar_water', p: 0.03 });
  react('liquid_nitrogen', 'water', { b: 'ice', p: 0.3 });
  react('liquid_nitrogen', 'fire', { b: 'smoke', p: 0.5 });
  for (const t of ['bread', 'meat', 'cheese', 'egg', 'dough']) react('acid', t, { b: 'empty', p: 0.04 });

  FX.S = S;
  FX.EL = list;
  FX.ID = id;
  FX.RX = rx;
  FX.NEL = N;
  FX.CATS = ['Powders', 'Liquids', 'Solids', 'Gases', 'Energy', 'Food', 'Special', 'Tools'];
})();
