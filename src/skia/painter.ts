// Stage 3 painter (docs/SKIA_REWORK.md): laid-out nodes + resolved props -> Skia draw calls, recorded as one
// SkPicture per top-level frame. Every rule mirrors the DOM renderer (NodeView.tsx / paint.ts) so the two look the
// same: last fill on top, CSS box-shadow and outline geometry, sigma = blur / 2, premultiplied gradient
// interpolation, text via Skia paragraphs. Anything it can't match yet makes skiaEligible() name a reason, and that
// frame stays on the DOM renderer.
import type { Canvas, CanvasKit, Paint, Paragraph, Path, SkPicture, Shader } from 'canvaskit-wasm';
import type { PenDoc, RNode } from '../model/types';
import { resolveProps } from '../render/NodeView';
import { effectList, fillList, isEnabled, linearEndpoints, normalizeStroke, parseColor, primaryColor, type StrokeInfo } from '../render/paint';
import { ellipseGeometry, pathGeometry, polygonGeometry } from '../render/geometry';
import { weightNum } from '../render/fonts';
import { scriptState } from '../editor/scriptHost';
import { Scope, free, own } from './lifetime';
import { familyList, fontBlocker, fontEpoch, fontProvider } from './fonts';
import { getImage } from './images';
import { iconLibrarySupported, iconPaths } from './icons';

export type Mat = [number, number, number, number, number, number];

/** What the painter needs from the layout tree (src/layout/layout.ts LayoutNode satisfies it). */
export type PaintNode = { key: string; node: RNode; w: number; h: number; world: Mat; children: PaintNode[] };

export type PaintContext = {
  ck: CanvasKit;
  doc: Pick<PenDoc, 'variables'>;
  /** Same resolver the DOM renderer uses for asset URLs (image fills). */
  resolveUrl: (u: string) => string;
};

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

// ---------- matrices ----------

function invert(m: Mat): Mat {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c || 1e-12;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}
const skMat = (m: Mat) => [m[0], m[2], m[4], m[1], m[3], m[5], 0, 0, 1];

// ---------- props ----------

const propCache = new WeakMap<RNode, { vars: any; p: any }>();
export function propsOf(ctx: Pick<PaintContext, 'doc'>, n: RNode): any {
  const hit = propCache.get(n);
  if (hit && hit.vars === ctx.doc.variables) return hit.p;
  const p = resolveProps(ctx.doc, n.props, n.theme);
  propCache.set(n, { vars: ctx.doc.variables, p });
  return p;
}

// ---------- eligibility ----------

const isShaderFill = (f: any) => f && typeof f === 'object' && f.type === 'shader' && f.enabled !== false && f.url;

/** null if Skia can draw this whole subtree now, else the first reason it can't (that frame stays DOM). */
export function skiaEligible(ctx: PaintContext, n: RNode, editingKey?: string | null): string | null {
  const p = propsOf(ctx, n);
  if (p.enabled === false) return null;
  if (n.key === editingKey) return 'text being edited';
  if (fillList(p.fill).some(isShaderFill)) return `shader fill on ${n.key}`;
  if (effectList(p.effect).some((e: any) => e.type === 'shader')) return `shader effect on ${n.key}`;
  switch (n.type) {
    case 'frame':
    case 'rectangle':
    case 'group':
    case 'ellipse':
    case 'polygon':
    case 'path':
    case 'line':
      break;
    case 'text':
    case 'note':
    case 'prompt':
    case 'context': {
      const why = fontBlocker(typeof p.fontFamily === 'string' && p.fontFamily ? p.fontFamily : 'Inter', p.fontWeight, p.fontStyle === 'italic');
      if (why) return why;
      break;
    }
    case 'icon':
    case 'icon_font':
      if (!iconLibrarySupported(String(p.library ?? p.iconFontFamily ?? 'lucide'))) return `icon font "${p.library ?? p.iconFontFamily}"`;
      break;
    case 'script': {
      const st = scriptState(n.props, n.theme, n.key);
      if (!st || st.status !== 'ok') return `script ${st ? st.status : 'without a file'}`;
      break;
    }
    default:
      return `${n.type} node`;
  }
  for (const f of [...fillList(p.fill), ...(normalizeStroke(p, 'inner')?.fills ?? [])]) {
    if (f && typeof f === 'object' && f.type === 'image' && f.url && f.enabled !== false) {
      const st = getImage(ctx.ck, ctx.resolveUrl(f.url)).status;
      if (st === 'loading') return 'pictures loading';
    }
  }
  for (const c of n.children) {
    const why = skiaEligible(ctx, c, editingKey);
    if (why) return why;
  }
  return null;
}

// ---------- paint helpers ----------

function color(ck: CanvasKit, c: any, alphaMul = 1): Float32Array {
  const rgba = parseColor(typeof c === 'string' ? c : '');
  if (rgba) return ck.Color(rgba.r, rgba.g, rgba.b, rgba.a * alphaMul);
  if (typeof c === 'string' && c) {
    try {
      const v = ck.parseColorString(c);
      v[3] *= alphaMul;
      return v;
    } catch {
      // fall through
    }
  }
  return ck.TRANSPARENT;
}

function stops(ck: CanvasKit, f: any) {
  const op = num(f.opacity, 1);
  const list = (f.colors ?? []).slice().sort((a: any, b: any) => num(a.position) - num(b.position));
  if (!list.length) return null;
  if (list.length === 1) list.push(list[0]);
  return { colors: list.map((s: any) => color(ck, s.color, op)), pos: list.map((s: any) => Math.max(0, Math.min(1, num(s.position)))) };
}

const PREMUL = 1; // kInterpolateColorsInPremul: browsers interpolate gradients premultiplied

const BLEND: Record<string, string> = {
  multiply: 'Multiply', screen: 'Screen', overlay: 'Overlay', darken: 'Darken', lighten: 'Lighten', light: 'Lighten',
  colorDodge: 'ColorDodge', linearDodge: 'ColorDodge', colorBurn: 'ColorBurn', linearBurn: 'ColorBurn', hardLight: 'HardLight',
  softLight: 'SoftLight', difference: 'Difference', exclusion: 'Exclusion', hue: 'Hue', saturation: 'Saturation', color: 'Color', luminosity: 'Luminosity',
};

/**
 * Shader for a gradient fill over a w×h box. `svg`: shapes use SVG gradient rules (radial honours rotation), boxes
 * use the CSS ones (radial ignores rotation), as the DOM renderer does.
 */
function gradientShader(ck: CanvasKit, f: any, x: number, y: number, w: number, h: number, svg: boolean): Shader | null {
  const s = stops(ck, f);
  if (!s) return null;
  const t = f.gradientType ?? 'linear';
  const W = w || 1, H = h || 1;
  if (t === 'linear') {
    const e = linearEndpoints(f);
    return ck.Shader.MakeLinearGradient([e.x1, e.y1], [e.x2, e.y2], s.colors, s.pos, ck.TileMode.Clamp, [W, 0, x, 0, H, y, 0, 0, 1], PREMUL);
  }
  const cx = num(f.center?.x, 0.5), cy = num(f.center?.y, 0.5);
  if (t === 'radial') {
    const sw = num(f.size?.width, 1) / 2, sh = num(f.size?.height, 1) / 2;
    let m = ck.Matrix.multiply(ck.Matrix.translated(x, y), ck.Matrix.scaled(W, H), ck.Matrix.translated(cx, cy));
    if (svg) m = ck.Matrix.multiply(m, ck.Matrix.rotated((-num(f.rotation) * Math.PI) / 180));
    m = ck.Matrix.multiply(m, ck.Matrix.scaled(Math.max(sw, 1e-4), Math.max(sh, 1e-4)));
    return ck.Shader.MakeRadialGradient([0, 0], 1, s.colors, s.pos, ck.TileMode.Clamp, m, PREMUL);
  }
  if (t === 'angular') {
    // CSS conic-gradient(from -rotation at cx cy): starts at 12 o'clock; Skia's sweep starts at 3 o'clock.
    const px = x + cx * W, py = y + cy * H;
    const m = ck.Matrix.rotated(((-90 - num(f.rotation)) * Math.PI) / 180, px, py);
    return ck.Shader.MakeSweepGradient(px, py, s.colors, s.pos, ck.TileMode.Clamp, m, PREMUL);
  }
  return null;
}

/** Paints one fill over the rect (x, y, w, h); the caller has clipped to the node's shape. */
function drawFill(c: Canvas, ck: CanvasKit, scope: Scope, f: any, x: number, y: number, w: number, h: number, resolveUrl: (u: string) => string, svg: boolean) {
  if (!isEnabled(f)) return;
  const paint = scope.own(new ck.Paint(), 'paint');
  paint.setAntiAlias(true);
  const rect = ck.XYWHRect(x, y, w, h);
  if (typeof f === 'object' && f.blendMode && f.blendMode !== 'normal' && BLEND[f.blendMode]) paint.setBlendMode((ck.BlendMode as any)[BLEND[f.blendMode]]);
  if (typeof f === 'string' || f.type === 'color') {
    paint.setColor(color(ck, typeof f === 'string' ? f : f.color));
    c.drawRect(rect, paint);
    return;
  }
  if (f.type === 'gradient') {
    const sh = gradientShader(ck, f, x, y, w, h, svg);
    if (!sh) return;
    paint.setShader(scope.own(sh, 'shader'));
    c.drawRect(rect, paint);
    return;
  }
  if (f.type === 'mesh_gradient') {
    // The DOM's three-gradient approximation: bottom row, top row, then a vertical fade to the bottom-right colour.
    const cols: any[] = f.colors ?? [];
    const n = num(f.columns, 2), m = num(f.rows, 2), op = num(f.opacity, 1);
    if (cols.length < 4) {
      paint.setColor(color(ck, cols[0], op));
      c.drawRect(rect, paint);
      return;
    }
    const tl = color(ck, cols[0], op), tr = color(ck, cols[n - 1], op), bl = color(ck, cols[(m - 1) * n], op), br = color(ck, cols[m * n - 1], op);
    const layers: [number[], number[], Float32Array[]][] = [
      [[x, y], [x + w, y], [bl, br]],
      [[x, y], [x + w, y], [tl, tr]],
      [[x, y], [x, y + h], [ck.TRANSPARENT, br]],
    ];
    for (const [a, b, cs] of layers) {
      paint.setShader(scope.own(ck.Shader.MakeLinearGradient(a, b, cs, [0, 1], ck.TileMode.Clamp, undefined, PREMUL), 'shader'));
      c.drawRect(rect, paint);
    }
    return;
  }
  if (f.type === 'image' && f.url) {
    const { image } = getImage(ck, resolveUrl(f.url));
    if (!image) return;
    const iw = image.width(), ih = image.height();
    const mode = f.mode ?? 'cover';
    let dw = w, dh = h;
    if (mode === 'cover' || mode === 'contain') {
      const k = mode === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      dw = iw * k;
      dh = ih * k;
    }
    if (svg) paint.setAlphaf(num(f.opacity, 1));
    c.save();
    c.clipRect(rect, ck.ClipOp.Intersect, true);
    c.drawImageRectOptions(image, ck.XYWHRect(0, 0, iw, ih), ck.XYWHRect(x + (w - dw) / 2, y + (h - dh) / 2, dw, dh), ck.FilterMode.Linear, ck.MipmapMode.Linear, paint);
    c.restore();
  }
}

function radii(v: any): number[] {
  const r = Array.isArray(v) ? v.map(x => Math.max(0, num(x))) : [num(v), num(v), num(v), num(v)].map(x => Math.max(0, x));
  while (r.length < 4) r.push(r[r.length - 1] ?? 0);
  return r;
}

/** RRect for (x,y,w,h) with CSS corner radii [tl, tr, br, bl], each grown by `grow` (clamped at 0). */
function rrect(x: number, y: number, w: number, h: number, r: number[], grow = 0): Float32Array {
  const g = (v: number) => (v > 0 ? Math.max(0, v + grow) : 0);
  return Float32Array.of(x, y, x + w, y + h, g(r[0]), g(r[0]), g(r[1]), g(r[1]), g(r[2]), g(r[2]), g(r[3]), g(r[3]));
}

/** CSS blur radius -> Skia sigma. */
const sigma = (blur: number) => Math.max(0, blur) / 2;

// ---------- node painting ----------

type Rec = { c: Canvas; ck: CanvasKit; scope: Scope; ctx: PaintContext };

function drawNode(r: Rec, pn: PaintNode, parentWorld: Mat) {
  const { c, ck } = r;
  const p = propsOf(r.ctx, pn.node);
  if (p.enabled === false) return;
  c.save();
  c.concat(skMat(mul(invert(parentWorld), pn.world)));
  let layers = 0;
  const opacity = p.opacity !== undefined ? num(p.opacity, 1) : 1;
  if (opacity < 1) {
    c.saveLayer(r.scope.own(paintWith(ck, pt => pt.setAlphaf(Math.max(0, opacity))), 'paint'));
    layers++;
  }
  const fx = effectList(p.effect);
  // Box nodes use box-shadow (drawn in drawBox); groups, shapes and icons use filter drop-shadow; blur applies to all.
  const boxLike = pn.node.type === 'frame' || pn.node.type === 'rectangle';
  const filter = filterFor(ck, r.scope, fx, boxLike || pn.node.type === 'text');
  if (filter) {
    c.saveLayer(r.scope.own(paintWith(ck, pt => pt.setImageFilter(filter)), 'paint'));
    layers++;
  }
  switch (pn.node.type) {
    case 'frame':
    case 'rectangle':
      drawBox(r, pn, p, fx);
      break;
    case 'text':
      drawText(r, pn, p, fx);
      break;
    case 'ellipse':
    case 'polygon':
    case 'path':
    case 'line':
      drawShape(r, pn, p);
      break;
    case 'icon':
    case 'icon_font':
      drawIcon(r, pn, p);
      break;
    case 'note':
    case 'prompt':
    case 'context':
      drawNote(r, pn, p);
      break;
    default:
      // group, script: just their children
      for (const ch of pn.children) drawNode(r, ch, pn.world);
  }
  for (let i = 0; i < layers; i++) c.restore();
  c.restore();
}

function paintWith(ck: CanvasKit, fn: (p: Paint) => void): Paint {
  const p = new ck.Paint();
  fn(p);
  return p;
}

/** CSS filter: blur(r/2) and, for non-box nodes, drop-shadow(x y b/2) (the DOM passes b/2 as the radius: sigma b/4). */
function filterFor(ck: CanvasKit, scope: Scope, fx: any[], boxLike: boolean) {
  let f: any = null;
  for (const e of fx) {
    if (e.type === 'blur' && num(e.radius) > 0) {
      const s = sigma(num(e.radius));
      f = scope.own(ck.ImageFilter.MakeBlur(s, s, ck.TileMode.Decal, f), 'filter');
    } else if (e.type === 'shadow' && !boxLike && e.shadowType !== 'inner') {
      const s = sigma(num(e.blur) / 2);
      f = scope.own(ck.ImageFilter.MakeDropShadow(num(e.offset?.x), num(e.offset?.y), s, s, color(ck, e.color ?? '#00000040'), f), 'filter');
    }
  }
  return f;
}

function drawBox(r: Rec, pn: PaintNode, p: any, fx: any[]) {
  const { c, ck, scope } = r;
  const { w, h } = pn;
  const rad = radii(p.cornerRadius);
  const box = rrect(0, 0, w, h, rad);
  const shadows = fx.filter(e => e.type === 'shadow');
  // Outer box-shadows (first listed on top), clipped out of the box like CSS.
  for (const e of [...shadows].reverse()) {
    if (e.shadowType === 'inner') continue;
    const sp = num(e.spread);
    const pt = scope.own(new ck.Paint(), 'paint');
    pt.setAntiAlias(true);
    pt.setColor(color(ck, e.color ?? '#00000040'));
    if (num(e.blur) > 0) pt.setMaskFilter(scope.own(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, sigma(num(e.blur)), false), 'maskFilter'));
    c.save();
    c.clipRRect(box, ck.ClipOp.Difference, true);
    c.drawRRect(rrect(num(e.offset?.x) - sp, num(e.offset?.y) - sp, w + sp * 2, h + sp * 2, rad, sp), pt);
    c.restore();
  }
  const backdrop = fx.find(e => e.type === 'background_blur' && num(e.radius) > 0);
  if (backdrop) {
    const s = sigma(num(backdrop.radius));
    c.save();
    c.clipRRect(box, ck.ClipOp.Intersect, true);
    c.saveLayer(undefined, undefined, scope.own(ck.ImageFilter.MakeBlur(s, s, ck.TileMode.Clamp, null), 'filter'));
    c.restore();
    c.restore();
  }
  const fills = fillList(p.fill);
  if (fills.length) {
    c.save();
    c.clipRRect(box, ck.ClipOp.Intersect, true);
    // background-blend-mode blends a box's layers with each other only: isolate them.
    const isolate = fills.some((f: any) => f && typeof f === 'object' && f.blendMode && f.blendMode !== 'normal');
    if (isolate) c.saveLayer();
    for (const f of fills) drawFill(c, ck, scope, f, 0, 0, w, h, r.ctx.resolveUrl, false);
    if (isolate) c.restore();
    c.restore();
  }
  // Inset box-shadows.
  const inner = shadows.filter(e => e.shadowType === 'inner');
  if (inner.length) {
    c.save();
    c.clipRRect(box, ck.ClipOp.Intersect, true);
    for (const e of [...inner].reverse()) {
      const sp = num(e.spread);
      const pt = scope.own(new ck.Paint(), 'paint');
      pt.setAntiAlias(true);
      pt.setColor(color(ck, e.color ?? '#00000040'));
      if (num(e.blur) > 0) pt.setMaskFilter(scope.own(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, sigma(num(e.blur)), false), 'maskFilter'));
      const pad = num(e.blur) * 2 + Math.abs(num(e.offset?.x)) + Math.abs(num(e.offset?.y)) + Math.abs(sp) + 10;
      const pb = new ck.PathBuilder();
      pb.addRect(ck.XYWHRect(-pad, -pad, w + pad * 2, h + pad * 2));
      pb.addRRect(rrect(num(e.offset?.x) + sp, num(e.offset?.y) + sp, Math.max(0, w - sp * 2), Math.max(0, h - sp * 2), rad, -sp));
      pb.setFillType(ck.FillType.EvenOdd);
      const path = scope.own(pb.detach(), 'path');
      pb.delete();
      c.drawPath(path, pt);
    }
    c.restore();
  }
  if (pn.node.type === 'frame') {
    if (p.clip === true) {
      c.save();
      c.clipRRect(box, ck.ClipOp.Intersect, true);
    }
    for (const ch of pn.children) drawNode(r, ch, pn.world);
    if (p.clip === true) c.restore();
  }
  boxStroke(r, normalizeStroke(p, 'inner'), w, h, rad);
}

function boxStroke(r: Rec, s: StrokeInfo | null, w: number, h: number, rad: number[]) {
  if (!s) return;
  const { c, ck, scope } = r;
  const solid = s.fills.length === 1 && (typeof s.fills[0] === 'string' || s.fills[0].type === 'color');
  if (typeof s.width === 'number' && solid) {
    // CSS outline with outline-offset: a band from offset to offset + width, following the corner radii.
    const sw = s.width;
    const mid = s.align === 'inner' ? -sw / 2 : s.align === 'center' ? 0 : sw / 2;
    const pt = scope.own(new ck.Paint(), 'paint');
    pt.setAntiAlias(true);
    pt.setStyle(ck.PaintStyle.Stroke);
    pt.setStrokeWidth(sw);
    const f = s.fills[0];
    pt.setColor(color(ck, typeof f === 'string' ? f : f.color));
    c.drawRRect(rrect(-mid, -mid, w + mid * 2, h + mid * 2, rad, mid), pt);
    return;
  }
  // Masked overlay: a ring between the grown box and the box inset by each side's width, filled with the stroke fills.
  const ws = typeof s.width === 'number' ? { top: s.width, right: s.width, bottom: s.width, left: s.width } : s.width;
  const grow = (v: number) => (s.align === 'outer' ? v : s.align === 'center' ? v / 2 : 0);
  const ox = -grow(ws.left), oy = -grow(ws.top);
  const ow = w + grow(ws.left) + grow(ws.right), oh = h + grow(ws.top) + grow(ws.bottom);
  const outer = rrect(ox, oy, ow, oh, rad);
  const innerR = [Math.max(0, rad[0] - Math.max(ws.top, ws.left)), Math.max(0, rad[1] - Math.max(ws.top, ws.right)), Math.max(0, rad[2] - Math.max(ws.bottom, ws.right)), Math.max(0, rad[3] - Math.max(ws.bottom, ws.left))];
  const inner = rrect(ox + ws.left, oy + ws.top, Math.max(0, ow - ws.left - ws.right), Math.max(0, oh - ws.top - ws.bottom), innerR);
  c.save();
  c.clipRRect(outer, ck.ClipOp.Intersect, true);
  c.clipRRect(inner, ck.ClipOp.Difference, true);
  for (const f of s.fills) drawFill(c, ck, scope, f, ox, oy, ow, oh, r.ctx.resolveUrl, false);
  c.restore();
}

// ---------- text ----------

const ALIGN: Record<string, string> = { left: 'Left', center: 'Center', right: 'Right', justify: 'Justify' };

const normalCache = new Map<string, number>();

/**
 * CSS line-height: normal as Chrome computes it: the font's ascent and descent, each rounded to a whole pixel (Skia's
 * own default leaves them fractional, so lines drift by a fraction of a pixel each).
 */
function normalLineHeight(ck: CanvasKit, textStyle: any): number {
  const k = `${textStyle.fontFamilies[0]}|${textStyle.fontStyle.weight.value}|${textStyle.fontStyle.slant}|${textStyle.fontSize}`;
  let v = normalCache.get(k);
  if (v === undefined) {
    const style = new ck.ParagraphStyle({ textStyle: { ...textStyle, heightMultiplier: undefined, halfLeading: undefined, shadows: [], decoration: 0 }, applyRoundingHack: false });
    const b = ck.ParagraphBuilder.MakeFromFontProvider(style, fontProvider(ck));
    b.addText('Hg');
    const para = b.build();
    b.delete();
    para.layout(1e6);
    const m = para.getLineMetrics()[0];
    v = m ? Math.round(m.ascent) + Math.round(m.descent) : textStyle.fontSize * 1.2;
    para.delete();
    // Keyed by the first font in the list, which changes when the real font replaces the bundled fallback.
    normalCache.set(k, v);
  }
  return v;
}

/** A laid-out paragraph for a text node's props; maxWidth null = no wrapping (textGrowth auto). Caller deletes it. */
export function textParagraph(ck: CanvasKit, p: any, maxWidth: number | null, foreground?: Paint): Paragraph {
  const family = typeof p.fontFamily === 'string' && p.fontFamily ? p.fontFamily : 'Inter';
  const fills = fillList(p.fill ?? '#000000').filter(isEnabled);
  const size = num(p.fontSize, 14);
  const lh = typeof p.lineHeight === 'number' && p.lineHeight > 0 ? p.lineHeight : 0;
  const decoration = (p.underline === true ? ck.UnderlineDecoration : 0) | (p.strikethrough === true ? ck.LineThroughDecoration : 0);
  const col = color(ck, primaryColor(fills) ?? 'transparent');
  const shadows = effectList(p.effect)
    .filter((e: any) => e.type === 'shadow' && e.shadowType !== 'inner')
    .map((e: any) => ({ color: color(ck, e.color ?? '#00000040'), offset: [num(e.offset?.x), num(e.offset?.y)], blurRadius: Math.max(0, (sigma(num(e.blur)) - 0.5) / 0.57735) }));
  const textStyle: any = {
    color: col,
    fontFamilies: familyList(family, p.fontWeight, p.fontStyle === 'italic'),
    fontSize: size,
    fontStyle: { weight: { value: weightNum(p.fontWeight) }, slant: p.fontStyle === 'italic' ? ck.FontSlant.Italic : ck.FontSlant.Upright },
    // Google serves variable fonts (one file for every weight): set the weight axis too, or the first copy registered
    // decides the weight. Static fonts ignore it.
    fontVariations: [{ axis: 'wght', value: weightNum(p.fontWeight) }],
    letterSpacing: num(p.letterSpacing),
    decoration,
    decorationColor: col,
    decorationThickness: 1,
    shadows,
  };
  // line-height: a multiplier with CSS half-leading; 'normal' is the browser's rounded ascent + descent.
  const lineHeight = lh || normalLineHeight(ck, textStyle) / size;
  Object.assign(textStyle, { heightMultiplier: lineHeight, halfLeading: true });
  const style = new ck.ParagraphStyle({
    textStyle,
    textAlign: (ck.TextAlign as any)[ALIGN[p.textAlign] ?? 'Left'],
    // Skia rounds line heights to whole pixels by default; browsers don't.
    applyRoundingHack: false,
  });
  const builder = ck.ParagraphBuilder.MakeFromFontProvider(style, fontProvider(ck));
  if (foreground) builder.pushPaintStyle({ ...textStyle, color: undefined } as any, foreground, foreground);
  const content = typeof p.content === 'string' ? p.content : p.content === undefined ? '' : String(p.content);
  builder.addText(content || '​');
  const para = builder.build();
  builder.delete();
  layoutParagraph(para, maxWidth);
  return para;
}

/** Lays a paragraph out at maxWidth, or (null) on one line per hard break. Re-laying out is much cheaper than building. */
function layoutParagraph(para: Paragraph, maxWidth: number | null) {
  if (maxWidth === null) {
    para.layout(1e6);
    para.layout(Math.ceil(para.getMaxIntrinsicWidth()) + 1);
  } else para.layout(Math.max(1, maxWidth));
}

/**
 * Paragraphs shared by measuring and drawing: one per text node's props (the layout engine asks for several widths,
 * then the painter draws it), built once and laid out again per width. Least recently used ones are freed; all of them
 * when a font arrives (glyphs may change).
 */
const paragraphs = new Map<object, { para: Paragraph; width: number | null | undefined }>();
let paragraphFonts = -1;
const MAX_PARAGRAPHS = 3000;

function sharedParagraph(ck: CanvasKit, p: any, maxWidth: number | null): Paragraph {
  if (paragraphFonts !== fontEpoch()) {
    clearParagraphs();
    paragraphFonts = fontEpoch();
  }
  let e = paragraphs.get(p);
  if (e) paragraphs.delete(p);
  else {
    e = { para: own(textParagraph(ck, p, maxWidth), 'paragraph'), width: maxWidth };
    if (paragraphs.size >= MAX_PARAGRAPHS) {
      const [k, old] = paragraphs.entries().next().value!;
      free(old.para);
      paragraphs.delete(k);
    }
  }
  paragraphs.set(p, e);
  if (e.width !== maxWidth) {
    layoutParagraph(e.para, maxWidth);
    e.width = maxWidth;
  }
  return e.para;
}

export function clearParagraphs() {
  for (const e of paragraphs.values()) free(e.para);
  paragraphs.clear();
}

/** MeasureText for the layout engine, from Skia paragraphs (cached per node props and width). */
export function skiaMeasureText(ctx: PaintContext) {
  const cache = new WeakMap<object, Map<string, { w: number; h: number }>>();
  return (n: RNode, maxWidth: number | null) => {
    const p = propsOf(ctx, n);
    let m = cache.get(p);
    if (!m) cache.set(p, (m = new Map()));
    const k = String(maxWidth);
    let v = m.get(k);
    if (!v) {
      const para = sharedParagraph(ctx.ck, p, maxWidth);
      // The layout engine's contract (src/layout/layout.ts MeasureText): shrink-to-fit width at maxWidth.
      const max = para.getMaxIntrinsicWidth();
      v = { w: maxWidth === null ? max : Math.min(max, Math.max(para.getMinIntrinsicWidth(), maxWidth)), h: para.getHeight() };
      m.set(k, v);
    }
    return v;
  };
}

function drawText(r: Rec, pn: PaintNode, p: any, _fx: any[]) {
  const { c, ck, scope } = r;
  const growth = p.textGrowth ?? 'auto';
  const fills = fillList(p.fill ?? '#000000').filter(isEnabled);
  const gradient = fills.some((f: any) => typeof f === 'object' && f.type !== 'color');
  let fg: Paint | undefined;
  if (gradient) {
    // background-clip: text — the fills are laid over the box and masked by the glyphs.
    const f = [...fills].reverse().find((x: any) => typeof x === 'object' && x.type === 'gradient');
    const sh = f ? gradientShader(ck, f, 0, 0, pn.w, pn.h, false) : null;
    fg = scope.own(new ck.Paint(), 'paint');
    fg.setAntiAlias(true);
    if (sh) fg.setShader(scope.own(sh, 'shader'));
    else fg.setColor(color(ck, primaryColor(fills) ?? 'transparent'));
  }
  const width = growth === 'auto' ? null : pn.w;
  const para = fg ? scope.own(textParagraph(ck, p, width, fg), 'paragraph') : sharedParagraph(ck, p, width);
  const ph = para.getHeight();
  const dy = p.textAlignVertical === 'middle' ? (pn.h - ph) / 2 : p.textAlignVertical === 'bottom' ? pn.h - ph : 0;
  c.drawParagraph(para, 0, dy);
}

// ---------- shapes ----------

const CAP: Record<string, string> = { butt: 'Butt', round: 'Round', square: 'Square' };
const JOIN: Record<string, string> = { miter: 'Miter', round: 'Round', bevel: 'Bevel' };

function shapePath(ck: CanvasKit, scope: Scope, type: string, p: any, w: number, h: number): { path: Path | null; evenodd: boolean } {
  let d = '';
  if (type === 'ellipse') d = ellipseGeometry(w, h, num(p.innerRadius), num(p.startAngle), p.sweepAngle === undefined ? 360 : num(p.sweepAngle, 360));
  else if (type === 'polygon') d = polygonGeometry(w, h, num(p.polygonCount, 3), num(p.cornerRadius));
  else if (type === 'path') d = pathGeometry(typeof p.geometry === 'string' ? p.geometry : '', w, h, p.viewBox);
  else if (type === 'line') d = `M0 0L${w} ${h}`;
  const evenodd = p.fillRule === 'evenodd' || (type === 'ellipse' && num(p.innerRadius) > 0);
  const path = d ? ck.Path.MakeFromSVGString(d) : null;
  if (path) {
    scope.own(path, 'path');
    path.setFillType(evenodd ? ck.FillType.EvenOdd : ck.FillType.Winding);
  }
  return { path, evenodd };
}

function drawShape(r: Rec, pn: PaintNode, p: any) {
  const { c, ck, scope } = r;
  const type = pn.node.type;
  const { w, h } = pn;
  const { path } = shapePath(ck, scope, type, p, w, h);
  if (!path) return;
  const open = type === 'line' || type === 'path';
  const fills = type === 'line' ? [] : fillList(p.fill).filter(isEnabled);
  if (fills.length) {
    c.save();
    c.clipPath(path, ck.ClipOp.Intersect, true);
    for (const f of fills) drawFill(c, ck, scope, f, 0, 0, w, h, r.ctx.resolveUrl, true);
    c.restore();
  }
  const s = normalizeStroke(p, open ? 'center' : type === 'ellipse' ? 'center' : 'inner');
  if (!s) return;
  const sw = typeof s.width === 'number' ? s.width : Math.max(s.width.top, s.width.left);
  const align = open ? 'center' : s.align;
  for (const f of s.fills) {
    const pt = scope.own(new ck.Paint(), 'paint');
    pt.setAntiAlias(true);
    pt.setStyle(ck.PaintStyle.Stroke);
    pt.setStrokeWidth(align === 'center' ? sw : sw * 2);
    pt.setStrokeCap((ck.StrokeCap as any)[CAP[s.cap ?? 'butt'] ?? 'Butt']);
    pt.setStrokeJoin((ck.StrokeJoin as any)[JOIN[s.join ?? 'miter'] ?? 'Miter']);
    if (typeof f === 'string' || f.type === 'color') pt.setColor(color(ck, typeof f === 'string' ? f : f.color));
    else if (f.type === 'gradient') {
      const sh = gradientShader(ck, f, 0, 0, w, h, true);
      if (sh) pt.setShader(scope.own(sh, 'shader'));
    } else continue;
    c.save();
    if (align === 'inner') c.clipPath(path, ck.ClipOp.Intersect, true);
    if (align === 'outer') c.clipPath(path, ck.ClipOp.Difference, true);
    c.drawPath(path, pt);
    c.restore();
  }
}

// ---------- icons ----------

function drawIcon(r: Rec, pn: PaintNode, p: any) {
  const { c, ck, scope } = r;
  const size = Math.min(pn.w, pn.h);
  const library = String(p.library ?? p.iconFontFamily ?? 'lucide');
  const paths = iconPaths(library, String(p.icon ?? p.iconFontName ?? ''));
  c.save();
  c.translate((pn.w - size) / 2, (pn.h - size) / 2);
  if (!paths) {
    // MissingGlyph: a 1px dashed red box.
    const pt = scope.own(new ck.Paint(), 'paint');
    pt.setStyle(ck.PaintStyle.Stroke);
    pt.setStrokeWidth(1);
    pt.setColor(color(ck, '#f43f5e'));
    pt.setPathEffect(scope.own(ck.PathEffect.MakeDash([3, 3], 0)!, 'pathEffect'));
    c.drawRect(ck.XYWHRect(0.5, 0.5, size - 1, size - 1), pt);
    c.restore();
    return;
  }
  const weight = num(p.weight, 0);
  const pt = scope.own(new ck.Paint(), 'paint');
  pt.setAntiAlias(true);
  pt.setStyle(ck.PaintStyle.Stroke);
  pt.setStrokeWidth(weight ? weight / 200 : 2);
  pt.setStrokeCap(ck.StrokeCap.Round);
  pt.setStrokeJoin(ck.StrokeJoin.Round);
  pt.setColor(color(ck, primaryColor(fillList(p.fill).filter(isEnabled)) ?? '#000000'));
  c.scale(size / 24, size / 24);
  for (const d of paths) {
    const path = ck.Path.MakeFromSVGString(d);
    if (!path) continue;
    c.drawPath(scope.own(path, 'path'), pt);
  }
  c.restore();
}

// ---------- notes ----------

const NOTE_COLORS: Record<string, [string, string]> = { note: ['#FDF6C3', '#3f3a1a'], prompt: ['#EDE9FE', '#2e1065'], context: ['#E0F2FE', '#0c4a6e'] };

function drawNote(r: Rec, pn: PaintNode, p: any) {
  const { c, ck, scope } = r;
  const [bg, fg] = NOTE_COLORS[pn.node.type] ?? NOTE_COLORS.note;
  const box = rrect(0, 0, pn.w, pn.h, [4, 4, 4, 4]);
  for (const [y, b, a] of [[4, 12, 0.08], [1, 2, 0.12]] as const) {
    const pt = scope.own(new ck.Paint(), 'paint');
    pt.setAntiAlias(true);
    pt.setColor(ck.Color(0, 0, 0, a));
    pt.setMaskFilter(scope.own(ck.MaskFilter.MakeBlur(ck.BlurStyle.Normal, sigma(b), false), 'maskFilter'));
    c.save();
    c.clipRRect(box, ck.ClipOp.Difference, true);
    c.drawRRect(rrect(0, y, pn.w, pn.h, [4, 4, 4, 4]), pt);
    c.restore();
  }
  const pt = scope.own(new ck.Paint(), 'paint');
  pt.setAntiAlias(true);
  pt.setColor(color(ck, bg));
  c.drawRRect(box, pt);
  c.save();
  c.clipRRect(box, ck.ClipOp.Intersect, true);
  let y = 16;
  const inner = Math.max(1, pn.w - 32);
  if (pn.node.type !== 'note') {
    const head = scope.own(textParagraph(ck, { content: `${pn.node.type}${p.model ? ` · ${p.model}` : ''}`.toUpperCase(), fontSize: 11, fontWeight: 600, fontFamily: p.fontFamily, fill: fg + '99', lineHeight: 1.45 }, inner), 'paragraph');
    c.drawParagraph(head, 16, y);
    y += head.getHeight() + 6;
  }
  const body = scope.own(textParagraph(ck, { content: typeof p.content === 'string' ? p.content : '', fontSize: num(p.fontSize, 14), fontWeight: p.fontWeight, fontFamily: p.fontFamily, fill: fg, lineHeight: 1.45 }, inner), 'paragraph');
  c.drawParagraph(body, 16, y);
  c.restore();
}

// ---------- recording ----------

/** Records a laid-out top-level frame (or any subtree) as a picture in world coordinates. */
export function recordPicture(ctx: PaintContext, root: PaintNode): SkPicture {
  const { ck } = ctx;
  const scope = new Scope();
  const rec = new ck.PictureRecorder();
  const [a, b, cc, d, e, f] = root.world;
  const xs = [e, e + a * root.w, e + cc * root.h, e + a * root.w + cc * root.h];
  const ys = [f, f + b * root.w, f + d * root.h, f + b * root.w + d * root.h];
  // Generous bounds: shadows, outer strokes and overflowing children reach past the frame.
  const m = 2000;
  const c = rec.beginRecording(ck.LTRBRect(Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m));
  try {
    drawNode({ c, ck, scope, ctx }, root, [1, 0, 0, 1, 0, 0]);
    return own(rec.finishRecordingAsPicture(), 'picture');
  } finally {
    rec.delete();
    scope.dispose();
  }
}
