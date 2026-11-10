/**
 * The campaign: three acts of objectives (with hints and waypoints), scripted events,
 * achievements, fast-travel unlocks, the win and the ways to lose.
 * Pure: it reads the other models through a context and asks the game to run scripted
 * events via the returned actions.
 */
import type { GridState } from './grid';
import type { ManagementState } from './management';
import { ledgerNet } from './management';
import type { ReactorState } from './reactor';
import type { StaffState } from './staff';
import type { Unit2State } from './unit2';
import type { UpgradesState } from './upgrades';
import type { WeatherState } from './weather';
import {
  BRIDGE, FIELD_POINTS, LOOKOUT, PLANT_LAYOUT, SUBSTATION_SITES, TOWN_SQUARE, type SubstationId,
} from '../world/layout';

export interface CampaignContext {
  t: number;
  player: { x: number; y: number; z: number; insideControlRoom: boolean; lookoutDeckY: number };
  reactor: ReactorState;
  grid: GridState;
  staff: StaffState;
  mgmt: ManagementState;
  upgrades: UpgradesState;
  unit2: Unit2State;
  weather: WeatherState;
}

export interface Marker {
  x: number;
  z: number;
  /** Height above ground for the 3D waypoint (e.g. a console inside the control room). */
  y?: number;
}

interface ObjectiveDef {
  id: string;
  text: string;
  hint: string;
  marker?: Marker;
  check: (c: CampaignContext, s: CampaignState) => boolean;
}

export interface ActDef {
  n: number;
  title: string;
  intro: string;
  /** Objectives must be done in order (the tutorial) or in any order. */
  ordered: boolean;
  objectives: ObjectiveDef[];
  outro: string;
}

export type GameOverKind = 'meltdown' | 'bankrupt' | 'licence';

export interface CampaignState {
  /** 1..3, then 4 = sandbox. */
  act: number;
  done: string[];
  actStartedAt: number;
  won: boolean;
  wonAt: number;
  gameOver: null | { kind: GameOverKind; t: number };
  achievements: string[];
  /** Fast-travel destinations unlocked by visiting them. */
  visited: string[];
  everShedWhileOnline: boolean;
  firstCriticalAt: number;
  script: {
    stormAt: number;
    stormSeen: boolean;
    inspectionPulled: boolean;
    heatwaveAt: number;
    heatwaveEndsAt: number;
    heatwaveServed0: number;
    heatwaveUnserved0: number;
    heatwaveFailures: number;
  };
  lastSandboxGrowthDay: number;
}

export function createCampaignState(): CampaignState {
  return {
    act: 1, done: [], actStartedAt: 0, won: false, wonAt: 0, gameOver: null, achievements: [],
    visited: ['plant', 'controlRoom'], everShedWhileOnline: false, firstCriticalAt: -1,
    script: {
      stormAt: -1, stormSeen: false, inspectionPulled: false,
      heatwaveAt: -1, heatwaveEndsAt: -1, heatwaveServed0: 0, heatwaveUnserved0: 0, heatwaveFailures: 0,
    },
    lastSandboxGrowthDay: 0,
  };
}

const CR = PLANT_LAYOUT.controlRoom;
const CONSOLE = {
  door: { x: CR.cx, z: CR.cz - CR.d / 2 - 1 },
  primary: { x: CR.cx - 7.5, z: CR.cz + 2.5, y: 3 },
  reactor: { x: CR.cx, z: CR.cz + 2.5, y: 3 },
  turbine: { x: CR.cx + 7.5, z: CR.cz + 2.5, y: 3 },
  grid: { x: CR.cx - 13.5, z: CR.cz + 6.5, y: 3 },
};
const synced = (c: CampaignContext) => c.reactor.generatorSynced;
const upgradeDone = (c: CampaignContext, id: keyof UpgradesState['builds']) => c.upgrades.builds[id]?.complete === true;

export const ACTS: readonly ActDef[] = [
  {
    n: 1, title: 'Act 1 · Cold Start', ordered: true,
    intro: 'Riverbend has sat cold for years and Millbrook is dark. Bring Unit 1 back to life.',
    outro: 'Millbrook has power again. The board is cautiously impressed.',
    objectives: [
      {
        id: 'walk', text: 'Walk to the Unit 1 control room', marker: CONSOLE.door,
        hint: 'The low building just south of the plant road, with its door on the north side. Follow the beacon.',
        check: (c) => c.player.insideControlRoom,
      },
      {
        id: 'pumps', text: 'Start all four reactor coolant pumps', marker: CONSOLE.primary,
        hint: 'Primary Loop panel (left console, press E) → Start all.',
        check: (c) => c.reactor.coolantPumps.every((p) => p.speed > 0.9),
      },
      {
        id: 'critical', text: 'Withdraw rods until the reactor is critical', marker: CONSOLE.reactor,
        hint: 'Reactor panel → OUT 1 until reactivity is near −500 pcm, then OUT 0.2. Keep the startup rate under 1.5 decades/min or it trips.',
        check: (c) => c.reactor.neutronFlux > 1e-5 && c.reactor.startupRate > 0.2 && !c.reactor.scram.active,
      },
      {
        id: 'heat', text: 'Heat the plant to 280 °C', marker: CONSOLE.reactor,
        hint: 'Let power climb to about 10%, then keep withdrawing rods (OUT 0.2) as it warms. Hotter water takes reactivity away. Takes a few minutes.',
        check: (c) => c.reactor.coolantTemp >= 280,
      },
      {
        id: 'speed', text: 'Bring the turbine up to 3600 rpm', marker: CONSOLE.turbine,
        hint: 'Turbine & Grid panel (right console) → "Set 3600 rpm", then wait for the turbine to spin up.',
        check: (c) => Math.abs(c.reactor.turbineRPM - 3600) < 18,
      },
      {
        id: 'sync', text: 'Synchronise the generator to the grid', marker: CONSOLE.turbine,
        hint: 'When the in-window lamp lights, press SYNC GENERATOR.',
        check: synced,
      },
      {
        id: 'town', text: 'Power every district of Millbrook', marker: CONSOLE.grid,
        hint: 'Raise the governor valve (+5%) until supply covers demand. Grid Dispatch (west wall) shows which districts are dark.',
        check: (c) => synced(c) && !c.grid.dead && c.grid.subs.town.feedersOff.length === 0,
      },
    ],
  },
  {
    n: 2, title: 'Act 2 · Keeping the Lights On', ordered: false,
    intro: 'Running a plant is more than starting it. Build a team, win customers, and survive whatever the valley throws at you.',
    outro: 'Riverbend is a going concern. Time to think bigger.',
    objectives: [
      {
        id: 'hireOp', text: 'Hire a shift operator',
        hint: 'Tab → Staff. An operator keeps output matched to demand while you are out of the control room.',
        check: (c) => c.staff.members.some((m) => m.role === 'operator'),
      },
      {
        id: 'hireCrew', text: 'Hire a maintenance or line crew',
        hint: 'Tab → Staff. Crews fix faults for you. Line crews do substations and power lines.',
        check: (c) => c.staff.members.some((m) => m.role === 'maintenance' || m.role === 'lineCrew'),
      },
      {
        id: 'industry', text: 'Sign a supply contract with the Industrial Park',
        hint: 'Tab → Contracts. A steady customer on weekdays — but missed deliveries cost penalties.',
        check: (c) => c.mgmt.contracts.some((k) => k.sub === 'industrial'),
      },
      {
        id: 'storm', text: 'Ride out the first big storm',
        hint: 'Forecasters expect a thunderstorm. Keep the plant on the grid and fix (or send crews to) whatever lightning breaks.',
        check: (c, s) => s.script.stormSeen && c.weather.kind !== 'thunderstorm' && synced(c),
      },
      {
        id: 'inspection', text: 'Pass a regulator inspection',
        hint: 'Inspectors are coming. Acknowledge alarms, fix faults, keep the control room staffed and never bypass safeties.',
        check: (c, s) => c.mgmt.regulator.reports.some((r) => r.passed && r.t >= s.actStartedAt),
      },
      {
        id: 'profit', text: 'Close a day in profit',
        hint: 'Sell more than you spend. Wages, fuel and site overheads add up — check Tab → Finances.',
        // A day that ended after the act began.
        check: (c, s) => c.mgmt.history.some((h) => h.day * 86400 > s.actStartedAt && ledgerNet(h.ledger) > 0),
      },
    ],
  },
  {
    n: 3, title: 'Act 3 · Expansion', ordered: false,
    intro: 'The city wants clean power and Riverbend has room to grow. Expand — and keep the valley lit when the heat comes.',
    outro: 'Two units, a city contract and a valley that trusts you. Riverbend is thriving.',
    objectives: [
      {
        id: 'upgrades', text: 'Complete two plant upgrades',
        hint: 'Tab → Upgrades. A third cooling tower is needed before Unit 2 anyway.',
        check: (c) => Object.entries(c.upgrades.builds).filter(([id, b]) => b?.complete && id !== 'unit2' && id !== 'tieLine').length >= 2,
      },
      {
        id: 'tieLine', text: 'Expand the city tie-line',
        hint: 'Tab → Upgrades. Doubles what the city can take from you.',
        check: (c) => upgradeDone(c, 'tieLine'),
      },
      {
        id: 'unit2', text: 'Build and start Unit 2',
        hint: 'Tab → Upgrades. $20M — borrow if you must (Finances). It commissions itself a few hours after construction.',
        check: (c) => c.unit2.built && c.unit2.outputMW > 1,
      },
      {
        id: 'city', text: 'Sign the City Grid Authority contract',
        hint: 'Tab → Contracts. The big one: high price, high penalties.',
        check: (c) => c.mgmt.contracts.some((k) => k.sub === 'city'),
      },
      {
        id: 'heatwave', text: 'Keep the lights on through the heatwave',
        hint: 'A heatwave will hit once Unit 2 and the tie-line are up: demand soars and cooling suffers. Keep at least 97% of homes and businesses supplied until it breaks (city exports don\'t count).',
        check: (c, s) => s.script.heatwaveEndsAt > 0 && c.t >= s.script.heatwaveEndsAt && s.done.includes('heatwave-ok'),
      },
    ],
  },
];

export interface Achievement {
  id: string;
  name: string;
  text: string;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'tourist', name: 'Local knowledge', text: 'Visit the bridge, the town square and the Lookout Hill tower.' },
  { id: 'handsOn', name: 'Hands on', text: 'Fix five faults in person.' },
  { id: 'lineman', name: 'Storm chaser', text: 'Reset a tripped substation breaker yourself.' },
  { id: 'cleanRecord', name: 'Clean record', text: 'Pass five inspections without a single failure.' },
  { id: 'noScram30', name: 'Steady hand', text: '30 game days without a reactor trip.' },
  { id: 'tycoon', name: 'Tycoon', text: 'Hold $50M in cash.' },
  { id: 'neverBlackout', name: 'Never caused a blackout', text: 'Win without ever shedding load while you were on the grid.' },
];

/** Fast-travel destinations, unlocked by visiting. */
export const TRAVEL_POINTS: ReadonlyArray<{ id: string; name: string; x: number; z: number; yaw: number }> = [
  { id: 'plant', name: 'Plant gate', x: PLANT_LAYOUT.gate.x - 12, z: 12, yaw: Math.PI / 2 },
  { id: 'controlRoom', name: 'Control room door', x: CR.cx, z: CR.cz - CR.d / 2 - 3, yaw: Math.PI },
  { id: 'town', name: 'Millbrook town square', x: TOWN_SQUARE.x, z: TOWN_SQUARE.z, yaw: Math.PI },
  { id: 'lookout', name: 'Lookout Hill', x: 528, z: -500, yaw: 0 },
  { id: 'intake', name: 'River intake', x: FIELD_POINTS.intake.x - 30, z: FIELD_POINTS.intake.z, yaw: -Math.PI / 2 },
  ...(Object.keys(SUBSTATION_SITES) as SubstationId[]).map((id) => ({
    id: `sub:${id}`, name: SUBSTATION_SITES[id].name, x: SUBSTATION_SITES[id].x, z: SUBSTATION_SITES[id].z + 20, yaw: 0,
  })),
];

export interface CampaignEvent {
  kind: 'info' | 'good' | 'warn' | 'danger';
  text: string;
}

/** Things the campaign asks the game to make happen. */
export interface CampaignActions {
  forceWeather?: { kind: 'thunderstorm' | 'heatwave'; hours: number };
  pullInspectionTo?: number;
  demandGrowth?: number;
  /** Cash handed to the company (the Act 3 expansion grant). */
  grant?: number;
  win?: boolean;
}

/** The Ash Valley Development Board's grant when the expansion act opens, $. */
export const EXPANSION_GRANT = 15_000_000;

export class Campaign {
  constructor(readonly state: CampaignState = createCampaignState()) {}

  get actDef(): ActDef | null {
    return ACTS[this.state.act - 1] ?? null;
  }

  /** Current objectives with done flags, for the HUD. */
  objectives(): Array<{ id: string; text: string; hint: string; done: boolean; marker?: Marker }> {
    const a = this.actDef;
    if (!a) return [];
    return a.objectives.map((o) => ({ id: o.id, text: o.text, hint: o.hint, marker: o.marker, done: this.state.done.includes(o.id) }));
  }

  /** The objective to point the player at (first not done). */
  current(): { text: string; hint: string; marker?: Marker } | null {
    return this.objectives().find((o) => !o.done) ?? null;
  }

  private unlock(id: string, events: CampaignEvent[]): void {
    if (this.state.achievements.includes(id)) return;
    this.state.achievements.push(id);
    const a = ACHIEVEMENTS.find((x) => x.id === id)!;
    events.push({ kind: 'good', text: `Achievement: ${a.name} — ${a.text}` });
  }

  private startAct(n: number, c: CampaignContext, events: CampaignEvent[], actions: CampaignActions): void {
    const s = this.state;
    s.act = n;
    s.actStartedAt = c.t;
    const a = this.actDef;
    if (a) {
      events.push({ kind: 'info', text: `${a.title}: ${a.intro}` });
      if (n === 2) {
        s.script.stormAt = c.t + 5 * 3600;
        // Bring the first inspection forward so the act doesn't drag.
        actions.pullInspectionTo = c.t + 12 * 3600;
      }
      if (n === 3) {
        actions.grant = EXPANSION_GRANT;
        events.push({ kind: 'good', text: `The Ash Valley Development Board backs the expansion with a $${EXPANSION_GRANT / 1e6}M grant.` });
      }
    } else {
      events.push({ kind: 'good', text: 'Sandbox: the valley keeps growing. Demand rises a little every day.' });
    }
  }

  step(c: CampaignContext): { events: CampaignEvent[]; actions: CampaignActions } {
    const s = this.state;
    const events: CampaignEvent[] = [];
    const actions: CampaignActions = {};
    if (s.gameOver) return { events, actions };
    if (s.actStartedAt === 0 && s.act === 1 && s.done.length === 0 && c.t > 0) s.actStartedAt = c.t;

    // ---------------- losing
    if (c.reactor.meltdown) s.gameOver = { kind: 'meltdown', t: c.t };
    else if (c.mgmt.bankrupt) s.gameOver = { kind: 'bankrupt', t: c.t };
    else if (c.mgmt.regulator.licenseRevoked) s.gameOver = { kind: 'licence', t: c.t };
    if (s.gameOver) return { events, actions };

    // ---------------- places visited (fast travel, the tourist achievement)
    const p = c.player;
    for (const tp of TRAVEL_POINTS) {
      if (!s.visited.includes(tp.id) && Math.hypot(p.x - tp.x, p.z - tp.z) < 30) {
        s.visited.push(tp.id);
        events.push({ kind: 'info', text: `Fast travel unlocked: ${tp.name} (press M)` });
      }
    }
    const onBridge = p.x > BRIDGE.x0 + 20 && p.x < BRIDGE.x1 - 20 && Math.abs(p.z - BRIDGE.z) < BRIDGE.halfWidth;
    if (onBridge && !s.visited.includes('bridge')) s.visited.push('bridge');
    if (Math.hypot(p.x - LOOKOUT.x, p.z - LOOKOUT.z) < 5 && p.y > p.lookoutDeckY - 0.4 && !s.visited.includes('lookoutDeck')) s.visited.push('lookoutDeck');
    if (['bridge', 'town', 'lookoutDeck'].every((v) => s.visited.includes(v))) this.unlock('tourist', events);

    // ---------------- achievements and records
    if (c.reactor.neutronFlux > 1e-3 && s.firstCriticalAt < 0) s.firstCriticalAt = c.t;
    if (c.reactor.generatorSynced && c.grid.shedFraction > 0) s.everShedWhileOnline = true;
    if (c.mgmt.repairsByPlayer >= 5) this.unlock('handsOn', events);
    if (c.mgmt.breakersResetByPlayer >= 1) this.unlock('lineman', events);
    if (c.mgmt.regulator.failures === 0 && c.mgmt.regulator.reports.filter((r) => r.passed).length >= 5) this.unlock('cleanRecord', events);
    const since = Math.max(s.firstCriticalAt, c.mgmt.lastTripAt);
    if (s.firstCriticalAt >= 0 && c.t - since >= 30 * 86400) this.unlock('noScram30', events);
    if (c.mgmt.cash >= 50_000_000) this.unlock('tycoon', events);

    // ---------------- scripted events
    const sc = s.script;
    if (c.weather.kind === 'thunderstorm' && s.act === 2) sc.stormSeen = true;
    if (sc.stormAt > 0 && c.t >= sc.stormAt) {
      sc.stormAt = -1;
      actions.forceWeather = { kind: 'thunderstorm', hours: 2.5 };
      events.push({ kind: 'warn', text: 'A severe thunderstorm is rolling into the valley.' });
    }
    if (s.act === 3 && sc.heatwaveAt < 0 && c.unit2.built && c.unit2.outputMW > 1 && upgradeDone(c, 'tieLine')) {
      sc.heatwaveAt = c.t + 6 * 3600;
      events.push({ kind: 'warn', text: 'Forecast: a record heatwave arrives in about 6 hours. Demand will soar.' });
    }
    if (sc.heatwaveAt > 0 && c.t >= sc.heatwaveAt && sc.heatwaveEndsAt < 0) {
      actions.forceWeather = { kind: 'heatwave', hours: 24 };
      sc.heatwaveEndsAt = c.t + 24 * 3600;
      sc.heatwaveServed0 = c.grid.stats.firmServedMWh;
      sc.heatwaveUnserved0 = c.grid.stats.firmUnservedMWh;
      events.push({ kind: 'warn', text: 'The heatwave has arrived. Keep at least 97% of demand served for the next 24 hours.' });
    }
    if (sc.heatwaveEndsAt > 0 && c.t >= sc.heatwaveEndsAt && !s.done.includes('heatwave-ok')) {
      const served = c.grid.stats.firmServedMWh - sc.heatwaveServed0;
      const unserved = c.grid.stats.firmUnservedMWh - sc.heatwaveUnserved0;
      const share = served / Math.max(1, served + unserved);
      if (share >= 0.97) {
        s.done.push('heatwave-ok');
        events.push({ kind: 'good', text: `The heatwave has broken. You served ${(share * 100).toFixed(1)}% of demand through it.` });
      } else {
        sc.heatwaveFailures++;
        sc.heatwaveAt = c.t + 2 * 86400;
        sc.heatwaveEndsAt = -1;
        events.push({ kind: 'danger', text: `Only ${(share * 100).toFixed(1)}% of demand served during the heatwave. Another is forecast in two days.` });
      }
    }

    // ---------------- objectives
    const a = this.actDef;
    if (a) {
      for (const o of a.objectives) {
        if (s.done.includes(o.id)) continue;
        if (o.check(c, s)) {
          s.done.push(o.id);
          events.push({ kind: 'good', text: `Objective complete: ${o.text}` });
        } else if (a.ordered) {
          break;
        }
      }
      if (a.objectives.every((o) => s.done.includes(o.id))) {
        events.push({ kind: 'good', text: a.outro });
        if (a.n === 3) {
          s.won = true;
          s.wonAt = c.t;
          if (!s.everShedWhileOnline) this.unlock('neverBlackout', events);
          actions.win = true;
        }
        this.startAct(a.n + 1, c, events, actions);
      }
    } else {
      // Sandbox: demand grows 2% a day.
      const day = Math.floor(c.t / 86400);
      if (day > s.lastSandboxGrowthDay) {
        s.lastSandboxGrowthDay = day;
        actions.demandGrowth = 1.02;
      }
    }
    return { events, actions };
  }
}

export const GAME_OVER_TEXT: Record<GameOverKind, { title: string; body: string }> = {
  meltdown: {
    title: 'Core meltdown',
    body: 'Fuel has melted in Unit 1. Sirens wail across the valley as Millbrook is evacuated. Riverbend will never run again.',
  },
  bankrupt: {
    title: 'Bankrupt',
    body: 'A week in the red was too much for the board. The lights at Riverbend go out for good, and the plant is put up for sale.',
  },
  licence: {
    title: 'Licence revoked',
    body: 'After three failed inspections, the Office of Nuclear Safety has revoked Riverbend\'s operating licence.',
  },
};
