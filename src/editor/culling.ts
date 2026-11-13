// Viewport performance: skip rendering off-screen top-level frames and keep the canvas on a GPU layer while it moves.
import { useStore } from './store';
import { currentTree } from './tree';
import { lodInteraction } from './lod';
import type { RNode } from '../model/types';

type Rect = { x: number; y: number; w: number; h: number };

const worldRects = new Map<string, Rect>();
/** The node version each measured size belongs to. */
const measuredFor = new Map<string, unknown>();
const pinned = new Map<string, number>();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let raf = 0;

function world() {
  return document.getElementById('pen-world');
}

function rootElements(): HTMLElement[] {
  const w = world();
  return w ? (Array.from(w.children) as HTMLElement[]).filter(el => el.dataset.k) : [];
}

let near: Set<string> | null = null;

/**
 * Performance mode: the top-level frames near the viewport. The others are unloaded (their snapshot or background
 * stands in) instead of only being skipped when painting. A frame comes in a third of a viewport before it shows and
 * leaves a full viewport after it is gone, so panning back and forth doesn't reload it. null: every frame is loaded.
 */
export function nearRoots(): Set<string> | null {
  if (!useStore.getState().perfMode) return null;
  // Called while rendering: the first answer is worked out without announcing a change.
  return near ?? updateNear(false);
}

function updateNear(announce = true): Set<string> {
  const { view } = useStore.getState();
  const c = document.getElementById('pen-canvas')?.getBoundingClientRect();
  const z = view.zoom;
  const vw = (c?.width || innerWidth) / z;
  const vh = (c?.height || innerHeight) / z;
  const vx = -view.x / z;
  const vy = -view.y / z;
  const within = (r: Rect, m: number) => r.x < vx + vw + vw * m && r.x + r.w > vx - vw * m && r.y < vy + vh + vh * m && r.y + r.h > vy - vh * m;
  const next = new Set<string>();
  for (const n of currentTree()?.roots ?? []) {
    const p = n.props;
    const fixed = typeof p.x === 'number' && typeof p.y === 'number' && typeof p.width === 'number' && typeof p.height === 'number' && !p.rotation;
    const r = fixed ? { x: p.x, y: p.y, w: p.width, h: p.height } : worldRects.get(n.key);
    // Frames whose size only the DOM knows have to be loaded to be measured.
    if (!r || within(r, near?.has(n.key) ? 1 : 0.35)) next.add(n.key);
  }
  const changed = !near || next.size !== near.size || [...next].some(k => !near!.has(k));
  near = next;
  if (changed && announce) useStore.setState(s => ({ nearVersion: s.nearVersion + 1 }));
  return next;
}

/** Hides frames that are well outside the viewport (content-visibility skips their layout and paint). */
export function cull() {
  raf = 0;
  if (useStore.getState().perfMode) updateNear();
  else if (near) {
    near = null;
    useStore.setState(s => ({ nearVersion: s.nearVersion + 1 }));
  }
  const w = world();
  const canvas = document.getElementById('pen-canvas');
  if (!w || !canvas) return;
  const { view } = useStore.getState();
  const c = canvas.getBoundingClientRect();
  const z = view.zoom;
  const vw = c.width / z;
  const vh = c.height / z;
  const vx = -view.x / z;
  const vy = -view.y / z;
  // Keep a generous margin so content overflowing its frame and frames about to scroll in stay rendered.
  const mx = vw * 0.6 + 200;
  const my = vh * 0.6 + 200;
  const now = performance.now();
  const tree = currentTree();
  for (const el of rootElements()) {
    const key = el.dataset.k!;
    const hidden = el.style.contentVisibility === 'hidden';
    let r = worldRects.get(key);
    // Positions come from the document; the DOM is only measured for sizes it can't give (hugging frames, text),
    // once per node version, so zooming doesn't force a layout of every frame on every step.
    const n = tree?.byKey.get(key);
    const p = n?.props;
    const placed = p && typeof p.x === 'number' && typeof p.y === 'number' && !p.rotation;
    if (placed && typeof p.width === 'number' && typeof p.height === 'number') r = { x: p.x, y: p.y, w: p.width, h: p.height };
    else if (placed && r && (hidden || measuredFor.get(key) === n)) r = { ...r, x: p.x, y: p.y };
    else if (!hidden || !r) {
      const b = el.getBoundingClientRect();
      r = { x: (b.left - c.left - view.x) / z, y: (b.top - c.top - view.y) / z, w: b.width / z, h: b.height / z };
      if (n) measuredFor.set(key, n);
    }
    worldRects.set(key, r);
    const visible = r.x < vx + vw + mx && r.x + r.w > vx - mx && r.y < vy + vh + my && r.y + r.h > vy - my;
    const pin = pinned.get(key);
    const keep = visible || (pin !== undefined && pin > now);
    if (keep && hidden) {
      el.style.contentVisibility = '';
      el.style.containIntrinsicSize = '';
    } else if (!keep && !hidden) {
      el.style.containIntrinsicSize = `${Math.max(1, r.w)}px ${Math.max(1, r.h)}px`;
      el.style.contentVisibility = 'hidden';
    }
  }
}

export function scheduleCull() {
  if (!raf) raf = requestAnimationFrame(cull);
}

let rasterZoom = 0;
let hitTestingOff = false;

/** While the view moves the design ignores the pointer: hit-testing every frame's DOM on each wheel step is costly. */
function setHitTesting(on: boolean) {
  const w = world();
  if (!w || hitTestingOff === !on) return;
  hitTestingOff = !on;
  w.style.pointerEvents = on ? '' : 'none';
}

/** The element under the pointer; turns hit-testing back on first if a pan/zoom had paused it. */
export function pointerTarget(e: { target: EventTarget | null; clientX: number; clientY: number }): HTMLElement {
  if (!hitTestingOff) return e.target as HTMLElement;
  setHitTesting(true);
  return (document.elementFromPoint(e.clientX, e.clientY) ?? e.target) as HTMLElement;
}

/**
 * Call on every pan/zoom. The canvas stays on its own GPU layer so panning and overlay updates never repaint
 * the design; after zooming stops it is re-rasterized once at the new scale so it stays sharp.
 */
export function onViewChanged() {
  lodInteraction();
  const w = world();
  const zoom = useStore.getState().view.zoom;
  if (w && !rerastering) {
    if (w.style.willChange !== 'transform') w.style.willChange = 'transform';
    // The layer keeps the scale it was drawn at while it moves. Zooming out, that scale is too detailed for an
    // ever larger visible area (from 800% to 6% it asks for over a gigabyte of tiles and stalls for a second), so
    // it is redrawn each time the zoom has halved instead of only when zooming stops.
    if (!rasterZoom) rasterZoom = zoom;
    else if (zoom < rasterZoom / 2 && !noHalving) reraster(w, zoom);
  }
  setHitTesting(false);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    setHitTesting(true);
    cull();
    const z = useStore.getState().view.zoom;
    const ww = world();
    if (!ww || z === rasterZoom) return;
    reraster(ww, z);
  }, 220);
  scheduleCull();
}

/** Diagnostic switch (set in localStorage) to compare against redrawing only when zooming stops. */
const noHalving = !!localStorage.getItem('pen.debug.noHalving');
let rerastering = false;
/** Redraws the canvas layer at the current zoom: dropping the layer hint for two frames makes the browser start over. */
function reraster(w: HTMLElement, zoom: number) {
  rasterZoom = zoom;
  rerastering = true;
  w.style.willChange = 'auto';
  let left = 2;
  const done = () => {
    if (--left > 0) return void requestAnimationFrame(done);
    rerastering = false;
    w.style.willChange = 'transform';
  };
  requestAnimationFrame(done);
  // A hidden tab gets no frames; don't leave the flag stuck.
  setTimeout(() => {
    if (!rerastering) return;
    rerastering = false;
    w.style.willChange = 'transform';
  }, 400);
}

/**
 * Forces the top-level frames containing these keys to render live (for screenshots, exports, zooming to nodes):
 * un-culls them and switches them out of bitmap mode. Callers should wait a couple of frames afterwards.
 */
export function ensureRendered(keys: string[], ms = 4000) {
  const until = performance.now() + ms;
  const tree = currentTree();
  const roots = new Set<string>();
  for (const key of keys) {
    let k = key;
    let p = tree?.parent.get(k);
    while (p) {
      k = p.key;
      p = tree?.parent.get(k);
    }
    roots.add(k);
  }
  const wallUntil = Date.now() + ms;
  useStore.setState(s => {
    const next = { ...s.pinnedRoots };
    for (const r of roots) next[r] = wallUntil;
    return { pinnedRoots: next };
  });
  for (const el of rootElements()) {
    const k = el.dataset.k!;
    if (roots.has(k)) {
      pinned.set(k, until);
      el.style.contentVisibility = '';
      el.style.containIntrinsicSize = '';
    }
  }
}

/**
 * World-space bounds of a top-level node without touching the DOM: from the document when it has a fixed size, else
 * the size measured for this node version. Null when it has to be measured.
 */
export function rootWorldRect(n: RNode): Rect | null {
  const p = n.props;
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || p.rotation) return null;
  if (typeof p.width === 'number' && typeof p.height === 'number') return { x: p.x, y: p.y, w: p.width, h: p.height };
  const r = worldRects.get(n.key);
  return r && measuredFor.get(n.key) === n ? { ...r, x: p.x, y: p.y } : null;
}

export function forgetRoot(key: string) {
  worldRects.delete(key);
  measuredFor.delete(key);
}
