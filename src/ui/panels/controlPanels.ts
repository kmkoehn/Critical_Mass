/** The six control-room panels. Each builds its DOM once and updates values in place. */
import { ANNUNCIATOR_TILES, type Annunciator } from '../../sim/annunciator';
import { GRID_CONFIG, SUBSTATIONS, type Grid } from '../../sim/grid';
import { TOWN_DISTRICT_NAMES } from '../../world/layout';
import { SIM_CONFIG } from '../../sim/config';
import type { TrendRecorder, TrendSample } from '../../sim/history';
import { TRIP_LABELS, averageRodInsertion, reactorStatus, type Reactor } from '../../sim/reactor';
import type { PanelId } from '../../world/controlRoom';
import {
  button, chart, h, lamp, meter, readout, section, segmented, setActive, setEnabled, type Tone,
} from './widgets';

export interface PanelContext {
  reactor(): Reactor;
  grid(): Grid;
  annunciator: Annunciator;
  trends: TrendRecorder;
  gameSeconds(): number;
  demandMW(): number;
  /** All active annunciator alarm ids (plant + grid). */
  activeAlarms(): string[];
}

export interface PanelView {
  title: string;
  el: HTMLElement;
  update(dt: number): void;
}

const TB = SIM_CONFIG.turbine;
const STATUS_TONE: Record<string, Tone> = {
  OFFLINE: 'dim', CRITICAL: 'info', 'AT POWER': 'ok', SCRAMMED: 'warn', ALARM: 'bad', MELTDOWN: 'bad',
};
const sign = (v: number, d = 0) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(d);

// ---------------------------------------------------------------- reactor

function reactorPanel(ctx: PanelContext): PanelView {
  const el = h('div', 'cp-grid cols-3');

  const inst = section(el, 'Nuclear instruments');
  const status = readout(inst, 'Reactor status', '', true);
  const power = readout(inst, 'Neutron power', '% rated', true);
  const logFlux = meter(inst, 'Flux, log scale (source range → power range)', -8, 1, {
    marks: [{ at: Math.log10(SIM_CONFIG.trips.highFlux), tone: 'bad' }],
  });
  const sur = readout(inst, 'Startup rate', 'decades/min');
  const rho = meter(inst, 'Reactivity', -1000, 1000, { marks: [{ at: 0, tone: 'info' }] });
  const parts = h('div', 'cp-note', inst);
  const core = readout(inst, 'Core temperature', '°C');
  const decay = readout(inst, 'Decay heat', 'MW');

  const rods = section(el, 'Control rods');
  h('div', 'cp-note', rods, 'Bar = insertion (top = withdrawn). Slider sets each bank’s target; rods drive at 1 %/s.');
  const banksRow = h('div', 'cp-banks', rods);
  const banks = [0, 1, 2, 3].map((i) => {
    const col = h('div', 'cp-bank', banksRow);
    h('div', 'cp-label', col, `Bank ${'ABCD'[i]}`);
    const body = h('div', 'cp-bank-body', col);
    const tube = h('div', 'cp-rod-tube', body);
    const fill = h('div', 'cp-rod-fill', tube);
    const target = h('div', 'cp-rod-target', tube);
    const slider = h('input', 'cp-rod-slider', body);
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '0.5';
    slider.addEventListener('input', () => ctx.reactor().setRodTarget(i, Number(slider.value)));
    const pos = h('div', 'cp-rod-pos', col);
    return { fill, target, slider, pos };
  });
  const allRow = h('div', 'cp-btnrow', rods);
  h('div', 'cp-label wide', allRow, 'All banks');
  const step = (d: number) => () => ctx.reactor().nudgeRods(d);
  button(allRow, 'IN 5', step(5));
  button(allRow, 'IN 1', step(1));
  button(allRow, 'IN 0.2', step(0.2));
  button(allRow, 'HOLD', () => ctx.reactor().holdRods(), 'hold');
  button(allRow, 'OUT 0.2', step(-0.2));
  button(allRow, 'OUT 1', step(-1));
  button(allRow, 'OUT 5', step(-5));
  const rodLamps = h('div', 'cp-lamps', rods);
  const moving = lamp(rodLamps, 'Rods moving');
  const allIn = lamp(rodLamps, 'All rods in');
  const avg = readout(rods, 'Average insertion', '%');

  const prot = section(el, 'Reactor protection');
  const scramBtn = button(prot, 'SCRAM', () => ctx.reactor().scram('manual'), 'cp-scram');
  scramBtn.title = 'Manual reactor trip: drives all rods in';
  const tripLamp = lamp(prot, 'Reactor tripped');
  const tripCause = h('div', 'cp-note', prot);
  const resetBtn = button(prot, 'Reset trip', () => ctx.reactor().resetScram());
  h('div', 'cp-divider', prot);
  h('div', 'cp-label', prot, 'Safety bypass keyswitch');
  const keyBtn = button(prot, 'NORMAL', () => {
    const r = ctx.reactor();
    if (r.state.safetyBypass) r.setSafetyBypass(false);
    else confirm.hidden = false;
  }, 'cp-key');
  const confirm = h('div', 'cp-confirm', prot);
  confirm.hidden = true;
  h('p', '', confirm, 'Bypass disables automatic trips, auxiliary feedwater and safety injection. Turn the key?');
  const crow = h('div', 'cp-btnrow', confirm);
  button(crow, 'Turn to BYPASS', () => {
    ctx.reactor().setSafetyBypass(true);
    confirm.hidden = true;
  }, 'danger');
  button(crow, 'Cancel', () => {
    confirm.hidden = true;
  });
  const bypassLamp = lamp(prot, 'Safeties bypassed');
  const setpoints = h('div', 'cp-note', prot);
  const t = SIM_CONFIG.trips;
  setpoints.innerHTML =
    `Trips: flux &gt; ${(t.highFlux * 100).toFixed(0)}% · SUR &gt; ${t.startupRateDpm} DPM (&lt;10%) · ` +
    `pressure &gt; ${t.highPressure} or &lt; ${t.lowPressure} MPa · flow &lt; ${t.lowFlow * 100}% (&gt;30%) · ` +
    `core &gt; ${t.highCoreTemp}°C · SG level &lt; ${t.lowSgLevel}% · turbine trip (&gt;50%)`;

  return {
    title: 'Reactor Control',
    el,
    update() {
      const s = ctx.reactor().state;
      const st = reactorStatus(s);
      status.set(st, STATUS_TONE[st]);
      const pct = s.neutronFlux * 100;
      power.set(pct < 0.01 ? pct.toExponential(1) : pct.toFixed(pct < 10 ? 2 : 1), s.neutronFlux > 1.03 ? 'bad' : 'ok');
      const lf = Math.log10(Math.max(1e-9, s.neutronFlux));
      logFlux.set(lf, s.neutronFlux.toExponential(1), s.neutronFlux > 1.03 ? 'bad' : 'info');
      sur.set(sign(s.startupRate, 2), s.startupRate > 2 ? 'bad' : s.startupRate > 1 ? 'warn' : 'ok');
      const r = s.reactivity;
      rho.set(r.total, `${sign(r.total)} pcm`, Math.abs(r.total) < 50 ? 'ok' : r.total > 0 ? 'warn' : 'info');
      parts.textContent = `rods ${sign(r.rods)} · fuel ${sign(r.fuel)} · temperature ${sign(r.temperature)} · xenon ${sign(r.xenon)}`;
      core.set(s.coreTemp.toFixed(0), s.coreTemp > SIM_CONFIG.trips.highCoreTemp - 20 ? 'warn' : 'ok');
      decay.set(s.decayHeatMW.toFixed(1));
      let anyMoving = false;
      banks.forEach((b, i) => {
        b.fill.style.height = `${s.rodBanks[i]}%`;
        b.target.style.top = `${s.rodTargets[i]}%`;
        if (document.activeElement !== b.slider) b.slider.value = String(s.rodTargets[i]);
        b.slider.disabled = s.scram.active;
        b.pos.textContent = s.rodBanks[i].toFixed(1);
        if (Math.abs(s.rodBanks[i] - s.rodTargets[i]) > 0.05) anyMoving = true;
      });
      moving.set(anyMoving, s.scram.active ? 'red' : 'amber');
      allIn.set(s.rodBanks.every((x) => x > 99.9), 'green');
      avg.set(averageRodInsertion(s).toFixed(1));
      tripLamp.set(s.scram.active, 'red');
      tripCause.textContent = s.scram.cause ? `Cause: ${TRIP_LABELS[s.scram.cause]}` : '';
      setEnabled(resetBtn, s.scram.active);
      keyBtn.textContent = s.safetyBypass ? 'BYPASS — click to restore' : 'NORMAL';
      keyBtn.classList.toggle('bypassed', s.safetyBypass);
      bypassLamp.set(s.safetyBypass, 'red');
    },
  };
}

// ---------------------------------------------------------------- primary loop

function primaryPanel(ctx: PanelContext): PanelView {
  const el = h('div', 'cp-grid cols-3');

  const pumps = section(el, 'Reactor coolant pumps');
  const pumpRows = [0, 1, 2, 3].map((i) => {
    const row = h('div', 'cp-pump', pumps);
    const l = lamp(row, `RCP ${i + 1}`);
    const sp = meter(row, 'speed', 0, 1);
    const btn = button(row, 'START', () => {
      const r = ctx.reactor();
      r.setCoolantPump(i, !r.state.coolantPumps[i].on);
    });
    return { l, sp, btn };
  });
  const prow = h('div', 'cp-btnrow', pumps);
  button(prow, 'Start all', () => ctx.reactor().setAllCoolantPumps(true));
  button(prow, 'Stop all', () => ctx.reactor().setAllCoolantPumps(false));
  const flow = meter(pumps, 'Coolant flow', 0, 1.05, { marks: [{ at: SIM_CONFIG.trips.lowFlow, tone: 'bad' }] });

  const loop = section(el, 'Loop conditions');
  const thot = readout(loop, 'Hot leg', '°C');
  const tcold = readout(loop, 'Cold leg', '°C');
  const tavg = readout(loop, 'T-avg', '°C', true);
  const press = meter(loop, 'Primary pressure', 12, 17.5, {
    unit: 'MPa', decimals: 2,
    marks: [
      { at: SIM_CONFIG.trips.lowPressure, tone: 'bad' }, { at: SIM_CONFIG.pressure.nominal, tone: 'info' },
      { at: SIM_CONFIG.trips.highPressure, tone: 'bad' },
    ],
  });
  const sub = readout(loop, 'Subcooling margin', '°C');
  const inv = meter(loop, 'Coolant inventory', 0, 100, { unit: '%', marks: [{ at: SIM_CONFIG.inventory.uncoverStart, tone: 'bad' }] });
  const loopLamps = h('div', 'cp-lamps', loop);
  const boil = lamp(loopLamps, 'Boiling');
  const porv = lamp(loopLamps, 'Relief valve open');
  const si = lamp(loopLamps, 'Safety injection');

  const pzr = section(el, 'Pressurizer & feedwater');
  const pmode = segmented(pzr, 'Pressurizer control', ['AUTO', 'MANUAL'], (o) => {
    const r = ctx.reactor();
    if (o === 'AUTO') r.setPressurizerAuto(true);
    else r.setPressurizerManual(r.state.pressurizerHeaters, r.state.pressurizerSpray);
  });
  const prow2 = h('div', 'cp-btnrow', pzr);
  const heatBtn = button(prow2, 'Heaters', () => {
    const r = ctx.reactor();
    r.setPressurizerManual(!r.state.pressurizerHeaters, r.state.pressurizerSpray);
  });
  const sprayBtn = button(prow2, 'Spray', () => {
    const r = ctx.reactor();
    r.setPressurizerManual(r.state.pressurizerHeaters, !r.state.pressurizerSpray);
  });
  h('div', 'cp-divider', pzr);
  const frow = h('div', 'cp-btnrow', pzr);
  h('div', 'cp-label wide', frow, 'Main feed pumps');
  const feedBtns = [0, 1].map((i) => button(frow, `FP ${i + 1}`, () => {
    const r = ctx.reactor();
    r.setFeedPump(i, !r.state.feedPumps[i]);
  }));
  const afw = segmented(pzr, 'Auxiliary feedwater', ['AUTO', 'ON', 'OFF'], (o) => ctx.reactor().setAuxFeed(o.toLowerCase() as 'auto' | 'on' | 'off'));
  const afwLamp = lamp(pzr, 'Aux feed running');
  const sg = meter(pzr, 'Steam generator level', 0, 100, {
    unit: '%', marks: [{ at: SIM_CONFIG.trips.lowSgLevel, tone: 'bad' }, { at: SIM_CONFIG.feedwater.nominalLevel, tone: 'info' }],
  });

  return {
    title: 'Primary Loop',
    el,
    update() {
      const s = ctx.reactor().state;
      s.coolantPumps.forEach((p, i) => {
        const row = pumpRows[i];
        row.l.set(p.speed > 0.05, p.speed > 0.95 ? 'green' : 'amber');
        row.sp.set(p.speed, `${(p.speed * 100).toFixed(0)}%`);
        row.btn.textContent = p.on ? 'STOP' : 'START';
        setActive(row.btn, p.on);
      });
      flow.set(s.coolantFlow, `${(s.coolantFlow * 100).toFixed(0)}%`, s.coolantFlow < SIM_CONFIG.trips.lowFlow && s.neutronFlux > 0.1 ? 'bad' : 'ok');
      thot.set(s.hotLegTemp.toFixed(1));
      tcold.set(s.coldLegTemp.toFixed(1));
      tavg.set(s.coolantTemp.toFixed(1));
      const pTone: Tone = s.primaryPressure > 16.2 || s.primaryPressure < 14 ? 'bad' : 'ok';
      press.set(s.primaryPressure, undefined, pTone);
      sub.set(s.subcooling.toFixed(0), s.subcooling < 15 ? 'bad' : s.subcooling < 25 ? 'warn' : 'ok');
      inv.set(s.primaryInventory, undefined, s.primaryInventory < 90 ? 'bad' : 'ok');
      boil.set(s.boiling, 'red');
      porv.set(s.porvOpen, 'red');
      si.set(s.safetyInjection, 'amber');
      pmode.set(s.pressurizerAuto ? 'AUTO' : 'MANUAL');
      setActive(heatBtn, s.pressurizerHeaters);
      setActive(sprayBtn, s.pressurizerSpray);
      feedBtns.forEach((b, i) => setActive(b, s.feedPumps[i]));
      afw.set(s.auxFeed.toUpperCase());
      afwLamp.set(s.auxFeedRunning, 'amber');
      sg.set(s.steamGeneratorLevel, undefined, s.steamGeneratorLevel < 30 || s.steamGeneratorLevel > 70 ? 'warn' : 'ok');
    },
  };
}

// ---------------------------------------------------------------- turbine & grid

function turbinePanel(ctx: PanelContext): PanelView {
  const el = h('div', 'cp-grid cols-3');

  const spd = section(el, 'Turbine speed');
  const rpm = readout(spd, 'Turbine speed', 'rpm', true);
  const rpmBar = meter(spd, 'Speed', 0, 4000, {
    marks: [{ at: TB.syncRpm, tone: 'info' }, { at: TB.overspeedRpm, tone: 'bad' }],
  });
  const target = readout(spd, 'Speed target (governor)', 'rpm');
  const trow = h('div', 'cp-btnrow', spd);
  const adj = (d: number) => () => {
    const r = ctx.reactor();
    r.setTurbineSpeedTarget(r.state.turbineSpeedTarget + d);
  };
  const speedBtns = [
    button(trow, '−300', adj(-300)), button(trow, '−100', adj(-100)), button(trow, '−10', adj(-10)),
    button(trow, '+10', adj(10)), button(trow, '+100', adj(100)), button(trow, '+300', adj(300)),
  ];
  const presetRow = h('div', 'cp-btnrow', spd);
  const preset = button(presetRow, `Set ${TB.syncRpm} rpm`, () => ctx.reactor().setTurbineSpeedTarget(TB.syncRpm));
  const steamT = readout(spd, 'Steam temperature', '°C');
  h('div', 'cp-note', spd, 'The turbine needs steam above ~150 °C. Steam dumps hold the plant near 292 °C while off-grid.');

  const sync = section(el, 'Synchronising');
  const scope = h('canvas', 'cp-synchroscope', sync);
  scope.width = scope.height = 180;
  const sg = scope.getContext('2d')!;
  const inWindow = lamp(sync, `Speed in window (${TB.syncRpm} ±${TB.syncWindow})`);
  const syncBtn = button(sync, 'SYNC GENERATOR', () => ctx.reactor().syncGenerator(), 'cp-sync');
  const genLamp = lamp(sync, 'Generator on grid');
  h('div', 'cp-divider', sync);
  const tripBtn = button(sync, 'Trip turbine', () => ctx.reactor().tripTurbine('manual turbine trip'), 'danger');
  const tripLamp = lamp(sync, 'Turbine tripped');
  const resetBtn = button(sync, 'Reset turbine', () => ctx.reactor().resetTurbine());

  const load = section(el, 'Load');
  const mwe = readout(load, 'Generator output', 'MWe', true);
  const demand = readout(load, 'Grid demand', 'MW');
  const valve = meter(load, 'Governor valve', 0, 1, { decimals: 1 });
  const vrow = h('div', 'cp-btnrow', load);
  const vadj = (d: number) => () => {
    const r = ctx.reactor();
    r.setGovernorValve(r.state.governorValve + d);
  };
  const valveBtns = [
    button(vrow, '−5%', vadj(-0.05)), button(vrow, '−1%', vadj(-0.01)), button(vrow, '+1%', vadj(0.01)), button(vrow, '+5%', vadj(0.05)),
  ];
  const vacuum = meter(load, 'Condenser vacuum', 0, 100, { unit: '%', marks: [{ at: SIM_CONFIG.cooling.vacuumTrip, tone: 'bad' }] });
  const dump = readout(load, 'Steam dump', '%');
  const ch = chart(load, 'Output vs demand · last hour', 110);

  let phase = 0;
  let chartTimer = 0;
  return {
    title: 'Turbine & Grid',
    el,
    update(dt) {
      const r = ctx.reactor();
      const s = r.state;
      rpm.set(s.turbineRPM.toFixed(0), s.turbineRPM > TB.overspeedRpm - 150 ? 'bad' : 'ok');
      rpmBar.set(s.turbineRPM, `${s.turbineRPM.toFixed(0)} rpm`);
      target.set(s.generatorSynced ? 'on grid' : s.turbineSpeedTarget.toFixed(0), s.generatorSynced ? 'dim' : 'ok');
      speedBtns.forEach((b) => setEnabled(b, !s.generatorSynced && !s.turbineTripped));
      setEnabled(preset, !s.generatorSynced && !s.turbineTripped);
      steamT.set(s.secondaryTemp.toFixed(0), s.secondaryTemp < SIM_CONFIG.steam.minTemp ? 'dim' : 'ok');

      // Synchroscope: the pointer spins at the slip between turbine and grid.
      const slip = s.generatorSynced ? 0 : (s.turbineRPM - TB.syncRpm) / 60;
      phase += slip * 0.35 * Math.PI * 2 * dt;
      const W = scope.width;
      sg.clearRect(0, 0, W, W);
      sg.fillStyle = '#0b1210';
      sg.beginPath();
      sg.arc(W / 2, W / 2, W / 2 - 4, 0, Math.PI * 2);
      sg.fill();
      sg.strokeStyle = '#3a4a42';
      sg.lineWidth = 3;
      sg.stroke();
      sg.fillStyle = 'rgba(80,220,120,0.35)';
      sg.beginPath();
      sg.moveTo(W / 2, W / 2);
      sg.arc(W / 2, W / 2, W / 2 - 8, -Math.PI / 2 - 0.2, -Math.PI / 2 + 0.2);
      sg.fill();
      sg.fillStyle = '#9aa59e';
      sg.font = '600 12px Bahnschrift, sans-serif';
      sg.textAlign = 'center';
      sg.fillText('SLOW', W * 0.25, W * 0.85);
      sg.fillText('FAST', W * 0.75, W * 0.85);
      const live = !s.generatorSynced && s.turbineRPM > 300;
      const ang = s.generatorSynced ? 0 : live ? phase : Math.PI;
      sg.strokeStyle = s.generatorSynced ? '#5fdc84' : live ? '#ffcf5a' : '#555';
      sg.lineWidth = 4;
      sg.beginPath();
      sg.moveTo(W / 2, W / 2);
      sg.lineTo(W / 2 + Math.sin(ang) * (W / 2 - 16), W / 2 - Math.cos(ang) * (W / 2 - 16));
      sg.stroke();

      const ok = Math.abs(s.turbineRPM - TB.syncRpm) <= TB.syncWindow && !s.turbineTripped;
      inWindow.set(ok, 'green');
      setEnabled(syncBtn, ok && !s.generatorSynced);
      genLamp.set(s.generatorSynced, 'green');
      setEnabled(tripBtn, !s.turbineTripped);
      tripLamp.set(s.turbineTripped, 'red');
      setEnabled(resetBtn, s.turbineTripped);

      mwe.set(s.electricalOutputMW.toFixed(0), s.generatorSynced ? 'ok' : 'dim');
      const d = ctx.demandMW();
      demand.set(d.toFixed(0), 'warn');
      valve.set(s.governorValve, `${(s.governorValve * 100).toFixed(1)}%`);
      valveBtns.forEach((b) => setEnabled(b, s.generatorSynced));
      vacuum.set(s.condenserVacuum, undefined, s.condenserVacuum < 85 ? 'warn' : 'ok');
      dump.set((s.steamDump * 100).toFixed(0), s.steamDump > 0.01 ? 'warn' : 'dim');

      chartTimer -= dt;
      if (chartTimer <= 0) {
        chartTimer = 0.5;
        const now = ctx.gameSeconds();
        const w = ctx.trends.window(now, 3600);
        ch.draw([
          { values: w.map((x) => x.demandMW), color: '#ffbf3c', min: 0, max: 1100, label: 'demand' },
          { values: w.map((x) => x.electricalMW), color: '#7dffb0', min: 0, max: 1100, label: 'output' },
        ], w.map((x) => x.t));
      }
    },
  };
}

// ---------------------------------------------------------------- cooling water

function coolingPanel(ctx: PanelContext): PanelView {
  const el = h('div', 'cp-grid cols-2');

  const pumps = section(el, 'River intake & towers');
  const intakeRow = h('div', 'cp-btnrow', pumps);
  h('div', 'cp-label wide', intakeRow, 'Intake pumps');
  const intake = [0, 1].map((i) => button(intakeRow, `CW ${i + 1}`, () => {
    const r = ctx.reactor();
    r.setIntakePump(i, !r.state.intakePumps[i]);
  }));
  const fanRow = h('div', 'cp-btnrow', pumps);
  h('div', 'cp-label wide', fanRow, 'Cooling tower fans');
  button(fanRow, '−', () => {
    const r = ctx.reactor();
    r.setTowerFans(r.state.towerFans - 1);
  });
  const fans = h('span', 'cp-count', fanRow);
  button(fanRow, '+', () => {
    const r = ctx.reactor();
    r.setTowerFans(r.state.towerFans + 1);
  });
  const cap = readout(pumps, 'Cooling capacity', 'MW');
  h('div', 'cp-note', pumps, 'Each intake pump carries about half of full-power heat rejection. More fans raise capacity; hot weather lowers it.');

  const cond = section(el, 'Condenser & outfall');
  const vac = meter(cond, 'Condenser vacuum', 0, 100, {
    unit: '%', marks: [{ at: SIM_CONFIG.cooling.vacuumTrip, tone: 'bad' }, { at: 85, tone: 'warn' }],
  });
  const loadM = meter(cond, 'Heat load / capacity', 0, 1.3, { marks: [{ at: 0.8, tone: 'warn' }, { at: 1, tone: 'bad' }] });
  const cw = readout(cond, 'Cooling water (condenser outlet)', '°C');
  const out = readout(cond, 'Outfall to river', '°C', true);
  h('div', 'cp-note', cond, 'Outfall above 28 °C breaks the environmental permit (fines arrive with the management layer).');

  return {
    title: 'Circulating Water',
    el,
    update() {
      const s = ctx.reactor().state;
      intake.forEach((b, i) => {
        setActive(b, s.intakePumps[i]);
        b.textContent = `CW ${i + 1} ${s.intakePumps[i] ? 'ON' : 'OFF'}`;
      });
      fans.textContent = `${s.towerFans} / ${SIM_CONFIG.cooling.towerFans}`;
      cap.set(s.coolingCapacityMW.toFixed(0));
      vac.set(s.condenserVacuum, undefined, s.condenserVacuum < 85 ? 'warn' : 'ok');
      const ratio = s.coolingCapacityMW > 0 ? s.condenserLoadMW / s.coolingCapacityMW : 0;
      loadM.set(ratio, `${s.condenserLoadMW.toFixed(0)} / ${s.coolingCapacityMW.toFixed(0)} MW`, ratio > 1 ? 'bad' : ratio > 0.8 ? 'warn' : 'ok');
      cw.set(s.coolingWaterTemp.toFixed(1));
      out.set(s.outfallTemp.toFixed(1), s.outfallTemp > 28 ? 'bad' : s.outfallTemp > 25 ? 'warn' : 'ok');
    },
  };
}

// ---------------------------------------------------------------- grid dispatch

function gridPanel(ctx: PanelContext): PanelView {
  const el = h('div', 'cp-grid cols-3');
  const cfg = GRID_CONFIG;

  const bal = section(el, 'Balance');
  const freq = readout(bal, 'Grid frequency', 'Hz', true);
  const fm = meter(bal, 'Frequency', 57, 63, {
    marks: [{ at: 59.5, tone: 'warn' }, { at: 60, tone: 'info' }, { at: 60.5, tone: 'warn' }, { at: cfg.overFreqTripHz, tone: 'bad' }],
  });
  const gen = readout(bal, 'Generation', 'MW');
  const dem = readout(bal, 'Demand', 'MW');
  const served = readout(bal, 'Served', 'MW');
  const otrip = meter(bal, 'Over-frequency trip timer', 0, cfg.overFreqDelay, { unit: 's', decimals: 1 });
  h('div', 'cp-note', bal,
    `Island grid: Riverbend is the only generator. Short of power, districts are blacked out in rotation every ${cfg.rotationPeriod / 60} game minutes. ` +
    `Too much power pushes frequency up; above ${cfg.overFreqTripHz} Hz for ${cfg.overFreqDelay} s the generator breaker opens.`);

  const subs = section(el, 'Substations');
  const rows = SUBSTATIONS.map((d) => {
    const box = h('div', 'cp-sub', subs);
    const head = h('div', 'cp-sub-head', box);
    const l = lamp(head, d.name);
    const mw = h('span', 'cp-sub-mw', head);
    const feeders = h('div', 'cp-feeders', box);
    const dots = Array.from({ length: d.feeders }, (_, i) => {
      const f = h('span', 'cp-feeder', feeders);
      f.title = d.id === 'town' ? TOWN_DISTRICT_NAMES[i] : `Feeder ${i + 1}`;
      return f;
    });
    return { d, l, mw, dots };
  });

  const town = section(el, 'Millbrook districts');
  const districts = TOWN_DISTRICT_NAMES.map((n) => {
    const r = h('div', 'cp-district', town);
    return { l: lamp(r, n) };
  });
  const shedLamp = lamp(town, 'Load shedding active');
  const rot = h('div', 'cp-note', town);
  const unserved = readout(town, 'Unserved energy (total)', 'MWh');

  return {
    title: 'Grid Dispatch',
    el,
    update() {
      const g = ctx.grid().state;
      freq.set(g.dead ? 'DEAD' : g.frequency.toFixed(2), g.dead ? 'bad' : g.frequency > 60.5 || g.frequency < 59.5 ? 'warn' : 'ok');
      fm.set(g.dead ? 57 : g.frequency, g.dead ? '—' : `${g.frequency.toFixed(2)} Hz`, g.frequency > cfg.overFreqTripHz ? 'bad' : 'ok');
      gen.set(g.supplyMW.toFixed(0));
      dem.set(g.demandMW.toFixed(0), 'warn');
      served.set(g.servedMW.toFixed(0), g.shedFraction > 0 ? 'bad' : 'ok');
      otrip.set(g.overFreqTimer, undefined, g.overFreqTimer > 0 ? 'bad' : 'ok');
      for (const r of rows) {
        const s = g.subs[r.d.id];
        const connected = s.breakerClosed && s.lineUp;
        r.l.set(true, !connected ? 'red' : g.dead ? 'white' : s.feedersOff.length ? 'amber' : 'green');
        r.mw.textContent = `${s.servedMW.toFixed(0)} / ${s.demandMW.toFixed(0)} MW`;
        r.dots.forEach((dot, i) => dot.classList.toggle('off', !ctx.grid().isFeederPowered(r.d.id, i)));
      }
      districts.forEach((d, i) => d.l.set(ctx.grid().isFeederPowered('town', i), 'green'));
      shedLamp.set(!g.dead && g.shedFraction > 0, 'red');
      const mins = Math.max(0, (g.nextRotationAt - ctx.gameSeconds()) / 60);
      rot.textContent = g.shedFraction > 0 && !g.dead ? `Next rotation in ${mins.toFixed(0)} game min.` : '';
      unserved.set(g.stats.unservedMWh.toFixed(0), 'dim');
    },
  };
}

// ---------------------------------------------------------------- annunciator

function annunciatorPanel(ctx: PanelContext): PanelView {
  const el = h('div', 'cp-annun');
  const grid = h('div', 'cp-tiles', el);
  const tiles = ANNUNCIATOR_TILES.map((a) => {
    const t = h('div', 'cp-tile', grid, a.label);
    t.dataset.sev = a.severity;
    return t;
  });
  const row = h('div', 'cp-btnrow', el);
  button(row, 'ACKNOWLEDGE', () => ctx.annunciator.acknowledge(ctx.activeAlarms()), 'cp-ack');
  button(row, 'SILENCE HORN', () => ctx.annunciator.silence());
  button(row, 'RESET', () => ctx.annunciator.reset());
  const legend = h('div', 'cp-note', el);
  legend.innerHTML =
    '<b>Fast flash</b> new alarm · <b>steady</b> acknowledged, still active · <b>slow flash</b> cleared, press reset. ' +
    'Colours: <span class="sev-trip">trip</span> <span class="sev-alarm">alarm</span> <span class="sev-warning">warning</span>.';
  const list = h('div', 'cp-alarm-list', el);
  return {
    title: 'Annunciator',
    el,
    update() {
      const st = ctx.annunciator.state;
      ANNUNCIATOR_TILES.forEach((a, i) => {
        const s = st.tiles[a.id] ?? 'off';
        if (tiles[i].dataset.state !== s) tiles[i].dataset.state = s;
      });
      const active = ctx.activeAlarms();
      const text = active.length
        ? `Active: ${active.map((id) => ANNUNCIATOR_TILES.find((a) => a.id === id)?.label ?? id).join(' · ')}`
        : 'No active alarms.';
      if (list.textContent !== text) list.textContent = text;
    },
  };
}

// ---------------------------------------------------------------- trends

const WINDOWS: Record<string, number> = { '10 min': 600, '1 h': 3600, '6 h': 21600, '12 h': 43200 };

function trendsPanel(ctx: PanelContext): PanelView {
  const el = h('div', 'cp-trends');
  let windowKey = '1 h';
  const seg = segmented(el, 'Time window (game time)', Object.keys(WINDOWS), (o) => {
    windowKey = o;
    timer = 0;
  });
  const grid = h('div', 'cp-grid cols-2', el);
  const charts = {
    power: chart(grid, 'Reactor power % & rod insertion %', 130),
    sur: chart(grid, 'Startup rate (DPM, −2 … +4)', 130),
    temp: chart(grid, 'T-avg (0–350 °C) & pressure (12–17 MPa)', 130),
    mwe: chart(grid, 'Output vs demand (MW)', 130),
    xenon: chart(grid, 'Xenon (× full-power equilibrium, 0–2.5)', 130),
    flux: chart(grid, 'Neutron flux (log, 1e-8 … 10)', 130),
  };
  let timer = 0;
  return {
    title: 'Trend Recorder',
    el,
    update(dt) {
      seg.set(windowKey);
      timer -= dt;
      if (timer > 0) return;
      timer = 0.5;
      const w: TrendSample[] = ctx.trends.window(ctx.gameSeconds(), WINDOWS[windowKey]);
      const xs = w.map((x) => x.t);
      const v = (k: keyof TrendSample) => w.map((x) => x[k] as number);
      charts.power.draw([
        { values: v('powerPct'), color: '#6cc6ff', min: 0, max: 110, label: 'power' },
        { values: v('rods'), color: '#c98cff', min: 0, max: 100, label: 'rods in' },
      ], xs);
      charts.sur.draw([{ values: v('startupRate'), color: '#ffbf3c', min: -2, max: 4, label: 'SUR' }], xs);
      charts.temp.draw([
        { values: v('coolantTemp'), color: '#ff8a5c', min: 0, max: 350, label: 'T-avg' },
        { values: v('pressure'), color: '#7dffb0', min: 12, max: 17, label: 'pressure' },
      ], xs);
      charts.mwe.draw([
        { values: v('demandMW'), color: '#ffbf3c', min: 0, max: 1100, label: 'demand' },
        { values: v('electricalMW'), color: '#7dffb0', min: 0, max: 1100, label: 'output' },
      ], xs);
      charts.xenon.draw([{ values: v('xenon'), color: '#ff6ad5', min: 0, max: 2.5, label: 'xenon' }], xs);
      charts.flux.draw([{ values: v('logFlux'), color: '#6cc6ff', min: -8, max: 1, label: 'log flux' }], xs);
    },
  };
}

export const PANEL_BUILDERS: Record<PanelId, (ctx: PanelContext) => PanelView> = {
  reactor: reactorPanel,
  primary: primaryPanel,
  turbine: turbinePanel,
  cooling: coolingPanel,
  grid: gridPanel,
  annunciator: annunciatorPanel,
  trends: trendsPanel,
};
