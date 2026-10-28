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

/** Hides frames that are well outside the viewport (content-visibility skips their layout and paint). */
export function cull() {
  raf = 0;
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
  if (w && w.style.willChange !== 'transform') w.style.willChange = 'transform';
  setHitTesting(false);
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    setHitTesting(true);
    cull();
    const zoom = useStore.getState().view.zoom;
    const ww = world();
    if (!ww || zoom === rasterZoom) return;
    rasterZoom = zoom;
    ww.style.willChange = 'auto';
    requestAnimationFrame(() => requestAnimationFrame(() => (ww.style.willChange = 'transform')));
  }, 220);
  scheduleCull();
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
