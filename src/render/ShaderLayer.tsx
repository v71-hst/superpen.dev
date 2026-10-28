// React glue for shader fills (a canvas layer inside the node) and shader effects (post-processing the rendered node).
import React, { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ShaderRunner, type ShapeSpec } from './shaders';
import { rasterizeToCanvas } from './rasterize';
import { colorCss, isEnabled, linearEndpoints } from './paint';
import { RenderCtx } from './NodeView';
import { useStore } from '../editor/store';
import { onAssetsChanged } from './scripts';

/** Render scale for shader output, quantized so zooming doesn't re-render on every wheel tick. */
function useShaderScale() {
  const zoom = useStore(s => Math.pow(2, Math.round(Math.log2(Math.max(0.05, s.view.zoom)) * 2) / 2));
  return Math.max(0.25, Math.min(2, zoom * (devicePixelRatio || 1)));
}

function useAssetEpoch() {
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const off = onAssetsChanged(() => setEpoch(e => e + 1));
    return () => void off();
  }, []);
  return epoch;
}

/** Draws plain fills (color/gradients) into a canvas: the @content of a shader fill is the fills under it. */
function paintFills(fills: any[], w: number, h: number, scale: number, shape: ShapeSpec | null): HTMLCanvasElement {
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
      } else grad = g.createRadialGradient((f.center?.x ?? 0.5) * w, (f.center?.y ?? 0.5) * h, 0, (f.center?.x ?? 0.5) * w, (f.center?.y ?? 0.5) * h, (Math.max(w * (f.size?.width ?? 1), h * (f.size?.height ?? 1)) / 2));
      for (const s of stops) grad.addColorStop(Math.max(0, Math.min(1, s.position ?? 0)), colorCss(s.color, f.opacity ?? 1));
      g.fillStyle = grad;
    } else continue;
    g.fillRect(0, 0, w, h);
  }
  return c;
}

/** Captures what is rendered behind a node (inside its top-level frame) for @backdrop, extended by a margin. */
async function captureBackdrop(el: HTMLElement, key: string, margin: number, scale: number): Promise<HTMLCanvasElement | null> {
  const root = el.closest<HTMLElement>('#pen-world > [data-k]');
  if (!root) return null;
  const z = useStore.getState().view.zoom;
  const rr = root.getBoundingClientRect();
  const er = el.getBoundingClientRect();
  const crop = { x: (er.left - rr.left) / z - margin, y: (er.top - rr.top) / z - margin, w: er.width / z + margin * 2, h: er.height / z + margin * 2 };
  return rasterizeToCanvas(root, { pixelRatio: Math.min(scale, 1.5), hideKeys: [key], crop, dropSelector: '[data-shader-fx]' });
}

export function ShaderFillCanvas({ nodeKey, fill, below, shape, style }: { nodeKey: string; fill: any; below: any[]; shape: ShapeSpec | null; style?: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const runner = useRef<ShaderRunner | null>(null);
  const ctx = useContext(RenderCtx);
  const scale = useShaderScale();
  const epoch = useAssetEpoch();
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    const el = ref.current!;
    runner.current = new ShaderRunner(el);
    runner.current.onError = setError;
    const ro = new ResizeObserver(() => setSize(s => (s[0] === el.clientWidth && s[1] === el.clientHeight ? s : [el.clientWidth, el.clientHeight])));
    ro.observe(el);
    setSize([el.clientWidth, el.clientHeight]);
    return () => {
      ro.disconnect();
      runner.current?.dispose();
    };
  }, []);
  const belowKey = JSON.stringify(below);
  const shapeKey = JSON.stringify(shape);
  const uniformsKey = JSON.stringify(fill.uniforms ?? {});
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  // Rebuild only when the shader's inputs change…
  useEffect(() => {
    const [w, h] = size;
    if (!w || !h || !fill.url || !runner.current) return;
    setError('');
    const s = scaleRef.current;
    runner.current.update({
      passes: [{ url: fill.url, uniforms: fill.uniforms ?? {} }],
      width: w,
      height: h,
      margin: 0,
      shape,
      content: async () => paintFills(below, w, h, Math.min(s, 2), shape),
      backdrop: () => captureBackdrop(ref.current!.parentElement!, nodeKey, 0, s),
      resolveUrl: ctx.resolveUrl,
      scale: s,
    });
  }, [size[0], size[1], fill.url, uniformsKey, belowKey, shapeKey, epoch, ctx.resolveUrl]);
  // …zooming only changes the output resolution.
  useEffect(() => {
    runner.current?.setScale(scale);
  }, [scale]);
  return (
    <>
      <canvas
        ref={ref}
        data-shader-fill
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: fill.opacity ?? 1, mixBlendMode: fill.blendMode && fill.blendMode !== 'normal' ? (fill.blendMode as any) : undefined, ...style }}
      />
      {error && <ShaderError message={error} />}
    </>
  );
}

function ShaderError({ message }: { message: string }) {
  return (
    <div data-asset-error={`Shader error: ${message}`} title={message} style={{ position: 'absolute', inset: 0, border: '1px dashed #f43f5e', color: '#f43f5e', font: '10px system-ui', padding: 4, overflow: 'hidden', pointerEvents: 'none', background: 'rgba(244,63,94,0.06)' }}>
      Shader error: {message}
    </div>
  );
}

function visualMargin(p: any): number {
  let m = 2;
  const sw = typeof p.strokeWidth === 'number' ? p.strokeWidth : 1;
  if (p.stroke) m = Math.max(m, sw + 2);
  const fx = Array.isArray(p.effect) ? p.effect : p.effect ? [p.effect] : [];
  for (const e of fx) {
    if (e.enabled === false) continue;
    if (e.type === 'shadow') m = Math.max(m, Math.abs(e.offset?.x ?? 0) + Math.abs(e.offset?.y ?? 0) + (e.blur ?? 0) * 1.5 + Math.abs(e.spread ?? 0) + 4);
    if (e.type === 'blur') m = Math.max(m, (e.radius ?? 0) * 1.5 + 4);
  }
  return Math.min(400, Math.ceil(m));
}

/**
 * Wraps a node with shader effects: the node renders normally but hidden, its rendering becomes the @content
 * texture, and the shader output is drawn in its place (over its visual bounds).
 */
export function ShaderEffectHost({ nodeKey, props, children }: { nodeKey: string; props: any; children: React.ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const runner = useRef<ShaderRunner | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ctx = useContext(RenderCtx);
  const scale = useShaderScale();
  const epoch = useAssetEpoch();
  const fx = (Array.isArray(props.effect) ? props.effect : [props.effect]).filter((e: any) => e && e.type === 'shader' && e.enabled !== false && e.url);
  const fxKey = JSON.stringify(fx);
  const margin = visualMargin(props);

  useLayoutEffect(() => {
    return () => {
      runner.current?.dispose();
      canvasRef.current?.remove();
    };
  }, []);

  // Content is captured at a resolution that only grows; zooming out re-renders without re-capturing.
  const captureScale = useRef(0);
  const [captureTick, setCaptureTick] = useState(0);
  useEffect(() => {
    if (!captureScale.current) return;
    if (scale > captureScale.current * 1.4) setCaptureTick(t => t + 1);
    else runner.current?.setScale(scale);
  }, [scale]);

  // DOM setup (cheap, every render): keep the node hidden and its output canvas attached.
  useLayoutEffect(() => {
    const el = wrap.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    el.style.visibility = runner.current?.error ? '' : 'hidden';
    if (canvasRef.current && canvasRef.current.parentElement !== el) el.appendChild(canvasRef.current);
  });

  useLayoutEffect(() => {
    const el = wrap.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    let canvas = canvasRef.current;
    if (!canvas || canvas.parentElement !== el) {
      canvas?.remove();
      canvas = document.createElement('canvas');
      canvas.setAttribute('data-shader-fx', nodeKey);
      el.appendChild(canvas);
      canvasRef.current = canvas;
      runner.current?.dispose();
      runner.current = new ShaderRunner(canvas);
      const c = canvas;
      runner.current.onError = msg => {
        // Show the node unprocessed with an error marker instead of making it disappear.
        el.style.visibility = '';
        c.setAttribute('data-asset-error', `Shader effect error: ${msg}`);
        c.title = msg;
        c.style.outline = '1px dashed #f43f5e';
      };
    }
    canvas.removeAttribute('data-asset-error');
    canvas.style.outline = '';
    el.style.visibility = 'hidden';
    canvas.style.cssText = `position:absolute;left:${-margin}px;top:${-margin}px;width:calc(100% + ${margin * 2}px);height:calc(100% + ${margin * 2}px);visibility:visible;pointer-events:none;`;
    canvas.removeAttribute('data-asset-error');
    let cancelled = false;
    // Capturing the node is relatively expensive; let rapid edits settle first.
    const t = setTimeout(() => {
      if (cancelled || !runner.current) return;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      captureScale.current = scale;
      runner.current.update({
        passes: fx.map((e: any) => ({ url: e.url, uniforms: e.uniforms ?? {} })),
        width: w,
        height: h,
        margin,
        shape: null,
        content: () => rasterizeToCanvas(el, { pixelRatio: Math.min(scale, 2), margin, forceVisible: true, dropSelector: `[data-shader-fx="${CSS.escape(nodeKey)}"]` }),
        backdrop: () => captureBackdrop(el, nodeKey, margin, scale),
        resolveUrl: ctx.resolveUrl,
        scale,
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // Re-capture only when the node itself, its effects or the shader files change (not on every render/zoom).
  }, [props, fxKey, margin, epoch, ctx.resolveUrl, captureTick]);

  return (
    <div ref={wrap} style={{ display: 'contents' }} data-fx-key={fxKey}>
      {children}
    </div>
  );
}

export { useShaderScale, useAssetEpoch };
