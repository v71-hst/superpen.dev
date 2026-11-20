// Pictures of any layer, drawn by Skia off screen: what screenshots (the agent's and MCP's), exports, presentation
// slides and layer thumbnails are made from. The layer is recorded from the layout engine's boxes like the frames on
// the canvas, after everything it shows is ready: fonts, pictures at the size the output needs, shader images and the
// first frame of animated shaders. It is drawn in its own coordinates (not rotated), cut to its box, as the page-element
// renderer's captures were.
import type { Surface } from 'canvaskit-wasm';
import { currentTree } from '../editor/tree';
import { loadKit } from './kit';
import { fontStats, loadBundledFonts } from './fonts';
import { getImage, imageStats, wantImage } from './images';
import { recordPicture, skiaEligible, type ImageUse, type Mat, type PaintNode } from './painter';
import { layoutOf, layoutWorldRect, rootOf } from './layoutIndex';
import { paintContext } from './testing';
import { isLiveKey, liveReady } from './liveShaders';
import { sceneGpu } from './scene';
import { free } from './lifetime';

export type NodeImage = { dataUrl: string; width: number; height: number; bytes: Uint8Array };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

/**
 * Layer `key` drawn at `scale` (pixels per design unit, made smaller so the longer side fits `maxSize`), as PNG or JPEG
 * (JPEG and `background` on a filled background). Waits up to `waitMs` for what it shows.
 */
export async function renderNodeImage(key: string, opts: { scale?: number; maxSize?: number; format?: 'png' | 'jpg'; background?: string; waitMs?: number } = {}): Promise<NodeImage> {
  const ck = await loadKit();
  await loadBundledFonts(ck);
  const ctx = paintContext(ck);
  const tree = currentTree();
  const rootKey = rootOf(key);
  const root = rootKey ? tree?.byKey.get(rootKey) : null;
  if (!root || !tree?.byKey.get(key)) throw new Error(`no layer "${key}"`);
  const until = performance.now() + (opts.waitMs ?? 15000);
  // Fonts, pictures and shader files the frame needs.
  while (/loading$/.test(skiaEligible(ctx, root) ?? '') || fontStats().loading || imageStats().loading) {
    if (performance.now() > until) break;
    await sleep(50);
  }
  const ln = (): PaintNode => {
    const l = layoutOf(key);
    if (!l) throw new Error(`layer "${key}" is not laid out (it may be hidden: enabled false)`);
    return l as PaintNode;
  };
  // Its own box, or (a group: no box of its own) the union of what is in it, in world units.
  const own = ln().w > 0 && ln().h > 0;
  const wr = own ? null : layoutWorldRect(key);
  const w = own ? ln().w : (wr?.w ?? 0);
  const h = own ? ln().h : (wr?.h ?? 0);
  if (!(w > 0 && h > 0)) throw new Error(`layer "${key}" has no size`);
  const ratio = Math.max(0.05, Math.min(opts.scale ?? 1, (opts.maxSize ?? 4096) / Math.max(w, h)));
  // Record, ask for what is missing at the size it is drawn, and record again until nothing is.
  let pic = null as ReturnType<typeof recordPicture> | null;
  for (;;) {
    const uses: ImageUse[] = [];
    const asked = new Set<string>();
    if (pic) free(pic);
    pic = recordPicture(ctx, ln(), uses, true, asked);
    for (const u of uses) wantImage(u.url, u.side * ratio, true);
    const waiting = [...asked].some(u => (isLiveKey(u) ? !liveReady(u) : getImage(u, false).status === 'loading')) || imageStats().sharpening > 0;
    if (!waiting || performance.now() > until) break;
    await sleep(60);
  }
  const W = Math.max(1, Math.round(w * ratio)), H = Math.max(1, Math.round(h * ratio));
  // On the canvas's graphics context when there is one: animated shaders are textures there.
  const gpu = sceneGpu();
  let surface: Surface | null = gpu ? gpu.makeSurface({ width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB }) : null;
  surface ??= ck.MakeSurface(W, H);
  if (!surface) throw new Error('could not make a drawing surface');
  try {
    const c = surface.getCanvas();
    const jpg = opts.format === 'jpg';
    c.clear(opts.background || jpg ? ck.parseColorString(opts.background ?? '#ffffff') : ck.TRANSPARENT);
    c.scale(ratio, ratio);
    if (own) {
      const [a, b, cc, d, e, f] = invert(ln().world);
      c.concat([a, cc, e, b, d, f, 0, 0, 1]);
    } else c.translate(-wr!.x, -wr!.y);
    c.drawPicture(pic!);
    surface.flush();
    const img = surface.makeImageSnapshot();
    const bytes = img.encodeToBytes(jpg ? ck.ImageFormat.JPEG : ck.ImageFormat.PNG, jpg ? 92 : 100);
    img.delete();
    if (!bytes) throw new Error('could not encode the picture');
    const dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(new Blob([bytes], { type: jpg ? 'image/jpeg' : 'image/png' }));
    });
    return { dataUrl, width: W, height: H, bytes };
  } finally {
    free(pic);
    surface.delete();
  }
}
