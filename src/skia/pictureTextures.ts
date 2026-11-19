// Far zoomed out, drawing a frame's recorded picture every frame would replay every node; instead the picture is
// rasterised once into an image at the size the zoom needs (levels halve, like the snapshot mip levels in lod.ts) and
// that image is drawn with mipmaps. Close up, the picture is drawn directly and stays sharp at any zoom.
// Images are CPU-side (they survive a lost context) and kept in a least-recently-used byte budget.
import type { CanvasKit, Image as SkImage, SkPicture } from 'canvaskit-wasm';
import { free, own } from './lifetime';
import { perfLimits } from '../editor/perfLimits';

type Entry = { picture: SkPicture; side: number; image: SkImage; bytes: number; used: number };

/** Byte budget for rasterised pictures; performance mode halves it. */
const BUDGET = 192 * 1024 * 1024;
const MIN_SIDE = 48;

const entries = new Map<string, Entry>(); // `${key}@${side}`
let bytes = 0;
const stats = { rasterised: 0, evictions: 0 };

function budget() {
  return perfLimits().bitmapSide < 2048 ? BUDGET / 2 : BUDGET;
}

/** Longest side, in pixels, a frame of `size` world px needs at this zoom and pixel ratio, rounded up to a level. */
export function levelSide(size: number, zoom: number, dpr: number) {
  const max = perfLimits().bitmapSide;
  const want = Math.max(MIN_SIDE, size * zoom * dpr);
  let side = max;
  while (side / 2 >= want && side / 2 >= MIN_SIDE) side /= 2;
  return side;
}

/**
 * The picture rasterised so its longest side is `side` px (bounds: the frame's world box), or null if it can't be
 * made. Rasterising happens synchronously the first time; callers draw it scaled into the frame's box.
 */
export function pictureImage(ck: CanvasKit, key: string, picture: SkPicture, bounds: { x: number; y: number; w: number; h: number }, side: number, create = true): SkImage | null {
  const id = `${key}@${side}`;
  const hit = entries.get(id);
  if (hit && hit.picture === picture) {
    hit.used = performance.now();
    return hit.image;
  }
  if (!create) return null;
  if (hit) drop(id, hit);
  const k = side / Math.max(bounds.w, bounds.h, 1);
  const w = Math.max(1, Math.ceil(bounds.w * k)), h = Math.max(1, Math.ceil(bounds.h * k));
  const surface = ck.MakeSurface(w, h);
  if (!surface) return null;
  try {
    const c = surface.getCanvas();
    c.clear(ck.TRANSPARENT);
    c.scale(k, k);
    c.translate(-bounds.x, -bounds.y);
    c.drawPicture(picture);
    surface.flush();
    const image = own(surface.makeImageSnapshot(), 'image');
    const e: Entry = { picture, side, image, bytes: w * h * 4, used: performance.now() };
    entries.set(id, e);
    bytes += e.bytes;
    stats.rasterised++;
    evict();
    return image;
  } finally {
    surface.delete();
  }
}

function drop(id: string, e: Entry) {
  free(e.image);
  bytes -= e.bytes;
  entries.delete(id);
}

function evict() {
  if (bytes <= budget()) return;
  const old = [...entries.entries()].sort((a, b) => a[1].used - b[1].used);
  for (const [id, e] of old) {
    if (bytes <= budget()) break;
    drop(id, e);
    stats.evictions++;
  }
}

/** Forgets a frame's images (its picture was re-recorded or the frame is gone). */
export function dropPictureImages(key: string) {
  for (const [id, e] of entries) if (id.slice(0, id.lastIndexOf('@')) === key) drop(id, e);
}

export function resetPictureImages() {
  for (const [id, e] of entries) drop(id, e);
}

export function pictureImageStats() {
  return { images: entries.size, MB: Math.round(bytes / 1048576), budgetMB: Math.round(budget() / 1048576), ...stats };
}
