/**
 * Static collision world: axis-aligned boxes and vertical cylinders in a
 * spatial hash. The player is a vertical capsule approximated as a cylinder.
 * Pure (no Three.js).
 */
export interface BoxCollider {
  kind: 'box';
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}
export interface CylCollider {
  kind: 'cyl';
  x: number; z: number; r: number;
  minY: number; maxY: number;
}
export type Collider = BoxCollider | CylCollider;
export interface Vec3Like { x: number; y: number; z: number }

function boundsXZ(c: Collider): [number, number, number, number] {
  return c.kind === 'box'
    ? [c.minX, c.minZ, c.maxX, c.maxZ]
    : [c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r];
}

export function containsXZ(c: Collider, x: number, z: number): boolean {
  if (c.kind === 'box') return x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
  const dx = x - c.x;
  const dz = z - c.z;
  return dx * dx + dz * dz <= c.r * c.r;
}

export class CollisionWorld {
  private readonly cells = new Map<number, Collider[]>();
  private readonly scratch: Collider[] = [];
  private readonly seen = new Set<Collider>();
  count = 0;

  constructor(private readonly cellSize = 32) {}

  private key(ix: number, iz: number): number {
    return (ix + 2048) * 4096 + (iz + 2048);
  }

  add(c: Collider): Collider {
    const [x0, z0, x1, z1] = boundsXZ(c);
    const cs = this.cellSize;
    for (let ix = Math.floor(x0 / cs); ix <= Math.floor(x1 / cs); ix++) {
      for (let iz = Math.floor(z0 / cs); iz <= Math.floor(z1 / cs); iz++) {
        const k = this.key(ix, iz);
        let list = this.cells.get(k);
        if (!list) this.cells.set(k, (list = []));
        list.push(c);
      }
    }
    this.count++;
    return c;
  }

  addBox(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number): BoxCollider {
    return this.add({ kind: 'box', minX, minY, minZ, maxX, maxY, maxZ }) as BoxCollider;
  }

  addCyl(x: number, z: number, r: number, minY: number, maxY: number): CylCollider {
    return this.add({ kind: 'cyl', x, z, r, minY, maxY }) as CylCollider;
  }

  /** Colliders whose XZ bounds may overlap the query rect. The returned array is reused. */
  query(minX: number, minZ: number, maxX: number, maxZ: number): Collider[] {
    const out = this.scratch;
    out.length = 0;
    this.seen.clear();
    const cs = this.cellSize;
    for (let ix = Math.floor(minX / cs); ix <= Math.floor(maxX / cs); ix++) {
      for (let iz = Math.floor(minZ / cs); iz <= Math.floor(maxZ / cs); iz++) {
        const list = this.cells.get(this.key(ix, iz));
        if (!list) continue;
        for (const c of list) {
          if (!this.seen.has(c)) {
            this.seen.add(c);
            out.push(c);
          }
        }
      }
    }
    return out;
  }

  /**
   * Push a standing cylinder (feet at pos.y) out of anything it overlaps.
   * Obstacles no taller than `step` above the feet are ignored so they can be stepped onto.
   */
  resolve(pos: Vec3Like, radius: number, height: number, step: number): boolean {
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      const list = this.query(pos.x - radius, pos.z - radius, pos.x + radius, pos.z + radius);
      for (const c of list) {
        if (c.maxY <= pos.y + step || c.minY >= pos.y + height) continue;
        if (c.kind === 'box') {
          const cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
          const cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
          const dx = pos.x - cx;
          const dz = pos.z - cz;
          const d2 = dx * dx + dz * dz;
          if (d2 >= radius * radius) continue;
          hit = true;
          if (d2 > 1e-10) {
            const d = Math.sqrt(d2);
            const push = (radius - d) / d;
            pos.x += dx * push;
            pos.z += dz * push;
          } else {
            // Centre is inside the box: leave via the nearest face.
            const left = pos.x - c.minX;
            const right = c.maxX - pos.x;
            const back = pos.z - c.minZ;
            const front = c.maxZ - pos.z;
            const m = Math.min(left, right, back, front);
            if (m === left) pos.x = c.minX - radius;
            else if (m === right) pos.x = c.maxX + radius;
            else if (m === back) pos.z = c.minZ - radius;
            else pos.z = c.maxZ + radius;
          }
        } else {
          const dx = pos.x - c.x;
          const dz = pos.z - c.z;
          const minD = c.r + radius;
          const d2 = dx * dx + dz * dz;
          if (d2 >= minD * minD) continue;
          hit = true;
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            pos.x = c.x + (dx / d) * minD;
            pos.z = c.z + (dz / d) * minD;
          } else {
            pos.x = c.x + minD;
          }
        }
      }
      if (!hit) break;
    }
    return hit;
  }

  /** Highest walkable surface under (x,z) that the feet can reach (terrain or collider tops). */
  groundAt(x: number, z: number, feetY: number, step: number, terrain: number): number {
    let g = terrain;
    for (const c of this.query(x, z, x, z)) {
      if (c.maxY > g && c.maxY <= feetY + step && containsXZ(c, x, z)) g = c.maxY;
    }
    return g;
  }

  /** Lowest collider underside above the feet and below the head, or Infinity. */
  ceilingAt(x: number, z: number, feetY: number, height: number): number {
    let ceil = Infinity;
    for (const c of this.query(x, z, x, z)) {
      if (c.minY > feetY + 0.05 && c.minY < feetY + height && c.minY < ceil && containsXZ(c, x, z)) ceil = c.minY;
    }
    return ceil;
  }
}
