/**
 * Static batching: merge meshes that never move into one mesh per material per map chunk.
 *
 * Town and plant buildings are hundreds of small boxes, many with a different material per
 * face. Splitting those by face material and merging everything that shares a material cuts
 * draw calls several-fold, while chunking keeps frustum culling useful. Animated lights
 * still work because they animate their material, not the mesh.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const CHUNK = 220;

interface Part {
  geo: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
}

/** Non-indexed copy with exactly position + normal + uv, so any two can be merged. */
function normalised(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = g.index ? g.toNonIndexed() : g.clone();
  for (const name of Object.keys(out.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') out.deleteAttribute(name);
  }
  if (!out.attributes.normal) out.computeVertexNormals();
  if (!out.attributes.uv) {
    out.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(out.attributes.position.count * 2), 2));
  }
  out.morphAttributes = {};
  return out;
}

/** Vertices [start, start + count) of a non-indexed geometry. */
function slice(g: THREE.BufferGeometry, start: number, count: number): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes) as Array<[string, THREE.BufferAttribute]>) {
    const n = attr.itemSize;
    out.setAttribute(name, new THREE.Float32BufferAttribute((attr.array as Float32Array).slice(start * n, (start + count) * n), n));
  }
  return out;
}

/**
 * Merge eligible meshes under `root`. `keep` lists objects (and their subtrees) that must
 * stay separate: raycast targets, anything that moves, toggles visibility or changes shape.
 */
export function batchStatic(root: THREE.Object3D, keep: Iterable<THREE.Object3D>): { before: number; after: number } {
  root.updateMatrixWorld(true);
  const rootInv = root.matrixWorld.clone().invert();
  const skip = new Set<THREE.Object3D>();
  for (const k of keep) k.traverse((o) => skip.add(o));

  const groups = new Map<string, { mat: THREE.Material; cast: boolean; receive: boolean; parts: Part[] }>();
  const merged: THREE.Mesh[] = [];
  const add = (mat: THREE.Material, mesh: THREE.Mesh, geo: THREE.BufferGeometry, cx: number, cz: number) => {
    const key = `${mat.uuid}|${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}|${Math.floor(cx / CHUNK)},${Math.floor(cz / CHUNK)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { mat, cast: mesh.castShadow, receive: mesh.receiveShadow, parts: [] }));
    g.parts.push({ geo, matrix: new THREE.Matrix4().multiplyMatrices(rootInv, mesh.matrixWorld) });
  };
  const usable = (m: THREE.Material) => !(m.transparent && !m.depthWrite);

  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (mesh as unknown as THREE.InstancedMesh).isInstancedMesh) return;
    if (skip.has(mesh) || mesh.userData.dynamic || !mesh.visible) return;
    for (let p = mesh.parent; p && p !== root; p = p.parent) if (skip.has(p) || p.userData.dynamic || !p.visible) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (!mats.every(usable)) return;
    // Vertex colours or other extra attributes (terrain, roads) can't share a merged buffer.
    if (Object.keys(mesh.geometry.attributes).some((n) => n !== 'position' && n !== 'normal' && n !== 'uv')) return;
    mesh.geometry.computeBoundingSphere();
    const c = mesh.geometry.boundingSphere!.center.clone().applyMatrix4(mesh.matrixWorld);
    const geo = normalised(mesh.geometry);
    if (Array.isArray(mesh.material)) {
      // One part per face-material group (toNonIndexed keeps index order, so ranges carry over).
      const groupsOf = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: geo.attributes.position.count, materialIndex: 0 }];
      for (const gr of groupsOf) {
        const mat = mesh.material[gr.materialIndex ?? 0];
        if (mat) add(mat, mesh, slice(geo, gr.start, Math.min(gr.count, geo.attributes.position.count - gr.start)), c.x, c.z);
      }
      geo.dispose();
    } else {
      add(mesh.material, mesh, geo, c.x, c.z);
    }
    merged.push(mesh);
  });

  let after = 0;
  for (const g of groups.values()) {
    const geos = g.parts.map((p) => p.geo.applyMatrix4(p.matrix));
    const geo = mergeGeometries(geos, false);
    for (const x of geos) x.dispose();
    if (!geo) throw new Error('batchStatic: could not merge geometry');
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    const mesh = new THREE.Mesh(geo, g.mat);
    mesh.castShadow = g.cast;
    mesh.receiveShadow = g.receive;
    mesh.name = 'batched';
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    after++;
  }
  for (const m of merged) m.removeFromParent();
  return { before: merged.length, after };
}
