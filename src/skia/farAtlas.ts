// Zoomed far out, hundreds of frames are on screen, each drawn from its own small far-zoom copy (pictureTextures.ts).
// One draw per copy means one texture switch per frame, and that is what made 2% zoom slow: 600 frames cost about
// 18 ms of Skia work per draw in the measurement, against 2 ms when they all come from one texture (docs/SKIA_REWORK.md,
// 2026-11-20). So the copies a draw uses are packed into a few shared textures (atlas pages) the first time they are
// drawn, and the frames are drawn as sprites of those pages: one drawAtlas call per page.
//
// A copy is packed once and reused while it lives; a new copy (an edit, a sharper version) gets a new slot. Packing
// waits until the view is still (packFarAtlas, from the scene's settle timer): drawing into a page that a draw has
// already used makes the graphics context copy the whole page first, so packing during a pan or zoom, frame by frame,
// cost more than it saved. Until then, and for a copy that can't be packed (too large, or no room), the copy is drawn
// on its own as before, so nothing is ever missing; the caller keeps draw order by flushing the sprites before
// anything it draws itself. When the pages are full they are cleared and refilled from the copies drawn since.
import type { Canvas as SkCanvas, CanvasKit, Image as SkImage, Paint, Surface } from 'canvaskit-wasm';
import { free, own } from './lifetime';
import { perfLimits } from '../editor/perfLimits';

const PAGE = 2048;
/** Up to 64 MB of graphics memory (16 MB a page); performance mode holds half. */
const maxPages = () => (perfLimits().bitmapSide < 2048 ? 2 : 4);
/** Copies larger than this on either side are drawn on their own (close to the far-zoom limit they are few). */
const MAX_SLOT = 512;
/** Each slot gets a copy of its edge pixels around it, so linear sampling at a sprite's edge doesn't bleed. */
const GUTTER = 1;

type Slot = { page: Page; x: number; y: number; w: number; h: number };
type Shelf = { y: number; h: number; x: number };
type Page = { surface: Surface; image: SkImage | null; dirty: boolean; shelves: Shelf[]; top: number };

let ck: CanvasKit | null = null;
let gpu: Surface | null = null;
let pages: Page[] = [];
let slots = new Map<SkImage, Slot>();
/** Copies drawn on their own since the last packing, waiting for the view to be still. */
let waiting = new Set<SkImage>();
let paint: Paint | null = null;
const stats = { packed: 0, resets: 0, unpacked: 0, atlasDraws: 0 };

/** Pending sprites of the current draw, per page, in draw order. */
let batch: { page: Page; src: number[]; xf: number[] }[] = [];

function reset() {
  for (const p of pages) {
    free(p.image);
    free(p.surface);
  }
  pages = [];
  slots = new Map();
  waiting = new Set();
  batch = [];
}

/** Frees the pages (the scene is reset, or the graphics context is gone). */
export function resetFarAtlas() {
  reset();
  if (paint) free(paint);
  paint = null;
  gpu = null;
}

function newPage(): Page | null {
  if (!ck || !gpu || pages.length >= maxPages()) return null;
  const surface = gpu.makeSurface({ width: PAGE, height: PAGE, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB });
  if (!surface) return null;
  own(surface, 'atlasPage');
  surface.getCanvas().clear(ck.TRANSPARENT);
  const p: Page = { surface, image: null, dirty: true, shelves: [], top: 0 };
  pages.push(p);
  return p;
}

/** A free spot of w×h (gutters included) on a page: shelf packing, a new shelf or a new page when needed. */
function place(w: number, h: number): { page: Page; x: number; y: number } | null {
  for (const page of pages) {
    for (const s of page.shelves) {
      if (h <= s.h && s.x + w <= PAGE) {
        const at = { page, x: s.x, y: s.y };
        s.x += w;
        return at;
      }
    }
    if (page.top + h <= PAGE) {
      page.shelves.push({ y: page.top, h, x: w });
      const at = { page, x: 0, y: page.top };
      page.top += h;
      return at;
    }
  }
  const page = newPage();
  if (!page) return null;
  page.shelves.push({ y: 0, h, x: w });
  page.top = h;
  return { page, x: 0, y: 0 };
}

function pack(img: SkImage): Slot | null {
  const w = img.width(), h = img.height();
  if (w > MAX_SLOT || h > MAX_SLOT) return null;
  const at = place(w + GUTTER * 2, h + GUTTER * 2);
  if (!at) return null;
  const x = at.x + GUTTER, y = at.y + GUTTER;
  const c = at.page.surface.getCanvas();
  const src = ck!.XYWHRect(0, 0, w, h);
  // The gutter: the copy stretched one pixel past each side underneath, so the border pixels repeat outwards.
  c.drawImageRectOptions(img, src, ck!.XYWHRect(x - GUTTER, y - GUTTER, w + GUTTER * 2, h + GUTTER * 2), ck!.FilterMode.Nearest, ck!.MipmapMode.None, null);
  c.drawImageRectOptions(img, src, ck!.XYWHRect(x, y, w, h), ck!.FilterMode.Nearest, ck!.MipmapMode.None, null);
  at.page.dirty = true;
  const slot = { page: at.page, x, y, w, h };
  slots.set(img, slot);
  stats.packed++;
  return slot;
}

/**
 * Starts a draw: `surface` is the Skia canvas's surface (pages live in its graphics context). A new surface (context
 * restored) starts over.
 */
export function beginFarAtlas(kit: CanvasKit, surface: Surface | null) {
  if (surface !== gpu) {
    reset();
    gpu = surface;
  }
  ck = kit;
  batch = [];
}

/**
 * Queues `img` drawn into the world rect (x, y, w, h). Returns false if it isn't packed (yet); the caller then flushes
 * (drawFarAtlas) and draws it itself, which keeps the order of everything drawn.
 */
export function addToFarAtlas(img: SkImage, x: number, y: number, w: number, h: number): boolean {
  if (!ck || !gpu) return false;
  const slot = slots.get(img);
  if (!slot) {
    if (img.width() <= MAX_SLOT && img.height() <= MAX_SLOT) waiting.add(img);
    stats.unpacked++;
    return false;
  }
  let b = batch[batch.length - 1];
  if (!b || b.page !== slot.page) batch.push((b = { page: slot.page, src: [], xf: [] }));
  b.src.push(slot.x, slot.y, slot.x + slot.w, slot.y + slot.h);
  // A copy keeps its frame's proportions (its size is the frame's, rounded up to whole pixels): one scale fits both
  // sides to within a pixel of the copy, as drawing it into the rect did.
  const s = Math.min(w / slot.w, h / slot.h);
  b.xf.push(s, 0, x, y);
  return true;
}

/**
 * Packs the copies drawn on their own since last time (call once the view is still). Returns whether anything was
 * packed, so the caller draws again from the pages. When the pages are full they start over with these copies.
 */
export function packFarAtlas(): boolean {
  if (!ck || !gpu || !waiting.size) return false;
  const todo = [...waiting].filter(img => !img.isDeleted() && !slots.has(img));
  waiting = new Set();
  let packed = false;
  for (const img of todo) {
    let slot = pack(img);
    if (!slot && pages.length >= maxPages()) {
      reset();
      stats.resets++;
      slot = pack(img);
    }
    if (slot) packed = true;
  }
  return packed;
}

/** Draws the queued sprites (call before drawing anything else, and at the end of the draw). */
export function drawFarAtlas(c: SkCanvas) {
  if (!ck || !batch.length) return;
  for (const p of pages) {
    if (!p.dirty) continue;
    // A snapshot shares the page's texture until the page is drawn into again.
    free(p.image);
    p.image = own(p.surface.makeImageSnapshot(), 'image');
    p.dirty = false;
  }
  paint ??= own(new ck.Paint(), 'paint');
  for (const b of batch) {
    if (!b.page.image) continue;
    c.drawAtlas(b.page.image, Float32Array.from(b.src), Float32Array.from(b.xf), paint, ck.BlendMode.SrcOver, null, { filter: ck.FilterMode.Linear, mipmap: ck.MipmapMode.None });
    stats.atlasDraws++;
  }
  batch = [];
}

export function farAtlasStats() {
  return { pages: pages.length, slots: slots.size, ...stats };
}
