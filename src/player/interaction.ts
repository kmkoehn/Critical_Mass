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

  /** `enabled` lets the caller limit interaction to where it makes sense (e.g. inside the room). */
  update(camera: THREE.Camera, enabled: boolean): Interactable | null {
    if (!enabled) {
      this.current = null;
      return null;
    }
    this.ray.setFromCamera(this.centre, camera);
    const hit = this.ray.intersectObjects(this.targets, false)[0];
    this.current = (hit?.object.userData.interact as Interactable | undefined) ?? null;
    return this.current;
  }
}
