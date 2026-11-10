/**
 * Plant upgrades: bought from the tablet, built over game hours, then permanent.
 * Pure and serialisable. Effects are read by the other models via `has()`.
 */

export type UpgradeId =
  | 'turbineRetrofit' | 'coolingTower3' | 'dieselBackup' | 'autoRods' | 'stormHardening'
  | 'visitorCentre' | 'tieLine' | 'unit2';

export interface UpgradeDef {
  id: UpgradeId;
  name: string;
  effect: string;
  cost: number;
  /** Game hours to build. */
  hours: number;
  requires: UpgradeId[];
  /** Campaign act needed before it can be bought. */
  act: number;
}

export const UPGRADES: readonly UpgradeDef[] = [
  {
    id: 'turbineRetrofit', name: 'High-efficiency turbine retrofit', cost: 5_000_000, hours: 24, requires: [], act: 2,
    effect: 'New low-pressure blades: about 6% more electricity from the same steam.',
  },
  {
    id: 'coolingTower3', name: 'Third cooling tower', cost: 7_000_000, hours: 48, requires: [], act: 2,
    effect: 'A mechanical-draft tower: 25% more cooling capacity, so heatwaves and clogged intakes bite less.',
  },
  {
    id: 'dieselBackup', name: 'Emergency diesel generators', cost: 4_000_000, hours: 12, requires: [], act: 2,
    effect: 'Stronger auxiliary feedwater and safety injection. Inspectors like it (+5 at every inspection).',
  },
  {
    id: 'autoRods', name: 'Automatic rod control', cost: 5_000_000, hours: 18, requires: [], act: 2,
    effect: 'Holds coolant temperature on program automatically whenever the generator is on the grid, operator or not.',
  },
  {
    id: 'stormHardening', name: 'Storm-hardened lines', cost: 8_000_000, hours: 36, requires: [], act: 2,
    effect: 'Lightning arresters and new insulators: lightning trips substations and downs lines far less often.',
  },
  {
    id: 'visitorCentre', name: 'Visitor centre', cost: 3_000_000, hours: 24, requires: [], act: 2,
    effect: 'Tours and a café by the gate. Public opinion settles higher and recovers faster.',
  },
  {
    id: 'tieLine', name: 'City tie-line expansion', cost: 8_000_000, hours: 36, requires: [], act: 3,
    effect: 'Doubles the export capacity to the city: it will buy up to twice as much. Exports are cut first (no blackouts) when you are short.',
  },
  {
    id: 'unit2', name: 'Unit 2', cost: 20_000_000, hours: 96, requires: ['coolingTower3'], act: 3,
    effect: 'A second 950 MWe reactor unit with its own crew. Runs at a base-load setpoint you choose; Unit 1 covers the rest.',
  },
];

export const UPGRADE_BY_ID = Object.fromEntries(UPGRADES.map((u) => [u.id, u])) as Record<UpgradeId, UpgradeDef>;

export interface BuildState {
  started: number;
  done: number;
  complete: boolean;
}

export interface UpgradesState {
  builds: Partial<Record<UpgradeId, BuildState>>;
}

export function createUpgradesState(): UpgradesState {
  return { builds: {} };
}

export class Upgrades {
  constructor(readonly state: UpgradesState = createUpgradesState()) {}

  has(id: UpgradeId): boolean {
    return this.state.builds[id]?.complete === true;
  }

  building(id: UpgradeId): BuildState | null {
    const b = this.state.builds[id];
    return b && !b.complete ? b : null;
  }

  /** 0..1 build progress (1 when complete, 0 if not started). */
  progress(id: UpgradeId, t: number): number {
    const b = this.state.builds[id];
    if (!b) return 0;
    if (b.complete) return 1;
    return Math.min(1, Math.max(0, (t - b.started) / (b.done - b.started)));
  }

  /** Why it can't be bought right now, or null if it can. */
  blocker(id: UpgradeId, cash: number, act: number): string | null {
    const def = UPGRADE_BY_ID[id];
    if (this.state.builds[id]) return this.has(id) ? 'Built' : 'Under construction';
    if (act < def.act) return `Available in Act ${def.act}`;
    const missing = def.requires.filter((r) => !this.has(r));
    if (missing.length) return `Needs ${missing.map((m) => UPGRADE_BY_ID[m].name).join(', ')}`;
    if (cash < def.cost) return 'Not enough cash';
    return null;
  }

  /** Start building. The caller pays. */
  start(id: UpgradeId, t: number): void {
    const def = UPGRADE_BY_ID[id];
    this.state.builds[id] = { started: t, done: t + def.hours * 3600, complete: false };
  }

  /** Finish builds whose time has come. Returns the ones completed this step. */
  step(t: number): UpgradeId[] {
    const done: UpgradeId[] = [];
    for (const [id, b] of Object.entries(this.state.builds) as Array<[UpgradeId, BuildState]>) {
      if (!b.complete && t >= b.done) {
        b.complete = true;
        done.push(id);
      }
    }
    return done;
  }
}
