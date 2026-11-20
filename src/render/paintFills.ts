// The plain fills under a shader fill (colours, gradients) drawn into a 2D canvas: the shader's @content input
// (skia/shaderFills.ts). Moved out of the page-element renderer's ShaderLayer.tsx, which is gone.
import { colorCss, isEnabled, linearEndpoints } from './paint';
import type { ShapeSpec } from './shaders';

/** Draws plain fills (color/gradients) into a canvas: the @content of a shader fill is the fills under it. */
export function paintFills(fills: any[], w: number, h: number, scale: number, shape: ShapeSpec | null): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  const g = c.getContext('2d')!;
  g.scale(scale, scale);
  g.beginPath();
  if (shape?.kind === 'ellipse') g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  else if (shape?.kind === 'path') {
    g.clip(new Path2D(shape.d));
  } else (g as any).roundRect ? (g as any).roundRect(0, 0, w, h, shape?.kind === 'rect' ? shape.radius : 0) : g.rect(0, 0, w, h);
  if (shape?.kind !== 'path') g.clip();
  for (const f of fills) {
    if (!isEnabled(f)) continue;
    if (typeof f === 'string' || f.type === 'color') g.fillStyle = colorCss(typeof f === 'string' ? f : f.color);
    else if (f.type === 'gradient') {
      const stops = (f.colors ?? []).slice().sort((a: any, b: any) => a.position - b.position);
      let grad: CanvasGradient;
      if ((f.gradientType ?? 'linear') === 'linear') {
        const e = linearEndpoints(f);
        grad = g.createLinearGradient(e.x1 * w, e.y1 * h, e.x2 * w, e.y2 * h);
      } else grad = g.createRadialGradient((f.center?.x ?? 0.5) * w, (f.center?.y ?? 0.5) * h, 0, (f.center?.x ?? 0.5) * w, (f.center?.y ?? 0.5) * h, Math.max(w * (f.size?.width ?? 1), h * (f.size?.height ?? 1)) / 2);
      for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.position ?? 0)), colorCss(s.color, f.opacity ?? 1));
      g.fillStyle = grad;
    } else continue;
    g.fillRect(0, 0, w, h);
  }
  return c;
}
