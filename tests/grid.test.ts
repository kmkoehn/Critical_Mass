import { describe, expect, it } from 'vitest';
import { GRID_CONFIG, Grid, SUBSTATIONS, isWeekend, regionalDemandMW } from '../src/sim/grid';
import { Reactor, createReactorState } from '../src/sim/reactor';
import { townDistrictAt } from '../src/world/layout';

const DT = 0.1;
const SCALE = 72;

/** Run the grid at a fixed game hour with a fixed supply. */
function run(grid: Grid, startHour: number, realSeconds: number, supply: number | ((t: number) => number)): number {
  let t = startHour * 3600;
  for (let i = 0; i < Math.round(realSeconds / DT); i++) {
    t += DT * SCALE;
    grid.step(DT, t, DT * SCALE, typeof supply === 'number' ? supply : supply(t), 18);
  }
  return t;
}

describe('regional demand', () => {
  it('stays between 450 and 1000 MW and peaks in the evening', () => {
    for (let h = 0; h < 24; h += 0.25) {
      const d = regionalDemandMW(h, 1);
      expect(d).toBeGreaterThan(450);
      expect(d).toBeLessThan(1000);
    }
    expect(regionalDemandMW(19.5, 1)).toBeGreaterThan(regionalDemandMW(3, 1) + 250);
  });

  it('drops industrial demand at weekends', () => {
    expect(isWeekend(1)).toBe(false);
    expect(isWeekend(6)).toBe(true);
    const ind = SUBSTATIONS.find((s) => s.id === 'industrial')!;
    expect(ind.demand(12, 1, 18)).toBeGreaterThan(ind.demand(12, 6, 18) + 150);
  });

  it('rises in hot and cold weather', () => {
    expect(regionalDemandMW(15, 1, 34)).toBeGreaterThan(regionalDemandMW(15, 1, 18) + 40);
    expect(regionalDemandMW(15, 1, -2)).toBeGreaterThan(regionalDemandMW(15, 1, 18) + 40);
  });
});

describe('island grid', () => {
  it('is dead with no generation: every feeder off', () => {
    const g = new Grid();
    run(g, 12, 1, 0);
    expect(g.state.dead).toBe(true);
    expect(g.state.frequency).toBe(0);
    for (let i = 0; i < 8; i++) expect(g.isFeederPowered('town', i)).toBe(false);
  });

  it('powers everything at 60 Hz when supply matches demand', () => {
    const g = new Grid();
    run(g, 12, 20, (t) => regionalDemandMW((t % 86400) / 3600, 1));
    expect(g.state.dead).toBe(false);
    expect(g.state.shedFraction).toBe(0);
    expect(Math.abs(g.state.frequency - 60)).toBeLessThan(0.1);
    for (let i = 0; i < 8; i++) expect(g.isFeederPowered('town', i)).toBe(true);
  });

  it('blacks out Millbrook districts in proportion to the shortfall', () => {
    const g = new Grid();
    const demand = regionalDemandMW(20, 1);
    run(g, 20, 5, demand * 0.7); // 30% short
    const off = g.state.subs.town.feedersOff.length;
    expect(off).toBeGreaterThanOrEqual(3);
    expect(off).toBeLessThanOrEqual(4);
    expect(g.state.servedMW).toBeLessThanOrEqual(demand * 0.7 + 1);
    expect(g.state.alarms).toContain('LOAD_SHED');
  });

  it('rotates which districts are dark', () => {
    const g = new Grid();
    const t = run(g, 20, 2, regionalDemandMW(20, 1) * 0.85);
    const first = [...g.state.subs.town.feedersOff];
    // Advance past one rotation period, holding a similar shortfall.
    run(g, t / 3600, (GRID_CONFIG.rotationPeriod / SCALE) + 2, (tt) => regionalDemandMW((tt % 86400) / 3600, 1) * 0.85);
    expect(g.state.subs.town.feedersOff.length).toBeGreaterThan(0);
    expect(g.state.subs.town.feedersOff).not.toEqual(first);
  });

  it('restores districts once supply recovers', () => {
    const g = new Grid();
    const t = run(g, 14, 3, regionalDemandMW(14, 1) * 0.6);
    expect(g.state.subs.town.feedersOff.length).toBeGreaterThan(0);
    run(g, t / 3600, 5, (tt) => regionalDemandMW((tt % 86400) / 3600, 1));
    expect(g.state.subs.town.feedersOff.length).toBe(0);
  });

  it('trips the generator after sustained over-frequency', () => {
    const g = new Grid();
    let tripped: string | null = null;
    let t = 2 * 3600;
    for (let i = 0; i < 200 && !tripped; i++) {
      t += DT * SCALE;
      tripped = g.step(DT, t, DT * SCALE, 1000, 18).generatorTrip; // ~1000 MW into ~520 MW at 2 am
    }
    expect(g.state.alarms).toContain('FREQ_HIGH');
    expect(tripped).toMatch(/over-frequency/);
  });

  it('governor droop rides through losing a substation without tripping', () => {
    const r = new Reactor(createReactorState('fullPower'));
    const g = new Grid();
    let t = 13 * 3600;
    const tick = () => {
      t += DT * SCALE;
      r.gridHz = g.state.dead ? 60 : g.state.frequency;
      r.step(DT, DT * SCALE);
      const res = g.step(DT, t, DT * SCALE, r.state.generatorSynced ? r.state.electricalOutputMW : 0, 18);
      if (res.generatorTrip) r.generatorTrip(res.generatorTrip);
    };
    // Settle with output matched to demand (one tick first so demand is known).
    tick();
    for (let i = 0; i < 300; i++) {
      r.setGovernorValve(r.state.governorValve * (1 + 0.3 * (g.state.demandMW - r.state.electricalOutputMW) / Math.max(g.state.demandMW, 100)));
      tick();
    }
    expect(r.state.generatorSynced).toBe(true);
    g.state.subs.city.breakerClosed = false; // lightning takes out ~300 MW of load
    for (let i = 0; i < 300; i++) tick();
    expect(r.state.generatorSynced).toBe(true);
    expect(g.state.frequency).toBeGreaterThan(60.2);
    expect(g.state.frequency).toBeLessThan(61.2);
  });

  it('a big load rejection from the grid trips the turbine and reactor', () => {
    const r = new Reactor(createReactorState('fullPower'));
    r.generatorTrip('grid over-frequency protection');
    expect(r.state.generatorSynced).toBe(false);
    expect(r.state.turbineTripped).toBe(true);
    expect(r.state.scram.active).toBe(true);
  });

  it('curtails flexible exports before blacking anyone out', () => {
    const g = new Grid();
    g.state.exportScale.city = 1; // tie-line expansion: city can take its base demand again as exports
    const firm = regionalDemandMW(20, 1);
    run(g, 20, 3, firm + 50); // enough for all firm load plus a little export
    expect(g.state.shedFraction).toBe(0);
    expect(g.state.exportCurtailed).toBeGreaterThan(0.5);
    for (let i = 0; i < 8; i++) expect(g.isFeederPowered('town', i)).toBe(true);
    run(g, 20, 3, firm * 0.7); // short even on firm load: now districts go dark
    expect(g.state.subs.town.feedersOff.length).toBeGreaterThan(0);
  });

  it('opening a substation breaker blacks out just that substation', () => {
    const g = new Grid();
    g.state.subs.industrial.breakerClosed = false;
    run(g, 12, 3, regionalDemandMW(12, 1));
    expect(g.isFeederPowered('industrial', 0)).toBe(false);
    expect(g.isFeederPowered('town', 0)).toBe(true);
    expect(g.state.alarms).toContain('SUB_OUT');
  });
});

describe('town districts', () => {
  it('maps the four blocks either side of Main Street to districts 0–7', () => {
    expect(townDistrictAt(-100, -50)).toBe(0);
    expect(townDistrictAt(0, -50)).toBe(1);
    expect(townDistrictAt(120, -50)).toBe(2);
    expect(townDistrictAt(250, -50)).toBe(3);
    expect(townDistrictAt(-100, 50)).toBe(4);
    expect(townDistrictAt(250, 200)).toBe(7);
  });
});
