// One recorded SkPicture per top-level frame, cached by RNode identity (TreeBuilder keeps an unchanged frame's RNode)
// plus the font and picture epochs it depends on. A frame Skia can't draw yet keeps its reason instead, so the caller
// leaves it to the DOM renderer.
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
  picture: SkPicture | null;
  reason: string | null;
};

const cache = new Map<string, Entry>();
let records = 0;

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

/**
 * The picture for a top-level frame, or the reason Skia can't draw it now. `layout` is only called when a new
 * picture must be recorded.
 */
export function frameDrawing(ctx: PaintContext, root: RNode, layout: () => PaintNode, editingKey: string | null = null): { picture: SkPicture | null; reason: string | null } {
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
  if (e) free(e.picture);
  const reason = skiaEligible(ctx, root, editing);
  const d = e && e.rnode === root ? { usesText: e.usesText, usesImages: e.usesImages } : deps(root);
  let picture: SkPicture | null = null;
  if (!reason) {
    picture = recordPicture(ctx, layout());
    records++;
  }
  const next: Entry = { rnode: root, vars: ctx.doc.variables, editing, fonts: fontEpoch(), images: imageEpoch(), ...d, picture, reason };
  cache.set(root.key, next);
  return next;
}

function inSubtree(root: RNode, key: string): boolean {
  let hit = false;
  walk(root, n => {
    if (n.key === key) hit = true;
  });
  return hit;
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
  let eligible = 0;
  for (const e of cache.values()) {
    if (e.picture) eligible++;
    else if (e.reason) {
      const r = e.reason.replace(/ on \S+$/, '').replace(/"[^"]*"/g, '"…"');
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
  }
  return { frames: cache.size, eligible, fallback: cache.size - eligible, reasons, recordings: records };
}
