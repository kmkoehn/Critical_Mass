/** Terrain colouring, shared by the 3D mesh and the map. Pure. */
import { hash2, lerp, smoothstep } from '../util/math';
import type { Noise2D } from '../util/noise';
import { FARMLAND, INDUSTRIAL, PLANT, RIVER_HALF_WIDTH, TOWN, riverX } from './layout';
import { rectMask } from './heightfield';

export type RGB = [number, number, number];

const GRASS: RGB = [0.30, 0.45, 0.19];
const DRY_GRASS: RGB = [0.50, 0.52, 0.28];
const LAWN: RGB = [0.36, 0.52, 0.22];
const GRAVEL: RGB = [0.52, 0.52, 0.48];
const INDUSTRIAL_GROUND: RGB = [0.47, 0.45, 0.38];
const SAND: RGB = [0.60, 0.55, 0.40];
const MUD: RGB = [0.30, 0.28, 0.22];
const ROCK: RGB = [0.46, 0.44, 0.40];
const HEDGE: RGB = [0.20, 0.33, 0.14];
const CROPS: readonly RGB[] = [
  [0.74, 0.65, 0.33], // wheat
  [0.42, 0.60, 0.25], // young crop
  [0.45, 0.33, 0.22], // ploughed
  [0.30, 0.47, 0.20], // pasture
  [0.62, 0.60, 0.30], // hay
];

function mix(a: RGB, b: RGB, t: number): RGB {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function terrainColor(x: number, z: number, h: number, slope: number, n: Noise2D): RGB {
  const broad = n(x / 220, z / 220) * 0.5 + 0.5;
  const detail = n(x / 23, z / 23) * 0.6 + n(x / 6, z / 6) * 0.4;
  let c = mix(GRASS, DRY_GRASS, smoothstep(0.35, 0.85, broad));

  // Farmland patchwork.
  if (x > FARMLAND.minX && x < FARMLAND.maxX && z > FARMLAND.minZ && z < FARMLAND.maxZ) {
    const fx = (x - FARMLAND.minX) / 72;
    const fz = (z - FARMLAND.minZ) / 56;
    const cx = Math.floor(fx);
    const cz = Math.floor(fz);
    const edge = Math.min(fx - cx, 1 - (fx - cx), fz - cz, 1 - (fz - cz));
    const crop = CROPS[Math.floor(hash2(cx, cz, 7) * CROPS.length)];
    c = edge < 0.06 ? HEDGE : crop;
  }

  // Building pads.
  const plant = rectMask(x, z, PLANT, 12);
  if (plant > 0) c = mix(c, GRAVEL, plant);
  const town = rectMask(x, z, TOWN, 20);
  if (town > 0) c = mix(c, LAWN, town);
  const ind = rectMask(x, z, INDUSTRIAL, 15);
  if (ind > 0) c = mix(c, INDUSTRIAL_GROUND, ind);

  // Riverbanks.
  const d = Math.abs(x - riverX(z));
  if (d < RIVER_HALF_WIDTH + 10 || h < 1.8) {
    const t = 1 - smoothstep(RIVER_HALF_WIDTH + 2, RIVER_HALF_WIDTH + 10, d);
    c = mix(c, h < 0 ? MUD : SAND, Math.max(t, h < 1.8 ? 0.85 : 0));
  }

  // Rock on steep slopes and high peaks.
  const rock = Math.max(smoothstep(0.6, 1.05, slope), smoothstep(120, 175, h) * 0.85);
  if (rock > 0) c = mix(c, ROCK, rock);

  const v = 1 + detail * 0.09;
  return [c[0] * v, c[1] * v, c[2] * v];
}
