/** Hosts one control panel at a time as a full-screen overlay. */
import type { PanelId } from '../../world/controlRoom';
import { PANEL_BUILDERS, type PanelContext, type PanelView } from './controlPanels';
import { button, h } from './widgets';
import './panels.css';

const ORDER: PanelId[] = ['reactor', 'primary', 'turbine', 'cooling', 'grid', 'annunciator', 'trends'];

export class PanelManager {
  private readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private readonly title: HTMLElement;
  private readonly tabs: Record<PanelId, HTMLButtonElement>;
  private readonly views = new Map<PanelId, PanelView>();
  current: PanelId | null = null;
  onClose: () => void = () => {};

  constructor(parent: HTMLElement, private readonly ctx: PanelContext, labels: Record<PanelId, string>) {
    this.root = h('div', 'cp-overlay', parent);
    this.root.hidden = true;
    const win = h('div', 'cp-window', this.root);
    const head = h('header', 'cp-head', win);
    h('div', 'cp-kicker', head, 'Unit 1 Control Room');
    this.title = h('h2', 'cp-title', head);
    const tabs = h('nav', 'cp-tabs', head);
    this.tabs = {} as Record<PanelId, HTMLButtonElement>;
    for (const id of ORDER) this.tabs[id] = button(tabs, labels[id].replace(/ (Panel|Wall)$/, ''), () => this.open(id), 'cp-tab');
    button(head, 'Close  [Esc]', () => this.close(), 'cp-close');
    this.body = h('div', 'cp-body', win);
    // Clicks inside the panel must not reach the game canvas.
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  open(id: PanelId): void {
    let view = this.views.get(id);
    if (!view) {
      view = PANEL_BUILDERS[id](this.ctx);
      this.views.set(id, view);
    }
    this.body.replaceChildren(view.el);
    this.title.textContent = view.title;
    for (const t of ORDER) this.tabs[t].classList.toggle('active', t === id);
    this.current = id;
    this.root.hidden = false;
    view.update(0.1);
  }

  close(): void {
    if (!this.current) return;
    this.current = null;
    this.root.hidden = true;
    this.onClose();
  }

  update(dt: number): void {
    if (!this.current) return;
    this.views.get(this.current)?.update(dt);
  }
}
