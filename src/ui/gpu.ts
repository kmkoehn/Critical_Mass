/**
 * What is actually drawing the game, and a dynamic-resolution governor for slow machines.
 */

/** Renderer names that mean the browser is drawing WebGL on the CPU. */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic|mesa offscreen/i;

export interface GpuInfo {
  /** e.g. "NVIDIA GeForce RTX 4070" (cleaned up from the ANGLE string). */
  name: string;
  /** The raw string the browser reported. */
  raw: string;
  software: boolean;
}

export function describeGpu(gl: WebGLRenderingContext | WebGL2RenderingContext): GpuInfo {
  let raw = '';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    raw = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  } catch {
    raw = 'unknown';
  }
  return { name: cleanName(raw), raw, software: SOFTWARE.test(raw) };
}

/** "ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 (0x00002B85) Direct3D11 vs_5_0 ps_5_0, D3D11)" → "NVIDIA GeForce RTX 5090". */
export function cleanName(raw: string): string {
  const inner = /^ANGLE \((.*)\)$/i.exec(raw.trim())?.[1];
  if (!inner) return raw.trim() || 'unknown';
  const parts = inner.split(', ');
  const name = (parts[1] ?? parts[0])
    .replace(/\s*\(0x[0-9a-f]+\)/i, '')
    .replace(/\s+(Direct3D|OpenGL|Vulkan|Metal).*$/i, '')
    .trim();
  return name || 'unknown';
}

export const SOFTWARE_WARNING =
  'Chrome is drawing this game without your graphics card (software rendering), which makes it very slow. ' +
  'Turn on Settings → System → "Use graphics acceleration when available", then restart Chrome. ' +
  'chrome://gpu shows what Chrome is using.';

/**
 * Dynamic resolution: when frames take too long, render fewer pixels; when there's headroom,
 * creep back up. Hysteresis and a settling delay stop it from oscillating.
 */
export class ResolutionGovernor {
  /** Fraction of the quality level's pixel ratio, 0.5..1. */
  scale = 1;
  private acc = 0;
  private frames = 0;
  private cooldown = 2;

  constructor(readonly min = 0.5, readonly max = 1) {}

  /**
   * Feed one frame's duration (seconds). Returns the new scale when it changes, else null.
   * Only call while the game is visibly running (hidden tabs report throttled frame times).
   */
  frame(dt: number): number | null {
    this.cooldown -= dt;
    this.acc += dt;
    this.frames++;
    if (this.acc < 1.5) return null;
    const avg = this.acc / this.frames;
    this.acc = 0;
    this.frames = 0;
    if (this.cooldown > 0) return null;
    let next = this.scale;
    if (avg > 1 / 40) next = Math.max(this.min, this.scale * (avg > 1 / 20 ? 0.75 : 0.88));
    else if (avg < 1 / 70) next = Math.min(this.max, this.scale * 1.08);
    if (Math.abs(next - this.scale) < 0.01) return null;
    this.scale = next;
    this.cooldown = 2;
    return next;
  }

  reset(): void {
    this.scale = this.max;
    this.acc = 0;
    this.frames = 0;
    this.cooldown = 2;
  }
}
