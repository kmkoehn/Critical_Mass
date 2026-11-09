/** Rain streaks around the camera and lightning bolts. (Clouds and fog live in DayNight.) */
import * as THREE from 'three';
import { Rng } from '../util/rng';

const DROPS = 2600;
const BOX = { x: 70, y: 40, z: 70 };

export class WeatherFx {
  private readonly rain: THREE.LineSegments;
  private readonly rainMat: THREE.LineBasicMaterial;
  private readonly drops: Float32Array;
  private readonly bolt: THREE.Line;
  private readonly boltMat: THREE.LineBasicMaterial;
  private boltLife = 0;
  private readonly rng = new Rng(4242);
  /** 0..1, decays quickly after a strike; DayNight uses it to light the scene. */
  flash = 0;

  constructor(scene: THREE.Scene) {
    this.drops = new Float32Array(DROPS * 6);
    for (let i = 0; i < DROPS; i++) {
      const x = this.rng.float(-BOX.x / 2, BOX.x / 2);
      const y = this.rng.float(0, BOX.y);
      const z = this.rng.float(-BOX.z / 2, BOX.z / 2);
      this.drops.set([x, y, z, x + 0.05, y + 0.9, z + 0.02], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.drops, 3));
    this.rainMat = new THREE.LineBasicMaterial({ color: 0xb4c4d4, transparent: true, opacity: 0, depthWrite: false });
    this.rain = new THREE.LineSegments(geo, this.rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    scene.add(this.rain);

    this.boltMat = new THREE.LineBasicMaterial({ color: 0xe8f0ff, transparent: true, opacity: 0, fog: false });
    this.bolt = new THREE.Line(new THREE.BufferGeometry(), this.boltMat);
    this.bolt.frustumCulled = false;
    scene.add(this.bolt);
  }

  /** Draw a lightning bolt from the clouds down to (x, groundY, z). */
  strike(x: number, groundY: number, z: number): void {
    const pts: number[] = [];
    let cx = x + this.rng.float(-40, 40);
    let cz = z + this.rng.float(-40, 40);
    const top = groundY + 420;
    const segs = 18;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const y = top + (groundY - top) * t;
      // Converge on the strike point as it nears the ground.
      cx += (x - cx) * t * 0.5 + this.rng.float(-14, 14) * (1 - t);
      cz += (z - cz) * t * 0.5 + this.rng.float(-14, 14) * (1 - t);
      pts.push(i === segs ? x : cx, y, i === segs ? z : cz);
    }
    this.bolt.geometry.dispose();
    this.bolt.geometry = new THREE.BufferGeometry();
    this.bolt.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.boltLife = 0.25;
    this.flash = 1;
  }

  update(dt: number, camera: THREE.Camera, rain: number): void {
    // Rain falls in a box that travels with the camera.
    const active = rain > 0.02;
    this.rain.visible = active;
    this.rainMat.opacity = Math.min(0.55, rain * 0.6);
    if (active) {
      const fall = 24 * dt;
      const d = this.drops;
      for (let i = 0; i < DROPS; i++) {
        const o = i * 6;
        d[o + 1] -= fall;
        d[o + 4] -= fall;
        if (d[o + 1] < 0) {
          d[o + 1] += BOX.y;
          d[o + 4] += BOX.y;
        }
      }
      (this.rain.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      this.rain.position.set(camera.position.x, camera.position.y - BOX.y / 2, camera.position.z);
    }
    this.boltLife -= dt;
    // Bolts flicker as they fade.
    this.boltMat.opacity = this.boltLife > 0 ? (Math.floor(this.boltLife * 30) % 2 ? 1 : 0.4) : 0;
    this.flash = Math.max(0, this.flash - dt * 4);
  }
}
