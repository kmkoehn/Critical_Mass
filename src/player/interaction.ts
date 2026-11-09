/** Crosshair raycast against interactable objects. */
import * as THREE from 'three';
import type { Interactable } from '../world/controlRoom';

export class Interactor {
  private readonly ray = new THREE.Raycaster();
  private readonly centre = new THREE.Vector2(0, 0);
  current: Interactable | null = null;

  constructor(private readonly targets: THREE.Object3D[], maxDistance = 4.5) {
    this.ray.far = maxDistance;
  }

  /** `allow` filters what may be used right now (e.g. control-room panels only from inside the room). */
  update(camera: THREE.Camera, allow: (i: Interactable) => boolean): Interactable | null {
    this.ray.setFromCamera(this.centre, camera);
    const hit = this.ray.intersectObjects(this.targets, false)[0];
    const it = (hit?.object.userData.interact as Interactable | undefined) ?? null;
    this.current = it && allow(it) ? it : null;
    return this.current;
  }
}
