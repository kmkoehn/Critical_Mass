import { describe, expect, it } from 'vitest';
import { createAnnunciatorState } from '../src/sim/annunciator';
import { createCampaignState } from '../src/sim/campaign';
import { createFaultState } from '../src/sim/faults';
import { Grid } from '../src/sim/grid';
import { createManagementState } from '../src/sim/management';
import { Reactor, createReactorState } from '../src/sim/reactor';
import { createStaffState } from '../src/sim/staff';
import { createUnit2State } from '../src/sim/unit2';
import { createUpgradesState } from '../src/sim/upgrades';
import { createWeatherState } from '../src/sim/weather';
import { SAVE_VERSION, SaveStore, decode, encode, migrate, type KeyValueStore, type SaveData } from '../src/save/save';
import { DEFAULT_SETTINGS, loadSettings, sanitize, saveSettings } from '../src/ui/settings';

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function sample(over: Partial<SaveData> = {}): SaveData {
  return {
    version: SAVE_VERSION, savedAt: 1000, label: 'Day 1 · 08:00 · Act 1', clockSeconds: 8 * 3600,
    reactor: createReactorState('fullPower'), grid: new Grid().state, weather: createWeatherState(),
    faults: createFaultState(), staff: createStaffState(), mgmt: createManagementState(), campaign: createCampaignState(),
    upgrades: createUpgradesState(), unit2: createUnit2State(), annunciator: createAnnunciatorState(),
    autopilot: { rng: 99, derating: false, stoppedForCrew: [] },
    player: { x: 1, y: 2, z: 3, yaw: 0.5, pitch: 0 }, vehicle: { x: 4, z: 5, yaw: 0 }, doseMSv: 0.2,
    ...over,
  };
}

describe('save games', () => {
  it('round-trip every model through JSON without loss', () => {
    const d = sample();
    const back = decode(encode(d));
    expect(back).toEqual(d);
  });

  it('a restored reactor carries on exactly like the original', () => {
    const a = new Reactor(createReactorState('fullPower'));
    for (let i = 0; i < 50; i++) a.step(0.1, 7.2);
    const b = new Reactor(decode(encode(sample({ reactor: a.state }))).reactor);
    for (let i = 0; i < 200; i++) {
      a.step(0.1, 7.2);
      b.step(0.1, 7.2);
    }
    expect(b.state).toEqual(a.state);
  });

  it('reject saves from newer versions and damaged files with a readable message', () => {
    expect(() => migrate({ ...sample(), version: SAVE_VERSION + 1 } as unknown as Record<string, unknown>)).toThrow(/newer version/);
    expect(() => decode('{not json')).toThrow(/damaged/);
    const { reactor: _r, ...noReactor } = sample();
    expect(() => decode(JSON.stringify(noReactor))).toThrow(/missing reactor/);
  });

  it('keep separate slots and know which is newest', () => {
    const store = new SaveStore(memoryStore());
    expect(store.latest()).toBeNull();
    expect(store.write('auto', sample({ savedAt: 10, label: 'auto' }))).toBeNull();
    expect(store.write('manual', sample({ savedAt: 5, label: 'manual' }))).toBeNull();
    expect(store.latest()).toBe('auto');
    expect(store.read('manual')?.label).toBe('manual');
    store.clear('auto');
    expect(store.latest()).toBe('manual');
  });

  it('list a damaged slot instead of failing', () => {
    const kv = memoryStore();
    kv.setItem('critical-mass.save.manual', '{"version":1}');
    const store = new SaveStore(kv);
    expect(store.list()).toEqual([{ slot: 'manual', error: expect.stringMatching(/damaged/) }]);
    expect(store.latest()).toBeNull();
  });

  it('report when storage is unavailable or full', () => {
    expect(new SaveStore(null).write('manual', sample())).toMatch(/unavailable/);
    const full = { ...memoryStore(), setItem: () => { throw new Error('QuotaExceeded'); } };
    expect(new SaveStore(full).write('manual', sample())).toMatch(/full or blocked/);
  });

  it('are small enough for localStorage', () => {
    expect(encode(sample()).length).toBeLessThan(200_000);
  });
});

describe('settings', () => {
  it('fall back to defaults and clamp bad values', () => {
    const kv = memoryStore();
    expect(loadSettings(kv)).toEqual(DEFAULT_SETTINGS);
    kv.setItem('critical-mass.settings', '{"sensitivity":9,"dayMinutes":13,"quality":"ultra","volume":-1}');
    const s = loadSettings(kv);
    expect(s.sensitivity).toBe(2.5);
    expect(s.dayMinutes).toBe(20);
    expect(s.quality).toBe('medium');
    expect(s.volume).toBe(0);
    kv.setItem('critical-mass.settings', 'garbage');
    expect(loadSettings(kv)).toEqual(DEFAULT_SETTINGS);
  });

  it('persist', () => {
    const kv = memoryStore();
    const s = sanitize({ ...DEFAULT_SETTINGS, quality: 'high', dayMinutes: 40, invertY: true });
    saveSettings(kv, s);
    expect(loadSettings(kv)).toEqual(s);
  });
});
