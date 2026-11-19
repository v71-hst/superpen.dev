// What the Skia layer draws (docs/SKIA_REWORK.md, stage 1): zoomed-out top-level frames, from the snapshots lod.ts
// already makes. Roots registers the frames it hands to Skia on every render (so positions follow drags); each
// snapshot becomes one texture with mipmaps, kept in a least-recently-used byte budget. Textures are CPU-side Skia
// images that the GPU uploads on first draw, so they survive a lost graphics context and re-upload on restore.
// A frame is only handed to Skia once its texture is ready and the surface can draw; until then, or if anything
// fails, Roots keeps showing the snapshot <img>, so a frame is never left with nothing.
import { useSyncExternalStore } from 'react';
import type { Canvas as SkCanvas, CanvasKit, Image as SkImage, Paint, SkPicture, Surface } from 'canvaskit-wasm';
import { baseSide, hasPictureCopy, levelSide, pictureCopy } from './pictureTextures';
import { kitIfLoaded } from './kit';
import { free, own } from './lifetime';
import { activeRenderer } from './renderer';
import { useStore } from '../editor/store';
import { log } from '../editor/diagnostics';

/**
 * A frame drawn by Skia: its snapshot (url) or its recorded picture (stages 3–4, url ''), and where it sits in the
 * world.
 */
export type SceneFrame = {
  key: string;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Picture frames: records (or returns) the picture; until it exists the placeholder colour is shown. */
  record?: () => SkPicture | null;
  /** The picture if it is already recorded (no work). */
  peek?: () => SkPicture | null;
  placeholder?: string;
  /** Changes with the frame's content. */
  token?: object;
};

/** Below this zoom (lod.ts LOD_ZOOM) a picture frame is drawn from a rasterised copy instead of replaying it. */
const PICTURE_IMAGE_ZOOM = 1 / 3;

type Texture = { state: 'loading' | 'ready' | 'failed'; image: SkImage | null; bytes: number; used: number };

/** Texture budget in bytes; halved in performance mode. Counts the mipmapped image once (the GPU copy). */
const BUDGET = 256 * 1024 * 1024;

const textures = new Map<string, Texture>();
let frames: SceneFrame[] = [];
let surfaceReady = false;
let bytes = 0;
const stats = {
  uploads: 0,
  evictions: 0,
  failures: 0,
  /** Frames shown as snapshot images at the last render. */
  fallbacks: 0,
  /** Whole pictures replayed while zoomed far out (the slow path: no rasterised copy yet). */
  farReplays: 0,
  /** Frames drawn as their colour because the picture wasn't recorded yet. */
  placeholders: 0,
  slowestDrawMs: 0,
};
let version = 0;
const listeners = new Set<() => void>();
const queue: string[] = [];
let loading = false;

let hooks: { requestDraw: () => void; drawNow: () => void } = { requestDraw: () => {}, drawNow: () => {} };

/** SkiaLayer registers how to redraw. */
export function setDrawHooks(h: typeof hooks | null) {
  hooks = h ?? { requestDraw: () => {}, drawNow: () => {} };
}

function bump() {
  version++;
  listeners.forEach(l => l());
}

/** Re-renders Roots when textures become ready or the surface comes and goes. */
export function useSceneVersion() {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

/** Whether zoomed-out frames are drawn by Skia (overview or full mode, with a working surface). */
export function overviewOn(): boolean {
  return activeRenderer() !== 'dom';
}

export function surfaceIsReady() {
  return surfaceReady;
}

/** The Skia canvas's surface while there is one: far-zoom copies are made in its graphics context. */
let gpu: Surface | null = null;

export function setSceneSurface(s: Surface | null) {
  gpu = s;
}

/** Something a frame's picture depends on changed (a font or picture loaded): Roots re-renders and re-records. */
export function invalidateScene() {
  bump();
}

/** SkiaLayer reports whether it can draw; while it can't (lost context), Roots shows the snapshot images. */
export function setSurfaceReady(ready: boolean) {
  if (ready === surfaceReady) return;
  surfaceReady = ready;
  bump();
}

/** True when this snapshot can be drawn by Skia right now. Otherwise queues its texture (if Skia is on). */
export function canDraw(url: string): boolean {
  if (!overviewOn()) return false;
  const t = textures.get(url);
  if (t?.state === 'ready' && surfaceReady) return true;
  if (!t) want(url);
  return false;
}

/**
 * The frames Skia draws now, in document order; called by Roots after each render. `imageFallbacks`: zoomed-out
 * frames Roots still shows as snapshot images (texture not ready, failed, or no surface).
 */
export function setSceneFrames(next: SceneFrame[], imageFallbacks: number) {
  stats.fallbacks = imageFallbacks;
  const now = performance.now();
  for (const f of next) {
    const t = textures.get(f.url);
    if (t) t.used = now;
  }
  const same = next.length === frames.length && next.every((f, i) => { const o = frames[i]; return o.key === f.key && o.url === f.url && o.token === f.token && o.x === f.x && o.y === f.y && o.w === f.w && o.h === f.h; });
  frames = next;
  pictureKeys = new Set(next.filter(f => f.record).map(f => f.key));
  // Draw right away so the canvas changes in the same frame as the <img> elements it replaces. Roots re-renders
  // often (zoom steps, frames going live a few at a time); an unchanged list needs no redraw (view changes redraw
  // on their own).
  if (!same) hooks.drawNow();
  scheduleWarm();
}

let pictureKeys = new Set<string>();

/** Whether Skia draws this top-level frame from its own picture now (it needs no snapshot and no DOM). */
export function drawsFromPicture(key: string) {
  return pictureKeys.has(key);
}

let lastViewChange = 0;
let lastInteraction = 0;

/** SkiaLayer reports view changes: while the view moves, drawing spends less time on new pictures and copies. */
export function noteViewChange() {
  lastViewChange = performance.now();
}

/** The user is panning, zooming or moving the pointer (lod.ts lodInteraction): background work waits. */
export function noteInteraction() {
  lastInteraction = performance.now();
}

/** lod.ts dropped a snapshot (the frame changed or a new file was opened). */
export function forgetSnapshot(url: string) {
  const t = textures.get(url);
  if (!t) return;
  textures.delete(url);
  if (t.image) {
    bytes -= t.bytes;
    free(t.image);
  }
}

function budget() {
  return useStore.getState().perfMode ? BUDGET / 2 : BUDGET;
}

function want(url: string) {
  textures.set(url, { state: 'loading', image: null, bytes: 0, used: performance.now() });
  queue.push(url);
  if (!loading) void loadQueue();
}

async function loadQueue() {
  loading = true;
  try {
    while (queue.length) {
      const url = queue.shift()!;
      const t = textures.get(url);
      if (!t || t.state !== 'loading') continue;
      const ck = kitIfLoaded();
      if (!ck) {
        textures.delete(url);
        continue;
      }
      try {
        const data = new Uint8Array(await (await fetch(url)).arrayBuffer());
        if (textures.get(url) !== t) continue; // forgotten meanwhile
        const image = decode(ck, data);
        t.image = image;
        t.bytes = Math.round(image.width() * image.height() * 4 * (4 / 3));
        t.state = 'ready';
        bytes += t.bytes;
        stats.uploads++;
        evict();
      } catch (e) {
        t.state = 'failed';
        stats.failures++;
        log('warn', `Skia could not load a zoomed-out snapshot; showing the image instead`, String(e));
      }
      bump();
      // Decoding happens on the main thread: let a frame through between snapshots.
      await new Promise(r => setTimeout(r, 0));
    }
  } finally {
    loading = false;
  }
}

function decode(ck: CanvasKit, data: Uint8Array): SkImage {
  const base = ck.MakeImageFromEncoded(data);
  if (!base) throw new Error('snapshot did not decode');
  try {
    return own(base.makeCopyWithDefaultMipmaps(), 'image');
  } finally {
    base.delete();
  }
}

/** Frees least-recently-used textures over the budget, never one that is on the canvas right now. */
function evict() {
  const limit = budget();
  if (bytes <= limit) return;
  const inUse = new Set(frames.map(f => f.url));
  const ready = [...textures.entries()].filter(([u, t]) => t.state === 'ready' && !inUse.has(u)).sort((a, b) => a[1].used - b[1].used);
  for (const [url, t] of ready) {
    if (bytes <= limit) break;
    textures.delete(url);
    bytes -= t.bytes;
    free(t.image);
    stats.evictions++;
  }
}

/** Draws the registered frames that intersect the visible world rect. The canvas already has the view transform. */
export function drawScene(c: SkCanvas, ck: CanvasKit, visible: { x: number; y: number; w: number; h: number }) {
  if (!frames.length) return;
  const now = performance.now();
  const zoom = useStore.getState().view.zoom;
  const far = zoom < PICTURE_IMAGE_ZOOM;
  const dpr = devicePixelRatio || 1;
  lastVisible = visible;
  // Recording a frame's picture, and rasterising its far-zoom copy, cost a few ms each. Zoomed out, a draw spends only
  // a little time on that work (less while the view is moving) and draws every other frame from what already exists:
  // its copy, even a blurrier one, or failing that its colour. Then it draws again. Close up, the few frames on screen
  // are recorded on the spot.
  const until = now + (now - lastViewChange < 150 ? 5 : 14);
  let more = false;
  let placeholderPaint: Paint | null = null;
  for (const f of frames) {
    if (f.x > visible.x + visible.w || f.x + f.w < visible.x || f.y > visible.y + visible.h || f.y + f.h < visible.y) continue;
    if (f.record) {
      const pic = !far || performance.now() < until ? f.record() : (f.peek?.() ?? null);
      if (pic && !far) {
        c.drawPicture(pic);
        continue;
      }
      if (pic) {
        const canWork = performance.now() < until;
        const copy = gpu ? pictureCopy(ck, gpu, f.key, pic, f, levelSide(Math.max(f.w, f.h), zoom, dpr), canWork) : null;
        if (copy) {
          const img = copy.image;
          c.drawImageRectOptions(img, ck.XYWHRect(0, 0, img.width(), img.height()), ck.XYWHRect(f.x, f.y, f.w, f.h), ck.FilterMode.Linear, ck.MipmapMode.None, null);
          if (!copy.sharp) more = true;
          continue;
        }
        if (canWork) {
          // A copy can't be made at all: replay the picture.
          stats.farReplays++;
          c.drawPicture(pic);
          continue;
        }
      }
      // Nothing to draw it from yet: the frame's own colour for a moment, never nothing.
      placeholderPaint ??= new ck.Paint();
      placeholderPaint.setColor(ck.parseColorString(f.placeholder ?? 'rgba(128,128,128,0.12)'));
      c.drawRect(ck.XYWHRect(f.x, f.y, f.w, f.h), placeholderPaint);
      stats.placeholders++;
      more = true;
      continue;
    }
    const t = textures.get(f.url);
    if (!t?.image) continue;
    t.used = now;
    const img = t.image;
    c.drawImageRectOptions(img, ck.XYWHRect(0, 0, img.width(), img.height()), ck.XYWHRect(f.x, f.y, f.w, f.h), ck.FilterMode.Linear, ck.MipmapMode.Linear, null);
  }
  placeholderPaint?.delete();
  stats.slowestDrawMs = Math.max(stats.slowestDrawMs, Math.round(performance.now() - now));
  if (more) setTimeout(() => hooks.requestDraw(), 0);
  else scheduleWarm();
}

let lastVisible = { x: 0, y: 0, w: 0, h: 0 };
let warmHandle: ReturnType<typeof setTimeout> | null = null;
/** Frames (by content token) whose picture could not be recorded ahead of need; drawing deals with them. */
const warmFailed = new WeakSet<object>();

/**
 * Records pictures and makes far-zoom copies ahead of need, nearest the view first, in short slices on a timer while
 * nothing is moving. After that, zooming out or panning to a frame for the first time has nothing left to compute.
 * (Not requestIdleCallback: in VS Code's webview it only fired on its timeout, about once a second.)
 */
function scheduleWarm(delay = 12) {
  if (warmHandle !== null || !surfaceReady || !pictureKeys.size) return;
  warmHandle = setTimeout(warm, delay);
}

function warm() {
  warmHandle = null;
  const ck = kitIfLoaded();
  const surface = gpu;
  if (!ck || !surface || !surfaceReady) return;
  if (document.hidden) return scheduleWarm(1000);
  // One frame's recording can't be interrupted: not while the view moves or the pointer is busy.
  const quiet = performance.now() - Math.max(lastViewChange, lastInteraction);
  if (quiet < 200) return scheduleWarm(200 - quiet);
  // Longer slices once the editor has been still for a while.
  const until = performance.now() + (quiet > 1500 ? 10 : 5);
  const cx = lastVisible.x + lastVisible.w / 2, cy = lastVisible.y + lastVisible.h / 2;
  let redraw = false;
  let left = true;
  for (;;) {
    let best: SceneFrame | null = null;
    let bestD = Infinity;
    for (const f of frames) {
      if (!f.record || (f.token && warmFailed.has(f.token))) continue;
      const pic = f.peek?.() ?? null;
      if (pic && hasPictureCopy(f.key, pic)) continue;
      const d = Math.hypot(f.x + f.w / 2 - cx, f.y + f.h / 2 - cy);
      if (d < bestD) {
        bestD = d;
        best = f;
      }
    }
    if (!best) {
      left = false;
      break;
    }
    try {
      const pic = best.record!();
      if (pic) pictureCopy(ck, surface, best.key, pic, best, baseSide(), true);
      if ((!pic || !hasPictureCopy(best.key, pic)) && best.token) warmFailed.add(best.token);
    } catch (e) {
      // drawScene's caller turns a CanvasKit failure into the DOM fallback; here, stop and let drawing find it.
      log('warn', 'Skia could not prepare a frame ahead of need', String(e));
      return;
    }
    if (best.x < lastVisible.x + lastVisible.w && best.x + best.w > lastVisible.x && best.y < lastVisible.y + lastVisible.h && best.y + best.h > lastVisible.y) redraw = true;
    if (performance.now() >= until) break;
  }
  if (redraw) hooks.requestDraw();
  if (left) scheduleWarm();
}

/** Throws away every texture (new file, or Skia switched off). */
export function resetScene() {
  for (const t of textures.values()) free(t.image);
  textures.clear();
  queue.length = 0;
  frames = [];
  pictureKeys = new Set();
  bytes = 0;
  bump();
}

export function sceneStats() {
  let ready = 0;
  let pending = 0;
  let failed = 0;
  for (const t of textures.values()) {
    if (t.state === 'ready') ready++;
    else if (t.state === 'loading') pending++;
    else failed++;
  }
  return { framesDrawn: frames.length, textures: ready, pending, failed, bytes, budget: budget(), surfaceReady, ...stats };
}

/** Lets the layer ask for a redraw (e.g. after the view changed). */
export function requestSceneDraw() {
  hooks.requestDraw();
}
