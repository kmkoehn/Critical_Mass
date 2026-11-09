/** Plain-text reactor readout for the debug panel (until the control room exists). */
import { TRIP_LABELS, averageRodInsertion, reactorStatus, type ReactorState } from '../sim/reactor';

const f0 = (v: number) => v.toFixed(0);
const f1 = (v: number) => v.toFixed(1);
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const sign = (v: number) => (v >= 0 ? '+' : '') + f0(v);

export function reactorDebugText(s: ReactorState): string {
  const r = s.reactivity;
  const status = reactorStatus(s);
  const lines = [
    `REACTOR    ${status}${s.scram.cause ? `  (${TRIP_LABELS[s.scram.cause]})` : ''}${s.safetyBypass ? '  BYPASS' : ''}`,
    `flux       ${s.neutronFlux.toExponential(2)}  ${pct(s.neutronFlux)}   SUR ${s.startupRate >= 0 ? '+' : ''}${s.startupRate.toFixed(2)} dpm`,
    `reactivity ${sign(r.total)} pcm  (rods ${sign(r.rods)} fuel ${sign(r.fuel)} temp ${sign(r.temperature)} Xe ${sign(r.xenon)})`,
    `rods       ${s.rodBanks.map((x, i) => `${'ABCD'[i]} ${f1(x)}`).join('  ')}   avg ${f1(averageRodInsertion(s))}%  → ${f1(s.rodTargets[0])}%`,
    `xenon      ${s.xenonLevel.toFixed(2)}× eq   iodine ${s.iodine.toFixed(2)}   burnup ${f0(s.burnupMWd)} MWd`,
    `power      ${f0(s.thermalPowerMW)} MWt  (fission ${f0(s.fissionPowerMW)}, decay ${f1(s.decayHeatMW)})`,
    `core       ${f0(s.coreTemp)}°C   coolant ${f1(s.coolantTemp)}°C (hot ${f0(s.hotLegTemp)} / cold ${f0(s.coldLegTemp)})`,
    `primary    ${s.primaryPressure.toFixed(2)} MPa   subcool ${f0(s.subcooling)}°C   flow ${pct(s.coolantFlow)}   inventory ${f0(s.primaryInventory)}%`,
    `pumps      RCP ${s.coolantPumps.map((p) => (p.on ? '■' : '□')).join('')}  feed ${s.feedPumps.map((p) => (p ? '■' : '□')).join('')}  AFW ${s.auxFeedRunning ? 'RUN' : s.auxFeed}  SI ${s.safetyInjection ? 'ON' : 'off'}`,
    `secondary  ${f0(s.secondaryTemp)}°C   SG level ${f0(s.steamGeneratorLevel)}%   dump ${pct(s.steamDump)}${s.steamReliefOpen ? '  RELIEF OPEN' : ''}${s.porvOpen ? '  PORV OPEN' : ''}`,
    `turbine    ${f0(s.turbineRPM)} rpm  ${s.generatorSynced ? 'SYNCED' : `target ${f0(s.turbineSpeedTarget)}`}${s.turbineTripped ? '  TRIPPED' : ''}   valve ${pct(s.governorValve)}   ${f0(s.electricalOutputMW)} MWe`,
    `cooling    vacuum ${f0(s.condenserVacuum)}%   load ${f0(s.condenserLoadMW)}/${f0(s.coolingCapacityMW)} MW   outfall ${f1(s.outfallTemp)}°C`,
    `radiation  containment ${f0(s.radiationLevels.containment)}  turbine hall ${f1(s.radiationLevels.turbineHall)} µSv/h${s.coreDamage > 0 ? `   CORE DAMAGE ${pct(s.coreDamage)}` : ''}`,
    `alarms     ${s.alarms.length ? s.alarms.join(' ') : '—'}`,
    '',
    '[ ] rods in/out 1% (Shift 5%)   P coolant pumps   , . turbine speed / governor',
    'Y sync   X SCRAM   R reset trip   B bypass   L load full power   K cold reset',
  ];
  return lines.join('\n');
}
