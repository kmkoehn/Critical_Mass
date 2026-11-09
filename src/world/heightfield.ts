/**
 * Terrain height model. Pure (no Three.js), so tests and the sim can query it.
 * The rendered mesh uses exactly the same grid + triangle split, so
 * heightAt() matches what the player sees.
 */
import { clamp, lerp, smoothstep } from '../util/math';
import { createNoise2D, fbm } from '../util/noise';
import {
  BRIDGE, FLAT_ZONES, LOOKOUT, RIVER_BANK, RIVER_HALF_WIDTH, Rect, SEED, WORLD_HALF, riverX,
} from './layout';

export const GRID_SEGMENTS = 320;
export const CELL = (WORLD_HALF * 2) / GRID_SEGMENTS;
export const RIVER_BED = -4.5;

/** 1 inside the rect, smoothly falling to 0 at `falloff` metres outside it. */
export function rectMask(x: number, z: number, r: Rect, falloff: number): number {
  const dx = Math.max(0, Math.abs(x - r.cx) - r.hx);
  const dz = Math.max(0, Math.abs(z - r.cz) - r.hz);
  return 1 - smoothstep(0, falloff, Math.hypot(dx, dz));
}

export type HeightFn = (x: number, z: number) => number;

/** The analytic terrain function the grid is sampled from. */
export function createTerrainFunction(seed = SEED): HeightFn {
  const n1 = createNoise2D(seed);
  const n2 = createNoise2D(seed + 1);
  const n3 = createNoise2D(seed + 2);
  const twoSigma2 = 2 * LOOKOUT.sigma * LOOKOUT.sigma;

  return (x: number, z: number): number => {
    // Rolling base terrain.
    let h = 12 + 11 * fbm(n1, x / 450, z / 450, 4) + 3 * fbm(n2, x / 80, z / 80, 3);

    // Lookout Hill.
    const lx = x - LOOKOUT.x;
    const lz = z - LOOKOUT.z;
    h += LOOKOUT.height * Math.exp(-(lx * lx + lz * lz) / twoSigma2);

    // Mountains ringing the valley (natural world boundary).
    const edge = Math.max(Math.abs(x), Math.abs(z));
    h += smoothstep(650, 980, edge) * (90 + 50 * n3(x / 200, z / 200));

    // Flat building pads.
    for (const zone of FLAT_ZONES) {
      const m = rectMask(x, z, zone, zone.falloff);
      if (m > 0) h = lerp(h, zone.elev, m);
    }
    h = Math.max(h, 2.5);

    // River channel.
    const d = Math.abs(x - riverX(z));
    if (d < RIVER_HALF_WIDTH) {
      const t = d / RIVER_HALF_WIDTH;
      h = lerp(RIVER_BED, -0.6, t * t);
    } else if (d < RIVER_HALF_WIDTH + RIVER_BANK) {
      const t = (d - RIVER_HALF_WIDTH) / RIVER_BANK;
      h = lerp(-0.6, h, smoothstep(0, 1, t));
    }

    // Bridge abutments: terrain meets the deck level on both banks.
    if (d >= RIVER_HALF_WIDTH && x > BRIDGE.x0 - 62 && x < BRIDGE.x1 + 30) {
      const dz = Math.abs(z - BRIDGE.z);
      if (dz < BRIDGE.flatHalfZ + 14) {
        const mz = 1 - smoothstep(BRIDGE.flatHalfZ, BRIDGE.flatHalfZ + 14, dz);
        h = lerp(h, BRIDGE.deckTop - 0.3, mz);
      }
    }
    return h;
  };
}

export class Heightfield {
  readonly n = GRID_SEGMENTS;
  readonly cell = CELL;
  readonly origin = -WORLD_HALF;
  readonly heights: Float32Array;

  constructor(fn: HeightFn = createTerrainFunction()) {
    const n1 = this.n + 1;
    this.heights = new Float32Array(n1 * n1);
    for (let j = 0; j < n1; j++) {
      const z = this.origin + j * this.cell;
      for (let i = 0; i < n1; i++) {
        this.heights[j * n1 + i] = fn(this.origin + i * this.cell, z);
      }
    }
  }

  vertex(i: number, j: number): number {
    const n1 = this.n + 1;
    return this.heights[clamp(j, 0, this.n) * n1 + clamp(i, 0, this.n)];
  }

  /**
   * Height of the rendered surface. Cells are split along the (i+1,j)-(i,j+1)
   * diagonal, matching the terrain mesh index buffer.
   */
  heightAt(x: number, z: number): number {
    const gx = clamp((x - this.origin) / this.cell, 0, this.n - 1e-6);
    const gz = clamp((z - this.origin) / this.cell, 0, this.n - 1e-6);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const h00 = this.vertex(i, j);
    const h10 = this.vertex(i + 1, j);
    const h01 = this.vertex(i, j + 1);
    const h11 = this.vertex(i + 1, j + 1);
    if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
    return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
  }

  /** Gradient magnitude (rise/run) at a grid vertex. */
  slopeAtVertex(i: number, j: number): number {
    const dx = (this.vertex(i + 1, j) - this.vertex(i - 1, j)) / (2 * this.cell);
    const dz = (this.vertex(i, j + 1) - this.vertex(i, j - 1)) / (2 * this.cell);
    return Math.hypot(dx, dz);
  }

  slopeAt(x: number, z: number): number {
    const e = this.cell;
    const dx = (this.heightAt(x + e, z) - this.heightAt(x - e, z)) / (2 * e);
    const dz = (this.heightAt(x, z + e) - this.heightAt(x, z - e)) / (2 * e);
    return Math.hypot(dx, dz);
  }
}
