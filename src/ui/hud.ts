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
    this.zone = el('div', 'tb-zone', top);
    this.fps = el('div', 'tb-right', top);

    el('div', 'crosshair', this.root);
    this.prompt = el('div', 'interact-prompt', this.root);
    this.prompt.hidden = true;

    const mm = el('div', 'minimap', this.root);
    this.minimapCanvas = el('canvas', '', mm);
    el('div', 'minimap-hint', mm).textContent = 'M  Map';

    this.objectives = el('div', 'objectives', this.root);
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

  update(info: { time: string; weather: string; zone: string; fps: number; reactor: string }): void {
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

  /** Hide gameplay chrome (crosshair, prompt) while a full-screen panel is open. */
  setPanelMode(on: boolean): void {
    this.root.classList.toggle('panel-open', on);
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
