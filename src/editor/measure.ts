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

  /** Layout size in design pixels, ignoring the view's zoom and any rotation. */
  size(key: string): { w: number; h: number } | null {
    const el = dom.el(key);
    if (!el) return null;
    return { w: el.offsetWidth || el.getBoundingClientRect().width, h: el.offsetHeight || el.getBoundingClientRect().height };
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

/** The element rendering a node (DOM renderer only). Prefer the measuring functions below for geometry. */
export function nodeEl(key: string): HTMLElement | null {
  return dom.el(key);
}

/** Whether a node is currently drawn on the canvas (live, or as a zoomed-out snapshot or placeholder). */
export function isRendered(key: string): boolean {
  return !!dom.el(key);
}

/**
 * A node's box in client (screen) coordinates; groups get the union of their children unless `ownBox` asks for the
 * group element's own box.
 */
export function nodeScreenRect(key: string, opts: { ownBox?: boolean } = {}): DOMRect | null {
  if (opts.ownBox) return dom.el(key)?.getBoundingClientRect() ?? null;
  return backend.screenRect(key);
}

/** A node's box in world (design) coordinates. */
export function nodeRect(key: string): WorldRect | null {
  const r = backend.screenRect(key);
  if (!r) return null;
  const p = clientToWorld(r.left, r.top);
  const z = useStore.getState().view.zoom;
  return { x: p.x, y: p.y, w: r.width / z, h: r.height / z };
}

/** A node's own size in design pixels (no zoom, no rotation). */
export function nodeSize(key: string): { w: number; h: number } | null {
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
  return backend.chainOf(backend.elementAt(clientX, clientY));
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
    const sr = backend.screenRect(key);
    if (!sr) continue;
    if (sr.left < r.left + r.width && sr.left + sr.width > r.left && sr.top < r.top + r.height && sr.top + sr.height > r.top) hits.push(key);
  }
  return hits;
}
