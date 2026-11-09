/** Annunciator alarm definitions. Pure; evaluated against the reactor state every step. */
import { SIM_CONFIG as C } from './config';
import type { ReactorState } from './reactor';

export type Severity = 'warning' | 'alarm' | 'trip';

export interface AlarmDef {
  id: string;
  label: string;
  severity: Severity;
  active: (s: ReactorState) => boolean;
}

export const ALARMS: readonly AlarmDef[] = [
  { id: 'RX_TRIP', label: 'Reactor trip', severity: 'trip', active: (s) => s.scram.active },
  { id: 'CORE_DAMAGE', label: 'Fuel damage', severity: 'trip', active: (s) => s.coreDamage > 0 },
  { id: 'CORE_UNCOVERED', label: 'Core uncovering', severity: 'trip', active: (s) => s.primaryInventory < C.inventory.uncoverStart },
  { id: 'BYPASS', label: 'Safety bypass', severity: 'alarm', active: (s) => s.safetyBypass },
  { id: 'HI_FLUX', label: 'High flux', severity: 'alarm', active: (s) => s.neutronFlux > 1.03 },
  { id: 'HI_PRESS', label: 'Primary press high', severity: 'alarm', active: (s) => s.primaryPressure > 16.2 },
  { id: 'LO_PRESS', label: 'Primary press low', severity: 'alarm', active: (s) => s.primaryPressure < 14.0 },
  { id: 'LO_FLOW', label: 'Coolant flow low', severity: 'alarm', active: (s) => s.coolantFlow < 0.92 && s.neutronFlux > 0.1 },
  { id: 'LO_SUBCOOL', label: 'Subcooling low', severity: 'alarm', active: (s) => s.subcooling < 15 },
  { id: 'PORV_OPEN', label: 'Relief valve open', severity: 'alarm', active: (s) => s.porvOpen },
  { id: 'SI_ACTUATED', label: 'Safety injection', severity: 'alarm', active: (s) => s.safetyInjection },
  { id: 'TURB_TRIP', label: 'Turbine trip', severity: 'alarm', active: (s) => s.turbineTripped },
  { id: 'SUR_HIGH', label: 'Startup rate high', severity: 'warning', active: (s) => s.startupRate > 1 && s.neutronFlux < 0.1 },
  { id: 'HI_CORE_TEMP', label: 'Core temp high', severity: 'warning', active: (s) => s.coreTemp > 360 },
  { id: 'SG_LEVEL', label: 'SG level abnormal', severity: 'warning', active: (s) => s.steamGeneratorLevel < 30 || s.steamGeneratorLevel > 70 },
  { id: 'AFW_RUNNING', label: 'Aux feed running', severity: 'warning', active: (s) => s.auxFeedRunning },
  { id: 'STEAM_RELIEF', label: 'Steam relief open', severity: 'warning', active: (s) => s.steamReliefOpen },
  { id: 'COND_VAC', label: 'Condenser vacuum low', severity: 'warning', active: (s) => s.condenserVacuum < 85 },
  { id: 'OUTFALL_HOT', label: 'Outfall temp high', severity: 'warning', active: (s) => s.outfallTemp > 28 },
  { id: 'REV_POWER', label: 'Generator reverse power', severity: 'warning', active: (s) => s.reversePowerTimer > 0 },
];

export function activeAlarms(s: ReactorState): AlarmDef[] {
  return ALARMS.filter((a) => a.active(s));
}
