// What the Skia layer draws (docs/SKIA_REWORK.md, stage 1): zoomed-out top-level frames, from the snapshots lod.ts
// already makes. Roots registers the frames it hands to Skia on every render (so positions follow drags); each
// snapshot becomes one texture with mipmaps, kept in a least-recently-used byte budget. Textures are CPU-side Skia
// images that the GPU uploads on first draw, so they survive a lost graphics context and re-upload on restore.
// A frame is only handed to Skia once its texture is ready and the surface can draw; until then, or if anything
// fails, Roots keeps showing the snapshot <img>, so a frame is never left with nothing.
import { useSyncExternalStore } from 'react';
import type { Canvas as SkCanvas, CanvasKit, Image as SkImage, Paint, SkPicture, Surface } from 'canvaskit-wasm';
import { baseSide, hasPictureCopy, levelSide, pictureCopy, stalePictureCopy } from './pictureTextures';
import { beginWantPass, setImageQuietSource, trimImages } from './images';
import { kitIfLoaded } from './kit';
import { free, own } from './lifetime';
import { activeRenderer } from './renderer';
import { useStore } from '../editor/store';
import { log } from '../editor/diagnostics';

/**
 * A frame drawn by Skia: its snapshot (url) or its recorded picture (stages 3–4, url ''), and where it sits in the
 * world.
 */
/** After the frames in view were seen: lets frames that are no longer shown large go back to small pictures. */
let relax: () => void = () => {};
export function setRelaxHook(fn: () => void) {
  relax = fn;
}

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
  /**
   * The frame is on screen at `scale` device pixels per world px: it asks for sharper versions of the pictures it
   * shows inside `visible` (null: all of them).
   */
  seen?: (scale: number, visible: Box | null) => void;
  placeholder?: string;
  /** Changes with the frame's content. */
  token?: object;
};

type Box = { x: number; y: number; w: number; h: number };

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
  /** Steps of the close-up warm-up drawn (see takeProgramStep). */
  programSteps: 0,
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
  scheduleSweep();
}

let pictureKeys = new Set<string>();

/** Whether Skia draws this top-level frame from its own picture now (it needs no snapshot and no DOM). */
export function drawsFromPicture(key: string) {
  return pictureKeys.has(key);
}

let lastViewChange = 0;
let lastInteraction = 0;
// Decoded pictures are swapped for sharper ones only while the view and pointer are still (it costs a few ms each).
setImageQuietSource(() => performance.now() - Math.max(lastViewChange, lastInteraction));

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
      // Zoomed out: from the frame's copy. If the picture has to be recorded again first (an edit, or a sharper
      // version of one of its pictures arrived) and there is no time left in this draw, the copy made before.
      const canWork = performance.now() < until;
      const side = levelSide(Math.max(f.w, f.h), zoom, dpr);
      const copy = !gpu ? null : pic ? pictureCopy(ck, gpu, f.key, pic, f, side, canWork) : stalePictureCopy(f.key, side);
      if (copy) {
        const img = copy.image;
        c.drawImageRectOptions(img, ck.XYWHRect(0, 0, img.width(), img.height()), ck.XYWHRect(f.x, f.y, f.w, f.h), ck.FilterMode.Linear, ck.MipmapMode.None, null);
        if (!copy.sharp) more = true;
        continue;
      }
      if (pic && canWork) {
        // A copy can't be made at all: replay the picture.
        stats.farReplays++;
        c.drawPicture(pic);
        continue;
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
  scheduleSettle();
}

// ---------- which pictures need to be sharp ----------

let settleHandle: ReturnType<typeof setTimeout> | null = null;
let sweepHandle: ReturnType<typeof setTimeout> | null = null;
const SETTLE_MS = 150;
const SWEEP_MS = 5000;

/**
 * Tells every frame in view (and a little around it) how large it is on screen, so the pictures it shows get versions
 * with enough pixels. Zoomed out a frame is drawn whole from its copy, so all its pictures count; close up only the
 * ones in view.
 */
function noticeVisible() {
  if (!lastVisible.w || !surfaceReady) return;
  const zoom = useStore.getState().view.zoom;
  const far = zoom < PICTURE_IMAGE_ZOOM;
  const scale = zoom * (devicePixelRatio || 1);
  const v = lastVisible;
  const near = { x: v.x - v.w / 4, y: v.y - v.h / 4, w: v.w * 1.5, h: v.h * 1.5 };
  beginWantPass();
  for (const f of frames) {
    if (!f.seen || f.x > near.x + near.w || f.x + f.w < near.x || f.y > near.y + near.h || f.y + f.h < near.y) continue;
    f.seen(scale, far ? null : near);
  }
}

/** Once the view has stopped moving: asking while it moves would decode pictures that are only passing by. */
function scheduleSettle() {
  settleHandle ??= setTimeout(() => {
    settleHandle = null;
    if (performance.now() - lastViewChange < SETTLE_MS - 10) return scheduleSettle();
    noticeVisible();
  }, SETTLE_MS);
}

/**
 * Every few seconds: what is in view still needs its sharp pictures (nothing is drawn while the editor sits still),
 * and the ones nothing has needed for a while are let go.
 */
function scheduleSweep() {
  if (sweepHandle !== null || !pictureKeys.size) return;
  sweepHandle = setTimeout(() => {
    sweepHandle = null;
    if (!document.hidden) noticeVisible();
    relax();
    trimImages();
    // Frames that went back to small pictures, or lost a larger one, are recorded again in the background.
    scheduleWarm();
    scheduleSweep();
  }, SWEEP_MS);
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
  const zoom = useStore.getState().view.zoom;
  const far = zoom < PICTURE_IMAGE_ZOOM;
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
    const onScreen = best.x < lastVisible.x + lastVisible.w && best.x + best.w > lastVisible.x && best.y < lastVisible.y + lastVisible.h && best.y + best.h > lastVisible.y;
    try {
      const pic = best.record!();
      // A frame that is being drawn from its copy right now gets one at the size it is drawn at, the rest a small one.
      if (pic) pictureCopy(ck, surface, best.key, pic, best, far && onScreen ? levelSide(Math.max(best.w, best.h), zoom, devicePixelRatio || 1) : baseSide(), true);
      if ((!pic || !hasPictureCopy(best.key, pic)) && best.token) warmFailed.add(best.token);
    } catch (e) {
      // drawScene's caller turns a CanvasKit failure into the DOM fallback; here, stop and let drawing find it.
      log('warn', 'Skia could not prepare a frame ahead of need', String(e));
      return;
    }
    if (onScreen) redraw = true;
    if (performance.now() >= until) break;
  }
  if (redraw) hooks.requestDraw();
  if (left) scheduleWarm();
  else {
    // Every frame there is now is recorded and has its copy: one step of the close-up warm-up (see takeProgramStep).
    if (programsWarmedFor !== surface) {
      programsWarmedFor = surface;
      programWarmed.clear();
      programSamples = 0;
      programSteps = [];
    }
    if (!programSteps.length) planProgramSteps();
    if (programSteps.length) {
      programStepDue = true;
      hooks.requestDraw();
    }
  }
}

// ---------- the graphics card's programs, ahead of need ----------
//
// The first time Skia draws a kind of thing (a picture, a rounded clip, a gradient, text at a new size...) the
// graphics driver compiles a program for it, and the draw waits: 150-200 ms measured on a fast card, on the first
// zoom-in after opening a design, longer on a slow one. Zoomed out nothing of the kind happens, because frames are
// drawn from their copies. So once a design is open and everything is recorded, a few of its frames are drawn close
// up, one step per draw while the editor is idle, onto the canvas itself (programs can differ between the canvas and
// an offscreen texture), and the canvas is cleared and drawn properly straight after, in the same draw: nothing of it
// is ever shown. After that the programs are there.

/** The surface whose programs are being compiled (a new graphics context starts over). */
let programsWarmedFor: object | null = null;
/** Frames (by key) that have had their warm-up steps planned on this surface. */
const programWarmed = new Set<string>();
let programSteps: { key: string; zoom: number; ox: number; oy: number }[] = [];
let programStepDue = false;
/** This many frames are drawn at several sizes; the rest, up to PROGRAM_FRAMES, once. */
const PROGRAM_SAMPLES = 8;
const PROGRAM_FRAMES = 400;
let programSamples = 0;

/** Steps for the frames that have none yet (frames keep arriving while a design opens, and later as it is edited). */
/** Diagnostic switch: localStorage pen.debug.noProgramWarm = 1 turns the warm-up off (to measure what it costs). */
let programWarmOff: boolean | null = null;

function planProgramSteps() {
  if (programWarmOff === null) {
    try {
      programWarmOff = localStorage.getItem('pen.debug.noProgramWarm') === '1';
    } catch {
      programWarmOff = false;
    }
  }
  if (programWarmOff || programWarmed.size >= PROGRAM_FRAMES) return;
  const fresh = frames.filter(f => f.record && !programWarmed.has(f.key));
  // The several-sizes treatment goes to frames spread through what is there: neighbours tend to be made of the same things.
  const every = Math.max(1, Math.floor(fresh.length / Math.max(1, PROGRAM_SAMPLES - programSamples)));
  fresh.forEach((f, i) => {
    if (programWarmed.size >= PROGRAM_FRAMES) return;
    programWarmed.add(f.key);
    if (programSamples < PROGRAM_SAMPLES && i % every === 0) {
      programSamples++;
      // Small (pictures shrunk, which reads them through their smaller copies: another program), at a size that
      // puts edges between pixels (rounded clips are then drawn another way), whole at 100%, then its top and its
      // middle at 200% (clips and pictures are drawn differently when large).
      programSteps.push({ key: f.key, zoom: 0.4, ox: 0, oy: 0 }, { key: f.key, zoom: 0.77, ox: 0.013, oy: 0.007 }, { key: f.key, zoom: 1, ox: 0, oy: 0 }, { key: f.key, zoom: 2, ox: 0, oy: 0 }, { key: f.key, zoom: 2, ox: 0.25, oy: 0.4 });
    } else {
      // Once, whole: a kind of thing only some frames have (a gradient, a blur, a dashed line) gets its program too.
      programSteps.push({ key: f.key, zoom: 1, ox: 0, oy: 0 });
    }
  });
}

/**
 * Called by the layer at the start of a draw, before it clears the canvas: draws one warm-up step if one is due.
 * Returns whether it drew (the layer then sends it to the graphics card before clearing, or the clear would cancel it).
 */
export function takeProgramStep(c: SkCanvas, dpr: number): boolean {
  if (!programStepDue || !programSteps.length) return false;
  programStepDue = false;
  const step = programSteps.shift()!;
  const f = frames.find(x => x.key === step.key);
  const pic = f?.record ? (f.peek?.() ?? f.record()) : null;
  if (!f || !pic) return false;
  c.save();
  c.scale(dpr * step.zoom, dpr * step.zoom);
  c.translate(-f.x - step.ox * f.w, -f.y - step.oy * f.h);
  c.drawPicture(pic);
  c.restore();
  stats.programSteps++;
  return true;
}

/** Throws away every texture (new file, or Skia switched off). */
export function resetScene() {
  for (const t of textures.values()) free(t.image);
  textures.clear();
  queue.length = 0;
  frames = [];
  pictureKeys = new Set();
  bytes = 0;
  // Another design may be made of other things: its close-up drawing is warmed up again.
  programsWarmedFor = null;
  programWarmed.clear();
  programSamples = 0;
  programSteps = [];
  programStepDue = false;
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
