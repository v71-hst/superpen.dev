// Per top-level frame: whether Skia can draw it (cheap, cached) and its recorded SkPicture (recorded only when the frame
// is actually drawn, or ahead of need while the editor is idle). Both are cached by RNode identity (TreeBuilder keeps an
// unchanged frame's RNode) plus the state of the font styles and pictures that frame itself uses: a font or picture
// arriving re-records only the frames that depend on it.
import { isLiveKey, liveStamp } from './liveShaders';
import type { SkPicture } from 'canvaskit-wasm';
import type { RNode } from '../model/types';
import { free } from './lifetime';
import { fontEpoch, fontStamp } from './fonts';
import { KEEP_MS, imageEpoch, imageStamp, wantImage } from './images';
import { newDeps, recordPicture, skiaEligible, type FrameDeps, type ImageUse, type PaintContext, type PaintNode } from './painter';

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
  /** Where the picture draws pictures (from the last recording; kept across a re-recording until the next one). */
  uses: ImageUse[];
  /** Live (animated) shader textures the picture draws (liveShaders.ts): the frame is replayed, never copied. */
  live: string[];
  /** Their liveStamp when it was recorded: a new frame of animation records it again. */
  liveSeen: number;
  /**
   * The frame is (or was a moment ago) in view showing a picture larger than its small version: it is recorded with
   * the larger versions and again whenever one arrives or goes. Other frames only ever draw the small ones.
   */
  detail: boolean;
  /** When it was last seen like that. */
  detailAt: number;
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
  if (fontsOf(e.deps) !== e.fonts || imageStamp(e.deps.images, e.detail) !== e.images) return false;
  e.seenFonts = f;
  e.seenImages = i;
  return true;
}

function entry(ctx: PaintContext, root: RNode, editingKey: string | null): Entry {
  const e = cache.get(root.key);
  const editing = editingKey && inSubtree(root, editingKey) ? editingKey : null;
  if (e && current(e, root, ctx.doc.variables, editing)) return e;
  // The picture is recorded again when it is next drawn. Its far-zoom copy stays until then: an out-of-date copy for
  // a moment, not a flash of the frame's flat colour.
  if (e?.picture) free(e.picture);
  const deps = newDeps();
  const reason = skiaEligible(ctx, root, editing, deps);
  const detail = e?.detail ?? false;
  const next: Entry = { rnode: root, vars: ctx.doc.variables, editing, deps, fonts: fontsOf(deps), images: imageStamp(deps.images, detail), seenFonts: fontEpoch(), seenImages: imageEpoch(), reason, picture: null, uses: e?.uses ?? [], live: e?.live ?? [], liveSeen: -1, detail, detailAt: e?.detailAt ?? 0 };
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
  if (e.picture && e.live.length && create && liveStamp(e.live) !== e.liveSeen) {
    free(e.picture);
    e.picture = null;
  }
  if (!e.picture && create) {
    const t0 = performance.now();
    const l = layout();
    if (!l) return null;
    const uses: ImageUse[] = [];
    const asked = new Set<string>();
    e.picture = recordPicture(ctx, l, uses, e.detail, asked, e.editing);
    e.uses = uses;
    // Made pictures (still shaders) are only known once the layout gives their size: from now on the frame depends
    // on them like on its other pictures, and records again when one arrives or gets a sharper version.
    if (asked.size) {
      for (const u of asked) e.deps.images.add(u);
      e.images = imageStamp(e.deps.images, e.detail);
    }
    e.live = [...asked].filter(isLiveKey);
    e.liveSeen = liveStamp(e.live);
    records++;
    const ms = performance.now() - t0;
    recordMs += ms;
    slowestRecordMs = Math.max(slowestRecordMs, ms);
  }
  return e.picture;
}

/** The live shader textures a frame's picture draws (empty when it has none or is not recorded). */
export function frameLiveKeys(key: string): readonly string[] {
  return cache.get(key)?.live ?? [];
}

/** World-space bounds of everything a frame's recorded picture draws (overflowing children and shadows included). */
export function pictureBounds(key: string): { x: number; y: number; w: number; h: number } | null {
  const pic = cache.get(key)?.picture;
  if (!pic) return null;
  const r = pic.cullRect();
  return { x: r[0], y: r[1], w: r[2] - r[0], h: r[3] - r[1] };
}

/**
 * The frame is on screen at `scale` device pixels per world px: asks for a sharper version of each picture it shows
 * larger than the version there is. `visible` (world box): only pictures inside it; null: all of the frame's.
 */
export function frameSeen(key: string, scale: number, visible: { x: number; y: number; w: number; h: number } | null) {
  const e = cache.get(key);
  if (!e || e.reason) return;
  let large = false;
  for (const u of e.uses) {
    if (visible && (u.x > visible.x + visible.w || u.x + u.w < visible.x || u.y > visible.y + visible.h || u.y + u.h < visible.y)) continue;
    if (wantImage(u.url, u.side * scale)) large = true;
  }
  if (!large) return;
  e.detailAt = performance.now();
  if (!e.detail) {
    e.detail = true;
    // Recorded again (with a larger version that is already there) when it is next drawn.
    e.seenImages = -1;
  }
}

/**
 * Frames that haven't shown a picture large for a while go back to the small versions, so the larger ones they were
 * recorded with can be let go (called every few seconds, after the frames in view were seen).
 */
export function relaxFrames() {
  const now = performance.now();
  for (const e of cache.values()) {
    if (!e.detail || now - e.detailAt < KEEP_MS) continue;
    e.detail = false;
    e.seenImages = -1;
  }
}

/** Told when a frame is gone and its picture with it (its rasterised copy must go too). */
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
