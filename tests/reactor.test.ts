import { describe, expect, it } from 'vitest';
import { SIM_CONFIG } from '../src/sim/config';
import { Reactor, computeReactivity, createReactorState, reactorStatus } from '../src/sim/reactor';

/** Game seconds per real second (20-minute days). */
const GAME_SCALE = 72;
const DT = 0.1;

function run(r: Reactor, realSeconds: number, scale = GAME_SCALE): void {
  const n = Math.round(realSeconds / DT);
  for (let i = 0; i < n; i++) r.step(DT, DT * scale);
}

function fullPower(): Reactor {
  return new Reactor(createReactorState('fullPower'));
}

describe('steady operation at power', () => {
  it('holds full power steadily without tripping', () => {
    const r = fullPower();
    const start = { ...r.state };
    run(r, 120);
    const s = r.state;
    expect(s.scram.active).toBe(false);
    expect(s.neutronFlux).toBeGreaterThan(0.98);
    expect(s.neutronFlux).toBeLessThan(1.02);
    expect(Math.abs(s.thermalPowerMW - start.thermalPowerMW)).toBeLessThan(60);
    expect(s.electricalOutputMW).toBeGreaterThan(980);
    expect(Math.abs(s.coolantTemp - start.coolantTemp)).toBeLessThan(2);
    expect(Math.abs(s.primaryPressure - SIM_CONFIG.pressure.nominal)).toBeLessThan(0.2);
    expect(s.alarms).toEqual([]);
    expect(reactorStatus(s)).toBe('AT POWER');
  });

  it('drifts down only slowly as fuel burns up over half a game day', () => {
    const r = fullPower();
    run(r, 600); // 12 game hours
    expect(r.state.scram.active).toBe(false);
    expect(r.state.neutronFlux).toBeGreaterThan(0.93);
    expect(r.state.neutronFlux).toBeLessThan(1.0);
    expect(r.state.burnupMWd).toBeGreaterThan(1200);
  });
});

describe('negative temperature feedback', () => {
  it('limits the power rise when rods are withdrawn a little', () => {
    const r = fullPower();
    // Withdraw all banks by 0.3% — roughly +55 pcm of rod reactivity.
    r.nudgeRods(-0.3);
    let peak = 0;
    for (let i = 0; i < 1200; i++) {
      r.step(DT, DT * GAME_SCALE);
      peak = Math.max(peak, r.state.neutronFlux);
    }
    const s = r.state;
    expect(s.scram.active).toBe(false);
    expect(peak).toBeGreaterThan(1.02);
    expect(peak).toBeLessThan(1.09);
    expect(s.neutronFlux).toBeLessThan(peak);
    // Feedback has soaked up the added reactivity: the core is critical again, but hotter.
    expect(Math.abs(s.reactivity.total)).toBeLessThan(5);
    expect(s.coreTemp).toBeGreaterThan(createReactorState('fullPower').coreTemp + 3);
  });

  it('follows load: closing the governor valve brings reactor power down on its own', () => {
    const r = fullPower();
    r.setGovernorValve(r.state.governorValve * 0.7);
    run(r, 30); // half a game hour: before xenon has time to move much
    const s = r.state;
    expect(s.scram.active).toBe(false);
    expect(s.neutronFlux).toBeGreaterThan(0.6);
    expect(s.neutronFlux).toBeLessThan(0.8);
  });

  it('then sags further as xenon builds up after the load cut', () => {
    const r = fullPower();
    r.setGovernorValve(r.state.governorValve * 0.7);
    run(r, 30);
    const early = r.state.neutronFlux;
    run(r, 300);
    expect(r.state.neutronFlux).toBeLessThan(early - 0.05);
  });
});

describe('reactor protection system (SCRAM)', () => {
  function expectTripped(r: Reactor, cause: string): void {
    expect(r.state.scram.active).toBe(true);
    expect(r.state.scram.cause).toBe(cause);
    run(r, 3);
    expect(Math.min(...r.state.rodBanks)).toBeGreaterThan(99.9);
    run(r, 12);
    expect(r.state.fissionPowerMW / SIM_CONFIG.ratedThermalMW).toBeLessThan(0.1);
    expect(reactorStatus(r.state)).toBe('SCRAMMED');
  }

  it('trips on high flux when rods are pulled at power', () => {
    const r = fullPower();
    r.setRodTarget('all', 5);
    run(r, 30);
    expectTripped(r, 'highFlux');
  });

  it('trips on low coolant flow when pumps stop at power', () => {
    const r = fullPower();
    r.setCoolantPump(0, false);
    r.setCoolantPump(1, false);
    run(r, 10);
    expectTripped(r, 'lowFlow');
  });

  it('trips on high primary pressure', () => {
    const r = fullPower();
    r.state.primaryPressure = 16.7;
    r.step(DT, DT * GAME_SCALE);
    expectTripped(r, 'highPressure');
  });

  it('trips on high core temperature', () => {
    const r = fullPower();
    r.state.coreTemp = 395;
    r.step(DT, DT * GAME_SCALE);
    expectTripped(r, 'highCoreTemp');
  });

  it('trips on a fast startup', () => {
    const r = new Reactor(createReactorState('cold'));
    r.setAllCoolantPumps(true);
    r.setRodTarget('all', 0); // yank every rod out
    run(r, 60);
    expectTripped(r, 'startupRate');
  });

  it('trips the reactor when the turbine trips at power', () => {
    const r = fullPower();
    r.tripTurbine();
    expectTripped(r, 'turbineTrip');
  });

  it('manual SCRAM always works and can be reset once rods are in', () => {
    const r = fullPower();
    r.setSafetyBypass(true);
    r.scram();
    expectTripped(r, 'manual');
    expect(r.resetScram()).toBe(true);
    expect(r.state.scram.active).toBe(false);
  });

  it('does not trip automatically while safeties are bypassed', () => {
    const r = fullPower();
    r.setSafetyBypass(true);
    r.setCoolantPump(0, false);
    r.setCoolantPump(1, false);
    run(r, 20);
    expect(r.state.scram.active).toBe(false);
    expect(r.state.alarms).toContain('BYPASS');
  });
});

describe('xenon', () => {
  it('builds up after a shutdown from full power, peaking hours later', () => {
    const r = fullPower();
    r.scram();
    run(r, (6 * 3600) / GAME_SCALE); // 6 game hours
    expect(r.state.xenonLevel).toBeGreaterThan(1.6);
    run(r, (60 * 3600) / GAME_SCALE); // 60 more game hours
    expect(r.state.xenonLevel).toBeLessThan(0.5);
  });

  it('makes an immediate restart impossible (xenon dead time), even with every rod out', () => {
    const r = fullPower();
    r.scram();
    run(r, (8 * 3600) / GAME_SCALE);
    const rodsOut = computeReactivity({ ...r.state, rodBanks: [0, 0, 0, 0] });
    expect(rodsOut.total).toBeLessThan(0);
  });

  it('builds up after a power reduction too', () => {
    const r = fullPower();
    r.setGovernorValve(r.state.governorValve * 0.5);
    run(r, (5 * 3600) / GAME_SCALE);
    expect(r.state.xenonLevel).toBeGreaterThan(1.1);
  });
});

describe('decay heat', () => {
  it('persists after shutdown and falls off over hours', () => {
    const r = fullPower();
    r.scram();
    run(r, 1, 1); // one real (and game) second
    const rated = SIM_CONFIG.ratedThermalMW;
    expect(r.state.decayHeatMW / rated).toBeGreaterThan(0.05);
    run(r, 3600 / GAME_SCALE); // one game hour
    const afterHour = r.state.decayHeatMW / rated;
    expect(afterHour).toBeGreaterThan(0.01);
    expect(afterHour).toBeLessThan(0.035);
    run(r, (24 * 3600) / GAME_SCALE);
    expect(r.state.decayHeatMW).toBeGreaterThan(0);
    expect(r.state.decayHeatMW / rated).toBeLessThan(afterHour);
  });

  it('keeps heating the coolant after shutdown if cooling is lost', () => {
    const r = fullPower();
    r.scram();
    run(r, 20);
    // Lose the heat sink: no feedwater at all, steam generators boiled nearly dry.
    r.setFeedPump(0, false);
    r.setFeedPump(1, false);
    r.setAuxFeed('off');
    r.state.steamGeneratorLevel = 5;
    const t0 = r.state.coolantTemp;
    run(r, 300);
    expect(r.state.coolantTemp).toBeGreaterThan(t0 + 10);
  });
});

describe('escalation', () => {
  it('melts the core if safeties are bypassed and the heat sink is lost', () => {
    const r = fullPower();
    r.setSafetyBypass(true);
    r.setFeedPump(0, false);
    r.setFeedPump(1, false);
    run(r, 3600);
    expect(r.state.coreDamage).toBeGreaterThan(0);
    expect(r.state.alarms).toContain('CORE_DAMAGE');
  });

  it('stays safe after the same fault when safeties are left on', () => {
    const r = fullPower();
    r.setFeedPump(0, false);
    r.setFeedPump(1, false);
    run(r, 1800);
    expect(r.state.scram.active).toBe(true);
    expect(r.state.coreDamage).toBe(0);
  });
});

describe('cold startup', () => {
  it('goes critical as rods are withdrawn and power climbs by decades', () => {
    const r = new Reactor(createReactorState('cold'));
    expect(reactorStatus(r.state)).toBe('OFFLINE');
    r.setAllCoolantPumps(true);
    run(r, 10);
    const n0 = r.state.neutronFlux;
    // Withdraw in small steps, holding while the startup rate is high.
    for (let i = 0; i < 600 && r.state.neutronFlux < 0.01; i++) {
      if (r.state.startupRate < 1) r.nudgeRods(-0.5);
      run(r, 1);
    }
    expect(r.state.scram.active).toBe(false);
    expect(r.state.neutronFlux).toBeGreaterThan(n0 * 1e4);
    expect(r.drainEvents().some((e) => e.text === 'Reactor is critical')).toBe(true);
  });
});

describe('determinism', () => {
  it('gives identical results for identical inputs', () => {
    const a = fullPower();
    const b = fullPower();
    for (const r of [a, b]) {
      r.nudgeRods(-1);
      run(r, 30);
      r.setGovernorValve(0.5);
      run(r, 30);
    }
    expect(a.state).toEqual(b.state);
  });
});
