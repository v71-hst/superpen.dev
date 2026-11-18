// Test helpers for the Skia painter (tests/paint-diff.mjs): draw one top-level frame through Skia into a PNG, with
// boxes taken either from the rendered DOM (isolates painting from layout) or from the layout engine. Exposed on
// window.__penSkia in dev and harness builds only.
import { useStore } from '../editor/store';
import { currentTree } from '../editor/tree';
import { makeUrlResolver } from '../editor/fileio';
import type { RNode } from '../model/types';
import { loadKit } from './kit';
import { loadBundledFonts } from './fonts';
import { free } from './lifetime';
import { recordPicture, skiaEligible, type Mat, type PaintContext, type PaintNode } from './painter';

const ID: Mat = [1, 0, 0, 1, 0, 0];
function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

/** Layout read back from the rendered DOM: each [data-k] element's offset box and CSS transform (origin 0 0). */
export function domPaintTree(key: string): PaintNode | null {
  const tree = currentTree();
  const el = document.querySelector<HTMLElement>(`#pen-world [data-k="${CSS.escape(key)}"]`);
  if (!tree || !el) return null;
  const build = (el: HTMLElement, parentWorld: Mat): PaintNode | null => {
    const n = tree.byKey.get(el.dataset.k!);
    if (!n) return null;
    const t = getComputedStyle(el).transform;
    const m = t && t !== 'none' ? new DOMMatrix(t) : null;
    const local = mul([1, 0, 0, 1, el.offsetLeft, el.offsetTop], m ? [m.a, m.b, m.c, m.d, m.e, m.f] : ID);
    const world = mul(parentWorld, local);
    const kids: PaintNode[] = [];
    for (const c of el.querySelectorAll<HTMLElement>('[data-k]')) {
      if (c.parentElement?.closest('[data-k]') !== el) continue;
      const k = build(c, world);
      if (k) kids.push(k);
    }
    return { key: n.key, node: n, w: el.offsetWidth, h: el.offsetHeight, world, children: kids };
  };
  return build(el, ID);
}

export function paintContext(ck: PaintContext['ck']): PaintContext {
  const s = useStore.getState();
  return { ck, doc: s.doc!, resolveUrl: makeUrlResolver(s.file?.path ?? null) };
}

/**
 * Draws a top-level frame through Skia at `scale` into a PNG data URL the size of the frame's box. Waits (up to
 * `waitMs`) for its fonts and pictures; reports why the frame would stay on the DOM renderer, if it would.
 */
export async function renderFrameForTest(key: string, opts: { scale?: number; layout?: (root: RNode) => PaintNode | null; waitMs?: number } = {}) {
  const ck = await loadKit();
  await loadBundledFonts(ck);
  const ctx = paintContext(ck);
  const root = currentTree()?.byKey.get(key);
  if (!root) throw new Error(`no node ${key}`);
  let reason = skiaEligible(ctx, root);
  const until = performance.now() + (opts.waitMs ?? 15000);
  while (reason && /loading/.test(reason) && performance.now() < until) {
    await new Promise(r => setTimeout(r, 100));
    reason = skiaEligible(ctx, root);
  }
  const pn = opts.layout ? opts.layout(root) : domPaintTree(key);
  if (!pn) throw new Error(`frame ${key} is not laid out`);
  const scale = opts.scale ?? 1;
  const w = Math.max(1, Math.round(pn.w * scale)), h = Math.max(1, Math.round(pn.h * scale));
  const surface = ck.MakeSurface(w, h)!;
  const pic = recordPicture(ctx, pn);
  try {
    const c = surface.getCanvas();
    c.clear(ck.TRANSPARENT);
    c.scale(scale, scale);
    c.translate(-pn.world[4], -pn.world[5]);
    c.drawPicture(pic);
    surface.flush();
    const img = surface.makeImageSnapshot();
    const bytes = img.encodeToBytes();
    img.delete();
    if (!bytes) throw new Error('encode failed');
    const dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(new Blob([bytes], { type: 'image/png' }));
    });
    return { dataUrl, width: w, height: h, reason };
  } finally {
    free(pic);
    surface.delete();
  }
}
