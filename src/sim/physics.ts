/** Small pure physics helpers used by the reactor model. */

/**
 * Integral rod-worth curve: fraction of a bank's worth inserted at a given
 * insertion (0..1). S-shaped — rods are most effective mid-core.
 */
export function rodWorthFraction(insertion01: number): number {
  const x = Math.min(1, Math.max(0, insertion01));
  return x - Math.sin(2 * Math.PI * x) / (2 * Math.PI);
}

/** Inverse of rodWorthFraction by bisection. */
export function insertionForWorth(fraction: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (rodWorthFraction(mid) < fraction) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Saturation temperature of water at a pressure (MPa), fitted to steam tables over 1–17 MPa. */
export function saturationTemp(pMPa: number): number {
  return 187.6 * Math.pow(Math.max(pMPa, 0.01), 0.2224);
}

/** Inverse of saturationTemp. */
export function saturationPressure(tC: number): number {
  return Math.pow(Math.max(tC, 1) / 187.6, 1 / 0.2224);
}

/**
 * One-group point kinetics with the prompt-jump approximation.
 * `p` is the delayed-neutron precursor level, normalised so that at steady
 * critical power the neutron power equals p.
 */
export function neutronPower(p: number, rho: number, beta: number, source: number): number {
  return (beta * p + source) / (beta - rho);
}

/** Exact integration of dp/dt = λ(ρp + s)/(β − ρ) over dt (stable for any step size). */
export function precursorStep(p: number, rho: number, beta: number, lambda: number, source: number, dt: number): number {
  const denom = beta - rho;
  const a = (lambda * rho) / denom;
  const b = (lambda * source) / denom;
  if (Math.abs(a) < 1e-12) return p + b * dt;
  return (p + b / a) * Math.exp(a * dt) - b / a;
}

/** Fraction of the way to a target after dt with time constant tau. */
export function approach(tau: number, dt: number): number {
  return 1 - Math.exp(-dt / tau);
}
