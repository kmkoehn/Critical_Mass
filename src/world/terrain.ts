import * as THREE from 'three';
import { createNoise2D } from '../util/noise';
import type { Heightfield } from './heightfield';
import { SEED, WATER_LEVEL } from './layout';
import type { Materials } from './materials';
import { terrainColor } from './terrainColor';

/** Terrain mesh built from the heightfield grid (same triangle split as Heightfield.heightAt). */
export function buildTerrain(hf: Heightfield, mats: Materials): THREE.Mesh {
  const n = hf.n;
  const n1 = n + 1;
  const pos = new Float32Array(n1 * n1 * 3);
  const col = new Float32Array(n1 * n1 * 3);
  const uv = new Float32Array(n1 * n1 * 2);
  const colorNoise = createNoise2D(SEED + 50);

  for (let j = 0; j < n1; j++) {
    for (let i = 0; i < n1; i++) {
      const k = j * n1 + i;
      const x = hf.origin + i * hf.cell;
      const z = hf.origin + j * hf.cell;
      const h = hf.vertex(i, j);
      pos[k * 3] = x;
      pos[k * 3 + 1] = h;
      pos[k * 3 + 2] = z;
      const c = terrainColor(x, z, h, hf.slopeAtVertex(i, j), colorNoise);
      col[k * 3] = c[0];
      col[k * 3 + 1] = c[1];
      col[k * 3 + 2] = c[2];
      uv[k * 2] = x / 7;
      uv[k * 2 + 1] = z / 7;
    }
  }

  const index = new Uint32Array(n * n * 6);
  let p = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v00 = j * n1 + i;
      const v10 = v00 + 1;
      const v01 = v00 + n1;
      const v11 = v01 + 1;
      index[p++] = v00; index[p++] = v01; index[p++] = v10;
      index[p++] = v10; index[p++] = v01; index[p++] = v11;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, map: mats.ground, roughness: 0.95 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** One big water plane at WATER_LEVEL; the terrain hides it everywhere except the river. */
export class Water {
  readonly mesh: THREE.Mesh;
  private readonly tex: THREE.Texture;

  constructor(mats: Materials) {
    this.tex = mats.waterNormal.clone();
    this.tex.wrapS = this.tex.wrapT = THREE.RepeatWrapping;
    this.tex.repeat.set(90, 90);
    this.tex.needsUpdate = true;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x2b5663,
      roughness: 0.1,
      metalness: 0.1,
      transparent: true,
      opacity: 0.86,
      normalMap: this.tex,
      normalScale: new THREE.Vector2(0.55, 0.55),
    });
    const geo = new THREE.PlaneGeometry(2400, 2400, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.y = WATER_LEVEL;
    this.mesh.receiveShadow = true;
    this.mesh.name = 'water';
  }

  update(dt: number): void {
    // River flows south (+Z).
    this.tex.offset.y -= dt * 0.035;
    this.tex.offset.x += dt * 0.004;
  }
}
