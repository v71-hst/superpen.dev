// Per top-level frame: whether Skia can draw it (cheap, cached) and its recorded SkPicture (recorded only when the frame
// is actually drawn, or ahead of need while the editor is idle). Both are cached by RNode identity (TreeBuilder keeps an
// unchanged frame's RNode) plus the state of the font styles and pictures that frame itself uses: a font or picture
// arriving re-records only the frames that depend on it.
import type { SkPicture } from 'canvaskit-wasm';
import type { RNode } from '../model/types';
import { free } from './lifetime';
import { fontEpoch, fontStamp } from './fonts';
import { imageEpoch, imageStamp } from './images';
import { newDeps, recordPicture, skiaEligible, type FrameDeps, type PaintContext, type PaintNode } from './painter';

type Entry = {
  rnode: RNode;
  vars: unknown;
  editing: string | null;
  deps: FrameDeps;
  /** State of the frame's own fonts and pictures when it was last checked. */
  fonts: number;
  images: number;
  /** The global epochs at that moment: while they haven't moved, nothing needs comparing. */
  seenFonts: number;
  seenImages: number;
  reason: string | null;
  picture: SkPicture | null;
};

const cache = new Map<string, Entry>();
let records = 0;
/** Time spent recording pictures (layout included), for diagnose_editor. */
let recordMs = 0;
let slowestRecordMs = 0;
const pictureListeners = new Set<(key: string) => void>();

function inSubtree(root: RNode, key: string): boolean {
  if (root.key === key) return true;
  return root.children.some(c => inSubtree(c, key));
}

const fontsOf = (d: FrameDeps) => (d.anyFont ? fontEpoch() : fontStamp(d.fonts));

function current(e: Entry, root: RNode, vars: unknown, editing: string | null): boolean {
  if (e.rnode !== root || e.vars !== vars || e.editing !== editing) return false;
  const f = fontEpoch(), i = imageEpoch();
  if (e.seenFonts === f && e.seenImages === i) return true;
  if (fontsOf(e.deps) !== e.fonts || imageStamp(e.deps.images) !== e.images) return false;
  e.seenFonts = f;
  e.seenImages = i;
  return true;
}

function entry(ctx: PaintContext, root: RNode, editingKey: string | null): Entry {
  const e = cache.get(root.key);
  const editing = editingKey && inSubtree(root, editingKey) ? editingKey : null;
  if (e && current(e, root, ctx.doc.variables, editing)) return e;
  if (e?.picture) {
    free(e.picture);
    pictureListeners.forEach(l => l(root.key));
  }
  const deps = newDeps();
  const reason = skiaEligible(ctx, root, editing, deps);
  const next: Entry = { rnode: root, vars: ctx.doc.variables, editing, deps, fonts: fontsOf(deps), images: imageStamp(deps.images), seenFonts: fontEpoch(), seenImages: imageEpoch(), reason, picture: null };
  cache.set(root.key, next);
  return next;
}

/** null if Skia can draw this top-level frame now, else why it stays on the DOM renderer. */
export function frameReason(ctx: PaintContext, root: RNode, editingKey: string | null = null): string | null {
  return entry(ctx, root, editingKey).reason;
}

/**
 * The frame's picture (null if the frame isn't Skia-drawable). `create` false: only if it is already recorded, so the
 * call does no work.
 */
export function framePicture(ctx: PaintContext, root: RNode, layout: () => PaintNode | null, editingKey: string | null = null, create = true): SkPicture | null {
  const e = entry(ctx, root, editingKey);
  if (e.reason) return null;
  if (!e.picture && create) {
    const t0 = performance.now();
    const l = layout();
    if (!l) return null;
    e.picture = recordPicture(ctx, l);
    records++;
    const ms = performance.now() - t0;
    recordMs += ms;
    slowestRecordMs = Math.max(slowestRecordMs, ms);
  }
  return e.picture;
}

/** World-space bounds of everything a frame's recorded picture draws (overflowing children and shadows included). */
export function pictureBounds(key: string): { x: number; y: number; w: number; h: number } | null {
  const pic = cache.get(key)?.picture;
  if (!pic) return null;
  const r = pic.cullRect();
  return { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] };
}

/** Told when a frame's picture is thrown away (its rasterised copies must go too). */
export function onPictureDropped(fn: (key: string) => void): () => void {
  pictureListeners.add(fn);
  return () => pictureListeners.delete(fn);
}

/** Frees pictures of frames that are gone (deleted, or a new document). */
export function pruneFrames(liveKeys: Set<string>) {
  for (const [k, e] of cache) {
    if (liveKeys.has(k)) continue;
    if (e.picture) {
      free(e.picture);
      pictureListeners.forEach(l => l(k));
    }
    cache.delete(k);
  }
}

export function clearFrames() {
  for (const e of cache.values()) free(e.picture);
  cache.clear();
}

export function frameStats() {
  const reasons: Record<string, number> = {};
  let eligible = 0, recorded = 0, bytes = 0;
  for (const e of cache.values()) {
    if (!e.reason) eligible++;
    else {
      const r = e.reason.replace(/ on \S+$/, '').replace(/"[^"]*"/g, '"…"');
      reasons[r] = (reasons[r] ?? 0) + 1;
    }
    if (e.picture) {
      recorded++;
      bytes += e.picture.approximateBytesUsed();
    }
  }
  return { frames: cache.size, eligible, recorded, pictureMB: Math.round(bytes / 104857.6) / 10, fallback: cache.size - eligible, reasons, recordings: records, recordMs: Math.round(recordMs), slowestRecordMs: Math.round(slowestRecordMs) };
}
