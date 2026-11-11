# Fluxel

A falling-sand style pixel simulation that runs in the browser, built around lifelike fluid motion.
Liquids carry momentum: they splash, slosh, form waves and level out in connected containers.

Play it by opening `index.html` (no build step), or host the folder on GitHub Pages.

## How it works

- **GPU engine** (`js/gpu.js`, used by default): the whole simulation runs in WebGL2 fragment shaders.
  Cell state lives in textures; each step runs the fluid solve, one physics pass (heat, reactions, fire,
  explosions, machines), beam passes and six 2×2 block movement passes, so cells are never lost or duplicated.
  Objects keep their physics on the CPU and read the cells around them back from the GPU without stalling it.
  Pick **CPU** in the engine menu to use the original engine below (it is also the automatic fallback
  when the browser has no WebGL2 float render targets).
- **Material grid** (`js/sim.js`): flat typed arrays, one entry per cell (element, temperature, velocity, timers).
  Powders, liquids and gases move cell by cell; heat spreads between neighbours and changes states;
  fire spreads; elements react on contact.
- **Fluid solver** (`js/fluid.js`): a coarse staggered grid. Liquid cell velocities are gathered onto it,
  gravity is applied, a pressure solve makes the flow incompressible, and the change is blended back into
  the cells (FLIP style). Cells then travel along their own velocity.
- **Elements** (`js/elements.js`): plain data (state, density, viscosity, melting/boiling points,
  flammability, reactions). Add an element by adding a `def(...)` line.
- **Rendering** (`js/render.js`): one pixel buffer per frame, scaled to the screen. Heat view shows temperature.
- **Quality**: on the GPU, "Auto" fills the screen at 2 CSS pixels per cell (up to 800k cells). On the CPU, "Auto" runs a short benchmark on first load and picks a grid size the device can run at 60 fps.

## Elements

Powders, liquids, solids, gases, energy (fire, plasma, laser, freeze ray, lightning), food that cooks,
melts and mixes (flour + water makes dough, dough bakes into bread, sugar caramelises, popcorn pops),
and special blocks: cloner, drain (removes liquids), void (removes anything that moves), heater and cooler.
Laser and freeze ray shoot in the direction you drag; lightning strikes downward.

Objects (tennis ball, rubber duck, beach ball, crate, bowling ball) move as one piece: they bounce,
float or sink depending on their density, drift with the current, and push water aside.
Tap an object to pick it up; flick and release to throw it.

## Resolution

Auto, Low, Medium, High and Ultra size the grid to the screen. The fixed sizes (1280×720, 1280×1200,
1920×1080 and 1920×1200) simulate exactly that many cells and are scaled to fit. The GPU engine is built to run them
at 60 fps on a dedicated graphics chip (such as the one in the 2024 Model Y). On the CPU engine the big ones are heavy:
expect slow motion while a lot is moving. Regions where nothing changes go to sleep, so settled scenes
run much faster.

## Controls

| Input | Action |
| --- | --- |
| Drag (mouse or finger) | Pour the selected element; flinging gives it speed |
| Tap an object | Pick it up; flick and release to throw |
| Right-click | Erase |
| Mouse wheel, `[` `]` | Brush size |
| Space | Pause / play |
| S | Step one frame |
| V | Heat view |
| R | Replace mode (paint over existing pixels) |
| Delete | Clear |
