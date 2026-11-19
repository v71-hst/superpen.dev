// Stages 3 and 4: top-level frames drawn by Skia from their own recorded picture (no DOM inside them). In `overview`
// mode that's far frames (instead of a snapshot); in `full` mode every frame Skia can draw, at any zoom. A frame stays
// on the DOM renderer while its text is edited, while it is pinned live (agent screenshots and exports copy the DOM),
// while AI Pen replays strokes in it, or when skiaEligible() names a reason. Deciding is cheap: the picture itself is
// recorded only when the frame is drawn on screen. measure.ts gets these frames' geometry from here.
import type { SkPicture } from 'canvaskit-wasm';
import type { RNode } from '../model/types';
import { useStore } from '../editor/store';
import { setSkiaGeometry } from '../editor/measure';
import { worldBounds } from '../layout/layout';
import { fillList, isEnabled, primaryColor } from '../render/paint';
import { kitIfLoaded } from './kit';
import { framePicture, frameReason } from './frames';
import { paintContext } from './testing';
import { hitChain, layoutOf, layoutWorldRect, rootLayout, rootOf } from './layoutIndex';
import { propsOf } from './painter';
import { surfaceIsReady } from './scene';

export type PictureFrame = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Records (or returns) the frame's picture. */
  record: () => SkPicture | null;
  /** Shown for the moment before the picture is recorded: the frame's own colour. */
  placeholder: string;
  /** Changes whenever the frame's content does (its RNode). */
  token: object;
};

/** Top-level frames drawn from pictures at the last Roots render, in document order. */
let drawn: string[] = [];
let drawnSet = new Set<string>();

function inSubtree(root: RNode, keys: Set<string>): boolean {
  if (keys.has(root.key)) return true;
  return root.children.some(c => inSubtree(c, keys));
}

/** Why a frame must stay DOM for reasons outside its content, or null. */
function heldLive(n: RNode): string | null {
  const s = useStore.getState();
  if ((s.pinnedRoots[n.key] ?? 0) > Date.now()) return 'pinned live';
  const pen = s.aiPenPasses ?? [];
  if (pen.length && inSubtree(n, new Set(pen.flatMap((p: any) => p.keys)))) return 'AI Pen drawing';
  return null;
}

const num = (v: any) => (typeof v === 'number' && isFinite(v) ? v : null);

/** Whether Skia draws this top-level frame now, and where; null if it stays DOM (or a snapshot) for now. */
export function pictureFrameFor(n: RNode): PictureFrame | null {
  const ck = kitIfLoaded();
  if (!ck || !surfaceIsReady() || heldLive(n)) return null;
  const ctx = paintContext(ck);
  const editing = useStore.getState().editingKey;
  if (frameReason(ctx, n, editing)) return null;
  const p = propsOf(ctx, n);
  // A fixed-size, unrotated frame's box comes straight from its props; anything else from the layout engine.
  let box = num(p.x) !== null && num(p.y) !== null && num(p.width) !== null && num(p.height) !== null && !p.rotation ? { x: p.x, y: p.y, w: p.width, h: p.height } : null;
  if (!box) {
    const l = layoutOf(n.key);
    if (!l) return null;
    box = worldBounds(l);
  }
  return {
    key: n.key,
    ...box,
    record: () => framePicture(ctx, n, () => layoutOf(n.key), useStore.getState().editingKey),
    placeholder: primaryColor(fillList(p.fill).filter(isEnabled)) ?? 'rgba(128,128,128,0.12)',
    token: n,
  };
}

/** Roots reports which frames it drew from pictures (document order). */
export function setPictureFrames(keys: string[]) {
  drawn = keys;
  drawnSet = new Set(keys);
}

export function pictureFrameKeys(): readonly string[] {
  return drawn;
}

/** measure.ts answers for picture-drawn frames from the layout tree. */
export function registerPictureGeometry(on: boolean) {
  if (!on) {
    setSkiaGeometry(null);
    return;
  }
  setSkiaGeometry({
    drawn: root => drawnSet.has(root),
    rootOf,
    worldRect: layoutWorldRect,
    size: key => {
      const n = layoutOf(key);
      return n ? { w: n.w, h: n.h } : null;
    },
    chainAt: (wx, wy) => {
      for (let i = drawn.length - 1; i >= 0; i--) {
        const root = rootLayout(drawn[i])?.get(drawn[i]);
        if (!root) continue;
        const chain = hitChain(root, wx, wy);
        if (chain.length) return chain;
      }
      return null;
    },
  });
}
