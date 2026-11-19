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
const MAX_LOADS = 3;

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
  while (loads < MAX_LOADS) {
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

function toImage(bmp: ImageBitmap): Image | null {
  const ck = kitIfLoaded();
  try {
    return ck ? ck.MakeImageFromCanvasImageSource(bmp) : null;
  } finally {
    bmp.close();
  }
}

async function loadSmall(e: Entry) {
  const gen = generation;
  try {
    const blob = await fetchBlob(e.url);
    let bmp = await createImageBitmap(blob);
    e.w = bmp.width;
    e.h = bmp.height;
    const k = Math.min(1, SMALL_SIDE / Math.max(bmp.width, bmp.height));
    if (k < 1) {
      const small = await createImageBitmap(bmp, { resizeWidth: Math.max(1, Math.round(bmp.width * k)), resizeHeight: Math.max(1, Math.round(bmp.height * k)), resizeQuality: 'high' });
      bmp.close();
      bmp = small;
    }
    if (gen !== generation) return bmp.close();
    const img = toImage(bmp);
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

/** Turning a decoded picture into a Skia image copies its pixels on the main thread: one at a time, while still. */
let converting: Promise<void> = Promise.resolve();

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
  let bmp: ImageBitmap | null = null;
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
    const blob = await fetchBlob(e.url);
    const k = Math.min(1, side / Math.max(e.w, e.h, 1));
    bmp = k < 1 ? await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(e.w * k)), resizeHeight: Math.max(1, Math.round(e.h * k)), resizeQuality: 'high' }) : await createImageBitmap(blob);
  } catch {
    // The small version stays; asking again later tries once more.
    e.bigFailures++;
  }
  // The decoding slot is free for the next picture; the swap waits its turn.
  const decoded = bmp;
  converting = converting.then(async () => {
    try {
      if (!decoded) return;
      await untilQuiet();
      if (stale()) {
        decoded.close();
        stats.skipped++;
        return;
      }
      const img = toImage(decoded);
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
  };
}
