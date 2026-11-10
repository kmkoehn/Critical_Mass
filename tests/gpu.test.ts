import { describe, expect, it } from 'vitest';
import { ResolutionGovernor, cleanName } from '../src/ui/gpu';

describe('GPU names', () => {
  it('tidy the ANGLE strings Chrome reports', () => {
    expect(cleanName('ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('NVIDIA GeForce RTX 5090');
    expect(cleanName('ANGLE (Intel, Intel(R) UHD Graphics 770 (0x00004680) Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe('Intel(R) UHD Graphics 770');
    expect(cleanName('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toMatch(/SwiftShader/);
    expect(cleanName('Apple M2')).toBe('Apple M2');
  });
});

describe('resolution governor', () => {
  const run = (g: ResolutionGovernor, fps: number, seconds: number) => {
    for (let t = 0; t < seconds; t += 1 / fps) g.frame(1 / fps);
  };

  it('drops resolution when the frame rate is low, down to a floor', () => {
    const g = new ResolutionGovernor();
    run(g, 12, 30);
    expect(g.scale).toBe(0.5);
  });

  it('leaves a smooth game alone and recovers once frames are fast again', () => {
    const g = new ResolutionGovernor();
    run(g, 60, 20);
    expect(g.scale).toBe(1);
    run(g, 25, 8);
    expect(g.scale).toBeLessThan(1);
    run(g, 144, 60);
    expect(g.scale).toBe(1);
  });

  it('holds steady in the comfortable band (no oscillation at 50 fps)', () => {
    const g = new ResolutionGovernor();
    g.scale = 0.8;
    run(g, 50, 30);
    expect(g.scale).toBe(0.8);
  });
});
