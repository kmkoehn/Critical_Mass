/**
 * Critical Mass — bootstrap and main loop.
 * Fixed-step simulation (SIM_DT) + variable-rate rendering.
 */
import * as THREE from 'three';
import './ui/style.css';
import { GameClock } from './sim/clock';
import { Reactor, averageRodInsertion, createReactorState, reactorStatus } from './sim/reactor';
import { reactorDebugText } from './ui/reactorDebug';
import { Input } from './player/input';
import { PlayerController } from './player/controller';
import { World } from './world/world';
import { DayNight } from './world/sky';
import { BRIDGE, LOOKOUT, SPAWN, TOWN_SQUARE, zoneNameAt } from './world/layout';
import { Hud, type Objective } from './ui/hud';
import { BigMap, Minimap, renderMapImage, type MapMarker } from './ui/map';

const SIM_DT = 0.1;

interface ObjectiveDef extends Objective {
  x: number;
  z: number;
  check: (p: { x: number; y: number; z: number }) => boolean;
}

class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly hud: Hud;
  private readonly input: Input;
  private readonly clock = new GameClock(8);
  private reactor = new Reactor(createReactorState('cold'));
  private world!: World;
  private dayNight!: DayNight;
  private player!: PlayerController;
  private minimap!: Minimap;
  private bigMap!: BigMap;
  private objectives: ObjectiveDef[] = [];

  private active = false;
  private started = false;
  private debugVisible = false;
  private acc = 0;
  private last = performance.now();
  private fps = 60;
  private fpsTime = 0;
  private fpsFrames = 0;
  private cpuMs = 0;
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
    this.hud.onStart = () => this.input.requestLock();
    this.input.onLockChange = (locked) => this.setActive(locked);

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

    const mapImage = renderMapImage(this.world.hf, this.world.features);
    this.minimap = new Minimap(this.hud.minimapCanvas, mapImage);
    this.bigMap = new BigMap(this.hud.bigMapRoot, this.hud.bigMapCanvas, mapImage);
    this.setupObjectives();
    console.info(`[world] built in ${Math.round(performance.now() - t0)} ms`, this.world.stats);

    this.hud.ready();
    this.renderer.setAnimationLoop((t) => this.frame(t));
    this.exposeDebugApi();
  }

  private setupObjectives(): void {
    const deckY = this.world.lookoutDeckY;
    const square = TOWN_SQUARE;
    this.objectives = [
      {
        id: 'bridge', text: 'Cross Riverbend Bridge', done: false, x: (BRIDGE.x0 + BRIDGE.x1) / 2, z: BRIDGE.z,
        check: (p) => p.x > BRIDGE.x0 + 20 && p.x < BRIDGE.x1 - 20 && Math.abs(p.z - BRIDGE.z) < BRIDGE.halfWidth,
      },
      {
        id: 'town', text: 'Visit the Millbrook town square', done: false, x: square.x, z: square.z,
        check: (p) => Math.hypot(p.x - square.x, p.z - square.z) < 25,
      },
      {
        id: 'lookout', text: 'Climb the Lookout Hill tower', done: false, x: LOOKOUT.x, z: LOOKOUT.z,
        check: (p) => Math.hypot(p.x - LOOKOUT.x, p.z - LOOKOUT.z) < 5 && p.y > deckY - 0.4,
      },
    ];
  }

  private setActive(active: boolean): void {
    this.active = active;
    if (active) {
      this.hud.hideOverlay();
      if (!this.started) {
        this.started = true;
        this.hud.toast('Welcome to Riverbend. Take a look around the valley.');
      }
    } else {
      this.hud.showOverlay(this.started);
    }
  }

  private frame(now: number): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const inp = this.input;

    if (this.active) {
      // Fixed-step simulation.
      this.acc += dt;
      while (this.acc >= SIM_DT) {
        this.clock.step(SIM_DT);
        this.reactor.step(SIM_DT, SIM_DT * this.clock.scale);
        this.acc -= SIM_DT;
      }
      for (const e of this.reactor.drainEvents()) this.hud.toast(e.text, e.kind);

      if (inp.wasPressed('KeyM')) this.bigMap.toggle();
      if (inp.wasPressed('Backquote')) this.debugVisible = !this.debugVisible;
      if (this.debugVisible) {
        if (inp.wasPressed('KeyN')) {
          this.player.noclip = !this.player.noclip;
          this.hud.toast(`Noclip ${this.player.noclip ? 'on' : 'off'}`);
        }
        if (inp.wasPressed('KeyT')) this.clock.setHour(this.clock.hour + 1);
        this.debugReactorKeys();
      }

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
      this.checkObjectives();
    }
    inp.endFrame();

    const p = this.player.pos;
    this.camera.position.set(p.x, this.player.eyeY, p.z);
    this.camera.rotation.set(this.player.pitch, this.player.yaw, 0);
    this.focus.set(p.x, p.y, p.z);
    this.dayNight.update(this.clock.hour, this.focus);
    const rs = this.reactor.state;
    const towerLoad = Math.min(1, rs.condenserLoadMW / 2000);
    this.world.update(dt, this.dayNight.daylight, this.dayNight.night, towerLoad);

    this.renderer.render(this.scene, this.camera);

    // HUD.
    this.fpsFrames++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.fpsFrames / this.fpsTime;
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }
    const zone = zoneNameAt(p.x, p.z);
    this.hud.update({ time: this.clock.format(), weather: 'Clear', zone, fps: this.fps, reactor: reactorStatus(rs) });
    this.minimap.draw(p.x, p.z, this.player.yaw);
    const markers: MapMarker[] = this.objectives.map((o) => ({ x: o.x, z: o.z, label: o.text, done: o.done }));
    this.bigMap.draw(p.x, p.z, this.player.yaw, markers);
    this.cpuMs = this.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
    if (this.debugVisible) {
      const info = this.renderer.info.render;
      const s = this.world.stats;
      this.hud.setDebug(true, [
        `fps        ${this.fps.toFixed(0)}   cpu ${this.cpuMs.toFixed(1)} ms`,
        `pos        ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}`,
        `ground     ${this.player.onGround ? 'yes' : 'no'}${this.player.swimming ? '  (swimming)' : ''}${this.player.noclip ? '  NOCLIP' : ''}`,
        `zone       ${zone}`,
        `draws      ${info.calls}   tris ${(info.triangles / 1000).toFixed(0)}k`,
        `world      ${s.buildings} town bldgs, ${s.trees} trees, ${s.colliders} colliders`,
        'N noclip   T +1 hour',
        '',
        reactorDebugText(rs),
      ].join('\n'));
    } else {
      this.hud.setDebug(false);
    }
  }

  private checkObjectives(): void {
    let changed = false;
    for (const o of this.objectives) {
      if (!o.done && o.check(this.player.pos)) {
        o.done = true;
        changed = true;
        this.hud.toast(`Objective complete: ${o.text}`, 'good');
      }
    }
    if (changed && this.objectives.every((o) => o.done)) {
      this.hud.toast('You know the valley. Next up: the reactor.', 'good');
    }
    this.hud.setObjectives('Get to know the valley', this.objectives);
  }

  /** Temporary reactor controls until the control room arrives (Milestone 3). Debug panel must be open. */
  private debugReactorKeys(): void {
    const inp = this.input;
    const r = this.reactor;
    const s = r.state;
    const big = inp.isDown('ShiftLeft') || inp.isDown('ShiftRight');
    if (inp.wasPressed('BracketLeft')) r.nudgeRods(big ? 5 : 1);
    if (inp.wasPressed('BracketRight')) r.nudgeRods(big ? -5 : -1);
    if (inp.wasPressed('KeyP')) r.setAllCoolantPumps(!s.coolantPumps.some((p) => p.on));
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
    if (inp.wasPressed('KeyL')) {
      this.reactor = new Reactor(createReactorState('fullPower'));
      this.hud.toast('Debug: plant loaded at full power', 'warn');
    }
    if (inp.wasPressed('KeyK')) {
      this.reactor = new Reactor(createReactorState('cold'));
      this.hud.toast('Debug: plant reset to cold shutdown', 'warn');
    }
  }

  /** Small console API for testing and debugging: window.__game. */
  private exposeDebugApi(): void {
    const g = this;
    (window as unknown as { __game: unknown }).__game = {
      start: () => g.setActive(true),
      pause: () => g.setActive(false),
      teleport: (x: number, z: number, yaw?: number) => g.player.spawn(x, z, yaw ?? g.player.yaw),
      look: (yaw: number, pitch = 0) => {
        g.player.yaw = yaw;
        g.player.pitch = pitch;
      },
      setHour: (h: number) => g.clock.setHour(h),
      reactor: () => g.reactor,
      loadPlant: (preset: 'cold' | 'fullPower') => {
        g.reactor = new Reactor(createReactorState(preset));
      },
      plant: () => {
        const s = g.reactor.state;
        return {
          status: reactorStatus(s), flux: s.neutronFlux, thermalMW: Math.round(s.thermalPowerMW),
          MWe: Math.round(s.electricalOutputMW), rods: +averageRodInsertion(s).toFixed(1),
          coolant: +s.coolantTemp.toFixed(1), pressure: +s.primaryPressure.toFixed(2),
          rpm: Math.round(s.turbineRPM), synced: s.generatorSynced, scram: s.scram.cause, alarms: s.alarms,
        };
      },
      toggleMap: () => g.bigMap.toggle(),
      state: () => ({
        pos: { ...g.player.pos },
        onGround: g.player.onGround,
        swimming: g.player.swimming,
        zone: zoneNameAt(g.player.pos.x, g.player.pos.z),
        fps: Math.round(g.fps),
        time: g.clock.format(),
        objectives: g.objectives.map((o) => `${o.done ? '[x]' : '[ ]'} ${o.text}`),
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
