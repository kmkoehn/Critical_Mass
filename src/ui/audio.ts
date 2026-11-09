/** Minimal Web Audio alarm horn (the full audio pass is Milestone 8). */
export class AlarmHorn {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private on = false;
  private t = 0;

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 880;
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 2200;
      osc.connect(filter).connect(this.gain).connect(this.ctx.destination);
      osc.start();
    } catch {
      this.ctx = null;
    }
  }

  /** Call every frame. `severe` picks the faster, higher pattern used for trips. */
  update(dt: number, sounding: boolean, severe: boolean): void {
    if (!this.ctx || !this.gain) return;
    this.t += dt;
    const period = severe ? 0.5 : 1.0;
    const beep = sounding && this.t % period < period * 0.45;
    if (beep !== this.on) {
      this.on = beep;
      const now = this.ctx.currentTime;
      this.gain.gain.setTargetAtTime(beep ? 0.05 : 0, now, 0.01);
    }
  }
}
