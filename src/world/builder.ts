/**
 * Helpers for placing static world geometry. Each helper adds the mesh,
 * its collider and (optionally) a footprint for the map in one call.
 */
import * as THREE from 'three';
import type { CollisionWorld } from './collision';
import type { Heightfield } from './heightfield';
import type { Materials } from './materials';
import type { FieldPointId } from './layout';

export type MapFeature =
  | { kind: 'rect'; minX: number; minZ: number; maxX: number; maxZ: number; color: string }
  | { kind: 'circle'; x: number; z: number; r: number; color: string };

export interface PlaceOpts {
  collide?: boolean;
  /** Map colour for the footprint, or false to leave it off the map. */
  map?: string | false;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

export type DoorSide = 'n' | 's' | 'e' | 'w';

const MAP_BUILDING = '#4b4f55';

/** Box geometry whose UVs are in metres, so tiling textures keep a constant scale. */
export function makeBoxGeometry(w: number, h: number, d: number): THREE.BoxGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  // Face order: +x, -x, +y, -y, +z, -z (4 verts each).
  const dims: Array<[number, number]> = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
  for (let f = 0; f < 6; f++) {
    for (let k = 0; k < 4; k++) {
      const i = f * 4 + k;
      uv.setXY(i, uv.getX(i) * dims[f][0], uv.getY(i) * dims[f][1]);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/** Triangular-prism roof with its ridge along X; base at y=0. */
function gableGeometry(w: number, d: number, rise: number): THREE.BufferGeometry {
  const hw = w / 2;
  const hd = d / 2;
  const A = [-hw, 0, -hd], B = [hw, 0, -hd], C = [hw, 0, hd], D = [-hw, 0, hd];
  const E = [-hw, rise, 0], F = [hw, rise, 0];
  const tris = [A, E, F, A, F, B, D, C, F, D, F, E, A, D, E, B, F, C];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}

export class WorldBuilder {
  readonly features: MapFeature[] = [];
  /** Meshes of repairable field equipment (raycast targets). */
  readonly fieldMeshes: THREE.Object3D[] = [];
  /** Amber beacon on each piece of field equipment; flashes while it has a fault. */
  readonly fieldBeacons = new Map<FieldPointId, THREE.MeshStandardMaterial>();

  /** Put a small fault beacon at a position. */
  beacon(point: FieldPointId, x: number, y: number, z: number): void {
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a2a10, emissive: 0xffa020, emissiveIntensity: 0 });
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), mat);
    m.position.set(x, y, z);
    this.root.add(m);
    this.fieldBeacons.set(point, mat);
  }
  /** Lit window materials per light group (e.g. "town:3"), so feeders can go dark independently. */
  readonly lightGroups = new Map<string, THREE.MeshStandardMaterial[]>();
  private lightGroup: string | null = null;
  private readonly clones = new Map<string, THREE.MeshStandardMaterial>();

  constructor(
    readonly root: THREE.Object3D,
    readonly hf: Heightfield,
    readonly collision: CollisionWorld,
    readonly mats: Materials,
  ) {}

  groundY(x: number, z: number): number {
    return this.hf.heightAt(x, z);
  }

  /** Mark an object as a piece of repairable field equipment. */
  fieldPoint(point: FieldPointId, obj: THREE.Object3D): void {
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.userData.interact = { kind: 'field', point };
        this.fieldMeshes.push(o);
      }
    });
  }

  /**
   * A small equipment cabinet standing on the ground, registered as a field point.
   * `facing` is the yaw of its front (which way someone using it looks, reversed).
   */
  cabinet(point: FieldPointId, x: number, z: number, w = 1.2, h = 1.9, d = 0.6, baseY?: number): THREE.Mesh {
    const y = baseY ?? this.groundY(x, z);
    const mesh = this.box(x - w / 2, y - 0.2, z - d / 2, x + w / 2, y + h, z + d / 2,
      [this.mats.metal, this.mats.metal, this.mats.metalDark, this.mats.metalDark, this.mats.safetyYellow, this.mats.safetyYellow],
      { map: false });
    this.fieldPoint(point, mesh);
    this.beacon(point, x, y + h + 0.2, z);
    return mesh;
  }

  /** Buildings placed after this call get their own copies of lit window materials. null = always lit. */
  setLightGroup(group: string | null): void {
    this.lightGroup = group;
  }

  private groupMat(m: THREE.Material): THREE.Material {
    const g = this.lightGroup;
    if (!g || !this.mats.litMaterials.includes(m as THREE.MeshStandardMaterial)) return m;
    const key = `${g}|${m.uuid}`;
    let c = this.clones.get(key);
    if (!c) {
      c = (m as THREE.MeshStandardMaterial).clone();
      this.clones.set(key, c);
      let list = this.lightGroups.get(g);
      if (!list) this.lightGroups.set(g, (list = []));
      list.push(c);
    }
    return c;
  }

  private finish(mesh: THREE.Mesh, opts: PlaceOpts): THREE.Mesh {
    mesh.castShadow = opts.castShadow ?? true;
    mesh.receiveShadow = opts.receiveShadow ?? true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.root.add(mesh);
    return mesh;
  }

  box(
    minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number,
    mat: THREE.Material | THREE.Material[], opts: PlaceOpts = {},
  ): THREE.Mesh {
    const w = maxX - minX;
    const h = maxY - minY;
    const d = maxZ - minZ;
    const material = Array.isArray(mat) ? mat.map((m) => this.groupMat(m)) : this.groupMat(mat);
    const mesh = new THREE.Mesh(makeBoxGeometry(w, h, d), material);
    mesh.position.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    if (opts.collide ?? true) this.collision.addBox(minX, minY, minZ, maxX, maxY, maxZ);
    const mapColor = opts.map ?? (w * d >= 30 ? MAP_BUILDING : false);
    if (mapColor) this.features.push({ kind: 'rect', minX, minZ, maxX, maxZ, color: mapColor });
    return this.finish(mesh, opts);
  }

  cylinder(
    x: number, z: number, r: number, y0: number, y1: number, mat: THREE.Material,
    opts: PlaceOpts & { segments?: number; rTop?: number } = {},
  ): THREE.Mesh {
    const geo = new THREE.CylinderGeometry(opts.rTop ?? r, r, y1 - y0, opts.segments ?? 20);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, (y0 + y1) / 2, z);
    if (opts.collide ?? true) this.collision.addCyl(x, z, Math.max(r, opts.rTop ?? r), y0, y1);
    const mapColor = opts.map ?? (r >= 3 ? MAP_BUILDING : false);
    if (mapColor) this.features.push({ kind: 'circle', x, z, r, color: mapColor });
    return this.finish(mesh, opts);
  }

  /** Solid building: walls with `wall` material, flat roof with `roof`. Returns the base Y. */
  building(
    cx: number, cz: number, w: number, d: number, h: number,
    wall: THREE.Material, roof: THREE.Material, opts: PlaceOpts & { baseY?: number } = {},
  ): number {
    const baseY = opts.baseY ?? this.groundY(cx, cz);
    // Sink slightly so the base never floats on gentle slopes.
    this.box(cx - w / 2, baseY - 1.5, cz - d / 2, cx + w / 2, baseY + h, cz + d / 2,
      [wall, wall, roof, roof, wall, wall], opts);
    return baseY;
  }

  gableRoof(cx: number, cz: number, w: number, d: number, y: number, rise: number, mat: THREE.Material, ridgeAlongX = true): void {
    const geo = ridgeAlongX ? gableGeometry(w, d, rise) : gableGeometry(d, w, rise);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(cx, y, cz);
    if (!ridgeAlongX) mesh.rotation.y = Math.PI / 2;
    this.collision.addBox(cx - w / 2, y, cz - d / 2, cx + w / 2, y + rise, cz + d / 2);
    this.finish(mesh, {});
  }

  /**
   * Building with an enterable interior: four walls (one with a doorway), floor and roof.
   * Returns the floor height.
   */
  hollow(
    cx: number, cz: number, w: number, d: number, h: number,
    wall: THREE.Material, roof: THREE.Material, floor: THREE.Material,
    door: { side: DoorSide; width: number; height: number; offset?: number },
    opts: { baseY?: number; light?: number } = {},
  ): number {
    const t = 0.4;
    const baseY = opts.baseY ?? this.groundY(cx, cz);
    const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
    const y0 = baseY - 1.5, yTop = baseY + h;
    const noMap: PlaceOpts = { map: false };

    const wallAlongX = (za: number, zb: number, hasDoor: boolean) => {
      if (!hasDoor) {
        this.box(x0, y0, za, x1, yTop, zb, wall, noMap);
        return;
      }
      const dc = cx + (door.offset ?? 0);
      const a = dc - door.width / 2, b = dc + door.width / 2;
      this.box(x0, y0, za, a, yTop, zb, wall, noMap);
      this.box(b, y0, za, x1, yTop, zb, wall, noMap);
      this.box(a, baseY + door.height, za, b, yTop, zb, wall, noMap);
    };
    const wallAlongZ = (xa: number, xb: number, hasDoor: boolean) => {
      const za = z0 + t, zb = z1 - t;
      if (!hasDoor) {
        this.box(xa, y0, za, xb, yTop, zb, wall, noMap);
        return;
      }
      const dc = cz + (door.offset ?? 0);
      const a = dc - door.width / 2, b = dc + door.width / 2;
      this.box(xa, y0, za, xb, yTop, a, wall, noMap);
      this.box(xa, y0, b, xb, yTop, zb, wall, noMap);
      this.box(xa, baseY + door.height, a, xb, yTop, b, wall, noMap);
    };

    wallAlongX(z0, z0 + t, door.side === 'n');
    wallAlongX(z1 - t, z1, door.side === 's');
    wallAlongZ(x0, x0 + t, door.side === 'w');
    wallAlongZ(x1 - t, x1, door.side === 'e');

    // Floor slab and roof.
    this.box(x0 + t, baseY - 0.3, z0 + t, x1 - t, baseY + 0.05, z1 - t, floor, { map: false, castShadow: false });
    this.box(x0, yTop, z0, x1, yTop + 0.5, z1, roof, { map: MAP_BUILDING });

    if (opts.light) {
      const lamp = new THREE.PointLight(0xfff1dd, opts.light, Math.max(w, d) * 1.4, 1.6);
      lamp.position.set(cx, baseY + h - 1, cz);
      this.root.add(lamp);
    }
    return baseY + 0.05;
  }
}
