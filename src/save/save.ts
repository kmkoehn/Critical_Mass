/**
 * Save games: a versioned JSON snapshot of every simulation model plus where the player is.
 * Stored in localStorage (any Storage-like object, so tests can use a Map).
 */
import type { AnnunciatorState } from '../sim/annunciator';
import type { AutopilotSnapshot } from '../sim/autopilot';
import type { CampaignState } from '../sim/campaign';
import type { FaultState } from '../sim/faults';
import type { GridState } from '../sim/grid';
import type { ManagementState } from '../sim/management';
import type { ReactorState } from '../sim/reactor';
import type { StaffState } from '../sim/staff';
import type { Unit2State } from '../sim/unit2';
import type { UpgradesState } from '../sim/upgrades';
import type { WeatherState } from '../sim/weather';

export const SAVE_VERSION = 1;
const PREFIX = 'critical-mass.save.';

export type SlotId = 'auto' | 'manual';
export const SLOTS: readonly SlotId[] = ['manual', 'auto'];

export interface SaveData {
  version: number;
  /** Real time the save was written (ms since epoch). */
  savedAt: number;
  /** Short description for the menu, e.g. "Day 3 · 14:20 · Act 2". */
  label: string;
  clockSeconds: number;
  reactor: ReactorState;
  grid: GridState;
  weather: WeatherState;
  faults: FaultState;
  staff: StaffState;
  mgmt: ManagementState;
  campaign: CampaignState;
  upgrades: UpgradesState;
  unit2: Unit2State;
  annunciator: AnnunciatorState;
  autopilot: AutopilotSnapshot;
  player: { x: number; y: number; z: number; yaw: number; pitch: number };
  vehicle: { x: number; z: number; yaw: number };
  doseMSv: number;
}

/** The minimal Storage surface we use (localStorage satisfies it). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Upgrade older save formats to the current one. Each step handles one version bump. */
const MIGRATIONS: Record<number, (d: Record<string, unknown>) => Record<string, unknown>> = {
  // 1 → 2 will go here when the format changes.
};

export function migrate(raw: Record<string, unknown>): SaveData {
  let d = raw;
  let v = typeof d.version === 'number' ? d.version : 0;
  if (v > SAVE_VERSION) throw new Error(`This save is from a newer version of the game (format ${v}).`);
  while (v < SAVE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`Can't read save format ${v}.`);
    d = step(d);
    v = d.version as number;
  }
  for (const k of ['reactor', 'grid', 'weather', 'faults', 'staff', 'mgmt', 'campaign', 'upgrades', 'unit2', 'player']) {
    if (typeof d[k] !== 'object' || d[k] === null) throw new Error(`Save is damaged (missing ${k}).`);
  }
  return d as unknown as SaveData;
}

/** Deep copy through JSON, so the snapshot doesn't alias live state. */
export function encode(data: SaveData): string {
  return JSON.stringify(data);
}

export function decode(json: string): SaveData {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Save is damaged (not valid JSON).');
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('Save is damaged.');
  return migrate(raw as Record<string, unknown>);
}

export class SaveStore {
  constructor(private readonly store: KeyValueStore | null) {}

  write(slot: SlotId, data: SaveData): string | null {
    if (!this.store) return 'Saving is unavailable in this browser.';
    try {
      this.store.setItem(PREFIX + slot, encode(data));
      return null;
    } catch {
      return 'Could not save (browser storage full or blocked).';
    }
  }

  read(slot: SlotId): SaveData | null {
    const json = this.store?.getItem(PREFIX + slot);
    if (!json) return null;
    return decode(json);
  }

  /** Slot summaries for the menu; damaged saves show their error. */
  list(): Array<{ slot: SlotId; label: string; savedAt: number } | { slot: SlotId; error: string }> {
    const out: Array<{ slot: SlotId; label: string; savedAt: number } | { slot: SlotId; error: string }> = [];
    for (const slot of SLOTS) {
      try {
        const d = this.read(slot);
        if (d) out.push({ slot, label: d.label, savedAt: d.savedAt });
      } catch (e) {
        out.push({ slot, error: (e as Error).message });
      }
    }
    return out;
  }

  /** Most recent readable save, for "Continue". */
  latest(): SlotId | null {
    let best: { slot: SlotId; savedAt: number } | null = null;
    for (const s of this.list()) if ('savedAt' in s && (!best || s.savedAt > best.savedAt)) best = s;
    return best?.slot ?? null;
  }

  clear(slot: SlotId): void {
    this.store?.removeItem(PREFIX + slot);
  }
}

/** localStorage, or null where it's blocked (private mode, sandboxed frames). */
export function browserStore(): KeyValueStore | null {
  try {
    const s = window.localStorage;
    const k = PREFIX + '__probe';
    s.setItem(k, '1');
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}
