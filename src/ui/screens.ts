/**
 * Drawing for the in-world control-room screens (canvas textures).
 * Phosphor-style readouts: dark glass, green/amber/red text.
 */
import type { Severity } from '../sim/alarms';
import { ANNUNCIATOR_TILES, type AnnunciatorState } from '../sim/annunciator';
import { SUBSTATIONS, type GridState } from '../sim/grid';
import type { TrendSample } from '../sim/history';
import { averageRodInsertion, reactorStatus, type ReactorState } from '../sim/reactor';

export const SCREEN_COLORS = {
  bg: '#05100b',
  grid: 'rgba(80,255,160,0.08)',
  text: '#7dffb0',
  dim: '#3f8f63',
  amber: '#ffbf3c',
  red: '#ff4b3a',
  blue: '#6cc6ff',
};
const C = SCREEN_COLORS;
const MONO = 'Consolas, "Cascadia Mono", monospace';

export const STATUS_COLOR: Record<string, string> = {
  OFFLINE: C.dim, CRITICAL: C.blue, 'AT POWER': C.text, SCRAMMED: C.amber, ALARM: C.red, MELTDOWN: C.red,
};

function frame(g: CanvasRenderingContext2D, w: number, h: number, title: string): void {
  g.fillStyle = C.bg;
  g.fillRect(0, 0, w, h);
  g.strokeStyle = C.grid;
  g.lineWidth = 1;
  for (let y = 0; y < h; y += 4) {
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(w, y + 0.5);
    g.stroke();
  }
  g.fillStyle = C.dim;
  g.font = `700 22px ${MONO}`;
  g.textBaseline = 'top';
  g.fillText(title, 18, 14);
  g.fillRect(18, 44, w - 36, 2);
}

function row(g: CanvasRenderingContext2D, y: number, label: string, value: string, color = C.text): void {
  g.font = `20px ${MONO}`;
  g.fillStyle = C.dim;
  g.fillText(label, 18, y);
  g.font = `700 26px ${MONO}`;
  g.fillStyle = color;
  g.textAlign = 'right';
  g.fillText(value, g.canvas.width - 18, y - 3);
  g.textAlign = 'left';
}

function bar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, frac: number, color: string): void {
  g.strokeStyle = C.dim;
  g.strokeRect(x + 0.5, y + 0.5, w, h);
  g.fillStyle = color;
  g.fillRect(x + 2, y + 2, Math.max(0, Math.min(1, frac)) * (w - 3), h - 3);
}

export function drawReactorScreen(g: CanvasRenderingContext2D, s: ReactorState): void {
  const { width: w, height: h } = g.canvas;
  frame(g, w, h, 'REACTOR');
  const status = reactorStatus(s);
  g.font = `700 22px ${MONO}`;
  g.fillStyle = STATUS_COLOR[status];
  g.textAlign = 'right';
  g.fillText(status, w - 18, 14);
  g.textAlign = 'left';
  g.font = `700 64px ${MONO}`;
  g.fillStyle = s.neutronFlux > 1.03 ? C.red : C.text;
  g.fillText(`${(s.neutronFlux * 100).toFixed(s.neutronFlux < 0.1 ? 3 : 1)}%`, 18, 58);
  // Log flux bar: 1e-8 .. 1e1
  const lf = (Math.log10(Math.max(1e-9, s.neutronFlux)) + 8) / 9;
  bar(g, 18, 136, w - 36, 18, lf, C.blue);
  row(g, 172, 'STARTUP RATE', `${s.startupRate >= 0 ? '+' : ''}${s.startupRate.toFixed(2)} DPM`, s.startupRate > 1 ? C.amber : C.text);
  row(g, 206, 'ROD POSITION', `${averageRodInsertion(s).toFixed(1)}% IN`);
  row(g, 240, 'REACTIVITY', `${s.reactivity.total >= 0 ? '+' : ''}${s.reactivity.total.toFixed(0)} PCM`);
  row(g, 274, 'CORE TEMP', `${s.coreTemp.toFixed(0)} °C`, s.coreTemp > 360 ? C.amber : C.text);
}

export function drawPrimaryScreen(g: CanvasRenderingContext2D, s: ReactorState): void {
  const { width: w, height: h } = g.canvas;
  frame(g, w, h, 'PRIMARY LOOP');
  s.coolantPumps.forEach((p, i) => {
    const x = 18 + i * 60;
    g.fillStyle = p.speed > 0.9 ? C.text : p.speed > 0.05 ? C.amber : '#1d3328';
    g.beginPath();
    g.arc(x + 20, 76, 16, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = C.bg;
    g.font = `700 16px ${MONO}`;
    g.textAlign = 'center';
    g.fillText(String(i + 1), x + 20, 69);
    g.textAlign = 'left';
  });
  g.font = `20px ${MONO}`;
  g.fillStyle = C.dim;
  g.fillText('RCPs', 270, 66);
  row(g, 110, 'FLOW', `${(s.coolantFlow * 100).toFixed(0)}%`);
  row(g, 144, 'T-AVG', `${s.coolantTemp.toFixed(1)} °C`);
  row(g, 178, 'PRESSURE', `${s.primaryPressure.toFixed(2)} MPa`, s.primaryPressure > 16.2 || s.primaryPressure < 14 ? C.amber : C.text);
  row(g, 212, 'SUBCOOLING', `${s.subcooling.toFixed(0)} °C`, s.subcooling < 15 ? C.red : C.text);
  row(g, 246, 'SG LEVEL', `${s.steamGeneratorLevel.toFixed(0)}%`);
  row(g, 280, 'INVENTORY', `${s.primaryInventory.toFixed(0)}%`, s.primaryInventory < 90 ? C.red : C.text);
}

export function drawTurbineScreen(g: CanvasRenderingContext2D, s: ReactorState, demandMW: number): void {
  const { width: w, height: h } = g.canvas;
  frame(g, w, h, 'TURBINE / GRID');
  g.font = `700 22px ${MONO}`;
  g.textAlign = 'right';
  g.fillStyle = s.turbineTripped ? C.red : s.generatorSynced ? C.text : C.dim;
  g.fillText(s.turbineTripped ? 'TRIPPED' : s.generatorSynced ? 'ON GRID' : 'OFF GRID', w - 18, 14);
  g.textAlign = 'left';
  g.font = `700 64px ${MONO}`;
  g.fillStyle = C.text;
  g.fillText(`${s.electricalOutputMW.toFixed(0)} MW`, 18, 58);
  row(g, 140, 'DEMAND', `${demandMW.toFixed(0)} MW`, C.amber);
  row(g, 174, 'TURBINE', `${s.turbineRPM.toFixed(0)} RPM`);
  row(g, 208, 'GOVERNOR', `${(s.governorValve * 100).toFixed(1)}%`);
  row(g, 242, 'STEAM TEMP', `${s.secondaryTemp.toFixed(0)} °C`);
  row(g, 276, 'STEAM DUMP', `${(s.steamDump * 100).toFixed(0)}%`);
}

export function drawCoolingScreen(g: CanvasRenderingContext2D, s: ReactorState): void {
  const { width: w, height: h } = g.canvas;
  frame(g, w, h, 'CIRCULATING WATER');
  row(g, 64, 'CONDENSER VAC', `${s.condenserVacuum.toFixed(0)}%`, s.condenserVacuum < 85 ? C.amber : C.text);
  const frac = s.coolingCapacityMW > 0 ? s.condenserLoadMW / s.coolingCapacityMW : 0;
  row(g, 98, 'HEAT LOAD', `${s.condenserLoadMW.toFixed(0)} / ${s.coolingCapacityMW.toFixed(0)} MW`);
  bar(g, 18, 130, w - 36, 16, frac, frac > 0.95 ? C.red : frac > 0.8 ? C.amber : C.text);
  row(g, 164, 'INTAKE PUMPS', s.intakePumps.map((p) => (p ? 'ON' : '--')).join(' '));
  row(g, 198, 'TOWER FANS', `${s.towerFans} / 4`);
  row(g, 232, 'COOLING WATER', `${s.coolingWaterTemp.toFixed(1)} °C`);
  row(g, 266, 'OUTFALL', `${s.outfallTemp.toFixed(1)} °C`, s.outfallTemp > 28 ? C.red : C.text);
}

/** Line chart of a numeric field over samples. */
export function drawChart(
  g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  samples: readonly TrendSample[], series: ReadonlyArray<{ key: keyof TrendSample; color: string; min: number; max: number }>,
  t0: number, t1: number,
): void {
  g.strokeStyle = C.dim;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w, h);
  for (let i = 1; i < 4; i++) {
    g.strokeStyle = C.grid;
    g.beginPath();
    g.moveTo(x, y + (h * i) / 4);
    g.lineTo(x + w, y + (h * i) / 4);
    g.stroke();
  }
  if (samples.length < 2) return;
  const span = Math.max(1, t1 - t0);
  for (const sr of series) {
    g.strokeStyle = sr.color;
    g.lineWidth = 2;
    g.beginPath();
    samples.forEach((sm, i) => {
      const v = sm[sr.key] as number;
      const px = x + ((sm.t - t0) / span) * w;
      const py = y + h - ((v - sr.min) / (sr.max - sr.min)) * h;
      const cy = Math.max(y, Math.min(y + h, py));
      if (i === 0) g.moveTo(px, cy);
      else g.lineTo(px, cy);
    });
    g.stroke();
  }
}

export function drawTrendScreen(g: CanvasRenderingContext2D, samples: readonly TrendSample[], now: number): void {
  const { width: w, height: h } = g.canvas;
  frame(g, w, h, 'TRENDS · LAST HOUR');
  const t0 = now - 3600;
  drawChart(g, 18, 60, w - 36, (h - 90) / 2, samples, [{ key: 'powerPct', color: C.blue, min: 0, max: 110 }], t0, now);
  drawChart(g, 18, 70 + (h - 90) / 2, w - 36, (h - 90) / 2, samples, [
    { key: 'coolantTemp', color: C.amber, min: 0, max: 350 },
    { key: 'electricalMW', color: C.text, min: 0, max: 1100 },
  ], t0, now);
  g.font = `16px ${MONO}`;
  g.fillStyle = C.blue;
  g.fillText('POWER %', 26, 66);
  g.fillStyle = C.amber;
  g.fillText('T-AVG', 26, 76 + (h - 90) / 2);
  g.fillStyle = C.text;
  g.fillText('MWe', 100, 76 + (h - 90) / 2);
}

export function drawGridScreen(g: CanvasRenderingContext2D, grid: GridState): void {
  const { width: w, height: h } = g.canvas;
  frame(g, w, h, 'GRID DISPATCH');
  g.font = `700 22px ${MONO}`;
  g.textAlign = 'right';
  const hzBad = grid.dead || grid.frequency > 60.5 || grid.frequency < 59.5;
  g.fillStyle = grid.dead ? C.red : hzBad ? C.amber : C.text;
  g.fillText(grid.dead ? 'GRID DEAD' : `${grid.frequency.toFixed(2)} Hz`, w - 18, 14);
  g.textAlign = 'left';
  row(g, 60, 'GENERATION', `${grid.supplyMW.toFixed(0)} MW`);
  row(g, 94, 'DEMAND', `${grid.demandMW.toFixed(0)} MW`, C.amber);
  row(g, 128, 'SHEDDING', grid.shedFraction > 0 ? `${(grid.shedFraction * 100).toFixed(0)}%` : 'NONE', grid.shedFraction > 0 ? C.red : C.text);
  SUBSTATIONS.forEach((d, i) => {
    const s = grid.subs[d.id];
    const y = 170 + i * 36;
    g.font = `20px ${MONO}`;
    g.fillStyle = C.dim;
    g.fillText(d.name.toUpperCase().slice(0, 14), 18, y);
    for (let f = 0; f < d.feeders; f++) {
      const on = !grid.dead && s.breakerClosed && s.lineUp && !s.feedersOff.includes(f);
      g.fillStyle = on ? C.text : '#3a1712';
      g.fillRect(230 + f * 30, y, 22, 20);
    }
  });
}

const SEV_COLOR: Record<Severity, string> = { trip: '#ff3b2f', alarm: '#ffb020', warning: '#f5e8a0' };

/** Annunciator tile wall. `flash` toggles ~3 Hz, `slow` ~1 Hz. */
export function drawAnnunciator(g: CanvasRenderingContext2D, ann: AnnunciatorState, flash: boolean, slow: boolean): void {
  const { width: w, height: h } = g.canvas;
  g.fillStyle = '#111416';
  g.fillRect(0, 0, w, h);
  const cols = 8;
  const rows = Math.ceil(ANNUNCIATOR_TILES.length / cols);
  const pad = 6;
  const tw = (w - pad * (cols + 1)) / cols;
  const th = (h - pad * (rows + 1)) / rows;
  ANNUNCIATOR_TILES.forEach((a, i) => {
    const cx = pad + (i % cols) * (tw + pad);
    const cy = pad + Math.floor(i / cols) * (th + pad);
    const st = ann.tiles[a.id] ?? 'off';
    const lit = st === 'acked' || (st === 'alerting' && flash) || (st === 'clearing' && slow);
    g.fillStyle = lit ? SEV_COLOR[a.severity] : '#2a2f33';
    g.fillRect(cx, cy, tw, th);
    g.fillStyle = lit ? '#1a1206' : '#5b6268';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const words = a.label.toUpperCase().split(' ');
    const mid = Math.ceil(words.length / 2);
    const lines = [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
    // Shrink the font until the longest line fits the tile.
    let size = Math.round(th * 0.2);
    g.font = `700 ${size}px ${MONO}`;
    const widest = Math.max(...lines.map((l) => g.measureText(l).width));
    if (widest > tw * 0.88) {
      size = Math.floor((size * tw * 0.88) / widest);
      g.font = `700 ${size}px ${MONO}`;
    }
    g.fillText(lines[0], cx + tw / 2, cy + th * 0.36);
    g.fillText(lines[1], cx + tw / 2, cy + th * 0.66);
  });
  g.textAlign = 'left';
  g.textBaseline = 'top';
}
