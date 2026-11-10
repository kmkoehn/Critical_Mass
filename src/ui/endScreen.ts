/** Win and game-over screens with a final report. */
import { ACHIEVEMENTS } from '../sim/campaign';
import { button, h } from './panels/widgets';

export interface ReportStats {
  days: number;
  deliveredGWh: number;
  cash: string;
  opinion: number;
  inspections: string;
  trips: number;
  repairs: string;
  achievements: string[];
}

export class EndScreen {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  isOpen = false;

  constructor(parent: HTMLElement) {
    this.root = h('div', 'end-overlay', parent);
    this.root.hidden = true;
    this.card = h('div', 'end-card', this.root);
    this.root.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  show(kind: 'win' | 'lose', title: string, body: string, stats: ReportStats, onContinue?: () => void): void {
    this.isOpen = true;
    this.root.hidden = false;
    this.root.dataset.kind = kind;
    const c = this.card;
    c.replaceChildren();
    h('div', 'end-kicker', c, kind === 'win' ? 'Riverbend Generating Station · Final report' : 'Riverbend Generating Station · Incident report');
    h('h1', 'end-title', c, title);
    h('p', 'end-body', c, body);
    const grid = h('div', 'end-stats', c);
    const stat = (label: string, value: string) => {
      const s = h('div', 'end-stat', grid);
      h('div', 'end-stat-v', s, value);
      h('div', 'end-stat-l', s, label);
    };
    stat('Days in charge', String(stats.days));
    stat('Energy delivered', `${stats.deliveredGWh.toFixed(1)} GWh`);
    stat('Cash', stats.cash);
    stat('Public opinion', `${Math.round(stats.opinion)} / 100`);
    stat('Inspections (passed / failed)', stats.inspections);
    stat('Reactor trips', String(stats.trips));
    stat('Faults fixed (you / crews)', stats.repairs);
    h('h3', 'end-sub', c, `Achievements · ${stats.achievements.length} of ${ACHIEVEMENTS.length}`);
    const ach = h('div', 'end-ach', c);
    for (const a of ACHIEVEMENTS) {
      const got = stats.achievements.includes(a.id);
      const row = h('div', `end-ach-row ${got ? 'got' : ''}`, ach);
      h('b', '', row, `${got ? '★' : '☆'} ${a.name}`);
      h('span', '', row, a.text);
    }
    const row = h('div', 'cp-btnrow end-buttons', c);
    if (onContinue) {
      button(row, 'Keep playing (sandbox)', () => {
        this.hide();
        onContinue();
      }, 'hire');
    }
    button(row, 'Start a new game', () => location.reload(), kind === 'win' ? '' : 'danger');
  }

  hide(): void {
    this.isOpen = false;
    this.root.hidden = true;
  }
}
