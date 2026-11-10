import { describe, expect, it } from 'vitest';
import { Campaign, EXPANSION_GRANT, createCampaignState, type CampaignContext } from '../src/sim/campaign';
import { FaultManager, createFaultState } from '../src/sim/faults';
import { createGridState } from '../src/sim/grid';
import { createManagementState } from '../src/sim/management';
import { Reactor, createReactorState } from '../src/sim/reactor';
import { createStaffState } from '../src/sim/staff';
import { UNIT2, Unit2, createUnit2State } from '../src/sim/unit2';
import { Upgrades } from '../src/sim/upgrades';
import { createWeatherState } from '../src/sim/weather';
import { PLANT_LAYOUT, TOWN_SQUARE } from '../src/world/layout';

/** A campaign context built from real (fresh) model states that tests can poke. */
function ctx(over: Partial<CampaignContext> = {}): CampaignContext {
  const cr = PLANT_LAYOUT.controlRoom;
  return {
    t: 8 * 3600,
    player: { x: -345, y: 8, z: 12, insideControlRoom: false, lookoutDeckY: 150 },
    reactor: createReactorState('cold'),
    grid: createGridState(),
    staff: createStaffState(),
    mgmt: createManagementState(),
    upgrades: { builds: {} },
    unit2: createUnit2State(),
    weather: createWeatherState(),
    ...over,
    ...(over.player ? {} : { player: { x: -345, y: 8, z: 12, insideControlRoom: false, lookoutDeckY: 150 } }),
  } as CampaignContext & { _cr?: typeof cr };
}

describe('upgrades', () => {
  it('are gated by act, prerequisites and cash, then build over game hours', () => {
    const u = new Upgrades();
    expect(u.blocker('turbineRetrofit', 1e9, 1)).toMatch(/Act 2/);
    expect(u.blocker('turbineRetrofit', 1, 2)).toMatch(/cash/);
    expect(u.blocker('unit2', 1e9, 3)).toMatch(/Third cooling tower/);
    expect(u.blocker('coolingTower3', 1e9, 2)).toBeNull();
    u.start('coolingTower3', 0);
    expect(u.blocker('coolingTower3', 1e9, 2)).toMatch(/construction/);
    expect(u.progress('coolingTower3', 24 * 3600)).toBeCloseTo(0.5);
    expect(u.step(47 * 3600)).toEqual([]);
    expect(u.step(48 * 3600)).toEqual(['coolingTower3']);
    expect(u.has('coolingTower3')).toBe(true);
    expect(u.blocker('unit2', 1e9, 3)).toBeNull();
  });

  it('the turbine retrofit makes about 6% more electricity', () => {
    const a = new Reactor(createReactorState('fullPower'));
    const b = new Reactor(createReactorState('fullPower'));
    b.mods.efficiency = 1.06;
    for (let i = 0; i < 20; i++) {
      a.step(0.1, 7.2);
      b.step(0.1, 7.2);
    }
    expect(b.state.electricalOutputMW / a.state.electricalOutputMW).toBeGreaterThan(1.05);
  });

  it('storm-hardened lines suffer far less lightning damage', () => {
    const count = (hardened: boolean) => {
      const f = new FaultManager(createFaultState(9));
      f.state.randomFailures = false;
      f.stormHardened = hardened;
      const r = new Reactor(createReactorState('fullPower'));
      let hits = 0;
      for (let i = 0; i < 2000; i++) {
        const before = f.state.faults.length;
        f.step(i * 36, 36, 'thunderstorm', 1, r);
        if (f.state.faults.length > before) hits++;
        f.state.faults = f.state.faults.filter((x) => x.kind === 'intakeClog');
      }
      return hits;
    };
    expect(count(true)).toBeLessThan(count(false) * 0.5);
  });
});

describe('Unit 2', () => {
  it('commissions, ramps to its setpoint and leaves Unit 1 some load', () => {
    const u = new Unit2();
    u.complete(0);
    u.step(3600, 3600, 900, true);
    expect(u.state.outputMW).toBe(0); // still commissioning
    let t = UNIT2.commissionHours * 3600;
    for (let i = 0; i < 100; i++) u.step((t += 360), 360, 1200, true);
    expect(u.state.outputMW).toBeCloseTo(500, 0); // default setpoint
    for (let i = 0; i < 100; i++) u.step((t += 360), 360, 600, true);
    expect(u.state.outputMW).toBeCloseTo(450, 0); // demand 600 − 150 left for Unit 1
  });

  it('follows demand alone when Unit 1 is off-line, and restarts after a trip', () => {
    const u = new Unit2(createUnit2State());
    u.complete(0);
    let t = UNIT2.commissionHours * 3600;
    for (let i = 0; i < 100; i++) u.step((t += 360), 360, 800, false);
    expect(u.state.outputMW).toBeCloseTo(800, 0);
    u.trip(t);
    expect(u.state.outputMW).toBe(0);
    u.step(t + 3600, 3600, 800, false);
    expect(u.state.outputMW).toBe(0);
    for (let i = 0; i < 100; i++) u.step((t += 360), 360, 800, false);
    expect(u.state.outputMW).toBeGreaterThan(700);
  });
});

describe('campaign', () => {
  it('Act 1 ticks off in order and ends with Millbrook lit', () => {
    const c = new Campaign(createCampaignState());
    const x = ctx();
    // Pumps running before you even reach the control room don't count yet: objectives are ordered.
    x.reactor.coolantPumps.forEach((p) => (p.speed = 1));
    c.step(x);
    expect(c.state.done).toEqual([]);
    const cr = PLANT_LAYOUT.controlRoom;
    x.player = { x: cr.cx, y: 8, z: cr.cz, insideControlRoom: true, lookoutDeckY: 150 };
    c.step(x);
    expect(c.state.done).toEqual(['walk', 'pumps']);
    Object.assign(x.reactor, { neutronFlux: 1e-3, startupRate: 0.8, coolantTemp: 285, turbineRPM: 3600, generatorSynced: true });
    x.grid.dead = false;
    x.grid.subs.town.feedersOff = [];
    for (let i = 0; i < 6; i++) c.step(x);
    expect(c.state.act).toBe(2);
    expect(c.current()?.text).toMatch(/shift operator/);
  });

  it('Act 2 schedules a storm and brings the first inspection forward', () => {
    const c = new Campaign({ ...createCampaignState(), act: 2, actStartedAt: 100 });
    const x = ctx({ t: 100 });
    // Starting the act is what schedules things, so jump in via the end of Act 1.
    const c1 = new Campaign({ ...createCampaignState(), done: ['walk', 'pumps', 'critical', 'heat', 'speed', 'sync'] });
    Object.assign(x.reactor, { generatorSynced: true });
    x.grid.dead = false;
    x.grid.subs.town.feedersOff = [];
    const r = c1.step(x);
    expect(c1.state.act).toBe(2);
    expect(r.actions.pullInspectionTo).toBe(x.t + 12 * 3600);
    const later = c1.step({ ...x, t: x.t + 5 * 3600 + 1 });
    expect(later.actions.forceWeather?.kind).toBe('thunderstorm');
    expect(c.state.act).toBe(2);
  });

  it('Act 3 opens with an expansion grant', () => {
    const c = new Campaign({ ...createCampaignState(), act: 2, actStartedAt: 0, done: ['hireOp', 'hireCrew', 'industry', 'storm', 'inspection'] });
    const x = ctx({ t: 3 * 86400 });
    x.mgmt.history.push({ day: 2, ledger: { ...x.mgmt.today, sales: 1e6 } } as (typeof x.mgmt.history)[number]);
    const r = c.step(x);
    expect(c.state.act).toBe(3);
    expect(r.actions.grant).toBe(EXPANSION_GRANT);
  });

  it('Act 3 heatwave: holding 97% wins; falling short reschedules it', () => {
    const make = () => {
      const c = new Campaign({ ...createCampaignState(), act: 3, actStartedAt: 0, done: ['upgrades', 'tieLine', 'unit2', 'city'] });
      const x = ctx({ t: 1000 });
      x.unit2.built = true;
      x.unit2.outputMW = 400;
      x.upgrades.builds.tieLine = { started: 0, done: 1, complete: true };
      return { c, x };
    };
    // Success.
    let { c, x } = make();
    c.step(x); // forecast
    const r1 = c.step({ ...x, t: x.t + 6 * 3600 + 1 }); // arrives
    expect(r1.actions.forceWeather).toEqual({ kind: 'heatwave', hours: 24 });
    x.grid.stats.firmServedMWh += 20000;
    x.grid.stats.firmUnservedMWh += 200; // 99%
    const end = c.step({ ...x, t: x.t + 31 * 3600 });
    expect(end.events.some((e) => /heatwave has broken/.test(e.text))).toBe(true);
    expect(end.actions.win).toBe(true);
    expect(c.state.won).toBe(true);
    expect(c.state.act).toBe(4);
    // Failure.
    ({ c, x } = make());
    c.step(x);
    c.step({ ...x, t: x.t + 6 * 3600 + 1 });
    x.grid.stats.firmServedMWh += 10000;
    x.grid.stats.firmUnservedMWh += 2000; // 83%
    c.step({ ...x, t: x.t + 31 * 3600 });
    expect(c.state.won).toBe(false);
    expect(c.state.script.heatwaveFailures).toBe(1);
    expect(c.state.script.heatwaveAt).toBeGreaterThan(x.t + 31 * 3600);
  });

  it('ends the game on meltdown, bankruptcy or a revoked licence', () => {
    for (const [mut, kind] of [
      [(x: CampaignContext) => { x.reactor.meltdown = true; }, 'meltdown'],
      [(x: CampaignContext) => { x.mgmt.bankrupt = true; }, 'bankrupt'],
      [(x: CampaignContext) => { x.mgmt.regulator.licenseRevoked = true; }, 'licence'],
    ] as const) {
      const c = new Campaign();
      const x = ctx();
      mut(x);
      c.step(x);
      expect(c.state.gameOver?.kind).toBe(kind);
    }
  });

  it('unlocks fast travel by visiting, and achievements', () => {
    const c = new Campaign();
    const x = ctx();
    x.player = { x: TOWN_SQUARE.x, y: 8, z: TOWN_SQUARE.z, insideControlRoom: false, lookoutDeckY: 150 };
    const r = c.step(x);
    expect(c.state.visited).toContain('town');
    expect(r.events.some((e) => /Fast travel unlocked/.test(e.text))).toBe(true);
    x.mgmt.cash = 60_000_000;
    c.step(x);
    expect(c.state.achievements).toContain('tycoon');
  });

  it('grows demand daily in the sandbox', () => {
    const c = new Campaign({ ...createCampaignState(), act: 4 });
    const r = c.step(ctx({ t: 5 * 86400 + 10 }));
    expect(r.actions.demandGrowth).toBeCloseTo(1.02);
    expect(c.step(ctx({ t: 5 * 86400 + 20 })).actions.demandGrowth).toBeUndefined();
  });
});
