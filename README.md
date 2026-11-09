# Critical Mass

An open-world nuclear power plant management game that runs in the browser. You're the new
director of the Riverbend Generating Station, a revived plant in a river valley. You'll walk the
valley, run the reactor from a real control room, keep the town of Millbrook powered, and keep
the place from melting down.

> **Status: Milestone 1 — walkable world skeleton.** The valley, plant campus, town, roads,
> first-person movement with collision, day/night cycle, minimap and full map are in.
> The reactor simulation arrives in Milestone 2. The full plan is in `nuclear-plant-game-prompt.md`.

## Run it

Needs Node.js 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (Vitest)
npm run build      # type-check + production build into dist/
```

## Controls

| Key | Action |
| --- | --- |
| W A S D / arrows | Move |
| Mouse | Look (click the game to capture the mouse) |
| Shift | Sprint |
| Space | Jump |
| C or Ctrl | Crouch |
| M | Full-screen map |
| Esc | Pause (releases the mouse) |
| \` (backtick) | Debug panel. While it's open: **N** toggles noclip flying, **T** skips ahead one hour |

## The valley

- **Riverbend Generating Station** (west bank): domed containment building, turbine hall and
  control room (both enterable), two cooling towers with steam plumes, switchyard, dry-cask fuel
  pad, admin office, parking and a fenced perimeter with a security gate.
- **Ash River**: you can swim in it. Riverbend Bridge carries the access road across.
- **Millbrook** (east bank): street grid, town hall and square, school, shops and houses. Windows and
  street lamps light up at night.
- **Lookout Hill** (north-east): dirt road up to a timber viewing tower over the whole valley.
- **Industrial park** (south-east), **farmland** (east), **North and West Woods**, with mountains
  ringing the map.

One in-game day lasts 20 real minutes, starting at 08:00.

## Code layout

```
src/
  main.ts       bootstrap + game loop (fixed-step sim, variable render)
  sim/          simulation (no rendering): clock (reactor arrives in Milestone 2)
  world/        layout data, terrain, river, roads, buildings, town, countryside, sky, collision
  player/       input, first-person controller
  ui/           HUD, minimap, full map, styles
  util/         seeded RNG, noise, math
tests/          Vitest unit tests
```

`world/layout.ts` is the single source of truth for where everything is. The heightfield,
collision, controller and clock are pure TypeScript with no Three.js, so they're unit-tested
and can run headless. Everything is generated from a fixed seed, so the world is identical on
every run.

For debugging there's `window.__game` in the browser console: `start()`, `teleport(x, z, yaw)`,
`setHour(h)`, `state()`.
