/** Millbrook: procedural town blocks, civic buildings, street lights and the river bridge. */
import * as THREE from 'three';
import type { WorldBuilder } from './builder';
import {
  BRIDGE, RIVER_HALF_WIDTH, SCHOOL, TOWN_GRID, TOWN_HALL, TOWN_STREETS_X, TOWN_STREETS_Z, WATER_LEVEL, riverX,
  townDistrictAt,
} from './layout';
import { Rng } from '../util/rng';

const MAX_BUILDINGS = 38;
const SETBACK = 7;

export interface TownHandles {
  buildingCount: number;
  /** Street-lamp bulb material per light group ("town:<district>"). */
  lampGroups: Map<string, THREE.MeshStandardMaterial>;
}

function overlapsCivic(x0: number, z0: number, x1: number, z1: number): boolean {
  const civic = [
    // Town hall: square on its north side.
    { x0: TOWN_HALL.cx - TOWN_HALL.w / 2 - 14, x1: TOWN_HALL.cx + TOWN_HALL.w / 2 + 14, z0: TOWN_HALL.cz - TOWN_HALL.d / 2 - 32, z1: TOWN_HALL.cz + TOWN_HALL.d / 2 + 10 },
    // School: sports field on its south side.
    { x0: SCHOOL.cx - SCHOOL.w / 2 - 14, x1: SCHOOL.cx + SCHOOL.w / 2 + 14, z0: SCHOOL.cz - SCHOOL.d / 2 - 14, z1: SCHOOL.cz + SCHOOL.d / 2 + 36 },
  ];
  return civic.some((c) => x1 > c.x0 && x0 < c.x1 && z1 > c.z0 && z0 < c.z1);
}

export function buildTown(b: WorldBuilder): TownHandles {
  const m = b.mats;
  const rng = new Rng(2024);

  // ---------------- bridge
  {
    const y = BRIDGE.deckTop;
    const hw = BRIDGE.halfWidth;
    b.box(BRIDGE.x0, y - 1.2, BRIDGE.z - hw, BRIDGE.x1, y, BRIDGE.z + hw, [m.concrete, m.concrete, m.asphalt, m.concrete, m.concrete, m.concrete],
      { map: '#55585c', castShadow: true });
    b.box(BRIDGE.x0, y, BRIDGE.z - hw, BRIDGE.x1, y + 1.1, BRIDGE.z - hw + 0.3, m.concrete, { map: false });
    b.box(BRIDGE.x0, y, BRIDGE.z + hw - 0.3, BRIDGE.x1, y + 1.1, BRIDGE.z + hw, m.concrete, { map: false });
    const rc = riverX(BRIDGE.z);
    for (const dx of [-RIVER_HALF_WIDTH * 0.55, 0, RIVER_HALF_WIDTH * 0.55]) {
      b.box(rc + dx - 1.2, WATER_LEVEL - 5, BRIDGE.z - hw + 1, rc + dx + 1.2, y - 1.2, BRIDGE.z + hw - 1, m.concreteDark, { map: false });
    }
    // Lamp posts on the bridge.
    for (let x = BRIDGE.x0 + 10; x < BRIDGE.x1; x += 25) {
      b.box(x - 0.1, y, BRIDGE.z - hw + 0.05, x + 0.1, y + 6, BRIDGE.z - hw + 0.25, m.metalDark, { map: false, collide: false });
    }
  }

  // ---------------- civic buildings
  {
    const t = TOWN_HALL;
    b.setLightGroup(`town:${townDistrictAt(t.cx, t.cz)}`);
    const base = b.building(t.cx, t.cz, t.w, t.d, t.h, m.shopWalls[1], m.roofDark);
    const front = t.cz - t.d / 2;
    // Portico columns on the north face, looking over the square to Main Street.
    for (let i = 0; i < 6; i++) {
      b.cylinder(t.cx - 12.5 + i * 5, front - 3, 0.6, base, base + 9, m.white, { segments: 12, map: false });
    }
    b.box(t.cx - 14, base + 9, front - 4, t.cx + 14, base + 10, front, m.white, { map: false, collide: false });
    // Clock tower and flagpole.
    b.box(t.cx - 3, base + t.h, t.cz - 3, t.cx + 3, base + t.h + 9, t.cz + 3, m.shopWalls[1], { map: false });
    b.box(t.cx - 3.4, base + t.h + 9, t.cz - 3.4, t.cx + 3.4, base + t.h + 9.6, t.cz + 3.4, m.roofDark, { map: false });
    b.cylinder(t.cx + 16, front - 20, 0.15, base, base + 14, m.metal, { segments: 8, map: false });
    // Town square paving.
    b.box(t.cx - 22, base - 0.2, front - 28, t.cx + 22, base + 0.06, front, m.concrete,
      { collide: false, map: '#8d8c86', castShadow: false });
  }
  {
    const s = SCHOOL;
    b.setLightGroup(`town:${townDistrictAt(s.cx, s.cz)}`);
    const base = b.building(s.cx, s.cz, s.w, s.d, s.h, m.shopWalls[0], m.roofDark);
    b.building(s.cx + s.w / 2 - 8, s.cz + s.d / 2 + 10, 16, 20, s.h - 2, m.shopWalls[0], m.roofDark, { baseY: base });
    // Sports field.
    b.box(s.cx - 30, base - 0.1, s.cz + s.d / 2 + 4, s.cx + 8, base + 0.04, s.cz + s.d / 2 + 34, m.field,
      { collide: false, map: '#4f8a3a', castShadow: false });
  }

  // ---------------- residential and commercial blocks
  const xs = [TOWN_GRID.minX, ...TOWN_STREETS_X];
  const zs = [TOWN_GRID.minZ, ...TOWN_STREETS_Z.filter((z) => z < 0), 0, ...TOWN_STREETS_Z.filter((z) => z > 0)];
  let count = 0;
  const lots: Array<{ x0: number; x1: number; z0: number; z1: number; front: 'n' | 's'; downtown: boolean }> = [];
  for (let bi = 0; bi < xs.length - 1; bi++) {
    for (let bj = 0; bj < zs.length - 1; bj++) {
      const bx0 = xs[bi] + SETBACK, bx1 = xs[bi + 1] - SETBACK;
      const bz0 = zs[bj] + SETBACK, bz1 = zs[bj + 1] - SETBACK;
      const lotW = 22;
      const nLots = Math.max(1, Math.floor((bx1 - bx0) / lotW));
      const w = (bx1 - bx0) / nLots;
      for (let k = 0; k < nLots; k++) {
        const x0 = bx0 + k * w, x1 = x0 + w;
        // A row along each long edge of the block.
        lots.push({ x0, x1, z0: bz0, z1: bz0 + 18, front: 'n', downtown: zs[bj] === 0 });
        lots.push({ x0, x1, z0: bz1 - 18, z1: bz1, front: 's', downtown: zs[bj + 1] === 0 });
      }
    }
  }
  // Shuffle deterministically, then place until the cap.
  for (let i = lots.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [lots[i], lots[j]] = [lots[j], lots[i]];
  }
  // Downtown lots first so Main Street is built up.
  lots.sort((a, b2) => Number(b2.downtown) - Number(a.downtown));
  for (const lot of lots) {
    if (count >= MAX_BUILDINGS) break;
    if (overlapsCivic(lot.x0, lot.z0, lot.x1, lot.z1)) continue;
    if (!lot.downtown && !rng.chance(0.55)) continue;
    const w = Math.min(lot.x1 - lot.x0 - 3, rng.float(11, 18));
    const d = rng.float(10, 15);
    const cx = (lot.x0 + lot.x1) / 2 + rng.float(-1, 1);
    const cz = lot.front === 'n' ? lot.z0 + d / 2 + 1 : lot.z1 - d / 2 - 1;
    b.setLightGroup(`town:${townDistrictAt(cx, cz)}`);
    if (lot.downtown) {
      const h = rng.float(10, 21);
      b.building(cx, cz, w + 3, d, h, rng.pick(m.shopWalls), m.roofDark);
    } else {
      const h = rng.float(5.5, 7.5);
      const base = b.building(cx, cz, w, d, h, rng.pick(m.houseWalls), m.roofDark);
      b.gableRoof(cx, cz, w + 1, d + 1, base + h, rng.float(2.5, 4), rng.chance(0.5) ? m.roofRed : m.roofDark, rng.chance(0.5));
    }
    count++;
  }

  // ---------------- street lights (instanced)
  const lamps: Array<[number, number]> = [];
  for (let x = BRIDGE.x1 + 8; x < 325; x += 30) {
    lamps.push([x, -6.5], [x + 15, 6.5]);
  }
  for (const sx of TOWN_STREETS_X) {
    for (let z = TOWN_GRID.minZ + 10; z < TOWN_GRID.maxZ; z += 34) if (Math.abs(z) > 10) lamps.push([sx + 5.5, z]);
  }
  b.setLightGroup(null);
  const poleGeo = new THREE.CylinderGeometry(0.1, 0.14, 6, 6);
  poleGeo.translate(0, 3, 0);
  const bulbGeo = new THREE.SphereGeometry(0.35, 8, 6);
  const poles = new THREE.InstancedMesh(poleGeo, m.metalDark, lamps.length);
  const mtx = new THREE.Matrix4();
  // One bulb mesh (and material) per district, so each district's lamps go dark with its feeder.
  const byDistrict = new Map<number, Array<[number, number, number]>>();
  lamps.forEach(([x, z], i) => {
    const y = b.groundY(x, z);
    mtx.makeTranslation(x, y, z);
    poles.setMatrixAt(i, mtx);
    b.collision.addCyl(x, z, 0.15, y, y + 6);
    const d = townDistrictAt(x, z);
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d)!.push([x, y + 6, z]);
  });
  poles.castShadow = true;
  b.root.add(poles);
  const lampGroups = new Map<string, THREE.MeshStandardMaterial>();
  for (const [d, list] of byDistrict) {
    const mat = m.bulb.clone();
    const bulbs = new THREE.InstancedMesh(bulbGeo, mat, list.length);
    list.forEach(([x, y, z], i) => bulbs.setMatrixAt(i, mtx.makeTranslation(x, y, z)));
    b.root.add(bulbs);
    lampGroups.set(`town:${d}`, mat);
  }

  return { buildingCount: count, lampGroups };
}
