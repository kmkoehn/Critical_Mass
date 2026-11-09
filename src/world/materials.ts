/** Procedural textures and the shared material palette. */
import * as THREE from 'three';
import { Rng } from '../util/rng';

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function toTexture(c: HTMLCanvasElement, repeatU: number, repeatV: number, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatU, repeatV);
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Speckled noise, e.g. for concrete or ground grain. Values centred on `base`. */
function noiseCanvas(size: number, seed: number, base: number, spread: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(size, size);
  const img = g.createImageData(size, size);
  const rng = new Rng(seed);
  for (let i = 0; i < size * size; i++) {
    const v = Math.max(0, Math.min(255, (base + (rng.float() - 0.5) * spread) * 255));
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // Soften so it reads as grain, not static.
  g.globalAlpha = 0.5;
  g.drawImage(c, 1, 0);
  g.drawImage(c, 0, 1);
  return c;
}

export interface WindowStyle {
  /** Metres covered by one texture tile horizontally / vertically. */
  tileW: number;
  tileH: number;
  cols: number;
  rows: number;
  /** Window size as a fraction of its cell. */
  winW: number;
  winH: number;
  litChance: number;
  seed: number;
}

/** A wall texture with a grid of windows, plus a matching emissive map for lit windows at night. */
function windowTextures(style: WindowStyle): { map: THREE.Texture; emissive: THREE.Texture } {
  const cell = 64;
  const W = style.cols * cell;
  const H = style.rows * cell;
  const [mc, m] = makeCanvas(W, H);
  const [ec, e] = makeCanvas(W, H);
  const rng = new Rng(style.seed);
  m.fillStyle = '#ffffff';
  m.fillRect(0, 0, W, H);
  // Subtle panel lines.
  m.fillStyle = 'rgba(0,0,0,0.06)';
  for (let r = 0; r < style.rows; r++) m.fillRect(0, r * cell, W, 2);
  e.fillStyle = '#000000';
  e.fillRect(0, 0, W, H);
  const ww = cell * style.winW;
  const wh = cell * style.winH;
  for (let r = 0; r < style.rows; r++) {
    for (let col = 0; col < style.cols; col++) {
      const x = col * cell + (cell - ww) / 2;
      const y = r * cell + (cell - wh) / 2;
      m.fillStyle = 'rgba(40,40,40,0.5)';
      m.fillRect(x - 2, y - 2, ww + 4, wh + 4);
      m.fillStyle = '#3d4a55';
      m.fillRect(x, y, ww, wh);
      m.fillStyle = 'rgba(255,255,255,0.18)';
      m.fillRect(x + 2, y + 2, ww * 0.35, wh - 4);
      if (rng.chance(style.litChance)) {
        e.fillStyle = rng.chance(0.8) ? '#ffcf8a' : '#cfe2ff';
        e.fillRect(x, y, ww, wh);
      }
    }
  }
  return {
    map: toTexture(mc, 1 / style.tileW, 1 / style.tileH),
    emissive: toTexture(ec, 1 / style.tileW, 1 / style.tileH),
  };
}

function fenceTexture(): THREE.Texture {
  const [c, g] = makeCanvas(64, 64);
  g.clearRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(200,205,210,1)';
  g.lineWidth = 3;
  for (let i = -64; i < 128; i += 16) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke();
    g.beginPath(); g.moveTo(i + 64, 0); g.lineTo(i, 64); g.stroke();
  }
  g.fillStyle = 'rgba(160,165,170,1)';
  g.fillRect(0, 0, 64, 4);
  return toTexture(c, 1 / 1.5, 1 / 1.5);
}

function waterNormalTexture(): THREE.Texture {
  // Tileable normal map built from a sum of periodic sine waves.
  const size = 256;
  const [c, g] = makeCanvas(size, size);
  const img = g.createImageData(size, size);
  const waves: Array<[number, number, number, number]> = [];
  const rng = new Rng(77);
  for (let i = 0; i < 9; i++) waves.push([rng.int(-6, 6), rng.int(1, 8), rng.float(0, Math.PI * 2), rng.float(0.4, 1)]);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let dx = 0;
      let dy = 0;
      const u = x / size;
      const v = y / size;
      for (const [kx, ky, ph, a] of waves) {
        const s = Math.cos(2 * Math.PI * (kx * u + ky * v) + ph) * a;
        dx += s * kx * 0.08;
        dy += s * ky * 0.08;
      }
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTexture(c, 1, 1, false);
}

export interface Materials {
  ground: THREE.Texture;
  waterNormal: THREE.Texture;
  concrete: THREE.MeshStandardMaterial;
  concreteDark: THREE.MeshStandardMaterial;
  containment: THREE.MeshStandardMaterial;
  tower: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  metalDark: THREE.MeshStandardMaterial;
  roofDark: THREE.MeshStandardMaterial;
  roofRed: THREE.MeshStandardMaterial;
  roofGrey: THREE.MeshStandardMaterial;
  asphalt: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  barnRed: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  cask: THREE.MeshStandardMaterial;
  transformer: THREE.MeshStandardMaterial;
  fence: THREE.MeshStandardMaterial;
  field: THREE.MeshStandardMaterial;
  stripe: THREE.MeshStandardMaterial;
  safetyYellow: THREE.MeshStandardMaterial;
  bulb: THREE.MeshStandardMaterial;
  houseWalls: THREE.MeshStandardMaterial[];
  shopWalls: THREE.MeshStandardMaterial[];
  plantWalls: THREE.MeshStandardMaterial;
  officeWalls: THREE.MeshStandardMaterial;
  industrialWalls: THREE.MeshStandardMaterial;
  /** Materials whose emissive windows glow at night. */
  litMaterials: THREE.MeshStandardMaterial[];
}

export function createMaterials(): Materials {
  const std = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });

  const concreteTex = toTexture(noiseCanvas(128, 11, 0.9, 0.22), 1 / 6, 1 / 6);
  const ground = toTexture(noiseCanvas(256, 12, 0.95, 0.14), 1, 1);
  const litMaterials: THREE.MeshStandardMaterial[] = [];

  const windowed = (color: number, style: WindowStyle, emissiveColor = 0xffffff) => {
    const t = windowTextures(style);
    const mat = std(color, {
      map: t.map,
      emissive: emissiveColor,
      emissiveMap: t.emissive,
      emissiveIntensity: 0,
      roughness: 0.8,
    });
    litMaterials.push(mat);
    return mat;
  };

  const house: WindowStyle = { tileW: 14, tileH: 6, cols: 4, rows: 2, winW: 0.42, winH: 0.42, litChance: 0.45, seed: 1 };
  const shop: WindowStyle = { tileW: 16, tileH: 14, cols: 4, rows: 4, winW: 0.62, winH: 0.5, litChance: 0.5, seed: 2 };
  const office: WindowStyle = { tileW: 12, tileH: 10.5, cols: 4, rows: 3, winW: 0.7, winH: 0.42, litChance: 0.6, seed: 3 };
  const plant: WindowStyle = { tileW: 24, tileH: 8, cols: 3, rows: 1, winW: 0.3, winH: 0.25, litChance: 0.7, seed: 4 };
  const ind: WindowStyle = { tileW: 30, tileH: 10, cols: 3, rows: 1, winW: 0.5, winH: 0.18, litChance: 0.5, seed: 5 };

  const houseColors = [0xe8dcc4, 0xc9a98a, 0xb7c4c9, 0xd9c7a0, 0xa9b49a, 0xd8b8b0];
  const shopColors = [0x9c5a44, 0xb8a58c, 0x8a8f96, 0xc2b49a];

  return {
    ground,
    waterNormal: waterNormalTexture(),
    concrete: std(0xbab7ae, { map: concreteTex }),
    concreteDark: std(0x8f8d86, { map: concreteTex }),
    containment: std(0xdcd9d0, { map: concreteTex, roughness: 0.7 }),
    tower: std(0xc9c5bb, { map: concreteTex, side: THREE.DoubleSide }),
    metal: std(0x8d9399, { metalness: 0.5, roughness: 0.5 }),
    metalDark: std(0x50565c, { metalness: 0.5, roughness: 0.6 }),
    roofDark: std(0x46474c),
    roofRed: std(0x7a3b30),
    roofGrey: std(0x6c7378, { metalness: 0.3, roughness: 0.6 }),
    asphalt: std(0x38393b, { roughness: 0.95, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    dirt: std(0x86704f, { roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }),
    wood: std(0x7a5a3a),
    barnRed: std(0x8e2f25),
    white: std(0xeeeeee),
    cask: std(0x9aa0a6, { metalness: 0.4, roughness: 0.5 }),
    transformer: std(0x5f6f62, { metalness: 0.3, roughness: 0.6 }),
    fence: std(0xb8bcc0, {
      map: fenceTexture(), transparent: false, alphaTest: 0.5, side: THREE.DoubleSide, metalness: 0.4, roughness: 0.5,
    }),
    field: std(0x4f8a3a, { polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }),
    stripe: std(0xe8e8e0, { polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 }),
    safetyYellow: std(0xe0b020),
    bulb: new THREE.MeshStandardMaterial({ color: 0x333333, emissive: 0xffd9a0, emissiveIntensity: 0 }),
    houseWalls: houseColors.map((c, i) => windowed(c, { ...house, seed: 10 + i })),
    shopWalls: shopColors.map((c, i) => windowed(c, { ...shop, seed: 20 + i })),
    plantWalls: windowed(0xc4c1b8, plant),
    officeWalls: windowed(0xb9c0c4, office),
    industrialWalls: windowed(0x9aa3a8, ind),
    litMaterials,
  };
}
