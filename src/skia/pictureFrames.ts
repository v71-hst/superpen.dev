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
import { framePicture, frameReason, pictureBounds, pruneFrames } from './frames';
import { paintContext } from './testing';
import { hitChain, layoutOf, layoutWorldRect, rootLayout, rootOf } from './layoutIndex';
import { propsOf } from './painter';
import { invalidateScene, surfaceIsReady } from './scene';
import { activeRenderer, failRenderer } from './renderer';

export type PictureFrame = {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Records (or returns) the frame's picture. */
  record: () => SkPicture | null;
  /** The picture if it is already recorded (no work). */
  peek: () => SkPicture | null;
  /** Shown for the moment before the picture is recorded: the frame's own colour. */
  placeholder: string;
  /** Changes whenever the frame's content does (its RNode). */
  token: object;
};

type Box = { x: number; y: number; w: number; h: number };

/** Top-level frames drawn from pictures at the last Roots render, in document order, and their boxes. */
let drawn: string[] = [];
let drawnSet = new Set<string>();
let boxes = new Map<string, Box>();

/** How long a frame may wait for Skia (its engine, fonts or pictures) as a plain box before its DOM is built instead. */
const PENDING_MS = 8000;
const pendingSince = new Map<string, number>();
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
/** Whether the Skia surface has been ready since the layer started: a context lost later shows frames as DOM at once. */
let everReady = false;

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
  if (!ck || !surfaceIsReady() || heldLive(n) || activeRenderer() === 'dom') return null;
  everReady = true;
  const ctx = paintContext(ck);
  const editing = useStore.getState().editingKey;
  try {
    if (frameReason(ctx, n, editing)) return null;
  } catch (e) {
    // Runs while the canvas renders: a CanvasKit failure here must not take the editor down. The DOM renderer takes
    // over for the rest of the session.
    failRenderer(`Skia failed while preparing frames (${e instanceof Error ? e.message : e})`);
    return null;
  }
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
    peek: () => framePicture(ctx, n, () => null, useStore.getState().editingKey, false),
    placeholder: primaryColor(fillList(p.fill).filter(isEnabled)) ?? 'rgba(128,128,128,0.12)',
    token: n,
  };
}

/**
 * Full mode: true while Skia is about to draw this frame but can't yet (the engine is starting, or the frame's fonts
 * or pictures are still loading). Roots shows the frame's colour meanwhile instead of building its DOM only to throw
 * it away a moment later. After a few seconds it gives up, so a font that never arrives can't keep a frame empty.
 */
export function pictureFramePending(n: RNode): boolean {
  if (activeRenderer() !== 'full' || heldLive(n)) return false;
  const ck = kitIfLoaded();
  let waiting: boolean;
  if (!ck || !surfaceIsReady()) waiting = !everReady;
  else {
    try {
      waiting = /loading$/.test(frameReason(paintContext(ck), n, useStore.getState().editingKey) ?? '');
    } catch {
      return false;
    }
  }
  if (!waiting) {
    pendingSince.delete(n.key);
    return false;
  }
  const now = performance.now();
  const since = pendingSince.get(n.key) ?? now;
  pendingSince.set(n.key, since);
  if (now - since > PENDING_MS) return false;
  // Roots renders again when the wait runs out, even if nothing arrived.
  pendingTimer ??= setTimeout(() => {
    pendingTimer = null;
    invalidateScene();
  }, PENDING_MS - (now - since) + 50);
  return true;
}

/**
 * Roots reports which frames it drew from pictures (document order) and which top-level frames exist; pictures of
 * frames that are gone are freed.
 */
export function setPictureFrames(frames: (Box & { key: string })[], live: Set<string>) {
  drawn = frames.map(f => f.key);
  drawnSet = new Set(drawn);
  boxes = new Map(frames.map(f => [f.key, f]));
  pruneFrames(live);
  for (const k of pendingSince.keys()) if (!live.has(k)) pendingSince.delete(k);
}

export function pictureFrameKeys(): readonly string[] {
  return drawn;
}

/** measure.ts answers for picture-drawn frames from the layout tree. */
export function registerPictureGeometry(on: boolean) {
  if (!on) {
    setSkiaGeometry(null);
    everReady = false;
    pendingSince.clear();
    return;
  }
  const within = (b: Box | null | undefined, x: number, y: number) => !!b && x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h;
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
        // Only frames the point can be in need their layout: the frame's box, or wherever its picture draws
        // (children that overflow it).
        if (!within(boxes.get(drawn[i]), wx, wy) && !within(pictureBounds(drawn[i]), wx, wy)) continue;
        const root = rootLayout(drawn[i])?.get(drawn[i]);
        if (!root) continue;
        const chain = hitChain(root, wx, wy);
        if (chain.length) return chain;
      }
      return null;
    },
  });
}
