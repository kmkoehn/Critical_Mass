import { describe, expect, it } from 'vitest';
import { Annunciator } from '../src/sim/annunciator';
import { gridDemandMW } from '../src/sim/grid';
import { TrendRecorder, TREND_INTERVAL_S } from '../src/sim/history';
import { Reactor, createReactorState } from '../src/sim/reactor';

describe('annunciator sequence', () => {
  it('alerts, acknowledges, clears and resets', () => {
    const a = new Annunciator();
    expect(a.update(['HI_PRESS'])).toEqual(['HI_PRESS']);
    expect(a.state.tiles.HI_PRESS).toBe('alerting');
    expect(a.hornOn).toBe(true);
    a.acknowledge(['HI_PRESS']);
    expect(a.state.tiles.HI_PRESS).toBe('acked');
    expect(a.hornOn).toBe(false);
    a.update([]);
    expect(a.state.tiles.HI_PRESS).toBe('clearing');
    a.reset();
    expect(a.state.tiles.HI_PRESS).toBe('off');
  });

  it('locks in a fleeting alarm until acknowledged', () => {
    const a = new Annunciator();
    a.update(['LO_FLOW']);
    a.update([]);
    expect(a.state.tiles.LO_FLOW).toBe('alerting');
    a.acknowledge([]);
    expect(a.state.tiles.LO_FLOW).toBe('off');
  });

  it('silence stops the horn until a new alarm arrives', () => {
    const a = new Annunciator();
    a.update(['HI_PRESS']);
    a.silence();
    expect(a.hornOn).toBe(false);
    a.update(['HI_PRESS', 'LO_FLOW']);
    expect(a.hornOn).toBe(true);
  });
});

describe('grid demand', () => {
  it('peaks in the evening and bottoms out overnight', () => {
    expect(gridDemandMW(19.5)).toBeGreaterThan(gridDemandMW(3) + 200);
    for (let h = 0; h < 24; h += 0.5) {
      expect(gridDemandMW(h)).toBeGreaterThan(400);
      expect(gridDemandMW(h)).toBeLessThan(1000);
    }
  });
});

describe('trend recorder', () => {
  it('samples on the game clock and returns a time window', () => {
    const rec = new TrendRecorder();
    const s = createReactorState('fullPower');
    for (let t = 0; t <= 3600; t += 5) rec.record(t, s, 700);
    expect(rec.samples.length).toBe(Math.floor(3600 / TREND_INTERVAL_S) + 1);
    const last10 = rec.window(3600, 600);
    expect(last10.length).toBeGreaterThan(35);
    expect(last10[0].t).toBeGreaterThanOrEqual(3000);
  });
});

describe('manual pressurizer and rod hold', () => {
  it('raises pressure with heaters and lowers it with spray', () => {
    const r = new Reactor(createReactorState('fullPower'));
    r.setPressurizerManual(true, false);
    for (let i = 0; i < 100; i++) r.step(0.1, 7.2);
    expect(r.state.primaryPressure).toBeGreaterThan(15.6);
    r.setPressurizerManual(false, true);
    for (let i = 0; i < 100; i++) r.step(0.1, 7.2);
    expect(r.state.primaryPressure).toBeLessThan(15.5);
  });

  it('holds rods where they are', () => {
    const r = new Reactor(createReactorState('cold'));
    r.setRodTarget('all', 50);
    for (let i = 0; i < 50; i++) r.step(0.1, 7.2);
    r.holdRods();
    const at = r.state.rodBanks[0];
    for (let i = 0; i < 50; i++) r.step(0.1, 7.2);
    expect(Math.abs(r.state.rodBanks[0] - at)).toBeLessThan(0.1);
  });
});
