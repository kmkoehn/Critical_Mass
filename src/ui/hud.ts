/** DOM HUD: top bar, crosshair, minimap frame, objectives, toasts, debug panel, start/pause overlay. */
export interface Objective {
  id: string;
  text: string;
  done: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

export class Hud {
  readonly root: HTMLElement;
  readonly minimapCanvas: HTMLCanvasElement;
  readonly bigMapRoot: HTMLElement;
  readonly bigMapCanvas: HTMLCanvasElement;
  private readonly time: HTMLElement;
  private readonly weather: HTMLElement;
  private readonly reactor: HTMLElement;
  private readonly prompt: HTMLElement;
  private readonly gridEl: HTMLElement;
  private readonly crewEl: HTMLElement;
  private readonly cashEl: HTMLElement;
  private readonly opinionEl: HTMLElement;
  private readonly workOrders: HTMLElement;
  private readonly dosimeter: HTMLElement;
  private readonly speedo: HTMLElement;
  private readonly progress: HTMLElement;
  private readonly progressLabel: HTMLElement;
  private readonly progressFill: HTMLElement;
  private readonly fade: HTMLElement;
  private readonly zone: HTMLElement;
  private readonly fps: HTMLElement;
  private readonly objectives: HTMLElement;
  private readonly toasts: HTMLElement;
  private readonly debug: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly overlayTitle: HTMLElement;
  private readonly overlayButton: HTMLButtonElement;
  private readonly loading: HTMLElement;
  private lastText = new Map<HTMLElement, string>();
  onStart: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud', parent);

    const top = el('div', 'topbar', this.root);
    const left = el('div', 'tb-left', top);
    this.time = el('span', 'tb-time', left);
    el('span', 'tb-sep', left);
    this.weather = el('span', 'tb-weather', left);
    el('span', 'tb-sep', left);
    this.reactor = el('span', 'tb-reactor', left);
    el('span', 'tb-sep', left);
    this.gridEl = el('span', 'tb-grid', left);
    el('span', 'tb-sep', left);
    this.crewEl = el('span', 'tb-crew', left);
    const mid = el('div', 'tb-money', top);
    this.cashEl = el('span', 'tb-cash', mid);
    el('span', 'tb-sep', mid);
    this.opinionEl = el('span', 'tb-opinion', mid);
    this.zone = el('div', 'tb-zone', top);
    this.fps = el('div', 'tb-right', top);

    el('div', 'crosshair', this.root);
    this.prompt = el('div', 'interact-prompt', this.root);
    this.prompt.hidden = true;

    const mm = el('div', 'minimap', this.root);
    this.minimapCanvas = el('canvas', '', mm);
    el('div', 'minimap-hint', mm).textContent = 'M  Map';

    const right = el('div', 'right-stack', this.root);
    this.workOrders = el('div', 'work-orders', right);
    this.workOrders.hidden = true;
    this.objectives = el('div', 'objectives', right);
    this.dosimeter = el('div', 'dosimeter', this.root);
    this.dosimeter.hidden = true;
    this.speedo = el('div', 'speedo', this.root);
    this.speedo.hidden = true;
    this.progress = el('div', 'progress', this.root);
    this.progress.hidden = true;
    this.progressLabel = el('div', 'progress-label', this.progress);
    this.progressFill = el('div', 'progress-fill', el('div', 'progress-track', this.progress));
    this.fade = el('div', 'fade', this.root);
    this.fade.hidden = true;
    this.toasts = el('div', 'toasts', this.root);
    this.debug = el('pre', 'debug', this.root);
    this.debug.hidden = true;

    this.bigMapRoot = el('div', 'bigmap', this.root);
    this.bigMapRoot.hidden = true;
    this.bigMapCanvas = el('canvas', '', this.bigMapRoot);
    el('div', 'bigmap-hint', this.bigMapRoot).textContent = 'M  Close map';

    this.overlay = el('div', 'overlay', this.root);
    const card = el('div', 'overlay-card', this.overlay);
    el('div', 'ov-kicker', card).textContent = 'Riverbend Generating Station';
    this.overlayTitle = el('h1', 'ov-title', card);
    this.overlayTitle.textContent = 'Critical Mass';
    el('p', 'ov-sub', card).textContent =
      'You are the new plant director. Get to know the valley before you bring the reactor back to life.';
    const keys = el('div', 'ov-keys', card);
    const bindings: Array<[string, string]> = [
      ['W A S D', 'Move'], ['Mouse', 'Look'], ['Shift', 'Sprint'], ['Space', 'Jump'],
      ['C', 'Crouch'], ['M', 'Map'], ['Esc', 'Pause'], ['`', 'Debug panel'],
    ];
    for (const [k, v] of bindings) {
      el('kbd', '', keys).textContent = k;
      el('span', '', keys).textContent = v;
    }
    this.loading = el('div', 'ov-loading', card);
    this.loading.textContent = 'Building the valley…';
    this.overlayButton = el('button', 'ov-button', card);
    this.overlayButton.textContent = 'Click to start';
    this.overlayButton.hidden = true;
    this.overlay.addEventListener('click', () => {
      if (!this.overlayButton.hidden) this.onStart();
    });
  }

  ready(): void {
    this.loading.hidden = true;
    this.overlayButton.hidden = false;
  }

  showOverlay(paused: boolean): void {
    this.overlay.hidden = false;
    this.overlayButton.textContent = paused ? 'Click to resume' : 'Click to start';
    this.overlayTitle.textContent = paused ? 'Paused' : 'Critical Mass';
  }

  hideOverlay(): void {
    this.overlay.hidden = true;
  }

  private set(e: HTMLElement, text: string): void {
    if (this.lastText.get(e) === text) return;
    this.lastText.set(e, text);
    e.textContent = text;
  }

  update(info: {
    time: string; weather: string; zone: string; fps: number; reactor: string;
    grid: { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' };
    crew: { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' };
    cash: string;
    cashTone: 'ok' | 'bad';
    opinion: number;
  }): void {
    this.set(this.gridEl, info.grid.text);
    if (this.gridEl.dataset.tone !== info.grid.tone) this.gridEl.dataset.tone = info.grid.tone;
    this.set(this.crewEl, info.crew.text);
    if (this.crewEl.dataset.tone !== info.crew.tone) this.crewEl.dataset.tone = info.crew.tone;
    this.set(this.cashEl, info.cash);
    if (this.cashEl.dataset.tone !== info.cashTone) this.cashEl.dataset.tone = info.cashTone;
    this.set(this.opinionEl, `Opinion ${Math.round(info.opinion)}`);
    const ot = info.opinion < 25 ? 'bad' : info.opinion < 45 ? 'warn' : 'ok';
    if (this.opinionEl.dataset.tone !== ot) this.opinionEl.dataset.tone = ot;
    this.set(this.time, info.time);
    this.set(this.weather, info.weather);
    if (this.lastText.get(this.reactor) !== info.reactor) {
      this.reactor.dataset.status = info.reactor.toLowerCase().replace(' ', '-');
    }
    this.set(this.reactor, info.reactor);
    this.set(this.zone, info.zone);
    this.set(this.fps, `${Math.round(info.fps)} FPS`);
  }

  /** "[E] Use …" prompt under the crosshair; null hides it. */
  setPrompt(label: string | null): void {
    this.prompt.hidden = label === null;
    if (label !== null) this.set(this.prompt, label);
  }

  setWorkOrders(list: ReadonlyArray<{ title: string; action: string; where: string; tone: 'warn' | 'bad' }>): void {
    this.workOrders.hidden = list.length === 0;
    const html = `<div class="obj-title">Work orders</div>` + list.map((w) =>
      `<div class="wo ${w.tone}"><div class="wo-title">${w.title}</div><div class="wo-meta">${w.action} · ${w.where}</div></div>`).join('');
    if (this.lastText.get(this.workOrders) === html) return;
    this.lastText.set(this.workOrders, html);
    this.workOrders.innerHTML = html;
  }

  /** Personal dosimeter: rate in µSv/h, today's dose in mSv. */
  setDosimeter(rateUSv: number, doseMSv: number, limitMSv: number): void {
    // Background radiation is always there; only show the dosimeter when it matters.
    const show = rateUSv > 5 || doseMSv > 0.5;
    this.dosimeter.hidden = !show;
    if (!show) return;
    const tone = doseMSv > limitMSv * 0.6 || rateUSv > 2000 ? 'bad' : rateUSv > 100 ? 'warn' : 'ok';
    if (this.dosimeter.dataset.tone !== tone) this.dosimeter.dataset.tone = tone;
    const rate = rateUSv >= 1000 ? `${(rateUSv / 1000).toFixed(1)} mSv/h` : `${rateUSv.toFixed(rateUSv < 10 ? 1 : 0)} µSv/h`;
    this.set(this.dosimeter, `☢ ${rate} · ${doseMSv.toFixed(2)} / ${limitMSv} mSv today`);
  }

  setSpeed(kmh: number | null): void {
    this.speedo.hidden = kmh === null;
    if (kmh !== null) this.set(this.speedo, `${Math.round(Math.abs(kmh))} km/h`);
  }

  setProgress(label: string | null, frac = 0): void {
    this.progress.hidden = label === null;
    if (label === null) return;
    this.set(this.progressLabel, label);
    this.progressFill.style.width = `${Math.round(frac * 100)}%`;
  }

  setFade(text: string | null): void {
    this.fade.hidden = text === null;
    if (text !== null) this.set(this.fade, text);
  }

  /** Hide gameplay chrome (crosshair, prompt) while a full-screen panel is open. */
  setPanelMode(on: boolean): void {
    this.root.classList.toggle('panel-open', on);
  }

  setDriving(on: boolean): void {
    this.root.classList.toggle('driving', on);
  }

  setObjectives(title: string, list: readonly Objective[]): void {
    const html =
      `<div class="obj-title">${title}</div>` +
      list.map((o) => `<div class="obj ${o.done ? 'done' : ''}"><span class="obj-box"></span>${o.text}</div>`).join('');
    if (this.lastText.get(this.objectives) === html) return;
    this.lastText.set(this.objectives, html);
    this.objectives.innerHTML = html;
  }

  toast(text: string, kind: 'info' | 'good' | 'warn' | 'danger' = 'info'): void {
    const t = el('div', `toast ${kind}`, this.toasts);
    t.textContent = text;
    setTimeout(() => t.classList.add('out'), 4200);
    setTimeout(() => t.remove(), 4800);
  }

  setDebug(visible: boolean, text = ''): void {
    this.debug.hidden = !visible;
    if (visible) this.set(this.debug, text);
  }
}
