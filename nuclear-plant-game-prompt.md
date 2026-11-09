# Build Prompt: "Critical Mass" — An Open-World Nuclear Power Plant Management Game

> Paste everything below this line into Claude Code (or another coding agent), run from an empty project folder.

---

You are building an original, playable 3D game in which the player runs a nuclear power plant inside a small open world they can freely explore on foot and by vehicle. Build it in playable increments, run it after every milestone, and fix what you find before moving on.

## 1. Tech stack (use these unless told otherwise)

- **Runtime:** Browser game. **Three.js** for 3D rendering, **Vite** for dev server and build, plain **TypeScript** (no React for the game view; a light DOM/CSS layer for the HUD and panels is fine).
- **Physics/collision:** Simple custom capsule-vs-AABB collision plus a heightmap ground query is fine. Bring in `cannon-es` or `rapier3d-compat` only if vehicles need it.
- **Assets:** No external art. Build everything from procedural geometry (boxes, cylinders, lathe shapes for cooling towers), simple materials, and procedural textures. Sounds come from the Web Audio API (hums, alarms, clicks, Geiger ticks).
- **Saving:** `localStorage` with a versioned JSON save format.
- **Structure:**
  ```
  src/
    main.ts            // bootstrap, game loop (fixed-step sim + variable render)
    world/             // terrain, roads, buildings, town, water, weather, day/night
    player/            // first-person controller, interaction raycast, vehicle
    sim/               // reactor, turbine, grid, economy, staff, events (NO rendering code)
    ui/                // HUD, control-room panels, menus, notifications
    save/              // serialize/deserialize, migrations
  ```
- Keep the simulation (`sim/`) completely separate from rendering, so it can be unit-tested and run headless. Add **Vitest** tests for the reactor model.

## 2. Game vision

The player is the newly hired plant director of a decommissioned-then-revived nuclear station on the edge of a river valley. The goal is to bring the reactor online, supply reliable power to the region, grow the plant, and keep the nearby town safe and on your side. It's a management sim you experience physically: you walk to the control room to pull rods, drive out to a substation to repair a breaker, check the river intake after a storm, and visit town hall to deal with public opinion.

Tone: grounded and a little tense, not grimdark. Meltdowns are a failure state shown with alarms, evacuation sirens, and a final report screen. No graphic content.

## 3. The open world

A single seamless map of about **2 km × 2 km**, with a heightmap terrain and these zones:

1. **Plant campus** (center-left, by the river)
   - Reactor containment building (domed), turbine hall, control room building, two hyperboloid cooling towers with animated steam plumes, switchyard, spent-fuel storage pad, admin office, parking lot, security gate.
   - Walkable interiors at least for the **control room** and **turbine hall**.
2. **River and intake/outfall:** water plane with flow, intake structure (can clog with debris), outfall where water temperature matters (environmental fines when it's too hot).
3. **Town of Millbrook** (across the bridge): about 20 to 40 procedural buildings, town hall, a school, houses whose windows light up when they have power and go dark during blackouts. Simple NPCs walk the streets.
4. **Power grid:** transmission towers with sagging cable lines running from the switchyard to 3 to 4 **substations** spread around the map (town, industrial park, farmland, a distant city tie-line at the map edge).
5. **Industrial park:** a big power customer whose demand spikes during work hours.
6. **Countryside:** farms, forest, a hill with a lookout over the whole valley, dirt roads.

World systems:
- **Day/night cycle** (1 in-game day = 20 real minutes by default, adjustable), sun/moon lighting, street lights.
- **Weather:** clear, rain, thunderstorm (lightning can trip grid lines), heatwave (raises cooling water temperature and power demand), cold snap (raises demand).
- **Fast travel** between unlocked locations, plus a drivable **utility truck** for getting around normally.
- A **minimap** and a full-screen **map** (M) showing zones, substations, active faults, and quest markers.

## 4. Player and controls

- First-person controller: WASD, mouse look (pointer lock), Shift sprint, Space jump, C crouch.
- **E** to interact with whatever the crosshair is on (valves, breakers, panels, doors, vehicle, NPCs). Show an on-screen prompt such as "[E] Open Valve 3B".
- **Tab** opens the **Director's Tablet**, a remote management UI (finances, staff, contracts, research, event log). Direct reactor control is **not** allowed from the tablet: the player has to be in the control room or delegate to a hired shift operator.
- Truck: E to enter or exit, WASD to drive, simple arcade handling.
- Pause menu: resume, settings (mouse sensitivity, time scale, graphics quality), save, load, quit to title.

## 5. Reactor and plant simulation (the heart of the game)

Model a simplified **pressurized water reactor**. It should feel plausible and readable, not be a physics-grade simulator. It runs at a fixed timestep (e.g. 10 Hz) inside `sim/`.

State variables (at minimum):
- `controlRodInsertion` (0 to 100%), `reactivity`, `neutronFlux` / `thermalPower` (MWt)
- `coreTemp`, `coolantTemp`, `primaryPressure`, `coolantFlow` (driven by up to 4 reactor coolant pumps)
- `xenonLevel` (builds up after power drops and makes restarting harder; this is the "trap" a skilled player learns to manage)
- `decayHeat` (persists after shutdown, so cooling still matters when the reactor is off)
- `steamGeneratorLevel`, `turbineRPM`, `electricalOutput` (MWe), `condenserVacuum`, `coolingWaterTemp` (from river and towers)
- `fuelBurnup` (fuel depletes over in-game weeks and needs a refueling outage)
- `radiationLevels` per zone

Behavior:
- Rod position and xenon set reactivity. Reactivity drives power, power drives temperature, and temperature feeds back negatively (stabilizing). Lose coolant flow or cooling water and temperature rises fast.
- **Automatic safety system (SCRAM):** trips when thresholds are exceeded (high flux, high pressure, low flow, high core temp). The player can also SCRAM manually with a big red button. After a SCRAM, xenon and decay heat make the restart a real challenge.
- Escalation: warnings, then alarms, then SCRAM. If the player keeps forcing things (bypassing safeties, which needs a deliberate key-turn interaction), the chain goes core damage, partial meltdown, game over.
- **Turbine and grid:** the player matches output to **grid demand**, which changes with time of day, weather, and the industrial park schedule. Under-supply causes rolling blackouts in town (windows go dark, opinion drops). Over-supply wastes money and can trip grid frequency protection.

## 6. Control room

A walkable 3D room with interactable panels, each opening a focused 2D overlay (DOM/canvas) when used:
- **Reactor panel:** rod bank sliders, flux/power gauges, reactivity meter, SCRAM button, safety-bypass keyswitch.
- **Primary loop panel:** pump on/off switches, flow, pressure, pressurizer heaters/sprays.
- **Turbine & grid panel:** governor valve, turbine RPM, sync-to-grid button (only works when frequency matches), demand vs. output chart.
- **Cooling panel:** cooling tower fans, river intake pumps, outfall temperature.
- **Annunciator wall:** a grid of alarm tiles that light up and flash, with acknowledge/silence buttons.
- **Trend recorder:** live line charts for the last 10 in-game minutes of key values.

The big control-room screens should also be visible in the 3D world (render a canvas texture onto the in-world monitors).

## 7. Field operations (why the open world matters)

Equipment out in the world degrades and breaks, and many faults have to be fixed **in person** or by sending a hired crew (who take time to travel there):
- Stuck valves in the turbine hall, pump bearing overheating (audible whine), cooling tower fan failure.
- River intake clogged by debris after storms. Walk to it and clear it.
- Lightning trips a substation breaker. Drive there and reset it, and the town reconnects.
- Transmission line down: dispatch a line crew, and the power flow reroutes in the meantime.
- Radiation leak at the spent-fuel pad: wear a dosimeter (HUD shows dose; too much dose forces the player to rest).

Each fault shows up as a map marker, an event-log entry, and an annunciator tile. Some faults get worse if ignored.

## 8. Management layer (Director's Tablet)

- **Finances:** revenue from electricity sold (price varies by demand), costs for staff, fuel, maintenance, fines, loans. Show a daily P&L and a balance graph.
- **Staff:** hire and assign shift operators (who can run the reactor on autopilot to hold a set point, with skill-based reliability), maintenance crews, line crews, and security. Staff have skill, fatigue, and wages.
- **Contracts:** sign supply contracts with the town, the industrial park, and the city tie-line. Missing a contracted supply costs penalties.
- **Upgrades / research tree:** better turbines, an extra cooling tower, a backup diesel generator, automated rod control, storm-hardened lines, a visitor center (boosts opinion), and eventually a **second reactor unit** (unlocks a new build site on the campus that physically constructs itself over time).
- **Regulator inspections:** random visits that score safety practices. Failing one leads to fines, then forced shutdown.
- **Public opinion (0 to 100):** affected by blackouts, incidents, outfall temperature, the visitor center, and town events. Very low opinion triggers protests at the gate and contract cancellations.

## 9. Progression and objectives

- **Tutorial / Act 1 – "Cold Start":** guided first startup. Walk to the control room, start pumps, withdraw rods slowly, reach criticality, heat up, sync the turbine to the grid, and power the town. Each step is a clear on-screen objective with world markers.
- **Act 2 – "Keeping the Lights On":** contracts with the industrial park, the first storm, the first inspection, hiring staff.
- **Act 3 – "Expansion":** fund and build Unit 2 and the city tie-line, survive a heatwave crisis.
- After the acts: **sandbox mode** with scaling demand and random events.
- **Win conditions:** reach the Act 3 goals. Optional achievements, for example "30 days without a SCRAM" or "Never caused a blackout".
- **Lose conditions:** meltdown, bankruptcy (negative balance for 7 days), or license revoked (three failed inspections).

## 10. HUD and feedback

- Top bar: in-game time/date, weather, cash, public opinion, reactor status pill (OFFLINE / CRITICAL / AT POWER / SCRAMMED / ALARM).
- Bottom-left: minimap. Bottom-right: current objective. Toast notifications for events.
- Audio: low reactor hum that scales with power, turbine whine, distinct alarm tones per severity, Geiger clicks near radiation, rain/thunder, town ambience.
- Visual feedback: cooling-tower steam scales with output, town lights reflect grid state, warning beacons on plant buildings during alarms, a heat shimmer over the outfall when it runs hot.

## 11. Build milestones (do these in order; each must be playable)

1. **Walkable world skeleton:** terrain, river, plant campus blockout, town blockout, roads, first-person controller with collision, day/night, minimap. *Done when:* you can walk from the plant across the bridge into town and up the lookout hill at a steady 60 fps.
2. **Reactor sim core (headless):** implement `sim/` with Vitest tests covering stable operation at power, the negative temperature feedback, SCRAM triggers, xenon buildup after a power drop, and decay heat after shutdown. *Done when:* tests pass and a debug overlay shows live sim values in-game.
3. **Control room:** interactive panels, annunciators, trend charts, in-world monitor screens. *Done when:* a player can do a full cold start to grid sync by hand.
4. **Grid and town:** demand curve, substations, transmission lines, town windows reacting to supply, blackouts. *Done when:* under-producing visibly darkens the town.
5. **Field faults and truck:** fault/event system, interactable field equipment, drivable truck, map markers. *Done when:* a storm can trip a substation that you drive to and reset.
6. **Management layer:** tablet UI, finances, staff, contracts, inspections, public opinion.
7. **Progression:** tutorial and acts, objectives, win/lose screens, upgrade tree, Unit 2 construction.
8. **Polish:** audio pass, weather visuals, steam particles, save/load, settings, title screen, performance pass (instancing for town buildings and towers, LOD, frustum culling).

After each milestone: run `npm run dev`, play-test the new feature in a browser, check the console for errors, run tests, and briefly summarize what works and what's next.

## 12. Quality bar

- Stable 60 fps on a mid-range laptop at default settings.
- No console errors during normal play.
- The sim is deterministic for a given seed and inputs (it helps with testing and saves).
- All tunable numbers (thresholds, rates, prices, wages) live in one `sim/config.ts` file.
- Write a `README.md` with controls, how to run, how to build (`npm run build`), and a short "how the reactor works" player guide.
- The game must be fully original: original name, setting, characters, and visuals. Don't copy or imitate any existing game.

Start with Milestone 1 now.
