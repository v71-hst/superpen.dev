// Where nodes are on the canvas (docs/SKIA_REWORK.md, stage 2c). Every "where is this node" and "which node is under
// this point" question goes through this module. Today one backend answers by asking the DOM renderer, whose
// elements carry data-k="<node key>"; stage 4 adds a backend that answers from the layout tree when Skia draws
// everything. Code that needs the element itself for other reasons (text editing, cloning for snapshots, style
// toggles) uses nodeEl(). Nothing here may call useStore at module load (import cycle: store -> diagnostics -> host
// -> agent -> ...).
import { useStore } from './store';
import { isGeneratedKey } from '../model/resolve';

export type WorldRect = { x: number; y: number; w: number; h: number };

const elCache = new Map<string, HTMLElement>();

const world = () => document.getElementById('pen-world');

/** Answers from the DOM renderer. */
const dom = {
  /** Element rendering a node. Cached because a selector search over a large document is expensive. */
  el(key: string): HTMLElement | null {
    const hit = elCache.get(key);
    if (hit && hit.isConnected && hit.dataset.k === key) return hit;
    const w = world();
    let el: HTMLElement | null = null;
    // Top-level frames are direct children of the world: avoid a full-document search for them.
    if (w && !key.includes('/')) {
      for (const c of w.children) if ((c as HTMLElement).dataset.k === key) el = c as HTMLElement;
    }
    el ??= document.querySelector(`#pen-world [data-k="${CSS.escape(key)}"]`);
    if (el) {
      if (elCache.size > 20000) elCache.clear();
      elCache.set(key, el);
    } else elCache.delete(key);
    return el;
  },

  screenRect(key: string): DOMRect | null {
    const el = dom.el(key);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if ((r.width > 0 || r.height > 0) && !el.hasAttribute('data-group')) return r;
    // Groups have no box of their own: union of descendants.
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    el.querySelectorAll('[data-k]').forEach(c => {
      const cr = c.getBoundingClientRect();
      if (!cr.width && !cr.height) return;
      x0 = Math.min(x0, cr.left);
      y0 = Math.min(y0, cr.top);
      x1 = Math.max(x1, cr.right);
      y1 = Math.max(y1, cr.bottom);
    });
    if (!isFinite(x0)) return r;
    return new DOMRect(x0, y0, x1 - x0, y1 - y0);
  },

  /** Layout size in design pixels, ignoring the view's zoom and any rotation (0 for elements without a box). */
  size(key: string): { w: number; h: number } | null {
    const el = dom.el(key);
    return el ? { w: el.offsetWidth, h: el.offsetHeight } : null;
  },

  canvasRect(): DOMRect {
    return document.getElementById('pen-canvas')?.getBoundingClientRect() ?? new DOMRect(0, 0, innerWidth, innerHeight);
  },

  /** Ancestor chain of node keys for an element inside the world, outermost first. */
  chainOf(el: Element | null): string[] {
    const out: string[] = [];
    while (el && el.id !== 'pen-world') {
      const k = (el as HTMLElement).dataset?.k;
      // Script output isn't selectable on its own; clicks land on the script node.
      if (k && !isGeneratedKey(k)) out.unshift(k);
      el = el.parentElement;
    }
    return out;
  },

  elementAt(clientX: number, clientY: number): Element | null {
    return document.elementFromPoint(clientX, clientY);
  },

  elementsAt(clientX: number, clientY: number): Element[] {
    return document.elementsFromPoint(clientX, clientY);
  },

  topLevelEls(): HTMLElement[] {
    const w = world();
    return w ? (Array.from(w.children) as HTMLElement[]).filter(el => el.dataset.k) : [];
  },
};

const backend = dom;

/**
 * Stage 4 (`pen.renderer=full`): top-level frames drawn by Skia have no elements inside them, so their geometry comes
 * from the layout tree. src/skia registers these hooks at runtime (this module must not import it: import cycles).
 */
export type SkiaGeometry = {
  /** Whether Skia draws this top-level frame (no DOM inside it). */
  drawn(rootKey: string): boolean;
  /** Top-level frame a node belongs to. */
  rootOf(key: string): string | null;
  worldRect(key: string): WorldRect | null;
  size(key: string): { w: number; h: number } | null;
  /** Node chain under a world point among Skia-drawn frames (topmost first by draw order), or null if none. */
  chainAt(wx: number, wy: number): string[] | null;
};
let skia: SkiaGeometry | null = null;
export function setSkiaGeometry(g: SkiaGeometry | null) {
  skia = g;
}
/**
 * Whether the node's geometry comes from the layout engine: every frame since the page-element renderer was removed
 * (2026-11-20), drawn by Skia yet or not (a frame still loading has no elements to measure either).
 */
export const skiaOwns = (key: string) => {
  if (!skia) return false;
  return !!skia.rootOf(key);
};
function worldToScreen(r: WorldRect): DOMRect {
  const { view } = useStore.getState();
  const c = canvasRect();
  return new DOMRect(c.left + view.x + r.x * view.zoom, c.top + view.y + r.y * view.zoom, r.w * view.zoom, r.h * view.zoom);
}
function screenRect(key: string): DOMRect | null {
  if (skiaOwns(key)) {
    const r = skia!.worldRect(key);
    return r ? worldToScreen(r) : null;
  }
  return backend.screenRect(key);
}

/** The element rendering a node (DOM renderer only). Prefer the measuring functions below for geometry. */
export function nodeEl(key: string): HTMLElement | null {
  return dom.el(key);
}

/** Whether a node is currently drawn on the canvas (live, or as a zoomed-out snapshot or placeholder). */
export function isRendered(key: string): boolean {
  return !!dom.el(key) || skiaOwns(key);
}

/**
 * A node's box in client (screen) coordinates; groups get the union of their children unless `ownBox` asks for the
 * group element's own box.
 */
export function nodeScreenRect(key: string, opts: { ownBox?: boolean } = {}): DOMRect | null {
  if (opts.ownBox && !skiaOwns(key)) return dom.el(key)?.getBoundingClientRect() ?? null;
  return screenRect(key);
}

/** A node's box in world (design) coordinates. */
export function nodeRect(key: string): WorldRect | null {
  if (skiaOwns(key)) return skia!.worldRect(key);
  const r = backend.screenRect(key);
  if (!r) return null;
  const p = clientToWorld(r.left, r.top);
  const z = useStore.getState().view.zoom;
  return { x: p.x, y: p.y, w: r.width / z, h: r.height / z };
}

/** A node's own size in design pixels (no zoom, no rotation); 0 when it has no box of its own (groups). */
export function nodeSize(key: string): { w: number; h: number } | null {
  if (skiaOwns(key)) return skia!.size(key);
  return backend.size(key);
}

export function canvasRect(): DOMRect {
  return backend.canvasRect();
}

export function clientToWorld(cx: number, cy: number) {
  const { view } = useStore.getState();
  const c = canvasRect();
  return { x: (cx - c.left - view.x) / view.zoom, y: (cy - c.top - view.y) / view.zoom };
}

/** The node an element renders (its own data-k), if any. */
export function nodeKeyOf(el: Element | null | undefined): string | null {
  return (el as HTMLElement | null | undefined)?.dataset?.k ?? null;
}

/** The innermost node an element belongs to. */
export function ownerNodeKey(el: Element | null | undefined): string | null {
  return nodeKeyOf(el?.closest('[data-k]'));
}

/** Node keys from the outermost to the innermost node containing an element on the canvas. */
export function nodeChainOf(el: Element | null): string[] {
  return backend.chainOf(el);
}

/** The topmost element under a point (canvas nodes or anything laid over them). */
export function elementAtPoint(clientX: number, clientY: number): Element | null {
  return backend.elementAt(clientX, clientY);
}

/** Every element under a point, topmost first. */
export function elementsAtPoint(clientX: number, clientY: number): Element[] {
  return backend.elementsAt(clientX, clientY);
}

/** Node keys from the outermost to the innermost node under a point. */
export function nodeChainAtPoint(clientX: number, clientY: number): string[] {
  return nodeChainAtEvent({ clientX, clientY }, backend.elementAt(clientX, clientY));
}

/**
 * Node chain under the pointer, given the element the browser found there. Elements of DOM-drawn frames and the
 * overlays sit above the Skia canvas and win; a point over a Skia-drawn frame is answered from the layout tree.
 */
export function nodeChainAtEvent(e: { clientX: number; clientY: number }, target: Element | null): string[] {
  if (skia && target) {
    const inWorld = !!target.closest('#pen-world');
    const root = inWorld ? target.closest<HTMLElement>('#pen-world > [data-k]')?.dataset.k : null;
    const overSkia = (inWorld && root && skia.drawn(root)) || target.id === 'pen-canvas' || target.id === 'pen-skia' || target.id === 'pen-world';
    if (overSkia) {
      const w = clientToWorld(e.clientX, e.clientY);
      const chain = skia.chainAt(w.x, w.y);
      if (chain) return chain;
    }
  }
  return backend.chainOf(target);
}

/** Elements of the top-level frames currently on the canvas (live, snapshot or placeholder). */
export function topLevelNodeEls(): HTMLElement[] {
  return backend.topLevelEls();
}

/** A top-level frame's element; `live` skips zoomed-out snapshots and placeholders. */
export function topLevelNodeEl(key: string, opts: { live?: boolean } = {}): HTMLElement | null {
  for (const el of backend.topLevelEls()) {
    if (el.dataset.k !== key) continue;
    if (!opts.live || (!('bitmap' in el.dataset) && !('placeholder' in el.dataset))) return el;
  }
  return null;
}

/** The top-level frame element an element is part of. */
export function topLevelNodeElOf(el: Element): HTMLElement | null {
  return el.closest<HTMLElement>('#pen-world > [data-k]');
}

/** Which of the candidate nodes overlap a rectangle given in client coordinates. */
export function nodesInScreenRect(r: { left: number; top: number; width: number; height: number }, candidates: string[]): string[] {
  const hits: string[] = [];
  for (const key of candidates) {
    const sr = screenRect(key);
    if (!sr) continue;
    if (sr.left < r.left + r.width && sr.left + sr.width > r.left && sr.top < r.top + r.height && sr.top + sr.height > r.top) hits.push(key);
  }
  return hits;
}
