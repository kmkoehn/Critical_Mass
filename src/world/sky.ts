/** Day/night cycle: sun, moon, sky dome, stars, fog and ambient light. */
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { Rng } from '../util/rng';
import { smoothstep } from '../util/math';

const FOG_DAY = new THREE.Color(0xbfcdd8);
const FOG_DUSK = new THREE.Color(0xc99277);
const FOG_NIGHT = new THREE.Color(0x0a1019);
const FOG_STORM = new THREE.Color(0x6d757d);
const HEMI_DAY = new THREE.Color(0xc4d8ff);
const HEMI_NIGHT = new THREE.Color(0x30406a);

export class DayNight {
  readonly sun = new THREE.DirectionalLight(0xffffff, 2.6);
  readonly moon = new THREE.DirectionalLight(0x9db4e0, 0);
  readonly hemi = new THREE.HemisphereLight(0xc4d8ff, 0x4a4230, 0.8);
  readonly sunDir = new THREE.Vector3(0, 1, 0);
  /** 1 in full daylight, 0 at night. */
  daylight = 1;
  /** 1 in full night, 0 by day. Drives window lights and street lamps. */
  night = 0;

  private readonly sky = new Sky();
  private readonly stars: THREE.Points;
  private readonly fog: THREE.FogExp2;
  private readonly tmp = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.sky.scale.setScalar(4000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 5.5;
    u.rayleigh.value = 1.4;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.82;
    scene.add(this.sky);

    const s = this.sun.shadow;
    this.sun.castShadow = true;
    s.mapSize.set(2048, 2048);
    s.camera.left = -140;
    s.camera.right = 140;
    s.camera.top = 140;
    s.camera.bottom = -140;
    s.camera.near = 1;
    s.camera.far = 1400;
    s.bias = -0.0004;
    s.normalBias = 0.5;
    scene.add(this.sun, this.sun.target, this.moon, this.moon.target, this.hemi);

    const rng = new Rng(99);
    const starPos: number[] = [];
    for (let i = 0; i < 1800; i++) {
      const theta = rng.float(0, Math.PI * 2);
      const y = rng.float(0.04, 1);
      const r = Math.sqrt(1 - y * y);
      starPos.push(Math.cos(theta) * r * 1800, y * 1800, Math.sin(theta) * r * 1800);
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(
      starGeo,
      new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }),
    );
    this.stars.frustumCulled = false;
    scene.add(this.stars);

    this.fog = new THREE.FogExp2(FOG_DAY.getHex(), 0.0006);
    scene.fog = this.fog;
  }

  /** Cloud cover 0..1 and a lightning flash 0..1, set each frame before update(). */
  cloud = 0;
  flash = 0;

  /** `hour` is 0..24; `focus` is where shadows should be sharpest (the player). */
  update(hour: number, focus: THREE.Vector3): void {
    const theta = ((hour - 6) / 24) * Math.PI * 2;
    this.sunDir.set(Math.cos(theta), Math.sin(theta), 0.35).normalize();
    const elev = this.sunDir.y;
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    this.sky.position.copy(focus);
    this.stars.position.copy(focus);

    this.daylight = smoothstep(-0.1, 0.22, elev);
    this.night = 1 - smoothstep(-0.16, 0.04, elev);
    const warm = 1 - smoothstep(0.02, 0.38, elev);

    const overcast = this.cloud;
    this.sky.material.uniforms.turbidity.value = 5.5 + 14 * overcast;
    this.sky.material.uniforms.rayleigh.value = 1.4 * (1 - 0.7 * overcast);
    this.sun.intensity = 2.6 * smoothstep(-0.03, 0.18, elev) * (1 - 0.78 * overcast);
    this.sun.color.setRGB(1, 1 - 0.32 * warm, 1 - 0.55 * warm);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 600);
    this.sun.target.position.copy(focus);

    // The moon rides opposite the sun.
    this.moon.intensity = 0.32 * this.night;
    this.moon.position.copy(focus).addScaledVector(this.sunDir, -600).setY(focus.y + 400);
    this.moon.target.position.copy(focus);

    this.hemi.intensity = (0.32 + 0.6 * this.daylight) * (1 - 0.3 * overcast) + this.flash * 4;
    this.hemi.color.copy(HEMI_NIGHT).lerp(HEMI_DAY, this.daylight);

    this.tmp.copy(FOG_NIGHT).lerp(FOG_DAY, this.daylight);
    this.tmp.lerp(FOG_DUSK, warm * this.daylight * 0.55 * (1 - overcast));
    // Overcast: greyer, thicker haze.
    this.tmp.lerp(FOG_STORM, overcast * 0.7 * Math.max(0.25, this.daylight));
    this.fog.color.copy(this.tmp);
    this.fog.density = 0.0006 + 0.0011 * overcast;

    (this.stars.material as THREE.PointsMaterial).opacity = this.night * 0.9 * (1 - overcast);
  }
}
