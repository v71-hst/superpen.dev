// Converts SVG markup into editable .pen vector nodes: a frame containing path nodes (and groups for <g>),
// with fills, gradients, strokes, opacity and transforms carried over and everything scaled to the target size.
import svgpath from 'svgpath';
import { svgPathBbox } from 'svg-path-bbox';
import type { PenNode } from './types';

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function mul(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

function parseTransform(t: string | null): Matrix {
  let m: Matrix = IDENTITY;
  if (!t) return m;
  for (const [, fn, args] of t.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = args.split(/[\s,]+/).filter(Boolean).map(Number);
    let n: Matrix = IDENTITY;
    switch (fn) {
      case 'matrix':
        n = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case 'scale':
        n = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
        break;
      case 'rotate': {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(r);
        const s = Math.sin(r);
        n = [c, s, -s, c, 0, 0];
        if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX':
        n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, n);
  }
  return m;
}

// ---------- colors ----------

let colorCtx: CanvasRenderingContext2D | null = null;
/** Normalizes any CSS color (named, rgb(), hsl(), #abc) to #RRGGBB(AA). */
function toHexColor(c: string, opacity = 1): string | null {
  const s = c.trim();
  if (!s || s === 'none' || s === 'transparent') return null;
  colorCtx ??= document.createElement('canvas').getContext('2d');
  if (!colorCtx) return null;
  colorCtx.fillStyle = '#000000';
  colorCtx.fillStyle = s === 'currentColor' ? '#000000' : s;
  const v = colorCtx.fillStyle; // "#rrggbb" or "rgba(r, g, b, a)"
  let r = 0, g = 0, b = 0, a = 1;
  if (v.startsWith('#')) {
    r = parseInt(v.slice(1, 3), 16);
    g = parseInt(v.slice(3, 5), 16);
    b = parseInt(v.slice(5, 7), 16);
  } else {
    const m = v.match(/[\d.]+/g)?.map(Number) ?? [];
    [r, g, b] = m;
    a = m[3] ?? 1;
  }
  a *= opacity;
  const h = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0').toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}${a < 0.999 ? h(a * 255) : ''}`;
}

// ---------- styles ----------

type Style = Record<string, string>;
const INHERITED = ['fill', 'stroke', 'stroke-width', 'fill-opacity', 'stroke-opacity', 'fill-rule', 'stroke-linecap', 'stroke-linejoin', 'visibility', 'color', 'font-family', 'font-size', 'font-weight'];
const PRESENTATION = [...INHERITED, 'opacity', 'display', 'stop-color', 'stop-opacity'];

function parseCssRules(doc: Document): { sel: string; decl: Style }[] {
  const rules: { sel: string; decl: Style }[] = [];
  for (const st of doc.querySelectorAll('style')) {
    for (const [, sels, body] of (st.textContent ?? '').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const decl = parseStyleAttr(body);
      for (const sel of sels.split(',')) rules.push({ sel: sel.trim(), decl });
    }
  }
  return rules;
}

function parseStyleAttr(s: string | null): Style {
  const out: Style = {};
  for (const part of (s ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function ownStyle(el: Element, rules: { sel: string; decl: Style }[]): Style {
  const out: Style = {};
  for (const p of PRESENTATION) {
    const v = el.getAttribute(p);
    if (v !== null) out[p] = v;
  }
  for (const r of rules) {
    try {
      if (el.matches(r.sel)) Object.assign(out, r.decl);
    } catch {
      /* unsupported selector */
    }
  }
  Object.assign(out, parseStyleAttr(el.getAttribute('style')));
  return out;
}

// ---------- geometry ----------

const num = (el: Element, a: string, d = 0) => {
  const v = parseFloat(el.getAttribute(a) ?? '');
  return isFinite(v) ? v : d;
};

function elementPath(el: Element): string | null {
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d');
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      if (w <= 0 || h <= 0) return null;
      let rx = num(el, 'rx', NaN), ry = num(el, 'ry', NaN);
      if (isNaN(rx)) rx = isNaN(ry) ? 0 : ry;
      if (isNaN(ry)) ry = rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const cx = num(el, 'cx'), cy = num(el, 'cy');
      const rx = el.tagName.toLowerCase() === 'circle' ? num(el, 'r') : num(el, 'rx');
      const ry = el.tagName.toLowerCase() === 'circle' ? num(el, 'r') : num(el, 'ry');
      if (rx <= 0 || ry <= 0) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case 'line':
      return `M${num(el, 'x1')} ${num(el, 'y1')}L${num(el, 'x2')} ${num(el, 'y2')}`;
    case 'polyline':
    case 'polygon': {
      const pts = (el.getAttribute('points') ?? '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return el.tagName.toLowerCase() === 'polygon' ? d + 'Z' : d;
    }
  }
  return null;
}

// ---------- gradients ----------

function gradientStops(g: Element, doc: Document): { color: string; position: number }[] {
  let src: Element | null = g;
  // Stops may be inherited through href chains.
  for (let i = 0; i < 5 && src && !src.querySelector('stop'); i++) {
    const href = src.getAttribute('href') ?? src.getAttribute('xlink:href');
    src = href ? doc.getElementById(href.replace(/^#/, '')) : null;
  }
  if (!src) return [];
  return [...src.querySelectorAll('stop')].map(s => {
    const st = { ...Object.fromEntries(['stop-color', 'stop-opacity'].map(a => [a, s.getAttribute(a) ?? ''])), ...parseStyleAttr(s.getAttribute('style')) };
    const off = s.getAttribute('offset') ?? '0';
    const position = off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
    const opacity = st['stop-opacity'] ? parseFloat(st['stop-opacity']) : 1;
    return { color: toHexColor(st['stop-color'] || '#000', isFinite(opacity) ? opacity : 1) ?? '#00000000', position: isFinite(position) ? Math.max(0, Math.min(1, position)) : 0 };
  });
}

function gradientAttr(g: Element, doc: Document, name: string): string | null {
  let cur: Element | null = g;
  for (let i = 0; i < 5 && cur; i++) {
    const v = cur.getAttribute(name);
    if (v !== null) return v;
    const href = cur.getAttribute('href') ?? cur.getAttribute('xlink:href');
    cur = href ? doc.getElementById(href.replace(/^#/, '')) : null;
  }
  return null;
}

/** Maps an SVG gradient onto a pen gradient fill, in the shape's bounding box. */
function convertGradient(g: Element, doc: Document, bbox: [number, number, number, number], toUser: Matrix, opacity: number): any | null {
  const stops = gradientStops(g, doc);
  if (!stops.length) return null;
  const userSpace = gradientAttr(g, doc, 'gradientUnits') === 'userSpaceOnUse';
  const gt = parseTransform(gradientAttr(g, doc, 'gradientTransform'));
  const [bx, by, bw, bh] = bbox;
  const val = (name: string, d: string) => {
    const v = gradientAttr(g, doc, name) ?? d;
    return v.endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  };
  // Point in gradient space -> final (scaled) user space -> normalized node bbox.
  const norm = (x: number, y: number): [number, number] => {
    let m = gt;
    if (!userSpace) m = mul(m, IDENTITY);
    let px = m[0] * x + m[2] * y + m[4];
    let py = m[1] * x + m[3] * y + m[5];
    if (userSpace) {
      const ux = toUser[0] * px + toUser[2] * py + toUser[4];
      const uy = toUser[1] * px + toUser[3] * py + toUser[5];
      return [(ux - bx) / (bw || 1), (uy - by) / (bh || 1)];
    }
    return [px, py];
  };
  const colors = stops.map(s => ({ ...s, color: opacity < 1 ? (toHexColor(s.color, opacity) ?? s.color) : s.color }));
  if (g.tagName.toLowerCase() === 'lineargradient') {
    const [x1, y1] = norm(val('x1', '0'), val('y1', '0'));
    const [x2, y2] = norm(val('x2', '1'), val('y2', '0'));
    const dx = x2 - x1;
    const dy = y2 - y1;
    // pen: rotation in degrees CCW with 0 = up; direction vector (-sin r, -cos r).
    const rotation = (Math.atan2(-dx, -dy) * 180) / Math.PI;
    return { type: 'gradient', gradientType: 'linear', rotation: Math.round(rotation * 100) / 100, center: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }, size: { height: Math.hypot(dx, dy) || 1 }, colors };
  }
  const [cx, cy] = norm(val('cx', '0.5'), val('cy', '0.5'));
  const r = val('r', '0.5');
  const [ex, ey] = norm(val('cx', '0.5') + r, val('cy', '0.5') + r);
  return { type: 'gradient', gradientType: 'radial', center: { x: cx, y: cy }, size: { width: Math.abs(ex - cx) * 2 || 1, height: Math.abs(ey - cy) * 2 || 1 }, colors };
}

// ---------- conversion ----------

export type SvgImportOptions = { width?: number; height?: number; name?: string };

export type SvgImportResult = { node: PenNode; paths: number; skipped: string[] };

export function svgToNodes(markup: string, opts: SvgImportOptions = {}): SvgImportResult {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const svg = doc.querySelector('svg');
  if (!svg || doc.querySelector('parsererror')) throw new Error('not valid SVG markup (expected an <svg> element)');
  const vb = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  const sw = parseFloat(svg.getAttribute('width') ?? '');
  const sh = parseFloat(svg.getAttribute('height') ?? '');
  const [vx, vy, vw, vh] = vb.length === 4 && vb.every(isFinite) ? vb : [0, 0, isFinite(sw) ? sw : 100, isFinite(sh) ? sh : 100];
  const outW = opts.width ?? (isFinite(sw) ? sw : vw);
  const outH = opts.height ?? (isFinite(sh) ? sh : vh);
  // Fit the viewBox into the target size (preserveAspectRatio xMidYMid meet).
  const s = Math.min(outW / vw, outH / vh);
  const root: Matrix = [s, 0, 0, s, (outW - vw * s) / 2 - vx * s, (outH - vh * s) / 2 - vy * s];
  const rules = parseCssRules(doc);
  const skipped = new Set<string>();
  let paths = 0;
  let counter = 0;
  // Unique temporary ids (replaced with document-unique ids on insert).
  let idc = 0;
  const nextId = () => `svg${++idc}`;

  const walk = (el: Element, parentStyle: Style, parentMatrix: Matrix, parentOpacity: number, depth: number): PenNode[] => {
    if (depth > 40) return [];
    const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
    if (['defs', 'style', 'title', 'desc', 'metadata', 'clippath', 'mask', 'symbol', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'marker'].includes(tag)) return [];
    const own = ownStyle(el, rules);
    const style: Style = {};
    for (const p of INHERITED) if (parentStyle[p] !== undefined) style[p] = parentStyle[p];
    Object.assign(style, own);
    if (style.display === 'none' || style.visibility === 'hidden') return [];
    let matrix = mul(parentMatrix, parseTransform(el.getAttribute('transform')));
    const opacity = parentOpacity * (own.opacity !== undefined ? parseFloat(own.opacity) || 0 : 1);
    if (tag === 'use') {
      const href = el.getAttribute('href') ?? el.getAttribute('xlink:href');
      const target = href ? doc.getElementById(href.replace(/^#/, '')) : null;
      if (!target) return [];
      matrix = mul(matrix, [1, 0, 0, 1, num(el, 'x'), num(el, 'y')]);
      const kids = target.tagName.toLowerCase() === 'symbol' ? [...target.children] : [target];
      return kids.flatMap(k => walk(k, style, matrix, opacity, depth + 1));
    }
    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
      const children = [...el.children].flatMap(c => walk(c, style, matrix, opacity, depth + 1));
      if (tag !== 'g' || children.length < 2) return children;
      return [{ type: 'group', id: nextId(), name: el.getAttribute('id') ?? `Group ${++counter}`, x: 0, y: 0, children }];
    }
    if (tag === 'text' || tag === 'image' || tag === 'foreignobject') {
      skipped.add(tag);
      return [];
    }
    const d0 = elementPath(el);
    if (!d0) {
      if (!['tspan'].includes(tag)) skipped.add(tag);
      return [];
    }
    let d: string;
    try {
      d = svgpath(d0).matrix(matrix).abs().round(3).toString();
    } catch {
      skipped.add(tag);
      return [];
    }
    let bbox: [number, number, number, number];
    try {
      const [x0, y0, x1, y1] = svgPathBbox(d);
      bbox = [x0, y0, x1 - x0, y1 - y0];
    } catch {
      return [];
    }
    const [bx, by, bw, bh] = bbox;
    const node: PenNode = {
      type: 'path',
      id: nextId(),
      name: el.getAttribute('id') ?? `${tag === 'path' ? 'Path' : tag.charAt(0).toUpperCase() + tag.slice(1)} ${++counter}`,
      x: Math.round(bx * 100) / 100,
      y: Math.round(by * 100) / 100,
      width: Math.max(0.01, Math.round(bw * 100) / 100),
      height: Math.max(0.01, Math.round(bh * 100) / 100),
      geometry: svgpath(d).translate(-bx, -by).round(3).toString(),
      viewBox: [0, 0, Math.max(0.01, bw), Math.max(0.01, bh)],
    };
    if (style['fill-rule'] === 'evenodd') node.fillRule = 'evenodd';
    const userBox: [number, number, number, number] = bbox;
    const paint = (value: string | undefined, alpha: number, fallback: string | null) => {
      const v = value ?? fallback;
      if (!v || v === 'none') return undefined;
      const url = v.match(/url\(\s*['"]?#([^'")]+)['"]?\s*\)/);
      if (url) {
        const g = doc.getElementById(url[1]);
        if (g && /gradient$/i.test(g.tagName)) return convertGradient(g, doc, userBox, matrix, alpha) ?? undefined;
        return undefined;
      }
      return toHexColor(v === 'currentColor' ? (style.color ?? '#000') : v, alpha) ?? undefined;
    };
    const fillOpacity = parseFloat(style['fill-opacity'] ?? '1');
    const strokeOpacity = parseFloat(style['stroke-opacity'] ?? '1');
    const isOpen = tag === 'line' || tag === 'polyline';
    const fill = paint(style.fill, isFinite(fillOpacity) ? fillOpacity : 1, isOpen ? null : '#000000');
    if (fill) node.fill = fill;
    const strokeW = parseFloat(style['stroke-width'] ?? '1');
    const stroke = strokeW === 0 ? undefined : paint(style.stroke, isFinite(strokeOpacity) ? strokeOpacity : 1, null);
    if (stroke) {
      node.stroke = stroke;
      // Stroke width scales with the element transform (average scale factor).
      const scale = Math.sqrt(Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]));
      node.strokeWidth = Math.round((parseFloat(style['stroke-width'] ?? '1') || 1) * scale * 100) / 100;
      node.strokeAlignment = 'center';
      if (style['stroke-linecap']) node.strokeLinecap = style['stroke-linecap'];
      if (style['stroke-linejoin'] && ['miter', 'round', 'bevel'].includes(style['stroke-linejoin'])) node.strokeLinejoin = style['stroke-linejoin'];
    }
    if (!node.fill && !node.stroke) return [];
    if (opacity < 0.999) node.opacity = Math.round(opacity * 1000) / 1000;
    paths++;
    return [node];
  };

  const children = [...svg.children].flatMap(c => walk(c, { fill: svg.getAttribute('fill') ?? '#000000' }, root, 1, 0));
  // Group children are positioned relative to the group's origin (0,0 here), so coordinates stay valid.
  const node: PenNode = {
    type: 'frame',
    id: nextId(),
    name: opts.name ?? svg.getAttribute('id') ?? 'Vector',
    width: Math.round(outW * 100) / 100,
    height: Math.round(outH * 100) / 100,
    layout: 'none',
    children,
  };
  return { node, paths, skipped: [...skipped] };
}

/** True when a string looks like SVG markup. */
export function looksLikeSvg(text: string) {
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text);
}

