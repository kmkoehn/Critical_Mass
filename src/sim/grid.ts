/**
 * Regional grid demand. Milestone 3 has the daily curve only; Milestone 4 adds
 * weather, the industrial park schedule, substations and blackouts.
 */

/** Demand on Riverbend in MW at a fractional hour of day (0..24). */
export function gridDemandMW(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  const bump = (centre: number, width: number) => Math.exp(-(((h - centre) / width) ** 2));
  // Overnight trough, morning ramp, working-day plateau, evening peak.
  return 520 + 230 * bump(9, 3.5) + 200 * bump(14, 4) + 300 * bump(19.5, 2.5);
}
