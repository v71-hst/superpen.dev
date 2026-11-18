// Stage 4: geometry from the layout tree for frames Skia draws (they have no DOM elements). measure.ts asks this
// module, through the hooks it registers, where those nodes are and which node is under a point. Hit testing follows
// draw order (last child on top), clipping (a clipped frame hides its children outside its box) and rotation.
import { currentTree } from '../editor/tree';
import { useStore } from '../editor/store';
import { isGeneratedKey } from '../model/resolve';
import type { RNode } from '../model/types';
import { layoutAll, matApply, matInvert, worldBounds, type LayoutNode } from '../layout/layout';
import { canvasMeasureText } from '../layout/measureText';
import { kitIfLoaded } from './kit';
import { propsOf, skiaMeasureText } from './painter';
import { paintContext } from './testing';

let cache: { roots: RNode[]; vars: unknown; kit: unknown; map: Map<string, LayoutNode> } | null = null;

/** Layout of every top-level frame of the current document (cached per tree; unchanged frames reuse their layout). */
export function currentLayout(): Map<string, LayoutNode> {
  const tree = currentTree();
  const s = useStore.getState();
  if (!tree || !s.doc) return new Map();
  const ck = kitIfLoaded();
  if (cache && cache.roots === tree.roots && cache.vars === s.doc.variables && cache.kit === ck) return cache.map;
  const measure = ck ? skiaMeasureText(paintContext(ck)) : canvasMeasureText(s.doc);
  const roots = layoutAll(tree.roots, measure, { doc: s.doc });
  // Index every node, not only roots.
  const map = new Map<string, LayoutNode>();
  const walk = (n: LayoutNode) => {
    map.set(n.key, n);
    n.children.forEach(walk);
  };
  roots.forEach(walk);
  cache = { roots: tree.roots, vars: s.doc.variables, kit: ck, map };
  return map;
}

export function layoutOf(key: string): LayoutNode | null {
  return currentLayout().get(key) ?? null;
}

/** World-space axis-aligned box of a node; groups get the union of their children, as the DOM measure does. */
export function layoutWorldRect(key: string): { x: number; y: number; w: number; h: number } | null {
  const n = layoutOf(key);
  if (!n) return null;
  if (n.node.type !== 'group' || (n.w > 0 && n.h > 0)) return worldBounds(n);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const visit = (c: LayoutNode) => {
    const b = worldBounds(c);
    if (b.w || b.h) {
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w);
      y1 = Math.max(y1, b.y + b.h);
    }
    c.children.forEach(visit);
  };
  n.children.forEach(visit);
  return isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : worldBounds(n);
}

function contains(n: LayoutNode, wx: number, wy: number) {
  const p = matApply(matInvert(n.world), wx, wy);
  return p.x >= 0 && p.y >= 0 && p.x <= n.w && p.y <= n.h;
}

/**
 * Keys from the outermost to the innermost node under a world point inside one top-level frame, or [] if the point
 * misses it. Mirrors what elementFromPoint gives the DOM renderer: invisible (enabled false) nodes are skipped, groups
 * are hit through their children, script output resolves to the script node.
 */
export function hitChain(root: LayoutNode, wx: number, wy: number): string[] {
  const ctx = { doc: useStore.getState().doc! };
  const visit = (n: LayoutNode): string[] | null => {
    const p = propsOf(ctx, n.node);
    if (p.enabled === false) return null;
    const inside = contains(n, wx, wy);
    const clips = (n.node.type === 'frame' && p.clip === true) || n.node.type === 'note';
    if (!clips || inside) {
      for (let i = n.children.length - 1; i >= 0; i--) {
        const c = visit(n.children[i]);
        if (c) return isGeneratedKey(n.key) ? c : [n.key, ...c];
      }
    }
    if (n.node.type === 'group') return null;
    if (!inside) return null;
    return isGeneratedKey(n.key) ? [] : [n.key];
  };
  return visit(root) ?? [];
}
