/**
 * First-person walker: vertical-cylinder body, terrain + collider ground,
 * step-up, ground snapping, swimming and a debug noclip mode.
 * No Three.js here — the camera just reads pos/yaw/pitch.
 */
import type { CollisionWorld } from '../world/collision';
import type { Heightfield } from '../world/heightfield';
import { WATER_LEVEL, WORLD_LIMIT } from '../world/layout';
import { clamp } from '../util/math';

export const PLAYER = {
  radius: 0.4,
  standHeight: 1.8,
  crouchHeight: 1.15,
  eyeBelowTop: 0.12,
  step: 0.55,
  walk: 4.6,
  sprint: 8.5,
  crouch: 2.2,
  swim: 2.6,
  jump: 6.2,
  gravity: 22,
  /** Feet depth below the surface while swimming. */
  swimDepth: 1.3,
  sensitivity: 0.0022,
  noclip: 45,
};

export interface ControlInput {
  forward: number;
  strafe: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  lookDX: number;
  lookDY: number;
}

export class PlayerController {
  readonly pos = { x: 0, y: 0, z: 0 };
  readonly vel = { x: 0, y: 0, z: 0 };
  yaw = 0;
  pitch = 0;
  onGround = false;
  crouching = false;
  swimming = false;
  noclip = false;
  sensitivity = PLAYER.sensitivity;
  private height = PLAYER.standHeight;
  private eye = PLAYER.standHeight - PLAYER.eyeBelowTop;

  constructor(private readonly hf: Heightfield, private readonly col: CollisionWorld) {}

  /**
   * Place the player on the highest walkable surface at or below `probeY`
   * (default: just above the terrain, so indoors you land on the floor, not the roof).
   */
  spawn(x: number, z: number, yaw: number, probeY?: number): void {
    const terrain = this.hf.heightAt(x, z);
    this.pos.x = x;
    this.pos.z = z;
    this.pos.y = this.col.groundAt(x, z, probeY ?? terrain + 1, 0.6, terrain);
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.yaw = yaw;
    this.pitch = 0;
    this.onGround = true;
  }

  get eyeY(): number {
    return this.pos.y + this.eye;
  }

  update(dt: number, inp: ControlInput): void {
    this.yaw -= inp.lookDX * this.sensitivity;
    this.pitch = clamp(this.pitch - inp.lookDY * this.sensitivity, -1.5, 1.5);

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    let wx = -sin * inp.forward + cos * inp.strafe;
    let wz = -cos * inp.forward - sin * inp.strafe;
    const wl = Math.hypot(wx, wz);
    if (wl > 1) {
      wx /= wl;
      wz /= wl;
    }

    if (this.noclip) {
      this.flyUpdate(dt, inp, sin, cos);
      return;
    }

    // Crouch (only stand up if there is headroom).
    if (inp.crouch) this.crouching = true;
    else if (this.crouching && this.col.ceilingAt(this.pos.x, this.pos.z, this.pos.y, PLAYER.standHeight) === Infinity) {
      this.crouching = false;
    }
    this.height = this.crouching ? PLAYER.crouchHeight : PLAYER.standHeight;
    const eyeTarget = this.height - PLAYER.eyeBelowTop;
    this.eye += (eyeTarget - this.eye) * (1 - Math.exp(-14 * dt));

    const speed = this.swimming
      ? PLAYER.swim
      : this.crouching
        ? PLAYER.crouch
        : inp.sprint && inp.forward > 0
          ? PLAYER.sprint
          : PLAYER.walk;
    const accel = this.onGround || this.swimming ? 14 : 2.5;
    const k = 1 - Math.exp(-accel * dt);
    this.vel.x += (wx * speed - this.vel.x) * k;
    this.vel.z += (wz * speed - this.vel.z) * k;

    if (this.swimming) {
      this.vel.y = 0;
    } else {
      if (this.onGround && inp.jump) {
        this.vel.y = PLAYER.jump;
        this.onGround = false;
      }
      this.vel.y -= PLAYER.gravity * dt;
    }

    const travel = Math.hypot(this.vel.x, this.vel.y, this.vel.z) * dt;
    const steps = clamp(Math.ceil(travel / 0.25), 1, 8);
    const h = dt / steps;
    const floatY = WATER_LEVEL - PLAYER.swimDepth;
    const p = this.pos;

    for (let s = 0; s < steps; s++) {
      const wasGrounded = this.onGround;
      p.x += this.vel.x * h;
      p.z += this.vel.z * h;
      this.col.resolve(p, PLAYER.radius, this.height, PLAYER.step);
      p.x = clamp(p.x, -WORLD_LIMIT, WORLD_LIMIT);
      p.z = clamp(p.z, -WORLD_LIMIT, WORLD_LIMIT);
      p.y += this.vel.y * h;

      let ground = this.col.groundAt(p.x, p.z, p.y, PLAYER.step, this.hf.heightAt(p.x, p.z));
      this.swimming = ground < floatY;
      if (this.swimming) ground = floatY;

      if (p.y <= ground) {
        p.y = ground;
        if (this.vel.y < 0) this.vel.y = 0;
        this.onGround = true;
      } else if (wasGrounded && this.vel.y <= 0 && p.y - ground < 0.65) {
        // Stick to the ground when walking downhill or down steps.
        p.y = ground;
        this.vel.y = 0;
        this.onGround = true;
      } else {
        this.onGround = false;
      }

      const ceil = this.col.ceilingAt(p.x, p.z, p.y, this.height);
      if (ceil !== Infinity && this.vel.y > 0) {
        p.y = Math.max(ground, ceil - this.height);
        this.vel.y = 0;
      }
    }
  }

  private flyUpdate(dt: number, inp: ControlInput, sin: number, cos: number): void {
    const speed = PLAYER.noclip * (inp.sprint ? 3 : 1);
    const cp = Math.cos(this.pitch);
    const fx = -sin * cp, fy = Math.sin(this.pitch), fz = -cos * cp;
    const rx = cos, rz = -sin;
    this.pos.x += (fx * inp.forward + rx * inp.strafe) * speed * dt;
    this.pos.y += (fy * inp.forward + (inp.jump ? 1 : 0) - (inp.crouch ? 1 : 0)) * speed * dt;
    this.pos.z += (fz * inp.forward + rz * inp.strafe) * speed * dt;
    this.pos.y = Math.max(this.pos.y, this.hf.heightAt(this.pos.x, this.pos.z));
    this.vel.x = this.vel.y = this.vel.z = 0;
  }
}
