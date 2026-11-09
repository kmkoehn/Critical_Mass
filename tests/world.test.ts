import { describe, expect, it } from 'vitest';
import { CollisionWorld } from '../src/world/collision';
import { Heightfield, createTerrainFunction } from '../src/world/heightfield';
import { BRIDGE, PLANT, TOWN, WATER_LEVEL, riverX, zoneNameAt } from '../src/world/layout';
import { PlayerController } from '../src/player/controller';

const hf = new Heightfield();
const idle = { forward: 0, strafe: 0, jump: false, sprint: false, crouch: false, lookDX: 0, lookDY: 0 };

describe('terrain', () => {
  it('is deterministic for a given seed', () => {
    const a = createTerrainFunction(1);
    const b = createTerrainFunction(1);
    expect(a(123.4, -567.8)).toBe(b(123.4, -567.8));
  });

  it('heightAt matches the grid exactly at vertices', () => {
    for (const [i, j] of [[0, 0], [10, 20], [160, 160], [319, 7]]) {
      const x = hf.origin + i * hf.cell;
      const z = hf.origin + j * hf.cell;
      expect(hf.heightAt(x, z)).toBeCloseTo(hf.vertex(i, j), 5);
    }
  });

  it('keeps the river below water and the building pads flat', () => {
    for (const z of [-600, -200, 0, 300, 700]) expect(hf.heightAt(riverX(z), z)).toBeLessThan(WATER_LEVEL - 2);
    expect(hf.heightAt(PLANT.cx, PLANT.cz)).toBeCloseTo(PLANT.elev, 1);
    expect(hf.heightAt(TOWN.cx, TOWN.cz)).toBeCloseTo(TOWN.elev, 1);
  });

  it('meets the bridge deck at both abutments', () => {
    for (const x of [BRIDGE.x0 - 2, BRIDGE.x1 + 2]) {
      expect(Math.abs(hf.heightAt(x, BRIDGE.z) - BRIDGE.deckTop)).toBeLessThan(0.5);
    }
  });

  it('names zones', () => {
    expect(zoneNameAt(PLANT.cx, PLANT.cz)).toMatch(/Riverbend/);
    expect(zoneNameAt(TOWN.cx, TOWN.cz)).toBe('Millbrook');
  });
});

describe('collision', () => {
  it('pushes a player out of a wall', () => {
    const w = new CollisionWorld();
    w.addBox(0, 0, -5, 1, 3, 5);
    const p = { x: 1.2, y: 0, z: 0 };
    expect(w.resolve(p, 0.4, 1.8, 0.5)).toBe(true);
    expect(p.x).toBeCloseTo(1.4, 5);
  });

  it('lets low obstacles be stepped onto and reports their top as ground', () => {
    const w = new CollisionWorld();
    w.addBox(0, 0, 0, 2, 0.4, 2);
    const p = { x: -0.2, y: 0, z: 1 };
    expect(w.resolve(p, 0.4, 1.8, 0.5)).toBe(false);
    expect(w.groundAt(1, 1, 0, 0.5, 0)).toBeCloseTo(0.4);
    expect(w.groundAt(1, 1, -1, 0.5, 0)).toBe(0); // out of reach from below
  });

  it('blocks cylinders', () => {
    const w = new CollisionWorld();
    w.addCyl(0, 0, 2, 0, 10);
    const p = { x: 2.1, y: 0, z: 0 };
    w.resolve(p, 0.4, 1.8, 0.5);
    expect(p.x).toBeCloseTo(2.4, 5);
  });
});

describe('player controller', () => {
  it('walks forward on flat ground and stays grounded', () => {
    const pc = new PlayerController(hf, new CollisionWorld());
    pc.spawn(TOWN.cx, TOWN.cz, 0); // facing north (-Z)
    for (let i = 0; i < 60; i++) pc.update(1 / 60, { ...idle, forward: 1 });
    expect(pc.pos.z).toBeLessThan(TOWN.cz - 3);
    expect(pc.onGround).toBe(true);
    expect(pc.pos.y).toBeCloseTo(TOWN.elev, 1);
  });

  it('floats when it walks into deep river water', () => {
    const pc = new PlayerController(hf, new CollisionWorld());
    pc.spawn(riverX(-400), -400, 0);
    pc.update(1 / 60, idle);
    expect(pc.swimming).toBe(true);
    expect(pc.pos.y).toBeGreaterThan(WATER_LEVEL - 2);
  });
});
