/**
 * Annunciator logic (alarm tile sequence). Pure and serialisable.
 *
 *   off ──alarm──▶ alerting (fast flash, horn)
 *   alerting ──acknowledge──▶ acked (steady) — or off if the condition already cleared
 *   acked ──condition clears──▶ clearing (slow flash)
 *   clearing ──reset──▶ off;  clearing ──alarm returns──▶ alerting
 */
import { ALARMS } from './alarms';

export type TileState = 'off' | 'alerting' | 'acked' | 'clearing';

export interface AnnunciatorState {
  tiles: Record<string, TileState>;
  silenced: boolean;
}

export function createAnnunciatorState(): AnnunciatorState {
  const tiles: Record<string, TileState> = {};
  for (const a of ALARMS) tiles[a.id] = 'off';
  return { tiles, silenced: false };
}

export class Annunciator {
  constructor(readonly state: AnnunciatorState = createAnnunciatorState()) {}

  /** Feed the currently active alarm ids. Returns ids that just started alerting. */
  update(activeIds: readonly string[]): string[] {
    const active = new Set(activeIds);
    const fresh: string[] = [];
    for (const id of Object.keys(this.state.tiles)) {
      const t = this.state.tiles[id];
      const on = active.has(id);
      if (on && (t === 'off' || t === 'clearing')) {
        this.state.tiles[id] = 'alerting';
        fresh.push(id);
      } else if (!on && t === 'acked') {
        this.state.tiles[id] = 'clearing';
      }
    }
    if (fresh.length) this.state.silenced = false;
    return fresh;
  }

  acknowledge(activeIds: readonly string[]): void {
    const active = new Set(activeIds);
    for (const [id, t] of Object.entries(this.state.tiles)) {
      if (t === 'alerting') this.state.tiles[id] = active.has(id) ? 'acked' : 'off';
    }
  }

  silence(): void {
    this.state.silenced = true;
  }

  reset(): void {
    for (const [id, t] of Object.entries(this.state.tiles)) if (t === 'clearing') this.state.tiles[id] = 'off';
  }

  get unacknowledged(): number {
    return Object.values(this.state.tiles).filter((t) => t === 'alerting').length;
  }

  /** The horn sounds while any tile is unacknowledged and it hasn't been silenced. */
  get hornOn(): boolean {
    return !this.state.silenced && this.unacknowledged > 0;
  }
}
