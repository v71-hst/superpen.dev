// Design to HTML/CSS: writes any layer of the current design as a self-contained HTML fragment with inline styles.
// Boxes come from the layout engine (src/layout/layout.ts), not from rendered elements: every node is absolutely
// positioned in its parent's coordinates (its local matrix), so auto layout and hug sizes come out exactly as the
// canvas draws them without flexbox. Paint follows what the old DOM renderer (NodeView) put in its inline styles.
//
// Not exportable as HTML: shader fills and shader effects (GLSL needs a canvas). A node is written with its other
// fills, as if the shader fills and effects were not there.
import svgpath from 'svgpath';
import { useStore } from '../editor/store';
import { currentTree } from '../editor/tree';
import { makeUrlResolver } from '../editor/fileio';
import { rootLayout, rootOf } from '../skia/layoutIndex';
import { resolvedProps, type LayoutNode, type Mat } from '../layout/layout';
import { iconPaths } from '../skia/icons';
import { colorCss, effectList, fillList, fillsToBackground, imageTransform, isEnabled, linearEndpoints, normalizeStroke, primaryColor, type StrokeInfo, type UrlResolver } from '../render/paint';
import { ellipseGeometry, pathGeometry, polygonGeometry } from '../render/geometry';
import { weightNum } from '../render/fonts';
import { meshDataUrl } from '../render/mesh';

type Style = Record<string, string | number | undefined | null>;

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

const UNITLESS = new Set(['opacity', 'zIndex', 'lineHeight', 'fontWeight', 'flex', 'flexGrow', 'flexShrink']);

function css(st: Style): string {
  const out: string[] = [];
  for (const [k, v] of Object.entries(st)) {
    if (v === undefined || v === null || v === '') continue;
    const name = k.startsWith('Webkit') ? '-webkit-' + kebab(k.slice(6)) : kebab(k);
    out.push(`${name}:${typeof v === 'number' && !UNITLESS.has(k) ? `${r3(v)}px` : typeof v === 'number' ? r3(v) : v}`);
  }
  return out.join(';');
}

const kebab = (s: string) => s.replace(/^[A-Z]/, c => c.toLowerCase()).replace(/[A-Z]/g, c => '-' + c.toLowerCase());
const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => escText(s).replace(/"/g, '&quot;');
const div = (st: Style, inner = '', attrs = '') => `<div${attrs} style="${escAttr(css(st))}">${inner}</div>`;

type Ctx = {
  doc: any;
  resolveUrl: UrlResolver;
  /** Unique prefix for SVG ids, so two exports pasted into one page don't share gradients. */
  uid: string;
  next: number;
  fonts: Set<string>;
  iconFonts: Set<string>;
};

let exportCount = 0;

function cornerRadius(v: any): string | undefined {
  if (Array.isArray(v)) return v.map(x => `${num(x)}px`).join(' ');
  const r = num(v);
  return r ? `${r}px` : undefined;
}

function radiusArray(v: any): number[] {
  if (Array.isArray(v)) return v.map(x => num(x));
  const r = num(v);
  return [r, r, r, r];
}

/** Position and transform from the node's matrix in its parent (layout engine), plus opacity / mask. */
function boxStyle(ln: LayoutNode, p: any, root: boolean): Style {
  const [a, b, c, d, e, f] = ln.local;
  const st: Style = { boxSizing: 'border-box', position: root ? 'relative' : 'absolute', left: root ? 0 : e, top: root ? 0 : f, width: ln.w, height: ln.h };
  const isIdentity = a === 1 && b === 0 && c === 0 && d === 1;
  if (!isIdentity) {
    // A pure rotation keeps rotate(); flips (with or without a rotation) need the whole matrix.
    const rot = Math.abs(a - d) < 1e-9 && Math.abs(b + c) < 1e-9 && Math.abs(a * a + b * b - 1) < 1e-9;
    st.transform = rot ? `rotate(${r3((Math.atan2(b, a) * 180) / Math.PI)}deg)` : `matrix(${[a, b, c, d].map(r3).join(', ')}, 0, 0)`;
    st.transformOrigin = '0 0';
  }
  if (p.opacity !== undefined && p.opacity !== 1) st.opacity = num(p.opacity, 1);
  // A mask is a shape, not a picture: it paints nothing.
  if (p.mask === true) st.opacity = 0;
  return st;
}

function shadowCss(effects: any[], kind: 'box' | 'text' | 'filter'): Style {
  const out: Style = {};
  const shadows: string[] = [];
  const filters: string[] = [];
  for (const e of effects) {
    if (e.type === 'shadow') {
      const inner = e.shadowType === 'inner';
      const x = num(e.offset?.x);
      const y = num(e.offset?.y);
      const b = num(e.blur);
      const s = num(e.spread);
      const c = colorCss(e.color ?? '#00000040');
      if (kind === 'box') shadows.push(`${inner ? 'inset ' : ''}${x}px ${y}px ${b}px ${s}px ${c}`);
      else if (kind === 'text' && !inner) shadows.push(`${x}px ${y}px ${b}px ${c}`);
      else if (kind === 'filter' && !inner) filters.push(`drop-shadow(${x}px ${y}px ${b / 2}px ${c})`);
    } else if (e.type === 'blur') {
      filters.push(`blur(${num(e.radius) / 2}px)`);
    } else if (e.type === 'background_blur') {
      out.backdropFilter = `blur(${num(e.radius) / 2}px)`;
      out.WebkitBackdropFilter = out.backdropFilter;
    }
    // Shader effects are left out (see the note at the top).
  }
  if (shadows.length) {
    if (kind === 'box') out.boxShadow = shadows.join(', ');
    else out.textShadow = shadows.join(', ');
  }
  if (filters.length) out.filter = filters.join(' ');
  return out;
}

const isShaderFill = (f: any) => f && typeof f === 'object' && f.type === 'shader';
const isCroppedImage = (f: any) => f && typeof f === 'object' && f.type === 'image' && f.enabled !== false && f.url && !!imageTransform(f);

/** Strokes for box-like nodes: CSS outline when possible, else a masked overlay element. */
function boxStroke(stroke: StrokeInfo | null, resolveUrl: UrlResolver, radius: string | undefined, w: number, h: number): { style: Style; overlay: string } {
  if (!stroke) return { style: {}, overlay: '' };
  const solid = stroke.fills.length === 1 && (typeof stroke.fills[0] === 'string' || stroke.fills[0].type === 'color');
  if (typeof stroke.width === 'number' && solid) {
    const sw = stroke.width;
    const offset = stroke.align === 'inner' ? -sw : stroke.align === 'center' ? -sw / 2 : 0;
    const f = stroke.fills[0];
    return { style: { outline: `${sw}px solid ${colorCss(typeof f === 'string' ? f : f.color)}`, outlineOffset: offset }, overlay: '' };
  }
  const widths = typeof stroke.width === 'number' ? { top: stroke.width, right: stroke.width, bottom: stroke.width, left: stroke.width } : stroke.width;
  const grow = (side: number) => (stroke.align === 'outer' ? side : stroke.align === 'center' ? side / 2 : 0);
  const bg = fillsToBackground(stroke.fills.filter(f => !isShaderFill(f)), w, h, resolveUrl) as Style;
  const mask = 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)';
  const style: Style = {
    position: 'absolute',
    top: -grow(widths.top),
    right: -grow(widths.right),
    bottom: -grow(widths.bottom),
    left: -grow(widths.left),
    padding: `${widths.top}px ${widths.right}px ${widths.bottom}px ${widths.left}px`,
    borderRadius: radius,
    pointerEvents: 'none',
    boxSizing: 'border-box',
    WebkitMask: mask,
    mask,
    ...bg,
  };
  return { style: {}, overlay: div(style) };
}

/** CSS for an image fill's crop matrix on a layer the size of the box (translation in %, so it needs no box size). */
function cropCss(t: [number, number, number, number, number, number], w: number, h: number): string {
  const [a, b, c, d, tx, ty] = t;
  return `translate(${tx * 100}%, ${ty * 100}%) matrix(${a}, ${(b * h) / (w || 1)}, ${(c * w) / (h || 1)}, ${d}, 0, 0)`;
}

/**
 * Background of a box: plain fills become CSS backgrounds on the element; a cropped picture needs a clipped layer of
 * its own, and so does every fill after it (stacked in order). Shader fills are dropped.
 */
function boxFills(fills: any[], w: number, h: number, radius: string | undefined, resolveUrl: UrlResolver): { style: Style; layers: string } {
  fills = fills.filter(f => !isShaderFill(f));
  let i = fills.findIndex(isCroppedImage);
  const style = fillsToBackground(i >= 0 ? fills.slice(0, i) : fills, w, h, resolveUrl) as Style;
  let layers = '';
  while (i >= 0 && i < fills.length) {
    const f = fills[i];
    const t = imageTransform(f)!;
    const inner = div({ position: 'absolute', inset: 0, transformOrigin: '0 0', transform: cropCss(t, w, h), ...(fillsToBackground([{ ...f, transform: undefined, blendMode: undefined }], w * Math.max(1, Math.abs(t[0])), h * Math.max(1, Math.abs(t[3])), resolveUrl) as Style) });
    layers += div({ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: radius, pointerEvents: 'none', mixBlendMode: f.blendMode && f.blendMode !== 'normal' ? f.blendMode : undefined }, inner);
    let j = i + 1;
    while (j < fills.length && !isCroppedImage(fills[j])) j++;
    const group = fills.slice(i + 1, j);
    if (group.length) layers += div({ position: 'absolute', inset: 0, borderRadius: radius, pointerEvents: 'none', ...(fillsToBackground(group, w, h, resolveUrl) as Style) });
    i = j;
  }
  return { style, layers };
}

// ---------- children and masks ----------

/** The outline of a mask layer in its parent's coordinates (its matrix from the layout), as CSS clip-path. */
function maskClip(ctx: Ctx, m: LayoutNode): string | null {
  const p = resolvedProps(m.node, ctx.doc);
  const { w, h } = m;
  let d: string;
  let evenodd = false;
  if (m.node.type === 'ellipse') {
    d = ellipseGeometry(w, h, num(p.innerRadius), num(p.startAngle), p.sweepAngle === undefined ? 360 : num(p.sweepAngle, 360));
    evenodd = num(p.innerRadius) > 0;
  } else if (m.node.type === 'polygon') d = polygonGeometry(w, h, num(p.polygonCount, 3), num(p.cornerRadius));
  else if (m.node.type === 'path') {
    d = pathGeometry(typeof p.geometry === 'string' ? p.geometry : '', w, h, p.viewBox);
    evenodd = p.fillRule === 'evenodd';
  } else {
    const r = radiusArray(p.cornerRadius).map(v => Math.min(v, w / 2, h / 2));
    d = `M${r[0]} 0H${w - r[1]}A${r[1]} ${r[1]} 0 0 1 ${w} ${r[1]}V${h - r[2]}A${r[2]} ${r[2]} 0 0 1 ${w - r[2]} ${h}H${r[3]}A${r[3]} ${r[3]} 0 0 1 0 ${h - r[3]}V${r[0]}A${r[0]} ${r[0]} 0 0 1 ${r[0]} 0Z`;
  }
  if (!d) return null;
  return `path(${evenodd ? 'evenodd, ' : ''}'${svgpath(d).matrix(m.local).round(2).toString()}')`;
}

/** Children in paint order; a mask (Superpencil's `mask: true`) clips the siblings after it where children are placed freely. */
function children(ctx: Ctx, ln: LayoutNode, free: boolean): string {
  const kids = ln.children;
  const from = (i: number): string => {
    let out = '';
    for (; i < kids.length; i++) {
      const c = kids[i];
      out += nodeHtml(ctx, c, false);
      const clip = free && c.node.props.mask === true ? maskClip(ctx, c) : null;
      if (clip) return out + div({ position: 'absolute', left: 0, top: 0, width: ln.w, height: ln.h, clipPath: clip }, from(i + 1));
    }
    return out;
  };
  return from(0);
}

// ---------- node types ----------

function nodeHtml(ctx: Ctx, ln: LayoutNode, root: boolean): string {
  const n = ln.node;
  const p = resolvedProps(n, ctx.doc);
  if (p.enabled === false) return '';
  switch (n.type) {
    case 'frame':
    case 'rectangle':
      return boxHtml(ctx, ln, p, root);
    case 'group':
      return div({ ...boxStyle(ln, p, root), ...shadowCss(effectList(p.effect), 'filter') }, children(ctx, ln, true));
    case 'text':
      return textHtml(ctx, ln, p, root);
    case 'ellipse':
    case 'polygon':
    case 'path':
    case 'line':
      return shapeHtml(ctx, ln, p, root);
    case 'icon':
    case 'icon_font':
      return iconHtml(ctx, ln, p, root);
    case 'note':
    case 'prompt':
    case 'context':
      return noteHtml(ctx, ln, p, root);
    case 'browser':
      return browserHtml(ln, p, root);
    case 'script':
      // The script's output (generated layers); its error/pending placeholder is editor UI and is left out.
      return div({ ...boxStyle(ln, p, root), overflow: p.clip === true ? 'hidden' : undefined }, children(ctx, ln, true));
    default: {
      const label = n.type === 'missing_ref' ? 'Missing component' : n.type;
      return div({ ...boxStyle(ln, p, root), border: '1px dashed #a1a1aa', display: 'grid', placeItems: 'center', color: '#a1a1aa', font: '11px system-ui', overflow: 'hidden' }, escText(label) + children(ctx, ln, true));
    }
  }
}

function boxHtml(ctx: Ctx, ln: LayoutNode, p: any, root: boolean): string {
  const isFrame = ln.node.type === 'frame';
  const { w, h } = ln;
  const radius = cornerRadius(p.cornerRadius);
  const stroke = boxStroke(normalizeStroke(p, 'inner'), ctx.resolveUrl, radius, w, h);
  const fills = boxFills(fillList(p.fill), w, h, radius, ctx.resolveUrl);
  const style: Style = { ...boxStyle(ln, p, root), ...fills.style, ...shadowCss(effectList(p.effect), 'box'), ...stroke.style, borderRadius: radius };
  if (p.clip === true) style.overflow = 'hidden';
  // Masks clip their later siblings only where children are placed freely (no auto layout), as on the canvas.
  return div(style, fills.layers + (isFrame ? children(ctx, ln, p.layout === 'none') : '') + stroke.overlay);
}

function fontStack(ff: any) {
  const fam = typeof ff === 'string' && ff ? ff : 'Inter';
  return `"${fam}", "Inter", system-ui, sans-serif`;
}

const SYSTEM_FONTS = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'arial', 'helvetica', 'times new roman', 'segoe ui', 'georgia', 'courier new', 'verdana']);

function useFont(ctx: Ctx, family: any, weight: any, italic: boolean) {
  if (!family || typeof family !== 'string' || family.startsWith('$') || SYSTEM_FONTS.has(family.toLowerCase())) return;
  const fam = family.trim().replace(/ /g, '+');
  const w = weightNum(weight);
  // One stylesheet per family/weight/style, as the editor loads them: a combined request fails whole when a family
  // lacks one of the weights.
  ctx.fonts.add(`https://fonts.googleapis.com/css2?family=${fam}:${italic ? 'ital,' : ''}wght@${italic ? '1,' : ''}${w}&display=swap`);
}

const WRAP_SLACK = 1;

function textHtml(ctx: Ctx, ln: LayoutNode, p: any, root: boolean): string {
  const growth = p.textGrowth ?? 'auto';
  const autoW = growth === 'auto';
  const family = typeof p.fontFamily === 'string' ? p.fontFamily : 'Inter';
  useFont(ctx, family, p.fontWeight, p.fontStyle === 'italic');
  const fills = fillList(p.fill ?? '#000000').filter(isEnabled).filter(f => !isShaderFill(f));
  const gradient = fills.some(f => typeof f === 'object' && f.type !== 'color');
  const fontSize = num(p.fontSize, 14);
  const style: Style = {
    ...boxStyle(ln, p, root),
    display: 'flex',
    flexDirection: 'column',
    justifyContent: p.textAlignVertical === 'middle' ? 'center' : p.textAlignVertical === 'bottom' ? 'flex-end' : 'flex-start',
    fontFamily: fontStack(family),
    fontSize,
    fontWeight: weightNum(p.fontWeight),
    fontStyle: p.fontStyle === 'italic' ? 'italic' : undefined,
    letterSpacing: p.letterSpacing !== undefined ? `${num(p.letterSpacing)}px` : undefined,
    lineHeight: typeof p.lineHeight === 'number' && p.lineHeight > 0 ? p.lineHeight : 'normal',
    textAlign: p.textAlign ?? 'left',
    whiteSpace: autoW ? 'pre' : 'pre-wrap',
    overflowWrap: 'break-word',
    textDecoration: [p.underline === true ? 'underline' : '', p.strikethrough === true ? 'line-through' : ''].join(' ').trim() || undefined,
    ...shadowCss(effectList(p.effect), 'text'),
  };
  // Wrapping text: the layout engine measures with its own font engine, and a word the browser finds a fraction of a
  // pixel wider would wrap (or break) differently. One spare pixel, placed so the alignment doesn't move.
  if (!autoW && typeof style.width === 'number') {
    const align = p.textAlign ?? 'left';
    const k = align === 'center' ? 0.5 : align === 'right' ? 1 : 0;
    style.width += WRAP_SLACK;
    if (k && typeof style.left === 'number' && !root) style.left -= WRAP_SLACK * k;
  }
  const content = escText(typeof p.content === 'string' ? p.content : p.content === undefined ? '' : String(p.content)) || '​';
  if (gradient) {
    const inner: Style = { ...(fillsToBackground(fills, ln.w || 100, ln.h || fontSize, ctx.resolveUrl) as Style), WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent' };
    return div(style, `<span style="${escAttr(css(inner))}">${content}</span>`);
  }
  style.color = primaryColor(fills) ?? 'transparent';
  return div(style, content);
}

const attr = (name: string, v: string | number | undefined) => (v === undefined || v === '' ? '' : ` ${name}="${escAttr(String(typeof v === 'number' ? r3(v) : v))}"`);

/** An SVG paint server (<defs> entry) for a fill that isn't a flat color, or ''. */
function svgPaint(ctx: Ctx, id: string, fill: any, w: number, h: number): string {
  if (typeof fill === 'string' || fill.type === 'color') return '';
  const op = num(fill.opacity, 1);
  const stops = (fill.colors ?? [])
    .slice()
    .sort((a: any, b: any) => num(a.position) - num(b.position))
    .map((s: any) => `<stop${attr('offset', num(s.position))}${attr('stop-color', colorCss(s.color, op))}/>`)
    .join('');
  if (fill.type === 'gradient') {
    const t = fill.gradientType ?? 'linear';
    if (t === 'linear') {
      const e = linearEndpoints(fill);
      return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse"${attr('x1', e.x1)}${attr('y1', e.y1)}${attr('x2', e.x2)}${attr('y2', e.y2)} gradientTransform="matrix(${r3(w)} 0 0 ${r3(h)} 0 0)">${stops}</linearGradient>`;
    }
    const cx = num(fill.center?.x, 0.5);
    const cy = num(fill.center?.y, 0.5);
    const sw = num(fill.size?.width, 1) / 2;
    const sh = num(fill.size?.height, 1) / 2;
    return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="matrix(${r3(w)} 0 0 ${r3(h)} 0 0) translate(${cx} ${cy}) rotate(${-num(fill.rotation)}) scale(${sw} ${sh})">${stops}</radialGradient>`;
  }
  if (fill.type === 'mesh_gradient') {
    const cols = (fill.colors ?? []).map((c: any) => colorCss(c));
    return cols.length ? `<pattern id="${id}" patternUnits="userSpaceOnUse"${attr('width', w)}${attr('height', h)}><image${attr('href', meshDataUrl(fill, cols))}${attr('width', w)}${attr('height', h)} preserveAspectRatio="none"/></pattern>` : '';
  }
  if (fill.type === 'image' && fill.url) {
    const mode = fill.mode ?? 'cover';
    const t = imageTransform(fill);
    const href = ctx.resolveUrl(fill.url, { w: w * Math.max(1, Math.abs(t?.[0] ?? 1)), h: h * Math.max(1, Math.abs(t?.[3] ?? 1)), mode });
    const tr = t ? `matrix(${t[0]} ${(t[1] * h) / (w || 1)} ${(t[2] * w) / (h || 1)} ${t[3]} ${t[4] * w} ${t[5] * h})` : undefined;
    const par = mode === 'stretch' ? 'none' : mode === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice';
    return `<pattern id="${id}" patternUnits="userSpaceOnUse"${attr('width', w)}${attr('height', h)}><image${attr('href', href)}${attr('width', w)}${attr('height', h)}${attr('opacity', op === 1 ? undefined : op)}${attr('transform', tr)}${attr('preserveAspectRatio', par)}/></pattern>`;
  }
  return '';
}

function paintRef(fill: any, id: string): string {
  if (typeof fill === 'string') return colorCss(fill);
  if (fill.type === 'color') return colorCss(fill.color);
  if (fill.type === 'gradient' && fill.gradientType === 'angular') return colorCss(fill.colors?.[0]?.color);
  if (fill.type === 'gradient' || fill.type === 'image') return `url(#${id})`;
  if (fill.type === 'mesh_gradient') return fill.colors?.length ? `url(#${id})` : 'none';
  return 'none';
}

function shapeHtml(ctx: Ctx, ln: LayoutNode, p: any, root: boolean): string {
  const type = ln.node.type;
  const { w, h } = ln;
  const uid = `${ctx.uid}-${ctx.next++}`;
  const open = type === 'line' || type === 'path';
  let d = '';
  if (type === 'ellipse') d = ellipseGeometry(w, h, num(p.innerRadius), num(p.startAngle), p.sweepAngle === undefined ? 360 : num(p.sweepAngle, 360));
  else if (type === 'polygon') d = polygonGeometry(w, h, num(p.polygonCount, 3), num(p.cornerRadius));
  else if (type === 'path') d = pathGeometry(typeof p.geometry === 'string' ? p.geometry : '', w, h, p.viewBox);
  else if (type === 'line') d = `M0 0L${r3(w)} ${r3(h)}`;
  const allFills = type === 'line' ? [] : fillList(p.fill).filter(isEnabled).filter(f => !isShaderFill(f));
  const isAngular = (f: any) => f && typeof f === 'object' && f.type === 'gradient' && f.gradientType === 'angular';
  const fills = allFills.filter(f => !isAngular(f));
  const stroke = normalizeStroke(p, open ? 'center' : type === 'ellipse' ? 'center' : 'inner');
  const strokeFills = (stroke?.fills ?? []).filter(f => !isShaderFill(f));
  const fillRule = p.fillRule === 'evenodd' || (type === 'ellipse' && num(p.innerRadius) > 0) ? 'evenodd' : 'nonzero';
  const sw = stroke ? (typeof stroke.width === 'number' ? stroke.width : Math.max(stroke.width.top, stroke.width.left)) : 0;
  const align = open ? 'center' : stroke?.align;
  let defs = '';
  fills.forEach((f, i) => (defs += svgPaint(ctx, `${uid}f${i}`, f, w, h)));
  strokeFills.forEach((f, i) => (defs += svgPaint(ctx, `${uid}s${i}`, f, w, h)));
  if (align === 'inner') defs += `<clipPath id="${uid}c"><path${attr('d', d)}${attr('clip-rule', fillRule)}/></clipPath>`;
  if (align === 'outer') {
    const box = `${attr('x', -sw * 2 - w)}${attr('y', -sw * 2 - h)}${attr('width', w * 3 + sw * 4)}${attr('height', h * 3 + sw * 4)}`;
    defs += `<mask id="${uid}m" maskUnits="userSpaceOnUse"${box}><rect${box} fill="white"/><path${attr('d', d)} fill="black"${attr('fill-rule', fillRule)}/></mask>`;
  }
  let body = '';
  for (const [i, f] of fills.entries()) body += `<path${attr('d', d)}${attr('fill', paintRef(f, `${uid}f${i}`))}${attr('fill-rule', fillRule)}${f?.blendMode ? attr('style', `mix-blend-mode:${f.blendMode}`) : ''}/>`;
  for (const [i, f] of strokeFills.entries()) {
    body +=
      `<path${attr('d', d)} fill="none"${attr('stroke', paintRef(f, `${uid}s${i}`))}${attr('stroke-width', align === 'center' ? sw : sw * 2)}` +
      `${attr('stroke-linecap', stroke?.cap ?? 'butt')}${attr('stroke-linejoin', stroke?.join ?? 'miter')}` +
      `${align === 'inner' ? attr('clip-path', `url(#${uid}c)`) : ''}${align === 'outer' ? attr('mask', `url(#${uid}m)`) : ''}/>`;
  }
  // An <svg> with zero width or height paints nothing, even with overflow visible: straight paths get 1px minimums.
  const svgStyle = css({ position: 'absolute', inset: 0, overflow: 'visible', display: 'block', minWidth: 1, minHeight: 1 });
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="${svgStyle}">${defs ? `<defs>${defs}</defs>` : ''}${body}</svg>`;
  // SVG has no conic gradients: angular fills are a CSS conic-gradient clipped to the shape.
  for (const f of allFills) {
    if (isAngular(f) && d) out += div({ position: 'absolute', inset: 0, pointerEvents: 'none', clipPath: `path(${fillRule === 'evenodd' ? 'evenodd, ' : ''}'${d}')`, ...(fillsToBackground([f], w, h, ctx.resolveUrl) as Style) });
  }
  return div({ ...boxStyle(ln, p, root), ...shadowCss(effectList(p.effect), 'filter') }, out);
}

const missingGlyph = (size: number) => div({ width: size, height: size, border: '1px dashed #f43f5e', boxSizing: 'border-box' });

function iconHtml(ctx: Ctx, ln: LayoutNode, p: any, root: boolean): string {
  const library = String(p.library ?? p.iconFontFamily ?? 'lucide');
  const name = String(p.icon ?? p.iconFontName ?? '');
  const lib = library.toLowerCase();
  const size = Math.min(ln.w, ln.h);
  const color = primaryColor(fillList(p.fill).filter(isEnabled)) ?? '#000000';
  const weight = num(p.weight, 0);
  let glyph: string;
  if (lib === 'lucide' || lib === 'feather') {
    const paths = iconPaths(library, name);
    glyph = paths
      ? `<svg xmlns="http://www.w3.org/2000/svg"${attr('width', size)}${attr('height', size)} viewBox="0 0 24 24" fill="none"${attr('stroke', color)}${attr('stroke-width', weight ? weight / 200 : 2)} stroke-linecap="round" stroke-linejoin="round">${paths.map(d => `<path${attr('d', d)}/>`).join('')}</svg>`
      : missingGlyph(size);
  } else if (lib.startsWith('material symbols')) {
    ctx.iconFonts.add(`https://fonts.googleapis.com/css2?family=${library.trim().replace(/ /g, '+')}:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block`);
    glyph = `<span style="${escAttr(css({ fontFamily: `'${library}'`, fontSize: size, lineHeight: 1, color, fontVariationSettings: `'wght' ${weight || 400}`, fontFeatureSettings: "'liga'", userSelect: 'none' }))}">${escText(name)}</span>`;
  } else if (lib === 'phosphor') {
    ctx.iconFonts.add('https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css');
    ctx.iconFonts.add('https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css');
    glyph = `<i class="ph ph-${escAttr(name)}" style="${escAttr(css({ fontSize: size, color, lineHeight: 1 }))}"></i>`;
  } else glyph = missingGlyph(size);
  return div({ ...boxStyle(ln, p, root), display: 'flex', alignItems: 'center', justifyContent: 'center', ...shadowCss(effectList(p.effect), 'filter') }, glyph);
}

const NOTE_STYLES: Record<string, Style> = {
  note: { background: '#FDF6C3', color: '#3f3a1a' },
  prompt: { background: '#EDE9FE', color: '#2e1065' },
  context: { background: '#E0F2FE', color: '#0c4a6e' },
};

function noteHtml(ctx: Ctx, ln: LayoutNode, p: any, root: boolean): string {
  const type = ln.node.type;
  if (p.fontFamily) useFont(ctx, p.fontFamily, p.fontWeight, false);
  else useFont(ctx, 'Inter', 400, false);
  const head = type !== 'note' ? div({ fontSize: 11, fontWeight: 600, opacity: 0.6, marginBottom: 6, textTransform: 'uppercase' }, escText(`${type}${p.model ? ` · ${p.model}` : ''}`)) : '';
  return div(
    {
      ...boxStyle(ln, p, root),
      ...NOTE_STYLES[type],
      borderRadius: 4,
      padding: 16,
      fontFamily: fontStack(p.fontFamily),
      fontSize: num(p.fontSize, 14),
      lineHeight: 1.45,
      whiteSpace: 'pre-wrap',
      overflow: 'hidden',
      boxShadow: '0 1px 2px rgba(0,0,0,.12), 0 4px 12px rgba(0,0,0,.08)',
    },
    head + escText(typeof p.content === 'string' ? p.content : ''),
  );
}

function browserHtml(ln: LayoutNode, p: any, root: boolean): string {
  const inner = p.url
    ? `<iframe${attr('src', String(p.url))}${attr('title', String(ln.node.props.name ?? 'browser'))} style="border:0;width:100%;height:100%"></iframe>`
    : div({ display: 'grid', placeItems: 'center', height: '100%', color: '#71717a', font: '14px system-ui' }, 'No URL');
  return div({ ...boxStyle(ln, p, root), borderRadius: cornerRadius(p.cornerRadius), overflow: 'hidden', background: '#fff' }, inner);
}

// ---------- entry points ----------

function exportNode(key: string): { html: string; ctx: Ctx; name: string } {
  const s = useStore.getState();
  const tree = currentTree();
  if (!s.doc || !tree?.byKey.has(key)) throw new Error(`no layer "${key}" in the current design`);
  const r = rootOf(key);
  const ln = r ? rootLayout(r)?.get(key) : null;
  if (!ln) throw new Error(`layer "${key}" has no layout (it may be hidden: enabled false)`);
  const ctx: Ctx = { doc: s.doc, resolveUrl: makeUrlResolver(s.file?.path ?? null), uid: `pen${++exportCount}`, next: 0, fonts: new Set(), iconFonts: new Set() };
  const html = nodeHtml(ctx, ln, true);
  const name = String(ln.node.props.name ?? ln.node.type);
  return { html, ctx, name };
}

/**
 * The layer `key` of the current design as one root <div> with inline styles and its children nested inside,
 * positioned at 0,0 of wherever it is pasted (position: relative). Fonts are not included: see nodeToHtmlDocument.
 */
export function nodeToHtml(key: string): string {
  return exportNode(key).html;
}

/** A complete HTML page showing the layer `key`, with stylesheet links for the Google Fonts and icon fonts it uses. */
export function nodeToHtmlDocument(key: string): string {
  const { html, ctx, name } = exportNode(key);
  const links = [...ctx.fonts, ...ctx.iconFonts].map(href => `<link rel="stylesheet" href="${escAttr(href)}">`).join('\n');
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${escText(name)}</title>\n${links}\n</head>\n<body style="margin:0">\n${html}\n</body>\n</html>\n`;
}
