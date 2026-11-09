/** In-game clock. Deterministic: advanced only by the fixed simulation step. */
export const REAL_MINUTES_PER_DAY = 20;
export const SECONDS_PER_DAY = 86400;

export class GameClock {
  /** Game seconds since Day 1, 00:00. */
  seconds: number;
  /** Game seconds that pass per real second. */
  scale = SECONDS_PER_DAY / (REAL_MINUTES_PER_DAY * 60);

  constructor(startHour = 8) {
    this.seconds = startHour * 3600;
  }

  step(realDt: number): void {
    this.seconds += realDt * this.scale;
  }

  get day(): number {
    return Math.floor(this.seconds / SECONDS_PER_DAY) + 1;
  }

  /** Fractional hour of day, 0..24. */
  get hour(): number {
    return (this.seconds % SECONDS_PER_DAY) / 3600;
  }

  setHour(h: number): void {
    this.seconds = (this.day - 1) * SECONDS_PER_DAY + ((h % 24) + 24) % 24 * 3600;
  }

  format(): string {
    const h = Math.floor(this.hour);
    const m = Math.floor((this.hour - h) * 60);
    return `Day ${this.day} · ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
