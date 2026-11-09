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
import { Grid, SUBSTATIONS } from './sim/grid';
import { activeAlarms } from './sim/alarms';
import { WEATHER_LABEL, Weather, createWeatherState, type WeatherKind } from './sim/weather';
import {
  FaultManager, REPAIR_SECONDS, faultLocation, faultPoint, faultStatus, faultTitle, type Fault, type FaultKind,
} from './sim/faults';
import { Staff } from './sim/staff';
import { Autopilot, type AutopilotReport } from './sim/autopilot';
import { Management, fmtMoney } from './sim/management';
import { Tablet } from './ui/tablet';
import { ProtestCrowd } from './world/protest';
import { Input } from './player/input';
import { PlayerController } from './player/controller';
import { Interactor } from './player/interaction';
import { Vehicle } from './player/vehicle';
import { World } from './world/world';
import { DayNight } from './world/sky';
import { TruckModel } from './world/truck';
import { WeatherFx } from './world/weatherFx';
import {
  BRIDGE, FIELD_POINTS, LOOKOUT, PLANT_LAYOUT, REST_POINT, ROADS, SPAWN, TOWN_SQUARE, TRUCK_SPAWN, zoneNameAt,
  type FieldPointId, type SubstationId,
} from './world/layout';
import type { PowerView } from './world/world';
import type { PanelId } from './world/controlRoom';
import { distToSegment } from './util/math';
import { Hud, type Objective } from './ui/hud';
import { BigMap, Minimap, renderMapImage, type MapMarker, type MapPin } from './ui/map';
import { reactorDebugText } from './ui/reactorDebug';
import { PanelManager } from './ui/panels/panelManager';
import { SoundFx } from './ui/audio';
import {
  drawAnnunciator, drawCoolingScreen, drawGridScreen, drawPrimaryScreen, drawReactorScreen, drawTrendScreen, drawTurbineScreen,
} from './ui/screens';

const SIM_DT = 0.1;
const WARPS = [1, 4, 16];
/** Personal dose limit (mSv per day) before you're sent to rest. */
const DOSE_LIMIT = 50;
const REST_HOURS = 8;

type Mode = 'paused' | 'play' | 'panel' | 'tablet';

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
  grid: 'Grid Dispatch Panel',
  annunciator: 'Annunciator Wall',
  trends: 'Trend Recorder',
};

const REPAIR_VERB: Record<FaultKind, string> = {
  rcpBearing: 'Service bearing', feedValve: 'Free stuck valve', towerFan: 'Repair fans', intakeClog: 'Clear debris',
  substationTrip: 'Reset breaker', lineDown: 'Inspect', radLeak: 'Reseal cask',
};

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

function onAnyRoad(x: number, z: number): boolean {
  for (const r of ROADS) {
    for (let i = 0; i < r.points.length - 1; i++) {
      const [ax, az] = r.points[i];
      const [bx, bz] = r.points[i + 1];
      if (distToSegment(x, z, ax, az, bx, bz) < r.width / 2 + 1) return true;
    }
  }
  return false;
}

class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly hud: Hud;
  private readonly input: Input;
  private readonly clock = new GameClock(8);
  private reactor = new Reactor(createReactorState('cold'));
  private readonly grid = new Grid();
  private readonly weather = new Weather(createWeatherState(1234, 8 * 3600));
  private readonly faults = new FaultManager();
  private readonly staff = new Staff();
  private readonly autopilot = new Autopilot();
  private readonly mgmt = new Management();
  private apReport: AutopilotReport = { active: false, reason: '', events: [] };
  private readonly annunciator = new Annunciator();
  private readonly power: PowerView = {
    groupPowered: (group) => {
      const [sub, feeder] = group.split(':');
      return this.grid.isFeederPowered(sub as SubstationId, Number(feeder));
    },
    substation: (id) => {
      const g = this.grid.state;
      const s = g.subs[id];
      if (!s.breakerClosed) return 'out';
      return g.dead ? 'dead' : 'on';
    },
  };
  private readonly trends = new TrendRecorder();
  private readonly sound = new SoundFx();
  private world!: World;
  private dayNight!: DayNight;
  private weatherFx!: WeatherFx;
  private player!: PlayerController;
  private vehicle!: Vehicle;
  private truck!: TruckModel;
  private interactor!: Interactor;
  private panels!: PanelManager;
  private tablet!: Tablet;
  private protest!: ProtestCrowd;
  private minimap!: Minimap;
  private bigMap!: BigMap;
  private groups: ObjectiveGroup[] = [];
  private groupIndex = 0;

  private mode: Mode = 'paused';
  private driving = false;
  private chaseYaw = 0;
  private readonly chaseCam = new THREE.Vector3();
  private repair: null | { fault: Fault; point: FieldPointId; elapsed: number; duration: number } = null;
  private doseMSv = 0;
  private doseRate = 0;
  private resting = 0;
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
  private debugFaultIndex = 0;
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
      this.sound.unlock();
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
    this.weatherFx = new WeatherFx(this.scene);
    this.player = new PlayerController(this.world.hf, this.world.collision);
    this.player.spawn(SPAWN.x, SPAWN.z, SPAWN.yaw);
    this.vehicle = new Vehicle(this.world.hf, this.world.collision, onAnyRoad, TRUCK_SPAWN.x, TRUCK_SPAWN.z, TRUCK_SPAWN.yaw);
    this.truck = new TruckModel(this.scene);
    this.interactor = new Interactor(this.world.interactables);
    this.panels = new PanelManager(this.hud.root, {
      reactor: () => this.reactor,
      grid: () => this.grid,
      faults: () => this.faults,
      staff: () => this.staff,
      annunciator: this.annunciator,
      trends: this.trends,
      gameSeconds: () => this.clock.seconds,
      demandMW: () => this.grid.state.demandMW,
      activeAlarms: () => this.activeAlarmIds(),
    }, PANEL_LABELS);
    this.panels.onClose = () => this.onPanelClosed();
    this.tablet = new Tablet(this.hud.root, {
      mgmt: this.mgmt,
      staff: this.staff,
      faults: this.faults,
      grid: this.grid,
      reactor: () => this.reactor,
      gameSeconds: () => this.clock.seconds,
      autopilotStatus: () => this.crewStatus(),
    });
    this.tablet.onClose = () => this.onPanelClosed();
    this.protest = new ProtestCrowd(this.scene, this.world.hf);

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
    this.hud.setPanelMode(mode === 'panel' || mode === 'tablet');
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

  private openTablet(): void {
    this.repair = null;
    this.tablet.open();
    this.setMode('tablet');
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** Who is minding the reactor, for the top bar and the tablet. */
  private crewStatus(): { active: boolean; text: string } {
    if (this.insideControlRoom || this.mode === 'panel') return { active: true, text: 'You are in the control room' };
    return { active: this.apReport.active, text: this.apReport.reason };
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

  private enterTruck(): void {
    this.driving = true;
    this.chaseYaw = 0;
    this.chaseCam.set(this.vehicle.x, this.vehicle.y + 4, this.vehicle.z);
    this.repair = null;
    this.hud.setDriving(true);
  }

  private exitTruck(): void {
    const at = this.vehicle.exitPoint();
    if (!at) {
      this.hud.toast('No room to get out here', 'warn');
      return;
    }
    if (Math.abs(this.vehicle.speed) > 2) {
      this.hud.toast('Stop the truck first', 'warn');
      return;
    }
    this.vehicle.speed = 0;
    this.driving = false;
    this.player.noclip = false;
    this.player.spawn(at.x, at.z, this.vehicle.yaw, this.vehicle.y + 1);
    this.hud.setDriving(false);
  }

  private event(kind: 'info' | 'good' | 'warn' | 'danger', text: string): void {
    this.hud.toast(text, kind);
    this.faults.note(this.clock.seconds, kind, text);
  }

  private activeAlarmIds(): string[] {
    return [...this.reactor.state.alarms, ...this.grid.state.alarms, ...this.faults.alarms];
  }

  /** Short top-bar note on who's minding the reactor. */
  private crewSummary(): { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' } {
    const rs = this.reactor.state;
    if (this.insideControlRoom || this.mode === 'panel') return { text: 'You have the controls', tone: 'dim' };
    if (this.apReport.active) return { text: `AUTO · ${this.staff.dutyOperator?.name ?? ''}`, tone: 'ok' };
    if (rs.generatorSynced || rs.neutronFlux > 0.01) return { text: 'Unattended', tone: 'warn' };
    return { text: 'Plant idle', tone: 'dim' };
  }

  private gridSummary(): { text: string; tone: 'ok' | 'warn' | 'bad' | 'dim' } {
    const g = this.grid.state;
    if (g.dead) return { text: `Grid dead · demand ${g.demandMW.toFixed(0)} MW`, tone: 'dim' };
    const text = `Grid ${g.servedMW.toFixed(0)} / ${g.demandMW.toFixed(0)} MW · ${g.frequency.toFixed(2)} Hz`;
    if (g.shedFraction > 0) return { text: `${text} · blackouts`, tone: 'bad' };
    if (g.frequency > 60.5) return { text, tone: 'warn' };
    return { text, tone: 'ok' };
  }

  private get insideControlRoom(): boolean {
    const c = PLANT_LAYOUT.controlRoom;
    const p = this.player.pos;
    return Math.abs(p.x - c.cx) < c.w / 2 && Math.abs(p.z - c.cz) < c.d / 2 && p.y < this.world.controlRoom.floorY + 3;
  }

  // ------------------------------------------------------------------ simulation

  /** One fixed simulation step of every system, in dependency order. */
  private simStep(strikes: Array<{ x: number; z: number }>): void {
    const dtGame = SIM_DT * this.clock.scale;
    this.clock.step(SIM_DT);
    const t = this.clock.seconds;
    const ws = this.weather.step(t, dtGame);
    if (ws.changed) this.hud.toast(`Weather: ${WEATHER_LABEL[ws.changed].toLowerCase()} moving in`, ws.changed === 'thunderstorm' ? 'warn' : 'info');
    const w = this.weather.state;
    this.reactor.env = { ambientTemp: w.ambientTemp, riverTemp: w.riverTemp };
    const fr = this.faults.step(t, dtGame, w.kind, ws.strikes, this.reactor);
    for (const e of fr.events) this.hud.toast(e.text, e.kind);
    for (const s of fr.strikes) strikes.push(s);
    this.faults.apply(this.reactor, this.grid);
    for (const e of this.staff.step(t, dtGame, new Set(this.faults.state.faults.map((f) => f.id)))) this.event('info', e);
    // The shift operator stands back while you're working the reactor or turbine panels.
    const youHaveControls = this.mode === 'panel' && ['reactor', 'primary', 'turbine'].includes(this.panels.current ?? '');
    this.apReport = this.autopilot.step(SIM_DT, this.reactor, this.grid, this.staff.state, this.staff.dutyOperator, youHaveControls);
    for (const e of this.apReport.events) this.event('warn', e);
    this.reactor.gridHz = this.grid.state.dead ? 60 : this.grid.state.frequency;
    this.reactor.lockout = this.mgmt.lockedOut(t)
      ? (this.mgmt.state.regulator.licenseRevoked ? 'operating licence revoked' : 'regulator-ordered shutdown in force')
      : null;
    this.reactor.step(SIM_DT, dtGame);
    const rs = this.reactor.state;
    const res = this.grid.step(SIM_DT, t, dtGame, rs.generatorSynced ? rs.electricalOutputMW : 0, w.ambientTemp);
    for (const e of res.events) this.hud.toast(e.text, e.kind);
    if (res.generatorTrip) this.reactor.generatorTrip(res.generatorTrip);
    for (const e of this.mgmt.step(t, dtGame, {
      reactor: this.reactor, grid: this.grid, faults: this.faults, staff: this.staff,
      controlRoomStaffed: this.insideControlRoom || this.staff.dutyOperator !== null,
      unackedAlarms: this.annunciator.unacknowledged,
      playerDoseMSv: this.doseMSv,
    })) this.event(e.kind, e.text);
    this.annunciator.update(this.activeAlarmIds());
    this.trends.record(t, rs, this.grid.state.demandMW);
    // Personal dose accumulates on the game clock.
    this.doseMSv += (this.doseRate * dtGame) / 3600 / 1000;
  }

  /** Run the simulation forward quickly (resting, debug). */
  private fastForward(gameSeconds: number): void {
    const steps = Math.round(gameSeconds / (SIM_DT * this.clock.scale));
    const sink: Array<{ x: number; z: number }> = [];
    for (let i = 0; i < steps; i++) this.simStep(sink);
    this.reactor.drainEvents();
  }

  /** Dose rate at the player's position, µSv/h. */
  private computeDoseRate(): number {
    const R = this.reactor.state.radiationLevels;
    const p = this.player.pos;
    let rate = R.site;
    const sf = PLANT_LAYOUT.spentFuel;
    const dPad = Math.hypot(p.x - sf.cx, p.z - sf.cz);
    rate += R.spentFuelPad / (1 + (dPad / 8) ** 2);
    const c = PLANT_LAYOUT.containment;
    const dC = Math.hypot(p.x - c.x, p.z - c.z);
    rate += (R.containment * 0.01) / (1 + (dC / 25) ** 2);
    const th = PLANT_LAYOUT.turbineHall;
    if (Math.abs(p.x - th.cx) < th.w / 2 && Math.abs(p.z - th.cz) < th.d / 2) rate += R.turbineHall;
    return rate;
  }

  private startRest(): void {
    this.resting = 2.5;
    this.repair = null;
    if (this.driving) {
      this.driving = false;
      this.hud.setDriving(false);
    }
    this.hud.setFade(`Dose limit reached (${DOSE_LIMIT} mSv). Health physics sends you off site to rest…`);
  }

  private finishRest(): void {
    this.fastForward(REST_HOURS * 3600);
    this.doseMSv = 0;
    this.player.noclip = false;
    this.player.spawn(REST_POINT.x, REST_POINT.z, REST_POINT.yaw);
    this.hud.setFade(null);
    this.hud.toast(`You rested for ${REST_HOURS} hours. Dose counter reset.`, 'info');
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
    const running = this.mode !== 'paused' && this.resting <= 0;
    let ePressed = inp.wasPressed('KeyE');
    const strikes: Array<{ x: number; z: number }> = [];

    if (this.resting > 0 && this.mode !== 'paused') {
      this.resting -= dt;
      if (this.resting <= 0) this.finishRest();
    }

    if (running) {
      // Fixed-step simulation.
      this.acc += dt * WARPS[this.warp];
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 400) {
        this.simStep(strikes);
        this.acc -= SIM_DT;
        steps++;
      }
      for (const e of this.reactor.drainEvents()) this.hud.toast(e.text, e.kind);
      if (this.doseMSv >= DOSE_LIMIT) this.startRest();

      if (inp.wasPressed('Backquote')) this.debugVisible = !this.debugVisible;
      if (this.debugVisible) this.debugKeys();
    }

    const [mdx, mdy] = inp.consumeMouse();
    if (this.mode === 'tablet') {
      if (inp.wasPressed('Tab') || inp.wasPressed('Escape')) this.tablet.close();
      if (this.driving) this.vehicle.update(dt, { throttle: 0, steer: 0, handbrake: true });
    } else if (this.mode === 'play' && this.resting <= 0 && inp.wasPressed('Tab')) {
      this.openTablet();
    }
    if (this.mode === 'play' && this.resting <= 0) {
      if (inp.wasPressed('KeyM')) this.bigMap.toggle();
      if (this.driving) {
        this.vehicle.update(dt, {
          throttle: (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0),
          steer: (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0),
          handbrake: inp.isDown('Space'),
        });
        // The player rides along (for zones, dose, objectives and the minimap).
        Object.assign(this.player.pos, { x: this.vehicle.x, y: this.vehicle.y, z: this.vehicle.z });
        this.player.yaw = this.vehicle.yaw;
        this.chaseYaw -= mdx * 0.004;
        if (mdx === 0) this.chaseYaw *= 1 - Math.min(1, dt * 1.5);
        if (ePressed) {
          this.exitTruck();
          ePressed = false;
        }
      } else {
        this.player.update(dt, {
          forward: (inp.isDown('KeyW') || inp.isDown('ArrowUp') ? 1 : 0) - (inp.isDown('KeyS') || inp.isDown('ArrowDown') ? 1 : 0),
          strafe: (inp.isDown('KeyD') || inp.isDown('ArrowRight') ? 1 : 0) - (inp.isDown('KeyA') || inp.isDown('ArrowLeft') ? 1 : 0),
          jump: inp.isDown('Space'),
          sprint: inp.isDown('ShiftLeft') || inp.isDown('ShiftRight'),
          crouch: inp.isDown('KeyC') || inp.isDown('ControlLeft'),
          lookDX: mdx,
          lookDY: mdy,
        });
      }
    } else if (this.mode === 'panel') {
      if (inp.wasPressed('Escape') || inp.wasPressed('KeyE')) {
        this.panels.close();
        ePressed = false; // don't reopen with the same key press
      }
    }
    if (running) this.checkObjectives();

    // Camera: first person on foot, chase camera in the truck.
    const p = this.player.pos;
    if (this.driving) {
      const v = this.vehicle;
      const yaw = v.yaw + this.chaseYaw;
      const want = new THREE.Vector3(v.x + Math.sin(yaw) * 9.5, v.y + 4.2, v.z + Math.cos(yaw) * 9.5);
      want.y = Math.max(want.y, this.world.hf.heightAt(want.x, want.z) + 1.5);
      this.chaseCam.lerp(want, 1 - Math.exp(-6 * dt));
      this.camera.position.copy(this.chaseCam);
      this.camera.lookAt(v.x, v.y + 1.8, v.z);
    } else {
      this.camera.position.set(p.x, this.player.eyeY, p.z);
      this.camera.rotation.set(this.player.pitch, this.player.yaw, 0);
    }
    this.camera.updateMatrixWorld();

    this.updateInteraction(dt, ePressed);
    inp.endFrame();

    this.focus.set(p.x, p.y, p.z);
    const w = this.weather.state;
    this.dayNight.cloud = w.cloud;
    this.dayNight.flash = this.weatherFx.flash;
    this.dayNight.update(this.clock.hour, this.focus);
    for (const s of strikes.slice(-3)) {
      const gy = this.world.hf.heightAt(s.x, s.z);
      this.weatherFx.strike(s.x, gy, s.z);
      const dist = Math.hypot(s.x - p.x, s.z - p.z);
      this.sound.thunder(Math.min(4, dist / 340), Math.max(0.15, 1 - dist / 1500));
    }
    this.weatherFx.update(dt, this.camera, w.rain);
    const rs = this.reactor.state;
    const towerLoad = Math.min(1, rs.condenserLoadMW / 2000);
    const faultPoints = new Set<FieldPointId>();
    for (const f of this.faults.state.faults) {
      const fp = faultPoint(f);
      if (fp) faultPoints.add(fp);
    }
    this.world.update(dt, this.dayNight.daylight, this.dayNight.night, towerLoad, this.power,
      { points: faultPoints, intakeClog: rs.plantFaults.intakeClog });
    this.truck.update(this.vehicle, dt, this.dayNight.night, this.driving);
    this.protest.update(dt, this.mgmt.state.opinion < 25);
    this.updateScreens(dt);
    this.panels.update(dt);
    this.tablet.update(dt);

    // Sound.
    this.doseRate = this.computeDoseRate();
    const rcp = FIELD_POINTS.rcp;
    const hottest = Math.max(...rs.coolantPumps.map((pp) => (pp.speed > 0.1 ? pp.bearingTemp : 0)));
    const near = 1 / (1 + (Math.hypot(p.x - rcp.x, p.z - rcp.z) / 15) ** 2);
    this.sound.update(dt, {
      horn: running && this.annunciator.hornOn && (this.insideControlRoom || this.mode === 'panel'),
      severe: activeAlarms(rs).some((a) => a.severity === 'trip'),
      rain: running ? w.rain : 0,
      whine: running ? Math.max(0, Math.min(1, (hottest - 80) / 40)) * near : 0,
      whinePitch: Math.max(0, Math.min(1, (hottest - 70) / 50)),
    });

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
      weather: `${WEATHER_LABEL[w.kind]} ${w.ambientTemp.toFixed(0)}°C`,
      zone, fps: this.fps, reactor: reactorStatus(rs), grid: this.gridSummary(),
      crew: this.crewSummary(),
      cash: `$${fmtMoney(this.mgmt.state.cash)}`,
      cashTone: this.mgmt.state.cash < 0 ? 'bad' : 'ok',
      opinion: this.mgmt.state.opinion,
    });
    this.hud.setSpeed(this.driving ? this.vehicle.speed * 3.6 : null);
    this.hud.setDosimeter(this.doseRate, this.doseMSv, DOSE_LIMIT);
    this.hud.setWorkOrders(this.faults.state.faults.slice(0, 5).map((f) => {
      const loc = faultLocation(f);
      const dx = loc.x - p.x;
      const dz = loc.z - p.z;
      const dir = COMPASS[Math.round(((Math.atan2(dx, -dz) / (Math.PI * 2)) * 8 + 8)) % 8];
      const dist = Math.hypot(dx, dz);
      return {
        title: faultTitle(f), action: faultStatus(f), where: dist < 30 ? 'here' : `${Math.round(dist / 10) * 10} m ${dir}`,
        tone: f.kind === 'radLeak' || f.kind === 'lineDown' || f.kind === 'substationTrip' ? 'bad' : 'warn',
      };
    }));

    const pins: MapPin[] = this.faults.state.faults.map((f) => ({
      ...faultLocation(f), color: '#ff5a3a', shape: 'diamond', label: faultTitle(f),
    }));
    if (!this.driving) pins.push({ x: this.vehicle.x, z: this.vehicle.z, color: '#5ab0ff', shape: 'square', label: 'Truck' });
    this.minimap.draw(p.x, p.z, this.player.yaw, pins);
    const g = this.groups[this.groupIndex];
    const markers: MapMarker[] = g.items.map((o) => ({ x: o.x, z: o.z, label: o.text, done: o.done }));
    const town = SUBSTATIONS.find((d) => d.id === 'town')!;
    const darkDistricts = Array.from({ length: town.feeders }, (_, i) => i).filter((i) => !this.grid.isFeederPowered('town', i));
    this.bigMap.draw(p.x, p.z, this.player.yaw, markers, { darkDistricts, substation: this.power.substation }, pins);
    this.cpuMs = this.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
    if (this.debugVisible) {
      const info = this.renderer.info.render;
      const s = this.world.stats;
      this.hud.setDebug(true, [
        `fps        ${this.fps.toFixed(0)}   cpu ${this.cpuMs.toFixed(1)} ms   sim ×${warp}`,
        `pos        ${p.x.toFixed(1)}, ${p.y.toFixed(2)}, ${p.z.toFixed(1)}${this.driving ? `   truck ${(this.vehicle.speed * 3.6).toFixed(0)} km/h` : ''}`,
        `ground     ${this.player.onGround ? 'yes' : 'no'}${this.player.swimming ? '  (swimming)' : ''}${this.player.noclip ? '  NOCLIP' : ''}`,
        `zone       ${zone}`,
        `draws      ${info.calls}   tris ${(info.triangles / 1000).toFixed(0)}k`,
        `world      ${s.buildings} town bldgs, ${s.trees} trees, ${s.towers} towers, ${s.colliders} colliders`,
        `weather    ${w.kind}  ${w.ambientTemp.toFixed(1)}°C  river ${w.riverTemp.toFixed(1)}°C  cloud ${w.cloud.toFixed(2)} rain ${w.rain.toFixed(2)}`,
        'N noclip   T +1 hour   = sim speed   O next weather   U inject fault   I inspection now',
        '',
        reactorDebugText(rs),
      ].join('\n'));
    } else {
      this.hud.setDebug(false);
    }
  }

  /** Crosshair prompts, panels, field repairs and the truck. */
  private updateInteraction(dt: number, ePressed: boolean): void {
    if (this.mode !== 'play' || this.resting > 0) {
      this.hud.setPrompt(null);
      this.hud.setProgress(null);
      return;
    }
    if (this.driving) {
      this.hud.setPrompt(Math.abs(this.vehicle.speed) < 2 ? '[E]  Get out' : null);
      this.hud.setProgress(null);
      return;
    }
    const target = this.interactor.update(this.camera, (i) => (i.kind === 'panel' ? this.insideControlRoom : true));

    // A repair in progress continues while you keep looking at the equipment.
    if (this.repair) {
      const still = target?.kind === 'field' && target.point === this.repair.point;
      if (!still) {
        this.hud.toast('Repair interrupted', 'warn');
        this.repair = null;
      } else {
        this.repair.elapsed += dt;
        const r = this.repair;
        this.hud.setProgress(`${REPAIR_VERB[r.fault.kind]}…`, r.elapsed / r.duration);
        this.hud.setPrompt(null);
        if (r.elapsed >= r.duration) {
          const err = this.faults.repair(r.fault.id, this.clock.seconds, this.reactor);
          if (err) this.hud.toast(err, 'warn');
          for (const e of this.faults.state.log.slice(-1)) if (!err) this.hud.toast(e.text, 'good');
          this.repair = null;
          this.hud.setProgress(null);
        }
        return;
      }
    }
    this.hud.setProgress(null);

    if (target?.kind === 'panel') {
      this.hud.setPrompt(`[E]  ${target.label}`);
      if (ePressed) this.openPanel(target.panelId);
      return;
    }
    if (target?.kind === 'field') {
      const f = this.faults.faultsAt(target.point)[0];
      const name = FIELD_POINTS[target.point].name;
      if (!f) {
        this.hud.setPrompt(`${name} — normal`);
        return;
      }
      this.hud.setPrompt(`[E]  ${REPAIR_VERB[f.kind]}: ${faultTitle(f)}`);
      if (ePressed) {
        if (f.kind === 'rcpBearing') {
          const pump = this.reactor.state.coolantPumps[Number(f.target)];
          if (pump.on || pump.speed > 0.05) {
            this.hud.toast(`Stop RCP ${Number(f.target) + 1} from the control room first`, 'warn');
            return;
          }
        }
        this.repair = { fault: f, point: target.point, elapsed: 0, duration: REPAIR_SECONDS[f.kind] };
      }
      return;
    }
    // The truck.
    const v = this.vehicle;
    const near = Math.hypot(v.x - this.player.pos.x, v.z - this.player.pos.z) < 4.2;
    this.hud.setPrompt(near ? '[E]  Drive utility truck' : null);
    if (near && ePressed) this.enterTruck();
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
    drawTurbineScreen(sc.turbine.ctx, s, this.grid.state.demandMW);
    drawCoolingScreen(sc.cooling.ctx, s);
    drawGridScreen(sc.grid.ctx, this.grid.state);
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
    if (inp.wasPressed('KeyO')) {
      const kinds: WeatherKind[] = ['clear', 'cloudy', 'rain', 'thunderstorm', 'heatwave', 'coldsnap'];
      const next = kinds[(kinds.indexOf(this.weather.state.kind) + 1) % kinds.length];
      this.weather.force(next, this.clock.seconds);
      this.hud.toast(`Debug: weather → ${WEATHER_LABEL[next]}`, 'warn');
    }
    if (inp.wasPressed('KeyI')) {
      this.mgmt.state.regulator.nextVisit = this.clock.seconds;
      this.hud.toast('Debug: inspectors arrive now', 'warn');
    }
    if (inp.wasPressed('KeyU')) {
      const list: Array<[FaultKind, string]> = [
        ['substationTrip', 'town'], ['intakeClog', 'intake'], ['rcpBearing', '1'], ['feedValve', 'fw3b'],
        ['towerFan', '0'], ['radLeak', 'pad'], ['lineDown', 'industrial'],
      ];
      const [kind, target] = list[this.debugFaultIndex++ % list.length];
      this.faults.inject(kind, target, this.clock.seconds);
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
      /** Debug camera: switch to noclip and hover at a position. */
      fly: (x: number, y: number, z: number, yaw: number, pitch = 0) => {
        g.player.noclip = true;
        Object.assign(g.player.pos, { x, y, z });
        g.player.yaw = yaw;
        g.player.pitch = pitch;
      },
      openPanel: (id: PanelId) => g.openPanel(id),
      openTablet: () => g.openTablet(),
      closeTablet: () => g.tablet.close(),
      company: () => {
        const m = g.mgmt.state;
        return {
          cash: Math.round(m.cash), opinion: +m.opinion.toFixed(1), today: m.today, days: m.history.length,
          contracts: m.contracts.map((c) => `${c.sub} $${c.price}`), offers: m.offers.map((o) => `${o.sub} $${o.price}`),
          nextInspection: m.regulator.nextVisit, failures: m.regulator.failures, reports: m.regulator.reports.map((r) => `${r.score} ${r.passed ? 'pass' : 'FAIL'}: ${r.findings.join('; ')}`),
          staff: g.staff.state.members.map((s) => `${s.name} (${s.role}, ${s.skill}★, fatigue ${s.fatigue.toFixed(2)})`),
          duty: g.staff.dutyOperator?.name ?? null, autopilot: g.apReport.reason,
        };
      },
      closePanel: () => g.panels.close(),
      setWarp: (n: number) => {
        g.warp = Math.max(0, WARPS.indexOf(n));
      },
      setHour: (h: number) => g.clock.setHour(h),
      fastForward: (hours: number) => g.fastForward(hours * 3600),
      toggleMap: () => g.bigMap.toggle(),
      reactor: () => g.reactor,
      setWeather: (kind: WeatherKind) => g.weather.force(kind, g.clock.seconds),
      weather: () => ({ ...g.weather.state }),
      injectFault: (kind: FaultKind, target: string) => g.faults.inject(kind, target, g.clock.seconds),
      faults: () => g.faults.state.faults.map((f) => `${faultTitle(f)} [${f.progress.toFixed(2)}]`),
      log: () => g.faults.state.log.slice(-10).map((e) => e.text),
      truck: () => ({
        x: +g.vehicle.x.toFixed(1), z: +g.vehicle.z.toFixed(1), y: +g.vehicle.y.toFixed(2),
        yaw: +g.vehicle.yaw.toFixed(3), kmh: Math.round(g.vehicle.speed * 3.6), driving: g.driving, road: g.vehicle.onRoadNow,
      }),
      dose: () => ({ rate: Math.round(g.doseRate), mSv: +g.doseMSv.toFixed(2) }),
      grid: () => {
        const s = g.grid.state;
        return {
          dead: s.dead, hz: +s.frequency.toFixed(2), supply: Math.round(s.supplyMW), demand: Math.round(s.demandMW),
          served: Math.round(s.servedMW), shed: +s.shedFraction.toFixed(3), alarms: s.alarms,
          townOff: s.subs.town.feedersOff,
          subs: Object.fromEntries(Object.entries(s.subs).map(([k, v]) => [k, `${v.breakerClosed ? '' : 'OPEN '}${v.servedMW.toFixed(0)}/${v.demandMW.toFixed(0)} off:${v.feedersOff.length}`])),
        };
      },
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
        driving: g.driving,
        panel: g.panels.current,
        prompt: g.interactor.current ? (g.interactor.current.kind === 'panel' ? g.interactor.current.label : g.interactor.current.point) : null,
        repairing: g.repair ? `${g.repair.point} ${(g.repair.elapsed / g.repair.duration * 100).toFixed(0)}%` : null,
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
