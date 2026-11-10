/**
 * Things the player builds: the third cooling tower, the visitor centre and Unit 2.
 * Each rises with its construction progress. Also the floating objective waypoint.
 */
import * as THREE from 'three';
import type { WorldBuilder } from './builder';
import { PLANT_LAYOUT } from './layout';
import { SteamPlume } from './plant';

const TOWER = { throatR: 21, throatY: 70, c: 54.2, height: 100 };
const towerR = (y: number) => TOWER.throatR * Math.sqrt(1 + ((y - TOWER.throatY) / TOWER.c) ** 2);

/** A mesh whose geometry sits on y=0, so scaling Y "grows" it from the ground. */
function grower(geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = m.receiveShadow = true;
  m.visible = false;
  return m;
}

export interface ExpansionProgress {
  coolingTower3: number;
  visitorCentre: number;
  unit2: number;
}

export class Expansion {
  readonly plume: SteamPlume;
  private readonly tower: THREE.Mesh;
  private readonly visitor: THREE.Group;
  private readonly u2Pad: THREE.Mesh;
  private readonly u2Cyl: THREE.Mesh;
  private readonly u2Dome: THREE.Mesh;
  private readonly u2Hall: THREE.Mesh;
  private readonly crane: THREE.Group;
  private readonly fenced = new Set<string>();
  private craneAngle = 0;

  constructor(private readonly b: WorldBuilder) {
    const m = b.mats;
    const root = b.root;

    // Third (mechanical-draft) cooling tower.
    const t3 = PLANT_LAYOUT.coolingTower3;
    const pts: THREE.Vector2[] = [];
    for (let k = 0; k <= 24; k++) {
      const y = (k / 24) * TOWER.height;
      pts.push(new THREE.Vector2(towerR(y) * t3.scale, y * t3.scale));
    }
    this.tower = grower(new THREE.LatheGeometry(pts, 56), m.tower, t3.x, b.groundY(t3.x, t3.z) - 0.5, t3.z);
    root.add(this.tower);
    this.plume = new SteamPlume(root, t3.x, b.groundY(t3.x, t3.z) + TOWER.height * t3.scale - 5, t3.z, 777);

    // Visitor centre: glassy pavilion with a roof canopy and a sign.
    const v = PLANT_LAYOUT.visitorCentre;
    const vy = b.groundY(v.cx, v.cz);
    this.visitor = new THREE.Group();
    const glass = new THREE.MeshStandardMaterial({ color: 0x8fb4c8, roughness: 0.15, metalness: 0.4, emissive: 0xffe2b0, emissiveIntensity: 0 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(v.w, v.h, v.d).translate(0, v.h / 2, 0), glass);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(v.w + 3, 0.5, v.d + 3).translate(0, v.h + 0.25, 0), m.white);
    const sign = new THREE.Mesh(new THREE.BoxGeometry(8, 1.4, 0.3).translate(0, v.h + 1.3, v.d / 2), m.safetyYellow);
    this.visitor.add(body, roof, sign);
    this.visitor.position.set(v.cx, vy, v.cz);
    this.visitor.traverse((o) => (o.castShadow = true));
    this.visitor.visible = false;
    root.add(this.visitor);

    // Unit 2: pad, containment cylinder + dome, turbine hall, tower crane.
    const u = PLANT_LAYOUT.unit2;
    const uy = b.groundY(u.containment.x, u.containment.z);
    this.u2Pad = grower(new THREE.BoxGeometry(120, 0.6, 50).translate(0, 0.3, 0), m.concreteDark, -532, uy - 0.3, -140);
    this.u2Cyl = grower(new THREE.CylinderGeometry(u.containment.r, u.containment.r, u.containment.h, 40).translate(0, u.containment.h / 2, 0),
      m.containment, u.containment.x, uy, u.containment.z);
    this.u2Dome = grower(new THREE.SphereGeometry(u.containment.r, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2), m.containment,
      u.containment.x, uy + u.containment.h, u.containment.z);
    this.u2Hall = grower(new THREE.BoxGeometry(u.hall.w, u.hall.h, u.hall.d).translate(0, u.hall.h / 2, 0), m.plantWalls, u.hall.cx, uy, u.hall.cz);
    root.add(this.u2Pad, this.u2Cyl, this.u2Dome, this.u2Hall);
    this.crane = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.BoxGeometry(2, 70, 2).translate(0, 35, 0), m.safetyYellow);
    const jib = new THREE.Mesh(new THREE.BoxGeometry(55, 1.6, 1.6).translate(15, 69, 0), m.safetyYellow);
    const cab = new THREE.Mesh(new THREE.BoxGeometry(3, 2.5, 2.5).translate(0, 66, 0), m.white);
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 30).translate(36, 54, 0), m.metalDark);
    this.crane.add(mast, jib, cab, line);
    this.crane.position.set(-532, uy, -112);
    this.crane.traverse((o) => (o.castShadow = true));
    this.crane.visible = false;
    root.add(this.crane);
  }

  /** Add a site's colliders once construction starts (you can't walk through a building site). */
  private fence(id: string, add: () => void): void {
    if (this.fenced.has(id)) return;
    this.fenced.add(id);
    add();
  }

  update(dt: number, p: ExpansionProgress, daylight: number, night: number, towerLoad: number): void {
    const b = this.b;
    // Third cooling tower.
    if (p.coolingTower3 > 0) {
      const t3 = PLANT_LAYOUT.coolingTower3;
      this.fence('t3', () => b.collision.addCyl(t3.x, t3.z, towerR(0) * t3.scale, b.groundY(t3.x, t3.z) - 1, b.groundY(t3.x, t3.z) + 80));
      this.tower.visible = true;
      this.tower.scale.y = Math.max(0.02, p.coolingTower3);
    }
    this.plume.intensity += ((p.coolingTower3 >= 1 ? towerLoad : 0) - this.plume.intensity) * (1 - Math.exp(-dt / 4));
    this.plume.setLight(daylight);
    this.plume.update(dt);

    // Visitor centre.
    if (p.visitorCentre > 0) {
      const v = PLANT_LAYOUT.visitorCentre;
      this.fence('vc', () => b.collision.addBox(v.cx - v.w / 2, b.groundY(v.cx, v.cz) - 1, v.cz - v.d / 2, v.cx + v.w / 2, b.groundY(v.cx, v.cz) + v.h + 1, v.cz + v.d / 2));
      this.visitor.visible = true;
      this.visitor.scale.y = Math.max(0.05, p.visitorCentre);
      const glass = (this.visitor.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
      glass.emissiveIntensity = p.visitorCentre >= 1 ? night * 1.2 : 0;
    }

    // Unit 2: foundation → walls → dome; the crane works until it's finished.
    const u2 = p.unit2;
    if (u2 > 0) {
      const u = PLANT_LAYOUT.unit2;
      this.fence('u2', () => {
        const y = b.groundY(u.containment.x, u.containment.z);
        b.collision.addCyl(u.containment.x, u.containment.z, u.containment.r, y - 1, y + u.containment.h + u.containment.r);
        b.collision.addBox(u.hall.cx - u.hall.w / 2, y - 1, u.hall.cz - u.hall.d / 2, u.hall.cx + u.hall.w / 2, y + u.hall.h, u.hall.cz + u.hall.d / 2);
        b.collision.addCyl(-532, -112, 1.5, y - 1, y + 70);
      });
      this.u2Pad.visible = true;
      this.u2Pad.scale.y = Math.min(1, u2 / 0.1);
      const walls = Math.min(1, Math.max(0, (u2 - 0.1) / 0.65));
      this.u2Cyl.visible = this.u2Hall.visible = walls > 0;
      this.u2Cyl.scale.y = Math.max(0.01, walls);
      this.u2Hall.scale.y = Math.max(0.01, Math.min(1, walls * 1.3));
      const dome = Math.min(1, Math.max(0, (u2 - 0.75) / 0.25));
      this.u2Dome.visible = dome > 0;
      this.u2Dome.scale.set(1, Math.max(0.01, dome), 1);
      this.crane.visible = u2 < 1;
      if (this.crane.visible) {
        this.craneAngle += dt * 0.15;
        this.crane.rotation.y = Math.sin(this.craneAngle) * 1.2;
      }
    }
  }
}

/** Floating diamond and light beam over the current objective. */
export class Waypoint {
  private readonly group = new THREE.Group();
  private readonly diamond: THREE.Mesh;
  private readonly beam: THREE.Mesh;
  private t = 0;

  constructor(parent: THREE.Object3D) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffcf5a, transparent: true, opacity: 0.9, depthTest: false, fog: false });
    this.diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.6), mat);
    this.diamond.renderOrder = 10;
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffcf5a, transparent: true, opacity: 0.18, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 80, 12, 1, true).translate(0, 40, 0), beamMat);
    this.group.add(this.diamond, this.beam);
    this.group.visible = false;
    parent.add(this.group);
  }

  /** `at` is null to hide. `indoor` hides the tall beam (e.g. inside the control room). */
  update(dt: number, at: { x: number; y: number; z: number; indoor: boolean } | null, playerDist: number): void {
    this.t += dt;
    this.group.visible = at !== null && playerDist > 2.5;
    if (!at) return;
    this.group.position.set(at.x, at.y, at.z);
    this.diamond.position.y = 2 + Math.sin(this.t * 2) * 0.25;
    this.diamond.rotation.y = this.t * 1.5;
    this.beam.visible = !at.indoor;
  }
}
