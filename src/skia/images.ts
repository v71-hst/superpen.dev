// Pictures for Skia: each image URL is fetched, decoded at a capped size and kept as a CPU-side SkImage (it survives a
// lost GPU context; Skia uploads it when drawn, with mipmaps for downscaling). Frames whose pictures are still loading
// are not Skia-eligible yet; when a picture arrives the epoch bumps so their pictures are re-recorded.
import type { CanvasKit, Image } from 'canvaskit-wasm';
import { free, own } from './lifetime';
import { perfLimits } from '../editor/perfLimits';

/** Longest side a picture is decoded at: the snapshot limit, which performance mode halves (2048 / 1024). */
const maxSide = () => perfLimits().bitmapSide;

type Entry = { status: 'loading' | 'ready' | 'failed'; image: Image | null; bytes: number; used: number; error?: string };

const entries = new Map<string, Entry>();
let epoch = 0;
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

/** The decoded picture, or null while loading / after a failure (the status says which). Starts loading. */
export function getImage(ck: CanvasKit, url: string): { status: Entry['status']; image: Image | null } {
  let e = entries.get(url);
  if (!e) {
    e = { status: 'loading', image: null, bytes: 0, used: performance.now() };
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
      changed();
    })().catch(err => {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      changed();
    });
  }
  e.used = performance.now();
  return { status: e.status, image: e.image };
}

/** Frees pictures not used for a while (pictures recorded since keep their own reference inside the SkPicture). */
export function trimImages(maxAgeMs = 60_000) {
  const now = performance.now();
  for (const [url, e] of entries) {
    if (e.status === 'ready' && now - e.used > maxAgeMs) {
      free(e.image);
      entries.delete(url);
    }
  }
}

/** Frees every decoded picture (Skia switched off). */
export function resetImages() {
  for (const e of entries.values()) free(e.image);
  entries.clear();
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
