// Pictures for Skia: each image URL is fetched, decoded at a capped size and kept as a CPU-side SkImage (it survives a
// lost GPU context; Skia uploads it when drawn, with mipmaps for downscaling). Frames whose pictures are still loading
// are not Skia-eligible yet; when a picture arrives the epoch bumps so their pictures are re-recorded.
import type { CanvasKit, Image } from 'canvaskit-wasm';
import { free, own } from './lifetime';
import { perfLimits } from '../editor/perfLimits';

/** Longest side a picture is decoded at: the snapshot limit, which performance mode halves (2048 / 1024). */
const maxSide = () => perfLimits().bitmapSide;

type Entry = { status: 'loading' | 'ready' | 'failed'; image: Image | null; bytes: number; used: number; /** The epoch at which it finished loading or failed. */ stamp: number; error?: string };

const entries = new Map<string, Entry>();
let epoch = 0;
/** The epoch of the last reset (every picture forgotten). */
let baseEpoch = 0;
const listeners = new Set<() => void>();

export function imageEpoch() {
  return epoch;
}

export function onImagesChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  epoch++;
  listeners.forEach(l => l());
}

/**
 * A number that changes when one of these pictures finishes loading or fails. A frame keeps its recorded picture when
 * some other frame's picture arrives.
 */
export function imageStamp(urls: Iterable<string>): number {
  let stamp = baseEpoch;
  for (const u of urls) stamp = Math.max(stamp, entries.get(u)?.stamp ?? 0);
  return stamp;
}

/** The decoded picture, or null while loading / after a failure (the status says which). Starts loading. */
export function getImage(ck: CanvasKit, url: string): { status: Entry['status']; image: Image | null } {
  let e = entries.get(url);
  if (!e) {
    e = { status: 'loading', image: null, bytes: 0, used: performance.now(), stamp: 0 };
    entries.set(url, e);
    const entry = e;
    (async () => {
      const blob = await fetch(url).then(r => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))));
      let bmp = await createImageBitmap(blob);
      const cap = maxSide();
      const scale = Math.min(1, cap / Math.max(bmp.width, bmp.height));
      if (scale < 1) {
        const small = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(bmp.width * scale)), resizeHeight: Math.max(1, Math.round(bmp.height * scale)), resizeQuality: 'high' });
        bmp.close();
        bmp = small;
      }
      const img = ck.MakeImageFromCanvasImageSource(bmp);
      bmp.close();
      if (!img) throw new Error('could not decode');
      entry.image = own(img, 'image');
      entry.bytes = img.width() * img.height() * 4;
      entry.status = 'ready';
      entry.stamp = epoch + 1;
      changed();
    })().catch(err => {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      entry.stamp = epoch + 1;
      changed();
    });
  }
  e.used = performance.now();
  return { status: e.status, image: e.image };
}

/** Frees every decoded picture (Skia switched off). */
export function resetImages() {
  for (const e of entries.values()) free(e.image);
  entries.clear();
  baseEpoch = ++epoch;
}

export function imageStats() {
  let ready = 0, loading = 0, failed = 0, bytes = 0;
  for (const e of entries.values()) {
    if (e.status === 'ready') (ready++, (bytes += e.bytes));
    else if (e.status === 'loading') loading++;
    else failed++;
  }
  return { ready, loading, failed, decodedMB: Math.round(bytes / 1048576) };
}
