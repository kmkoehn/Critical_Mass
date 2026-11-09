/**
 * Every tunable number in the simulation lives here.
 *
 * Units: power in MW, temperature in °C, pressure in MPa, reactivity in pcm
 * (1 pcm = 1e-5 Δk/k), rod insertion in % (0 = fully withdrawn, 100 = fully inserted).
 * Fast plant dynamics run in real seconds; slow processes (xenon, decay heat,
 * fuel burnup) run in game seconds, so they unfold over in-game hours.
 */
export const SIM_CONFIG = {
  ratedThermalMW: 3000,

  kinetics: {
    /** Delayed neutron fraction. Reactivity above this is prompt critical. */
    beta: 0.0065,
    /** One-group delayed neutron precursor decay constant, 1/s. */
    lambda: 0.08,
    /** Neutron source strength (normalised). Sets the shutdown neutron level. */
    source: 3e-9,
    /** Reactivity is clamped to this fraction of beta inside the kinetics (prompt-jump model). */
    promptClamp: 0.97,
  },

  reactivity: {
    /** Excess reactivity of fresh fuel with no xenon, cold. */
    fuelExcessFresh: 9500,
    /** Excess reactivity at the end of the fuel cycle. */
    fuelExcessDepleted: 6000,
    /** Burnup at which the fuel cycle is spent (≈ 3 weeks at full power). */
    burnupCapacityMWd: 63000,
    /** Total worth of all control rods. */
    rodWorthTotal: 12000,
    /** Share of the total rod worth held by each bank (A–D). */
    bankWeights: [0.2, 0.25, 0.25, 0.3],
    /** Combined fuel (Doppler) + moderator temperature coefficient, pcm/°C. */
    tempCoefficient: -15,
    tempReference: 25,
    /** Reactivity held by equilibrium full-power xenon. */
    xenonWorthEq: 3000,
  },

  rods: {
    /** Normal drive speed, %/s. Mid-core, 1% of all banks is worth up to ~240 pcm. */
    driveSpeed: 1,
    /** Time for a full SCRAM insertion, s. */
    scramTime: 2.5,
  },

  xenon: {
    iodineHalfLifeH: 6.57,
    xenonHalfLifeH: 9.14,
    /** Xenon burn-out by neutron absorption at full power, relative to its decay rate. */
    burnoutRatio: 4,
    /** Fraction of xenon produced directly by fission (rest via iodine decay). */
    directYield: 0.05,
  },

  /** Decay heat groups: equilibrium fraction of rated power, half-life in game seconds. Sum ≈ 6%. */
  decayHeat: [
    { fraction: 0.025, halfLifeS: 60 },
    { fraction: 0.015, halfLifeS: 1800 },
    { fraction: 0.012, halfLifeS: 18000 },
    { fraction: 0.008, halfLifeS: 259200 },
  ],

  thermal: {
    /** Heat capacities, MJ/°C. */
    coreHeatCap: 120,
    coolantHeatCap: 300,
    secondaryHeatCap: 380,
    /** Core-to-coolant conductance at full flow, MW/°C. */
    coreToCoolantHA: 85.7,
    /** Loop heat-carrying capacity at full flow, MW/°C (sets hot/cold leg split). */
    loopFlowCapacity: 85.7,
    /** Natural circulation flow when all pumps are off (fraction of full). */
    naturalCirculation: 0.06,
    /** Heat-transfer multiplier once the coolant boils at the fuel (departure from nucleate boiling). */
    dnbFactor: 0.15,
    /** Steam generator conductance at full flow, MW/°C. */
    sgUA: 150,
    /** Heat added by each running reactor coolant pump, MW. */
    pumpHeatMW: 4,
    pumpSpinUpTau: 2,
    pumpCoastdownTau: 12,
    /** Primary heat loss to the building at 300 °C, MW. */
    primaryLossMW: 2,
  },

  steam: {
    /** Steam heat flow with all valves wide open at nominal temperature, MW. */
    maxFlowMW: 3300,
    /** Secondary temperature below which no useful steam is made. */
    minTemp: 150,
    nominalTemp: 285,
    /** Steam dumps (bypass to condenser) open above this secondary temperature when the generator is off-line. */
    dumpSetpoint: 292,
    dumpMax: 0.45,
    /** Atmospheric relief valves open above this secondary temperature. */
    reliefSetpoint: 300,
    reliefMax: 0.25,
  },

  feedwater: {
    nominalLevel: 50,
    /** Feed capacity per main feed pump (fraction of full-power steam flow). */
    pumpCapacity: 0.6,
    /** Auxiliary feedwater capacity (enough for decay heat). */
    auxCapacity: 0.1,
    /** Auxiliary feed starts automatically below this SG level. */
    auxStartLevel: 25,
    /** SG level change rate per unit feed/steam mismatch, %/s. */
    levelGain: 2.5,
  },

  pressure: {
    nominal: 15.5,
    /** Pressure change per °C of coolant temperature change (thermal expansion), MPa/°C. */
    thermalExpansion: 0.04,
    /** Pressurizer heaters/sprays: maximum correction rates, MPa/s. */
    heaterRate: 0.02,
    sprayRate: 0.05,
    controlTau: 30,
    /** Power-operated relief valve opens here and vents coolant. */
    reliefSetpoint: 16.9,
    reliefInventoryLoss: 0.4,
    /** Safety injection starts below this pressure or inventory. */
    safetyInjectionPressure: 12,
    safetyInjectionInventory: 85,
    safetyInjectionRate: 1,
  },

  inventory: {
    /** Below this primary inventory (%) the core starts to uncover. */
    uncoverStart: 70,
    uncoverFull: 40,
    /** Residual core cooling (steam/radiation) once fully uncovered, as a fraction of normal. */
    uncoveredCooling: 0.003,
  },

  turbine: {
    efficiency: 0.345,
    /** Mechanical power needed to hold 3600 rpm with no load, MW. */
    spinPowerMW: 30,
    syncRpm: 3600,
    syncWindow: 18,
    maxSpeedTarget: 3700,
    overspeedRpm: 3960,
    rpmTau: 6,
    /** Generator losses, MW. */
    lossesMW: 12,
    /** Generator trips after this long below the reverse-power threshold. */
    reversePowerMW: 5,
    reversePowerDelay: 5,
    /** Max governor valve movement, fraction per second. */
    valveRate: 0.05,
  },

  cooling: {
    /** Heat each river intake pump can reject through the condenser at 4 tower fans, MW. */
    intakePumpCapacityMW: 1150,
    towerFans: 4,
    /** Hotter weather reduces cooling capacity by this fraction per °C above 15 °C. */
    ambientDerate: 0.012,
    /** Turbine trips when condenser vacuum falls below this (%). */
    vacuumTrip: 75,
    /** Steam dumps are unusable below this condenser vacuum (%). */
    dumpMinVacuum: 60,
  },

  /** Reactor protection system setpoints (automatic SCRAM). */
  trips: {
    highFlux: 1.09,
    /** Startup rate (decades per minute) trip, only below startupRatePermissive power. */
    startupRateDpm: 3,
    startupRatePermissive: 0.1,
    highPressure: 16.6,
    lowPressure: 13.0,
    lowPressurePermissive: 0.05,
    lowFlow: 0.88,
    lowFlowPermissive: 0.3,
    highCoreTemp: 380,
    lowSgLevel: 15,
    lowSgLevelPermissive: 0.05,
    /** A turbine trip above this power trips the reactor. */
    turbineTripPermissive: 0.5,
  },

  damage: {
    /** Fuel damage starts above this core temperature. */
    onsetTemp: 1200,
    meltTemp: 2800,
    /** Damage per second per 1000 °C above onset. */
    rate: 0.012,
    /** Extra heat from zirconium cladding oxidising, MW per °C above onset (runaway once it starts). */
    oxidationMWPerC: 0.15,
    oxidationMaxMW: 300,
  },
} as const;

export type SimConfig = typeof SIM_CONFIG;
