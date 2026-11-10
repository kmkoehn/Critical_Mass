/**
 * Critical Mass — bootstrap and main loop.
 * Fixed-step simulation (SIM_DT) + variable-rate rendering.
 */
import * as THREE from 'three';
import './ui/style.css';
import { GameClock } from './sim/clock';
import { Reactor, averageRodInsertion, createReactorState, reactorStatus } from './sim/reactor';
import { ANNUNCIATOR_TILES, Annunciator } from './sim/annunciator';
import { TrendRecorder } from './sim/history';
import { Grid, SUBSTATIONS } from './sim/grid';
import { WEATHER_LABEL, Weather, createWeatherState, type WeatherKind } from './sim/weather';
import {
  FaultManager, REPAIR_SECONDS, faultLocation, faultPoint, faultStatus, faultTitle, type Fault, type FaultKind,
} from './sim/faults';
import { Staff } from './sim/staff';
import { Autopilot, type AutopilotReport } from './sim/autopilot';
import { Management, fmtMoney } from './sim/management';
import { Tablet } from './ui/tablet';
import { ProtestCrowd } from './world/protest';
import { Campaign, GAME_OVER_TEXT, TRAVEL_POINTS } from './sim/campaign';
import { UPGRADE_BY_ID, Upgrades, type UpgradeId } from './sim/upgrades';
import { UNIT2, Unit2 } from './sim/unit2';
import { EndScreen, type ReportStats } from './ui/endScreen';
import { Input } from './player/input';
import { PlayerController } from './player/controller';
import { Interactor } from './player/interaction';
import { Vehicle } from './player/vehicle';
import { World } from './world/world';
import { DayNight } from './world/sky';
import { TruckModel } from './world/truck';
import { WeatherFx } from './world/weatherFx';
import { PlantEffects } from './world/effects';
import {
  FIELD_POINTS, PLANT_LAYOUT, REST_POINT, ROADS, SPAWN, TOWN_SQUARE, TRUCK_SPAWN, zoneNameAt,
  type FieldPointId, type SubstationId,
} from './world/layout';
import type { PowerView } from './world/world';
import type { PanelId } from './world/controlRoom';
import { distToSegment } from './util/math';
import { Hud } from './ui/hud';
import { BigMap, Minimap, renderMapImage, type MapMarker, type MapPin } from './ui/map';
import { reactorDebugText } from './ui/reactorDebug';
import { PanelManager } from './ui/panels/panelManager';
import { SoundFx, type AlarmLevel } from './ui/audio';
import { Menu } from './ui/menu';
import { QUALITY, loadSettings, saveSettings, type Settings } from './ui/settings';
import { SaveStore, browserStore, SAVE_VERSION, type SaveData, type SlotId } from './save/save';
import { PLAYER } from './player/controller';
import {
  drawAnnunciator, drawCoolingScreen, drawGridScreen, drawPrimaryScreen, drawReactorScreen, drawTrendScreen, drawTurbineScreen,
} from './ui/screens';

const SIM_DT = 0.1;
const WARPS = [1, 4, 16];
/** Personal dose limit (mSv per day) before you're sent to rest. */
const DOSE_LIMIT = 50;
const REST_HOURS = 8;
/** Autosave interval, game seconds. */
const AUTOSAVE_EVERY = 3 * 3600;

type Mode = 'paused' | 'play' | 'panel' | 'tablet' | 'over';


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
  private effects!: PlantEffects;
  private player!: PlayerController;
  private vehicle!: Vehicle;
  private truck!: TruckModel;
  private interactor!: Interactor;
  private panels!: PanelManager;
  private tablet!: Tablet;
  private protest!: ProtestCrowd;
  private minimap!: Minimap;
  private bigMap!: BigMap;
  private readonly campaign = new Campaign();
  private readonly upgrades = new Upgrades();
  private readonly unit2 = new Unit2();
  private endScreen!: EndScreen;
  private pendingWin = false;
  private readonly store = browserStore();
  private readonly saves = new SaveStore(this.store);
  private settings: Settings = loadSettings(this.store);
  private menu!: Menu;
  private nextAutosave = 0;

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
    const q = QUALITY[this.settings.quality];
    this.renderer = new THREE.WebGLRenderer({ antialias: q.antialias, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = q.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.62;
    this.renderer.domElement.className = 'game';
    app.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 4500);
    this.camera.rotation.order = 'YXZ';

    this.hud = new Hud(app);
    this.input = new Input(this.renderer.domElement);
    this.menu = new Menu(this.hud.root, {
      newGame: () => this.beginPlay(),
      resume: () => this.beginPlay(),
      load: (slot) => this.loadGame(slot),
      save: () => this.saveGame('manual'),
      quitToTitle: () => this.quitToTitle(),
      settingsChanged: (st) => this.applySettings(st),
    }, this.saves, { ...this.settings });
    this.input.onLockChange = (locked) => this.onLockChange(locked);
    this.renderer.domElement.addEventListener('mousedown', () => {
      if (this.mode === 'play' && !this.input.locked && !this.noLock) this.input.requestLock();
    });

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
    this.effects = new PlantEffects(this.world.root, this.scene, this.world.hf);
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
      upgrades: this.upgrades,
      unit2: this.unit2,
      act: () => this.campaign.state.act,
      buyUpgrade: (id) => this.buyUpgrade(id),
      reactor: () => this.reactor,
      gameSeconds: () => this.clock.seconds,
      autopilotStatus: () => this.crewStatus(),
    });
    this.tablet.onClose = () => this.onPanelClosed();
    this.protest = new ProtestCrowd(this.scene, this.world.hf);

    const mapImage = renderMapImage(this.world.hf, this.world.features);
    this.minimap = new Minimap(this.hud.minimapCanvas, mapImage);
    this.bigMap = new BigMap(this.hud.bigMapRoot, this.hud.bigMapCanvas, mapImage);
    this.endScreen = new EndScreen(this.hud.root);
    console.info(`[world] built in ${Math.round(performance.now() - t0)} ms`, this.world.stats);

    this.applySettings(this.settings);
    this.nextAutosave = this.clock.seconds + AUTOSAVE_EVERY;
    this.hud.root.classList.add('at-title');
    this.menu.ready();
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
    this.hud.root.classList.toggle('at-title', mode === 'paused' && !this.started);
    if (mode === 'paused') {
      this.menu.show(this.started ? 'pause' : 'title');
      return;
    }
    this.menu.hide();
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

  /** Most severe alarm still waiting to be acknowledged. */
  private alarmLevel(): AlarmLevel {
    const tiles = this.annunciator.state.tiles;
    let level: AlarmLevel = 'none';
    const rank = { none: 0, warning: 1, alarm: 2, trip: 3 } as const;
    for (const a of ANNUNCIATOR_TILES) {
      if (tiles[a.id] === 'alerting' && rank[a.severity] > rank[level]) level = a.severity;
    }
    return level;
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
    for (const id of this.upgrades.step(t)) this.onUpgradeComplete(id);
    this.applyUpgrades();
    this.unit2.step(t, dtGame, this.grid.state.demandMW, this.reactor.state.generatorSynced);
    this.autopilot.otherSupplyMW = this.unit2.state.outputMW;
    for (const e of this.staff.step(t, dtGame, new Set(this.faults.state.faults.map((f) => f.id)))) this.event('info', e);
    // The shift operator stands back while you're working the reactor or turbine panels.
    const youHaveControls = this.mode === 'panel' && ['reactor', 'primary', 'turbine'].includes(this.panels.current ?? '');
    const hotPumps = this.faults.state.faults.filter((f) => f.kind === 'rcpBearing').map((f) => Number(f.target));
    this.apReport = this.autopilot.step(SIM_DT, this.reactor, this.grid, this.staff.state, this.staff.dutyOperator, youHaveControls, hotPumps);
    for (const e of this.apReport.events) this.event('warn', e);
    this.reactor.gridHz = this.grid.state.dead ? 60 : this.grid.state.frequency;
    this.reactor.lockout = this.mgmt.lockedOut(t)
      ? (this.mgmt.state.regulator.licenseRevoked ? 'operating licence revoked' : 'regulator-ordered shutdown in force')
      : null;
    this.reactor.step(SIM_DT, dtGame);
    const rs = this.reactor.state;
    const unit1MW = rs.generatorSynced ? rs.electricalOutputMW : 0;
    const res = this.grid.step(SIM_DT, t, dtGame, unit1MW + this.unit2.state.outputMW, w.ambientTemp);
    for (const e of res.events) this.hud.toast(e.text, e.kind);
    if (res.generatorTrip) {
      this.reactor.generatorTrip(res.generatorTrip);
      if (this.unit2.state.outputMW > 0) {
        this.unit2.trip(t);
        this.event('warn', 'Unit 2 tripped off the grid. Its crew will restart it in about 4 hours.');
      }
    }
    for (const e of this.mgmt.step(t, dtGame, {
      reactor: this.reactor, grid: this.grid, faults: this.faults, staff: this.staff,
      controlRoomStaffed: this.insideControlRoom || this.staff.dutyOperator !== null,
      unackedAlarms: this.annunciator.unacknowledged,
      playerDoseMSv: this.doseMSv,
    })) this.event(e.kind, e.text);
    // The campaign: objectives, scripted events, achievements, winning and losing.
    const cr = this.campaign.step(this.campaignContext());
    for (const e of cr.events) this.event(e.kind, e.text);
    const act = cr.actions;
    if (act.forceWeather) this.weather.force(act.forceWeather.kind, t, act.forceWeather.hours);
    if (act.pullInspectionTo !== undefined) {
      const reg = this.mgmt.state.regulator;
      if (reg.nextVisit > act.pullInspectionTo) {
        reg.nextVisit = act.pullInspectionTo;
        reg.announced = false;
      }
    }
    if (act.demandGrowth) for (const k of Object.keys(this.grid.state.scale) as SubstationId[]) this.grid.state.scale[k] *= act.demandGrowth;
    if (act.grant) this.mgmt.state.cash += act.grant;
    if (act.win) this.pendingWin = true;
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

  // ------------------------------------------------------------------ menu, settings, saving

  /** Start or resume play from a menu button (a user gesture, so audio and pointer lock are allowed). */
  private beginPlay(): void {
    this.sound.unlock();
    if (this.noLock) {
      this.setMode('play');
      return;
    }
    this.input.requestLock();
    // Some browsers refuse pointer lock (embedded views, permissions): play anyway, and a click
    // on the view tries again.
    setTimeout(() => {
      if ((this.mode === 'paused' || this.mode === 'over') && !this.input.locked) {
        this.setMode('play');
        this.hud.toast('Click the view to capture the mouse for looking around', 'info');
      }
    }, 600);
  }

  private applySettings(st: Settings): void {
    const prevQuality = this.settings.quality;
    this.settings = st;
    saveSettings(this.store, st);
    this.player.sensitivity = PLAYER.sensitivity * st.sensitivity;
    this.player.invertY = st.invertY;
    this.clock.scale = 86400 / (st.dayMinutes * 60);
    this.sound.setVolume(st.volume);
    const q = QUALITY[st.quality];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
    this.camera.far = q.drawDistance;
    this.camera.updateProjectionMatrix();
    this.dayNight.setDrawDistance(q.drawDistance);
    this.dayNight.setShadowQuality(q.shadows, q.shadowMap);
    if (this.renderer.shadowMap.enabled !== q.shadows || prevQuality !== st.quality) {
      this.renderer.shadowMap.enabled = q.shadows;
      // Materials compile differently with and without shadows.
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
  }

  private snapshot(): SaveData {
    const p = this.player.pos;
    const a = this.campaign.actDef;
    return structuredClone({
      version: SAVE_VERSION,
      savedAt: Date.now(),
      label: `${this.clock.format()} · ${a ? `Act ${this.campaign.state.act}` : 'Sandbox'}`,
      clockSeconds: this.clock.seconds,
      reactor: this.reactor.state,
      grid: this.grid.state,
      weather: this.weather.state,
      faults: this.faults.state,
      staff: this.staff.state,
      mgmt: this.mgmt.state,
      campaign: this.campaign.state,
      upgrades: this.upgrades.state,
      unit2: this.unit2.state,
      annunciator: this.annunciator.state,
      autopilot: this.autopilot.snapshot(),
      player: { x: p.x, y: p.y, z: p.z, yaw: this.player.yaw, pitch: this.player.pitch },
      vehicle: { x: this.vehicle.x, z: this.vehicle.z, yaw: this.vehicle.yaw },
      doseMSv: this.doseMSv,
    });
  }

  private saveGame(slot: SlotId): string | null {
    if (this.campaign.state.gameOver) return 'The game is over: there is nothing to save.';
    return this.saves.write(slot, this.snapshot());
  }

  /** Restore a save into the running game, in place (other objects keep their references). */
  private applySave(d: SaveData): void {
    this.clock.seconds = d.clockSeconds;
    this.reactor = new Reactor(d.reactor);
    Object.assign(this.grid.state, d.grid);
    this.grid.resync();
    Object.assign(this.weather.state, d.weather);
    Object.assign(this.faults.state, d.faults);
    Object.assign(this.staff.state, d.staff);
    Object.assign(this.mgmt.state, d.mgmt);
    Object.assign(this.campaign.state, d.campaign);
    Object.assign(this.upgrades.state, d.upgrades);
    Object.assign(this.unit2.state, d.unit2);
    if (d.annunciator) Object.assign(this.annunciator.state, d.annunciator);
    if (d.autopilot) this.autopilot.restore(d.autopilot);
    this.applyUpgrades();
    this.trends.clear();
    this.doseMSv = d.doseMSv ?? 0;
    this.repair = null;
    this.pendingWin = false;
    this.resting = 0;
    this.hud.setFade(null);
    if (this.driving) {
      this.driving = false;
      this.hud.setDriving(false);
    }
    this.vehicle.place(d.vehicle.x, d.vehicle.z, d.vehicle.yaw);
    this.player.noclip = false;
    this.player.spawn(d.player.x, d.player.z, d.player.yaw, d.player.y + 1.5);
    this.player.pitch = d.player.pitch;
    this.panels.close();
    this.tablet.close();
    this.endScreen.hide();
    this.sound.setSiren(false);
    this.nextAutosave = this.clock.seconds + AUTOSAVE_EVERY;
  }

  private loadGame(slot: SlotId): string | null {
    let d: SaveData | null;
    try {
      d = this.saves.read(slot);
    } catch (e) {
      return (e as Error).message;
    }
    if (!d) return 'That save slot is empty.';
    this.applySave(d);
    this.started = true;
    // Leave the end screen's mode; play resumes when the mouse is captured.
    if (this.mode === 'over') this.mode = 'paused';
    this.beginPlay();
    this.hud.toast(`Loaded: ${d.label}`, 'good');
    return null;
  }

  private quitToTitle(): void {
    if (this.settings.autosave && this.started) this.saveGame('auto');
    location.reload();
  }

  // ------------------------------------------------------------------ objectives

  /** Upgrade effects pushed into the other models (every step, so loading a save works too). */
  private applyUpgrades(): void {
    const u = this.upgrades;
    this.reactor.mods = {
      efficiency: u.has('turbineRetrofit') ? 1.06 : 1,
      coolingMult: u.has('coolingTower3') ? 1.25 : 1,
      strongEmergency: u.has('dieselBackup'),
    };
    this.faults.stormHardened = u.has('stormHardening');
    this.autopilot.autoRods = u.has('autoRods');
    this.mgmt.mods = {
      opinionBaseline: u.has('visitorCentre') ? 65 : 50,
      opinionRecovery: u.has('visitorCentre') ? 0.7 : 0.4,
      inspectionBonus: u.has('dieselBackup') ? 5 : 0,
      extraOverheadPerHour: this.unit2.state.built ? UNIT2.overheadPerHour : 0,
      extraGenerationMW: this.unit2.state.outputMW,
    };
  }

  private buyUpgrade(id: UpgradeId): string | null {
    const block = this.upgrades.blocker(id, this.mgmt.state.cash, this.campaign.state.act);
    if (block) return block;
    const def = UPGRADE_BY_ID[id];
    this.mgmt.spendCapital(def.cost);
    this.upgrades.start(id, this.clock.seconds);
    this.event('info', `Construction started: ${def.name} (${def.hours} game hours)`);
    return null;
  }

  private onUpgradeComplete(id: UpgradeId): void {
    this.event('good', `Construction complete: ${UPGRADE_BY_ID[id].name}`);
    if (id === 'unit2') {
      this.unit2.complete(this.clock.seconds);
      this.event('info', 'Unit 2 is commissioning and will start delivering power in a few hours.');
    }
    if (id === 'tieLine') this.grid.state.exportScale.city = 1;
  }

  private campaignContext() {
    const p = this.player.pos;
    return {
      t: this.clock.seconds,
      player: { x: p.x, y: p.y, z: p.z, insideControlRoom: this.insideControlRoom, lookoutDeckY: this.world.lookoutDeckY },
      reactor: this.reactor.state, grid: this.grid.state, staff: this.staff.state, mgmt: this.mgmt.state,
      upgrades: this.upgrades.state, unit2: this.unit2.state, weather: this.weather.state,
    };
  }

  private stats(): ReportStats {
    const m = this.mgmt.state;
    const passed = m.regulator.reports.filter((r) => r.passed).length;
    return {
      days: Math.floor(this.clock.seconds / 86400) + 1,
      deliveredGWh: this.grid.state.stats.servedMWh / 1000,
      cash: `$${fmtMoney(m.cash)}`,
      opinion: m.opinion,
      inspections: `${passed} / ${m.regulator.reports.length - passed}`,
      trips: m.totalTrips,
      repairs: `${m.repairsByPlayer} / ${m.repairsByCrew}`,
      achievements: [...this.campaign.state.achievements],
    };
  }

  private showGameOver(): void {
    const go = this.campaign.state.gameOver!;
    const text = GAME_OVER_TEXT[go.kind];
    this.repair = null;
    this.panels.close();
    this.tablet.close();
    this.setMode('over');
    if (document.pointerLockElement) document.exitPointerLock();
    if (go.kind === 'meltdown') this.sound.setSiren(true);
    const last = this.saves.latest();
    const info = last ? this.saves.list().find((x) => x.slot === last) : undefined;
    this.endScreen.show('lose', text.title, text.body, this.stats(), {
      onLoad: last && info && 'label' in info ? {
        label: `Load last save (${info.label})`,
        run: () => {
          const err = this.loadGame(last);
          if (err) this.hud.toast(err, 'danger');
        },
      } : undefined,
    });
  }

  private showWin(): void {
    this.setMode('over');
    if (document.pointerLockElement) document.exitPointerLock();
    this.endScreen.show('win', 'Riverbend is thriving',
      'Two units on the grid, a city contract, and a valley that kept its lights on through the worst heatwave in memory. ' +
      'The board has renewed your contract. Riverbend is yours to run for as long as you like.',
      this.stats(), {
        onContinue: () => {
          this.setMode('play');
          if (!this.noLock) this.input.requestLock();
        },
      });
  }

  /** Fast travel: time passes as if you drove there. */
  private fastTravel(index: number): void {
    const dests = TRAVEL_POINTS.filter((d) => this.campaign.state.visited.includes(d.id));
    const d = dests[index];
    if (!d) return;
    const p = this.player.pos;
    const travelS = Math.max(300, Math.hypot(d.x - p.x, d.z - p.z) / 11);
    this.bigMap.toggle();
    this.fastForward(travelS);
    this.player.noclip = false;
    this.player.spawn(d.x, d.z, d.yaw);
    this.event('info', `Travelled to ${d.name} (${Math.round(travelS / 60)} game min)`);
  }

  private updateObjectivesHud(): void {
    const a = this.campaign.actDef;
    if (!a) {
      this.hud.setObjectives('Sandbox', [{ id: 'sandbox', text: 'Keep the valley powered as demand grows', done: false }]);
      return;
    }
    this.hud.setObjectives(a.title, this.campaign.objectives());
  }

  // ------------------------------------------------------------------ frame

  private frame(now: number): void {
    const t0 = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.realTime += dt;
    const inp = this.input;
    const running = this.mode !== 'paused' && this.mode !== 'over' && this.resting <= 0;
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
      if (this.campaign.state.gameOver) this.showGameOver();
      else if (this.pendingWin) {
        this.pendingWin = false;
        this.showWin();
      }
      if (this.clock.seconds >= this.nextAutosave) {
        this.nextAutosave = this.clock.seconds + AUTOSAVE_EVERY;
        if (this.settings.autosave && this.mode !== 'over' && !this.campaign.state.gameOver) {
          const err = this.saveGame('auto');
          if (err) this.hud.toast(err, 'warn');
        }
      }
      if (inp.wasPressed('F5')) {
        const err = this.saveGame('manual');
        this.hud.toast(err ?? 'Game saved', err ? 'warn' : 'good');
      }

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
    // Without pointer lock, Esc doesn't leave the lock, so pause here.
    if (this.mode === 'play' && !inp.locked && !this.noLock && inp.wasPressed('Escape')) this.setMode('paused');
    if (this.mode === 'play' && this.resting <= 0) {
      if (inp.wasPressed('KeyM')) this.bigMap.toggle();
      // Fast travel from the open map with the number keys (on foot only).
      if (this.bigMap.visible && !this.driving) {
        for (let i = 0; i < 9; i++) {
          if (inp.wasPressed(`Digit${i + 1}`)) {
            this.fastTravel(i);
            break;
          }
        }
      }
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
    this.updateObjectivesHud();

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
    } else if (!this.started) {
      // Title screen: a slow flight around the plant.
      const a = this.realTime * 0.03 + 0.4;
      const cx = -470;
      const cz = 0;
      this.camera.position.set(cx + Math.cos(a) * 520, 120 + Math.sin(this.realTime * 0.05) * 20, cz + Math.sin(a) * 520);
      this.camera.lookAt(cx, 50, cz);
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
    const rs = this.reactor.state;
    // Below freezing, precipitation falls as snow.
    const freezing = w.ambientTemp < 0.5;
    this.weatherFx.update(dt, this.camera, freezing ? 0 : w.rain);
    const tiles = this.annunciator.state.tiles;
    const plantAlarm = ANNUNCIATOR_TILES.some((a) => a.severity !== 'warning' && tiles[a.id] !== undefined && tiles[a.id] !== 'off');
    const relief = rs.steamDump > 0.05 ? Math.min(1, rs.steamDump * 1.5)
      : rs.turbineTripped && rs.secondaryTemp > 240 && rs.neutronFlux > 0.02 ? 0.7 : 0;
    this.effects.update(dt, this.camera, {
      alarm: plantAlarm || !!this.campaign.state.gameOver, relief, outfallTemp: rs.outfallTemp, cloud: w.cloud,
      snow: freezing ? Math.max(w.rain, w.kind === 'coldsnap' ? 0.4 + 0.5 * w.cloud : 0) : 0,
      daylight: this.dayNight.daylight, night: this.dayNight.night, skyColor: (this.scene.fog as THREE.FogExp2).color,
    });
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
    const now_ = this.clock.seconds;
    this.world.expansion.update(dt, {
      coolingTower3: this.upgrades.progress('coolingTower3', now_),
      visitorCentre: this.upgrades.progress('visitorCentre', now_),
      unit2: this.upgrades.progress('unit2', now_),
    }, this.dayNight.daylight, this.dayNight.night, towerLoad);
    const goal = this.campaign.current();
    const mk = goal?.marker;
    this.world.waypoint.update(dt, mk ? {
      x: mk.x, z: mk.z, y: this.world.hf.heightAt(mk.x, mk.z) + (mk.y ?? 0), indoor: mk.y !== undefined,
    } : null, mk ? Math.hypot(mk.x - p.x, mk.z - p.z) : 0);
    this.updateScreens(dt);
    this.panels.update(dt);
    this.tablet.update(dt);

    // Sound.
    this.doseRate = this.computeDoseRate();
    const rcp = FIELD_POINTS.rcp;
    const hottest = Math.max(...rs.coolantPumps.map((pp) => (pp.speed > 0.1 ? pp.bearingTemp : 0)));
    const near = 1 / (1 + (Math.hypot(p.x - rcp.x, p.z - rcp.z) / 15) ** 2);
    const inCR = this.insideControlRoom || this.mode === 'panel';
    const th = PLANT_LAYOUT.turbineHall;
    const inHall = Math.abs(p.x - th.cx) < th.w / 2 && Math.abs(p.z - th.cz) < th.d / 2;
    const ct = PLANT_LAYOUT.containment;
    const falloff = (d: number, r: number) => 1 / (1 + (d / r) ** 2);
    const dPlant = Math.hypot(p.x - th.cx, p.z - th.cz);
    const dTown = Math.hypot(p.x - TOWN_SQUARE.x, p.z - TOWN_SQUARE.z);
    this.sound.update(dt, {
      alarm: running && this.annunciator.hornOn && inCR ? this.alarmLevel() : 'none',
      power: running ? Math.min(1.2, rs.thermalPowerMW / 3000) : 0,
      nearReactor: inCR ? 0.5 : falloff(Math.hypot(p.x - ct.x, p.z - ct.z), 60),
      turbine: running ? Math.min(1.1, rs.turbineRPM / 3600) : 0,
      nearTurbine: inHall ? 1 : inCR ? 0.15 : falloff(dPlant, 70),
      indoors: inCR || inHall,
      rain: running ? w.rain : 0,
      wind: running ? (w.kind === 'thunderstorm' ? 1 : w.kind === 'rain' ? 0.45 : w.kind === 'coldsnap' ? 0.35 : 0.1) : 0,
      whine: running ? Math.max(0, Math.min(1, (hottest - 80) / 40)) * near : 0,
      whinePitch: Math.max(0, Math.min(1, (hottest - 70) / 50)),
      doseRate: running ? this.doseRate : 0,
      nearTown: running ? falloff(dTown, 260) : 0,
      daylight: this.dayNight.daylight,
      countryside: running ? Math.min(1, Math.max(0, (Math.min(dPlant, dTown) - 250) / 300)) : 0,
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
    const markers: MapMarker[] = this.campaign.objectives().filter((o) => o.marker && !o.done).slice(0, 1)
      .map((o) => ({ x: o.marker!.x, z: o.marker!.z, label: o.text, done: false }));
    this.bigMap.setTravel(this.driving ? null : TRAVEL_POINTS.filter((d) => this.campaign.state.visited.includes(d.id)));
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
      /** Renderable objects by type, and the largest groups of separate meshes (performance work). */
      sceneStats: () => {
        const types: Record<string, number> = {};
        const byParent: Record<string, number> = {};
        g.scene.traverse((o) => {
          if (!(o as THREE.Mesh).isMesh && !(o as THREE.Sprite).isSprite && !(o as THREE.Line).isLine && !(o as THREE.Points).isPoints) return;
          types[o.type] = (types[o.type] ?? 0) + 1;
          if (o.type === 'Mesh') {
            const k = `${o.parent?.name || o.parent?.type}/${o.name || ((o as THREE.Mesh).material as THREE.Material).name || ((o as THREE.Mesh).geometry.type)}`;
            byParent[k] = (byParent[k] ?? 0) + 1;
          }
        });
        return { types, top: Object.entries(byParent).sort((a, b) => b[1] - a[1]).slice(0, 15) };
      },
      save: (slot: SlotId = 'manual') => g.saveGame(slot),
      load: (slot: SlotId = 'manual') => g.loadGame(slot),
      saves: () => g.saves.list(),
      settings: () => ({ ...g.settings }),
      applySettings: (st: Partial<Settings>) => g.applySettings({ ...g.settings, ...st }),
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
        act: g.campaign.state.act,
        objectives: g.campaign.objectives().map((o) => `${o.done ? '[x]' : '[ ]'} ${o.text}`),
        gameOver: g.campaign.state.gameOver?.kind ?? null,
        won: g.campaign.state.won,
        achievements: g.campaign.state.achievements,
        draws: g.renderer.info.render.calls,
        triangles: g.renderer.info.render.triangles,
        cpuMs: +g.cpuMs.toFixed(2),
      }),
    };
  }
}

const app = document.getElementById('app')!;
new Game(app).init().catch((err) => {
  console.error(err);
  app.insertAdjacentHTML('beforeend', `<pre style="position:fixed;inset:20px;color:#f88">${String(err)}</pre>`);
});
