/**
 * Weather on the game clock. Pure and deterministic (seeded RNG kept in state).
 * Drives ambient and river temperature (grid demand, cooling capacity),
 * cloud/rain levels (visuals) and lightning (faults).
 */
import { SECONDS_PER_DAY } from './clock';

export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'thunderstorm' | 'heatwave' | 'coldsnap';

export const WEATHER_LABEL: Record<WeatherKind, string> = {
  clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', thunderstorm: 'Thunderstorm', heatwave: 'Heatwave', coldsnap: 'Cold snap',
};

interface KindDef {
  hours: [number, number];
  tempOffset: number;
  cloud: number;
  rain: number;
  next: Partial<Record<WeatherKind, number>>;
}

const KINDS: Record<WeatherKind, KindDef> = {
  clear: { hours: [4, 10], tempOffset: 0, cloud: 0.05, rain: 0, next: { clear: 0.3, cloudy: 0.3, rain: 0.12, thunderstorm: 0.1, heatwave: 0.1, coldsnap: 0.08 } },
  cloudy: { hours: [3, 8], tempOffset: -1, cloud: 0.6, rain: 0, next: { clear: 0.35, cloudy: 0.15, rain: 0.28, thunderstorm: 0.14, coldsnap: 0.08 } },
  rain: { hours: [2, 6], tempOffset: -3, cloud: 0.85, rain: 0.7, next: { cloudy: 0.4, clear: 0.25, rain: 0.15, thunderstorm: 0.2 } },
  thunderstorm: { hours: [1.5, 3.5], tempOffset: -2, cloud: 1, rain: 1, next: { rain: 0.5, cloudy: 0.3, clear: 0.2 } },
  heatwave: { hours: [10, 24], tempOffset: 14, cloud: 0, rain: 0, next: { clear: 0.45, thunderstorm: 0.35, heatwave: 0.2 } },
  coldsnap: { hours: [10, 24], tempOffset: -18, cloud: 0.4, rain: 0, next: { cloudy: 0.5, clear: 0.4, coldsnap: 0.1 } },
};

/** Lightning strikes per game hour in a thunderstorm. */
export const STRIKES_PER_HOUR = 10;

export interface WeatherState {
  kind: WeatherKind;
  nextChangeAt: number;
  ambientTemp: number;
  riverTemp: number;
  /** 0..1, smoothed. */
  cloud: number;
  rain: number;
  rng: number;
  /** Fractional strikes carried between steps. */
  strikeAcc: number;
}

/** Deterministic PRNG step on a state number (mulberry32). Returns [value 0..1, next state]. */
export function rand(state: number): [number, number] {
  const s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

function baseTemp(gameSeconds: number): number {
  const hour = (gameSeconds % SECONDS_PER_DAY) / 3600;
  return 16 + 6 * Math.sin((2 * Math.PI * (hour - 9)) / 24);
}

export function createWeatherState(seed = 1234, startSeconds = 8 * 3600): WeatherState {
  return {
    kind: 'clear', nextChangeAt: startSeconds + 6 * 3600,
    ambientTemp: baseTemp(startSeconds), riverTemp: 14, cloud: 0.05, rain: 0, rng: seed >>> 0, strikeAcc: 0,
  };
}

export class Weather {
  constructor(readonly state: WeatherState = createWeatherState()) {}

  private random(): number {
    const [v, s] = rand(this.state.rng);
    this.state.rng = s;
    return v;
  }

  /** Switch weather now (debug / scripted events). */
  force(kind: WeatherKind, gameSeconds: number): void {
    const def = KINDS[kind];
    this.state.kind = kind;
    this.state.nextChangeAt = gameSeconds + 3600 * (def.hours[0] + this.random() * (def.hours[1] - def.hours[0]));
  }

  /** Advance; returns how many lightning strikes happen this step. */
  step(gameSeconds: number, dtGame: number): { strikes: number; changed: WeatherKind | null } {
    const w = this.state;
    let changed: WeatherKind | null = null;
    if (gameSeconds >= w.nextChangeAt) {
      const prev = w.kind;
      const table = KINDS[w.kind].next;
      let r = this.random();
      let pick: WeatherKind = 'clear';
      for (const [k, p] of Object.entries(table) as Array<[WeatherKind, number]>) {
        pick = k;
        if ((r -= p) <= 0) break;
      }
      this.force(pick, gameSeconds);
      if (pick !== prev) changed = pick;
    }
    const def = KINDS[w.kind];
    const k = (tau: number) => 1 - Math.exp(-dtGame / tau);
    w.ambientTemp += (baseTemp(gameSeconds) + def.tempOffset - w.ambientTemp) * k(3600);
    w.riverTemp += (Math.max(2, w.ambientTemp - 3) - w.riverTemp) * k(24 * 3600);
    w.cloud += (def.cloud - w.cloud) * k(1200);
    w.rain += (def.rain - w.rain) * k(900);

    let strikes = 0;
    if (w.kind === 'thunderstorm') {
      w.strikeAcc += (STRIKES_PER_HOUR * dtGame) / 3600;
      while (w.strikeAcc >= 1) {
        w.strikeAcc -= 1;
        strikes++;
      }
    }
    return { strikes, changed };
  }
}
