/**
 * Shift-operator autopilot: while a hired operator has the controls, follow grid
 * demand (or hold a setpoint) with the governor valve and keep T-avg on program
 * with small rod moves. Skill and fatigue set how quickly and how well they act.
 * Pure and deterministic. The operator never restarts a tripped reactor.
 */
import type { Grid } from './grid';
import type { Reactor } from './reactor';
import type { StaffMember, StaffState } from './staff';
import { rand } from './weather';

export interface AutopilotReport {
  active: boolean;
  /** Why it isn't running, for the HUD. */
  reason: string;
  events: string[];
}

/** T-avg program: 292 °C at no load rising to 305 °C at full power. */
export function tavgProgram(powerFrac: number): number {
  return 292 + 13 * Math.min(1, Math.max(0, powerFrac));
}

export class Autopilot {
  private valveTimer = 0;
  private rodTimer = 0;
  rng = 99;

  step(dt: number, reactor: Reactor, grid: Grid, staff: StaffState, op: StaffMember | null, suspended: boolean): AutopilotReport {
    const s = reactor.state;
    const ap = staff.autopilot;
    const events: string[] = [];
    if (!ap.enabled) return { active: false, reason: 'Autopilot off', events };
    if (!op) return { active: false, reason: 'No operator on shift', events };
    if (suspended) return { active: false, reason: `${op.name} standing by (you have the controls)`, events };
    if (s.scram.active) return { active: false, reason: `${op.name}: reactor tripped, waiting for you`, events };
    if (!s.generatorSynced) return { active: false, reason: `${op.name}: generator off-line`, events };

    const r = () => {
      const [v, n] = rand(this.rng);
      this.rng = n;
      return v;
    };
    // Slower and sloppier when less skilled or tired.
    const quality = Math.max(0.15, (op.skill / 5) * (1 - 0.6 * op.fatigue));
    const interval = 0.6 + (1 - quality) * 2.4;
    const mistakeChance = 0.03 * (1 - quality);

    this.valveTimer -= dt;
    if (this.valveTimer <= 0) {
      this.valveTimer = interval;
      const target = ap.mode === 'follow' ? grid.state.demandMW : ap.setpointMW;
      let err = target - s.electricalOutputMW;
      // Steam generators starving: back off.
      if (s.steamGeneratorLevel < 30) err = Math.min(err, -50);
      if (r() < mistakeChance) {
        err *= 3;
        events.push(`${op.name} overcorrected the turbine load`);
      }
      const step = Math.max(-0.02, Math.min(0.02, (err / 1000) * (0.4 + 0.6 * quality)));
      reactor.setGovernorValve(s.governorValve + step);
    }

    // Rods only trim slow drift (xenon, burnup). The reactor's own temperature feedback does
    // the load following, so rod moves are small and infrequent to avoid fighting it.
    this.rodTimer -= dt;
    if (this.rodTimer <= 0) {
      this.rodTimer = 6 + interval * 2;
      const tref = tavgProgram(s.electricalOutputMW / 1000);
      const dev = s.coolantTemp - tref;
      if (s.neutronFlux > 1.02) reactor.nudgeRods(0.3);
      else if (dev < -3 && s.startupRate < 0.1 && s.neutronFlux < 0.98) reactor.nudgeRods(-Math.min(0.3, 0.1 + 0.03 * (-dev - 3)));
      else if (dev > 3) reactor.nudgeRods(Math.min(0.5, 0.1 + 0.05 * (dev - 3)));
    }
    return { active: true, reason: `${op.name} has the controls`, events };
  }
}
