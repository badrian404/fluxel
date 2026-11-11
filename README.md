# Fluxel

A falling-sand style pixel simulation that runs in the browser, built around lifelike fluid motion.
Liquids carry momentum: they splash, slosh, form waves and level out in connected containers.

Play it by opening `index.html` (no build step), or host the folder on GitHub Pages.

## How it works

- **Material grid** (`js/sim.js`): flat typed arrays, one entry per cell (element, temperature, velocity, timers).
  Powders, liquids and gases move cell by cell; heat spreads between neighbours and changes states;
  fire spreads; elements react on contact.
- **Fluid solver** (`js/fluid.js`): a coarse staggered grid. Liquid cell velocities are gathered onto it,
  gravity is applied, a pressure solve makes the flow incompressible, and the change is blended back into
  the cells (FLIP style). Cells then travel along their own velocity.
- **Elements** (`js/elements.js`): plain data (state, density, viscosity, melting/boiling points,
  flammability, reactions). Add an element by adding a `def(...)` line.
- **Rendering** (`js/render.js`): one pixel buffer per frame, scaled to the screen. Heat view shows temperature.
- **Quality**: "Auto" runs a short benchmark on first load and picks a grid size the device can run at 60 fps.

## Elements

Powders, liquids, solids, gases, energy (fire, plasma, laser, freeze ray, lightning), food that cooks,
melts and mixes (flour + water makes dough, dough bakes into bread, sugar caramelises, popcorn pops),
and special blocks: cloner, drain (removes liquids), void (removes anything that moves), heater and cooler.
Laser and freeze ray shoot in the direction you drag; lightning strikes downward.

## Controls

| Input | Action |
| --- | --- |
| Drag (mouse or finger) | Pour the selected element; flinging gives it speed |
| Right-click | Erase |
| Mouse wheel, `[` `]` | Brush size |
| Space | Pause / play |
| S | Step one frame |
| V | Heat view |
| R | Replace mode (paint over existing pixels) |
| Delete | Clear |
