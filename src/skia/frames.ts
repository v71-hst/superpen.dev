// Per top-level frame: whether Skia can draw it (cheap, cached) and its recorded SkPicture (recorded only when the frame
// is actually drawn, so a 320-frame file doesn't record every frame up front). Both are cached by RNode identity
// (TreeBuilder keeps an unchanged frame's RNode) plus the font and picture epochs the frame depends on.
import type { SkPicture } from 'canvaskit-wasm';
import type { RNode } from '../model/types';
import { free } from './lifetime';
import { fontEpoch } from './fonts';
import { imageEpoch } from './images';
import { recordPicture, skiaEligible, type PaintContext, type PaintNode } from './painter';

type Entry = {
  rnode: RNode;
  vars: unknown;
  editing: string | null;
  fonts: number;
  images: number;
  usesText: boolean;
  usesImages: boolean;
  reason: string | null;
  picture: SkPicture | null;
};

const cache = new Map<string, Entry>();
let records = 0;
const pictureListeners = new Set<(key: string) => void>();

function walk(n: RNode, fn: (n: RNode) => void) {
  fn(n);
  for (const c of n.children) walk(c, fn);
}

function deps(root: RNode) {
  let usesText = false, usesImages = false;
  walk(root, n => {
    if (n.type === 'text' || n.type === 'note' || n.type === 'prompt' || n.type === 'context') usesText = true;
    if (JSON.stringify(n.props.fill ?? '').includes('"image"') || JSON.stringify(n.props.stroke ?? '').includes('"image"')) usesImages = true;
  });
  return { usesText, usesImages };
}

function inSubtree(root: RNode, key: string): boolean {
  let hit = false;
  walk(root, n => {
    if (n.key === key) hit = true;
  });
  return hit;
}

function entry(ctx: PaintContext, root: RNode, editingKey: string | null): Entry {
  const e = cache.get(root.key);
  const editing = editingKey && inSubtree(root, editingKey) ? editingKey : null;
  if (
    e &&
    e.rnode === root &&
    e.vars === ctx.doc.variables &&
    e.editing === editing &&
    (!e.usesText || e.fonts === fontEpoch()) &&
    (!e.usesImages || e.images === imageEpoch())
  )
    return e;
  if (e?.picture) {
    free(e.picture);
    pictureListeners.forEach(l => l(root.key));
  }
  const d = e && e.rnode === root ? { usesText: e.usesText, usesImages: e.usesImages } : deps(root);
  const next: Entry = { rnode: root, vars: ctx.doc.variables, editing, fonts: fontEpoch(), images: imageEpoch(), ...d, reason: skiaEligible(ctx, root, editing), picture: null };
  cache.set(root.key, next);
  return next;
}

/** null if Skia can draw this top-level frame now, else why it stays on the DOM renderer. */
export function frameReason(ctx: PaintContext, root: RNode, editingKey: string | null = null): string | null {
  return entry(ctx, root, editingKey).reason;
}

/** The frame's picture, recorded now if it isn't yet (null if the frame isn't Skia-drawable). */
export function framePicture(ctx: PaintContext, root: RNode, layout: () => PaintNode | null, editingKey: string | null = null): SkPicture | null {
  const e = entry(ctx, root, editingKey);
  if (e.reason) return null;
  if (!e.picture) {
    const l = layout();
    if (!l) return null;
    e.picture = recordPicture(ctx, l);
    records++;
  }
  return e.picture;
}

/** The picture if it is already recorded (no work). */
export function recordedPicture(key: string, root: RNode): SkPicture | null {
  const e = cache.get(key);
  return e && e.rnode === root ? e.picture : null;
}

/** Told when a frame's picture is thrown away (its rasterised copies must go too). */
export function onPictureDropped(fn: (key: string) => void): () => void {
  pictureListeners.add(fn);
  return () => pictureListeners.delete(fn);
}

/** Frees pictures of frames that are gone (deleted, or a new document). */
export function pruneFrames(liveKeys: Set<string>) {
  for (const [k, e] of cache) {
    if (!liveKeys.has(k)) {
      free(e.picture);
      cache.delete(k);
    }
  }
}

export function clearFrames() {
  for (const e of cache.values()) free(e.picture);
  cache.clear();
}

export function frameStats() {
  const reasons: Record<string, number> = {};
  let eligible = 0, recorded = 0;
  for (const e of cache.values()) {
    if (!e.reason) eligible++;
    else {
      const r = e.reason.replace(/ on \S+$/, '').replace(/"[^"]*"/g, '"…"');
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
    if (e.picture) recorded++;
  }
  return { frames: cache.size, eligible, recorded, fallback: cache.size - eligible, reasons, recordings: records };
}
