import * as THREE from 'three';
import type { Heightfield } from './heightfield';
import { ROADS, type Road } from './layout';
import type { Materials } from './materials';

const SAMPLE = 3;
const LIFT = 0.12;

function appendRibbon(road: Road, hf: Heightfield, pos: number[], idx: number[], uv: number[]): void {
  // Resample the polyline at even spacing, keeping the corners.
  const pts: Array<[number, number]> = [];
  for (let s = 0; s < road.points.length - 1; s++) {
    const [ax, az] = road.points[s];
    const [bx, bz] = road.points[s + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(len / SAMPLE));
    for (let k = 0; k < steps; k++) pts.push([ax + ((bx - ax) * k) / steps, az + ((bz - az) * k) / steps]);
  }
  pts.push([...road.points[road.points.length - 1]] as [number, number]);

  const hw = road.width / 2;
  const base = pos.length / 3;
  let dist = 0;
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dz = next[1] - prev[1];
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    const px = -dz;
    const pz = dx;
    if (i > 0) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    for (const side of [-1, 0, 1]) {
      const x = pts[i][0] + px * hw * side;
      const z = pts[i][1] + pz * hw * side;
      pos.push(x, hf.heightAt(x, z) + LIFT, z);
      uv.push((side + 1) * 0.5, dist / road.width);
    }
  }
  for (let i = 0; i < pts.length - 1; i++) {
    for (let s = 0; s < 2; s++) {
      const a = base + i * 3 + s;
      const b = a + 1;
      const c = a + 3;
      const d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
}

export function buildRoads(hf: Heightfield, mats: Materials): THREE.Group {
  const group = new THREE.Group();
  group.name = 'roads';
  for (const kind of ['asphalt', 'dirt'] as const) {
    const pos: number[] = [];
    const idx: number[] = [];
    const uv: number[] = [];
    for (const r of ROADS) if (r.kind === kind) appendRibbon(r, hf, pos, idx, uv);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, kind === 'asphalt' ? mats.asphalt : mats.dirt);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}
