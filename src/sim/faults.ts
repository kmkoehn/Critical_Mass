/**
 * Field faults: random equipment failures, weather damage and lightning.
 * Pure and deterministic (seeded RNG kept in state). Faults show up as map
 * markers, event-log entries and annunciator tiles; most must be fixed in person.
 */
import type { Severity } from './alarms';
import type { Grid } from './grid';
import type { Reactor } from './reactor';
import { rand, type WeatherKind } from './weather';
import {
  FIELD_POINTS, PLANT_LAYOUT, POWER_LINES, SUBSTATION_SITES, SWITCHYARD_POINT,
  type FieldPointId, type SubstationId,
} from '../world/layout';

export type FaultKind = 'rcpBearing' | 'feedValve' | 'towerFan' | 'intakeClog' | 'substationTrip' | 'lineDown' | 'radLeak';

export interface Fault {
  id: number;
  kind: FaultKind;
  /** Pump index, tower index, substation id or line id, depending on kind. */
  target: string;
  started: number;
  /** 0..1 for faults that get worse over time. */
  progress: number;
  crew: null | { staffId: number; name: string; skill: number; phase: 'enroute' | 'waiting' | 'repairing'; until: number };
}

/** A completed repair, for billing. */
export interface RepairRecord {
  kind: FaultKind;
  t: number;
  by: 'player' | 'crew';
}

export interface LogEntry {
  t: number;
  kind: 'info' | 'good' | 'warn' | 'danger';
  text: string;
}

export interface FaultState {
  faults: Fault[];
  log: LogEntry[];
  nextId: number;
  rng: number;
  /** Turn random failures off (e.g. during a tutorial). Weather damage still happens. */
  randomFailures: boolean;
  /** Completed repairs not yet billed (drained by the management model). */
  repairs: RepairRecord[];
}

export interface Strike {
  x: number;
  z: number;
  /** What it hit, for the log. */
  hit: string | null;
}

/** Failure rates per game hour. */
export const FAULT_RATES = {
  rcpBearing: 0.012,
  feedValve: 0.006,
  towerFan: 0.01,
  radLeak: 0.004,
  intakeClogDry: 0.002,
  intakeClogRain: 0.06,
  intakeClogStorm: 0.15,
};

/** Progression per game hour for faults that get worse if ignored. */
const WORSENING = { rcpBearing: 0.25, intakeClog: 0.08, intakeClogWet: 0.25, radLeak: 0.2 };

/** Lightning: share of strikes that hit a tall structure, and what a hit does. */
const LIGHTNING = { targeted: 0.35, substationTrip: 0.6, lineDown: 0.12 };

/** Crews drive from the plant at this speed (m per game second ≈ 40 km/h). */
export const CREW_SPEED = 11;
/** Hours a skill-3 crew needs on site. Skill 5 is ~30% faster, skill 1 ~30% slower. */
export const CREW_REPAIR_HOURS: Record<FaultKind, number> = {
  rcpBearing: 3, feedValve: 1, towerFan: 2, intakeClog: 1.5, substationTrip: 0.5, lineDown: 2, radLeak: 2,
};
/** Parts and materials, $. */
export const REPAIR_COST: Record<FaultKind, number> = {
  rcpBearing: 120_000, feedValve: 40_000, towerFan: 80_000, intakeClog: 15_000, substationTrip: 20_000, lineDown: 150_000, radLeak: 60_000,
};
/** Which kind of crew a fault needs. */
export function crewRoleFor(kind: FaultKind): 'maintenance' | 'lineCrew' {
  return kind === 'lineDown' || kind === 'substationTrip' ? 'lineCrew' : 'maintenance';
}
const CREW_BASE = { x: -385, z: -96 };

export const REPAIR_SECONDS: Record<FaultKind, number> = {
  rcpBearing: 8, feedValve: 6, towerFan: 6, intakeClog: 8, substationTrip: 3, lineDown: 0, radLeak: 10,
};

const SUB_NAMES: Record<SubstationId, string> = {
  town: 'Millbrook', industrial: 'Industrial Park', farmland: 'Farmland', city: 'City tie-line',
};

export function faultTitle(f: Fault): string {
  switch (f.kind) {
    case 'rcpBearing': return `RCP ${Number(f.target) + 1} bearing overheating`;
    case 'feedValve': return 'Feed valve FW-3B stuck';
    case 'towerFan': return `Cooling tower ${Number(f.target) + 1} fans failed`;
    case 'intakeClog': return 'River intake clogged with debris';
    case 'substationTrip': return `${SUB_NAMES[f.target as SubstationId]} breaker tripped`;
    case 'lineDown': return `Transmission line down (${f.target} line)`;
    case 'radLeak': return 'Radiation leak at the fuel pad';
  }
}

/** Where the fault is fixed (null: needs a line crew). */
export function faultPoint(f: Fault): FieldPointId | null {
  switch (f.kind) {
    case 'rcpBearing': return 'rcp';
    case 'feedValve': return 'fwValve';
    case 'towerFan': return `fan:${f.target}` as FieldPointId;
    case 'intakeClog': return 'intake';
    case 'substationTrip': return `sub:${f.target}` as FieldPointId;
    case 'radLeak': return 'spentFuel';
    case 'lineDown': return null;
  }
}

/** Map position of a fault. */
export function faultLocation(f: Fault): { x: number; z: number } {
  const p = faultPoint(f);
  if (p) return FIELD_POINTS[p];
  const line = POWER_LINES.find((l) => l.id === f.target)!;
  const [a, b] = [line.points[0], line.points[1]];
  return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2 };
}

/** What to do about it, for the work-order list. */
export function faultAction(f: Fault): string {
  switch (f.kind) {
    case 'rcpBearing': return 'Stop the pump, then service it at the containment access';
    case 'feedValve': return 'Free the valve in the turbine hall';
    case 'towerFan': return 'Repair the fans at the tower base';
    case 'intakeClog': return 'Clear the screens at the river intake';
    case 'substationTrip': return 'Reset the breaker at the substation';
    case 'radLeak': return 'Reseal the leaking cask (watch your dose)';
    case 'lineDown':
      if (!f.crew) return 'Send a line crew (tablet or Grid Dispatch)';
      break;
  }
  return '';
}

/** Work-order text including any crew on the job. */
export function faultStatus(f: Fault): string {
  if (!f.crew) return faultAction(f);
  if (f.crew.phase === 'enroute') return `${f.crew.name} on the way`;
  if (f.crew.phase === 'waiting') return `${f.crew.name} waiting: stop RCP ${Number(f.target) + 1}`;
  return `${f.crew.name} repairing`;
}

export const FAULT_ALARMS: ReadonlyArray<{ id: string; label: string; severity: Severity; active: (s: FaultState) => boolean }> = [
  { id: 'RCP_BEARING', label: 'RCP bearing hot', severity: 'alarm', active: (s) => s.faults.some((f) => f.kind === 'rcpBearing') },
  { id: 'FW_VALVE', label: 'Feed valve stuck', severity: 'alarm', active: (s) => s.faults.some((f) => f.kind === 'feedValve') },
  { id: 'TOWER_FAN', label: 'Tower fan failed', severity: 'warning', active: (s) => s.faults.some((f) => f.kind === 'towerFan') },
  { id: 'INTAKE_CLOG', label: 'Intake screen clogged', severity: 'warning', active: (s) => s.faults.some((f) => f.kind === 'intakeClog') },
  { id: 'RAD_LEAK', label: 'Fuel pad radiation', severity: 'alarm', active: (s) => s.faults.some((f) => f.kind === 'radLeak') },
  { id: 'LINE_DOWN', label: 'Transmission line down', severity: 'alarm', active: (s) => s.faults.some((f) => f.kind === 'lineDown') },
];

export function createFaultState(seed = 777): FaultState {
  return { faults: [], log: [], nextId: 1, rng: seed >>> 0, randomFailures: true, repairs: [] };
}

/** Tall structures lightning prefers. */
const STRIKE_TARGETS: ReadonlyArray<{ x: number; z: number; sub?: SubstationId; line?: string; name: string }> = [
  ...(Object.keys(SUBSTATION_SITES) as SubstationId[]).map((id) => ({ ...SUBSTATION_SITES[id], sub: id })),
  ...POWER_LINES.flatMap((l) => l.points.slice(1, -1).map(([x, z]) => ({ x, z, line: l.id, name: `${l.id} line tower` }))),
  ...POWER_LINES.map((l) => {
    const [a, b] = [l.points[0], l.points[1]];
    return { x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, line: l.id, name: `${l.id} line tower` };
  }),
  ...PLANT_LAYOUT.coolingTowers.map((t, i) => ({ ...t, name: `cooling tower ${i + 1}` })),
  { x: SWITCHYARD_POINT[0], z: SWITCHYARD_POINT[1], name: 'plant switchyard' },
];

export class FaultManager {
  /** Storm-hardened lines: lightning does a quarter of the damage. */
  stormHardened = false;

  constructor(readonly state: FaultState = createFaultState()) {}

  private random(): number {
    const [v, s] = rand(this.state.rng);
    this.state.rng = s;
    return v;
  }

  /** Add something else (staff, money, regulator) to the shared event log. */
  note(t: number, kind: LogEntry['kind'], text: string): void {
    this.log(t, kind, text);
  }

  private log(t: number, kind: LogEntry['kind'], text: string): LogEntry {
    const e = { t, kind, text };
    this.state.log.push(e);
    if (this.state.log.length > 200) this.state.log.splice(0, this.state.log.length - 200);
    return e;
  }

  has(kind: FaultKind, target?: string): boolean {
    return this.state.faults.some((f) => f.kind === kind && (target === undefined || f.target === target));
  }

  /** Start a fault now (random generator, lightning, or debug). Returns null if it already exists. */
  inject(kind: FaultKind, target: string, t: number): Fault | null {
    if (this.has(kind, target)) return null;
    const f: Fault = { id: this.state.nextId++, kind, target, started: t, progress: 0, crew: null };
    this.state.faults.push(f);
    this.log(t, kind === 'radLeak' || kind === 'lineDown' ? 'danger' : 'warn', faultTitle(f));
    return f;
  }

  /**
   * Advance one step: random failures, worsening, lightning, crews.
   * Returns new log entries and where lightning struck (for the visuals).
   */
  step(t: number, dtGame: number, weather: WeatherKind, strikes: number, reactor: Reactor): { events: LogEntry[]; strikes: Strike[] } {
    const st = this.state;
    const before = st.log.length;
    const hours = dtGame / 3600;
    const chance = (perHour: number) => this.random() < perHour * hours;
    const rs = reactor.state;

    // Random failures.
    if (st.randomFailures) {
      const running = rs.coolantPumps.map((p, i) => (p.on && !p.failed ? i : -1)).filter((i) => i >= 0);
      if (running.length && chance(FAULT_RATES.rcpBearing)) {
        this.inject('rcpBearing', String(running[Math.floor(this.random() * running.length)]), t);
      }
      if (rs.feedPumps.some(Boolean) && rs.neutronFlux > 0.1 && chance(FAULT_RATES.feedValve)) this.inject('feedValve', 'fw3b', t);
      if (chance(FAULT_RATES.towerFan)) this.inject('towerFan', String(this.random() < 0.5 ? 0 : 1), t);
      if (chance(FAULT_RATES.radLeak)) this.inject('radLeak', 'pad', t);
    }
    const clogRate = weather === 'thunderstorm' ? FAULT_RATES.intakeClogStorm
      : weather === 'rain' ? FAULT_RATES.intakeClogRain : FAULT_RATES.intakeClogDry;
    if (chance(clogRate)) this.inject('intakeClog', 'intake', t);

    // Lightning.
    const hits: Strike[] = [];
    for (let i = 0; i < strikes; i++) {
      if (this.random() < LIGHTNING.targeted) {
        const target = STRIKE_TARGETS[Math.floor(this.random() * STRIKE_TARGETS.length)];
        hits.push({ x: target.x, z: target.z, hit: target.name });
        const harden = this.stormHardened ? 0.25 : 1;
        if (target.sub && this.random() < LIGHTNING.substationTrip * harden) {
          if (this.inject('substationTrip', target.sub, t)) this.log(t, 'danger', `Lightning struck ${target.name}`);
        } else if (target.line && this.random() < LIGHTNING.lineDown * harden) {
          if (this.inject('lineDown', target.line, t)) this.log(t, 'danger', `Lightning brought down a tower on the ${target.line} line`);
        }
      } else {
        hits.push({ x: (this.random() * 2 - 1) * 950, z: (this.random() * 2 - 1) * 950, hit: null });
      }
    }

    // Worsening and crews.
    const wet = weather === 'rain' || weather === 'thunderstorm';
    for (const f of [...st.faults]) {
      if (f.kind === 'rcpBearing') {
        const pump = rs.coolantPumps[Number(f.target)];
        // Bearings only heat while the pump turns.
        if (pump && pump.speed > 0.1) f.progress = Math.min(1, f.progress + WORSENING.rcpBearing * hours);
      } else if (f.kind === 'intakeClog') {
        f.progress = Math.min(1, f.progress + (wet ? WORSENING.intakeClogWet : WORSENING.intakeClog) * hours);
      } else if (f.kind === 'radLeak') {
        f.progress = Math.min(1, f.progress + WORSENING.radLeak * hours);
      }
      // Crews: travel, (wait for a pump to be stopped), repair.
      const c = f.crew;
      if (c && t >= c.until) {
        if (c.phase === 'enroute' || c.phase === 'waiting') {
          const pump = f.kind === 'rcpBearing' ? rs.coolantPumps[Number(f.target)] : null;
          if (pump && (pump.on || pump.speed > 0.05)) {
            if (c.phase === 'enroute') this.log(t, 'warn', `${c.name} is waiting: stop RCP ${Number(f.target) + 1} so they can work`);
            c.phase = 'waiting';
            c.until = t + 300;
          } else {
            c.phase = 'repairing';
            c.until = t + CREW_REPAIR_HOURS[f.kind] * 3600 * (1.45 - 0.15 * c.skill);
            this.log(t, 'info', `${c.name} on site: ${faultTitle(f)}`);
          }
        } else {
          if (f.kind === 'rcpBearing') reactor.repairPump(Number(f.target));
          this.resolve(f, t, `${c.name} fixed: ${faultTitle(f)}`, 'crew');
        }
      }
    }
    return { events: st.log.slice(before), strikes: hits };
  }

  /** Push fault effects into the plant and grid models. Call every step before they step. */
  apply(reactor: Reactor, grid: Grid): void {
    const rs = reactor.state;
    const pf = rs.plantFaults;
    pf.feedValveStuck = this.has('feedValve');
    pf.towerFansBroken = this.state.faults.filter((f) => f.kind === 'towerFan').length * 2;
    pf.intakeClog = this.state.faults.find((f) => f.kind === 'intakeClog')?.progress ?? 0;
    pf.radLeak = this.state.faults.find((f) => f.kind === 'radLeak')?.progress ?? 0;
    rs.coolantPumps.forEach((p, i) => {
      const f = this.state.faults.find((x) => x.kind === 'rcpBearing' && x.target === String(i));
      p.bearingTemp = 70 + 50 * (f?.progress ?? 0);
      if (f && f.progress >= 1 && !p.failed) reactor.failPump(i);
    });
    for (const id of Object.keys(grid.state.subs) as SubstationId[]) {
      grid.state.subs[id].breakerClosed = !this.has('substationTrip', id);
      grid.state.subs[id].lineUp = true;
    }
    for (const f of this.state.faults) {
      if (f.kind !== 'lineDown') continue;
      for (const id of POWER_LINES.find((l) => l.id === f.target)!.feeds) grid.state.subs[id].lineUp = false;
    }
  }

  /**
   * Fix a fault in person. Returns null on success, or why it can't be done yet.
   */
  repair(faultId: number, t: number, reactor: Reactor): string | null {
    const f = this.state.faults.find((x) => x.id === faultId);
    if (!f) return 'Nothing to repair';
    if (f.kind === 'rcpBearing') {
      const i = Number(f.target);
      const pump = reactor.state.coolantPumps[i];
      if (pump.on || pump.speed > 0.05) return `Stop RCP ${i + 1} from the control room first`;
      reactor.repairPump(i);
    }
    this.resolve(f, t, `Repaired: ${faultTitle(f)}`);
    return null;
  }

  /** Send a crew (the caller checks they're free and the right kind). Travel time depends on distance. */
  dispatchCrew(faultId: number, t: number, crew: { id: number; name: string; skill: number }): boolean {
    const f = this.state.faults.find((x) => x.id === faultId);
    if (!f || f.crew) return false;
    const loc = faultLocation(f);
    const travel = Math.hypot(loc.x - CREW_BASE.x, loc.z - CREW_BASE.z) / CREW_SPEED + 600;
    f.crew = { staffId: crew.id, name: crew.name, skill: crew.skill, phase: 'enroute', until: t + travel };
    this.log(t, 'info', `${crew.name} dispatched: ${faultTitle(f)} (≈${Math.max(1, Math.round(travel / 60))} game min away)`);
    return true;
  }

  private resolve(f: Fault, t: number, text: string, by: 'player' | 'crew' = 'player'): void {
    this.state.faults = this.state.faults.filter((x) => x !== f);
    this.state.repairs.push({ kind: f.kind, t, by });
    this.log(t, 'good', text);
  }

  /** Completed repairs since the last call (for billing). */
  drainRepairs(): RepairRecord[] {
    const r = this.state.repairs;
    this.state.repairs = [];
    return r;
  }

  /** Active faults fixed at a field point. */
  faultsAt(point: FieldPointId): Fault[] {
    return this.state.faults.filter((f) => faultPoint(f) === point);
  }

  get alarms(): string[] {
    return FAULT_ALARMS.filter((a) => a.active(this.state)).map((a) => a.id);
  }
}
