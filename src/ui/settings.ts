/** Player settings, remembered in localStorage separately from save games. */
import type { KeyValueStore } from '../save/save';

export type Quality = 'low' | 'medium' | 'high';

export interface Settings {
  /** Mouse look multiplier, 0.3..2.5. */
  sensitivity: number;
  invertY: boolean;
  /** Real minutes per game day: 10, 20, 40 or 60. */
  dayMinutes: number;
  quality: Quality;
  /** Master volume 0..1. */
  volume: number;
  /** Autosave every few game hours. */
  autosave: boolean;
  /** Lower the render resolution automatically when the frame rate drops. */
  adaptiveResolution: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sensitivity: 1, invertY: false, dayMinutes: 20, quality: 'medium', volume: 0.8, autosave: true, adaptiveResolution: true,
};

export const DAY_LENGTHS = [10, 20, 40, 60] as const;

const KEY = 'critical-mass.settings';

export function loadSettings(store: KeyValueStore | null): Settings {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return sanitize({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(store: KeyValueStore | null, s: Settings): void {
  try {
    store?.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage blocked: settings just won't persist */
  }
}

export function sanitize(s: Settings): Settings {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    sensitivity: Math.min(2.5, Math.max(0.3, num(s.sensitivity, 1))),
    invertY: s.invertY === true,
    dayMinutes: (DAY_LENGTHS as readonly number[]).includes(s.dayMinutes) ? s.dayMinutes : 20,
    quality: (['low', 'medium', 'high'] as const).includes(s.quality) ? s.quality : 'medium',
    volume: Math.min(1, Math.max(0, num(s.volume, 0.8))),
    autosave: s.autosave !== false,
    adaptiveResolution: s.adaptiveResolution !== false,
  };
}

/** Renderer settings per quality level. */
export const QUALITY: Record<Quality, { pixelRatio: number; shadows: boolean; shadowMap: number; antialias: boolean; drawDistance: number }> = {
  low: { pixelRatio: 0.75, shadows: false, shadowMap: 1024, antialias: false, drawDistance: 1600 },
  medium: { pixelRatio: 1, shadows: true, shadowMap: 1024, antialias: true, drawDistance: 2800 },
  high: { pixelRatio: 1.5, shadows: true, shadowMap: 2048, antialias: true, drawDistance: 4500 },
};
