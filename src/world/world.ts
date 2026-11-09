/** Assembles the whole static world and owns its per-frame animation. */
import * as THREE from 'three';
import { WorldBuilder, type MapFeature } from './builder';
import { CollisionWorld } from './collision';
import { buildCountryside } from './countryside';
import { Heightfield } from './heightfield';
import { createMaterials, type Materials } from './materials';
import { buildPlant, type SteamPlume } from './plant';
import { buildRoads } from './roads';
import { buildTerrain, Water } from './terrain';
import { buildTown } from './town';

export class World {
  readonly root = new THREE.Group();
  readonly hf = new Heightfield();
  readonly collision = new CollisionWorld();
  readonly mats: Materials = createMaterials();
  readonly features: MapFeature[];
  readonly lookoutDeckY: number;
  readonly stats: { buildings: number; trees: number; colliders: number };
  private readonly water: Water;
  private readonly plumes: SteamPlume[];
  private readonly bulbMat: THREE.MeshStandardMaterial;

  constructor(scene: THREE.Scene) {
    this.root.name = 'world';
    scene.add(this.root);
    this.root.add(buildTerrain(this.hf, this.mats));
    this.water = new Water(this.mats);
    this.root.add(this.water.mesh);
    this.root.add(buildRoads(this.hf, this.mats));

    const b = new WorldBuilder(this.root, this.hf, this.collision, this.mats);
    const plant = buildPlant(b);
    const town = buildTown(b);
    const country = buildCountryside(b);
    this.features = b.features;
    this.plumes = plant.plumes;
    this.lookoutDeckY = country.deckY;
    this.bulbMat = town.streetLightBulbs.material as THREE.MeshStandardMaterial;
    this.stats = { buildings: town.buildingCount, trees: country.trees, colliders: this.collision.count };
  }

  update(dt: number, daylight: number, night: number): void {
    this.water.update(dt);
    for (const p of this.plumes) {
      p.setLight(daylight);
      p.update(dt);
    }
    const glow = night * 0.8;
    for (const m of this.mats.litMaterials) m.emissiveIntensity = glow;
    this.bulbMat.emissiveIntensity = night * 3;
  }
}
