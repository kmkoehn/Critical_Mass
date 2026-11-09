/** Pre-rendered top-down map image, the rotating minimap and the full-screen map (M). */
import type { MapFeature } from '../world/builder';
import type { Heightfield } from '../world/heightfield';
import { MAP_LABELS, ROADS, SEED, WATER_LEVEL, WORLD_HALF } from '../world/layout';
import { terrainColor } from '../world/terrainColor';
import { createNoise2D } from '../util/noise';
import { clamp } from '../util/math';

const SIZE = 768;
const toPx = (v: number) => ((v + WORLD_HALF) / (WORLD_HALF * 2)) * SIZE;

export function renderMapImage(hf: Heightfield, features: readonly MapFeature[]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const g = canvas.getContext('2d')!;
  const img = g.createImageData(SIZE, SIZE);
  const n = createNoise2D(SEED + 50);
  const m = (WORLD_HALF * 2) / SIZE;
  for (let py = 0; py < SIZE; py++) {
    const z = -WORLD_HALF + (py + 0.5) * m;
    for (let px = 0; px < SIZE; px++) {
      const x = -WORLD_HALF + (px + 0.5) * m;
      const h = hf.heightAt(x, z);
      const hx = hf.heightAt(x + m, z) - hf.heightAt(x - m, z);
      const hz = hf.heightAt(x, z + m) - hf.heightAt(x, z - m);
      let r: number, gg: number, b: number;
      if (h < WATER_LEVEL) {
        const depth = clamp(-h / 4.5, 0, 1);
        r = 0.22 - depth * 0.08;
        gg = 0.42 - depth * 0.1;
        b = 0.52 - depth * 0.06;
      } else {
        [r, gg, b] = terrainColor(x, z, h, Math.hypot(hx, hz) / (2 * m), n);
        // Hill shading, light from the north-west.
        const shade = clamp(1 + (hx + hz) * -0.18, 0.6, 1.3);
        r *= shade;
        gg *= shade;
        b *= shade;
      }
      const i = (py * SIZE + px) * 4;
      img.data[i] = clamp(r * 255, 0, 255);
      img.data[i + 1] = clamp(gg * 255, 0, 255);
      img.data[i + 2] = clamp(b * 255, 0, 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);

  const scale = SIZE / (WORLD_HALF * 2);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const road of ROADS) {
    g.strokeStyle = road.kind === 'asphalt' ? '#2c2d30' : '#8a7454';
    g.lineWidth = Math.max(1.5, road.width * scale * 1.3);
    g.beginPath();
    road.points.forEach(([x, z], i) => (i ? g.lineTo(toPx(x), toPx(z)) : g.moveTo(toPx(x), toPx(z))));
    g.stroke();
  }
  for (const f of features) {
    g.fillStyle = f.color;
    if (f.kind === 'rect') {
      g.fillRect(toPx(f.minX), toPx(f.minZ), Math.max(1, (f.maxX - f.minX) * scale), Math.max(1, (f.maxZ - f.minZ) * scale));
    } else {
      g.beginPath();
      g.arc(toPx(f.x), toPx(f.z), Math.max(1, f.r * scale), 0, Math.PI * 2);
      g.fill();
    }
  }
  return canvas;
}

function drawArrow(g: CanvasRenderingContext2D, size: number, color: string): void {
  g.beginPath();
  g.moveTo(0, -size);
  g.lineTo(size * 0.7, size * 0.8);
  g.lineTo(0, size * 0.35);
  g.lineTo(-size * 0.7, size * 0.8);
  g.closePath();
  g.fillStyle = color;
  g.strokeStyle = 'rgba(0,0,0,0.7)';
  g.lineWidth = 1.5;
  g.fill();
  g.stroke();
}

/** Circular minimap that rotates so the player's heading is always up. */
export class Minimap {
  private readonly g: CanvasRenderingContext2D;
  private readonly px: number;
  /** World metres from centre to edge. */
  range = 260;

  constructor(canvas: HTMLCanvasElement, private readonly image: HTMLCanvasElement) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.px = 190;
    canvas.width = canvas.height = this.px * dpr;
    canvas.style.width = canvas.style.height = `${this.px}px`;
    this.g = canvas.getContext('2d')!;
    this.g.scale(dpr, dpr);
  }

  draw(x: number, z: number, yaw: number): void {
    const g = this.g;
    const s = this.px;
    const c = s / 2;
    const k = c / this.range; // px per metre
    g.clearRect(0, 0, s, s);
    g.save();
    g.beginPath();
    g.arc(c, c, c - 2, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = '#1b2026';
    g.fillRect(0, 0, s, s);
    g.translate(c, c);
    g.rotate(yaw);
    const span = WORLD_HALF * 2 * k;
    g.imageSmoothingEnabled = true;
    g.drawImage(this.image, -(x + WORLD_HALF) * k, -(z + WORLD_HALF) * k, span, span);
    g.restore();

    // North marker on the rim.
    // World north (0,-1) after the map rotation lands at (sin yaw, -cos yaw).
    const nx = c + Math.sin(yaw) * (c - 12);
    const ny = c - Math.cos(yaw) * (c - 12);
    g.fillStyle = 'rgba(10,14,18,0.8)';
    g.beginPath();
    g.arc(nx, ny, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffcf5a';
    g.font = '600 11px Bahnschrift, "Segoe UI", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', nx, ny + 0.5);

    g.save();
    g.translate(c, c);
    drawArrow(g, 8, '#ffcf5a');
    g.restore();

    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(c, c, c - 2, 0, Math.PI * 2);
    g.stroke();
  }
}

export interface MapMarker {
  x: number;
  z: number;
  label: string;
  done: boolean;
}

/** Full-screen map overlay. */
export class BigMap {
  private readonly g: CanvasRenderingContext2D;
  visible = false;

  constructor(private readonly root: HTMLElement, private readonly canvas: HTMLCanvasElement, private readonly image: HTMLCanvasElement) {
    this.g = canvas.getContext('2d')!;
  }

  toggle(): void {
    this.visible = !this.visible;
    this.root.hidden = !this.visible;
  }

  draw(x: number, z: number, yaw: number, markers: readonly MapMarker[]): void {
    if (!this.visible) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.84);
    if (this.canvas.width !== size * dpr) {
      this.canvas.width = this.canvas.height = size * dpr;
      this.canvas.style.width = this.canvas.style.height = `${size}px`;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.drawImage(this.image, 0, 0, size, size);
    const k = size / (WORLD_HALF * 2);
    const P = (v: number) => (v + WORLD_HALF) * k;

    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const l of MAP_LABELS) {
      const fs = l.size === 'lg' ? 17 : l.size === 'md' ? 14 : 12;
      g.font = `${l.size === 'lg' ? 700 : 600} ${fs}px Bahnschrift, "Segoe UI", sans-serif`;
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(12,16,20,0.75)';
      g.strokeText(l.name.toUpperCase(), P(l.x), P(l.z));
      g.fillStyle = '#f2efe6';
      g.fillText(l.name.toUpperCase(), P(l.x), P(l.z));
    }

    for (const mk of markers) {
      g.beginPath();
      g.arc(P(mk.x), P(mk.z), 7, 0, Math.PI * 2);
      g.fillStyle = mk.done ? '#5fbf6a' : '#ffcf5a';
      g.fill();
      g.lineWidth = 2;
      g.strokeStyle = '#111';
      g.stroke();
    }

    g.save();
    g.translate(P(x), P(z));
    g.rotate(-yaw);
    drawArrow(g, 10, '#ff6a3d');
    g.restore();
  }
}
