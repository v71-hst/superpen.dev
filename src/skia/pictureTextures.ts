// Far zoomed out, drawing a frame's recorded picture every frame would replay every node; instead the picture is drawn
// once into a texture and that texture is drawn. One copy per frame, as a chain of halved levels: it serves every
// zoom at or below the size it was made for, and is only made again, sharper, when the zoom needs more pixels than it
// has; until then the blurrier copy is drawn. Close up, the picture is drawn directly and stays sharp at any zoom.
// Copies are made by the graphics card (the processor takes several times longer for the same picture), so they are
// lost with the graphics context: SkiaLayer drops them all then, and they are made again from the pictures, which
// live on the CPU side. A least-recently-used byte budget bounds them.
import type { CanvasKit, Image as SkImage, SkPicture, Surface } from 'canvaskit-wasm';
import { free, own } from './lifetime';
import { perfLimits } from '../editor/perfLimits';

/** levels[i] is the copy at side / 2^i. */
type Entry = { picture: SkPicture; side: number; levels: SkImage[]; bytes: number; used: number };

/** Byte budget for copies; performance mode halves it. */
const BUDGET = 192 * 1024 * 1024;
const MIN_SIDE = 48;

const entries = new Map<string, Entry>(); // by frame key
let bytes = 0;
const stats = { rasterised: 0, evictions: 0, rasterMs: 0, slowestRasterMs: 0 };

const lowMemory = () => perfLimits().bitmapSide < 2048;

function budget() {
  return lowMemory() ? BUDGET / 2 : BUDGET;
}

/** Longest side, in pixels, a frame of `size` world px needs at this zoom and pixel ratio, rounded up to a level. */
export function levelSide(size: number, zoom: number, dpr: number) {
  const max = perfLimits().bitmapSide;
  const want = Math.max(MIN_SIDE, size * zoom * dpr);
  let side = max;
  while (side / 2 >= want && side / 2 >= MIN_SIDE) side /= 2;
  return side;
}

/** The size copies are made at ahead of need: enough for a frame a few centimetres across on screen. */
export function baseSide() {
  return lowMemory() ? 128 : 256;
}

/** Whether the frame has a copy of this picture (of any size). */
export function hasPictureCopy(key: string, picture: SkPicture) {
  return entries.get(key)?.picture === picture;
}

/**
 * The image to draw for a frame at `side` pixels (bounds: the frame's world box; callers draw it scaled into that
 * box with plain linear filtering: the level returned is never more than twice the size asked for), and whether the
 * copy has that many pixels. A copy that is too small is made again when `create` allows; otherwise its largest level
 * is returned. null: there is no copy and none could be made now. `surface`: the Skia canvas's own surface, whose
 * graphics context the copies are made in.
 */
export function pictureCopy(ck: CanvasKit, surface: Surface, key: string, picture: SkPicture, bounds: { x: number; y: number; w: number; h: number }, side: number, create = true): { image: SkImage; sharp: boolean } | null {
  let hit = entries.get(key);
  if (hit && hit.picture !== picture) {
    drop(key, hit);
    hit = undefined;
  }
  if (hit) hit.used = performance.now();
  if (hit && hit.side >= side) return { image: hit.levels[Math.min(hit.levels.length - 1, Math.round(Math.log2(hit.side / side)))], sharp: true };
  const made = create ? rasterise(ck, surface, picture, bounds, side) : null;
  if (!made) return hit ? { image: hit.levels[0], sharp: false } : null;
  if (hit) drop(key, hit);
  entries.set(key, made);
  bytes += made.bytes;
  evict(key);
  return { image: made.levels[0], sharp: true };
}

function rasterise(ck: CanvasKit, surface: Surface, picture: SkPicture, bounds: { x: number; y: number; w: number; h: number }, side: number): Entry | null {
  const t0 = performance.now();
  const k = side / Math.max(bounds.w, bounds.h, 1);
  let w = Math.max(1, Math.ceil(bounds.w * k)), h = Math.max(1, Math.ceil(bounds.h * k));
  const info = (width: number, height: number) => ({ width, height, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB });
  const levels: SkImage[] = [];
  let total = 0;
  /** Draws into a new texture the size of this level and keeps it as an image. */
  const level = (draw: (c: ReturnType<Surface['getCanvas']>) => void) => {
    const s = surface.makeSurface(info(w, h));
    if (!s) return false;
    try {
      const c = s.getCanvas();
      c.clear(ck.TRANSPARENT);
      draw(c);
      s.flush();
      levels.push(own(s.makeImageSnapshot(), 'image'));
      total += w * h * 4;
      return true;
    } finally {
      s.delete();
    }
  };
  try {
    const ok = level(c => {
      // The frame's box onto the whole texture (its size is rounded up to whole pixels), so every level maps back
      // onto exactly that box.
      c.scale(w / Math.max(bounds.w, 1e-6), h / Math.max(bounds.h, 1e-6));
      c.translate(-bounds.x, -bounds.y);
      c.drawPicture(picture);
    });
    if (!ok) return null;
    // Each smaller level is the one before it at half the size (an exact 2×2 average with linear filtering).
    for (let s = side / 2; s >= MIN_SIDE; s /= 2) {
      const prev = levels[levels.length - 1];
      const pw = w, ph = h;
      w = Math.max(1, Math.ceil(w / 2));
      h = Math.max(1, Math.ceil(h / 2));
      if (!level(c => c.drawImageRectOptions(prev, ck.XYWHRect(0, 0, pw, ph), ck.XYWHRect(0, 0, w, h), ck.FilterMode.Linear, ck.MipmapMode.None, null))) break;
    }
  } catch (e) {
    for (const l of levels) free(l);
    throw e;
  }
  stats.rasterised++;
  const ms = performance.now() - t0;
  stats.rasterMs += ms;
  stats.slowestRasterMs = Math.max(stats.slowestRasterMs, ms);
  return { picture, side, levels, bytes: total, used: performance.now() };
}

function drop(key: string, e: Entry) {
  for (const l of e.levels) free(l);
  bytes -= e.bytes;
  if (entries.get(key) === e) entries.delete(key);
}

/** Frees least-recently-used copies over the budget, never the one just made. */
function evict(keep: string) {
  if (bytes <= budget()) return;
  const old = [...entries.entries()].filter(([k]) => k !== keep).sort((a, b) => a[1].used - b[1].used);
  for (const [k, e] of old) {
    if (bytes <= budget()) break;
    drop(k, e);
    stats.evictions++;
  }
}

/** Forgets a frame's copy (its picture was re-recorded or the frame is gone). */
export function dropPictureImages(key: string) {
  const e = entries.get(key);
  if (e) drop(key, e);
}

/** Forgets every copy (the graphics context they lived in is gone, or Skia was switched off). */
export function resetPictureImages() {
  for (const [k, e] of [...entries]) drop(k, e);
}

export function pictureImageStats() {
  let levelImages = 0;
  for (const e of entries.values()) levelImages += e.levels.length;
  return { images: entries.size, levelImages, MB: Math.round(bytes / 1048576), budgetMB: Math.round(budget() / 1048576), ...stats, rasterMs: Math.round(stats.rasterMs), slowestRasterMs: Math.round(stats.slowestRasterMs) };
}
