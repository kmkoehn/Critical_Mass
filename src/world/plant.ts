/** Riverbend Generating Station: campus blockout plus cooling-tower steam. */
import * as THREE from 'three';
import type { WorldBuilder } from './builder';
import { PLANT_LAYOUT as L } from './layout';
import { Rng } from '../util/rng';

const TOWER = { throatR: 21, throatY: 70, c: 54.2, height: 100 };

function towerRadius(y: number): number {
  const k = (y - TOWER.throatY) / TOWER.c;
  return TOWER.throatR * Math.sqrt(1 + k * k);
}

export function softPuffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Puff {
  sprite: THREE.Sprite;
  age: number;
  life: number;
  ox: number;
  oz: number;
}

/** Rising steam plume above a cooling tower. `intensity` will later follow reactor output. */
export class SteamPlume {
  private readonly puffs: Puff[] = [];
  intensity = 0;
  private brightness = 1;

  constructor(parent: THREE.Object3D, private readonly x: number, private readonly topY: number, private readonly z: number, seed: number) {
    const tex = softPuffTexture();
    const rng = new Rng(seed);
    const count = 16;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: true });
      const sprite = new THREE.Sprite(mat);
      parent.add(sprite);
      const life = rng.float(9, 13);
      this.puffs.push({ sprite, life, age: (i / count) * life, ox: rng.float(-6, 6), oz: rng.float(-6, 6) });
    }
  }

  setLight(brightness: number): void {
    this.brightness = brightness;
  }

  update(dt: number): void {
    for (const p of this.puffs) {
      p.age += dt;
      if (p.age > p.life) p.age -= p.life;
      const t = p.age / p.life;
      const rise = t * 75;
      // Gentle drift downwind (towards the east).
      p.sprite.position.set(this.x + p.ox + t * 40, this.topY + rise, this.z + p.oz + t * 10);
      p.sprite.scale.setScalar((26 + t * 55) * (0.5 + 0.5 * this.intensity));
      const mat = p.sprite.material;
      p.sprite.visible = this.intensity > 0.01;
      mat.opacity = Math.sin(Math.PI * Math.min(1, t * 1.4)) * 0.55 * this.intensity * (t < 0.08 ? t / 0.08 : 1);
      const b = 0.35 + 0.65 * this.brightness;
      mat.color.setRGB(b, b, b * 1.02);
    }
  }
}

export interface PlantHandles {
  plumes: SteamPlume[];
  controlRoomFloorY: number;
}

export function buildPlant(b: WorldBuilder): PlantHandles {
  const m = b.mats;
  const pad = b.groundY(L.gate.x - 20, L.gate.z);

  // --- Containment building: cylinder + dome.
  {
    const c = L.containment;
    const base = b.groundY(c.x, c.z);
    b.cylinder(c.x, c.z, c.r, base - 1, base + c.h, m.containment, { segments: 48, map: '#6b6e73' });
    const dome = new THREE.Mesh(new THREE.SphereGeometry(c.r, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), m.containment);
    dome.position.set(c.x, base + c.h, c.z);
    dome.castShadow = dome.receiveShadow = true;
    b.root.add(dome);
    b.collision.addCyl(c.x, c.z, c.r * 0.8, base + c.h, base + c.h + c.r);
    // Equipment hatch and access building on the east side.
    b.building(c.x + c.r + 3, c.z, 8, 12, 9, m.concrete, m.roofGrey, { baseY: base });
  }

  // --- Turbine hall (enterable).
  {
    const t = L.turbineHall;
    b.hollow(t.cx, t.cz, t.w, t.d, t.h, m.plantWalls, m.roofGrey, m.concreteDark,
      { side: 's', width: 7, height: 7 }, { light: 40 });
    // Placeholder turbine-generator set inside (fleshed out in a later milestone).
    const base = b.groundY(t.cx, t.cz);
    b.box(t.cx - 26, base, t.cz - 4, t.cx + 20, base + 4.5, t.cz + 4, m.metal, { map: false });
    b.cylinder(t.cx + 24, t.cz, 3.5, base, base + 6, m.metalDark, { map: false });
  }

  // --- Control room building (enterable).
  let controlRoomFloorY: number;
  {
    const c = L.controlRoom;
    // Interior is furnished by controlRoom.ts.
    controlRoomFloorY = b.hollow(c.cx, c.cz, c.w, c.d, c.h, m.officeWalls, m.roofDark, m.concreteDark,
      { side: 'n', width: 2.4, height: 3 }, { light: 45 });
  }

  // --- Cooling towers.
  const plumes: SteamPlume[] = [];
  L.coolingTowers.forEach((tw, i) => {
    const base = b.groundY(tw.x, tw.z);
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= 24; k++) {
      const y = (k / 24) * TOWER.height;
      pts.push(new THREE.Vector2(towerRadius(y), y));
    }
    const mesh = new THREE.Mesh(new THREE.LatheGeometry(pts, 64), m.tower);
    mesh.position.set(tw.x, base - 0.5, tw.z);
    mesh.castShadow = mesh.receiveShadow = true;
    b.root.add(mesh);
    const r0 = towerRadius(0);
    b.collision.addCyl(tw.x, tw.z, r0, base - 1, base + TOWER.height);
    b.features.push({ kind: 'circle', x: tw.x, z: tw.z, r: r0, color: '#7d8086' });
    // Basin rim.
    b.cylinder(tw.x, tw.z, r0 + 3, base - 1, base + 1.2, m.concreteDark, { segments: 48, map: false, collide: false });
    plumes.push(new SteamPlume(b.root, tw.x, base + TOWER.height - 6, tw.z, 300 + i));
  });

  // --- Switchyard: fenced area with transformers and gantries.
  {
    const s = L.switchyard;
    const base = b.groundY(s.cx, s.cz);
    const x0 = s.cx - s.w / 2, x1 = s.cx + s.w / 2, z0 = s.cz - s.d / 2, z1 = s.cz + s.d / 2;
    b.box(x0, base - 0.2, z0, x1, base + 0.08, z1, m.concreteDark, { collide: false, map: '#5d6166', castShadow: false });
    const fh = 2.6;
    // North side has a gate where the spur road arrives.
    b.box(x0, base, z0, s.cx - 4, base + fh, z0 + 0.1, m.fence, { map: false, castShadow: false });
    b.box(s.cx + 4, base, z0, x1, base + fh, z0 + 0.1, m.fence, { map: false, castShadow: false });
    b.box(x0, base, z1 - 0.1, x1, base + fh, z1, m.fence, { map: false, castShadow: false });
    b.box(x0, base, z0, x0 + 0.1, base + fh, z1, m.fence, { map: false, castShadow: false });
    b.box(x1 - 0.1, base, z0, x1, base + fh, z1, m.fence, { map: false, castShadow: false });
    for (let i = 0; i < 3; i++) {
      const tx = x0 + 12 + i * 18;
      b.box(tx - 3, base, s.cz - 4, tx + 3, base + 4.5, s.cz + 4, m.transformer, { map: false });
      b.box(tx - 3.5, base, s.cz + 12, tx + 3.5, base + 0.5, s.cz + 13, m.metal, { map: false, collide: false });
    }
    for (let i = 0; i < 4; i++) {
      const gx = x0 + 6 + i * 16;
      b.box(gx - 0.3, base, z0 + 4, gx + 0.3, base + 14, z0 + 4.6, m.metal, { map: false });
      b.box(gx - 0.3, base, z1 - 4.6, gx + 0.3, base + 14, z1 - 4, m.metal, { map: false });
      b.box(gx - 0.3, base + 13.4, z0 + 4, gx + 0.3, base + 14, z1 - 4, m.metal, { map: false, collide: false });
    }
  }

  // --- Spent fuel dry-cask pad.
  {
    const s = L.spentFuel;
    const base = b.groundY(s.cx, s.cz);
    b.box(s.cx - s.w / 2, base - 0.3, s.cz - s.d / 2, s.cx + s.w / 2, base + 0.3, s.cz + s.d / 2, m.concrete,
      { collide: true, map: '#5d6166', castShadow: false });
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 6; c++) {
        b.cylinder(s.cx - 15 + c * 6, s.cz - 5 + r * 10, 1.7, base + 0.3, base + 6, m.cask, { segments: 16, map: false });
      }
    }
  }

  // --- Admin office, gatehouse, parking.
  {
    const a = L.admin;
    b.building(a.cx, a.cz, a.w, a.d, a.h, m.officeWalls, m.roofDark);
    const p = L.parking;
    const base = b.groundY(p.cx, p.cz);
    b.box(p.cx - p.w / 2, base - 0.2, p.cz - p.d / 2, p.cx + p.w / 2, base + 0.1, p.cz + p.d / 2, m.asphalt,
      { collide: false, map: '#3b3d40', castShadow: false });
    for (let i = 0; i <= 8; i++) {
      const x = p.cx - p.w / 2 + 2 + i * 4.5;
      b.box(x - 0.08, base + 0.1, p.cz - p.d / 2 + 2, x + 0.08, base + 0.13, p.cz - 4, m.stripe,
        { collide: false, map: false, castShadow: false });
      b.box(x - 0.08, base + 0.1, p.cz + 4, x + 0.08, base + 0.13, p.cz + p.d / 2 - 2, m.stripe,
        { collide: false, map: false, castShadow: false });
    }
    // Gatehouse booth and barrier.
    const g = L.gate;
    b.building(g.x - 6, g.z + 9, 4, 4, 3, m.officeWalls, m.roofDark, { baseY: pad });
    b.box(g.x - 0.6, pad, g.z + 6.2, g.x + 0.6, pad + 1.2, g.z + 7.2, m.safetyYellow, { map: false });
    b.box(g.x - 0.12, pad + 1.0, g.z - 5.5, g.x + 0.12, pad + 1.2, g.z + 6.2, m.safetyYellow, { map: false, collide: false });
  }

  // --- Perimeter fence with a gap at the gate.
  {
    const f = L.fence;
    const fh = 2.6;
    const fy = pad - 1;
    const opts = { map: false as const, castShadow: false };
    b.box(f.minX, fy, f.minZ, f.maxX, pad + fh, f.minZ + 0.1, b.mats.fence, opts);
    b.box(f.minX, fy, f.maxZ - 0.1, f.maxX, pad + fh, f.maxZ, b.mats.fence, opts);
    b.box(f.minX, fy, f.minZ, f.minX + 0.1, pad + fh, f.maxZ, b.mats.fence, opts);
    b.box(f.maxX - 0.1, fy, f.minZ, f.maxX, pad + fh, L.gate.z - f.gateHalf, b.mats.fence, opts);
    b.box(f.maxX - 0.1, fy, L.gate.z + f.gateHalf, f.maxX, pad + fh, f.maxZ, b.mats.fence, opts);
    for (let x = f.minX; x <= f.maxX; x += 12) {
      b.box(x - 0.08, fy, f.minZ - 0.08, x + 0.08, pad + fh + 0.3, f.minZ + 0.18, m.metal, { map: false, collide: false });
      b.box(x - 0.08, fy, f.maxZ - 0.18, x + 0.08, pad + fh + 0.3, f.maxZ + 0.08, m.metal, { map: false, collide: false });
    }
  }

  // --- Plant sign by the gate.
  {
    const g = L.gate;
    b.box(g.x + 6, pad, g.z - 14, g.x + 6.4, pad + 3.5, g.z - 8, m.white, { map: false });
  }

  return { plumes, controlRoomFloorY };
}
