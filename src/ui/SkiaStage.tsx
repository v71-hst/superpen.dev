// One layer drawn by Skia into its own canvas, fitted to a size: Present's slides (they used the page-element
// renderer). Laid out by the layout engine and recorded by the painter like frames on the canvas; drawn off screen on
// the Skia canvas's graphics context (animated shaders are textures there) and copied in. Drawn again when fonts or
// pictures arrive, and at the shader frame rate while it shows animated shaders. `hitRef` answers which layers are
// under a point (innermost first), as elements under the pointer did.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { RNode } from '../model/types';
import { layoutTree, type LayoutNode } from '../layout/layout';
import { loadKit } from '../skia/kit';
import { loadBundledFonts, onFontsChanged } from '../skia/fonts';
import { onImagesChanged, wantImage } from '../skia/images';
import { recordPicture, skiaMeasureText, type ImageUse } from '../skia/painter';
import { paintContext } from '../skia/testing';
import { hitChain } from '../skia/layoutIndex';
import { isLiveKey, noteLiveDrawn } from '../skia/liveShaders';
import { sceneGpu } from '../skia/scene';
import { free } from '../skia/lifetime';
import { perfLimits } from '../editor/perfLimits';

export type StageHit = (clientX: number, clientY: number) => string[];

export function SkiaStage({ n, width, height, hitRef, maxScale = Infinity, lazy = false, className = 'present-stage' }: { n: RNode; width: number; height: number; hitRef?: React.MutableRefObject<StageHit | null>; maxScale?: number; lazy?: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const layout = useRef<{ root: LayoutNode; s: number } | null>(null);
  const [changed, setChanged] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });
  // `lazy` (lists of thumbnails): drawn only while on screen.
  const [visible, setVisible] = useState(!lazy);
  useEffect(() => {
    if (!lazy || !ref.current) return;
    const io = new IntersectionObserver(es => setVisible(es.some(e => e.isIntersecting)));
    io.observe(ref.current);
    return () => io.disconnect();
  }, [lazy]);
  const placed = useMemo(() => ({ ...n, props: { ...n.props, x: 0, y: 0, rotation: undefined } }) as RNode, [n]);
  useEffect(() => {
    // Fonts and pictures arrive in bursts: one redraw for a burst.
    let t: ReturnType<typeof setTimeout> | null = null;
    const bump = () => {
      t ??= setTimeout(() => {
        t = null;
        setChanged(c => c + 1);
      }, 150);
    };
    const a = onFontsChanged(bump);
    const b = onImagesChanged(bump);
    return () => {
      a();
      b();
      if (t) clearTimeout(t);
    };
  }, []);
  useEffect(() => {
    if (!visible) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const draw = async () => {
      const ck = await loadKit();
      await loadBundledFonts(ck);
      const canvas = ref.current;
      if (stop || !canvas) return;
      const ctx = paintContext(ck);
      const root = layoutTree(placed, skiaMeasureText(ctx), { doc: ctx.doc });
      const s = Math.min(width / Math.max(1, root.w), height / Math.max(1, root.h), maxScale);
      layout.current = { root, s };
      setBox(b => (b.w === root.w * s && b.h === root.h * s ? b : { w: root.w * s, h: root.h * s }));
      const dpr = devicePixelRatio || 1;
      const W = Math.max(1, Math.round(root.w * s * dpr)), H = Math.max(1, Math.round(root.h * s * dpr));
      const uses: ImageUse[] = [];
      const asked = new Set<string>();
      const pic = recordPicture(ctx, root, uses, true, asked);
      for (const u of uses) wantImage(u.url, u.side * s * dpr, true);
      const gpu = sceneGpu();
      const surface = (gpu ? gpu.makeSurface({ width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB }) : null) ?? ck.MakeSurface(W, H);
      try {
        if (!surface) return;
        const c = surface.getCanvas();
        c.clear(ck.TRANSPARENT);
        c.scale(s * dpr, s * dpr);
        c.drawPicture(pic);
        surface.flush();
        const img = surface.makeImageSnapshot();
        const px = img.readPixels(0, 0, { width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
        img.delete();
        if (px && !stop) {
          canvas.width = W;
          canvas.height = H;
          canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), W, H), 0, 0);
        }
      } finally {
        free(pic);
        surface?.delete();
      }
      const live = [...asked].filter(isLiveKey);
      if (live.length && !stop) {
        noteLiveDrawn(live);
        timer = setTimeout(draw, perfLimits().shaderFrameMs);
      }
    };
    void draw();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [placed, width, height, changed, visible, maxScale]);
  // Tests: where a layer is on screen (the slide's elements used to be found on the page).
  if (hitRef && (import.meta.env.DEV || import.meta.env.VITE_PEN_HOOKS))
    (window as any).__penStage = {
      hit: (x: number, y: number) => hitRef?.current?.(x, y) ?? null,
      rectOf: (key: string) => {
        const l = layout.current, el = ref.current;
        if (!l || !el) return null;
        const find = (n: LayoutNode): LayoutNode | null => (n.key === key ? n : n.children.map(find).find(Boolean) ?? null);
        const n = find(l.root);
        if (!n) return null;
        const r = el.getBoundingClientRect();
        const [a, b, c, d, e, f] = n.world;
        const xs = [e, e + a * n.w, e + c * n.h, e + a * n.w + c * n.h], ys = [f, f + b * n.w, f + d * n.h, f + b * n.w + d * n.h];
        return { x: r.left + Math.min(...xs) * l.s, y: r.top + Math.min(...ys) * l.s, width: (Math.max(...xs) - Math.min(...xs)) * l.s, height: (Math.max(...ys) - Math.min(...ys)) * l.s };
      },
    };
  if (hitRef)
    hitRef.current = (x, y) => {
      const l = layout.current, el = ref.current;
      if (!l || !el) return [];
      const r = el.getBoundingClientRect();
      return hitChain(l.root, (x - r.left) / l.s, (y - r.top) / l.s).reverse();
    };
  // Until it has been laid out (or seen, when lazy), the box it will fill.
  const w = box.w || width, h = box.h || (lazy ? Math.min(height, 40) : height);
  return <canvas ref={ref} className={className} style={{ display: 'block', width: w, height: h }} />;
}
