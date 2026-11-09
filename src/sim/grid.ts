/**
 * Regional island grid. Riverbend is the only generator; four substations draw power.
 * Pure TypeScript, deterministic.
 *
 * - Demand follows time of day, weekdays (industrial park) and the weather.
 * - Short of power, feeders are shed in proportion across substations and rotated
 *   every 20 game minutes (rolling blackouts). Millbrook's feeders are its 8 districts.
 * - Long on power, the frequency rises; sustained over-frequency opens the generator breaker.
 */
import type { Severity } from './alarms';
import type { SubstationId } from '../world/layout';

export type { SubstationId };

export const GRID_CONFIG = {
  nominalHz: 60,
  /** Frequency change per unit of supply/demand imbalance. */
  hzPerImbalance: 20,
  freqTau: 2,
  /** Over-frequency protection: trip the generator above this for overFreqDelay real seconds. */
  overFreqTripHz: 61.2,
  overFreqResetHz: 61.0,
  overFreqDelay: 8,
  /** Shortfalls smaller than this fraction are absorbed without shedding. */
  shedDeadband: 0.01,
  /** Rolling-blackout rotation period, game seconds. */
  rotationPeriod: 20 * 60,
  /** Game seconds a feeder stays shed before it may be restored. */
  restoreDelay: 60,
} as const;

export interface SubstationDef {
  id: SubstationId;
  name: string;
  feeders: number;
  /** Demand in MW at a game time. */
  demand: (hour: number, day: number, ambientTemp: number) => number;
}

const bump = (h: number, centre: number, width: number) => Math.exp(-(((h - centre) / width) ** 2));
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** Day 1 is a Monday; days 6 and 7 of each week are the weekend. */
export const isWeekend = (day: number) => ((day - 1) % 7) >= 5;
const weather = (ambient: number, perHot: number, perCold: number) =>
  Math.max(0, ambient - 24) * perHot + Math.max(0, 8 - ambient) * perCold;

export const SUBSTATIONS: readonly SubstationDef[] = [
  {
    id: 'town', name: 'Millbrook', feeders: 8,
    demand: (h, _d, t) => 85 + 55 * bump(h, 7.5, 1.6) + 35 * bump(h, 13, 4) + 125 * bump(h, 19.5, 2.2) + weather(t, 5, 6),
  },
  {
    id: 'industrial', name: 'Industrial Park', feeders: 4,
    demand: (h, d, t) => {
      const shift = isWeekend(d) ? 0 : smooth(6, 8, h) * (1 - smooth(18, 20, h));
      return 55 + 215 * shift + weather(t, 3, 2);
    },
  },
  {
    id: 'farmland', name: 'Farmland', feeders: 3,
    demand: (h, _d, t) => 30 + 20 * bump(h, 6, 2) + 15 * bump(h, 17, 3) + weather(t, 1.5, 1),
  },
  {
    id: 'city', name: 'City Tie-Line', feeders: 4,
    demand: (h) => 290 + 80 * bump(h, 10, 3) + 130 * bump(h, 19, 3),
  },
];

export interface SubstationState {
  /** Breaker at the substation (opened by faults in Milestone 5). */
  breakerClosed: boolean;
  /** Transmission line feeding it is intact. */
  lineUp: boolean;
  demandMW: number;
  servedMW: number;
  /** Feeders currently shed (indices). */
  feedersOff: number[];
  /** Game time of the last change to the shed count. */
  lastChange: number;
}

export interface GridState {
  frequency: number;
  supplyMW: number;
  demandMW: number;
  servedMW: number;
  /** Fraction of connected demand being shed (0..1). */
  shedFraction: number;
  dead: boolean;
  overFreqTimer: number;
  rotation: number;
  nextRotationAt: number;
  subs: Record<SubstationId, SubstationState>;
  stats: { unservedMWh: number; townDarkDistrictHours: number };
  alarms: string[];
}

export interface GridEvent {
  kind: 'info' | 'good' | 'warn' | 'danger';
  text: string;
}

export function createGridState(): GridState {
  const subs = {} as Record<SubstationId, SubstationState>;
  for (const d of SUBSTATIONS) {
    subs[d.id] = {
      breakerClosed: true, lineUp: true, demandMW: 0, servedMW: 0,
      feedersOff: Array.from({ length: d.feeders }, (_, i) => i), lastChange: -1e9,
    };
  }
  return {
    frequency: 0, supplyMW: 0, demandMW: 0, servedMW: 0, shedFraction: 1, dead: true,
    overFreqTimer: 0, rotation: 0, nextRotationAt: GRID_CONFIG.rotationPeriod,
    subs, stats: { unservedMWh: 0, townDarkDistrictHours: 0 }, alarms: [],
  };
}

export const GRID_ALARMS: ReadonlyArray<{ id: string; label: string; severity: Severity; active: (g: GridState) => boolean }> = [
  { id: 'LOAD_SHED', label: 'Load shedding', severity: 'alarm', active: (g) => !g.dead && g.shedFraction > 0 },
  { id: 'FREQ_HIGH', label: 'Grid frequency high', severity: 'warning', active: (g) => g.frequency > 60.5 },
  { id: 'FREQ_LOW', label: 'Grid frequency low', severity: 'warning', active: (g) => !g.dead && g.frequency < 59.5 },
  { id: 'SUB_OUT', label: 'Substation out', severity: 'alarm', active: (g) => Object.values(g.subs).some((s) => !s.breakerClosed || !s.lineUp) },
];

/** Total regional demand at a time (all substations connected). */
export function regionalDemandMW(hour: number, day = 1, ambientTemp = 18): number {
  return SUBSTATIONS.reduce((sum, d) => sum + d.demand(hour, day, ambientTemp), 0);
}

export class Grid {
  private wasDead = true;
  private lastTownOff = -1;

  constructor(readonly state: GridState = createGridState()) {}

  isFeederPowered(sub: SubstationId, feeder: number): boolean {
    const s = this.state.subs[sub];
    return !this.state.dead && s.breakerClosed && !s.feedersOff.includes(feeder);
  }

  /**
   * @param dt real seconds (frequency dynamics)
   * @param gameSeconds current game time
   * @param dtGame game seconds elapsed
   * @param supplyMW generator output delivered to the grid
   */
  step(dt: number, gameSeconds: number, dtGame: number, supplyMW: number, ambientTemp: number): {
    events: GridEvent[];
    generatorTrip: string | null;
  } {
    const g = this.state;
    const cfg = GRID_CONFIG;
    const events: GridEvent[] = [];
    const hour = (gameSeconds % 86400) / 3600;
    const day = Math.floor(gameSeconds / 86400) + 1;
    g.supplyMW = supplyMW;

    // Demand on connected substations.
    let demand = 0;
    for (const d of SUBSTATIONS) {
      const s = g.subs[d.id];
      s.demandMW = d.demand(hour, day, ambientTemp);
      if (s.breakerClosed) demand += s.demandMW;
    }
    g.demandMW = demand;
    g.dead = supplyMW <= 0.5;

    // How much must be shed.
    let shed = demand > 0 ? Math.min(1, Math.max(0, (demand - supplyMW) / demand)) : 0;
    if (shed < cfg.shedDeadband) shed = 0;
    if (g.dead) shed = 1;
    g.shedFraction = shed;

    // Rotate which feeders are dark.
    const rotate = gameSeconds >= g.nextRotationAt;
    if (rotate) {
      g.rotation++;
      g.nextRotationAt = gameSeconds + cfg.rotationPeriod;
    }

    let served = 0;
    for (const d of SUBSTATIONS) {
      const s = g.subs[d.id];
      // A downed line reroutes through the rest of the network at half capacity.
      const connected = s.breakerClosed;
      let want = !connected ? d.feeders : shed > 0 ? Math.min(d.feeders, Math.ceil(shed * d.feeders - 1e-9)) : 0;
      if (connected && !s.lineUp) want = Math.max(want, Math.ceil(d.feeders * 0.5));
      let count = s.feedersOff.length;
      if (want > count || g.dead || !connected) {
        count = want;
        s.lastChange = gameSeconds;
      } else if (want < count && gameSeconds - s.lastChange >= cfg.restoreDelay) {
        count = want;
        s.lastChange = gameSeconds;
      }
      if (count !== s.feedersOff.length || (rotate && count > 0 && count < d.feeders)) {
        const offset = (g.rotation * Math.max(1, count)) % d.feeders;
        s.feedersOff = Array.from({ length: count }, (_, k) => (offset + k) % d.feeders);
      }
      s.servedMW = connected && !g.dead ? s.demandMW * (1 - s.feedersOff.length / d.feeders) : 0;
      served += s.servedMW;
    }
    g.servedMW = served;

    // Frequency.
    let target = 0;
    if (!g.dead) {
      const imbalance = shed > 0 ? -0.01 : (supplyMW - demand) / Math.max(demand, 50);
      target = cfg.nominalHz + cfg.hzPerImbalance * Math.min(0.15, Math.max(-0.15, imbalance));
    }
    if (g.dead) g.frequency = 0;
    else if (g.frequency < 1) g.frequency = target;
    else g.frequency += (target - g.frequency) * (1 - Math.exp(-dt / cfg.freqTau));

    let generatorTrip: string | null = null;
    if (g.frequency > cfg.overFreqTripHz) {
      g.overFreqTimer += dt;
      if (g.overFreqTimer > cfg.overFreqDelay) {
        generatorTrip = 'grid over-frequency protection';
        g.overFreqTimer = 0;
      }
    } else if (g.frequency < cfg.overFreqResetHz) {
      g.overFreqTimer = 0;
    }

    // Stats.
    const hours = dtGame / 3600;
    g.stats.unservedMWh += Math.max(0, demand - served) * hours;
    g.stats.townDarkDistrictHours += g.subs.town.feedersOff.length * hours;

    // Events.
    if (g.dead && !this.wasDead) events.push({ kind: 'danger', text: 'Grid blackout: no generation. Millbrook is dark.' });
    if (!g.dead && this.wasDead) events.push({ kind: 'good', text: 'Grid energised: Riverbend is supplying the region' });
    this.wasDead = g.dead;
    const townOff = g.subs.town.feedersOff.length;
    if (!g.dead && townOff !== this.lastTownOff && this.lastTownOff !== -1) {
      if (townOff === 0) events.push({ kind: 'good', text: 'Power restored to all of Millbrook' });
      else if (townOff > this.lastTownOff) {
        events.push({ kind: 'warn', text: `Rolling blackouts: ${townOff} of ${SUBSTATIONS[0].feeders} Millbrook districts dark` });
      }
    }
    this.lastTownOff = townOff;

    g.alarms = GRID_ALARMS.filter((a) => a.active(g)).map((a) => a.id);
    return { events, generatorTrip };
  }
}
