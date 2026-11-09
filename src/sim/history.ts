/** Trend recorder: samples key plant values on the game clock into a ring buffer. Pure. */
import type { ReactorState } from './reactor';
import { averageRodInsertion } from './reactor';

export interface TrendSample {
  /** Game seconds. */
  t: number;
  /** log10 of neutron flux (fraction of rated). */
  logFlux: number;
  powerPct: number;
  startupRate: number;
  coolantTemp: number;
  pressure: number;
  electricalMW: number;
  demandMW: number;
  xenon: number;
  rods: number;
  turbineRPM: number;
}

export const TREND_INTERVAL_S = 15; // game seconds between samples
export const TREND_CAPACITY = (12 * 3600) / TREND_INTERVAL_S; // 12 game hours

export class TrendRecorder {
  readonly samples: TrendSample[] = [];
  private nextAt = 0;

  record(gameSeconds: number, s: ReactorState, demandMW: number): void {
    if (gameSeconds < this.nextAt) return;
    this.nextAt = gameSeconds + TREND_INTERVAL_S;
    this.samples.push({
      t: gameSeconds,
      logFlux: Math.log10(Math.max(1e-10, s.neutronFlux)),
      powerPct: (s.thermalPowerMW / 3000) * 100,
      startupRate: s.startupRate,
      coolantTemp: s.coolantTemp,
      pressure: s.primaryPressure,
      electricalMW: s.electricalOutputMW,
      demandMW,
      xenon: s.xenonLevel,
      rods: averageRodInsertion(s),
      turbineRPM: s.turbineRPM,
    });
    if (this.samples.length > TREND_CAPACITY) this.samples.splice(0, this.samples.length - TREND_CAPACITY);
  }

  /** Samples within the last `windowS` game seconds. */
  window(nowGameSeconds: number, windowS: number): TrendSample[] {
    const from = nowGameSeconds - windowS;
    let i = this.samples.length;
    while (i > 0 && this.samples[i - 1].t >= from) i--;
    return this.samples.slice(i);
  }

  clear(): void {
    this.samples.length = 0;
    this.nextAt = 0;
  }
}
