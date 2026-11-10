/** Forests, farms, Lookout Hill tower and the industrial park blockout. */
import * as THREE from 'three';
import type { WorldBuilder } from './builder';
import {
  FARMLAND, FLAT_ZONES, INDUSTRIAL, LOOKOUT, RIVER_HALF_WIDTH, SEED, WORLD_LIMIT, distanceToRoads, inRect, riverDistance,
} from './layout';
import { Rng } from '../util/rng';
import { createNoise2D } from '../util/noise';
import { smoothstep } from '../util/math';

export interface LookoutHandles {
  deckY: number;
}

function treeDensity(x: number, z: number, n: (x: number, y: number) => number): number {
  const base = n(x / 160, z / 160) * 0.5 + 0.5;
  let d = 0.12 + base * 0.25;
  if (z < -300) d += 0.55; // North Woods
  if (x < -700) d += 0.5; // West Woods
  d += smoothstep(600, 850, Math.max(Math.abs(x), Math.abs(z))) * 0.3;
  return d;
}

function buildTrees(b: WorldBuilder): number {
  const rng = new Rng(SEED + 9);
  const n = createNoise2D(SEED + 9);
  const spots: Array<[number, number, number, number]> = [];
  const target = 3800;
  for (let attempt = 0; attempt < 40000 && spots.length < target; attempt++) {
    const x = rng.float(-WORLD_LIMIT, WORLD_LIMIT);
    const z = rng.float(-WORLD_LIMIT, WORLD_LIMIT);
    if (rng.float() > treeDensity(x, z, n)) continue;
    if (FLAT_ZONES.some((zone) => inRect(x, z, zone, 25))) continue;
    if (x > FARMLAND.minX - 5 && x < FARMLAND.maxX + 5 && z > FARMLAND.minZ - 5 && z < FARMLAND.maxZ + 5 && rng.float() > 0.04) continue;
    if (riverDistance(x, z) < RIVER_HALF_WIDTH + 14) continue;
    if (Math.hypot(x - LOOKOUT.x, z - LOOKOUT.z) < 45) continue;
    if (distanceToRoads(x, z) < 6) continue;
    const y = b.groundY(x, z);
    if (y > 150 || b.hf.slopeAt(x, z) > 1.1) continue;
    spots.push([x, y, z, rng.float(0.75, 1.35)]);
  }

  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.32, 3, 5);
  trunkGeo.translate(0, 1.5, 0);
  const pineGeo = new THREE.ConeGeometry(2.6, 9, 7);
  pineGeo.translate(0, 7, 0);
  const leafGeo = new THREE.IcosahedronGeometry(3.2, 0);
  leafGeo.translate(0, 5.2, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4330, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, flatShading: true });

  // Trees are instanced per map cell, so whole cells outside the view (or the shadow camera)
  // are culled instead of drawing every tree in the valley every frame.
  const CELL = 500;
  const cells = new Map<string, Array<{ spot: [number, number, number, number]; i: number }>>();
  spots.forEach((spot, i) => {
    const key = `${Math.floor(spot[0] / CELL)},${Math.floor(spot[2] / CELL)}`;
    let list = cells.get(key);
    if (!list) cells.set(key, (list = []));
    list.push({ spot, i });
  });
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);

  for (const list of cells.values()) {
    // Same 1-in-3 mix of broadleaf and pine as before, keyed on the global index.
    const pines = list.filter(({ i }) => i % 3 !== 0);
    const broad = list.filter(({ i }) => i % 3 === 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    const pineMesh = new THREE.InstancedMesh(pineGeo, leafMat, Math.max(1, pines.length));
    const broadMesh = new THREE.InstancedMesh(leafGeo, leafMat, Math.max(1, broad.length));
    pineMesh.count = pines.length;
    broadMesh.count = broad.length;
    list.forEach(({ spot: [x, y, z, sc], i }, k) => {
      q.setFromAxisAngle(up, (i * 2.399) % (Math.PI * 2));
      mtx.compose(p.set(x, y - 0.3, z), q, s.set(sc, sc, sc));
      trunks.setMatrixAt(k, mtx);
      b.collision.addCyl(x, z, 0.35 * sc, y - 1, y + 9 * sc);
    });
    pines.forEach(({ spot: [x, y, z, sc], i }, k) => {
      const j = Math.floor((i * 2) / 3);
      q.setFromAxisAngle(up, j * 1.7);
      mtx.compose(p.set(x, y - 0.3, z), q, s.set(sc, sc * (0.9 + (j % 5) * 0.06), sc));
      pineMesh.setMatrixAt(k, mtx);
      pineMesh.setColorAt(k, color.setHSL(0.30 + (j % 7) * 0.008, 0.38, 0.17 + (j % 5) * 0.015));
    });
    broad.forEach(({ spot: [x, y, z, sc], i }, k) => {
      const j = i / 3;
      q.setFromAxisAngle(up, j * 0.9);
      mtx.compose(p.set(x, y - 0.3, z), q, s.set(sc * 1.1, sc, sc * 1.1));
      broadMesh.setMatrixAt(k, mtx);
      broadMesh.setColorAt(k, color.setHSL(0.22 + (j % 9) * 0.01, 0.42, 0.24 + (j % 4) * 0.02));
    });
    for (const mesh of [trunks, pineMesh, broadMesh]) {
      if (mesh.count === 0) continue;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      b.root.add(mesh);
    }
  }
  return spots.length;
}

function buildFarm(b: WorldBuilder, x: number, z: number, rot: boolean): void {
  const m = b.mats;
  const base = b.groundY(x, z);
  // Barn with a gable roof, farmhouse, silo.
  const bw = rot ? 14 : 22, bd = rot ? 22 : 14;
  b.building(x, z, bw, bd, 7, m.barnRed, m.roofDark, { baseY: base });
  b.gableRoof(x, z, bw + 1, bd + 1, base + 7, 5, m.roofDark, !rot);
  const hx = x + (rot ? 20 : 0), hz = z + (rot ? 0 : 22);
  const hb = b.groundY(hx, hz);
  b.building(hx, hz, 11, 9, 5.5, m.houseWalls[0], m.roofDark, { baseY: hb });
  b.gableRoof(hx, hz, 12, 10, hb + 5.5, 3, m.roofRed, true);
  b.cylinder(x - (rot ? 0 : 16), z - (rot ? 16 : 0), 3.2, base - 1, base + 15, m.metal, { segments: 16 });
}

function buildLookout(b: WorldBuilder): LookoutHandles {
  const m = b.mats;
  const cx = LOOKOUT.x, cz = LOOKOUT.z;
  const ground = b.groundY(cx, cz);
  const deckY = ground + 6;
  const half = 4;
  // Posts.
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    b.box(cx + dx * half - 0.25 * (dx + 1), ground - 3, cz + dz * half - 0.25 * (dz + 1),
      cx + dx * half - 0.25 * (dx - 1), deckY, cz + dz * half - 0.25 * (dz - 1), m.wood, { map: false });
  }
  // Deck.
  b.box(cx - half, deckY - 0.3, cz - half, cx + half, deckY, cz + half, m.wood, { map: '#7a5a3a' });
  // Stairs climbing toward +X onto the west edge of the deck.
  const steps = 15;
  const run = 0.55;
  const sx = cx - half - steps * run;
  // Start the flight from whichever is lower, so the first step is never too tall.
  const stairBase = Math.min(ground, b.groundY(sx, cz - half + 0.7));
  const rise = (deckY - stairBase) / steps;
  for (let i = 1; i <= steps; i++) {
    const x0 = sx + (i - 1) * run;
    b.box(x0, stairBase - 3, cz - half, x0 + run, stairBase + i * rise, cz - half + 1.4, m.wood, { map: false });
  }
  // Railings (leave the stair landing open).
  // Open railings: two rails for looks, one solid invisible collider per side.
  const rail = (x0: number, z0: number, x1: number, z1: number) => {
    for (const [y0, y1] of [[1.0, 1.1], [0.5, 0.58]]) {
      b.box(x0, deckY + y0, z0, x1, deckY + y1, z1, m.wood, { map: false, collide: false });
    }
    b.collision.addBox(x0, deckY, z0, x1, deckY + 1.1, z1);
  };
  rail(cx - half, cz + half - 0.12, cx + half, cz + half);
  rail(cx + half - 0.12, cz - half, cx + half, cz + half);
  rail(cx - half, cz - half, cx + half, cz - half + 0.12);
  rail(cx - half, cz - half + 1.6, cx - half + 0.12, cz + half);
  // Roof.
  b.box(cx - half - 0.5, deckY + 3, cz - half - 0.5, cx + half + 0.5, deckY + 3.3, cz + half + 0.5, m.roofDark, { map: false, collide: false });
  // Telescope post.
  b.cylinder(cx + 2.5, cz + 2.5, 0.12, deckY, deckY + 1.2, m.metalDark, { segments: 8, map: false });
  return { deckY };
}

function buildIndustrial(b: WorldBuilder): void {
  const m = b.mats;
  const I = INDUSTRIAL;
  const base = b.groundY(I.cx, I.cz);
  b.setLightGroup('industrial:0');
  b.building(I.cx - 70, I.cz - 40, 70, 40, 14, m.industrialWalls, m.roofGrey, { baseY: base });
  b.setLightGroup('industrial:1');
  b.building(I.cx + 40, I.cz - 45, 60, 30, 12, m.industrialWalls, m.roofGrey, { baseY: base });
  b.setLightGroup('industrial:2');
  b.building(I.cx - 20, I.cz + 45, 90, 35, 18, m.industrialWalls, m.roofGrey, { baseY: base });
  b.setLightGroup(null);
  b.cylinder(I.cx + 85, I.cz + 40, 2.2, base, base + 45, m.concreteDark, { segments: 16, rTop: 1.6 });
  for (let i = 0; i < 3; i++) b.cylinder(I.cx + 70 + i * 16, I.cz - 5, 6, base, base + 12, m.metal, { segments: 24 });
  b.box(I.cx - 120, base - 0.2, I.cz - 10, I.cx + 120, base + 0.08, I.cz + 18, m.asphalt, { collide: false, map: '#3b3d40', castShadow: false });
}

export function buildCountryside(b: WorldBuilder): LookoutHandles & { trees: number } {
  b.setLightGroup('farmland:0');
  buildFarm(b, 600, 140, false);
  b.setLightGroup('farmland:1');
  buildFarm(b, 760, 340, true);
  b.setLightGroup('farmland:2');
  buildFarm(b, 560, 330, false);
  buildIndustrial(b);
  b.setLightGroup(null);
  const look = buildLookout(b);
  const trees = buildTrees(b);
  return { ...look, trees };
}
