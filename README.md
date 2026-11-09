# Critical Mass

An open-world nuclear power plant management game that runs in the browser. You're the new
director of the Riverbend Generating Station, a revived plant in a river valley. You'll walk the
valley, run the reactor from a real control room, keep the town of Millbrook powered, and keep
the place from melting down.

> **Status: Milestone 3 — control room.** Walk into the Unit 1 control room (the low building just
> south of the plant road, door on its north side) and run the reactor from its panels. The
> "Cold start: Unit 1" objectives walk you from cold shutdown to putting power on the grid.
> The full plan is in `nuclear-plant-game-prompt.md`.

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
| E | Use whatever the crosshair is on (control-room consoles, alarm wall, trend recorder) |
| M | Full-screen map |
| Esc | Pause (releases the mouse). With a panel open, Esc (or E) closes it |
| \` (backtick) | Debug panel. While it's open: **N** toggles noclip flying, **T** skips ahead one hour, **=** cycles simulation speed ×1 / ×4 / ×16 |

## The control room

Six stations, each opening a panel. The panels have tabs, so you can switch between them without walking:

| Station | What it does |
| --- | --- |
| Reactor Control | Neutron power and flux (log scale), startup rate, reactivity breakdown, the four rod banks (sliders, plus all-bank IN/OUT/HOLD buttons), SCRAM, trip reset, safety-bypass keyswitch (asks before turning) |
| Primary Loop | Start/stop each coolant pump, flow, hot/cold leg temperatures, pressure, subcooling, inventory, pressurizer auto/manual (heaters, spray), main and auxiliary feedwater, steam generator level |
| Turbine & Grid | Turbine speed target, synchroscope and SYNC button, governor valve (load), output vs. grid demand, turbine trip/reset, condenser vacuum, steam dumps |
| Cooling Water | River intake pumps, cooling tower fans, condenser vacuum, heat load vs. capacity, outfall temperature |
| Annunciator wall | 20 alarm tiles: they flash when new, stay steady once acknowledged, and flash slowly once cleared. Acknowledge, silence the horn, reset |
| Trend recorder | Live charts over 10 min / 1 h / 6 h / 12 h of game time |

The console screens and the alarm wall also show live data in the 3D room.

**Cold start in brief:** start all four coolant pumps → withdraw rods (OUT 1 while far from
critical, then OUT 0.2), keeping the startup rate around 1 decade/min → hold about 10% power and keep
withdrawing as the plant heats to about 285 °C → Turbine & Grid: "Set 3600 rpm", wait for the
in-window lamp, SYNC → raise the governor valve to take load.

### Debug reactor shortcuts (debug panel open)

| Key | Action |
| --- | --- |
| `[` / `]` | Insert / withdraw all rod banks 1% (hold Shift for 5%) |
| P | Start / stop the four reactor coolant pumps |
| `,` / `.` | Turbine speed target −/+ 300 rpm before sync; governor valve −/+ 2% after |
| Y | Synchronise the generator to the grid (turbine must be at 3600 ±18 rpm) |
| X | Manual SCRAM |
| R | Reset the reactor trip (rods fully in, no trip condition), or reset a turbine trip |
| B | Safety bypass key: disables automatic trips, aux feedwater and safety injection |
| L / K | Load the plant at full power / reset to cold shutdown |

## How the reactor works

Riverbend is a simplified pressurized water reactor. It's meant to feel plausible and readable,
not to be an engineering simulator. Fast effects (power, temperatures, pressure) run in real
seconds. Slow ones (xenon, decay heat, fuel burnup) run on the game clock, so they play out
over in-game hours.

- **Reactivity** decides whether power rises or falls. Control rods take it away, fuel adds it, and
  heat and xenon take it away. At exactly zero the reactor is *critical* and power holds steady.
- **Startup.** The plant starts cold with all rods in. Start the coolant pumps, then withdraw rods
  slowly. Power climbs by *decades* (×10 steps); the startup rate (SUR, decades per minute) tells you
  how fast. Above 3 decades per minute at low power, the reactor trips.
- **Heat-up.** Hotter water and fuel take reactivity away, so you keep withdrawing rods as the plant
  warms. That same effect makes the reactor self-stabilising at power.
- **Making electricity.** Above about 150°C the steam generators make steam. Raise the turbine
  speed target to 3600 rpm, synchronise, then open the governor valve. Opening it draws more steam,
  which cools the coolant, which raises reactor power by itself: the reactor follows the load.
- **Xenon** is a neutron poison that builds up for hours after power drops. After a trip from full
  power it peaks around 8–10 game hours later, and for a while not even pulling every rod will
  restart the reactor. Plan around it.
- **Decay heat** keeps coming after shutdown (about 6% of full power at first, falling over hours),
  so the plant still needs cooling while it's off.
- **The safety system** trips the reactor on high flux, fast startup, high or low pressure, low
  coolant flow, high core temperature, low steam generator level, or a turbine trip at power. A
  reactor trip also trips the turbine.
- **Bypassing safeties** turns that off, along with auxiliary feedwater and safety injection. Lose
  the feedwater with the bypass on and the coolant boils, the relief valve vents it, the core
  uncovers, and the fuel eventually melts.

All the tuning numbers are in `src/sim/config.ts`.

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
  sim/          simulation (no rendering): clock, reactor plant model, alarms, annunciator, trends, grid demand, config
  world/        layout data, terrain, river, roads, buildings, town, countryside, sky, collision
  player/       input, first-person controller, crosshair interaction
  ui/           HUD, minimap, full map, in-world screens, alarm horn, control panels (ui/panels/)
  util/         seeded RNG, noise, math
tests/          Vitest unit tests
```

`world/layout.ts` is the single source of truth for where everything is. The heightfield,
collision, controller and clock are pure TypeScript with no Three.js, so they're unit-tested
and can run headless. Everything is generated from a fixed seed, so the world is identical on
every run.

For debugging there's `window.__game` in the browser console: `start()`, `teleport(x, z, yaw)`,
`setHour(h)`, `state()`.
