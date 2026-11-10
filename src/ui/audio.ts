/**
 * All game audio, synthesised with the Web Audio API (no sound files).
 *
 * Continuous layers (gains follow the game state every frame): reactor hum, turbine whine,
 * RCP bearing whine, rain, wind, town murmur. One-shots: alarm tones by severity, Geiger clicks,
 * birdsong, thunder, and the meltdown siren.
 */
export type AlarmLevel = 'none' | 'warning' | 'alarm' | 'trip';

export interface SoundState {
  /** Unacknowledged alarm level, heard only in the control room (or with a panel open). */
  alarm: AlarmLevel;
  /** Reactor power 0..1 and how close you are to the containment / turbine hall (0..1, 1 = inside). */
  power: number;
  nearReactor: number;
  /** Turbine speed 0..1 (of 3600 rpm) and closeness to the turbine hall. */
  turbine: number;
  nearTurbine: number;
  /** Inside a building (muffles weather, adds a little room hum). */
  indoors: boolean;
  rain: number;
  /** Wind strength 0..1 (storms). */
  wind: number;
  whine: number;
  whinePitch: number;
  /** Dose rate at the player, µSv/h (Geiger counter). */
  doseRate: number;
  /** Closeness to Millbrook 0..1 and daylight 0..1. */
  nearTown: number;
  daylight: number;
  /** 0..1: away from the plant and roads, out in the countryside (birds). */
  countryside: number;
}

export class SoundFx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private volume = 0.8;
  private layers: null | {
    hum: GainNode; humOsc: OscillatorNode;
    turbine: GainNode; turbineOsc: OscillatorNode; turbineFilter: BiquadFilterNode;
    whine: GainNode; whineOsc: OscillatorNode;
    rain: GainNode; rainFilter: BiquadFilterNode;
    wind: GainNode; windFilter: BiquadFilterNode;
    town: GainNode;
  } = null;
  private t = 0;
  private alarmTimer = 0;
  private alarmStep = 0;
  private lastAlarm: AlarmLevel = 'none';
  private birdTimer = 3;

  /** Must be called from a user gesture (browsers block audio until then). */
  unlock(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    try {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(ctx.destination);
      this.build(ctx, this.master);
    } catch {
      this.ctx = null;
    }
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  private noiseSource(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    // Start each loop at a different offset so layers don't phase together.
    src.start(0, Math.random() * 1.9);
    return src;
  }

  private build(ctx: AudioContext, out: AudioNode): void {
    // White noise shared by rain, wind, thunder, clicks.
    const len = ctx.sampleRate * 2;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    const gain = (to: AudioNode) => {
      const g = ctx.createGain();
      g.gain.value = 0;
      g.connect(to);
      return g;
    };

    // Reactor hum: mains-frequency drone with a couple of harmonics.
    const hum = gain(out);
    const humOsc = ctx.createOscillator();
    humOsc.frequency.value = 60;
    const humLp = ctx.createBiquadFilter();
    humLp.type = 'lowpass';
    humLp.frequency.value = 400;
    for (const [mult, amp] of [[1, 1], [2, 0.5], [3, 0.2]] as const) {
      const o = ctx.createOscillator();
      o.type = mult === 1 ? 'sine' : 'triangle';
      o.frequency.value = 60 * mult;
      const a = ctx.createGain();
      a.gain.value = amp;
      o.connect(a).connect(humLp);
      o.start();
    }
    humOsc.connect(humLp);
    humOsc.start();
    humLp.connect(hum);

    // Turbine: a rising whine whose pitch follows shaft speed, over a rumble.
    const turbine = gain(out);
    const turbineOsc = ctx.createOscillator();
    turbineOsc.type = 'sawtooth';
    turbineOsc.frequency.value = 300;
    const turbineFilter = ctx.createBiquadFilter();
    turbineFilter.type = 'bandpass';
    turbineFilter.Q.value = 3;
    turbineFilter.frequency.value = 600;
    turbineOsc.connect(turbineFilter).connect(turbine);
    turbineOsc.start();
    const rumbleLp = ctx.createBiquadFilter();
    rumbleLp.type = 'lowpass';
    rumbleLp.frequency.value = 120;
    const rumbleAmp = ctx.createGain();
    rumbleAmp.gain.value = 1.4;
    this.noiseSource(ctx).connect(rumbleLp).connect(rumbleAmp).connect(turbine);

    // RCP bearing whine.
    const whine = gain(out);
    const whineOsc = ctx.createOscillator();
    whineOsc.type = 'sawtooth';
    whineOsc.frequency.value = 1400;
    const whineFilter = ctx.createBiquadFilter();
    whineFilter.type = 'bandpass';
    whineFilter.frequency.value = 1600;
    whineFilter.Q.value = 6;
    whineOsc.connect(whineFilter).connect(whine);
    whineOsc.start();

    // Rain hiss.
    const rain = gain(out);
    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 2500;
    rainFilter.Q.value = 0.4;
    this.noiseSource(ctx).connect(rainFilter).connect(rain);

    // Wind: low, slowly swelling noise.
    const wind = gain(out);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 500;
    windFilter.Q.value = 2;
    this.noiseSource(ctx).connect(windFilter).connect(wind);

    // Town: distant traffic and voices, a soft band of noise.
    const town = gain(out);
    const townBp = ctx.createBiquadFilter();
    townBp.type = 'bandpass';
    townBp.frequency.value = 350;
    townBp.Q.value = 0.8;
    this.noiseSource(ctx).connect(townBp).connect(town);

    this.layers = { hum, humOsc, turbine, turbineOsc, turbineFilter, whine, whineOsc, rain, rainFilter, wind, windFilter, town };
  }

  /** Call every frame. */
  update(dt: number, s: SoundState): void {
    const ctx = this.ctx;
    const L = this.layers;
    if (!ctx || !L || !this.master) return;
    this.t += dt;
    const now = ctx.currentTime;
    const set = (g: AudioParam, v: number, tau = 0.3) => g.setTargetAtTime(v, now, tau);

    // Plant machinery.
    set(L.hum.gain, (0.012 + 0.05 * s.power) * s.nearReactor + (s.indoors ? 0.006 * s.power : 0));
    L.humOsc.frequency.setTargetAtTime(60 + 0.6 * s.power, now, 1);
    set(L.turbine.gain, 0.045 * s.turbine * s.nearTurbine);
    L.turbineOsc.frequency.setTargetAtTime(80 + 320 * s.turbine, now, 0.8);
    L.turbineFilter.frequency.setTargetAtTime(200 + 900 * s.turbine, now, 0.8);
    set(L.whine.gain, s.whine * 0.04, 0.2);
    L.whineOsc.frequency.setTargetAtTime(1200 + 900 * s.whinePitch, now, 0.5);

    // Weather, muffled indoors.
    const muffle = s.indoors ? 0.25 : 1;
    set(L.rain.gain, s.rain * 0.12 * muffle);
    L.rainFilter.frequency.setTargetAtTime(s.indoors ? 700 : 2500, now, 0.3);
    const gust = 0.6 + 0.4 * Math.sin(this.t * 0.7) * Math.sin(this.t * 0.23);
    set(L.wind.gain, s.wind * 0.09 * gust * muffle, 0.6);
    L.windFilter.frequency.setTargetAtTime(300 + 300 * gust, now, 0.6);

    // Ambience.
    set(L.town.gain, s.nearTown * (0.008 + 0.018 * s.daylight) * muffle, 1);
    this.birdTimer -= dt;
    if (this.birdTimer <= 0) {
      this.birdTimer = 1.5 + Math.random() * 5;
      if (s.daylight > 0.5 && s.rain < 0.1 && !s.indoors && s.countryside > 0.2) this.bird(s.countryside);
    }

    this.alarms(dt, s.alarm);
    this.geiger(dt, s.doseRate);
  }

  /** Short tone through its own envelope. */
  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'square', at = 0, glideTo?: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 2600;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.01);
    g.gain.setValueAtTime(vol, t0 + dur * 0.8);
    g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(lp).connect(g).connect(this.master!);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /**
   * Distinct alarm sounds: warnings chime softly, alarms sound a steady horn,
   * trips get a fast two-tone klaxon.
   */
  private alarms(dt: number, level: AlarmLevel): void {
    if (level !== this.lastAlarm) {
      this.lastAlarm = level;
      this.alarmTimer = 0;
      this.alarmStep = 0;
    }
    if (level === 'none') return;
    this.alarmTimer -= dt;
    if (this.alarmTimer > 0) return;
    if (level === 'warning') {
      this.tone(988, 0.18, 0.03, 'sine');
      this.tone(784, 0.3, 0.03, 'sine', 0.2);
      this.alarmTimer = 4;
    } else if (level === 'alarm') {
      this.tone(880, 0.45, 0.04);
      this.alarmTimer = 1;
    } else {
      this.tone(this.alarmStep++ % 2 ? 950 : 700, 0.24, 0.05, 'sawtooth');
      this.alarmTimer = 0.25;
    }
  }

  private geigerAcc = 0;

  /** Random clicks at a rate that rises with the dose rate (only above background). */
  private geiger(dt: number, rate: number): void {
    if (rate < 2) return;
    const perSecond = Math.min(120, rate * 0.4);
    // Jittered accumulation gives the irregular rhythm of a real counter.
    this.geigerAcc += perSecond * dt * (0.3 + Math.random() * 1.4);
    let clicks = 0;
    while (this.geigerAcc >= 1 && clicks < 8) {
      this.geigerAcc -= 1;
      clicks++;
    }
    const ctx = this.ctx!;
    for (let i = 0; i < clicks; i++) {
      const t0 = ctx.currentTime + Math.random() * dt;
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 3000;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.12, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.006);
      src.connect(hp).connect(g).connect(this.master!);
      src.start(t0, Math.random() * 1.5);
      src.stop(t0 + 0.01);
    }
  }

  private bird(level: number): void {
    const base = 2200 + Math.random() * 1600;
    const notes = 2 + Math.floor(Math.random() * 4);
    for (let i = 0; i < notes; i++) {
      const f = base * (0.85 + Math.random() * 0.3);
      this.tone(f, 0.07 + Math.random() * 0.05, 0.012 * level, 'sine', i * 0.13, f * (Math.random() < 0.5 ? 1.3 : 0.8));
    }
  }

  private siren: { osc: OscillatorNode; gain: GainNode; lfo: OscillatorNode } | null = null;

  /** Rising-and-falling evacuation siren (meltdown). */
  setSiren(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
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
      osc.connect(lp).connect(gain).connect(this.master);
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
    if (!ctx || !this.noise || !this.master) return;
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
    src.connect(lp).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + 2.6);
  }
}
