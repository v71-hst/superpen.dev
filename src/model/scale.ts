// The Scale tool (K): resizing with it scales a layer and everything inside it together, the way an image scales:
// sizes, positions, gaps, padding, corner radii, stroke widths and dashes, font sizes and letter spacing, shadow
// offsets and blurs. What is relative already stays as it is: line height (a multiple of the font size), gradient
// geometry (fractions of the box), path data (mapped onto the box by its viewBox), opacity, rotation.
// Values bound to a variable ("$name") are left alone: the variable belongs to the design system, not to this layer.
import type { PenNode } from './types';

const num = (v: unknown): v is number => typeof v === 'number' && isFinite(v);
const round = (v: number) => Math.round(v * 100) / 100;

/** Scales a number, an array of numbers, or an object of numbers; anything else (strings, variables) is returned as is. */
function scaled(v: any, k: number): any {
  if (num(v)) return round(v * k);
  if (Array.isArray(v)) return v.map(x => scaled(x, k));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([key, x]) => [key, scaled(x, k)]));
  return v;
}

/** "fit_content(200)" keeps its meaning with a scaled fallback; plain sizing words are untouched. */
function scaledSize(v: any, k: number): any {
  if (num(v)) return round(v * k);
  if (typeof v === 'string') return v.replace(/\(([\d.]+)\)/, (_, n) => `(${round(Number(n) * k)})`);
  return v;
}

function scaleEffect(e: any, k: number): any {
  if (!e || typeof e !== 'object') return e;
  if (Array.isArray(e)) return e.map(x => scaleEffect(x, k));
  const out = { ...e };
  for (const key of ['blur', 'spread', 'radius']) if (num(out[key])) out[key] = round(out[key] * k);
  if (out.offset && typeof out.offset === 'object') out.offset = scaled(out.offset, k);
  return out;
}

/** Props of one node that scale with it (not its position: the caller decides where the scaled layer sits). */
function scaleOwn(n: PenNode, k: number) {
  if ('width' in n) n.width = scaledSize(n.width, k);
  if ('height' in n) n.height = scaledSize(n.height, k);
  for (const key of ['gap', 'padding', 'cornerRadius', 'strokeWidth', 'strokeDash', 'fontSize', 'letterSpacing']) if (key in n) n[key] = scaled(n[key], k);
  if ('effect' in n) n.effect = scaleEffect(n.effect, k);
}

/**
 * Scales a node and its whole subtree by k, in place (pass a draft or a copy). The node's own x/y are left to the
 * caller; its descendants' positions scale. Instances scale their box and the overrides they carry; the component
 * they point at is not touched.
 */
export function scaleSubtree(n: PenNode, k: number, isRoot = true): PenNode {
  if (!isFinite(k) || k <= 0 || k === 1) return n;
  scaleOwn(n, k);
  if (!isRoot) {
    if (num(n.x)) n.x = round(n.x * k);
    if (num(n.y)) n.y = round(n.y * k);
  }
  // Overrides an instance carries are props of nodes inside it.
  if (n.descendants && typeof n.descendants === 'object') {
    for (const entry of Object.values<any>(n.descendants)) {
      if (!entry || typeof entry !== 'object') continue;
      if (Array.isArray(entry.children)) entry.children.forEach((c: PenNode) => scaleSubtree(c, k, false));
      const { children, ...own } = entry;
      scaleOwn(own as PenNode, k);
      for (const key of ['x', 'y']) if (num(own[key])) own[key] = round(own[key] * k);
      Object.assign(entry, own);
    }
  }
  // Component states are alternative props of the same nodes.
  if (n.states && typeof n.states === 'object') {
    for (const st of Object.values<any>(n.states)) {
      if (st?.root) scaleOwn(st.root, k);
      for (const d of Object.values<any>(st?.descendants ?? {})) {
        scaleOwn(d, k);
        for (const key of ['x', 'y']) if (num(d[key])) d[key] = round(d[key] * k);
      }
    }
  }
  for (const c of n.children ?? []) scaleSubtree(c, k, false);
  return n;
}
