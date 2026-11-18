// Layout without the DOM (docs/SKIA_REWORK.md, stage 2): boxes for every node of an RNode tree, reproducing what
// boxStyle / BoxView / GroupView / TextView / ShapeView / IconView / NoteView in src/render/NodeView.tsx make the
// browser do. The DOM renderer stays the reference: tests/layout-diff.mjs compares every box against it.
//
// What the browser does there, in short: every node is a border-box element. Frames with layout horizontal (the
// default) or vertical are single-line flex containers (gap, padding, justify-content, align-items, no wrapping);
// their children are flex items with flex-shrink 0, `fill_container` on the main axis is `flex: 1 1 0` with a zero
// minimum, on the cross axis `align-self: stretch`. Children of `layout: none` frames, groups and scripts, and
// children with `layoutPosition: absolute`, are absolutely positioned at x, y; an auto width there is CSS
// shrink-to-fit. Rotation (counter-clockwise degrees) turns about the top-left corner, flips about the centre;
// transforms never change layout.
import type { PenDoc, RNode } from '../model/types';
import { deepResolve } from '../model/resolve';

export type Mat = [number, number, number, number, number, number];
export type LayoutNode = {
  key: string;
  node: RNode;
  x: number;
  y: number;
  w: number;
  h: number;
  local: Mat;
  world: Mat;
  children: LayoutNode[];
  /** For text nodes: the max width the text was laid out with (null = no wrapping). */
  textWidth?: number | null;
};
/**
 * Size of a text node's content. maxWidth null: one line per hard break. Otherwise h is the height laid out at exactly
 * maxWidth (words longer than a line break, as overflow-wrap: break-word does) and w is the shrink-to-fit width
 * min(max-content, max(min-content, maxWidth)): with maxWidth 0, the longest word.
 */
export type MeasureText = (n: RNode, maxWidth: number | null) => { w: number; h: number };
export type LayoutOptions = { doc?: Pick<PenDoc, 'variables'> };

// ---------- matrices ----------

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

export function matMul(a: Mat, b: Mat): Mat {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export function matApply(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function matInvert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return [...IDENTITY];
  const [a, b, c, d, e, f] = m;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function worldBounds(n: LayoutNode): { x: number; y: number; w: number; h: number } {
  const m = n.world;
  if (m[1] === 0 && m[2] === 0) {
    const x0 = m[4];
    const y0 = m[5];
    const x1 = m[0] * n.w + m[4];
    const y1 = m[3] * n.h + m[5];
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  const pts = [matApply(m, 0, 0), matApply(m, n.w, 0), matApply(m, 0, n.h), matApply(m, n.w, n.h)];
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Translate, then rotate (CSS rotate(-rotation) about the top-left), then flip about the centre. */
function localMatrix(x: number, y: number, w: number, h: number, p: any): Mat {
  let m: Mat = [1, 0, 0, 1, x, y];
  const rot = num(p.rotation);
  if (rot) {
    const t = (-rot * Math.PI) / 180;
    const c = Math.cos(t);
    const s = Math.sin(t);
    m = matMul(m, [c, s, -s, c, 0, 0]);
  }
  if (p.flipX === true || p.flipY === true) {
    const fx = p.flipX === true ? -1 : 1;
    const fy = p.flipY === true ? -1 : 1;
    m = matMul(m, [fx, 0, 0, fy, (w / 2) * (1 - fx), (h / 2) * (1 - fy)]);
  }
  return m;
}

// ---------- props ----------

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
/** Chrome lays out in 1/64 px units: flexed sizes are rounded down to them, which decides where text wraps. */
const lu = (v: number) => Math.floor(v * 64) / 64;
const SKIP_RESOLVE = new Set(['children', 'descendants', 'id', 'type', 'ref', 'name', 'context', 'metadata']);
const resolvedCache = new WeakMap<RNode, { vars: any; p: any }>();

/** Props with variables resolved, as NodeView's resolveProps makes them (cached per node and variable set). */
export function resolvedProps(n: RNode, doc?: Pick<PenDoc, 'variables'>): any {
  const vars = doc?.variables;
  const hit = resolvedCache.get(n);
  if (hit && hit.vars === vars) return hit.p;
  const out: any = {};
  for (const k of Object.keys(n.props)) out[k] = SKIP_RESOLVE.has(k) || !doc ? n.props[k] : deepResolve(doc as PenDoc, n.props[k], n.theme);
  resolvedCache.set(n, { vars, p: out });
  return out;
}

type Sizing = { mode: 'fixed'; px: number } | { mode: 'fill'; fallback?: number } | { mode: 'fit'; fallback?: number };

/** Same as parseSizing in NodeView.tsx. */
export function parseSizing(v: any): Sizing {
  if (typeof v === 'number' && isFinite(v)) return { mode: 'fixed', px: v };
  if (typeof v === 'string') {
    const m = v.match(/^(fill_container|fit_content)(?:\(([-\d.]+)\))?$/);
    if (m) {
      const fb = m[2] !== undefined ? parseFloat(m[2]) : undefined;
      return m[1] === 'fill_container' ? { mode: 'fill', fallback: fb } : { mode: 'fit', fallback: fb };
    }
    const n = parseFloat(v);
    if (isFinite(n)) return { mode: 'fixed', px: n };
  }
  return { mode: 'fit' };
}

/** Same as childExtent in NodeView.tsx: raw (unresolved) props, disabled children included. */
function childExtent(n: RNode, axis: 'x' | 'y'): number {
  let max = 0;
  for (const c of n.children) {
    const p = c.props;
    const s = parseSizing(axis === 'x' ? p.width : p.height);
    const size = s.mode === 'fixed' ? s.px : (s.fallback ?? 0);
    max = Math.max(max, num(axis === 'x' ? p.x : p.y) + size);
  }
  return max;
}

function padding(v: any): [number, number, number, number] {
  if (v === undefined) return [0, 0, 0, 0];
  if (Array.isArray(v)) {
    if (v.length === 2) return [num(v[0]), num(v[1]), num(v[0]), num(v[1])];
    if (v.length === 4) return [num(v[0]), num(v[1]), num(v[2]), num(v[3])];
    return [num(v[0]), num(v[0]), num(v[0]), num(v[0])];
  }
  const p = num(v);
  return [p, p, p, p];
}

type Layout = 'none' | 'horizontal' | 'vertical';

/**
 * How one axis of a node is sized, from the CSS boxStyle writes: a fixed length, `fill` (flex / stretch when in flow,
 * the fallback or 100% of the containing block when absolute) or `auto` (content-based).
 */
type Spec = { kind: 'fixed'; v: number } | { kind: 'fill' } | { kind: 'pct' } | { kind: 'auto' };

type Info = {
  p: any;
  /** The node's own children layout ('none' for everything but flex frames). */
  layout: Layout;
  spec: { x: Spec; y: Spec };
  absolute: boolean;
};

// ---------- engine ----------

class Engine {
  private infos = new Map<RNode, Map<Layout, Info>>();
  private intrinsicMemo = new Map<Info, { min: number; max: number }>();
  private heightMemo = new Map<Info, Map<number, number>>();
  private flexMemo = new Map<string, FlexResult>();

  constructor(
    private measure: MeasureText,
    private doc: Pick<PenDoc, 'variables'> | undefined,
  ) {}

  /** Props with the per-type defaults NodeView applies before boxStyle. */
  private props(n: RNode): any {
    const p = resolvedProps(n, this.doc);
    switch (n.type) {
      case 'script':
        return { ...p, width: p.width ?? 200, height: p.height ?? 200 };
      case 'note':
      case 'prompt':
      case 'context':
        return { ...p, width: p.width ?? 240, height: p.height ?? 160 };
      case 'browser':
        return { ...p, width: p.width ?? 1280, height: p.height ?? 800 };
      case 'frame':
      case 'rectangle':
      case 'group':
      case 'text':
      case 'ellipse':
      case 'polygon':
      case 'path':
      case 'line':
      case 'icon':
      case 'icon_font':
        return p;
      default:
        return { ...p, width: p.width ?? 100, height: p.height ?? 100 };
    }
  }

  info(n: RNode, parentLayout: Layout): Info {
    let byParent = this.infos.get(n);
    if (!byParent) this.infos.set(n, (byParent = new Map()));
    const hit = byParent.get(parentLayout);
    if (hit) return hit;
    const p = this.props(n);
    const absolute = parentLayout === 'none' || p.layoutPosition === 'absolute';
    const layout: Layout = n.type === 'frame' ? (p.layout === 'none' || p.layout === 'vertical' || p.layout === 'horizontal' ? p.layout : 'horizontal') : 'none';
    const spec = (axis: 'x' | 'y'): Spec => {
      if (n.type === 'group') {
        // GroupView drops width/height; in flow it gets the children's extent, absolute it has no size of its own.
        return absolute ? { kind: 'auto' } : { kind: 'fixed', v: childExtent(n, axis) };
      }
      if (n.type === 'text') {
        const growth = p.textGrowth ?? 'auto';
        if (axis === 'x' && growth === 'auto') return { kind: 'auto' };
        if (axis === 'y' && growth !== 'fixed-width-height') return { kind: 'auto' };
      }
      const fit = n.type === 'frame' && layout === 'none' ? childExtent(n, axis) : undefined;
      const s = parseSizing(axis === 'x' ? p.width : p.height);
      if (s.mode === 'fixed') return { kind: 'fixed', v: s.px };
      if (s.mode === 'fill') return absolute ? (s.fallback !== undefined ? { kind: 'fixed', v: s.fallback } : { kind: 'pct' }) : { kind: 'fill' };
      if (s.fallback !== undefined && !(fit !== undefined && fit > 0)) return { kind: 'fixed', v: s.fallback };
      if (fit !== undefined) return { kind: 'fixed', v: fit };
      return { kind: 'auto' };
    };
    const info: Info = { p, layout, spec: { x: spec('x'), y: spec('y') }, absolute };
    byParent.set(parentLayout, info);
    return info;
  }

  private inFlow(n: RNode): RNode[] {
    return n.children.filter(c => {
      const p = resolvedProps(c, this.doc);
      return p.enabled !== false && p.layoutPosition !== 'absolute';
    });
  }

  /** Icon glyph size: NodeView uses min(width, height), each 24 when not a fixed number. */
  private iconSize(i: Info) {
    return Math.min(i.spec.x.kind === 'fixed' ? i.spec.x.v : 24, i.spec.y.kind === 'fixed' ? i.spec.y.v : 24);
  }

  private wraps(n: RNode, i: Info) {
    return n.type === 'text' && (i.p.textGrowth ?? 'auto') !== 'auto';
  }

  /** Min-content and max-content width of a node whose width is auto (border box). */
  intrinsicW(n: RNode, i: Info): { min: number; max: number } {
    const hit = this.intrinsicMemo.get(i);
    if (hit) return hit;
    let r = { min: 0, max: 0 };
    if (n.type === 'text') {
      const max = this.measure(n, null).w;
      r = { min: this.wraps(n, i) ? Math.min(max, this.measure(n, 0).w) : max, max };
    } else if (n.type === 'icon' || n.type === 'icon_font') {
      const s = this.iconSize(i);
      r = { min: s, max: s };
    } else if (n.type === 'frame' && i.layout !== 'none') {
      const [, pr, , pl] = padding(i.p.padding);
      const gap = num(i.p.gap);
      const items = this.inFlow(n);
      let min = 0;
      let max = 0;
      items.forEach((c, k) => {
        const ci = this.info(c, i.layout);
        const cw = ci.spec.x.kind === 'fixed' ? { min: ci.spec.x.v, max: ci.spec.x.v } : this.intrinsicW(c, ci);
        if (i.layout === 'horizontal') {
          min += cw.min + (k ? gap : 0);
          max += cw.max + (k ? gap : 0);
        } else {
          min = Math.max(min, cw.min);
          max = Math.max(max, cw.max);
        }
      });
      r = { min: min + pl + pr, max: max + pl + pr };
    }
    this.intrinsicMemo.set(i, r);
    return r;
  }

  /** Height of a node at border-box width w when its height is not set by its parent (stretch / flex). */
  contentH(n: RNode, i: Info, w: number): number {
    let byW = this.heightMemo.get(i);
    if (!byW) this.heightMemo.set(i, (byW = new Map()));
    const hit = byW.get(w);
    if (hit !== undefined) return hit;
    let h = 0;
    if (i.spec.y.kind === 'fixed') h = i.spec.y.v;
    else if (n.type === 'text') h = this.measure(n, this.wraps(n, i) ? w : null).h;
    else if (n.type === 'icon' || n.type === 'icon_font') h = this.iconSize(i);
    else if (n.type === 'frame' && i.layout !== 'none') h = this.flex(n, i, w, undefined).h;
    byW.set(w, h);
    return h;
  }

  /** Lays out a flex frame's in-flow children at outer width W (and outer height H when it is definite). */
  flex(n: RNode, i: Info, W: number, H: number | undefined): FlexResult {
    const memoKey = n.key + '|' + W + '|' + H;
    const hit = this.flexMemo.get(memoKey);
    if (hit) return hit;
    const [pt, pr, pb, pl] = padding(i.p.padding);
    const gap = num(i.p.gap);
    const items = this.inFlow(n).map(c => ({ c, ci: this.info(c, i.layout), x: 0, y: 0, w: 0, h: 0, grow: false, stretch: false }));
    const gaps = gap * Math.max(0, items.length - 1);
    const innerW = W - pl - pr;
    let innerH: number;
    if (i.layout === 'horizontal') {
      // Main sizes: fixed, max-content, or a share of the free space (flex: 1 1 0, never below 0).
      let base = 0;
      let growers = 0;
      for (const it of items) {
        const s = it.ci.spec.x;
        if (s.kind === 'fixed') it.w = s.v;
        else if (s.kind === 'fill') (it.grow = true), growers++;
        else it.w = this.intrinsicW(it.c, it.ci).max;
        base += it.w;
      }
      const free = innerW - base - gaps;
      if (growers) for (const it of items) if (it.grow) it.w = free > 0 ? lu(free / growers) : 0;
      // Cross sizes at those widths; stretched items size the line by their content first.
      let line = 0;
      for (const it of items) {
        const s = it.ci.spec.y;
        it.stretch = s.kind === 'fill';
        it.h = s.kind === 'fixed' ? s.v : this.contentH(it.c, it.ci, it.w);
        line = Math.max(line, it.h);
      }
      innerH = H !== undefined ? H - pt - pb : line;
      for (const it of items) if (it.stretch) it.h = innerH;
      this.place(items, i.p, innerW, innerH, pl, pt, 'x', growers > 0 && free > 0, gap);
    } else {
      // Cross (width) first: fixed, stretched to the inner width, or fit-content.
      for (const it of items) {
        const s = it.ci.spec.x;
        it.stretch = s.kind === 'fill';
        if (s.kind === 'fixed') it.w = s.v;
        else if (it.stretch) it.w = innerW;
        else {
          const iw = this.intrinsicW(it.c, it.ci);
          it.w = Math.min(iw.max, Math.max(iw.min, innerW));
        }
      }
      let base = 0;
      let growers = 0;
      for (const it of items) {
        const s = it.ci.spec.y;
        if (s.kind === 'fixed') it.h = s.v;
        else if (s.kind === 'fill') (it.grow = true), growers++;
        else it.h = this.contentH(it.c, it.ci, it.w);
        base += it.h;
      }
      // An auto-height column is as tall as its items' flex bases: fill items (basis 0) add nothing.
      innerH = H !== undefined ? H - pt - pb : base + gaps;
      const free = innerH - base - gaps;
      if (growers) for (const it of items) if (it.grow) it.h = free > 0 ? lu(free / growers) : 0;
      this.place(items, i.p, innerH, innerW, pt, pl, 'y', growers > 0 && free > 0, gap);
    }
    const r: FlexResult = { w: W, h: H !== undefined ? H : innerH + pt + pb, items };
    this.flexMemo.set(memoKey, r);
    return r;
  }

  /** justify-content along the main axis, align-items across it. */
  private place(items: FlexItem[], p: any, innerMain: number, innerCross: number, padMain: number, padCross: number, axis: 'x' | 'y', filled: boolean, gap: number) {
    const mainOf = (it: FlexItem) => (axis === 'x' ? it.w : it.h);
    const crossOf = (it: FlexItem) => (axis === 'x' ? it.h : it.w);
    const k = items.length;
    const used = items.reduce((s, it) => s + mainOf(it), 0) + gap * Math.max(0, k - 1);
    const rem = filled ? 0 : innerMain - used;
    let start = 0;
    let between = gap;
    switch (p.justifyContent) {
      case 'center':
        start = rem / 2;
        break;
      case 'end':
        start = rem;
        break;
      case 'space_between':
        if (rem > 0 && k > 1) between = gap + rem / (k - 1);
        break;
      case 'space_around':
        if (rem > 0) {
          start = rem / k / 2;
          between = gap + rem / k;
        }
        break;
    }
    let pos = padMain + start;
    for (const it of items) {
      const free = innerCross - crossOf(it);
      const off = it.stretch ? 0 : p.alignItems === 'center' ? free / 2 : p.alignItems === 'end' ? free : 0;
      if (axis === 'x') {
        it.x = pos;
        it.y = padCross + off;
      } else {
        it.y = pos;
        it.x = padCross + off;
      }
      pos += mainOf(it) + between;
    }
  }

  /** Width of an absolutely positioned node: its spec, or shrink-to-fit against the containing block. */
  private absWidth(n: RNode, i: Info, cbW: number): number {
    const s = i.spec.x;
    if (s.kind === 'fixed') return s.v;
    if (s.kind === 'pct') return cbW;
    const iw = this.intrinsicW(n, i);
    return Math.min(iw.max, Math.max(iw.min, cbW - num(i.p.x)));
  }

  private absHeight(n: RNode, i: Info, w: number, cbH: number): number {
    const s = i.spec.y;
    if (s.kind === 'fixed') return s.v;
    if (s.kind === 'pct') return cbH;
    return this.contentH(n, i, w);
  }

  /** Builds the LayoutNode for n with its final border-box size, then its children. */
  build(n: RNode, i: Info, x: number, y: number, w: number, h: number, parentWorld: Mat, out: Map<string, LayoutNode> | null): LayoutNode {
    const local = localMatrix(x, y, w, h, i.p);
    const world = matMul(parentWorld, local);
    const ln: LayoutNode = { key: n.key, node: n, x, y, w, h, local, world, children: [] };
    if (n.type === 'text') ln.textWidth = this.wraps(n, i) ? w : null;
    out?.set(n.key, ln);
    const flexItems = n.type === 'frame' && i.layout !== 'none' ? new Map(this.flex(n, i, w, h).items.map(it => [it.c, it])) : null;
    // Only frames, groups, scripts and placeholders render their children.
    const rendersChildren = n.type === 'frame' || n.type === 'group' || n.type === 'script' || !KNOWN.has(n.type);
    if (!rendersChildren) return ln;
    for (const c of n.children) {
      const ci = this.info(c, i.layout);
      if (ci.p.enabled === false) continue;
      const it = flexItems?.get(c);
      if (it) ln.children.push(this.build(c, ci, it.x, it.y, it.w, it.h, world, out));
      else {
        const cw = this.absWidth(c, ci, w);
        const ch = this.absHeight(c, ci, cw, h);
        ln.children.push(this.build(c, ci, num(ci.p.x), num(ci.p.y), cw, ch, world, out));
      }
    }
    return ln;
  }

  /** A top-level node: absolutely positioned in #pen-world, which is 0×0. */
  root(n: RNode, out: Map<string, LayoutNode> | null): LayoutNode {
    const i = this.info(n, 'none');
    const w = this.absWidth(n, i, 0);
    const h = this.absHeight(n, i, w, 0);
    return this.build(n, i, num(i.p.x), num(i.p.y), w, h, IDENTITY, out);
  }
}

const KNOWN = new Set(['frame', 'rectangle', 'group', 'text', 'ellipse', 'polygon', 'path', 'line', 'icon', 'icon_font', 'note', 'prompt', 'context', 'browser', 'script']);

type FlexItem = { c: RNode; ci: Info; x: number; y: number; w: number; h: number; grow: boolean; stretch: boolean };
type FlexResult = { w: number; h: number; items: FlexItem[] };

// ---------- public API ----------

export function layoutTree(root: RNode, measure: MeasureText, opts: LayoutOptions = {}): LayoutNode {
  return new Engine(measure, opts.doc).root(root, null);
}

const cache = new WeakMap<RNode, { measure: MeasureText; vars: any; index: Map<string, LayoutNode> }>();

/** Layout of every top-level node, indexed by key. Unchanged frames (same RNode object) are not recomputed. */
export function layoutAll(roots: RNode[], measure: MeasureText, opts: LayoutOptions = {}): Map<string, LayoutNode> {
  const all = new Map<string, LayoutNode>();
  const vars = opts.doc?.variables;
  for (const r of roots) {
    let hit = cache.get(r);
    if (!hit || hit.measure !== measure || hit.vars !== vars) {
      const index = new Map<string, LayoutNode>();
      new Engine(measure, opts.doc).root(r, index);
      hit = { measure, vars, index };
      cache.set(r, hit);
    }
    for (const [k, v] of hit.index) all.set(k, v);
  }
  return all;
}
