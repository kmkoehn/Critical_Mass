import { describe, expect, it } from 'vitest';
import { Autopilot } from '../src/sim/autopilot';
import { FaultManager, createFaultState } from '../src/sim/faults';
import { Grid } from '../src/sim/grid';
import { MGMT_CONFIG, Management, createManagementState, ledgerNet } from '../src/sim/management';
import { Reactor, createReactorState } from '../src/sim/reactor';
import { Staff, createStaffState } from '../src/sim/staff';

const DT = 0.1;
const SCALE = 72;

/** A whole plant: reactor, grid, faults, staff, management and autopilot, stepped like the game does. */
function plant(preset: 'cold' | 'fullPower' = 'fullPower', startHour = 13) {
  const reactor = new Reactor(createReactorState(preset));
  const grid = new Grid();
  const faults = new FaultManager(createFaultState(5));
  faults.state.randomFailures = false;
  const staff = new Staff(createStaffState(11));
  const mgmt = new Management(createManagementState(3));
  const autopilot = new Autopilot();
  let t = startHour * 3600;
  let playerInRoom = false;
  const events: string[] = [];
  const step = () => {
    const dtGame = DT * SCALE;
    t += dtGame;
    faults.step(t, dtGame, 'clear', 0, reactor);
    faults.apply(reactor, grid);
    events.push(...staff.step(t, dtGame, new Set(faults.state.faults.map((f) => f.id))));
    const ap = autopilot.step(DT, reactor, grid, staff.state, staff.dutyOperator, playerInRoom);
    events.push(...ap.events);
    reactor.gridHz = grid.state.dead ? 60 : grid.state.frequency;
    reactor.lockout = mgmt.lockedOut(t) ? 'regulator shutdown' : null;
    reactor.step(DT, dtGame);
    const res = grid.step(DT, t, dtGame, reactor.state.generatorSynced ? reactor.state.electricalOutputMW : 0, 18);
    if (res.generatorTrip) reactor.generatorTrip(res.generatorTrip);
    for (const e of mgmt.step(t, dtGame, {
      reactor, grid, faults, staff,
      controlRoomStaffed: playerInRoom || staff.dutyOperator !== null,
      unackedAlarms: 0, playerDoseMSv: 0,
    })) events.push(e.text);
  };
  const runHours = (hours: number) => {
    for (let i = 0; i < (hours * 3600) / (DT * SCALE); i++) step();
  };
  const hireBest = (role: 'operator' | 'maintenance' | 'lineCrew' | 'security') => {
    const c = staff.state.candidates.filter((x) => x.role === role).sort((a, b) => b.skill - a.skill)[0];
    return staff.hire(c.id)!;
  };
  return {
    reactor, grid, faults, staff, mgmt, autopilot, events, step, runHours, hireBest,
    get t() { return t; },
    setPlayerInRoom: (v: boolean) => { playerInRoom = v; },
  };
}

describe('staff', () => {
  it('puts a hired operator on shift and rotates tired operators', () => {
    const p = plant();
    const a = p.hireBest('operator');
    p.step();
    expect(p.staff.dutyOperator?.id).toBe(a.id);
    const b = p.hireBest('operator');
    p.runHours(12);
    expect(p.events.some((e) => e.startsWith('Shift change'))).toBe(true);
    expect([a.id, b.id]).toContain(p.staff.dutyOperator?.id);
  });

  it('charges wages', () => {
    const p = plant('cold');
    p.hireBest('operator');
    p.hireBest('maintenance');
    p.runHours(2);
    expect(p.mgmt.state.today.wages).toBeGreaterThan(p.staff.wagesPerHour * 1.9);
  });
});

describe('shift-operator autopilot', () => {
  it('follows grid demand through the afternoon and evening without tripping', () => {
    const p = plant('fullPower', 13);
    p.hireBest('operator');
    p.runHours(8); // 13:00 → 21:00: demand swings by hundreds of MW
    const s = p.reactor.state;
    expect(s.scram.active).toBe(false);
    expect(s.generatorSynced).toBe(true);
    expect(Math.abs(s.electricalOutputMW - p.grid.state.demandMW)).toBeLessThan(60);
    expect(p.grid.state.frequency).toBeGreaterThan(59.5);
    expect(p.grid.state.frequency).toBeLessThan(60.6);
  });

  it('handles a hot RCP bearing: derates, stops the pump for the crew, restarts it after', () => {
    const p = plant('fullPower', 13);
    p.hireBest('operator');
    const crew = p.hireBest('maintenance');
    const f = p.faults.inject('rcpBearing', '1', p.t)!;
    p.faults.dispatchCrew(f.id, p.t, crew);
    crew.busyWith = f.id;
    // Same wiring as the game: the autopilot is told which pumps have hot bearings.
    const ap = p.autopilot;
    const orig = ap.step.bind(ap);
    ap.step = (dt, r, g, s, op, sus) => orig(dt, r, g, s, op, sus, p.faults.state.faults.filter((x) => x.kind === 'rcpBearing').map((x) => Number(x.target)));
    p.runHours(8);
    expect(p.reactor.state.scram.active).toBe(false);
    expect(p.events.some((e) => /stopped RCP 2/.test(e))).toBe(true);
    expect(p.faults.has('rcpBearing')).toBe(false);
    expect(p.events.some((e) => /restarted RCP 2/.test(e))).toBe(true);
    expect(p.reactor.state.coolantPumps[1].on).toBe(true);
  });

  it('stands back while the player has the controls', () => {
    const p = plant('fullPower', 13);
    p.hireBest('operator');
    p.setPlayerInRoom(true);
    const valve = p.reactor.state.governorValve;
    for (let i = 0; i < 50; i++) p.step();
    expect(p.reactor.state.governorValve).toBe(valve);
  });
});

describe('finances', () => {
  it('turns a profit at power, and closes the day into the ledger history', () => {
    const p = plant('fullPower', 13);
    p.hireBest('operator');
    p.runHours(11.5); // 13:00 → 00:30 next day
    const day1 = p.mgmt.state.history[0];
    expect(day1.day).toBe(1);
    expect(day1.ledger.sales).toBeGreaterThan(250_000);
    expect(ledgerNet(day1.ledger)).toBeGreaterThan(0);
    expect(p.mgmt.state.cash).toBeGreaterThan(MGMT_CONFIG.startingCash);
    expect(p.events.some((e) => /Day 1 closed: profit/.test(e))).toBe(true);
  });

  it('loses money every hour while shut down', () => {
    const p = plant('cold', 8);
    p.runHours(5);
    expect(p.mgmt.state.cash).toBeLessThan(MGMT_CONFIG.startingCash - 5 * MGMT_CONFIG.overheadPerHour * 0.99);
  });

  it('charges penalties for missing contracted supply', () => {
    const p = plant('cold', 18);
    const offer = p.mgmt.state.offers.find((o) => o.sub === 'town')!;
    expect(p.mgmt.signContract(offer.id, p.t)).not.toBeNull();
    p.runHours(2); // grid is dead: nothing delivered
    expect(p.mgmt.state.today.penalties).toBeGreaterThan(0);
  });

  it('loans add cash and cost interest', () => {
    const p = plant('cold');
    expect(p.mgmt.takeLoan()).toBe(true);
    expect(p.mgmt.state.loan).toBe(MGMT_CONFIG.loanStep);
    p.runHours(10);
    expect(p.mgmt.state.today.interest).toBeGreaterThan(0);
  });

  it('goes bankrupt after a week overdrawn', () => {
    const p = plant('cold', 0);
    p.mgmt.state.cash = -50_000_000;
    p.runHours(24 * 7 + 1);
    expect(p.mgmt.state.bankrupt).toBe(true);
  });

  it('bills repairs', () => {
    const p = plant('fullPower');
    const f = p.faults.inject('intakeClog', 'intake', p.t)!;
    p.faults.repair(f.id, p.t, p.reactor);
    p.step();
    expect(p.mgmt.state.today.repairs).toBeGreaterThan(0);
  });
});

describe('public opinion', () => {
  it('ignores the years-long darkness before the first start-up', () => {
    const p = plant('cold', 18);
    p.runHours(12);
    expect(p.mgmt.state.opinion).toBeGreaterThan(50);
  });

  it('falls during blackouts and recovers with reliable supply', () => {
    const p = plant('cold', 18);
    p.mgmt.state.everEnergized = true; // Riverbend has powered the town before
    const start = p.mgmt.state.opinion;
    p.runHours(6);
    expect(p.mgmt.state.opinion).toBeLessThan(start - 10);
    const q = plant('fullPower', 10);
    q.hireBest('operator');
    q.mgmt.state.opinion = 40;
    q.runHours(8);
    expect(q.mgmt.state.opinion).toBeGreaterThan(41);
  });
});

describe('regulator inspections', () => {
  it('fails a plant run unattended with safeties bypassed, then shuts it down, then revokes the licence', () => {
    const p = plant('fullPower');
    p.reactor.setSafetyBypass(true);
    const ctx = () => ({
      reactor: p.reactor, grid: p.grid, faults: p.faults, staff: p.staff,
      controlRoomStaffed: false, unackedAlarms: 4, playerDoseMSv: 0,
    });
    const r1 = p.mgmt.inspect(p.t, ctx());
    expect(r1.passed).toBe(false);
    expect(r1.findings.join(' ')).toMatch(/bypassed/);
    expect(p.mgmt.state.today.fines).toBe(MGMT_CONFIG.inspection.fines[0]);
    const r2 = p.mgmt.inspect(p.t, ctx());
    expect(r2.passed).toBe(false);
    expect(p.reactor.state.scram.cause).toBe('regulator');
    expect(p.mgmt.lockedOut(p.t + 3600)).toBe(true);
    p.reactor.lockout = 'regulator shutdown';
    for (let i = 0; i < 50; i++) p.reactor.step(DT, DT * SCALE);
    expect(p.reactor.resetScram()).toBe(false);
    p.mgmt.inspect(p.t, ctx());
    expect(p.mgmt.state.regulator.licenseRevoked).toBe(true);
  });

  it('passes a well-run plant', () => {
    const p = plant('fullPower');
    p.hireBest('operator');
    p.hireBest('security');
    p.step();
    const r = p.mgmt.inspect(p.t, {
      reactor: p.reactor, grid: p.grid, faults: p.faults, staff: p.staff,
      controlRoomStaffed: true, unackedAlarms: 0, playerDoseMSv: 0,
    });
    expect(r.passed).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it('announces and holds the first inspection on day 2', () => {
    const p = plant('fullPower', 8);
    p.hireBest('operator');
    p.hireBest('security');
    p.runHours(27);
    expect(p.events.some((e) => /inspection announced/.test(e))).toBe(true);
    expect(p.mgmt.state.regulator.reports.length).toBe(1);
  });
});
