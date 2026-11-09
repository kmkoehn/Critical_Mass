/** Assembles the whole static world and owns its per-frame animation. */
import * as THREE from 'three';
import { WorldBuilder, type MapFeature } from './builder';
import { CollisionWorld } from './collision';
import { buildControlRoom, type ControlRoomHandles } from './controlRoom';
import { buildCountryside } from './countryside';
import { buildFieldEquipment } from './fieldEquipment';
import { buildGridStructures } from './gridStructures';
import { Heightfield } from './heightfield';
import type { FieldPointId, SubstationId } from './layout';
import { createMaterials, type Materials } from './materials';
import { buildPlant, type SteamPlume } from './plant';
import { buildRoads } from './roads';
import { buildTerrain, Water } from './terrain';
import { buildTown } from './town';

export type SubstationLight = 'on' | 'out' | 'dead';

/** What the renderer needs to know about the electrical state each frame. */
export interface PowerView {
  /** Is a light group (e.g. "town:3", "industrial:0") energised? */
  groupPowered(group: string): boolean;
  substation(id: SubstationId): SubstationLight;
}

/** What the renderer needs to know about field faults each frame. */
export interface FaultView {
  /** Field points with an active fault (their beacons flash). */
  points: ReadonlySet<FieldPointId>;
  intakeClog: number;
}

export class World {
  readonly root = new THREE.Group();
  readonly hf = new Heightfield();
  readonly collision = new CollisionWorld();
  readonly mats: Materials = createMaterials();
  readonly features: MapFeature[];
  readonly lookoutDeckY: number;
  readonly controlRoom: ControlRoomHandles;
  /** Everything the crosshair can interact with: control-room panels and field equipment. */
  readonly interactables: THREE.Object3D[];
  readonly stats: { buildings: number; trees: number; colliders: number; towers: number };
  private readonly water: Water;
  private readonly plumes: SteamPlume[];
  private readonly lightGroups: Map<string, THREE.MeshStandardMaterial[]>;
  private readonly lampGroups: Map<string, THREE.MeshStandardMaterial>;
  private readonly beacons: Record<SubstationId, THREE.MeshStandardMaterial>;
  private readonly fieldBeacons: Map<FieldPointId, THREE.MeshStandardMaterial>;
  private readonly intakeDebris: THREE.Group;
  private readonly alwaysLit: THREE.MeshStandardMaterial[];
  private blink = 0;

  constructor(scene: THREE.Scene) {
    this.root.name = 'world';
    scene.add(this.root);
    this.root.add(buildTerrain(this.hf, this.mats));
    this.water = new Water(this.mats);
    this.root.add(this.water.mesh);
    this.root.add(buildRoads(this.hf, this.mats));

    const b = new WorldBuilder(this.root, this.hf, this.collision, this.mats);
    const plant = buildPlant(b);
    this.controlRoom = buildControlRoom(b, plant.controlRoomFloorY);
    const town = buildTown(b);
    const country = buildCountryside(b);
    const grid = buildGridStructures(b);
    const field = buildFieldEquipment(b);
    this.features = b.features;
    this.plumes = plant.plumes;
    this.lookoutDeckY = country.deckY;
    this.lightGroups = b.lightGroups;
    this.lampGroups = town.lampGroups;
    this.beacons = grid.beacons;
    this.fieldBeacons = b.fieldBeacons;
    this.intakeDebris = field.intakeDebris;
    this.interactables = [...this.controlRoom.interactables, ...b.fieldMeshes];
    // Base (un-grouped) lit materials are only used by the plant, which runs on station power.
    this.alwaysLit = this.mats.litMaterials;
    this.stats = { buildings: town.buildingCount, trees: country.trees, colliders: this.collision.count, towers: grid.towerCount };
  }

  /** `steam` 0..1: how hard the cooling towers are working (drives the plumes). */
  update(dt: number, daylight: number, night: number, steam: number, power: PowerView, faults: FaultView): void {
    this.water.update(dt);
    for (const p of this.plumes) {
      p.intensity += (steam - p.intensity) * (1 - Math.exp(-dt / 4));
      p.setLight(daylight);
      p.update(dt);
    }
    const glow = night * 0.8;
    for (const m of this.alwaysLit) m.emissiveIntensity = glow;
    for (const [group, mats] of this.lightGroups) {
      const v = power.groupPowered(group) ? glow : 0;
      for (const m of mats) m.emissiveIntensity = v;
    }
    for (const [group, mat] of this.lampGroups) mat.emissiveIntensity = power.groupPowered(group) ? night * 3 : 0;

    this.blink += dt;
    const on = Math.floor(this.blink * 1.5) % 2 === 0;
    for (const id of Object.keys(this.beacons) as SubstationId[]) {
      const st = power.substation(id);
      const m = this.beacons[id];
      m.emissive.setHex(st === 'on' ? 0x33ff66 : 0xff3322);
      m.emissiveIntensity = st === 'on' ? 2 : st === 'out' ? (on ? 3 : 0.2) : 0;
    }
    const fast = Math.floor(this.blink * 3) % 2 === 0;
    for (const [point, mat] of this.fieldBeacons) mat.emissiveIntensity = faults.points.has(point) ? (fast ? 4 : 0.3) : 0;
    this.intakeDebris.visible = faults.intakeClog > 0.05;
  }
}
