/**
 * Critical Mass — bootstrap and main loop.
 * Fixed-step simulation (SIM_DT) + variable-rate rendering.
 */
import * as THREE from 'three';
import './ui/style.css';
import { GameClock } from './sim/clock';
import { Reactor, averageRodInsertion, createReactorState, reactorStatus } from './sim/reactor';
import { Annunciator } from './sim/annunciator';
import { TrendRecorder } from './sim/history';
import { gridDemandMW } from './sim/grid';
import { activeAlarms } from './sim/alarms';
import { Input } from './player/input';
import { PlayerController } from './player/controller';
import { Interactor } from './player/interaction';
import { World } from './world/world';
import { DayNight } from './world/sky';
import { BRIDGE, LOOKOUT, PLANT_LAYOUT, SPAWN, TOWN_SQUARE, zoneNameAt } from './world/layout';
import type { PanelId } from './world/controlRoom';
import { Hud, type Objective } from './ui/hud';
import { BigMap, Minimap, renderMapImage, type MapMarker } from './ui/map';
import { reactorDebugText } from './ui/reactorDebug';
import { PanelManager } from './ui/panels/panelManager';
import { AlarmHorn } from './ui/audio';
import {
  drawAnnunciator, drawCoolingScreen, drawPrimaryScreen, drawReactorScreen, drawTrendScreen, drawTurbineScreen,
} from './ui/screens';

const SIM_DT = 0.1;
const WARPS = [1, 4, 16];

type Mode = 'paused' | 'play' | 'panel';

interface ObjectiveDef extends Objective {
  x: number;
  z: number;
  check: () => boolean;
}
interface ObjectiveGroup {
  title: string;
  items: ObjectiveDef[];
  doneText: string;
}

const PANEL_LABELS: Record<PanelId, string> = {
  reactor: 'Reactor Control Panel',
  primary: 'Primary Loop Panel',
  turbine: 'Turbine & Grid Panel',
  cooling: 'Cooling Water Panel',
  annunciator: 'Annunciator Wall',
  trends: 'Trend Recorder',
};

class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly hud: Hud;
  private readonly input: Input;
  private readonly clock = new GameClock(8);
  private reactor = new Reactor(createReactorState('cold'));
  private readonly annunciator = new Annunciator();
  private readonly trends = new TrendRecorder();
  private readonly horn = new AlarmHorn();
  private world!: World;
  private dayNight!: DayNight;
  private player!: PlayerController;
  private interactor!: Interactor;
  private panels!: PanelManager;
  private minimap!: Minimap;
  private bigMap!: BigMap;
  private groups: ObjectiveGroup[] = [];
  private groupIndex = 0;

  private mode: Mode = 'paused';
  private started = false;
  /** Set by the debug API: keep running without pointer lock (automated browsers). */
  private noLock = false;
  private debugVisible = false;
  private warp = 0;
  private acc = 0;
  private last = performance.now();
  private fps = 60;
  private fpsTime = 0;
  private fpsFrames = 0;
  private cpuMs = 0;
  private screenTimer = 0;
  private realTime = 0;
  private readonly focus = new THREE.Vector3();

  constructor(app: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.domElement.className = 'game';
    app.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 4500);
    this.camera.rotation.order = 'YXZ';

    this.hud = new Hud(app);
    this.input = new Input(this.renderer.domElement);
    this.hud.onStart = () => {
      this.horn.unlock();
      this.input.requestLock();
    };
    this.input.onLockChange = (locked) => this.onLockChange(locked);

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  async init(): Promise<void> {
    // Let the loading overlay paint before the heavy world build.
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    this.world = new World(this.scene);
    this.dayNight = new DayNight(this.scene);
    this.player = new PlayerController(this.world.hf, this.world.collision);
    this.player.spawn(SPAWN.x, SPAWN.z, SPAWN.yaw);
    this.interactor = new Interactor(this.world.controlRoom.interactables);
    this.panels = new PanelManager(this.hud.root, {
      reactor: () => this.reactor,
      annunciator: this.annunciator,
      trends: this.trends,
      gameSeconds: () => this.clock.seconds,
      demandMW: () => gridDemandMW(this.clock.hour),
    }, PANEL_LABELS);
    this.panels.onClose = () => this.onPanelClosed();

    const mapImage = renderMapImage(this.world.hf, this.world.features);
    this.minimap = new Minimap(this.hud.minimapCanvas, mapImage);
    this.bigMap = new BigMap(this.hud.bigMapRoot, this.hud.bigMapCanvas, mapImage);
    this.setupObjectives();
    console.info(`[world] built in ${Math.round(performance.now() - t0)} ms`, this.world.stats);

    this.hud.ready();
    this.renderer.setAnimationLoop((t) => this.frame(t));
    this.exposeDebugApi();
  }

  // ------------------------------------------------------------------ modes

  private onLockChange(locked: boolean): void {
    if (locked) {
      this.setMode('play');
    } else if (this.mode === 'play') {
      this.setMode('paused');
    }
    // Unlocking while a panel is open is expected.
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.hud.setPanelMode(mode === 'panel');
    if (mode === 'paused') {
      this.hud.showOverlay(this.started);
      return;
    }
    this.hud.hideOverlay();
    if (!this.started) {
      this.started = true;
      this.hud.toast('Welcome to Riverbend. Take a look around the valley.');
    }
  }

  private openPanel(id: PanelId): void {
    this.panels.open(id);
    this.setMode('panel');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private onPanelClosed(): void {
    if (this.noLock) {
      this.setMode('play');
      return;
    }
    this.setMode('play');
    this.input.requestLock();
    // If the browser refuses the lock, fall back to the pause screen.
    setTimeout(() => {
      if (this.mode === 'play' && !this.input.locked) this.setMode('paused');
    }, 400);
  }

  private get insideControlRoom(): boolean {
    const c = PLANT_LAYOUT.controlRoom;
    const p = this.player.pos;
    return Math.abs(p.x - c.cx) < c.w / 2 && Math.abs(p.z - c.cz) < c.d / 2 && p.y < this.world.controlRoom.floorY + 3;
  }

  // ------------------------------------------------------------------ objectives

  private setupObjectives(): void {
    const deckY = this.world.lookoutDeckY;
    const p = () => this.player.pos;
    const s = () => this.reactor.state;
    const cr = PLANT_LAYOUT.controlRoom;
    this.groups = [
      {
        title: 'Get to know the valley',
        doneText: 'You know the valley. Next up: the reactor.',
        items: [
          {
            id: 'bridge', text: 'Cross Riverbend Bridge', done: false, x: (BRIDGE.x0 + BRIDGE.x1) / 2, z: BRIDGE.z,
            check: () => p().x > BRIDGE.x0 + 20 && p().x < BRIDGE.x1 - 20 && Math.abs(p().z - BRIDGE.z) < BRIDGE.halfWidth,
          },
          {
            id: 'town', text: 'Visit the Millbrook town square', done: false, x: TOWN_SQUARE.x, z: TOWN_SQUARE.z,
            check: () => Math.hypot(p().x - TOWN_SQUARE.x, p().z - TOWN_SQUARE.z) < 25,
          },
          {
            id: 'lookout', text: 'Climb the Lookout Hill tower', done: false, x: LOOKOUT.x, z: LOOKOUT.z,
            check: () => Math.hypot(p().x - LOOKOUT.x, p().z - LOOKOUT.z) < 5 && p().y > deckY - 0.4,
          },
        ],
      },
      {
        title: 'Cold start: Unit 1',
        doneText: 'Unit 1 is on the grid. Millbrook has power.',
        items: [
          { id: 'enter', text: 'Enter the control room', done: false, x: cr.cx, z: cr.cz, check: () => this.insideControlRoom },
          {
            id: 'pumps', text: 'Start all four reactor coolant pumps', done: false, x: cr.cx, z: cr.cz,
            check: () => s().coolantPumps.every((pp) => pp.speed > 0.9),
          },
          {
            id: 'critical', text: 'Withdraw rods slowly until the reactor is critical', done: false, x: cr.cx, z: cr.cz,
            check: () => s().neutronFlux > 1e-5 && s().startupRate > 0.2 && !s().scram.active,
          },
          {
            id: 'heat', text: 'Heat the plant to 280 °C (keep withdrawing rods)', done: false, x: cr.cx, z: cr.cz,
            check: () => s().coolantTemp >= 280,
          },
          {
            id: 'speed', text: 'Bring the turbine up to 3600 rpm', done: false, x: cr.cx, z: cr.cz,
            check: () => Math.abs(s().turbineRPM - 3600) < 18,
          },
          { id: 'sync', text: 'Synchronise the generator to the grid', done: false, x: cr.cx, z: cr.cz, check: () => s().generatorSynced },
          {
            id: 'load', text: 'Deliver 200 MWe to the grid', done: false, x: cr.cx, z: cr.cz,
            check: () => s().generatorSynced && s().electricalOutputMW >= 200,
          },
        ],
      },
    ];
  }

  private checkObjectives(): void {
    // Walking into the control room skips ahead to the cold start, valley tour or not.
    if (this.groupIndex === 0 && this.insideControlRoom) this.groupIndex = 1;
    const g = this.groups[this.groupIndex];
    let changed = false;
    // Steps complete in order, so later steps can't tick off early.
    const next = g.items.find((o) => !o.done);
    if (next && next.check()) {
      next.done = true;
      changed = true;
      this.hud.toast(`Objective complete: ${next.text}`, 'good');
    }
    if (changed && g.items.every((o) => o.done)) {
      this.hud.toast(g.doneText, 'good');
      if (this.groupIndex < this.groups.length - 1) this.groupIndex++;
    }
    this.hud.setObjectives(g.title, g.items);
  }

  // ------------------------------------------------------------------ frame

  private frame(now: number): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.realTime += dt;
    const inp = this.input;
    const running = this.mode !== 'paused';
    let ePressed = inp.wasPressed('KeyE');

    if (running) {
      // Fixed-step simulation.
      const warp = WARPS[this.warp];
      this.acc += dt * warp;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 400) {
        this.clock.step(SIM_DT);
        this.reactor.step(SIM_DT, SIM_DT * this.clock.scale);
        this.annunciator.update(this.reactor.state.alarms);
        this.trends.record(this.clock.seconds, this.reactor.state, gridDemandMW(this.clock.hour));
        this.acc -= SIM_DT;
        steps++;
      }
      for (const e of this.reactor.drainEvents()) this.hud.toast(e.text, e.kind);

      if (inp.wasPressed('Backquote')) this.debugVisible = !this.debugVisible;
      if (this.debugVisible) this.debugKeys();
    }

    if (this.mode === 'play') {
      if (inp.wasPressed('KeyM')) this.bigMap.toggle();
      const [mdx, mdy] = inp.consumeMouse();
      this.player.update(dt, {
        forward: (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0),
        strafe: (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0),
        jump: inp.isDown('Space'),
        sprint: inp.isDown('ShiftLeft') || inp.isDown('ShiftRight'),
        crouch: inp.isDown('KeyC') || inp.isDown('ControlLeft'),
        lookDX: mdx,
        lookDY: mdy,
      });
    } else if (this.mode === 'panel') {
      inp.consumeMouse();
      if (inp.wasPressed('Escape') || inp.wasPressed('KeyE')) {
        this.panels.close();
        ePressed = false; // don't reopen with the same key press
      }
    }
    if (running) this.checkObjectives();

    const p = this.player.pos;
    this.camera.position.set(p.x, this.player.eyeY, p.z);
    this.camera.rotation.set(this.player.pitch, this.player.yaw, 0);
    this.camera.updateMatrixWorld();

    // Interaction.
    const target = this.mode === 'play' ? this.interactor.update(this.camera, this.insideControlRoom) : null;
    this.hud.setPrompt(target ? `[E]  ${target.label}` : null);
    if (target && ePressed) this.openPanel(target.panelId);
    inp.endFrame();

    this.focus.set(p.x, p.y, p.z);
    this.dayNight.update(this.clock.hour, this.focus);
    const rs = this.reactor.state;
    const towerLoad = Math.min(1, rs.condenserLoadMW / 2000);
    this.world.update(dt, this.dayNight.daylight, this.dayNight.night, towerLoad);
    this.updateScreens(dt);
    this.panels.update(dt);
    const severe = activeAlarms(rs).some((a) => a.severity === 'trip');
    this.horn.update(dt, running && this.annunciator.hornOn, severe);

    this.renderer.render(this.scene, this.camera);

    // HUD.
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    const zone = this.insideControlRoom ? 'Unit 1 Control Room' : zoneNameAt(p.x, p.z);
    const warp = WARPS[this.warp];
    this.hud.update({
      time: this.clock.format() + (warp > 1 ? `  ×${warp}` : ''),
      weather: 'Clear', zone, fps: this.fps, reactor: reactorStatus(rs),
    });
    this.minimap.draw(p.x, p.z, this.player.yaw);
    const g = this.groups[this.groupIndex];
    const markers: MapMarker[] = g.items.map((o) => ({ x: o.x, z: o.z, label: o.text, done: o.done }));
    this.bigMap.draw(p.x, p.z, this.player.yaw, markers);
    this.cpuMs = this.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
    if (this.debugVisible) {
      const info = this.renderer.info.render;
      const s = this.world.stats;
      this.hud.setDebug(true, [
        `fps        ${this.fps.toFixed(0)}   cpu ${this.cpuMs.toFixed(1)} ms   sim ×${warp}`,
        `pos        ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}`,
        `ground     ${this.player.onGround ? 'yes' : 'no'}${this.player.swimming ? '  (swimming)' : ''}${this.player.noclip ? '  NOCLIP' : ''}`,
        `zone       ${zone}`,
        `draws      ${info.calls}   tris ${(info.triangles / 1000).toFixed(0)}k`,
        `world      ${s.buildings} town bldgs, ${s.trees} trees, ${s.colliders} colliders`,
        'N noclip   T +1 hour   = sim speed ×1/×4/×16',
        '',
        reactorDebugText(rs),
      ].join('\n'));
    } else {
      this.hud.setDebug(false);
    }
  }

  /** Redraw the in-world control-room screens a few times a second, when anyone could see them. */
  private updateScreens(dt: number): void {
    this.screenTimer -= dt;
    const c = PLANT_LAYOUT.controlRoom;
    const near = Math.hypot(this.player.pos.x - c.cx, this.player.pos.z - c.cz) < 60;
    if (this.screenTimer > 0 || !near) return;
    this.screenTimer = 0.25;
    const sc = this.world.controlRoom.screens;
    const s = this.reactor.state;
    drawReactorScreen(sc.reactor.ctx, s);
    drawPrimaryScreen(sc.primary.ctx, s);
    drawTurbineScreen(sc.turbine.ctx, s, gridDemandMW(this.clock.hour));
    drawCoolingScreen(sc.cooling.ctx, s);
    drawTrendScreen(sc.trends.ctx, this.trends.window(this.clock.seconds, 3600), this.clock.seconds);
    const t = this.realTime;
    drawAnnunciator(sc.annunciator.ctx, this.annunciator.state, Math.floor(t * 3) % 2 === 0, Math.floor(t) % 2 === 0);
    for (const k of Object.keys(sc) as PanelId[]) sc[k].texture.needsUpdate = true;
  }

  /** Debug-panel keys (backtick panel must be open). Reactor keys remain as shortcuts. */
  private debugKeys(): void {
    const inp = this.input;
    const r = this.reactor;
    const s = r.state;
    if (inp.wasPressed('KeyN')) {
      this.player.noclip = !this.player.noclip;
      this.hud.toast(`Noclip ${this.player.noclip ? 'on' : 'off'}`);
    }
    if (inp.wasPressed('KeyT')) this.clock.setHour(this.clock.hour + 1);
    if (inp.wasPressed('Equal')) {
      this.warp = (this.warp + 1) % WARPS.length;
      this.hud.toast(`Debug: simulation speed ×${WARPS[this.warp]}`, 'warn');
    }
    const big = inp.isDown('ShiftLeft') || inp.isDown('ShiftRight');
    if (inp.wasPressed('BracketLeft')) r.nudgeRods(big ? 5 : 1);
    if (inp.wasPressed('BracketRight')) r.nudgeRods(big ? -5 : -1);
    if (inp.wasPressed('KeyP')) r.setAllCoolantPumps(!s.coolantPumps.some((pp) => pp.on));
    if (inp.wasPressed('Comma') || inp.wasPressed('Period')) {
      const dir = inp.wasPressed('Period') ? 1 : -1;
      if (s.generatorSynced) r.setGovernorValve(s.governorValve + dir * (big ? 0.1 : 0.02));
      else r.setTurbineSpeedTarget(s.turbineSpeedTarget + dir * 300);
    }
    if (inp.wasPressed('KeyY')) r.syncGenerator();
    if (inp.wasPressed('KeyX')) r.scram('manual');
    if (inp.wasPressed('KeyR')) {
      if (s.scram.active) r.resetScram();
      else if (s.turbineTripped) r.resetTurbine();
    }
    if (inp.wasPressed('KeyB')) r.setSafetyBypass(!s.safetyBypass);
    if (inp.wasPressed('KeyL')) this.loadPlant('fullPower');
    if (inp.wasPressed('KeyK')) this.loadPlant('cold');
  }

  private loadPlant(preset: 'cold' | 'fullPower'): void {
    this.reactor = new Reactor(createReactorState(preset));
    this.trends.clear();
    this.hud.toast(preset === 'cold' ? 'Debug: plant reset to cold shutdown' : 'Debug: plant loaded at full power', 'warn');
  }

  /** Small console API for testing and debugging: window.__game. */
  private exposeDebugApi(): void {
    const g = this;
    (window as unknown as { __game: unknown }).__game = {
      start: () => {
        g.noLock = true;
        g.setMode('play');
      },
      pause: () => g.setMode('paused'),
      /** probeY: land on the highest surface below this height (e.g. 1e6 for rooftops / the lookout deck). */
      teleport: (x: number, z: number, yaw?: number, probeY?: number) => g.player.spawn(x, z, yaw ?? g.player.yaw, probeY),
      look: (yaw: number, pitch = 0) => {
        g.player.yaw = yaw;
        g.player.pitch = pitch;
      },
      goTo: (panel: PanelId) => {
        const st = g.world.controlRoom.stations[panel];
        g.player.spawn(st.x, st.z, st.yaw);
        g.player.pitch = panel === 'annunciator' ? 0.7 : -0.12;
      },
      openPanel: (id: PanelId) => g.openPanel(id),
      closePanel: () => g.panels.close(),
      setWarp: (n: number) => {
        g.warp = Math.max(0, WARPS.indexOf(n));
      },
      setHour: (h: number) => g.clock.setHour(h),
      toggleMap: () => g.bigMap.toggle(),
      reactor: () => g.reactor,
      loadPlant: (preset: 'cold' | 'fullPower') => g.loadPlant(preset),
      plant: () => {
        const s = g.reactor.state;
        return {
          status: reactorStatus(s), flux: s.neutronFlux, sur: +s.startupRate.toFixed(2), thermalMW: Math.round(s.thermalPowerMW),
          MWe: Math.round(s.electricalOutputMW), rods: +averageRodInsertion(s).toFixed(1),
          coolant: +s.coolantTemp.toFixed(1), steam: +s.secondaryTemp.toFixed(1), pressure: +s.primaryPressure.toFixed(2),
          rpm: Math.round(s.turbineRPM), synced: s.generatorSynced, scram: s.scram.cause, alarms: s.alarms,
        };
      },
      state: () => ({
        mode: g.mode,
        panel: g.panels.current,
        prompt: g.interactor.current?.label ?? null,
        pos: { ...g.player.pos },
        onGround: g.player.onGround,
        swimming: g.player.swimming,
        zone: zoneNameAt(g.player.pos.x, g.player.pos.z),
        fps: Math.round(g.fps),
        time: g.clock.format(),
        objectives: g.groups[g.groupIndex].items.map((o) => `${o.done ? '[x]' : '[ ]'} ${o.text}`),
        draws: g.renderer.info.render.calls,
      }),
    };
  }
}

const app = document.getElementById('app')!;
new Game(app).init().catch((err) => {
  console.error(err);
  app.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:20px;color:#f88">${String(err)}</pre>`);
});
