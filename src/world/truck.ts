/** The utility truck's model: cab, flatbed with tool boxes, light bar, spinning wheels, headlights. */
import * as THREE from 'three';
import type { Vehicle } from '../player/vehicle';

export class TruckModel {
  readonly group = new THREE.Group();
  private readonly wheels: THREE.Mesh[] = [];
  private readonly lightBar: THREE.MeshStandardMaterial;
  private readonly headlamps: THREE.MeshStandardMaterial;
  private readonly spot: THREE.SpotLight;
  private flash = 0;

  constructor(parent: THREE.Object3D) {
    const paint = new THREE.MeshStandardMaterial({ color: 0xe7e3d6, roughness: 0.5, metalness: 0.2 });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xd8731e, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x24282c, roughness: 0.8 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.1, metalness: 0.5 });
    this.lightBar = new THREE.MeshStandardMaterial({ color: 0x553300, emissive: 0xffa020, emissiveIntensity: 0 });
    this.headlamps = new THREE.MeshStandardMaterial({ color: 0xdddddd, emissive: 0xfff2d0, emissiveIntensity: 0 });

    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      this.group.add(mesh);
      return mesh;
    };
    // Model faces −Z (forward).
    add(new THREE.BoxGeometry(2.3, 0.5, 6.2), dark, 0, 0.75, 0); // chassis
    add(new THREE.BoxGeometry(2.3, 1.5, 2.1), paint, 0, 1.75, -1.9); // cab
    add(new THREE.BoxGeometry(2.32, 0.25, 2.12), stripe, 0, 1.25, -1.9);
    add(new THREE.BoxGeometry(2.1, 0.7, 0.05), glass, 0, 2.1, -2.96); // windscreen
    add(new THREE.BoxGeometry(2.3, 0.35, 3.8), paint, 0, 1.15, 1.2); // bed
    add(new THREE.BoxGeometry(0.5, 0.8, 3.6), stripe, -0.9, 1.7, 1.2); // tool boxes
    add(new THREE.BoxGeometry(0.5, 0.8, 3.6), stripe, 0.9, 1.7, 1.2);
    add(new THREE.BoxGeometry(1.6, 0.18, 0.35), this.lightBar, 0, 2.6, -1.6);
    for (const x of [-0.75, 0.75]) add(new THREE.BoxGeometry(0.4, 0.2, 0.05), this.headlamps, x, 1.2, -3.12);
    const wheelGeo = new THREE.CylinderGeometry(0.5, 0.5, 0.4, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    for (const [x, z] of [[-1.15, -2], [1.15, -2], [-1.15, 1.9], [1.15, 1.9]]) {
      this.wheels.push(add(wheelGeo, dark, x, 0.5, z));
    }
    this.spot = new THREE.SpotLight(0xfff2d0, 0, 60, 0.55, 0.5, 1.2);
    this.spot.position.set(0, 1.3, -3);
    this.spot.target.position.set(0, -2, -20);
    this.group.add(this.spot, this.spot.target);
    this.group.rotation.order = 'YXZ';
    parent.add(this.group);
  }

  update(v: Vehicle, dt: number, night: number, occupied: boolean): void {
    this.group.position.set(v.x, v.y, v.z);
    this.group.rotation.set(v.pitch, v.yaw, v.roll);
    this.wheels.forEach((w, i) => {
      w.rotation.x = -v.wheelSpin;
      if (i < 2) w.rotation.y = -v.steer * 0.5;
    });
    this.flash += dt;
    this.lightBar.emissiveIntensity = occupied ? (Math.floor(this.flash * 3) % 2 ? 2.5 : 0.3) : 0;
    const lamps = occupied ? night : 0;
    this.headlamps.emissiveIntensity = lamps * 3;
    this.spot.intensity = lamps * 120;
  }
}
