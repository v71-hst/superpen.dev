// Zoomed-out level of detail: large top-level frames are shown as GPU-backed bitmaps instead of live DOM.
// Bitmaps are rendered in the background (closest to the viewport first) and refreshed when a frame changes.
// Each bitmap is sharp at LOD_ZOOM; zooming further out switches to half-resolution copies (mip levels), made by
// downscaling the previous level so lower zooms upload and composite smaller textures.
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from './store';
import { currentTree } from './tree';
import { ImagesUnavailableError, rasterize } from '../render/rasterize';
import { NodeView, RenderCtx } from '../render/NodeView';
import { makeUrlResolver } from './fileio';
import { log } from './diagnostics';
import type { RNode } from '../model/types';

/** Below this zoom, big frames may be drawn from bitmaps. */
export const LOD_ZOOM = 1 / 3;
/** Frames with fewer nodes than this (labels, single shapes) are cheap enough to always render live. */
const MIN_NODES = 8;
const MAX_BITMAP_SIDE = 2048;
/** Mip levels stop once the longest side would drop below this many pixels. */
const MIN_LEVEL_SIDE = 48;

/** `levels[i]` is the bitmap at `ratio / 2^i` (filled in on demand); `levels[0] === url`. */
export type Bitmap = { url: string; node: RNode; ratio: number; w: number; h: number; levels: (string | undefined)[] };

const bitmaps = new Map<string, Bitmap>();
const stats = { renderFailures: 0, levelFailures: 0, liveOnly: 0 };

/** For diagnose_editor: how many bitmaps and mip levels exist, what is queued, and failures so far. */
export function lodStats() {
  let levels = 0;
  for (const b of bitmaps.values()) levels += b.levels.filter(Boolean).length;
  return { lodZoom: LOD_ZOOM, bitmaps: bitmaps.size, levels, queued: queued.size, levelQueue: levelQueue.size, working, ...stats };
}
const queued = new Set<string>();
let working = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let staging: { host: HTMLDivElement; root: Root } | null = null;

const sizeCache = new WeakMap<RNode, number>();
function nodeCount(n: RNode): number {
  let c = sizeCache.get(n);
  if (c === undefined) {
    c = 1 + n.children.reduce((s, k) => s + nodeCount(k), 0);
    sizeCache.set(n, c);
  }
  return c;
}

const shaderCache = new WeakMap<RNode, boolean>();
/** Frames with shaders stay live: a bitmap would freeze their animation and flicker when swapping. */
function containsShader(n: RNode): boolean {
  let v = shaderCache.get(n);
  if (v === undefined) {
    const p = n.props;
    const list = (x: any) => (Array.isArray(x) ? x : x ? [x] : []);
    v = list(p.fill).some((f: any) => f?.type === 'shader') || list(p.effect).some((e: any) => e?.type === 'shader') || n.children.some(containsShader);
    shaderCache.set(n, v);
  }
  return v;
}

/**
 * Frames with images that can't be embedded in a bitmap (remote hosts that block cross-origin reads) stay live, or
 * the images would vanish when zoomed out. Keyed by node version, so an edit gives the frame another try.
 */
const liveOnly = new WeakSet<RNode>();

export function lodEligible(n: RNode): boolean {
  return !liveOnly.has(n) && nodeCount(n) >= MIN_NODES && !n.props.rotation && typeof n.props.x === 'number' && typeof n.props.y === 'number' && !containsShader(n);
}

/** Placeholders need a known size; frames that hug their content must render live once before they get a bitmap. */
export function hasFixedSize(n: RNode) {
  return typeof n.props.width === 'number' && typeof n.props.height === 'number';
}

function bitmapRatio(w: number, h: number): number {
  const dpr = devicePixelRatio || 1;
  return Math.min(LOD_ZOOM * dpr, MAX_BITMAP_SIDE / Math.max(w, h, 1));
}

export function getBitmap(key: string): Bitmap | undefined {
  return bitmaps.get(key);
}

function levelSize(bm: Bitmap, i: number) {
  const r = bm.ratio / 2 ** i;
  return { w: Math.max(1, Math.round(bm.w * r)), h: Math.max(1, Math.round(bm.h * r)) };
}

/** The smallest level that still has at least one bitmap pixel per screen pixel at this zoom. */
function wantedLevel(bm: Bitmap, zoom: number): number {
  const need = zoom * (devicePixelRatio || 1);
  let i = 0;
  while (bm.ratio / 2 ** (i + 1) >= need && Math.max(bm.w, bm.h) * (bm.ratio / 2 ** (i + 1)) >= MIN_LEVEL_SIDE) i++;
  return i;
}

/** Image URL to show for a bitmap at this zoom; if the right level isn't made yet, uses the next sharper one and queues it. */
export function bitmapUrl(bm: Bitmap, zoom: number): string {
  const want = wantedLevel(bm, zoom);
  for (let i = want; i > 0; i--) {
    if (bm.levels[i]) return bm.levels[i]!;
    if (i === want) requestLevel(bm.node.key, want);
  }
  return bm.url;
}

const levelQueue = new Map<string, number>();
let levelWorking = false;
let levelTimer: ReturnType<typeof setTimeout> | undefined;
/** Downscaling is cheap, but waits for zooming to pause briefly so swaps don't land mid-gesture. */
const LEVEL_IDLE_MS = 150;

function requestLevel(key: string, level: number) {
  if ((levelQueue.get(key) ?? -1) >= level) return;
  levelQueue.set(key, level);
  clearTimeout(levelTimer);
  levelTimer = setTimeout(workLevels, LEVEL_IDLE_MS);
}

async function workLevels() {
  if (levelWorking) return;
  const quiet = performance.now() - lastInteraction;
  if (quiet < LEVEL_IDLE_MS) {
    levelTimer = setTimeout(workLevels, LEVEL_IDLE_MS - quiet);
    return;
  }
  levelWorking = true;
  try {
    for (const [key, want] of levelQueue) {
      levelQueue.delete(key);
      const bm = bitmaps.get(key);
      if (!bm) continue;
      // Halve one level at a time from the sharpest one below `want`: a single big downscale would alias.
      let from = want;
      while (from > 0 && !bm.levels[from]) from--;
      for (let i = from + 1; i <= want; i++) {
        const { w, h } = levelSize(bm, i);
        const url = await downscale(bm.levels[i - 1]!, w, h);
        if (bitmaps.get(key) !== bm) {
          URL.revokeObjectURL(url);
          break;
        }
        bm.levels[i] = url;
      }
      bump();
      if (performance.now() - lastInteraction < LEVEL_IDLE_MS) break;
    }
  } catch (e) {
    stats.levelFailures++;
    log('warn', 'bitmap level failed', e);
  } finally {
    levelWorking = false;
    if (levelQueue.size) levelTimer = setTimeout(workLevels, LEVEL_IDLE_MS);
  }
}

async function downscale(src: string, w: number, h: number): Promise<string> {
  const blob = await (await fetch(src)).blob();
  const img = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
  const cv = new OffscreenCanvas(w, h);
  cv.getContext('2d')!.drawImage(img, 0, 0);
  img.close();
  const url = URL.createObjectURL(await cv.convertToBlob({ type: 'image/png' }));
  await predecode(url);
  return url;
}

/** Decode before the <img> switches to it, so the frame doesn't blank for a frame while swapping. */
function predecode(url: string) {
  const img = new Image();
  img.src = url;
  return img.decode().catch(() => {});
}

function revoke(bm: Bitmap) {
  for (const u of bm.levels) if (u) URL.revokeObjectURL(u);
}

function bump() {
  useStore.setState(s => ({ lodVersion: s.lodVersion + 1 }));
}

/** Queue a frame for (re-)rasterization; runs once interaction has been idle for a moment. */
export function requestBitmap(key: string) {
  if (queued.has(key)) return;
  queued.add(key);
  schedule();
}

let lastInteraction = 0;
/** Rendering one big frame can't be interrupted, so it only starts after the user has been idle this long. */
const IDLE_MS = 900;

function schedule(delay = IDLE_MS) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const quiet = performance.now() - lastInteraction;
    if (quiet < IDLE_MS) return schedule(IDLE_MS - quiet);
    work();
  }, delay);
}

/** Postpone background rendering while the user pans, zooms or moves the pointer. */
export function lodInteraction() {
  lastInteraction = performance.now();
}

function pickNext(): string | null {
  const tree = currentTree();
  if (!tree) return null;
  const { view } = useStore.getState();
  const canvas = document.getElementById('pen-canvas')?.getBoundingClientRect();
  const cx = canvas ? (canvas.width / 2 - view.x) / view.zoom : 0;
  const cy = canvas ? (canvas.height / 2 - view.y) / view.zoom : 0;
  let best: string | null = null;
  let bestD = Infinity;
  for (const key of queued) {
    const n = tree.byKey.get(key);
    if (!n) {
      queued.delete(key);
      continue;
    }
    const p = n.props;
    const d = Math.hypot((p.x ?? 0) + (p.width ?? 0) / 2 - cx, (p.y ?? 0) + (p.height ?? 0) / 2 - cy);
    if (d < bestD) {
      bestD = d;
      best = key;
    }
  }
  return best;
}

async function work() {
  if (working) return;
  const key = pickNext();
  if (!key) return;
  working = true;
  queued.delete(key);
  try {
    const n = currentTree()?.byKey.get(key);
    const cur = bitmaps.get(key);
    if (n && lodEligible(n) && cur?.node !== n) await renderBitmap(n);
  } catch (e) {
    stats.renderFailures++;
    log('warn', `bitmap render failed for ${key}`, e);
  } finally {
    working = false;
    if (queued.size) schedule(performance.now() - lastInteraction > IDLE_MS ? 30 : IDLE_MS);
  }
}

async function renderBitmap(n: RNode) {
  // Prefer the live element when it is mounted and current; otherwise render it in an off-screen staging root.
  const live = document.querySelector<HTMLElement>(`#pen-world > [data-k="${CSS.escape(n.key)}"]:not([data-bitmap]):not([data-placeholder])`);
  let el: HTMLElement | null = live && live.style.contentVisibility !== 'hidden' ? live : null;
  if (!el) el = await stage(n);
  if (!el) return;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  if (!w || !h) return unstage();
  const ratio = bitmapRatio(w, h);
  let shot: Awaited<ReturnType<typeof rasterize>>;
  try {
    // No image inside can need more pixels than the whole bitmap has.
    shot = await rasterize(el, { format: 'png', pixelRatio: ratio, requireImages: true, maxImageSide: Math.ceil(Math.max(w, h) * ratio) });
  } catch (e) {
    unstage();
    if (!(e instanceof ImagesUnavailableError)) throw e;
    liveOnly.add(n);
    stats.liveOnly++;
    bump();
    return;
  }
  unstage();
  // The frame may have changed while rendering; only keep the bitmap if it is still current.
  if (currentTree()?.byKey.get(n.key) !== n) return requestBitmap(n.key);
  const blob = await (await fetch(shot.dataUrl)).blob();
  const old = bitmaps.get(n.key);
  if (old) revoke(old);
  const url = URL.createObjectURL(blob);
  await predecode(url);
  bitmaps.set(n.key, { url, node: n, ratio, w, h, levels: [url] });
  bump();
}

async function stage(n: RNode): Promise<HTMLElement | null> {
  if (!staging) {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:0;transform:translate(-300000px,0);pointer-events:none;contain:layout style;';
    document.body.appendChild(host);
    staging = { host, root: createRoot(host) };
  }
  const s = useStore.getState();
  const ctx = { doc: { variables: s.doc?.variables }, resolveUrl: makeUrlResolver(s.file?.path ?? null) };
  const placed: RNode = { ...n, props: { ...n.props, x: 0, y: 0 } };
  staging.root.render(React.createElement(RenderCtx.Provider, { value: ctx }, React.createElement(NodeView, { n: placed, parentLayout: 'none' })));
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  await document.fonts.ready;
  return staging.host.querySelector<HTMLElement>('[data-k]');
}

function unstage() {
  staging?.root.render(null);
}

/** Drop all bitmaps (new file opened). */
export function resetLod() {
  for (const b of bitmaps.values()) revoke(b);
  bitmaps.clear();
  queued.clear();
  levelQueue.clear();
}
