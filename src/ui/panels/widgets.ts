/** Small DOM widgets for the control panels. Each returns a handle with a cheap set(). */

export type Tone = 'ok' | 'warn' | 'bad' | 'dim' | 'info';

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, parent?: HTMLElement, text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

export function section(parent: HTMLElement, title: string, cls = ''): HTMLElement {
  const s = h('section', `cp-section ${cls}`, parent);
  h('h3', 'cp-section-title', s, title);
  return s;
}

function setTone(e: HTMLElement, tone: Tone): void {
  if (e.dataset.tone !== tone) e.dataset.tone = tone;
}

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export interface Readout {
  set(text: string, tone?: Tone): void;
}

export function readout(parent: HTMLElement, label: string, unit = '', big = false): Readout {
  const w = h('div', `cp-readout${big ? ' big' : ''}`, parent);
  h('div', 'cp-label', w, label);
  const row = h('div', 'cp-lcd', w);
  const v = h('span', 'cp-value', row, '—');
  if (unit) h('span', 'cp-unit', row, unit);
  return {
    set(text, tone = 'ok') {
      setText(v, text);
      setTone(row, tone);
    },
  };
}

export interface Lamp {
  set(on: boolean, color?: 'green' | 'amber' | 'red' | 'blue' | 'white'): void;
}

export function lamp(parent: HTMLElement, label: string): Lamp {
  const w = h('div', 'cp-lamp', parent);
  const bulb = h('span', 'cp-bulb', w);
  h('span', 'cp-lamp-label', w, label);
  return {
    set(on, color = 'green') {
      const c = on ? color : 'off';
      if (bulb.dataset.c !== c) bulb.dataset.c = c;
    },
  };
}

export function button(parent: HTMLElement, label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = h('button', `cp-btn ${cls}`, parent, label);
  b.type = 'button';
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

export function setEnabled(b: HTMLButtonElement, on: boolean): void {
  if (b.disabled === on) b.disabled = !on;
}

export function setActive(e: HTMLElement, on: boolean): void {
  e.classList.toggle('active', on);
}

export interface Meter {
  set(value: number, text?: string, tone?: Tone): void;
}

/** Horizontal bar meter with optional setpoint marks. */
export function meter(
  parent: HTMLElement, label: string, min: number, max: number,
  opts: { marks?: Array<{ at: number; tone: Tone }>; unit?: string; decimals?: number } = {},
): Meter {
  const w = h('div', 'cp-meter', parent);
  const head = h('div', 'cp-meter-head', w);
  h('span', 'cp-label', head, label);
  const val = h('span', 'cp-meter-val', head);
  const track = h('div', 'cp-meter-track', w);
  const fill = h('div', 'cp-meter-fill', track);
  for (const mk of opts.marks ?? []) {
    const m = h('div', 'cp-meter-mark', track);
    m.dataset.tone = mk.tone;
    m.style.left = `${((mk.at - min) / (max - min)) * 100}%`;
  }
  return {
    set(value, text, tone = 'ok') {
      const f = Math.max(0, Math.min(1, (value - min) / (max - min)));
      fill.style.width = `${(f * 100).toFixed(1)}%`;
      setTone(fill, tone);
      setText(val, text ?? `${value.toFixed(opts.decimals ?? 0)}${opts.unit ? ` ${opts.unit}` : ''}`);
    },
  };
}

export interface Segmented {
  set(active: string): void;
}

export function segmented(parent: HTMLElement, label: string, options: string[], onPick: (o: string) => void): Segmented {
  const w = h('div', 'cp-seg-wrap', parent);
  h('div', 'cp-label', w, label);
  const row = h('div', 'cp-seg', w);
  const btns = options.map((o) => button(row, o, () => onPick(o)));
  return {
    set(active) {
      btns.forEach((b, i) => setActive(b, options[i] === active));
    },
  };
}

export interface ChartSeries {
  values: number[];
  color: string;
  min: number;
  max: number;
  label: string;
}

/** Simple line chart on a canvas, redrawn on demand. */
export function chart(parent: HTMLElement, title: string, height = 120): { draw(series: ChartSeries[], xs: number[]): void } {
  const w = h('div', 'cp-chart', parent);
  const head = h('div', 'cp-chart-head', w);
  h('span', 'cp-label', head, title);
  const legend = h('span', 'cp-chart-legend', head);
  const canvas = h('canvas', '', w);
  const g = canvas.getContext('2d')!;
  let lastLegend = '';
  return {
    draw(series, xs) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cw = Math.max(100, canvas.clientWidth);
      if (canvas.width !== Math.round(cw * dpr)) {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.height = `${height}px`;
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#050c09';
      g.fillRect(0, 0, cw, height);
      g.strokeStyle = 'rgba(120,255,170,0.09)';
      g.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        g.beginPath();
        g.moveTo(0, (height * i) / 4 + 0.5);
        g.lineTo(cw, (height * i) / 4 + 0.5);
        g.stroke();
      }
      if (xs.length >= 2) {
        const x0 = xs[0];
        const span = Math.max(1e-6, xs[xs.length - 1] - x0);
        for (const s of series) {
          g.strokeStyle = s.color;
          g.lineWidth = 1.8;
          g.beginPath();
          s.values.forEach((v, i) => {
            const px = ((xs[i] - x0) / span) * (cw - 2) + 1;
            const py = height - 2 - ((v - s.min) / (s.max - s.min)) * (height - 4);
            const cy = Math.max(1, Math.min(height - 1, py));
            if (i === 0) g.moveTo(px, cy);
            else g.lineTo(px, cy);
          });
          g.stroke();
        }
      }
      const lg = series.map((s) => `<i style="background:${s.color}"></i>${s.label}`).join(' ');
      if (lg !== lastLegend) {
        legend.innerHTML = lg;
        lastLegend = lg;
      }
    },
  };
}
