/**
 * Simplified pressurized-water reactor plant model. Pure TypeScript, no rendering.
 *
 * Chain: control rods + xenon + temperature → reactivity → neutron power
 * → core heat → reactor coolant → steam generator → turbine / steam dumps → condenser
 * → river cooling water. A reactor protection system trips (SCRAMs) the reactor when
 * setpoints are exceeded, unless the player has turned the safety-bypass key.
 *
 * Deterministic: the same commands and steps always give the same state.
 */
import { SIM_CONFIG as C } from './config';
import {
  approach, insertionForWorth, neutronPower, precursorStep, rodWorthFraction, saturationPressure, saturationTemp,
} from './physics';
import { activeAlarms } from './alarms';

export type TripCause =
  | 'manual' | 'highFlux' | 'startupRate' | 'highPressure' | 'lowPressure'
  | 'lowFlow' | 'highCoreTemp' | 'lowSgLevel' | 'turbineTrip';

export const TRIP_LABELS: Record<TripCause, string> = {
  manual: 'manual SCRAM',
  highFlux: 'high neutron flux',
  startupRate: 'high startup rate',
  highPressure: 'high primary pressure',
  lowPressure: 'low primary pressure',
  lowFlow: 'low coolant flow',
  highCoreTemp: 'high core temperature',
  lowSgLevel: 'low steam generator level',
  turbineTrip: 'turbine trip at power',
};

export type ReactorStatus = 'OFFLINE' | 'CRITICAL' | 'AT POWER' | 'SCRAMMED' | 'ALARM' | 'MELTDOWN';
export type AuxFeedMode = 'auto' | 'on' | 'off';

export interface Environment {
  ambientTemp: number;
  riverTemp: number;
}
export const DEFAULT_ENV: Environment = { ambientTemp: 18, riverTemp: 15 };

export interface ReactorEvent {
  kind: 'info' | 'good' | 'warn' | 'danger';
  text: string;
  time: number;
}

export interface Pump {
  on: boolean;
  /** 0..1, follows `on` with spin-up / coast-down. */
  speed: number;
}

export interface ReactivityParts {
  rods: number;
  fuel: number;
  temperature: number;
  xenon: number;
  total: number;
}

export interface ReactorState {
  /** Real seconds simulated. */
  time: number;

  // ---- controls
  /** Actual rod bank insertion, % (0 = withdrawn, 100 = fully in). Banks A–D. */
  rodBanks: number[];
  rodTargets: number[];
  scram: { active: boolean; cause: TripCause | null; time: number | null };
  safetyBypass: boolean;
  coolantPumps: Pump[];
  feedPumps: boolean[];
  auxFeed: AuxFeedMode;
  intakePumps: boolean[];
  towerFans: number;
  pressurizerAuto: boolean;
  turbineSpeedTarget: number;
  /** Governor valve opening 0..1 (manual load control once synced). */
  governorValve: number;
  turbineTripped: boolean;
  generatorSynced: boolean;

  // ---- nuclear
  precursors: number;
  /** Fission power as a fraction of rated (the "neutron flux" reading). */
  neutronFlux: number;
  reactivity: ReactivityParts;
  /** Decades per minute; positive while power is rising. */
  startupRate: number;
  decayGroups: number[];
  iodine: number;
  /** Xenon relative to the full-power equilibrium level. */
  xenonLevel: number;
  burnupMWd: number;

  // ---- thermal-hydraulics
  coreTemp: number;
  coolantTemp: number;
  hotLegTemp: number;
  coldLegTemp: number;
  secondaryTemp: number;
  primaryPressure: number;
  primaryInventory: number;
  coolantFlow: number;
  subcooling: number;
  boiling: boolean;
  steamGeneratorLevel: number;
  auxFeedRunning: boolean;
  safetyInjection: boolean;
  porvOpen: boolean;
  steamDump: number;
  steamReliefOpen: boolean;

  // ---- outputs
  thermalPowerMW: number;
  fissionPowerMW: number;
  decayHeatMW: number;
  steamToTurbineMW: number;
  turbineRPM: number;
  electricalOutputMW: number;
  reversePowerTimer: number;
  condenserVacuum: number;
  condenserLoadMW: number;
  coolingCapacityMW: number;
  coolingWaterTemp: number;
  outfallTemp: number;

  // ---- consequences
  coreDamage: number;
  partialMeltdown: boolean;
  meltdown: boolean;
  /** Dose rates by zone, µSv/h. */
  radiationLevels: Record<RadiationZone, number>;
  /** Active alarm ids (see alarms.ts). */
  alarms: string[];
}

export type RadiationZone = 'containment' | 'turbineHall' | 'controlRoom' | 'spentFuelPad' | 'site';

const BANKS = C.reactivity.bankWeights.length;
const RCPS = 4;

function fuelExcess(burnupMWd: number): number {
  const r = C.reactivity;
  const t = Math.min(1, burnupMWd / r.burnupCapacityMWd);
  return r.fuelExcessFresh + (r.fuelExcessDepleted - r.fuelExcessFresh) * t;
}

function feedbackTemp(s: Pick<ReactorState, 'coreTemp' | 'coolantTemp'>): number {
  return 0.5 * s.coreTemp + 0.5 * s.coolantTemp;
}

/** Reactivity breakdown for a state (pcm). Exported for tests and displays. */
export function computeReactivity(
  s: Pick<ReactorState, 'rodBanks' | 'burnupMWd' | 'coreTemp' | 'coolantTemp' | 'xenonLevel'>,
): ReactivityParts {
  const r = C.reactivity;
  let rodFrac = 0;
  for (let i = 0; i < BANKS; i++) rodFrac += r.bankWeights[i] * rodWorthFraction(s.rodBanks[i] / 100);
  const rods = -r.rodWorthTotal * rodFrac;
  const fuel = fuelExcess(s.burnupMWd);
  const temperature = r.tempCoefficient * (feedbackTemp(s) - r.tempReference);
  const xenon = -r.xenonWorthEq * s.xenonLevel;
  return { rods, fuel, temperature, xenon, total: rods + fuel + temperature + xenon };
}

/** Weighted average rod insertion across banks, %. */
export function averageRodInsertion(s: Pick<ReactorState, 'rodBanks'>): number {
  return s.rodBanks.reduce((sum, x, i) => sum + x * C.reactivity.bankWeights[i], 0);
}

function steamFactor(secondaryTemp: number): number {
  const st = C.steam;
  return Math.min(1.3, Math.max(0, (secondaryTemp - st.minTemp) / (st.nominalTemp - st.minTemp)));
}

function coolingCapacity(intakePumps: boolean[], fans: number, env: Environment): number {
  const c = C.cooling;
  const pumps = intakePumps.filter(Boolean).length;
  const towerFactor = 0.75 + (0.25 * fans) / c.towerFans;
  const weather = Math.max(0.5, 1 - (env.ambientTemp - 15) * c.ambientDerate);
  return pumps * c.intakePumpCapacityMW * towerFactor * weather;
}

function emptyRadiation(): Record<RadiationZone, number> {
  return { containment: 0, turbineHall: 0, controlRoom: 0, spentFuelPad: 0, site: 0 };
}

/** A shut-down plant with cool water: rods in, pumps off, turbine stopped. The tutorial start. */
function coldState(): ReactorState {
  const T = 45;
  const s: ReactorState = {
    time: 0,
    rodBanks: new Array(BANKS).fill(100),
    rodTargets: new Array(BANKS).fill(100),
    scram: { active: false, cause: null, time: null },
    safetyBypass: false,
    coolantPumps: Array.from({ length: RCPS }, () => ({ on: false, speed: 0 })),
    feedPumps: [true, true],
    auxFeed: 'auto',
    intakePumps: [true, true],
    towerFans: 2,
    pressurizerAuto: true,
    turbineSpeedTarget: 0,
    governorValve: 0,
    turbineTripped: false,
    generatorSynced: false,
    precursors: 0,
    neutronFlux: 0,
    reactivity: { rods: 0, fuel: 0, temperature: 0, xenon: 0, total: 0 },
    startupRate: 0,
    decayGroups: C.decayHeat.map(() => 0),
    iodine: 0,
    xenonLevel: 0,
    burnupMWd: 0,
    coreTemp: T,
    coolantTemp: T,
    hotLegTemp: T,
    coldLegTemp: T,
    secondaryTemp: T,
    primaryPressure: C.pressure.nominal,
    primaryInventory: 100,
    coolantFlow: 0,
    subcooling: 0,
    boiling: false,
    steamGeneratorLevel: C.feedwater.nominalLevel,
    auxFeedRunning: false,
    safetyInjection: false,
    porvOpen: false,
    steamDump: 0,
    steamReliefOpen: false,
    thermalPowerMW: 0,
    fissionPowerMW: 0,
    decayHeatMW: 0,
    steamToTurbineMW: 0,
    turbineRPM: 0,
    electricalOutputMW: 0,
    reversePowerTimer: 0,
    condenserVacuum: 100,
    condenserLoadMW: 0,
    coolingCapacityMW: 0,
    coolingWaterTemp: DEFAULT_ENV.riverTemp,
    outfallTemp: DEFAULT_ENV.riverTemp,
    coreDamage: 0,
    partialMeltdown: false,
    meltdown: false,
    radiationLevels: emptyRadiation(),
    alarms: [],
  };
  // Settle the neutron level at its subcritical source equilibrium.
  s.reactivity = computeReactivity(s);
  const rho = s.reactivity.total * 1e-5;
  s.neutronFlux = C.kinetics.source / -rho;
  s.precursors = s.neutronFlux;
  return s;
}

/** Steady full power with equilibrium xenon and decay heat, generator on the grid. */
function fullPowerState(env: Environment): ReactorState {
  const s = coldState();
  const th = C.thermal;
  const rated = C.ratedThermalMW;
  s.coolantPumps.forEach((p) => {
    p.on = true;
    p.speed = 1;
  });
  s.coolantFlow = 1;
  s.towerFans = 4;
  s.neutronFlux = 1;
  s.precursors = 1;
  s.decayGroups = C.decayHeat.map((g) => g.fraction);
  s.iodine = 1;
  s.xenonLevel = 1;
  s.secondaryTemp = C.steam.nominalTemp;
  const pumpHeat = RCPS * th.pumpHeatMW;
  const loss = th.primaryLossMW * ((300 - env.ambientTemp) / 280);
  const qsg = rated + pumpHeat - loss;
  s.coolantTemp = s.secondaryTemp + qsg / th.sgUA;
  s.coreTemp = s.coolantTemp + rated / th.coreToCoolantHA;
  s.governorValve = qsg / C.steam.maxFlowMW;
  s.turbineSpeedTarget = C.turbine.syncRpm;
  s.turbineRPM = C.turbine.syncRpm;
  s.generatorSynced = true;

  // Position all banks equally so the core is exactly critical.
  const parts = computeReactivity({ ...s, rodBanks: [0, 0, 0, 0] });
  const needed = (parts.fuel + parts.temperature + parts.xenon) / C.reactivity.rodWorthTotal;
  const x = insertionForWorth(Math.max(0, Math.min(1, needed))) * 100;
  s.rodBanks = new Array(BANKS).fill(x);
  s.rodTargets = new Array(BANKS).fill(x);
  s.reactivity = computeReactivity(s);
  return s;
}

export function createReactorState(preset: 'cold' | 'fullPower' = 'cold', env: Environment = DEFAULT_ENV): ReactorState {
  const s = preset === 'cold' ? coldState() : fullPowerState(env);
  const r = new Reactor(s, env);
  r.step(0.05, 0.05); // fill in derived outputs
  r.drainEvents();
  return r.state;
}

export function reactorStatus(s: ReactorState): ReactorStatus {
  if (s.meltdown) return 'MELTDOWN';
  if (s.scram.active) return 'SCRAMMED';
  if (activeAlarms(s).some((a) => a.severity !== 'warning')) return 'ALARM';
  if (s.generatorSynced && s.electricalOutputMW > 1) return 'AT POWER';
  if (s.neutronFlux > 0.001 || (s.reactivity.total > -20 && s.neutronFlux > 1e-6)) return 'CRITICAL';
  return 'OFFLINE';
}

const SUBSTEPS = 2;

export class Reactor {
  readonly state: ReactorState;
  env: Environment;
  private events: ReactorEvent[] = [];
  private wasCritical = false;
  private wasPrompt = false;

  constructor(state: ReactorState = createReactorState('cold'), env: Environment = { ...DEFAULT_ENV }) {
    this.state = state;
    this.env = env;
    this.wasCritical = state.neutronFlux > 1e-6 && state.reactivity.total >= 0;
  }

  // ------------------------------------------------------------------ commands

  /** Set rod bank target insertion (%). Ignored while a SCRAM is latched. */
  setRodTarget(bank: number | 'all', pct: number): void {
    if (this.state.scram.active) return;
    const v = Math.min(100, Math.max(0, pct));
    if (bank === 'all') this.state.rodTargets.fill(v);
    else if (bank >= 0 && bank < BANKS) this.state.rodTargets[bank] = v;
  }

  nudgeRods(delta: number): void {
    if (this.state.scram.active) return;
    const t = this.state.rodTargets;
    for (let i = 0; i < t.length; i++) t[i] = Math.min(100, Math.max(0, t[i] + delta));
  }

  setCoolantPump(i: number, on: boolean): void {
    const p = this.state.coolantPumps[i];
    if (!p || p.on === on) return;
    p.on = on;
    this.emit('info', `Reactor coolant pump ${i + 1} ${on ? 'started' : 'stopped'}`);
  }

  setAllCoolantPumps(on: boolean): void {
    this.state.coolantPumps.forEach((_, i) => this.setCoolantPump(i, on));
  }

  setFeedPump(i: number, on: boolean): void {
    if (i >= 0 && i < this.state.feedPumps.length) this.state.feedPumps[i] = on;
  }

  setAuxFeed(mode: AuxFeedMode): void {
    this.state.auxFeed = mode;
  }

  setIntakePump(i: number, on: boolean): void {
    if (i >= 0 && i < this.state.intakePumps.length) this.state.intakePumps[i] = on;
  }

  setTowerFans(n: number): void {
    this.state.towerFans = Math.min(C.cooling.towerFans, Math.max(0, Math.round(n)));
  }

  setPressurizerAuto(on: boolean): void {
    this.state.pressurizerAuto = on;
  }

  /** Turbine speed setpoint used before the generator is synchronised. */
  setTurbineSpeedTarget(rpm: number): void {
    this.state.turbineSpeedTarget = Math.min(C.turbine.maxSpeedTarget, Math.max(0, rpm));
  }

  /** Governor valve opening (0..1); controls load once the generator is on the grid. */
  setGovernorValve(v: number): void {
    this.state.governorValve = Math.min(1, Math.max(0, v));
  }

  /** Connect the generator to the grid. Only works with the turbine at synchronous speed. */
  syncGenerator(): boolean {
    const s = this.state;
    const t = C.turbine;
    if (s.generatorSynced || s.turbineTripped) return false;
    if (Math.abs(s.turbineRPM - t.syncRpm) > t.syncWindow) {
      this.emit('warn', `Cannot sync: turbine at ${Math.round(s.turbineRPM)} rpm (need ${t.syncRpm} ±${t.syncWindow})`);
      return false;
    }
    s.generatorSynced = true;
    s.reversePowerTimer = 0;
    this.emit('good', 'Generator synchronised to the grid');
    return true;
  }

  tripTurbine(reason = 'manual turbine trip'): void {
    const s = this.state;
    if (s.turbineTripped) return;
    s.turbineTripped = true;
    s.generatorSynced = false;
    s.governorValve = 0;
    this.emit('warn', `Turbine trip: ${reason}`);
    if (!s.scram.active && !s.safetyBypass && s.neutronFlux > C.trips.turbineTripPermissive) {
      this.scram('turbineTrip');
    }
  }

  resetTurbine(): boolean {
    const s = this.state;
    if (!s.turbineTripped) return false;
    if (s.condenserVacuum < C.cooling.vacuumTrip) {
      this.emit('warn', 'Cannot reset turbine: condenser vacuum too low');
      return false;
    }
    s.turbineTripped = false;
    s.turbineSpeedTarget = 0;
    this.emit('info', 'Turbine trip reset');
    return true;
  }

  scram(cause: TripCause = 'manual'): void {
    const s = this.state;
    if (s.scram.active) return;
    s.scram = { active: true, cause, time: s.time };
    s.rodTargets.fill(100);
    this.emit('danger', `REACTOR TRIP — ${TRIP_LABELS[cause]}`);
    // A reactor trip always trips the turbine, or it would keep drawing steam and over-cool the plant.
    if (!s.turbineTripped && (s.generatorSynced || s.turbineRPM > 1)) this.tripTurbine('reactor trip');
  }

  /** Clear a latched SCRAM once the rods are fully in and no trip condition remains. */
  resetScram(): boolean {
    const s = this.state;
    if (!s.scram.active) return false;
    if (s.rodBanks.some((x) => x < 99.9)) {
      this.emit('warn', 'Cannot reset trip: rods still inserting');
      return false;
    }
    const cause = this.tripCondition();
    if (cause) {
      this.emit('warn', `Cannot reset trip: ${TRIP_LABELS[cause]} still present`);
      return false;
    }
    s.scram = { active: false, cause: null, time: null };
    this.emit('info', 'Reactor trip reset');
    return true;
  }

  setSafetyBypass(on: boolean): void {
    if (this.state.safetyBypass === on) return;
    this.state.safetyBypass = on;
    this.emit(on ? 'danger' : 'info', on ? 'SAFETY SYSTEMS BYPASSED' : 'Safety systems restored');
  }

  drainEvents(): ReactorEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private emit(kind: ReactorEvent['kind'], text: string): void {
    this.events.push({ kind, text, time: this.state.time });
  }

  // ------------------------------------------------------------------ simulation

  /** Advance by `dt` real seconds, during which `dtGame` game seconds pass. */
  step(dt: number, dtGame: number): void {
    const h = dt / SUBSTEPS;
    const hg = dtGame / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) this.substep(h, hg);
    this.state.alarms = activeAlarms(this.state).map((a) => a.id);
  }

  private substep(dt: number, dtGame: number): void {
    const s = this.state;
    const env = this.env;
    const th = C.thermal;
    const rated = C.ratedThermalMW;
    s.time += dt;

    // --- control rods
    const rodSpeed = s.scram.active ? 100 / C.rods.scramTime : C.rods.driveSpeed;
    for (let i = 0; i < BANKS; i++) {
      const d = s.rodTargets[i] - s.rodBanks[i];
      const maxMove = rodSpeed * dt;
      s.rodBanks[i] += Math.max(-maxMove, Math.min(maxMove, d));
    }

    // --- coolant pumps
    let pumpFlow = 0;
    let pumpHeat = 0;
    for (const p of s.coolantPumps) {
      p.speed += ((p.on ? 1 : 0) - p.speed) * approach(p.on ? th.pumpSpinUpTau : th.pumpCoastdownTau, dt);
      pumpFlow += p.speed / RCPS;
      pumpHeat += p.speed * th.pumpHeatMW;
    }
    const inventoryOk = s.primaryInventory > C.inventory.uncoverFull;
    s.coolantFlow = Math.max(pumpFlow, inventoryOk ? th.naturalCirculation : 0.01);

    // --- reactivity and neutron kinetics
    s.reactivity = computeReactivity(s);
    const k = C.kinetics;
    const rho = s.reactivity.total * 1e-5;
    const rhoK = Math.min(rho, k.promptClamp * k.beta);
    // Startup rate is read from the delayed-neutron level, so the instant "prompt jump"
    // when a rod moves doesn't register as a runaway.
    const pBefore = s.precursors;
    s.precursors = Math.max(0, precursorStep(s.precursors, rhoK, k.beta, k.lambda, k.source, dt));
    s.neutronFlux = Math.max(0, neutronPower(s.precursors, rhoK, k.beta, k.source));
    if (pBefore > 0 && s.precursors > 0) {
      const dpm = (Math.log10(s.precursors / pBefore) / dt) * 60;
      s.startupRate += (dpm - s.startupRate) * approach(1.5, dt);
    }
    const critical = rho >= -0.0001 && s.neutronFlux > 1e-6;
    if (critical && !this.wasCritical && !s.scram.active) this.emit('good', 'Reactor is critical');
    this.wasCritical = critical;
    const prompt = rho >= k.beta;
    if (prompt && !this.wasPrompt) this.emit('danger', 'PROMPT CRITICAL EXCURSION');
    this.wasPrompt = prompt;

    // --- decay heat, xenon, burnup (game time)
    const decayTotal = C.decayHeat.reduce((sum, g) => sum + g.fraction, 0);
    let decay = 0;
    C.decayHeat.forEach((g, i) => {
      const lam = Math.LN2 / g.halfLifeS;
      s.decayGroups[i] += (g.fraction * s.neutronFlux - s.decayGroups[i]) * (1 - Math.exp(-lam * dtGame));
      decay += s.decayGroups[i];
    });
    s.fissionPowerMW = s.neutronFlux * rated * (1 - decayTotal);
    s.decayHeatMW = decay * rated;
    s.thermalPowerMW = s.fissionPowerMW + s.decayHeatMW;

    const xe = C.xenon;
    const lamI = Math.LN2 / (xe.iodineHalfLifeH * 3600);
    const lamX = Math.LN2 / (xe.xenonHalfLifeH * 3600);
    s.iodine += (s.neutronFlux - s.iodine) * (1 - Math.exp(-lamI * dtGame));
    const production = lamX * (1 + xe.burnoutRatio) * (xe.directYield * s.neutronFlux + (1 - xe.directYield) * s.iodine);
    const removal = lamX * (1 + xe.burnoutRatio * s.neutronFlux) * s.xenonLevel;
    s.xenonLevel = Math.max(0, s.xenonLevel + (production - removal) * dtGame);
    s.burnupMWd += (s.fissionPowerMW * dtGame) / 86400;

    // --- primary heat transfer
    const inv = C.inventory;
    const uncover = Math.min(1, Math.max(inv.uncoveredCooling,
      (s.primaryInventory - inv.uncoverFull) / (inv.uncoverStart - inv.uncoverFull)));
    const loopDT = (q: number) => q / (C.thermal.loopFlowCapacity * Math.max(s.coolantFlow, 0.02));
    const tsat = saturationTemp(s.primaryPressure);
    s.boiling = s.hotLegTemp > tsat;
    const hA = th.coreToCoolantHA * Math.pow(s.coolantFlow, 0.8) * (s.boiling ? th.dnbFactor : 1) * uncover;
    const qCore = hA * (s.coreTemp - s.coolantTemp);

    // --- feedwater and steam generator
    const fw = C.feedwater;
    const levelFactor = Math.min(1, Math.max(0, s.steamGeneratorLevel / 30));
    const qSG = th.sgUA * (0.3 + 0.7 * s.coolantFlow) * levelFactor * (s.coolantTemp - s.secondaryTemp);

    // --- steam: turbine, dumps, atmospheric relief
    const st = C.steam;
    const sf = steamFactor(s.secondaryTemp);
    const tb = C.turbine;
    let valve = 0;
    if (!s.turbineTripped) {
      if (s.generatorSynced) {
        valve = s.governorValve;
      } else {
        // Speed governor: open just enough steam to hold the speed target.
        const need = tb.spinPowerMW * Math.pow(s.turbineSpeedTarget / tb.syncRpm, 2) / tb.efficiency;
        valve = sf > 0.01 ? Math.min(1, need / (st.maxFlowMW * sf)) : 0;
        s.governorValve += (valve - s.governorValve) * approach(2, dt);
        valve = s.governorValve;
      }
    }
    const qTurb = valve * st.maxFlowMW * sf;

    const dumpAvailable = s.condenserVacuum >= C.cooling.dumpMinVacuum;
    const dumpTarget = (!s.generatorSynced || s.turbineTripped) && dumpAvailable
      ? Math.min(st.dumpMax, Math.max(0, (s.secondaryTemp - st.dumpSetpoint) / 8))
      : 0;
    s.steamDump += (dumpTarget - s.steamDump) * approach(1.5, dt);
    const qDump = s.steamDump * st.maxFlowMW * sf;
    const reliefFrac = Math.min(1, Math.max(0, (s.secondaryTemp - st.reliefSetpoint) / 6));
    s.steamReliefOpen = reliefFrac > 0.02;
    const qRelief = reliefFrac * st.reliefMax * st.maxFlowMW * sf;
    const qSteam = qTurb + qDump + qRelief;
    s.steamToTurbineMW = qTurb;

    // Feedwater keeps SG level near nominal.
    const steamFrac = qSteam / rated;
    const mainCap = s.feedPumps.filter(Boolean).length * fw.pumpCapacity;
    s.auxFeedRunning = s.auxFeed === 'on' ||
      (s.auxFeed === 'auto' && !s.safetyBypass && (s.steamGeneratorLevel < fw.auxStartLevel || (s.auxFeedRunning && s.steamGeneratorLevel < fw.nominalLevel)));
    const feedCap = mainCap + (s.auxFeedRunning ? fw.auxCapacity : 0);
    const feed = Math.min(feedCap, Math.max(0, steamFrac + 0.02 * (fw.nominalLevel - s.steamGeneratorLevel)));
    s.steamGeneratorLevel = Math.min(100, Math.max(0, s.steamGeneratorLevel + (feed - steamFrac) * fw.levelGain * dt));

    // --- temperatures
    const loss = th.primaryLossMW * Math.max(0, (s.coolantTemp - env.ambientTemp) / 280);
    const prevCoolant = s.coolantTemp;
    const dmgCfg = C.damage;
    const oxidation = s.coreTemp > dmgCfg.onsetTemp
      ? Math.min(dmgCfg.oxidationMaxMW, (s.coreTemp - dmgCfg.onsetTemp) * dmgCfg.oxidationMWPerC)
      : 0;
    // Less water in the loop means less heat capacity to soak up heat.
    const coolantCap = th.coolantHeatCap * Math.max(0.1, s.primaryInventory / 100);
    s.coreTemp += ((s.thermalPowerMW + oxidation - qCore) / th.coreHeatCap) * dt;
    s.coolantTemp += ((qCore + pumpHeat - qSG - loss) / coolantCap) * dt;
    s.secondaryTemp += ((qSG - qSteam) / th.secondaryHeatCap) * dt;
    s.secondaryTemp = Math.max(env.ambientTemp, s.secondaryTemp);
    s.coolantTemp = Math.max(env.ambientTemp, s.coolantTemp);
    s.coreTemp = Math.min(C.damage.meltTemp, Math.max(s.coolantTemp, s.coreTemp));
    const halfRise = 0.5 * loopDT(Math.max(0, qCore));
    s.hotLegTemp = s.coolantTemp + halfRise;
    s.coldLegTemp = s.coolantTemp - halfRise;

    // --- primary pressure and inventory
    const pc = C.pressure;
    s.primaryPressure += pc.thermalExpansion * (s.coolantTemp - prevCoolant);
    if (s.pressurizerAuto) {
      const sprayAvail = pumpFlow > 0.5 ? pc.sprayRate : 0;
      const want = (pc.nominal - s.primaryPressure) / pc.controlTau;
      s.primaryPressure += Math.max(-sprayAvail, Math.min(pc.heaterRate, want)) * dt;
    }
    if (s.boiling) {
      // Boiling coolant drives pressure up towards saturation at the hot-leg temperature.
      const psat = saturationPressure(s.hotLegTemp);
      if (psat > s.primaryPressure) s.primaryPressure += (psat - s.primaryPressure) * approach(2, dt);
    }
    s.porvOpen = s.primaryPressure >= pc.reliefSetpoint;
    if (s.porvOpen) {
      s.primaryPressure = Math.min(s.primaryPressure, pc.reliefSetpoint + 0.1);
      s.primaryInventory -= pc.reliefInventoryLoss * dt;
    }
    if (s.primaryInventory < 100 && !s.porvOpen) {
      // Without makeup, a depleted system slowly depressurises.
      s.primaryPressure -= 0.01 * (100 - s.primaryInventory) * dt * (s.safetyInjection ? 0 : 1);
    }
    const siWanted = !s.safetyBypass &&
      (s.primaryPressure < pc.safetyInjectionPressure || s.primaryInventory < pc.safetyInjectionInventory);
    if (siWanted && !s.safetyInjection) this.emit('warn', 'Safety injection actuated');
    s.safetyInjection = siWanted || (s.safetyInjection && !s.safetyBypass && s.primaryInventory < 99);
    if (s.safetyInjection) {
      s.primaryInventory += pc.safetyInjectionRate * dt;
      s.coolantTemp -= 0.5 * dt; // cold borated water
    }
    s.primaryInventory = Math.min(100, Math.max(0, s.primaryInventory));
    s.primaryPressure = Math.max(0.1, s.primaryPressure);
    s.subcooling = saturationTemp(s.primaryPressure) - s.hotLegTemp;

    // --- turbine-generator
    const cc = C.cooling;
    s.coolingCapacityMW = coolingCapacity(s.intakePumps, s.towerFans, env);
    const vacFactor = 0.9 + 0.1 * (s.condenserVacuum / 100);
    const pMech = qTurb * tb.efficiency * vacFactor;
    if (s.generatorSynced) {
      s.turbineRPM = tb.syncRpm;
      s.electricalOutputMW = Math.max(0, pMech - tb.lossesMW);
      if (pMech < tb.reversePowerMW) {
        s.reversePowerTimer += dt;
        if (s.reversePowerTimer > tb.reversePowerDelay) {
          s.generatorSynced = false;
          s.reversePowerTimer = 0;
          this.emit('warn', 'Generator tripped on reverse power');
        }
      } else {
        s.reversePowerTimer = 0;
      }
    } else {
      const rpmEq = pMech > 0 ? tb.syncRpm * Math.sqrt(pMech / tb.spinPowerMW) : 0;
      s.turbineRPM += (rpmEq - s.turbineRPM) * approach(tb.rpmTau, dt);
      s.electricalOutputMW = 0;
      if (s.turbineRPM > tb.overspeedRpm) this.tripTurbine('overspeed');
    }

    // --- condenser and cooling water
    s.condenserLoadMW = Math.max(0, qTurb - pMech + qDump);
    const ratio = s.coolingCapacityMW > 0 ? s.condenserLoadMW / s.coolingCapacityMW : s.condenserLoadMW > 1 ? 3 : 0;
    s.condenserVacuum = Math.min(100, Math.max(0, 100 - 70 * Math.max(0, ratio - 0.8)));
    if (s.condenserVacuum < cc.vacuumTrip && qTurb > 1 && !s.turbineTripped) this.tripTurbine('low condenser vacuum');
    const towerFactor = 0.75 + (0.25 * s.towerFans) / cc.towerFans;
    s.coolingWaterTemp = env.riverTemp + 11 * Math.min(ratio, 2);
    s.outfallTemp = env.riverTemp + 4 * Math.min(ratio, 2) * (2 - towerFactor);

    // --- fuel damage
    const dmg = C.damage;
    if (s.coreTemp > dmg.onsetTemp) {
      s.coreDamage = Math.min(1, s.coreDamage + ((s.coreTemp - dmg.onsetTemp) / 1000) * dmg.rate * dt);
    }
    if (s.coreDamage >= 0.5 && !s.partialMeltdown) {
      s.partialMeltdown = true;
      this.emit('danger', 'PARTIAL CORE MELT');
    }
    if (s.coreDamage >= 1 && !s.meltdown) {
      s.meltdown = true;
      this.emit('danger', 'CORE MELTDOWN');
    }

    // --- radiation (µSv/h)
    const R = s.radiationLevels;
    R.containment = 5 + 4000 * s.neutronFlux + 200 * (s.decayHeatMW / rated) + 50000 * s.coreDamage;
    R.turbineHall = 0.2 + 15 * s.neutronFlux + 300 * s.coreDamage;
    R.controlRoom = 0.1 + 40 * s.coreDamage;
    R.spentFuelPad = 2;
    R.site = 0.1 + 10 * s.coreDamage + (s.porvOpen ? 0.5 : 0);

    // --- reactor protection system
    if (!s.scram.active && !s.safetyBypass) {
      const cause = this.tripCondition();
      if (cause) this.scram(cause);
    }
  }

  /** The first automatic trip condition currently exceeded, if any. */
  private tripCondition(): TripCause | null {
    const s = this.state;
    const t = C.trips;
    if (s.neutronFlux > t.highFlux) return 'highFlux';
    if (s.neutronFlux < t.startupRatePermissive && s.startupRate > t.startupRateDpm) return 'startupRate';
    if (s.primaryPressure > t.highPressure) return 'highPressure';
    if (s.primaryPressure < t.lowPressure && s.neutronFlux > t.lowPressurePermissive) return 'lowPressure';
    if (s.coolantFlow < t.lowFlow && s.neutronFlux > t.lowFlowPermissive) return 'lowFlow';
    if (s.coreTemp > t.highCoreTemp) return 'highCoreTemp';
    if (s.steamGeneratorLevel < t.lowSgLevel && s.neutronFlux > t.lowSgLevelPermissive) return 'lowSgLevel';
    return null;
  }
}
