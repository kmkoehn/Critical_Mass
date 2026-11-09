/**
 * Arcade utility-truck physics: bicycle-model steering, faster on roads,
 * circle collision against the static world, follows terrain and bridge decks,
 * won't drive into deep water. No Three.js here.
 */
import type { CollisionWorld } from '../world/collision';
import type { Heightfield } from '../world/heightfield';
import { WATER_LEVEL, WORLD_LIMIT } from '../world/layout';
import { clamp } from '../util/math';

export const TRUCK = {
  /** Collision circle: about the truck's width, so it fits between lamp posts and through gates. */
  radius: 1.5,
  height: 2.6,
  step: 0.9,
  accel: 7,
  brake: 16,
  coast: 2.5,
  maxRoad: 27,
  maxOffroad: 13,
  maxReverse: 7,
  wheelbase: 3.6,
  maxSteer: 0.6,
  steerRate: 2.5,
  /** Ground deeper than this below the water surface stops the truck. */
  maxWade: 0.7,
};

export interface DriveInput {
  /** +1 accelerate, −1 brake / reverse. */
  throttle: number;
  /** +1 right, −1 left. */
  steer: number;
  handbrake: boolean;
}

export class Vehicle {
  x: number;
  y: number;
  z: number;
  /** Same convention as the player: forward = (−sin yaw, −cos yaw). */
  yaw: number;
  speed = 0;
  steer = 0;
  pitch = 0;
  roll = 0;
  wheelSpin = 0;
  bumped = false;

  constructor(
    private readonly hf: Heightfield,
    private readonly col: CollisionWorld,
    private readonly onRoad: (x: number, z: number) => boolean,
    x: number, z: number, yaw: number,
  ) {
    this.x = x;
    this.z = z;
    this.yaw = yaw;
    this.y = this.groundAt(x, z, hf.heightAt(x, z) + 2);
  }

  private groundAt(x: number, z: number, fromY: number): number {
    return this.col.groundAt(x, z, fromY, TRUCK.step, this.hf.heightAt(x, z));
  }

  get onRoadNow(): boolean {
    return this.onRoad(this.x, this.z);
  }

  update(dt: number, inp: DriveInput): void {
    const T = TRUCK;
    // Steering eases in and is gentler at speed.
    const steerTarget = clamp(inp.steer, -1, 1) / (1 + Math.abs(this.speed) / 18);
    this.steer += clamp(steerTarget - this.steer, -T.steerRate * dt, T.steerRate * dt);

    const max = this.onRoadNow ? T.maxRoad : T.maxOffroad;
    if (inp.handbrake) {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), T.brake * 1.3 * dt);
    } else if (inp.throttle > 0) {
      this.speed += (this.speed < -0.2 ? T.brake : T.accel) * inp.throttle * dt;
    } else if (inp.throttle < 0) {
      this.speed += (this.speed > 0.2 ? -T.brake : -T.accel * 0.7) * -inp.throttle * dt;
    } else {
      this.speed -= Math.sign(this.speed) * Math.min(Math.abs(this.speed), T.coast * dt);
    }
    // Over the limit (e.g. leaving the road): bleed speed off quickly.
    if (this.speed > max) this.speed = Math.max(max, this.speed - 10 * dt);
    this.speed = clamp(this.speed, -T.maxReverse, T.maxRoad);

    const steps = clamp(Math.ceil((Math.abs(this.speed) * dt) / 0.4), 1, 10);
    const h = dt / steps;
    this.bumped = false;
    for (let i = 0; i < steps; i++) {
      this.yaw -= (this.speed / T.wheelbase) * Math.tan(this.steer * T.maxSteer) * h;
      const nx = this.x - Math.sin(this.yaw) * this.speed * h;
      const nz = this.z - Math.cos(this.yaw) * this.speed * h;
      const pos = { x: nx, y: this.y, z: nz };
      if (this.col.resolve(pos, T.radius, T.height, T.step)) {
        this.bumped = true;
        this.speed *= 0.6;
      }
      pos.x = clamp(pos.x, -WORLD_LIMIT, WORLD_LIMIT);
      pos.z = clamp(pos.z, -WORLD_LIMIT, WORLD_LIMIT);
      const g = this.groundAt(pos.x, pos.z, this.y + 0.5);
      // Too deep: the truck stops at the water's edge.
      if (g < WATER_LEVEL - T.maxWade) {
        this.speed = 0;
        continue;
      }
      // Too steep a step up (wall the colliders missed): stop.
      if (g - this.y > T.step + 0.3) {
        this.speed = 0;
        continue;
      }
      this.x = pos.x;
      this.z = pos.z;
      this.y = g;
    }
    this.wheelSpin += (this.speed / 0.5) * dt;

    // Pitch and roll from the ground under the wheels.
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const at = (dx: number, dz: number) => this.groundAt(this.x + dx, this.z + dz, this.y + 1);
    const front = at(fx * 1.8, fz * 1.8);
    const back = at(-fx * 1.8, -fz * 1.8);
    const right = at(rx, rz);
    const left = at(-rx, -rz);
    const k = 1 - Math.exp(-10 * dt);
    this.pitch += (Math.atan2(front - back, 3.6) - this.pitch) * k;
    this.roll += (Math.atan2(right - left, 2) - this.roll) * k;
  }

  /** Where the driver steps out (left side), or null if both sides are blocked. */
  exitPoint(): { x: number; z: number } | null {
    for (const side of [-1, 1]) {
      const x = this.x + Math.cos(this.yaw) * 2.8 * side;
      const z = this.z - Math.sin(this.yaw) * 2.8 * side;
      const pos = { x, y: this.y, z };
      if (!this.col.resolve(pos, 0.45, 1.8, 0.5) && this.hf.heightAt(x, z) > WATER_LEVEL - 1) return { x, z };
    }
    return null;
  }
}
