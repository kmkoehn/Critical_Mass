/**
 * Title screen and pause menu: new game, continue, save, load, settings, quit to title.
 * Replaces the old click-to-start overlay.
 */
import type { SaveStore, SlotId } from '../save/save';
import { DAY_LENGTHS, type Quality, type Settings } from './settings';

export interface MenuHandlers {
  newGame(): void;
  resume(): void;
  load(slot: SlotId): string | null;
  save(): string | null;
  quitToTitle(): void;
  settingsChanged(s: Settings): void;
  /** One line about what's drawing the game and how fast, for the settings screen. */
  perfInfo(): string;
}

type Screen = 'title' | 'pause' | 'load' | 'settings';

const SLOT_NAME: Record<SlotId, string> = { manual: 'Saved game', auto: 'Autosave' };

const BINDINGS: Array<[string, string]> = [
  ['W A S D', 'Move'], ['Mouse', 'Look'], ['Shift', 'Sprint'], ['Space', 'Jump'],
  ['C', 'Crouch'], ['E', 'Use / drive'], ['Tab', "Director's tablet"], ['M', 'Map'],
  ['Esc', 'Pause'], ['F5', 'Quick save'],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, parent?: HTMLElement, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString();
}

export class Menu {
  private readonly overlay: HTMLElement;
  private readonly card: HTMLElement;
  private screen: Screen = 'title';
  /** Where "Back" returns from Load / Settings. */
  private base: 'title' | 'pause' = 'title';
  private loading = true;
  private note = '';
  /** A warning shown on the title and pause screens (e.g. software rendering). */
  private notice: string | null = null;

  constructor(
    parent: HTMLElement,
    private readonly h: MenuHandlers,
    private readonly saves: SaveStore,
    private settings: Settings,
  ) {
    this.overlay = el('div', 'overlay', parent);
    this.card = el('div', 'overlay-card', this.overlay);
    // Keep clicks inside the menu from reaching the game canvas.
    this.overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (this.overlay.hidden || e.code !== 'Escape') return;
      if (this.screen === 'load' || this.screen === 'settings') this.go(this.base);
    });
    this.render();
  }

  get visible(): boolean {
    return !this.overlay.hidden;
  }

  /** The world has finished building: enable the buttons. */
  ready(): void {
    this.loading = false;
    this.render();
  }

  show(kind: 'title' | 'pause'): void {
    this.overlay.hidden = false;
    this.base = kind;
    this.note = '';
    this.go(kind);
  }

  hide(): void {
    this.overlay.hidden = true;
  }

  setNotice(text: string | null): void {
    this.notice = text;
    this.render();
  }

  private go(s: Screen): void {
    this.screen = s;
    this.render();
  }

  private button(parent: HTMLElement, text: string, onClick: () => void, opts: { primary?: boolean; disabled?: boolean; sub?: string } = {}): HTMLButtonElement {
    const b = el('button', `ov-btn${opts.primary ? ' primary' : ''}`, parent);
    el('span', 'ov-btn-label', b, text);
    if (opts.sub) el('span', 'ov-btn-sub', b, opts.sub);
    b.disabled = !!opts.disabled || this.loading;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  private header(kicker: string, title: string, sub?: string): void {
    el('div', 'ov-kicker', this.card, kicker);
    el('h1', 'ov-title', this.card, title);
    if (sub) el('p', 'ov-sub', this.card, sub);
  }

  private keys(): void {
    const keys = el('div', 'ov-keys', this.card);
    for (const [k, v] of BINDINGS) {
      el('kbd', '', keys, k);
      el('span', '', keys, v);
    }
  }

  private render(): void {
    this.card.replaceChildren();
    this.card.dataset.screen = this.screen;
    if (this.notice && (this.screen === 'title' || this.screen === 'pause' || this.screen === 'settings')) {
      el('div', 'ov-warning', this.card, this.notice);
    }
    if (this.screen === 'title') this.renderTitle();
    else if (this.screen === 'pause') this.renderPause();
    else if (this.screen === 'load') this.renderLoad();
    else this.renderSettings();
    if (this.note) {
      const n = el('div', 'ov-note');
      n.textContent = this.note;
      const keys = this.card.querySelector('.ov-keys');
      if (keys) this.card.insertBefore(n, keys);
      else this.card.appendChild(n);
    }
  }

  private renderTitle(): void {
    this.header('Riverbend Generating Station', 'Critical Mass',
      'You are the new plant director. Bring Unit 1 back to life, keep the valley lit, and grow Riverbend into something the town can be proud of.');
    const col = el('div', 'ov-buttons', this.card);
    if (this.loading) {
      el('div', 'ov-loading', col, 'Building the valley…');
      return;
    }
    const latest = this.saves.latest();
    if (latest) {
      const d = this.saves.list().find((s) => s.slot === latest);
      this.button(col, 'Continue', () => this.load(latest), { primary: true, sub: d && 'label' in d ? `${d.label} · ${ago(d.savedAt)}` : undefined });
    }
    this.button(col, 'New game', () => this.h.newGame(), { primary: !latest });
    this.button(col, 'Load game', () => this.go('load'), { disabled: this.saves.list().length === 0 });
    this.button(col, 'Settings', () => this.go('settings'));
    this.keys();
  }

  private renderPause(): void {
    this.header('Riverbend Generating Station', 'Paused');
    const col = el('div', 'ov-buttons', this.card);
    this.button(col, 'Resume', () => this.h.resume(), { primary: true });
    this.button(col, 'Save game', () => {
      const err = this.h.save();
      this.note = err ?? 'Game saved.';
      this.render();
    });
    this.button(col, 'Load game', () => this.go('load'), { disabled: this.saves.list().length === 0 });
    this.button(col, 'Settings', () => this.go('settings'));
    this.button(col, 'Quit to title', () => this.h.quitToTitle(), { sub: 'Your progress is autosaved first' });
    this.keys();
  }

  private load(slot: SlotId): void {
    const err = this.h.load(slot);
    if (err) {
      this.note = err;
      this.render();
    }
  }

  private renderLoad(): void {
    this.header('Riverbend Generating Station', 'Load game');
    const col = el('div', 'ov-buttons', this.card);
    const list = this.saves.list();
    if (!list.length) el('p', 'ov-sub', col, 'No saved games yet.');
    for (const s of list) {
      if ('error' in s) this.button(col, SLOT_NAME[s.slot], () => {}, { disabled: true, sub: s.error });
      else this.button(col, SLOT_NAME[s.slot], () => this.load(s.slot), { sub: `${s.label} · ${ago(s.savedAt)}` });
    }
    this.button(col, 'Back', () => this.go(this.base));
  }

  private renderSettings(): void {
    this.header('Riverbend Generating Station', 'Settings');
    const form = el('div', 'ov-settings', this.card);
    const s = this.settings;
    const changed = () => {
      this.h.settingsChanged({ ...this.settings });
    };
    const row = (label: string, hint?: string) => {
      const r = el('label', 'ov-set', form);
      const l = el('span', 'ov-set-label', r, label);
      if (hint) el('span', 'ov-set-hint', l, hint);
      return r;
    };

    // Mouse sensitivity.
    const sens = row('Mouse sensitivity');
    const sensIn = el('input', '', sens);
    Object.assign(sensIn, { type: 'range', min: '0.3', max: '2.5', step: '0.1', value: String(s.sensitivity) });
    const sensVal = el('span', 'ov-set-val', sens, `${s.sensitivity.toFixed(1)}×`);
    sensIn.addEventListener('input', () => {
      s.sensitivity = Number(sensIn.value);
      sensVal.textContent = `${s.sensitivity.toFixed(1)}×`;
      changed();
    });

    const inv = row('Invert mouse Y');
    const invIn = el('input', '', inv);
    invIn.type = 'checkbox';
    invIn.checked = s.invertY;
    invIn.addEventListener('change', () => {
      s.invertY = invIn.checked;
      changed();
    });

    // Day length (time scale).
    const day = row('Length of a game day', 'Longer days give you more time for each shift');
    const daySel = el('select', '', day);
    for (const m of DAY_LENGTHS) {
      const o = el('option', '', daySel, `${m} real minutes`);
      o.value = String(m);
      o.selected = m === s.dayMinutes;
    }
    daySel.addEventListener('change', () => {
      s.dayMinutes = Number(daySel.value);
      changed();
    });

    // Graphics quality.
    const q = row('Graphics quality', 'Low turns off shadows and shortens the view distance');
    const qSel = el('select', '', q);
    for (const [v, t] of [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']] as Array<[Quality, string]>) {
      const o = el('option', '', qSel, t);
      o.value = v;
      o.selected = v === s.quality;
    }
    qSel.addEventListener('change', () => {
      s.quality = qSel.value as Quality;
      changed();
    });

    // Volume.
    const vol = row('Volume');
    const volIn = el('input', '', vol);
    Object.assign(volIn, { type: 'range', min: '0', max: '1', step: '0.05', value: String(s.volume) });
    const volVal = el('span', 'ov-set-val', vol, `${Math.round(s.volume * 100)}%`);
    volIn.addEventListener('input', () => {
      s.volume = Number(volIn.value);
      volVal.textContent = `${Math.round(s.volume * 100)}%`;
      changed();
    });

    const auto = row('Autosave', 'Every 3 game hours and when you quit to the title');
    const autoIn = el('input', '', auto);
    autoIn.type = 'checkbox';
    autoIn.checked = s.autosave;
    autoIn.addEventListener('change', () => {
      s.autosave = autoIn.checked;
      changed();
    });

    const adapt = row('Adaptive resolution', 'Renders fewer pixels when the frame rate drops');
    const adaptIn = el('input', '', adapt);
    adaptIn.type = 'checkbox';
    adaptIn.checked = s.adaptiveResolution;
    adaptIn.addEventListener('change', () => {
      s.adaptiveResolution = adaptIn.checked;
      changed();
    });

    const perf = el('div', 'ov-perf', this.card, this.h.perfInfo());
    const timer = setInterval(() => {
      if (!perf.isConnected) clearInterval(timer);
      else perf.textContent = this.h.perfInfo();
    }, 1000);

    const col = el('div', 'ov-buttons', this.card);
    this.button(col, 'Back', () => this.go(this.base), { primary: true });
  }
}
