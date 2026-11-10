/**
 * Plant and weather effects that follow the simulation:
 * rotating alarm beacons, relief-valve steam, heat haze over a hot outfall, a cloud deck and snow.
 */
import * as THREE from 'three';
import { INTAKE, PLANT_LAYOUT as L, WATER_LEVEL, riverX } from './layout';
import type { Heightfield } from './heightfield';
import { softPuffTexture } from './plant';
import { Rng } from '../util/rng';

// ------------------------------------------------------------------ alarm beacons

/** Rotating red beacons on the containment and turbine hall roofs, lit while a plant alarm is up. */
class AlarmBeacons {
  private readonly heads: Array<{ head: THREE.Group; lens: THREE.MeshStandardMaterial; beam: THREE.Mesh }> = [];
  private t = 0;

  constructor(parent: THREE.Object3D, hf: Heightfield) {
    const spots: Array<[number, number, number]> = [
      [L.containment.x, L.containment.z, hf.heightAt(L.containment.x, L.containment.z) + L.containment.h + L.containment.r + 0.6],
      [L.turbineHall.cx - 25, L.turbineHall.cz, hf.heightAt(L.turbineHall.cx, L.turbineHall.cz) + L.turbineHall.h + 0.6],
      [L.turbineHall.cx + 25, L.turbineHall.cz, hf.heightAt(L.turbineHall.cx, L.turbineHall.cz) + L.turbineHall.h + 0.6],
    ];
    const beamGeo = new THREE.ConeGeometry(4, 26, 16, 1, true);
    beamGeo.translate(0, -13, 0);
    beamGeo.rotateZ(Math.PI / 2);
    for (const [x, z, y] of spots) {
      const head = new THREE.Group();
      head.position.set(x, y, z);
      const lens = new THREE.MeshStandardMaterial({ color: 0x401010, emissive: 0xff2a1a, emissiveIntensity: 0, roughness: 0.3 });
      head.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.9, 12), lens));
      const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
        color: 0xff3020, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      }));
      head.add(beam);
      parent.add(head);
      this.heads.push({ head, lens, beam });
    }
  }

  update(dt: number, alarm: boolean, night: number): void {
    this.t += dt;
    for (const [i, h] of this.heads.entries()) {
      h.head.rotation.y = this.t * 4 + i * 2.1;
      h.lens.emissiveIntensity = alarm ? 3 + Math.sin(this.t * 25) * 0.5 : 0;
      const m = h.beam.material as THREE.MeshBasicMaterial;
      m.opacity = alarm ? 0.08 + 0.22 * night : 0;
      h.beam.visible = alarm;
    }
  }
}

// ------------------------------------------------------------------ steam puffs

/** A short-lived column of puffs, e.g. a relief valve lifting on the main steam lines. */
class PuffSource {
  private readonly puffs: Array<{ s: THREE.Sprite; age: number; life: number; ox: number; oz: number }> = [];
  level = 0;

  constructor(parent: THREE.Object3D, tex: THREE.Texture, private readonly x: number, private readonly y: number, private readonly z: number,
    count: number, private readonly size: number, private readonly rise: number, seed: number, private readonly tint = 1) {
    const rng = new Rng(seed);
    for (let i = 0; i < count; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
      s.visible = false;
      parent.add(s);
      const life = rng.float(2.5, 4);
      this.puffs.push({ s, age: (i / count) * life, life, ox: rng.float(-1, 1), oz: rng.float(-1, 1) });
    }
  }

  update(dt: number, brightness: number): void {
    const on = this.level > 0.01;
    for (const p of this.puffs) {
      p.s.visible = on;
      if (!on) continue;
      p.age += dt * (0.8 + this.level);
      if (p.age > p.life) p.age -= p.life;
      const t = p.age / p.life;
      p.s.position.set(this.x + p.ox * (1 + t * 4) + t * 8, this.y + t * this.rise, this.z + p.oz * (1 + t * 4));
      p.s.scale.setScalar(this.size * (0.4 + t * 1.6) * (0.5 + this.level * 0.5));
      p.s.material.opacity = Math.sin(Math.PI * t) * 0.7 * this.level;
      const b = (0.35 + 0.65 * brightness) * this.tint;
      p.s.material.color.setRGB(b, b, b);
    }
  }
}

// ------------------------------------------------------------------ cloud deck

function cloudTexture(): THREE.Texture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(0,0,0,0)';
  g.fillRect(0, 0, size, size);
  const rng = new Rng(77);
  // Soft blobs, drawn wrapped so the texture tiles.
  for (let i = 0; i < 140; i++) {
    const x = rng.float(0, size);
    const y = rng.float(0, size);
    const r = rng.float(12, 46);
    const a = rng.float(0.12, 0.3);
    for (const ox of [-size, 0, size]) {
      for (const oy of [-size, 0, size]) {
        const grad = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grad.addColorStop(0, `rgba(255,255,255,${a})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 5);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------ snow

const FLAKES = 1800;
const SNOW_BOX = { x: 80, y: 40, z: 80 };

class Snow {
  private readonly points: THREE.Points;
  private readonly mat: THREE.PointsMaterial;
  private readonly pos: Float32Array;
  private readonly phase: Float32Array;
  private t = 0;

  constructor(scene: THREE.Object3D) {
    const rng = new Rng(31);
    this.pos = new Float32Array(FLAKES * 3);
    this.phase = new Float32Array(FLAKES);
    for (let i = 0; i < FLAKES; i++) {
      this.pos.set([rng.float(-SNOW_BOX.x / 2, SNOW_BOX.x / 2), rng.float(0, SNOW_BOX.y), rng.float(-SNOW_BOX.z / 2, SNOW_BOX.z / 2)], i * 3);
      this.phase[i] = rng.float(0, Math.PI * 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.18, transparent: true, opacity: 0, depthWrite: false });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    scene.add(this.points);
  }

  update(dt: number, camera: THREE.Camera, amount: number): void {
    const on = amount > 0.02;
    this.points.visible = on;
    if (!on) return;
    this.t += dt;
    this.mat.opacity = Math.min(0.9, amount);
    const p = this.pos;
    for (let i = 0; i < FLAKES; i++) {
      const o = i * 3;
      p[o + 1] -= 1.6 * dt;
      p[o] += Math.sin(this.t * 0.9 + this.phase[i]) * 0.5 * dt + 0.6 * dt;
      if (p[o + 1] < 0) p[o + 1] += SNOW_BOX.y;
      if (p[o] > SNOW_BOX.x / 2) p[o] -= SNOW_BOX.x;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    this.points.position.set(camera.position.x, camera.position.y - SNOW_BOX.y / 2, camera.position.z);
  }
}

// ------------------------------------------------------------------ everything together

export interface EffectsInput {
  /** A plant alarm is active (beacons turn). */
  alarm: boolean;
  /** Steam relief to atmosphere 0..1 (steam dumps, turbine trip at power). */
  relief: number;
  /** Outfall temperature, °C. */
  outfallTemp: number;
  cloud: number;
  /** Snowfall 0..1. */
  snow: number;
  daylight: number;
  night: number;
  /** Sky colour hint for the clouds (fog colour). */
  skyColor: THREE.Color;
}

export class PlantEffects {
  private readonly beacons: AlarmBeacons;
  private readonly relief: PuffSource[];
  private readonly haze: PuffSource;
  private readonly clouds: THREE.Mesh;
  private readonly cloudMat: THREE.MeshBasicMaterial;
  private readonly snow: Snow;

  constructor(parent: THREE.Object3D, scene: THREE.Scene, hf: Heightfield) {
    this.beacons = new AlarmBeacons(parent, hf);
    const tex = softPuffTexture();
    const th = L.turbineHall;
    const roof = hf.heightAt(th.cx, th.cz) + th.h;
    this.relief = [-12, 0, 12].map((dx, i) => new PuffSource(parent, tex, th.cx + dx, roof + 2, th.cz + th.d / 2 - 4, 10, 7, 30, 500 + i));
    // Outfall: warm discharge just downstream of the intake.
    const oz = INTAKE.cz - 45;
    const ox = riverX(oz) - 26;
    this.haze = new PuffSource(parent, tex, ox, WATER_LEVEL + 0.5, oz, 14, 9, 7, 900, 1.05);

    this.cloudMat = new THREE.MeshBasicMaterial({ map: cloudTexture(), transparent: true, opacity: 0, depthWrite: false, fog: false });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), this.cloudMat);
    this.clouds.rotation.x = Math.PI / 2;
    this.clouds.renderOrder = -1;
    scene.add(this.clouds);
    this.snow = new Snow(scene);
  }

  update(dt: number, camera: THREE.Camera, s: EffectsInput): void {
    this.beacons.update(dt, s.alarm, s.night);
    for (const r of this.relief) {
      r.level += (s.relief - r.level) * Math.min(1, dt * 2);
      r.update(dt, s.daylight);
    }
    const hot = Math.max(0, Math.min(1, (s.outfallTemp - 24) / 6));
    this.haze.level += (hot - this.haze.level) * Math.min(1, dt * 0.5);
    this.haze.update(dt, s.daylight);

    // Cloud deck follows the camera, drifting with the wind.
    this.clouds.position.set(camera.position.x, 700, camera.position.z);
    const map = this.cloudMat.map!;
    map.offset.x = (camera.position.x / 6000) * 5 + performance.now() * 0.0000025;
    map.offset.y = (camera.position.z / 6000) * 5;
    this.cloudMat.opacity = Math.min(1, 0.35 + 0.9 * s.cloud);
    const b = 0.25 + 0.75 * s.daylight * (1 - 0.45 * s.cloud);
    this.cloudMat.color.setRGB(b, b, b * 1.04).lerp(s.skyColor, 0.25);
    this.snow.update(dt, camera, s.snow);
  }
}
