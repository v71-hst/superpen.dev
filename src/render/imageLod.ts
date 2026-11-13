// Image fills on the canvas are drawn from copies sized for the current zoom. Handing the browser a 4K picture to
// fill a box that is 300px wide on screen makes it decode, scale and upload the full image, again for every zoom
// level; a file with a dozen large pictures then costs over a gigabyte of graphics memory and stalls on each zoom.
// Each picture is fetched once, half-size copies ("levels") are made on demand off the main thread, and nodes show
// the smallest level that still has a pixel per screen pixel, switching after zooming pauses. A level is only shown
// once it is decoded, so swaps never flash. Pictures that are off screen stay at a small level until they come
// near the viewport. Captures and exports map levels back to the original (see originalOf).
import { useEffect, useSyncExternalStore } from 'react';
import { useStore } from '../editor/store';
import { onAssetsChanged } from './scripts';
import { SOFT, isBlank } from './pixels';

export type ImageBox = { w: number; h: number; mode?: string };

/** Shown until a picture's first level is ready (transparent pixel). */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const MIN_SIDE = 256;
/** Pictures nowhere near the viewport are kept at this level at most (enough for snapshots and a first glimpse). */
const OFFSCREEN_SIDE = 512;
/** The level key of the picture itself. */
const FULL = Infinity;

type Entry = {
  /** loading: being fetched; ready: size known, levels available; plain: always shown as-is (svg, gif, unknown, unreachable). */
  state: 'loading' | 'ready' | 'plain';
  url: string;
  /** What "the original" is shown from: a blob of the fetched file (ready) or the url itself (plain). */
  src: string;
  w: number;
  h: number;
  /** Level side (longest side in pixels, or FULL) -> url that is loaded and decoded. */
  ready: Map<number, string>;
  making: Set<number>;
  /** Keeps each level's decoded image alive so switching to it paints at once. */
  keep: Map<number, HTMLImageElement>;
  /** Bumped when this picture's levels change, so only the nodes showing it re-render. */
  version: number;
};

const entries = new Map<string, Entry>();
const sources = new Map<string, string>();
let pending = 0;
let idleWaiters: (() => void)[] = [];

// ---- change notification (nodes with image fills re-render) ----
let epoch = 0;
let versionSum = 0;
const listeners = new Set<() => void>();
let notifyTimer: ReturnType<typeof setTimeout> | undefined;
/** Without an entry: everything showing a picture re-renders (zoom level or mode changed). */
function bump(e?: Entry) {
  if (e) {
    e.version++;
    versionSum++;
  } else epoch++;
  // Coalesced; a timer rather than an animation frame so a hidden tab (no frames) still updates before a capture.
  if (notifyTimer === undefined)
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      for (const l of listeners) l();
    }, 16);
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/**
 * Re-renders the calling component when the levels of its pictures change. `urls` are the resolved urls of its image
 * fills (none: never re-renders); omit them to follow every picture.
 */
export function useImageEpoch(urls?: readonly string[]) {
  return useSyncExternalStore(subscribe, () => {
    if (!urls) return epoch + versionSum;
    if (!urls.length) return 0;
    let v = epoch;
    for (const u of urls) v += entries.get(u)?.version ?? 0;
    return v;
  });
}

/** The urls of a node's image fills (fill and stroke), unresolved. */
export function imageFillUrls(p: any): string[] {
  const out: string[] = [];
  const add = (x: any) => {
    for (const f of Array.isArray(x) ? x : [x]) if (f && typeof f === 'object' && f.type === 'image' && typeof f.url === 'string' && f.url) out.push(f.url);
  };
  add(p?.fill);
  add(p?.stroke);
  add(p?.stroke?.fill);
  return out;
}

// ---- which pictures are near the viewport ----
const onScreen = new Map<string, number>();
const observed = new WeakMap<Element, { urls: readonly string[]; on: boolean }>();
let io: IntersectionObserver | null = null;
function setOn(urls: readonly string[], d: 1 | -1) {
  for (const u of urls) {
    const n = (onScreen.get(u) ?? 0) + d;
    if (n > 0) onScreen.set(u, n);
    else onScreen.delete(u);
    const e = entries.get(u);
    if (!e) continue;
    if (d === 1 && n === 1) bump(e);
    // Out of sight: let go of the full-size picture if a level can stand in for it.
    if (n <= 0) releaseFull(e);
  }
}

/** Lets the pictures of the canvas node `key` sharpen while its element is near the viewport. */
export function useImageVisibility(key: string, urls: readonly string[]) {
  const id = urls.join(' ');
  useEffect(() => {
    if (!urls.length) return;
    const el = document.querySelector(`#pen-world [data-k="${CSS.escape(key)}"]`);
    if (!el) return;
    io ??= new IntersectionObserver(
      list => {
        for (const x of list) {
          const o = observed.get(x.target);
          if (!o || o.on === x.isIntersecting) continue;
          o.on = x.isIntersecting;
          setOn(o.urls, o.on ? 1 : -1);
        }
      },
      // Sharpen a little before a picture scrolls in.
      { rootMargin: '25%' },
    );
    const o = { urls, on: false };
    observed.set(el, o);
    io.observe(el);
    return () => {
      io!.unobserve(el);
      observed.delete(el);
      if (o.on) setOn(o.urls, -1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, id]);
}

// ---- zoom ----
/** Device pixels per design pixel, rounded up to a power of two so levels switch once per doubling of zoom. */
let scale = 1;
let watching = false;
let zoomTimer: ReturnType<typeof setTimeout> | undefined;
/** Performance mode shows pictures at half resolution. */
let quality = 1;
function liveScale() {
  const z = Math.max(1 / 64, useStore.getState().view.zoom * (devicePixelRatio || 1));
  return 2 ** Math.ceil(Math.log2(z) - 1e-6);
}
function readScale() {
  const s = useStore.getState();
  const next = liveScale();
  const q = s.perfMode ? 0.5 : 1;
  if (next === scale && q === quality) return;
  const out = next < scale;
  scale = next;
  quality = q;
  // Zoomed out: full-size pictures are no longer needed.
  if (out) for (const e of entries.values()) releaseFull(e);
  bump();
}
function watch() {
  // Subscribed on first use: this module can load before the store has finished initializing.
  watching = true;
  readScale();
  useStore.subscribe((s, p) => {
    if (s.perfMode !== p.perfMode) readScale();
    if (s.view.zoom === p.view.zoom) return;
    // Levels switch once zooming pauses; mid-gesture the current level is simply scaled.
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoomTimer = undefined;
      readScale();
      // Pictures that came into view during the gesture were left as they were: let them pick their level now.
      bump();
    }, 140);
  });
  onAssetsChanged(resetImages);
}

// ---- loading ----
/** Pixel size from the file header, or null for formats shown as-is (svg, gif, animated or unknown). */
function headerSize(b: Uint8Array): { w: number; h: number } | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1];
  const u32 = (i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32(16), h: u32(20) };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: u16(i + 7), h: u16(i + 5) };
      i += 2 + u16(i + 2);
    }
    return null;
  }
  if (b.length > 30 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
    const kind = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (kind === 'VP8X') return b[20] & 0x02 ? null : { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    if (kind === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (kind === 'VP8L') {
      const n = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: 1 + (n & 0x3fff), h: 1 + ((n >> 14) & 0x3fff) };
    }
  }
  return null;
}

function releaseFull(e: Entry) {
  if (!e.keep.has(FULL) || e.ready.size < 2) return;
  e.keep.delete(FULL);
  e.ready.delete(FULL);
  bump(e);
}

function settle() {
  pending--;
  if (pending > 0) return;
  const w = idleWaiters;
  idleWaiters = [];
  for (const f of w) f();
}

function load(url: string): Entry {
  const e: Entry = { state: 'loading', url, src: url, w: 0, h: 0, ready: new Map(), making: new Set(), keep: new Map(), version: 0 };
  entries.set(url, e);
  pending++;
  (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const size = headerSize(new Uint8Array(await blob.slice(0, 262144).arrayBuffer()));
      if (entries.get(url) !== e) return;
      if (!size || !size.w || !size.h) {
        e.state = 'plain';
        return;
      }
      e.w = size.w;
      e.h = size.h;
      e.src = URL.createObjectURL(blob);
      sources.set(e.src, url);
      e.state = 'ready';
    } catch {
      // Unreachable from script (e.g. a remote host without CORS): the browser may still be able to show it directly.
      if (entries.get(url) === e) e.state = 'plain';
    } finally {
      bump(e);
      settle();
    }
  })();
  return e;
}

/** Pictures whose levels could not be made (shown as-is). */
let failed = 0;
const queue: (() => Promise<void>)[] = [];
let running = 0;
/** Decoding a large picture takes tens of megabytes for a moment, so only two are worked on at once. */
function enqueue(job: () => Promise<void>) {
  queue.push(job);
  const next = () => {
    if (running >= 2) return;
    const j = queue.shift();
    if (!j) return;
    running++;
    void j().finally(() => {
      running--;
      next();
    });
  };
  next();
}

async function decoded(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

/** Makes level `side` and every smaller level from one decode of the original. */
function make(e: Entry, side: number) {
  if (e.making.has(side) || e.ready.has(side)) return;
  const sides: number[] = [];
  if (side === FULL) sides.push(FULL);
  else for (let s = side; s >= MIN_SIDE; s /= 2) if (!e.ready.has(s) && !e.making.has(s)) sides.push(s);
  for (const s of sides) e.making.add(s);
  pending++;
  enqueue(async () => {
    try {
      if (side === FULL) {
        const img = await decoded(e.src);
        if (entries.get(e.url) !== e) return;
        e.keep.set(FULL, img);
        e.ready.set(FULL, e.src);
        return;
      }
      const blob = await (await fetch(e.src)).blob();
      const long = Math.max(e.w, e.h);
      let prev: ImageBitmap | OffscreenCanvas = await createImageBitmap(blob, e.w >= e.h ? { resizeWidth: sides[0], resizeQuality: 'high' } : { resizeHeight: sides[0], resizeQuality: 'high' });
      for (const s of sides) {
        const k = s / long;
        const cv = new OffscreenCanvas(Math.max(1, Math.round(e.w * k)), Math.max(1, Math.round(e.h * k)));
        const g = cv.getContext('2d', SOFT) as OffscreenCanvasRenderingContext2D;
        g.imageSmoothingQuality = 'high';
        g.drawImage(prev, 0, 0, cv.width, cv.height);
        if (prev instanceof ImageBitmap) prev.close();
        prev = cv;
        // A copy with nothing in it would make the picture vanish: give up on levels for this picture.
        if (isBlank(cv)) throw new Error('blank level');
        const url = URL.createObjectURL(await cv.convertToBlob({ type: 'image/png' }));
        const img = await decoded(url);
        if (entries.get(e.url) !== e) return URL.revokeObjectURL(url);
        sources.set(url, e.url);
        e.keep.set(s, img);
        e.ready.set(s, url);
        bump(e);
      }
    } catch {
      // Could not be decoded or scaled here (or the copy came out blank): show the picture itself from now on.
      if (entries.get(e.url) === e) {
        e.state = 'plain';
        failed++;
      }
    } finally {
      for (const s of sides) e.making.delete(s);
      bump(e);
      settle();
    }
  });
}

/** The level a picture needs to cover `box` (design pixels) at the current zoom. */
function wanted(e: Entry, box: ImageBox): number {
  const sx = box.w / e.w;
  const sy = box.h / e.h;
  const s = box.mode === 'contain' ? Math.min(sx, sy) : Math.max(sx, sy);
  const long = Math.max(e.w, e.h);
  // `scale` follows the zoom only after it pauses. While zooming out, pictures coming into view must not be
  // prepared for the detail of the zoom the gesture started at, so the live zoom caps it.
  const need = long * s * Math.min(scale, liveScale()) * quality;
  const side = Math.max(MIN_SIDE, 2 ** Math.ceil(Math.log2(Math.max(1, need)) - 1e-6));
  return side >= long ? FULL : side;
}

/**
 * The url to draw an image fill from: a level sized for the box at the current zoom. Until that level exists the
 * closest ready one is used (a smaller one first, so memory never jumps just to bridge a moment).
 */
export function pickImageUrl(url: string, box: ImageBox): string {
  if (!url || /^(data|blob):/i.test(url)) return url;
  // A box with no size yet shows nothing anyway; don't fetch the full picture for it.
  if (!(box.w > 0) || !(box.h > 0)) return BLANK;
  if (!watching) watch();
  const e = entries.get(url) ?? load(url);
  if (e.state === 'plain') return e.src;
  if (e.state === 'loading') return BLANK;
  const want = wanted(e, box);
  const hit = e.ready.get(want);
  if (hit) return hit;
  const long = Math.max(e.w, e.h);
  if (long <= MIN_SIDE) {
    // Too small to have levels: the picture itself, loaded in place.
    e.ready.set(FULL, e.src);
    return e.src;
  }
  // Away from the viewport a small level is enough; the right one is made when the picture comes near. While the
  // zoom is changing nothing new is made either (the zoom being passed through is not where it will stop), beyond
  // a first small level for a picture that has none.
  const cap = long > OFFSCREEN_SIDE ? OFFSCREEN_SIDE : FULL;
  if (zoomTimer === undefined) make(e, onScreen.has(url) || want <= cap ? want : cap);
  else if (!e.ready.size) make(e, Math.min(want, cap));
  let below = 0;
  let above = FULL;
  for (const s of e.ready.keys()) {
    if (s < want && s > below) below = s;
    if (s > want && s < above) above = s;
  }
  return e.ready.get(below) ?? (above !== FULL || e.ready.has(FULL) ? e.ready.get(above)! : BLANK);
}

/** The picture a level (or fetched copy) was made from, for captures and exports; undefined for other urls. */
export function originalOf(url: string): string | undefined {
  return sources.get(url);
}

export function imagesBusy() {
  return pending > 0;
}

/** Resolves once no picture is loading or being scaled (or after `ms`), so a capture doesn't miss images. */
export function imagesIdle(ms = 8000): Promise<void> {
  if (pending <= 0) return Promise.resolve();
  return new Promise(res => {
    const t = setTimeout(res, ms);
    idleWaiters.push(() => {
      clearTimeout(t);
      res();
    });
  });
}

/** Forget every picture (another file was opened, or image files changed on disk). */
export function resetImages() {
  for (const e of entries.values()) {
    for (const u of e.ready.values()) if (u !== e.url) URL.revokeObjectURL(u);
    if (e.src !== e.url) URL.revokeObjectURL(e.src);
  }
  entries.clear();
  sources.clear();
  bump();
}

/** For diagnose_editor. */
export function imageLodStats() {
  let levels = 0;
  let large = 0;
  for (const e of entries.values()) {
    levels += [...e.ready.keys()].filter(s => s !== FULL).length;
    if (Math.max(e.w, e.h) > MIN_SIDE) large++;
  }
  return { images: entries.size, scalable: large, levels, failed, loading: pending, zoomScale: scale, quality };
}
