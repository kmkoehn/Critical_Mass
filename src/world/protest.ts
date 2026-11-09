/** A crowd of protesters with placards outside the plant gate (shown when public opinion is low). */
import * as THREE from 'three';
import type { Heightfield } from './heightfield';
import { PLANT_LAYOUT } from './layout';
import { Rng } from '../util/rng';

const SLOGANS = ['NO MORE BLACKOUTS', 'SAFETY FIRST', 'KEEP MILLBROOK LIT', 'WHO RUNS THIS PLACE?', 'OUR RIVER', 'SHUT IT DOWN'];

function placardTexture(text: string): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#f2ede0';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#b3261e';
  g.font = '700 30px Bahnschrift, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const words = text.split(' ');
  const mid = Math.ceil(words.length / 2);
  g.fillText(words.slice(0, mid).join(' '), 128, 44);
  g.fillText(words.slice(mid).join(' '), 128, 86);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ProtestCrowd {
  readonly group = new THREE.Group();
  private readonly people: Array<{ obj: THREE.Object3D; phase: number; baseY: number }> = [];
  private t = 0;

  constructor(parent: THREE.Object3D, hf: Heightfield) {
    const rng = new Rng(808);
    const gate = PLANT_LAYOUT.gate;
    const clothes = [0x3d5a80, 0x9c4f2f, 0x4f6d3a, 0x6b4e71, 0x8a8a8a, 0x2f3e46].map((c) => new THREE.MeshStandardMaterial({ color: c }));
    const skin = new THREE.MeshStandardMaterial({ color: 0xc89f7c });
    const pole = new THREE.MeshStandardMaterial({ color: 0x6b4f33 });
    const signs = SLOGANS.map((s) => new THREE.MeshStandardMaterial({ map: placardTexture(s), side: THREE.DoubleSide }));
    const bodyGeo = new THREE.CapsuleGeometry(0.28, 0.9, 4, 8);
    const headGeo = new THREE.SphereGeometry(0.17, 10, 8);
    const poleGeo = new THREE.CylinderGeometry(0.03, 0.03, 1.4, 6);
    const signGeo = new THREE.PlaneGeometry(1.0, 0.5);
    for (let i = 0; i < 16; i++) {
      // Spread along the access road, just outside the gate (east of the fence).
      const x = gate.x + 6 + rng.float(0, 14);
      const z = gate.z + rng.float(-9, 9);
      const y = hf.heightAt(x, z);
      const p = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, rng.pick(clothes));
      body.position.y = 0.73;
      const head = new THREE.Mesh(headGeo, skin);
      head.position.y = 1.48;
      p.add(body, head);
      if (i % 2 === 0) {
        const pl = new THREE.Mesh(poleGeo, pole);
        pl.position.set(0.3, 1.5, 0);
        const sign = new THREE.Mesh(signGeo, rng.pick(signs));
        sign.position.set(0.3, 2.25, 0);
        p.add(pl, sign);
      }
      // Face the gate.
      p.rotation.y = Math.atan2(gate.x - x, gate.z - z) + Math.PI;
      p.position.set(x, y, z);
      p.traverse((o) => (o.castShadow = true));
      this.group.add(p);
      this.people.push({ obj: p, phase: rng.float(0, Math.PI * 2), baseY: y });
    }
    this.group.visible = false;
    parent.add(this.group);
  }

  update(dt: number, visible: boolean): void {
    this.group.visible = visible;
    if (!visible) return;
    this.t += dt;
    for (const p of this.people) p.obj.position.y = p.baseY + Math.max(0, Math.sin(this.t * 3 + p.phase)) * 0.12;
  }
}
