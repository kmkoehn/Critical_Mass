/** Transmission towers with sagging conductors, and the four substations. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WorldBuilder } from './builder';
import {
  POWER_LINES, RIVER_HALF_WIDTH, SUBSTATION_SITES, SWITCHYARD_POINT, distanceToRoads, riverDistance,
  type SubstationId,
} from './layout';

const SPACING = 115;
const TOWER_H = 28;
/** Conductor attachment points on a tower, in its local frame (x across the line). */
const PHASES: ReadonlyArray<readonly [number, number]> = [[-5.5, 24], [5.5, 24], [0, 28.6]];
/** Same, on the low gantries at the switchyard and substations. */
const GANTRY_PHASES: ReadonlyArray<readonly [number, number]> = [[-4, 13.5], [4, 13.5], [0, 13.5]];

export interface GridStructureHandles {
  /** Beacon material per substation: green = energised, red = out, dark = grid dead. */
  beacons: Record<SubstationId, THREE.MeshStandardMaterial>;
  towerCount: number;
}

interface Attach {
  x: number;
  y: number;
  z: number;
  yaw: number;
  gantry: boolean;
}

function towerGeometry(): { body: THREE.BufferGeometry; arms: THREE.BufferGeometry } {
  const body = new THREE.CylinderGeometry(0.7, 2.6, TOWER_H, 4, 1, true);
  body.rotateY(Math.PI / 4);
  body.translate(0, TOWER_H / 2, 0);
  // World-scaled UVs so the lattice texture tiles evenly.
  const uv = body.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 6, uv.getY(i) * TOWER_H);
  const top = new THREE.CylinderGeometry(0.15, 0.7, 4, 4, 1, true);
  top.rotateY(Math.PI / 4);
  top.translate(0, TOWER_H + 2, 0);
  const arm1 = new THREE.BoxGeometry(12.5, 0.45, 0.45);
  arm1.translate(0, 24, 0);
  const arm2 = new THREE.BoxGeometry(5, 0.35, 0.35);
  arm2.translate(0, 20, 0);
  return { body: mergeGeometries([body, top])!, arms: mergeGeometries([arm1, arm2])! };
}

export function buildGridStructures(b: WorldBuilder): GridStructureHandles {
  const m = b.mats;

  // ---------------------------------------------------------------- tower sites
  const towers: Attach[] = [];
  const spans: Array<[Attach, Attach]> = [];
  const gantryAt = (x: number, z: number, towardX: number, towardZ: number): Attach => ({
    x, z, y: b.groundY(x, z), yaw: Math.atan2(towardX - x, towardZ - z), gantry: true,
  });
  const junctions = new Map<string, Attach>();

  for (const line of POWER_LINES) {
    const pts = line.points;
    const chain: Attach[] = [];
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, az] = pts[s];
      const [bx, bz] = pts[s + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / SPACING));
      const yaw = Math.atan2(bx - ax, bz - az);
      for (let k = s === 0 ? 0 : 1; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n;
        const z = az + ((bz - az) * k) / n;
        const isStart = s === 0 && k === 0;
        const isEnd = s === pts.length - 2 && k === n;
        const key = `${Math.round(x)},${Math.round(z)}`;
        const isSite = (x === SWITCHYARD_POINT[0] && z === SWITCHYARD_POINT[1]) ||
          Object.values(SUBSTATION_SITES).some((ss) => ss.x === x && ss.z === z);
        if (isSite) {
          // Lines terminate on the low gantry inside the switchyard / substation.
          let g = junctions.get(key);
          if (!g) {
            g = isStart ? gantryAt(x, z, bx, bz) : gantryAt(x, z, ax, az);
            junctions.set(key, g);
          }
          chain.push(g);
          continue;
        }
        const existing = junctions.get(key);
        if (existing) {
          chain.push(existing);
          continue;
        }
        // Keep towers off roads and out of the river; the span simply gets longer.
        if (!isStart && !isEnd && (distanceToRoads(x, z) < 8 || riverDistance(x, z) < RIVER_HALF_WIDTH + 10)) continue;
        // Corner towers bisect the angle between spans.
        let ty = yaw;
        if (k === n && s < pts.length - 2) {
          const [cx, cz] = pts[s + 2];
          const yaw2 = Math.atan2(cx - bx, cz - bz);
          ty = Math.atan2(Math.sin(yaw) + Math.sin(yaw2), Math.cos(yaw) + Math.cos(yaw2));
        }
        const t: Attach = { x, z, y: b.groundY(x, z), yaw: ty, gantry: false };
        towers.push(t);
        junctions.set(key, t);
        chain.push(t);
      }
    }
    for (let i = 0; i < chain.length - 1; i++) spans.push([chain[i], chain[i + 1]]);
  }

  // ---------------------------------------------------------------- tower meshes
  const geo = towerGeometry();
  const body = new THREE.InstancedMesh(geo.body, m.fence, towers.length);
  const arms = new THREE.InstancedMesh(geo.arms, m.metal, towers.length);
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const pos = new THREE.Vector3();
  towers.forEach((t, i) => {
    q.setFromAxisAngle(up, t.yaw);
    mtx.compose(pos.set(t.x, t.y - 0.5, t.z), q, one);
    body.setMatrixAt(i, mtx);
    arms.setMatrixAt(i, mtx);
    b.collision.addCyl(t.x, t.z, 2.4, t.y - 1, t.y + 8);
  });
  body.castShadow = arms.castShadow = true;
  b.root.add(body, arms);

  // ---------------------------------------------------------------- conductors
  const verts: number[] = [];
  const attach = (a: Attach, phase: number): THREE.Vector3 => {
    const [ox, oy] = (a.gantry ? GANTRY_PHASES : PHASES)[phase];
    // Local +x after a yaw rotation is (cos yaw, 0, -sin yaw).
    return new THREE.Vector3(a.x + Math.cos(a.yaw) * ox, a.y + oy, a.z - Math.sin(a.yaw) * ox);
  };
  for (const [a, c] of spans) {
    for (let ph = 0; ph < 3; ph++) {
      const p0 = attach(a, ph);
      const p1 = attach(c, ph);
      const span = p0.distanceTo(p1);
      const sag = 0.035 * span;
      const segs = 14;
      let prev = p0;
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const p = new THREE.Vector3().lerpVectors(p0, p1, t);
        p.y -= sag * 4 * t * (1 - t);
        verts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
        prev = p;
      }
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  const wires = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x2a2d31 }));
  wires.frustumCulled = false;
  b.root.add(wires);

  // ---------------------------------------------------------------- substations
  const beacons = {} as Record<SubstationId, THREE.MeshStandardMaterial>;
  for (const id of Object.keys(SUBSTATION_SITES) as SubstationId[]) {
    const site = SUBSTATION_SITES[id];
    const base = b.groundY(site.x, site.z);
    const w = 34, d = 26;
    const x0 = site.x - w / 2, x1 = site.x + w / 2, z0 = site.z - d / 2, z1 = site.z + d / 2;
    b.box(x0, base - 1, z0, x1, base + 0.15, z1, m.concreteDark, { map: '#6a6e73', castShadow: false });
    const fy = base + 0.15;
    const fence = { map: false as const, castShadow: false };
    b.box(x0, fy, z0, x1, fy + 2.6, z0 + 0.1, m.fence, fence);
    b.box(x0, fy, z0, x0 + 0.1, fy + 2.6, z1, m.fence, fence);
    b.box(x1 - 0.1, fy, z0, x1, fy + 2.6, z1, m.fence, fence);
    b.box(x0, fy, z1 - 0.1, site.x - 3, fy + 2.6, z1, m.fence, fence);
    b.box(site.x + 3, fy, z1 - 0.1, x1, fy + 2.6, z1, m.fence, fence);
    for (const dx of [-8, 2]) b.box(site.x + dx - 2.5, fy, site.z - 6, site.x + dx + 2.5, fy + 4.2, site.z, m.transformer, { map: false });
    // Gantry.
    for (const dx of [-5, 5]) b.box(site.x + dx - 0.25, fy, site.z - 0.25, site.x + dx + 0.25, fy + 14, site.z + 0.25, m.metal, { map: false });
    b.box(site.x - 5.5, fy + 13.3, site.z - 0.3, site.x + 5.5, fy + 13.9, site.z + 0.3, m.metal, { map: false, collide: false });
    // Control hut with a status beacon on the roof.
    b.box(site.x + 9, fy, site.z + 4, site.x + 15, fy + 3.4, site.z + 9, m.officeWalls, { map: false });
    const beaconMat = new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0x33ff66, emissiveIntensity: 0 });
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.45, 12, 8), beaconMat);
    beacon.position.set(site.x + 12, fy + 3.9, site.z + 6.5);
    b.root.add(beacon);
    beacons[id] = beaconMat;
  }

  return { beacons, towerCount: towers.length };
}
