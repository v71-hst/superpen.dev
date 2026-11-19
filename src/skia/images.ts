// Pictures for Skia, kept in two sizes. A small version of every picture (256 px on its longest side) is decoded as
// soon as a frame asks for it: it decides whether Skia can draw the frame, and it is all a zoomed-out frame needs. A
// larger version is decoded only while something on screen shows the picture bigger than that (wantImage, called by
// the scene for what is in view once the view has settled), at the size the screen needs, and dropped again when
// nothing has needed it for a while or the byte budget is full. Both are CPU-side SkImages (they survive a lost GPU
// context; Skia uploads them when drawn, with mipmaps for downscaling). Every change moves the picture's stamp, so the
// frames that use it record their pictures again with whichever version is there now. Only frames that are in view
// and show a picture large draw its larger version (frames.ts keeps that per frame): a picture shared by a hundred
// frames sharpening for one of them leaves the others alone.
import type { Image } from 'canvaskit-wasm';
import { kitIfLoaded } from './kit';
import { free, own } from './lifetime';
import { perfLimits } from '../editor/perfLimits';

/** Longest side a picture is ever decoded at: the snapshot limit, which performance mode halves (2048 / 1024). */
const maxSide = () => perfLimits().bitmapSide;
/** Longest side of the version every picture gets. */
const SMALL_SIDE = 256;
/** Bytes of larger versions kept; performance mode halves it. What is on screen is never dropped to get under it. */
const BUDGET = 128 * 1024 * 1024;
/** A larger version nothing on screen has needed for this long is dropped. */
export const KEEP_MS = 30000;
/** Needed this recently counts as on screen (the scene reports what is in view every few seconds). */
const RECENT_MS = 9000;
/**
 * Pictures decoded at once. Decoding happens in workers (see decode), so this is how many of those are busy, not
 * how much the editor's own thread is asked to do: half the processor's cores, between 2 and 4. Performance mode
 * keeps it at 2 (each decode in flight holds the whole picture for a moment).
 */
const maxLoads = () => (maxSide() < 2048 ? 2 : Math.max(2, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))));

type Entry = {
  url: string;
  status: 'loading' | 'ready' | 'failed';
  small: Image | null;
  smallSide: number;
  smallBytes: number;
  /** Size of the original, known once the small version is decoded. */
  w: number;
  h: number;
  big: Image | null;
  /** Longest side of the larger version (0: there is none). */
  bigSide: number;
  bigBytes: number;
  /** Longest side of the larger version being loaded or queued (0: none), and whether a load is queued or under way. */
  loadingSide: number;
  busy: boolean;
  /** Larger versions that did not decode; after two the small one is all there will be. */
  bigFailures: number;
  /** The pass (see beginWantPass) that last asked for a larger version. */
  wantPass: number;
  /** When something on screen last needed more than the small version. */
  bigUsed: number;
  /** The epoch at which it last changed (loaded, failed, larger version arrived or dropped). */
  stamp: number;
  /** The epoch at which it loaded or failed: all that matters to a frame drawing the small version. */
  smallStamp: number;
  error?: string;
};

const entries = new Map<string, Entry>();
let epoch = 0;
/** The epoch of the last reset (every picture forgotten). */
let baseEpoch = 0;
/** Bumped by a reset: loads that finish afterwards throw their result away. */
let generation = 0;
let bigBytes = 0;
let pass = 0;
const stats = { sharpened: 0, dropped: 0, skipped: 0 };
const listeners = new Set<(eligibility: boolean) => void>();
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let notifyEligibility = false;
let quietMs: () => number = () => Infinity;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function imageEpoch() {
  return epoch;
}

/**
 * Told (at most once per frame) when pictures changed. `eligibility`: a picture finished loading or failed, so frames
 * may have become drawable; otherwise only a larger version came or went.
 */
export function onImagesChanged(fn: (eligibility: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The scene says how long the view and pointer have been still: larger versions are only swapped in then. */
export function setImageQuietSource(fn: (() => number) | null) {
  quietMs = fn ?? (() => Infinity);
}

function touch(e: Entry, eligibility: boolean) {
  e.stamp = ++epoch;
  if (eligibility) e.smallStamp = e.stamp;
  notifyEligibility ||= eligibility;
  notifyTimer ??= setTimeout(() => {
    notifyTimer = null;
    const elig = notifyEligibility;
    notifyEligibility = false;
    listeners.forEach(l => l(elig));
  }, 16);
}

/**
 * A number that changes when one of these pictures changes (`detail` false: only when one loads or fails, which is
 * all a frame drawing the small versions sees). A frame keeps its recorded picture when some other frame's picture
 * arrives.
 */
export function imageStamp(urls: Iterable<string>, detail = true): number {
  let stamp = baseEpoch;
  for (const u of urls) {
    const e = entries.get(u);
    if (e) stamp = Math.max(stamp, detail ? e.stamp : e.smallStamp);
  }
  return stamp;
}

// ---------- loading ----------

let loads = 0;
const smallQueue: (() => Promise<void>)[] = [];
const bigQueue: (() => Promise<void>)[] = [];

function pump() {
  while (loads < maxLoads()) {
    const task = smallQueue.shift() ?? bigQueue.shift();
    if (!task) return;
    loads++;
    void task().finally(() => {
      loads--;
      pump();
    });
  }
}

const fetchBlob = (url: string) => fetch(url).then(r => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))));

// ---------- decoding ----------
//
// A picture is decoded straight to the size that is wanted, in a worker, and comes back as plain pixels:
// - Until 1.0.0 the small version decoded the whole picture and then shrank it (two passes, the first one at full
//   size), and turning any decoded picture into a Skia image drew it on a canvas and read it back, both on the
//   editor's own thread: 10-40 ms per large picture, which is why they were converted one at a time, only while the
//   view was still. Now the worker does the decoding, the shrinking and the reading back; the editor's thread only
//   copies the finished pixels into Skia's memory (a few ms for the largest).
// - To decode at a size, the picture's own size has to be known first: it is read from the file's header.
// The worker is made from text (the webview only allows workers from blob: addresses) and is handed the file's
// bytes, so it never fetches anything itself. If a worker cannot be made, or one fails, pictures are decoded on the
// editor's thread as before.

/** Pixels of a decoded picture (RGBA, not premultiplied) and the size of the original. */
type Decoded = { w0: number; h0: number; width: number; height: number; pixels: ArrayBuffer };

const DECODER = `
const u16 = (b, o, le) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
// Width and height from the start of a PNG, GIF, WebP or JPEG file; null when it cannot be told.
function sniff(b) {
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return [u32(b, 16), u32(b, 20)];
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return [u16(b, 6, true), u16(b, 8, true)];
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const t = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (t === 'VP8X') return [1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16))];
    if (t === 'VP8 ') return [u16(b, 26, true) & 0x3fff, u16(b, 28, true) & 0x3fff];
    if (t === 'VP8L') { const n = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0; return [(n & 0x3fff) + 1, ((n >>> 14) & 0x3fff) + 1]; }
    return null;
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) { o++; continue; }
      const m = b[o + 1];
      if (m === 0xff) { o++; continue; }
      if (m >= 0xd0 && m <= 0xd9) { o += 2; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [u16(b, o + 7, false), u16(b, o + 5, false)];
      o += 2 + u16(b, o + 2, false);
    }
  }
  return null;
}
async function decode(blob, side) {
  let dims = null;
  try { dims = sniff(new Uint8Array(await blob.slice(0, 262144).arrayBuffer())); } catch (e) {}
  let bmp = null, w0 = 0, h0 = 0;
  if (dims && dims[0] > 0 && dims[1] > 0) {
    const k = Math.min(1, side / Math.max(dims[0], dims[1]));
    if (k < 1) {
      // Only the width is given: the decoder keeps the picture's proportions (and applies a photo's rotation). If
      // the height it comes back with is not what the header promised, the header was misread: decode whole below.
      const b = await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(dims[0] * k)), resizeQuality: 'high' });
      const want = Math.max(1, Math.round(dims[1] * k));
      if (Math.abs(b.height - want) <= Math.max(2, want * 0.03)) { bmp = b; w0 = dims[0]; h0 = dims[1]; }
      else b.close();
    }
  }
  if (!bmp) {
    let full = await createImageBitmap(blob);
    w0 = full.width; h0 = full.height;
    const k = Math.min(1, side / Math.max(w0, h0));
    if (k < 1) {
      const s = await createImageBitmap(full, { resizeWidth: Math.max(1, Math.round(w0 * k)), resizeHeight: Math.max(1, Math.round(h0 * k)), resizeQuality: 'high' });
      full.close();
      full = s;
    }
    bmp = full;
  }
  const width = bmp.width, height = bmp.height;
  const g = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return { w0, h0, width, height, pixels: g.getImageData(0, 0, width, height).data.buffer };
}
onmessage = async e => {
  const { id, blob, side } = e.data;
  try { const r = await decode(blob, side); postMessage({ id, ...r }, [r.pixels]); }
  catch (err) { postMessage({ id, error: String((err && err.message) || err) }); }
};
`;

let decoders: Worker[] | null = null;
let decodersBroken = false;
let decoderTurn = 0;
let decodeId = 0;
const decoding = new Map<number, { resolve: (d: Decoded) => void; reject: (e: Error) => void }>();
const decodeStats = { offThread: 0, onThread: 0 };

function decoderFailed(why: string) {
  decodersBroken = true;
  for (const w of decoders ?? []) w.terminate();
  decoders = null;
  const waiting = [...decoding.values()];
  decoding.clear();
  for (const w of waiting) w.reject(new Error(why));
}

function decoder(): Worker | null {
  if (decodersBroken || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;
  if (!decoders) {
    try {
      const src = URL.createObjectURL(new Blob([DECODER], { type: 'text/javascript' }));
      decoders = Array.from({ length: 4 }, () => {
        const w = new Worker(src);
        w.onmessage = ev => {
          const job = decoding.get(ev.data?.id);
          if (!job) return;
          decoding.delete(ev.data.id);
          if (ev.data.error) job.reject(new Error(ev.data.error));
          else job.resolve(ev.data as Decoded);
        };
        w.onerror = () => decoderFailed('the picture decoder stopped');
        return w;
      });
    } catch {
      decodersBroken = true;
      return null;
    }
  }
  return decoders[decoderTurn++ % decoders.length];
}

/** The picture at `side` pixels on its longest side (or whole, if it is smaller), as something Skia can take. */
async function decode(blob: Blob, side: number): Promise<{ w0: number; h0: number; make: () => Image | null; discard: () => void }> {
  const w = decoder();
  if (w) {
    try {
      const d = await new Promise<Decoded>((resolve, reject) => {
        const id = ++decodeId;
        decoding.set(id, { resolve, reject });
        w.postMessage({ id, blob, side });
      });
      decodeStats.offThread++;
      return {
        w0: d.w0,
        h0: d.h0,
        make: () => {
          const ck = kitIfLoaded();
          return ck ? ck.MakeImage({ width: d.width, height: d.height, alphaType: ck.AlphaType.Unpremul, colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB }, new Uint8Array(d.pixels), 4 * d.width) : null;
        },
        discard: () => undefined,
      };
    } catch {
      // This picture (or the worker) could not: the editor's own thread tries, as it always did.
    }
  }
  let bmp = await createImageBitmap(blob);
  const w0 = bmp.width;
  const h0 = bmp.height;
  const k = Math.min(1, side / Math.max(w0, h0));
  if (k < 1) {
    const s = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(w0 * k)), resizeHeight: Math.max(1, Math.round(h0 * k)), resizeQuality: 'high' });
    bmp.close();
    bmp = s;
  }
  decodeStats.onThread++;
  const got = bmp;
  return {
    w0,
    h0,
    make: () => {
      const ck = kitIfLoaded();
      try {
        return ck ? ck.MakeImageFromCanvasImageSource(got) : null;
      } finally {
        got.close();
      }
    },
    discard: () => got.close(),
  };
}

async function loadSmall(e: Entry) {
  const gen = generation;
  try {
    const d = await decode(await fetchBlob(e.url), SMALL_SIDE);
    if (gen !== generation) return d.discard();
    e.w = d.w0;
    e.h = d.h0;
    const img = d.make();
    if (!img) throw new Error('could not decode');
    e.small = own(img, 'image');
    e.smallSide = Math.max(img.width(), img.height());
    e.smallBytes = img.width() * img.height() * 4;
    e.status = 'ready';
  } catch (err) {
    if (gen !== generation) return;
    e.status = 'failed';
    e.error = err instanceof Error ? err.message : String(err);
  }
  touch(e, true);
}

/**
 * Larger versions are swapped in one after another, while the view is still: each swap makes the frames that show
 * the picture record again, which is work on the editor's thread even though the decoding no longer is.
 */
let converting: Promise<void> = Promise.resolve();
/** Bytes of larger versions swapped in since the last pause (see loadBig). */
let swappedBytes = 0;
const SWAP_BYTES_PER_FRAME = 5 * 1024 * 1024;

async function untilQuiet() {
  const giveUp = performance.now() + 3000;
  for (;;) {
    const q = quietMs();
    if (q >= 120 || performance.now() > giveUp) return;
    await sleep(Math.max(16, 120 - q));
  }
}

async function loadBig(e: Entry) {
  const gen = generation;
  // The size wanted now, which may be more than when the load was queued.
  const side = e.loadingSide;
  const stale = () => gen !== generation || e.wantPass < pass;
  let got: Awaited<ReturnType<typeof decode>> | null = null;
  // Asked for while passing by, and no longer in view: not worth decoding.
  if (stale()) {
    stats.skipped++;
    if (gen === generation) {
      e.busy = false;
      e.loadingSide = 0;
    }
    return;
  }
  try {
    got = await decode(await fetchBlob(e.url), side);
  } catch {
    // The small version stays; asking again later tries once more.
    e.bigFailures++;
  }
  // The decoding slot is free for the next picture; the swap waits its turn.
  const decoded = got;
  converting = converting.then(async () => {
    try {
      if (!decoded) return;
      await untilQuiet();
      if (stale()) {
        decoded.discard();
        stats.skipped++;
        return;
      }
      const img = decoded.make();
      if (!img) return void e.bigFailures++;
      if (e.big) {
        free(e.big);
        bigBytes -= e.bigBytes;
      }
      e.big = own(img, 'image');
      e.bigSide = Math.max(img.width(), img.height());
      e.bigBytes = img.width() * img.height() * 4;
      bigBytes += e.bigBytes;
      e.bigUsed = performance.now();
      stats.sharpened++;
      touch(e, false);
      evictOver();
      // Each new version is handed to the graphics card (with its smaller copies) the next time it is drawn: several
      // large ones in one draw made a frame of 60 ms. After a few megabytes' worth, the rest wait for the next frames.
      swappedBytes += e.bigBytes;
      if (swappedBytes >= SWAP_BYTES_PER_FRAME) {
        swappedBytes = 0;
        await sleep(34);
      }
    } catch {
      // As above.
    } finally {
      if (gen === generation) {
        e.busy = false;
        // Asked for more while this one was loading (and still in view): go again.
        if (e.loadingSide > side && e.loadingSide > e.bigSide && !stale()) queueBig(e);
        else e.loadingSide = 0;
      }
    }
  });
}

function queueBig(e: Entry) {
  e.busy = true;
  bigQueue.push(() => loadBig(e));
  pump();
}

// ---------- asking ----------

/**
 * The best version of a picture there is now, or with `detail` false its small version (null while loading / after a
 * failure; the status says which), and the original's size: geometry is computed from that, so it doesn't shift when
 * a version of another size arrives. Starts loading the small version.
 */
export function getImage(url: string, detail = true): { status: Entry['status']; image: Image | null; w: number; h: number } {
  let e = entries.get(url);
  if (!e) {
    e = { url, status: 'loading', small: null, smallSide: 0, smallBytes: 0, w: 0, h: 0, big: null, bigSide: 0, bigBytes: 0, loadingSide: 0, busy: false, bigFailures: 0, wantPass: 0, bigUsed: 0, stamp: 0, smallStamp: 0 };
    entries.set(url, e);
    const entry = e;
    smallQueue.push(() => loadSmall(entry));
    pump();
  }
  return { status: e.status, image: (detail ? e.big : null) ?? e.small, w: e.w, h: e.h };
}

/** The scene is about to report everything in view (wantImage): requests from earlier passes that haven't started are dropped. */
export function beginWantPass() {
  pass++;
}

/**
 * Something on screen shows this picture `side` device pixels long. If that is more than the version there is, a
 * larger one is loaded (sizes double from the small one up to the original or the decode limit). `pinned`: not part of
 * a pass, never dropped as out of view (tests). Returns whether the small version is too small for it.
 */
export function wantImage(url: string, side: number, pinned = false): boolean {
  const e = entries.get(url);
  if (!e || !e.small || e.bigFailures >= 2) return false;
  const cap = Math.min(maxSide(), Math.max(e.w, e.h));
  const need = Math.min(side, cap);
  if (need <= e.smallSide * 1.1) return false;
  e.bigUsed = performance.now();
  e.wantPass = pinned ? Infinity : Math.max(e.wantPass, pass);
  if (e.big && e.bigSide >= need * 0.9) return true;
  let target = SMALL_SIDE * 2;
  while (target < need) target *= 2;
  // Close to all there is: take all of it, rather than this and then the rest.
  if (target >= cap * 0.75) target = cap;
  if (e.loadingSide >= target || (e.big && e.bigSide >= target)) return true;
  e.loadingSide = target;
  if (!e.busy) queueBig(e);
  return true;
}

// ---------- dropping ----------

function budget() {
  return maxSide() < 2048 ? BUDGET / 2 : BUDGET;
}

function dropBig(e: Entry) {
  free(e.big);
  e.big = null;
  bigBytes -= e.bigBytes;
  e.bigBytes = 0;
  e.bigSide = 0;
  stats.dropped++;
  // The frames drawn with it record again with the small version, which lets go of the larger one's pixels.
  touch(e, false);
}

/** Over the budget: drops the least recently needed larger versions, never one that is on screen. */
function evictOver() {
  const limit = budget();
  if (bigBytes <= limit) return;
  const now = performance.now();
  const old = [...entries.values()].filter(e => e.big && now - e.bigUsed > RECENT_MS).sort((a, b) => a.bigUsed - b.bigUsed);
  for (const e of old) {
    if (bigBytes <= limit) break;
    dropBig(e);
  }
}

/**
 * Drops larger versions nothing on screen has needed for a while (the scene calls this every few seconds, after
 * reporting what is in view), and ones above the decode limit (performance mode was switched on).
 */
export function trimImages() {
  const now = performance.now();
  const cap = maxSide();
  for (const e of entries.values()) if (e.big && (now - e.bigUsed > KEEP_MS || e.bigSide > cap)) dropBig(e);
  evictOver();
}

/** Frees every decoded picture (Skia switched off). */
export function resetImages() {
  for (const e of entries.values()) {
    free(e.small);
    free(e.big);
  }
  entries.clear();
  smallQueue.length = 0;
  bigQueue.length = 0;
  for (const w of decoders ?? []) w.terminate();
  decoders = null;
  const waiting = [...decoding.values()];
  decoding.clear();
  for (const w of waiting) w.reject(new Error('pictures were reset'));
  bigBytes = 0;
  generation++;
  baseEpoch = ++epoch;
}

export function imageStats() {
  let ready = 0, loading = 0, failed = 0, small = 0, larger = 0, sharpening = 0;
  for (const e of entries.values()) {
    if (e.status === 'ready') (ready++, (small += e.smallBytes));
    else if (e.status === 'loading') loading++;
    else failed++;
    if (e.big) larger++;
    if (e.loadingSide) sharpening++;
  }
  const mb = (b: number) => Math.round(b / 104857.6) / 10;
  return {
    ready, loading, failed,
    /** Larger versions held, and being loaded. */
    larger, sharpening,
    /** CanvasKit images held: one small version per ready picture plus the larger ones. */
    held: ready + larger,
    decodedMB: Math.round((small + bigBytes) / 1048576), smallMB: mb(small), largerMB: mb(bigBytes), budgetMB: Math.round(budget() / 1048576),
    ...stats,
    /** Pictures decoded in a worker, and on the editor's thread (the worker could not be used). */
    decodedOffThread: decodeStats.offThread, decodedOnThread: decodeStats.onThread,
  };
}
