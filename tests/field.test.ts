import { describe, expect, it } from 'vitest';
import { Weather, createWeatherState } from '../src/sim/weather';
import { CREW_TIMES, FaultManager, createFaultState } from '../src/sim/faults';
import { Grid, regionalDemandMW } from '../src/sim/grid';
import { Reactor, createReactorState } from '../src/sim/reactor';
import { Vehicle } from '../src/player/vehicle';
import { CollisionWorld } from '../src/world/collision';
import { Heightfield } from '../src/world/heightfield';
import { BRIDGE, TOWN, riverX } from '../src/world/layout';

const DT = 0.1;
const SCALE = 72;
const hf = new Heightfield();

describe('weather', () => {
  it('is deterministic for a seed and cycles through several kinds', () => {
    const a = new Weather(createWeatherState(5));
    const b = new Weather(createWeatherState(5));
    const seen = new Set<string>();
    let t = 8 * 3600;
    for (let i = 0; i < 20000; i++) {
      t += 30;
      a.step(t, 30);
      b.step(t, 30);
      seen.add(a.state.kind);
    }
    expect(a.state).toEqual(b.state);
    expect(seen.size).toBeGreaterThanOrEqual(4);
  });

  it('makes heatwaves hot, cold snaps cold, and storms throw lightning', () => {
    const w = new Weather(createWeatherState(9));
    let t = 12 * 3600;
    w.force('heatwave', t);
    for (let i = 0; i < 400; i++) w.step((t += 30), 30);
    expect(w.state.ambientTemp).toBeGreaterThan(26);
    w.force('coldsnap', t);
    for (let i = 0; i < 600; i++) w.step((t += 30), 30);
    expect(w.state.ambientTemp).toBeLessThan(5);
    w.force('thunderstorm', t);
    let strikes = 0;
    for (let i = 0; i < 120; i++) strikes += w.step((t += 30), 30).strikes;
    expect(strikes).toBeGreaterThan(5);
  });
});

describe('faults', () => {
  function setup() {
    const reactor = new Reactor(createReactorState('fullPower'));
    const grid = new Grid();
    const faults = new FaultManager(createFaultState(1));
    faults.state.randomFailures = false;
    return { reactor, grid, faults };
  }

  it('a tripped substation breaker blacks it out until reset in the field', () => {
    const { reactor, grid, faults } = setup();
    faults.inject('substationTrip', 'town', 0);
    faults.apply(reactor, grid);
    grid.step(DT, 12 * 3600, 7.2, regionalDemandMW(12), 18);
    expect(grid.isFeederPowered('town', 0)).toBe(false);
    expect(faults.alarms).toEqual([]);
    expect(grid.state.alarms).toContain('SUB_OUT');
    const f = faults.state.faults[0];
    expect(faults.repair(f.id, 100, reactor)).toBeNull();
    faults.apply(reactor, grid);
    grid.step(DT, 12 * 3600 + 7.2, 7.2, regionalDemandMW(12), 18);
    expect(grid.state.subs.town.breakerClosed).toBe(true);
  });

  it('lightning in a long storm trips substation breakers and logs it', () => {
    const { reactor, faults } = setup();
    let t = 0;
    let trips = 0;
    for (let i = 0; i < 400; i++) {
      t += 36;
      const r = faults.step(t, 36, 'thunderstorm', 1, reactor); // one strike per step
      if (r.events.some((e) => /breaker tripped/.test(e.text))) trips++;
    }
    expect(trips).toBeGreaterThan(0);
    expect(faults.state.log.some((e) => /Lightning struck/.test(e.text))).toBe(true);
  });

  it('an ignored RCP bearing seizes the pump; repair needs the pump stopped', () => {
    const { reactor, grid, faults } = setup();
    faults.inject('rcpBearing', '2', 0);
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t += 72;
      faults.step(t, 72, 'clear', 0, reactor);
      faults.apply(reactor, grid);
      reactor.step(1, 72);
    }
    expect(reactor.state.coolantPumps[2].failed).toBe(true);
    expect(reactor.state.coolantPumps[2].on).toBe(false);
    const f = faults.state.faults.find((x) => x.kind === 'rcpBearing')!;
    expect(faults.repair(f.id, t, reactor)).toBeNull(); // pump already stopped (seized)
    expect(reactor.state.coolantPumps[2].failed).toBe(false);
  });

  it('refuses to service a bearing while the pump runs', () => {
    const { reactor, faults } = setup();
    const f = faults.inject('rcpBearing', '0', 0)!;
    expect(faults.repair(f.id, 1, reactor)).toMatch(/Stop RCP 1/);
  });

  it('a clogged intake cuts cooling capacity, worse in the rain', () => {
    const { reactor, grid, faults } = setup();
    const before = reactor.state.coolingCapacityMW;
    faults.inject('intakeClog', 'intake', 0);
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t += 72;
      faults.step(t, 72, 'rain', 0, reactor);
      faults.apply(reactor, grid);
      reactor.step(0.1, 72);
    }
    expect(reactor.state.plantFaults.intakeClog).toBeGreaterThan(0.4);
    expect(reactor.state.coolingCapacityMW).toBeLessThan(before * 0.75);
  });

  it('a downed line halves its substations until a crew repairs it', () => {
    const { reactor, grid, faults } = setup();
    const f = faults.inject('lineDown', 'industrial', 0)!;
    faults.apply(reactor, grid);
    let t = 12 * 3600;
    grid.step(DT, t, 7.2, regionalDemandMW(12), 18);
    expect(grid.state.subs.industrial.feedersOff.length).toBe(2);
    expect(faults.dispatchCrew(f.id, t)).toBe(true);
    for (let i = 0; i < (CREW_TIMES.travel + CREW_TIMES.repair) / 72 + 5; i++) {
      t += 72;
      faults.step(t, 72, 'clear', 0, reactor);
    }
    expect(faults.has('lineDown')).toBe(false);
  });

  it('broken tower fans and a stuck feed valve reach the plant model', () => {
    const { reactor, grid, faults } = setup();
    faults.inject('towerFan', '1', 0);
    faults.inject('feedValve', 'fw3b', 0);
    faults.apply(reactor, grid);
    expect(reactor.state.plantFaults.towerFansBroken).toBe(2);
    expect(reactor.state.plantFaults.feedValveStuck).toBe(true);
    // At full power the stuck valve starves the steam generators: level sinks well below normal
    // (alarm), aux feed cuts in, and output sags.
    const mwe0 = reactor.state.electricalOutputMW;
    for (let i = 0; i < 3000; i++) reactor.step(DT, DT * SCALE);
    expect(reactor.state.steamGeneratorLevel).toBeLessThan(30);
    expect(reactor.state.alarms).toContain('SG_LEVEL');
    expect(reactor.state.electricalOutputMW).toBeLessThan(mwe0);
  });

  it('cutting load to 70% rides through a stuck feed valve', () => {
    const { reactor, grid, faults } = setup();
    faults.inject('feedValve', 'fw3b', 0);
    faults.apply(reactor, grid);
    reactor.setGovernorValve(reactor.state.governorValve * 0.7);
    for (let i = 0; i < 3000; i++) reactor.step(DT, DT * SCALE);
    expect(reactor.state.scram.active).toBe(false);
  });

  it('is deterministic for a seed', () => {
    const runOnce = () => {
      const { reactor, faults } = setup();
      faults.state.randomFailures = true;
      let t = 0;
      for (let i = 0; i < 2000; i++) faults.step((t += 72), 72, i % 300 < 50 ? 'thunderstorm' : 'clear', i % 7 === 0 ? 1 : 0, reactor);
      return faults.state;
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

describe('utility truck', () => {
  const road = () => true;

  it('drives forward along Main Street and stays on the ground', () => {
    const v = new Vehicle(hf, new CollisionWorld(), road, TOWN.cx - 100, 0, -Math.PI / 2); // facing east
    for (let i = 0; i < 300; i++) v.update(1 / 60, { throttle: 1, steer: 0, handbrake: false });
    expect(v.x).toBeGreaterThan(TOWN.cx - 100 + 30);
    expect(Math.abs(v.z)).toBeLessThan(1);
    expect(Math.abs(v.y - hf.heightAt(v.x, v.z))).toBeLessThan(0.5);
  });

  it('turns right when steering right', () => {
    const v = new Vehicle(hf, new CollisionWorld(), road, TOWN.cx, TOWN.cz, 0); // facing north
    for (let i = 0; i < 240; i++) v.update(1 / 60, { throttle: 1, steer: 1, handbrake: false });
    expect(v.x).toBeGreaterThan(TOWN.cx + 2); // north + right turn = east
  });

  it('stops at the river instead of driving in', () => {
    const z = -400;
    const v = new Vehicle(hf, new CollisionWorld(), road, riverX(z) - 70, z, -Math.PI / 2);
    for (let i = 0; i < 900; i++) v.update(1 / 60, { throttle: 1, steer: 0, handbrake: false });
    expect(hf.heightAt(v.x, v.z)).toBeGreaterThan(-0.8);
    expect(v.x).toBeLessThan(riverX(z));
  });

  it('crosses the bridge deck', () => {
    const col = new CollisionWorld();
    col.addBox(BRIDGE.x0, BRIDGE.deckTop - 1.2, BRIDGE.z - BRIDGE.halfWidth, BRIDGE.x1, BRIDGE.deckTop, BRIDGE.z + BRIDGE.halfWidth);
    const v = new Vehicle(hf, col, road, BRIDGE.x0 - 20, 0, -Math.PI / 2);
    for (let i = 0; i < 900 && v.x < BRIDGE.x1 + 10; i++) v.update(1 / 60, { throttle: 1, steer: 0, handbrake: false });
    expect(v.x).toBeGreaterThan(BRIDGE.x1);
  });
});
