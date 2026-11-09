# Critical Mass

An open-world nuclear power plant management game that runs in the browser. You're the new
director of the Riverbend Generating Station, a revived plant in a river valley. You'll walk the
valley, run the reactor from a real control room, keep the town of Millbrook powered, and keep
the place from melting down.

> **Status: Milestone 6 — management layer.** Riverbend is now a business. Press **Tab** for the
> Director's Tablet: hire shift operators to run the reactor while you're out, send crews to
> faults, sign supply contracts, watch the books, and keep the regulator and the public on side.
> Run the reactor yourself from the Unit 1 control room (the low building just south of the plant
> road, door on its north side). The full plan is in `nuclear-plant-game-prompt.md`.

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
| E | Use whatever the crosshair is on (control-room consoles, field equipment), get in or out of the truck |
| W A S D (in the truck) | Drive and steer. Space is the handbrake; the mouse swings the camera |
| Tab | Director's Tablet (management). Tab or Esc closes it |
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
| Grid Dispatch | Grid frequency, generation vs. demand vs. served, every substation's feeders, Millbrook's 8 districts, the over-frequency trip timer |
| Annunciator wall | 20 alarm tiles: they flash when new, stay steady once acknowledged, and flash slowly once cleared. Acknowledge, silence the horn, reset |
| Trend recorder | Live charts over 10 min / 1 h / 6 h / 12 h of game time |

The console screens and the alarm wall also show live data in the 3D room.

**Cold start in brief:** start all four coolant pumps → withdraw rods (OUT 1 while far from
critical, then OUT 0.2), keeping the startup rate around 1 decade/min → hold about 10% power and keep
withdrawing as the plant heats to about 285 °C → Turbine & Grid: "Set 3600 rpm", wait for the
in-window lamp, SYNC → raise the governor valve to take load.

## The grid

Riverbend is the only generator on an island grid. Transmission lines run from the plant
switchyard to four substations:

| Substation | Demand |
| --- | --- |
| Millbrook (8 districts) | ~85 MW overnight, ~210 MW evening peak |
| Industrial Park | ~270 MW on weekday shifts (07:00–19:00), ~55 MW otherwise |
| Farmland | 30–55 MW |
| City tie-line | 290–420 MW, peaking mid-morning and evening |

Total demand runs from about 480 MW overnight to about 950 MW. Hot or cold weather adds more.

- **Short of power:** feeders are switched off in proportion at every substation, and Millbrook's
  districts go dark, windows and street lamps included. Which districts are dark rotates every 20
  game minutes. The full map (M) shades the dark districts.
- **Too much power:** grid frequency climbs. Above 61.2 Hz for 8 seconds, the generator breaker
  opens. If you were carrying more than 500 MW, that also trips the turbine and the reactor.
  Match output to demand with the governor valve.
- **No generation** (for example, at the game start): the whole region is dark until you
  synchronise.

The top bar shows served/demand and frequency. The Grid Dispatch console shows everything else.

With governor droop, the turbine automatically closes its valve as grid frequency rises. Losing a
whole substation's load holds the frequency near 61 Hz instead of tripping you off, which gives
you time to rebalance.

## Weather, faults and the field

**Weather** changes every few game hours: clear, cloudy, rain, thunderstorm, heatwave or cold
snap. It sets the air and river temperature (heat and cold raise demand, hot weather cuts cooling
capacity), the clouds and fog, and the rain. Thunderstorms throw about 10 lightning strikes per game
hour, and tall structures attract them.

**Faults** show up four ways: as a work order (bottom right, with distance and direction), a red
diamond on the minimap and map, a tile on the annunciator wall, and an amber flashing beacon on the
equipment itself. Most are fixed in person: walk up, look at the equipment, press **E**, and hold
your aim until the repair bar fills.

| Fault | Effect | Fix |
| --- | --- | --- |
| Substation breaker tripped (lightning) | That substation blacks out | Reset the breaker cabinet beside its control hut |
| Transmission line down (lightning) | Its substations limp along at half capacity | Dispatch a line crew from Grid Dispatch (~3.5 game hours) |
| River intake clogged (rain and storms make it worse) | Cooling capacity falls, then condenser vacuum, then the turbine trips | Clear the screens at the intake pier on the riverbank north-east of the plant |
| RCP bearing overheating (audible whine near containment) | Seizes the pump after ~4 game hours if ignored | Stop that pump from the control room, then service it at the containment access panel |
| Feed valve FW-3B stuck | Feedwater limited: steam generator level sags at high power | Free the valve in the turbine hall |
| Cooling tower fans failed | Two fans out, less cooling | Repair at the tower's base cabinet |
| Fuel pad radiation leak | Dose rate around the dry casks climbs | Reseal at the pad's monitor cabinet, and watch your dose |

**The utility truck** is parked in the plant car park. It does about 97 km/h on roads and 47 km/h
off them, crosses the bridge, and stops at the water's edge. Dirt service tracks lead to each
substation's gate.

**Dosimeter.** Radiation near the fuel pad, containment and turbine hall adds to your daily dose
(bottom left). At 50 mSv, health physics sends you off site for 8 hours of rest.

## Running the company (Director's Tablet)

The top bar shows your cash, public opinion, and who is minding the reactor ("You have the
controls", "AUTO · *operator*" or "Unattended").

| Tab | What's there |
| --- | --- |
| Overview | Cash, today's profit, loan, public opinion, reactor and grid status, **autopilot orders** (follow demand or hold a setpoint), next inspection, contracts |
| Finances | Cash chart, today's and yesterday's profit and loss, borrow or repay in $5M steps (9% a year) |
| Staff | Your roster (skill, wage, fatigue, what each person is doing), and applicants who change every game day |
| Work orders | Every open fault, with a button to send the right crew |
| Contracts | Active supply contracts with current delivery, and offers to sign |
| Regulator | The next inspection, failures so far, and every report with its findings |
| Log | Everything that has happened |

- **Money.** Customers without a contract pay the spot price, $40–75/MWh depending on demand. Costs
  are site overheads ($6k per game hour, even while shut down), wages, fuel ($8/MWh), repair parts,
  environmental fines (outfall over 28°C), contract penalties and loan interest. Seven days overdrawn
  means bankruptcy.
- **Staff.**
  - *Shift operators* follow demand with the governor and trim the rods while you're out of the
    reactor and turbine panels. They stand back while you work those panels, and they never restart a
    tripped reactor. They tire over a shift, and a rested colleague takes over automatically.
  - *Maintenance crews* fix plant equipment; *line crews* fix substations and power lines. Both drive
    out from the plant first, and higher skill works faster.
  - *Security* helps at inspections.
- **Contracts.** A fixed price and a signing bonus for promising to cover a share (95–98%) of a
  customer's demand. Every MWh short costs a penalty. Better public opinion gets better offers.
- **The regulator** (Office of Nuclear Safety) inspects every 2–4 game days, with 6 hours' notice,
  starting on day 2. Pass mark 70/100. The first failure is a fine; the second is a bigger fine plus a
  12-hour forced shutdown (the trip can't be reset); the third revokes your licence.
- **Public opinion** (0–100) falls with blackouts, reactor trips, radiation leaks, hot outfall water
  and failed inspections, and recovers slowly with reliable supply. Below 25, protesters gather at the
  plant gate; below 20, the council cancels its contract and won't offer a new one.

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
| O | Next weather |
| U | Inject the next fault type (for testing) |
| I | Inspectors arrive now |

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
  sim/          simulation (no rendering): clock, reactor, alarms, annunciator, trends, island grid, weather, faults,
                staff, autopilot, management (money, contracts, regulator, opinion), config
  world/        layout data, terrain, river, roads, buildings, town, countryside, grid structures, field equipment,
                truck model, sky, rain/lightning, collision
  player/       input, first-person controller, crosshair interaction, truck physics
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
