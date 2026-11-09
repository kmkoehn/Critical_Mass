/**
 * Unit 1 control room interior: consoles with live screens, the annunciator wall
 * and the trend recorder. Each console is an interactable that opens a panel.
 */
import * as THREE from 'three';
import type { WorldBuilder } from './builder';
import { PLANT_LAYOUT } from './layout';

export type PanelId = 'reactor' | 'primary' | 'turbine' | 'cooling' | 'annunciator' | 'trends';

export interface Interactable {
  panelId: PanelId;
  label: string;
}

export interface Screen {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
}

export interface ControlRoomHandles {
  /** Meshes the interaction raycast tests against (userData.interact: Interactable). */
  interactables: THREE.Object3D[];
  screens: Record<PanelId, Screen>;
  floorY: number;
  /** Where a player stands to use the reactor console (for tests / tutorial markers). */
  stations: Record<PanelId, { x: number; z: number; yaw: number }>;
}

function makeScreen(w: number, h: number): Screen {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return { canvas, ctx, texture };
}

function screenMaterial(s: Screen): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ map: s.texture, toneMapped: false });
}

export function buildControlRoom(b: WorldBuilder, floorY: number): ControlRoomHandles {
  const L = PLANT_LAYOUT.controlRoom;
  const m = b.mats;
  const x0 = L.cx - L.w / 2 + 0.4;
  const x1 = L.cx + L.w / 2 - 0.4;
  const z1 = L.cz + L.d / 2 - 0.4;
  const interactables: THREE.Object3D[] = [];

  const consoleBody = new THREE.MeshStandardMaterial({ color: 0x7d8679, roughness: 0.7, metalness: 0.15 });
  const consoleTop = new THREE.MeshStandardMaterial({ color: 0x3b4140, roughness: 0.6 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x23272a, roughness: 0.5 });

  const screens = {
    reactor: makeScreen(512, 320),
    primary: makeScreen(512, 320),
    turbine: makeScreen(512, 320),
    cooling: makeScreen(512, 320),
    trends: makeScreen(768, 440),
    annunciator: makeScreen(1400, 260),
  } satisfies Record<PanelId, Screen>;

  const tag = (obj: THREE.Object3D, panelId: PanelId, label: string) => {
    obj.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.userData.interact = { panelId, label } satisfies Interactable;
        interactables.push(o);
      }
    });
  };

  /**
   * A console. Local frame: operator stands at -Z looking +Z; desk at z 0..0.9,
   * upright panel behind. `yaw` rotates it to face other directions.
   */
  const addConsole = (x: number, z: number, width: number, yaw: number, panelId: PanelId, label: string) => {
    const g = new THREE.Group();
    const desk = new THREE.Mesh(new THREE.BoxGeometry(width, 0.95, 0.9), consoleBody);
    desk.position.set(0, 0.475, 0.45);
    const deskTop = new THREE.Mesh(new THREE.BoxGeometry(width + 0.04, 0.05, 0.94), consoleTop);
    deskTop.position.set(0, 0.97, 0.45);
    deskTop.rotation.x = -0.12;
    const upright = new THREE.Mesh(new THREE.BoxGeometry(width, 1.45, 0.3), consoleBody);
    upright.position.set(0, 1.0 + 0.725, 1.05);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(width + 0.06, 0.06, 0.4), trim);
    cap.position.set(0, 2.48, 1.05);
    const scr = new THREE.Mesh(new THREE.PlaneGeometry(Math.min(width * 0.8, 1.9), 1.15), screenMaterial(screens[panelId]));
    scr.position.set(0, 1.72, 0.895);
    scr.rotation.y = Math.PI;
    // Little indicator lamps along the desk.
    const lampGeo = new THREE.BoxGeometry(0.08, 0.03, 0.08);
    const lampMats = [0x3ad06a, 0xd0a23a, 0xd04a3a].map((c) => new THREE.MeshBasicMaterial({ color: c }));
    for (let i = 0; i < Math.floor(width / 0.3); i++) {
      const lamp = new THREE.Mesh(lampGeo, lampMats[i % 3]);
      lamp.position.set(-width / 2 + 0.25 + i * 0.3, 1.0, 0.2);
      g.add(lamp);
    }
    g.add(desk, deskTop, upright, cap, scr);
    g.position.set(x, floorY, z);
    g.rotation.y = yaw;
    g.traverse((o) => {
      o.castShadow = true;
      o.receiveShadow = true;
    });
    b.root.add(g);
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(g);
    b.collision.addBox(box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z);
    tag(g, panelId, label);
  };

  // Main horseshoe board facing south (+Z): primary loop | reactor | turbine.
  const boardZ = L.cz + 2;
  addConsole(L.cx - 7.5, boardZ, 5.5, 0, 'primary', 'Primary Loop Panel');
  addConsole(L.cx, boardZ, 7, 0, 'reactor', 'Reactor Control Panel');
  addConsole(L.cx + 7.5, boardZ, 5.5, 0, 'turbine', 'Turbine & Grid Panel');
  // Circulating water console against the east wall, operator facing east.
  addConsole(x1 - 1.3, L.cz - 3.5, 4.5, Math.PI / 2, 'cooling', 'Cooling Water Panel');

  // Annunciator wall on the south wall, above the board.
  {
    const scr = screens.annunciator;
    const w = 20;
    const h = (w * scr.canvas.height) / scr.canvas.width;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), screenMaterial(scr));
    mesh.position.set(L.cx, floorY + 4.6, z1 - 0.12);
    mesh.rotation.y = Math.PI;
    b.root.add(mesh);
    const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, h + 0.4, 0.1), trim);
    frameMesh.position.set(L.cx, floorY + 4.6, z1 - 0.01);
    b.root.add(frameMesh);
    // Acknowledge station: a small desk under the wall.
    const ack = new THREE.Mesh(new THREE.BoxGeometry(3, 1.1, 0.8), consoleBody);
    ack.position.set(L.cx, floorY + 0.55, z1 - 0.6);
    ack.castShadow = ack.receiveShadow = true;
    b.root.add(ack);
    b.collision.addBox(L.cx - 1.5, floorY, z1 - 1.0, L.cx + 1.5, floorY + 1.1, z1 - 0.2);
    tag(mesh, 'annunciator', 'Annunciator Wall');
    tag(ack, 'annunciator', 'Alarm Acknowledge Station');
  }

  // Trend recorder screen on the west wall, facing east.
  {
    const scr = screens.trends;
    const w = 5.2;
    const h = (w * scr.canvas.height) / scr.canvas.width;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), screenMaterial(scr));
    mesh.position.set(x0 + 0.12, floorY + 2.4, L.cz - 3.5);
    mesh.rotation.y = Math.PI / 2;
    b.root.add(mesh);
    const frameMesh = new THREE.Mesh(new THREE.BoxGeometry(0.1, h + 0.3, w + 0.3), trim);
    frameMesh.position.set(x0 + 0.02, floorY + 2.4, L.cz - 3.5);
    b.root.add(frameMesh);
    tag(mesh, 'trends', 'Trend Recorder');
  }

  // Shift supervisor desk (decor).
  b.box(L.cx - 10.6, floorY, L.cz - 7.0, L.cx - 7.4, floorY + 0.78, L.cz - 6.0, m.wood, { map: false });

  // Ceiling light panels.
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xfff6e6 });
  for (const dx of [-8, 0, 8]) {
    for (const dz of [-4, 3]) {
      const p = new THREE.Mesh(new THREE.PlaneGeometry(3, 0.8), lightMat);
      p.rotation.x = Math.PI / 2;
      p.position.set(L.cx + dx, floorY + L.h - 0.06, L.cz + dz);
      b.root.add(p);
    }
  }

  const stations: ControlRoomHandles['stations'] = {
    reactor: { x: L.cx, z: boardZ - 1.4, yaw: Math.PI },
    primary: { x: L.cx - 7.5, z: boardZ - 1.4, yaw: Math.PI },
    turbine: { x: L.cx + 7.5, z: boardZ - 1.4, yaw: Math.PI },
    cooling: { x: x1 - 2.8, z: L.cz - 3.5, yaw: -Math.PI / 2 },
    annunciator: { x: L.cx, z: z1 - 2.2, yaw: Math.PI },
    trends: { x: x0 + 2.5, z: L.cz - 3.5, yaw: Math.PI / 2 },
  };

  return { interactables, screens, floorY, stations };
}
