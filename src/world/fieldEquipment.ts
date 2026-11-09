/** Repairable field equipment: river intake pier, feed valve, pump service panel, fan controls, fuel-pad monitor. */
import * as THREE from 'three';
import type { WorldBuilder } from './builder';
import { FIELD_POINTS, INTAKE, WATER_LEVEL } from './layout';

export interface FieldEquipmentHandles {
  /** Debris floating against the intake screens (shown while clogged). */
  intakeDebris: THREE.Group;
}

export function buildFieldEquipment(b: WorldBuilder): FieldEquipmentHandles {
  const m = b.mats;

  // ---------------------------------------------------------------- river intake pier
  const deckY = b.groundY(INTAKE.x0, INTAKE.cz);
  const z0 = INTAKE.cz - INTAKE.halfZ;
  const z1 = INTAKE.cz + INTAKE.halfZ;
  b.box(INTAKE.x0, deckY - 0.6, z0, INTAKE.x1, deckY, z1, m.concrete, { map: '#8d8c86' });
  // Piers down to the river bed.
  for (let x = INTAKE.x0 + 8; x < INTAKE.x1; x += 9) {
    for (const z of [z0 + 1, z1 - 1]) b.box(x - 0.6, WATER_LEVEL - 5, z - 0.6, x + 0.6, deckY - 0.6, z + 0.6, m.concreteDark, { map: false });
  }
  // Railings and the trash-rack screen at the river end.
  const ry = deckY + 1.1;
  b.box(INTAKE.x0, deckY, z0, INTAKE.x1, ry, z0 + 0.1, m.fence, { map: false, castShadow: false });
  b.box(INTAKE.x0, deckY, z1 - 0.1, INTAKE.x1, ry, z1, m.fence, { map: false, castShadow: false });
  b.box(INTAKE.x1 - 0.15, WATER_LEVEL - 4, z0, INTAKE.x1, ry, z1, m.fence, { map: false, castShadow: false });
  b.cabinet('intake', FIELD_POINTS.intake.x, FIELD_POINTS.intake.z + 3, 1.4, 1.6, 0.7, deckY);

  const debris = new THREE.Group();
  const debrisMat = new THREE.MeshStandardMaterial({ color: 0x5a4630, roughness: 1 });
  for (let i = 0; i < 14; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 2 + (i % 4), 6), debrisMat);
    log.rotation.z = Math.PI / 2;
    log.rotation.y = (i * 1.37) % Math.PI;
    log.position.set(INTAKE.x1 + 1 + (i % 3) * 1.4, WATER_LEVEL + 0.05, z0 + 1 + ((i * 1.9) % (z1 - z0 - 2)));
    debris.add(log);
  }
  debris.visible = false;
  b.root.add(debris);

  // ---------------------------------------------------------------- turbine hall feed valve FW-3B
  {
    const p = FIELD_POINTS.fwValve;
    const y = b.groundY(p.x, p.z) + 0.05;
    const g = new THREE.Group();
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 8, 12), m.metal);
    pipe.rotation.z = Math.PI / 2;
    pipe.position.set(0, 1.1, -0.8);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), m.metalDark);
    body.position.set(0, 1.1, -0.8);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.7, 8), m.metal);
    stem.rotation.x = Math.PI / 2;
    stem.position.set(0, 1.1, -0.1);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 8, 24), m.safetyYellow);
    wheel.position.set(0, 1.1, 0.25);
    g.add(pipe, body, stem, wheel);
    g.position.set(p.x, y, p.z);
    g.traverse((o) => (o.castShadow = true));
    b.root.add(g);
    b.collision.addBox(p.x - 4, y, p.z - 1.4, p.x + 4, y + 1.5, p.z - 0.2);
    b.fieldPoint('fwValve', g);
    b.beacon('fwValve', p.x, y + 1.9, p.z - 0.8);
  }

  // ---------------------------------------------------------------- RCP motor service panel (containment access)
  b.cabinet('rcp', FIELD_POINTS.rcp.x - 0.05, FIELD_POINTS.rcp.z, 0.3, 2.0, 2.2);

  // ---------------------------------------------------------------- cooling tower fan controls
  b.cabinet('fan:0', FIELD_POINTS['fan:0'].x, FIELD_POINTS['fan:0'].z);
  b.cabinet('fan:1', FIELD_POINTS['fan:1'].x, FIELD_POINTS['fan:1'].z);

  // ---------------------------------------------------------------- fuel pad radiation monitor
  b.cabinet('spentFuel', FIELD_POINTS.spentFuel.x, FIELD_POINTS.spentFuel.z, 0.6, 1.8, 1.0);

  return { intakeDebris: debris };
}
