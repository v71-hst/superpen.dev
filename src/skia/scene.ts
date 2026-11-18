// What the Skia layer draws (docs/SKIA_REWORK.md, stage 1): zoomed-out top-level frames, from the snapshots lod.ts
// already makes. Roots registers the frames it hands to Skia on every render (so positions follow drags); each
// snapshot becomes one texture with mipmaps, kept in a least-recently-used byte budget. Textures are CPU-side Skia
// images that the GPU uploads on first draw, so they survive a lost graphics context and re-upload on restore.
// A frame is only handed to Skia once its texture is ready and the surface can draw; until then, or if anything
// fails, Roots keeps showing the snapshot <img>, so a frame is never left with nothing.
import { useSyncExternalStore } from 'react';
import type { Canvas as SkCanvas, CanvasKit, Image as SkImage } from 'canvaskit-wasm';
import { kitIfLoaded } from './kit';
import { free, own } from './lifetime';
import { activeRenderer } from './renderer';
import { useStore } from '../editor/store';
import { log } from '../editor/diagnostics';

/** A frame drawn by Skia: its snapshot and where it sits in the world. */
export type SceneFrame = { key: string; url: string; x: number; y: number; w: number; h: number };

type Texture = { state: 'loading' | 'ready' | 'failed'; image: SkImage | null; bytes: number; used: number };

/** Texture budget in bytes; halved in performance mode. Counts the mipmapped image once (the GPU copy). */
const BUDGET = 256 * 1024 * 1024;

const textures = new Map<string, Texture>();
let frames: SceneFrame[] = [];
let surfaceReady = false;
let bytes = 0;
const stats = { uploads: 0, evictions: 0, failures: 0, /** Frames shown as snapshot images at the last render. */ fallbacks: 0 };
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
  frames = next;
  // Draw right away so the canvas changes in the same frame as the <img> elements it replaces.
  hooks.drawNow();
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
  for (const f of frames) {
    if (f.x > visible.x + visible.w || f.x + f.w < visible.x || f.y > visible.y + visible.h || f.y + f.h < visible.y) continue;
    const t = textures.get(f.url);
    if (!t?.image) continue;
    t.used = now;
    const img = t.image;
    c.drawImageRectOptions(img, ck.XYWHRect(0, 0, img.width(), img.height()), ck.XYWHRect(f.x, f.y, f.w, f.h), ck.FilterMode.Linear, ck.MipmapMode.Linear, null);
  }
}

/** Throws away every texture (new file, or Skia switched off). */
export function resetScene() {
  for (const t of textures.values()) free(t.image);
  textures.clear();
  queue.length = 0;
  frames = [];
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
