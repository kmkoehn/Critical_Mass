/**
 * Unit 2: once built, a second reactor unit run by its own crew. Modelled at the
 * plant level (not a full reactor sim): it commissions, ramps towards a setpoint
 * at a limited rate, and trips with grid disturbances, restarting a few hours later.
 */

export const UNIT2 = {
  maxMW: 950,
  /** Ramp rate, MW per game hour. */
  rampPerHour: 400,
  commissionHours: 6,
  restartHours: 4,
  fuelPerMWh: 8,
  overheadPerHour: 3_000,
};

export interface Unit2State {
  built: boolean;
  /** Game time it becomes available (commissioning / after a trip). */
  availableAt: number;
  outputMW: number;
  /** Base-load setpoint chosen on the tablet. */
  setpointMW: number;
  tripped: boolean;
}

export function createUnit2State(): Unit2State {
  return { built: false, availableAt: 0, outputMW: 0, setpointMW: 500, tripped: false };
}

export class Unit2 {
  constructor(readonly state: Unit2State = createUnit2State()) {}

  /** Construction finished: commission over the next few hours. */
  complete(t: number): void {
    this.state.built = true;
    this.state.availableAt = t + UNIT2.commissionHours * 3600;
  }

  get online(): boolean {
    return this.state.built && !this.state.tripped && this.state.outputMW > 0.5;
  }

  trip(t: number): void {
    if (!this.state.built || this.state.outputMW <= 0) return;
    this.state.tripped = true;
    this.state.outputMW = 0;
    this.state.availableAt = t + UNIT2.restartHours * 3600;
  }

  /**
   * Ramp towards the target. With Unit 1 on the grid, Unit 2 holds its base-load setpoint;
   * with Unit 1 off-line, it follows demand on its own.
   */
  step(t: number, dtGame: number, demandMW: number, unit1Online: boolean): void {
    const s = this.state;
    if (!s.built || t < s.availableAt) {
      s.outputMW = 0;
      return;
    }
    s.tripped = false;
    // Leave Unit 1 at least 150 MW of load so it isn't pushed into reverse power.
    const want = unit1Online ? Math.min(s.setpointMW, demandMW - 150) : demandMW;
    const target = Math.min(UNIT2.maxMW, Math.max(0, want));
    const maxStep = (UNIT2.rampPerHour * dtGame) / 3600;
    s.outputMW += Math.max(-maxStep, Math.min(maxStep, target - s.outputMW));
  }
}
