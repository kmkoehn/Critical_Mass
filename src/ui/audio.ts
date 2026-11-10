/**
 * Minimal Web Audio: alarm horn, rain, thunder and a bearing whine.
 * (The full audio pass is Milestone 8.)
 */
export class SoundFx {
  private ctx: AudioContext | null = null;
  private horn: GainNode | null = null;
  private rainGain: GainNode | null = null;
  private whineGain: GainNode | null = null;
  private whineOsc: OscillatorNode | null = null;
  private noise: AudioBuffer | null = null;
  private hornOn = false;
  private t = 0;

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      // Horn: filtered square wave, gated by update().
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 880;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      this.horn = ctx.createGain();
      this.horn.gain.value = 0;
      osc.connect(lp).connect(this.horn).connect(ctx.destination);
      osc.start();
      // White-noise buffer shared by rain and thunder.
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      const rain = ctx.createBufferSource();
      rain.buffer = this.noise;
      rain.loop = true;
      const rainFilter = ctx.createBiquadFilter();
      rainFilter.type = 'bandpass';
      rainFilter.frequency.value = 2500;
      rainFilter.Q.value = 0.4;
      this.rainGain = ctx.createGain();
      this.rainGain.gain.value = 0;
      rain.connect(rainFilter).connect(this.rainGain).connect(ctx.destination);
      rain.start();
      // Bearing whine: a thin sine that rises in pitch with temperature.
      this.whineOsc = ctx.createOscillator();
      this.whineOsc.type = 'sawtooth';
      this.whineOsc.frequency.value = 1400;
      const whineFilter = ctx.createBiquadFilter();
      whineFilter.type = 'bandpass';
      whineFilter.frequency.value = 1600;
      whineFilter.Q.value = 6;
      this.whineGain = ctx.createGain();
      this.whineGain.gain.value = 0;
      this.whineOsc.connect(whineFilter).connect(this.whineGain).connect(ctx.destination);
      this.whineOsc.start();
    } catch {
      this.ctx = null;
    }
  }

  /** Call every frame. */
  update(dt: number, o: { horn: boolean; severe: boolean; rain: number; whine: number; whinePitch: number }): void {
    const ctx = this.ctx;
    if (!ctx || !this.horn || !this.rainGain || !this.whineGain || !this.whineOsc) return;
    this.t += dt;
    const now = ctx.currentTime;
    const period = o.severe ? 0.5 : 1.0;
    const beep = o.horn && this.t % period < period * 0.45;
    if (beep !== this.hornOn) {
      this.hornOn = beep;
      this.horn.gain.setTargetAtTime(beep ? 0.05 : 0, now, 0.01);
    }
    this.rainGain.gain.setTargetAtTime(o.rain * 0.12, now, 0.3);
    this.whineGain.gain.setTargetAtTime(o.whine * 0.04, now, 0.2);
    this.whineOsc.frequency.setTargetAtTime(1200 + 900 * o.whinePitch, now, 0.5);
  }

  private siren: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode } | null = null;

  /** Rising-and-falling evacuation siren (meltdown). */
  setSiren(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (on && !this.siren) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = 600;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.25;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 260;
      lfo.connect(lfoGain).connect(osc.frequency);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1500;
      const gain = ctx.createGain();
      gain.gain.value = 0.06;
      osc.connect(lp).connect(gain).connect(ctx.destination);
      osc.start();
      lfo.start();
      this.siren = { osc, gain, lfo };
    } else if (!on && this.siren) {
      this.siren.osc.stop();
      this.siren.lfo.stop();
      this.siren = null;
    }
  }

  /** A thunderclap after `delay` seconds (sound travels ~340 m/s). */
  thunder(delay: number, volume: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180 + 400 * volume;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + delay;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.5 * volume, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + 2.5);
    src.connect(lp).connect(g).connect(ctx.destination);
    src.start(t0);
    src.stop(t0 + 2.6);
  }
}
