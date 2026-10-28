// Zoomed-out level of detail: large top-level frames are shown as GPU-backed bitmaps instead of live DOM.
// Bitmaps are rendered in the background (closest to the viewport first) and refreshed when a frame changes.
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from './store';
import { currentTree } from './tree';
import { rasterize } from '../render/rasterize';
import { NodeView, RenderCtx } from '../render/NodeView';
import { makeUrlResolver } from './fileio';
import type { RNode } from '../model/types';

/** Below this zoom, big frames may be drawn from bitmaps. */
export const LOD_ZOOM = 0.3;
/** Frames with fewer nodes than this are cheap enough to always render live. */
const MIN_NODES = 40;
const MAX_BITMAP_SIDE = 2048;

export type Bitmap = { url: string; node: RNode; ratio: number; w: number; h: number };

const bitmaps = new Map<string, Bitmap>();
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

export function lodEligible(n: RNode): boolean {
  return nodeCount(n) >= MIN_NODES && !n.props.rotation && typeof n.props.x === 'number' && typeof n.props.y === 'number' && !containsShader(n);
}

/** Placeholders need a known size; frames that hug their content must render live once before they get a bitmap. */
export function hasFixedSize(n: RNode) {
  return typeof n.props.width === 'number' && typeof n.props.height === 'number';
}

function bitmapRatio(w: number, h: number): number {
  const dpr = devicePixelRatio || 1;
  return Math.min(LOD_ZOOM * dpr * 1.1, MAX_BITMAP_SIDE / Math.max(w, h, 1));
}

export function getBitmap(key: string): Bitmap | undefined {
  return bitmaps.get(key);
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
    console.warn('[pen-editor] bitmap render failed', key, e);
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
  const shot = await rasterize(el, { format: 'png', pixelRatio: ratio });
  unstage();
  // The frame may have changed while rendering; only keep the bitmap if it is still current.
  if (currentTree()?.byKey.get(n.key) !== n) return requestBitmap(n.key);
  const blob = await (await fetch(shot.dataUrl)).blob();
  const old = bitmaps.get(n.key);
  if (old) URL.revokeObjectURL(old.url);
  bitmaps.set(n.key, { url: URL.createObjectURL(blob), node: n, ratio, w, h });
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
  for (const b of bitmaps.values()) URL.revokeObjectURL(b.url);
  bitmaps.clear();
  queued.clear();
}
