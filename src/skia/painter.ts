// Stage 3 painter (docs/SKIA_REWORK.md): laid-out nodes + resolved props -> Skia draw calls, recorded as one
// SkPicture per top-level frame. Every rule mirrors the DOM renderer (NodeView.tsx / paint.ts) so the two look the
// same: last fill on top, CSS box-shadow and outline geometry, sigma = blur / 2, premultiplied gradient
// interpolation, text via Skia paragraphs. Anything it can't match yet makes skiaEligible() name a reason, and that
// frame stays on the DOM renderer.
import type { Canvas, CanvasKit, Paint, Paragraph, Path, SkPicture, Shader } from 'canvaskit-wasm';
import type { PenDoc, RNode } from '../model/types';
import { resolveProps } from '../model/props';
import { effectList, fillList, imageTransform, isEnabled, linearEndpoints, normalizeStroke, parseColor, primaryColor, type StrokeInfo } from '../render/paint';
import { ellipseGeometry, pathGeometry, polygonGeometry } from '../render/geometry';
import { weightNum } from '../render/fonts';
import { scriptState } from '../editor/scriptHost';
import { Scope, free, own } from './lifetime';
import { DEFAULT_FAMILY, familyList, fontBlocker, fontCollection, fontEpoch, fontStyleKey, iconFontKey, iconFontText, isIconFont } from './fonts';
import { getImage, imageEpoch } from './images';
import { SHADERS_LOADING, effectMargin, isShaderEffect, shaderEffectBlocker, shaderEffectImage, shaderFillBlocker, shaderFillImage, shaderInfoKey, type ShaderEnv } from './shaderFills';
import { nodeScreenRect } from '../editor/measure';
import { useStore } from '../editor/store';
import { iconLibraryBlocker, iconPaths } from './icons';
import { meshOf, tessellate } from '../render/mesh';

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

/**
 * What a frame's eligibility and picture depend on besides its own nodes: the font styles and pictures it uses. When
 * one of those arrives the frame is checked and recorded again; other frames keep their pictures.
 */
export type FrameDeps = {
  fonts: Set<string>;
  /** Text with characters outside the bundled font's range, or a note: any font that arrives may supply its glyphs. */
  anyFont: boolean;
  images: Set<string>;
};

export const newDeps = (): FrameDeps => ({ fonts: new Set(), anyFont: false, images: new Set() });

/**
 * One place a recorded frame draws a picture: where (world box of the node it fills) and how long the picture's
 * longest side is there, in world px. The scene turns that into how many pixels the picture needs at the current zoom.
 */
export type ImageUse = { url: string; x: number; y: number; w: number; h: number; side: number };

/** Characters the bundled Inter (latin) has: text made only of these never needs a glyph from a later font. */
const BASIC_RANGES = '0000-00FF 0131 0152 0153 02C6 02DA 02DC 2000-206F 20AC 2122 2191 2193 2212 2215 FEFF FFFD';
const BASIC_TEXT = new RegExp(`^[${BASIC_RANGES.split(' ').map(r => r.split('-').map(h => String.fromCharCode(92) + 'u' + h).join('-')).join('')}]*$`);

/**
 * null if Skia can draw this whole subtree now, else the first reason it can't (that frame stays DOM). `deps` collects
 * what the answer depends on, up to the node that gave the reason.
 */
/** Why a frame cannot be drawn yet when only its pictures are missing (the frame is tried again when they arrive). */
const PICTURES_LOADING = 'pictures loading';

export function skiaEligible(ctx: PaintContext, n: RNode, editingKey?: string | null, deps?: FrameDeps): string | null {
  const p = propsOf(ctx, n);
  if (p.enabled === false) return null;
  // Still shader effects are drawn from a picture of their output (drawShaderEffects); the others leave the frame.
  let effectsLoading = false;
  for (const e of effectList(p.effect)) {
    if (!isShaderEffect(e)) continue;
    deps?.images.add(shaderInfoKey(ctx.resolveUrl(e.url)));
    const why = shaderEffectBlocker(ctx.resolveUrl, n, e);
    if (why === SHADERS_LOADING) effectsLoading = true;
    else if (why) return why;
  }
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
      const family = typeof p.fontFamily === 'string' && p.fontFamily ? p.fontFamily : 'Inter';
      if (deps) {
        deps.fonts.add(fontStyleKey(family, p.fontWeight, p.fontStyle === 'italic'));
        // Notes also draw a heading in another weight.
        if (n.type !== 'text' || !BASIC_TEXT.test(typeof p.content === 'string' ? p.content : String(p.content ?? ''))) deps.anyFont = true;
      }
      const why = fontBlocker(family, p.fontWeight, p.fontStyle === 'italic');
      if (why) return why;
      break;
    }
    case 'icon':
    case 'icon_font':
    {
      const library = String(p.library ?? p.iconFontFamily ?? 'lucide');
      if (isIconFont(library)) deps?.fonts.add(iconFontKey(library));
      const why = iconLibraryBlocker(library);
      if (why) return why;
      break;
    }
    // A script that has not run, or failed, is drawn with the page's marker (drawScript); a browser node as its box
    // (the live page is an overlay, BrowserOverlays); any other type as the page's placeholder (drawPlaceholder).
    default:
      break;
  }
  // Pictures that are still loading do not stop the walk: stopping at the first one asked for a frame's pictures
  // one per try, each only after the one before it had arrived.
  let loading = effectsLoading;
  // Shader fills: still ones are drawn from an image of their output (shaderFills.ts); the others, and shader fills
  // on kinds of node that image cannot be made for, leave the frame to the page-element renderer as before.
  for (const f of fillList(p.fill)) {
    if (!isShaderFill(f)) continue;
    deps?.images.add(shaderInfoKey(ctx.resolveUrl(f.url)));
    const why = shaderFillBlocker(ctx.resolveUrl, n, p, f);
    if (why === SHADERS_LOADING) loading = true;
    else if (why) return why;
  }
  for (const f of [...fillList(p.fill), ...(normalizeStroke(p, 'inner')?.fills ?? [])]) {
    if (f && typeof f === 'object' && f.type === 'image' && f.url && f.enabled !== false) {
      const url = ctx.resolveUrl(f.url);
      deps?.images.add(url);
      if (getImage(url).status === 'loading') loading = true;
    }
  }
  for (const c of n.children) {
    const why = skiaEligible(ctx, c, editingKey, deps);
    if (why === PICTURES_LOADING) loading = true;
    else if (why) return why;
  }
  return loading ? PICTURES_LOADING : null;
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

/** Paints one fill of the node at `world` over the rect (x, y, w, h); the caller has clipped to the node's shape. */
function drawFill(r: Rec, world: Mat, f: any, x: number, y: number, w: number, h: number, svg: boolean) {
  const { c, ck, scope } = r;
  if (!f || !isEnabled(f)) return;
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
    // The same patches as the DOM renderer's bitmap (render/mesh.ts), as coloured triangles.
    const cols: string[] = (f.colors ?? []).map((cc: any) => (typeof cc === 'string' ? cc : ''));
    if (!cols.length) return;
    const t = tessellate(meshOf(f), cols, 12, num(f.opacity, 1));
    const pos = new Float32Array(t.positions.length);
    for (let i = 0; i < pos.length; i += 2) {
      pos[i] = x + t.positions[i] * w;
      pos[i + 1] = y + t.positions[i + 1] * h;
    }
    const verts = scope.own(ck.MakeVertices(ck.VertexMode.Triangles, pos, null, t.colors, t.indices, true), 'vertices');
    paint.setColor(ck.WHITE);
    c.save();
    c.clipRect(rect, ck.ClipOp.Intersect, true);
    c.drawVertices(verts, ck.BlendMode.Dst, paint);
    c.restore();
    return;
  }
  if (f.type === 'image' && f.url) {
    const url = r.ctx.resolveUrl(f.url);
    // A live shader (liveShaders.ts): its texture, whatever its size; nothing to make sharper. It has no mipmap levels
    // (sampling it with them gives black), and it is drawn at about its own size.
    const got = f.liveImage !== undefined ? { image: f.liveImage, w: 0, h: 0 } : getImage(url, r.detail);
    const image = got.image;
    // A made picture (a still shader) is asked for here, at record time: note what is being waited for.
    if (f.wanted && f.wanted !== url) r.pending?.add(f.wanted);
    if (f.shader) r.pending?.add(url);
    if (!image) return;
    // The original's size, whichever version is drawn: the picture sits in the same place when a sharper one arrives.
    const iw = got.w || image.width(), ih = got.h || image.height();
    const mode = f.mode ?? 'cover';
    let dw = w, dh = h;
    if (mode === 'cover' || mode === 'contain') {
      const k = mode === 'cover' ? Math.max(w / iw, h / ih) : Math.min(w / iw, h / ih);
      dw = iw * k;
      dh = ih * k;
    }
    if (svg || f.shader) paint.setAlphaf(num(f.opacity, 1));
    // The crop: the fitted picture transformed in units of the box (see imageTransform).
    const t = imageTransform(f);
    const grow = t ? Math.max(Math.hypot(t[0], t[1]), Math.hypot(t[2], t[3])) : 1;
    if (r.uses && f.liveImage === undefined) {
      const [a, b, cc, d, e, g] = world;
      const xs = [x, x + w].flatMap(px => [y, y + h].map(py => a * px + cc * py + e));
      const ys = [x, x + w].flatMap(px => [y, y + h].map(py => b * px + d * py + g));
      const x0 = Math.min(...xs), y0 = Math.min(...ys);
      r.uses.push({ url, x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0, side: Math.max(dw, dh) * grow * Math.sqrt(Math.abs(a * d - b * cc)) });
    }
    c.save();
    c.clipRect(rect, ck.ClipOp.Intersect, true);
    if (t) {
      const W = w || 1, H = h || 1;
      c.translate(x, y);
      c.concat([t[0], (t[2] * W) / H, t[4] * W, (t[1] * H) / W, t[3], t[5] * H, 0, 0, 1]);
      c.translate(-x, -y);
    }
    c.drawImageRectOptions(image, ck.XYWHRect(0, 0, image.width(), image.height()), ck.XYWHRect(x + (w - dw) / 2, y + (h - dh) / 2, dw, dh), ck.FilterMode.Linear, f.liveImage !== undefined ? ck.MipmapMode.None : ck.MipmapMode.Linear, paint);
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

type Rec = {
  c: Canvas;
  ck: CanvasKit;
  scope: Scope;
  ctx: PaintContext;
  uses?: ImageUse[];
  detail: boolean;
  /** Pictures the recording asked for that were not there yet: the frame records again when they are. */
  pending?: Set<string>;
  /** The node drawn alone for its shader effects' @content: without those effects, its opacity and its filters. */
  bare?: string;
  /**
   * Nodes left out (with everything in them): what is behind a node, for shaders that read their backdrop; the text
   * being edited; shapes AI Pen has not traced yet.
   */
  hide?: ReadonlySet<string>;
  /** The top-level frame being recorded, and (once asked) what it looks like: for those backdrops. */
  root?: PaintNode;
  rootSig?: string;
  /** Pictures of the root's layers, reused while they are unchanged (recordPicture's `layers`). */
  layers?: LayerCache;
  /** The recording read what the frame looks like (a shader's @backdrop): it depends on the other layers. */
  usedRoot?: boolean;
};

/** One layer of a top-level frame (a node directly inside it) recorded on its own, in the frame's units. */
type LayerPic = { rnode: RNode; w: number; h: number; m: Mat; rootM: Mat; hidden: string; detail: boolean; vars: unknown; fonts: number; images: number; pic: SkPicture; uses: ImageUse[]; pending: string[] };

/**
 * The layers of one top-level frame, kept between its recordings (frames.ts): an edit records only the layer it is
 * in again. `keep`: whether a layer whose recording asked for these pictures may be kept (not live shaders, which
 * change every frame of their animation).
 */
export type LayerCache = { pics: Map<string, LayerPic>; seen: Set<string>; keep: (pending: string[]) => boolean; hits: number; misses: number };

export const newLayerCache = (keep: (pending: string[]) => boolean): LayerCache => ({ pics: new Map(), seen: new Set(), keep, hits: 0, misses: 0 });

/** Frees the layers not drawn by the last recording (gone, or no longer kept). */
export function pruneLayers(L: LayerCache) {
  for (const [k, e] of L.pics) {
    if (L.seen.has(k)) continue;
    free(e.pic);
    L.pics.delete(k);
  }
}

export function freeLayers(L: LayerCache) {
  for (const e of L.pics.values()) free(e.pic);
  L.pics.clear();
}

export function layerBytes(L: LayerCache): number {
  let b = 0;
  for (const e of L.pics.values()) b += e.pic.approximateBytesUsed();
  return b;
}

function inTree(n: RNode, key: string): boolean {
  return n.key === key || n.children.some(c => inTree(c, key));
}

/**
 * Draws layer `ch` of the top-level frame `pn` from its own picture: recorded again only when the layer, its box or
 * place in the frame, the variables, the fonts, the pictures or what is left out of it changed. Moving the frame
 * keeps every layer's picture (they are in the frame's units).
 */
function drawLayer(r: Rec, ch: PaintNode, pn: PaintNode) {
  const L = r.layers!;
  const { ck } = r;
  const local = mul(invert(pn.world), ch.world);
  const hidden = r.hide ? [...r.hide].filter(k => inTree(ch.node, k)).sort().join('\n') : '';
  const rootM = pn.world;
  let e = L.pics.get(ch.key);
  const same =
    !!e && e.rnode === ch.node && e.w === ch.w && e.h === ch.h && e.hidden === hidden && e.detail === r.detail && e.vars === r.ctx.doc.variables &&
    e.fonts === fontEpoch() && e.images === imageEpoch() && e.m.every((v, i) => v === local[i]) && e.rootM.slice(0, 4).every((v, i) => v === rootM[i]);
  if (same) {
    L.hits++;
    for (const u of e!.pending) r.pending?.add(u);
    if (r.uses) {
      const dx = rootM[4] - e!.rootM[4], dy = rootM[5] - e!.rootM[5];
      for (const u of e!.uses) r.uses.push(dx || dy ? { ...u, x: u.x + dx, y: u.y + dy } : u);
    }
    L.seen.add(ch.key);
    r.c.drawPicture(e!.pic);
    return;
  }
  L.misses++;
  if (e) {
    free(e.pic);
    L.pics.delete(ch.key);
  }
  const [a, b, c2, d, tx, ty] = local;
  const xs = [tx, tx + a * ch.w, tx + c2 * ch.h, tx + a * ch.w + c2 * ch.h], ys = [ty, ty + b * ch.w, ty + d * ch.h, ty + b * ch.w + d * ch.h];
  const m = 2000;
  const scope = new Scope();
  const rec = new ck.PictureRecorder();
  const uses: ImageUse[] = [];
  const pending = new Set<string>();
  const sub: Rec = { c: rec.beginRecording(ck.LTRBRect(Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m), true), ck, scope, ctx: r.ctx, uses: r.uses ? uses : undefined, detail: r.detail, pending, hide: r.hide, root: r.root };
  let pic: SkPicture;
  try {
    drawNode(sub, ch, pn.world);
    pic = own(rec.finishRecordingAsPicture(), 'picture');
  } finally {
    rec.delete();
    scope.dispose();
  }
  for (const u of pending) r.pending?.add(u);
  r.uses?.push(...uses);
  r.c.drawPicture(pic);
  if (sub.usedRoot || !L.keep([...pending])) {
    free(pic);
    return;
  }
  e = { rnode: ch.node, w: ch.w, h: ch.h, m: local, rootM: [...rootM] as Mat, hidden, detail: r.detail, vars: r.ctx.doc.variables, fonts: fontEpoch(), images: imageEpoch(), pic, uses, pending: [...pending] };
  L.pics.set(ch.key, e);
  L.seen.add(ch.key);
}

function drawNode(r: Rec, pn: PaintNode, parentWorld: Mat) {
  const { c, ck } = r;
  const p = propsOf(r.ctx, pn.node);
  // A mask is a shape that clips its later siblings (drawChildren); it paints nothing itself.
  if (p.enabled === false || p.mask === true || r.hide?.has(pn.key)) return;
  c.save();
  c.concat(skMat(mul(invert(parentWorld), pn.world)));
  let layers = 0;
  const bare = r.bare === pn.key;
  const opacity = p.opacity !== undefined && !bare ? num(p.opacity, 1) : 1;
  if (opacity < 1) {
    c.saveLayer(r.scope.own(paintWith(ck, pt => pt.setAlphaf(Math.max(0, opacity))), 'paint'));
    layers++;
  }
  const fx = effectList(p.effect);
  // Box nodes use box-shadow (drawn in drawBox); groups, shapes and icons use filter drop-shadow; blur applies to all.
  const boxLike = pn.node.type === 'frame' || pn.node.type === 'rectangle';
  const filter = bare ? null : filterFor(ck, r.scope, fx, boxLike || pn.node.type === 'text');
  if (filter) {
    c.saveLayer(r.scope.own(paintWith(ck, pt => pt.setImageFilter(filter)), 'paint'));
    layers++;
  }
  const shaderFx = bare ? [] : fx.filter(isShaderEffect);
  if (shaderFx.length && drawShaderEffects(r, pn, p, shaderFx)) {
    for (let i = 0; i < layers; i++) c.restore();
    c.restore();
    return;
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
    case 'group':
      drawChildren(r, pn, true);
      break;
    case 'script':
      drawScript(r, pn, p);
      break;
    case 'browser':
      drawBrowser(r, pn, p);
      break;
    default:
      drawPlaceholder(r, pn);
  }
  for (let i = 0; i < layers; i++) c.restore();
  c.restore();
}

/**
 * What a shader on node `pn` may need from the frame (shaderFills.ts ShaderEnv). The backdrop is the frame drawn
 * without the node (nor what is in it), cropped to the node's box grown by `margin`, as the page-element renderer
 * captured it (ShaderLayer.tsx captureBackdrop).
 */
function shaderEnv(r: Rec, pn: PaintNode): ShaderEnv {
  const ctx = r.ctx, root = r.root;
  return {
    backdropSig: () => {
      if (!root) return '';
      r.usedRoot = true;
      r.rootSig ??= nodeSignature(ctx, root);
      return r.rootSig;
    },
    backdrop: (k, margin) => {
      if (!root) return null;
      r.usedRoot = true;
      const { ck } = ctx;
      const [a, b, c, d, e, f] = pn.world;
      const xs = [e, e + a * pn.w, e + c * pn.h, e + a * pn.w + c * pn.h], ys = [f, f + b * pn.w, f + d * pn.h, f + b * pn.w + d * pn.h];
      const x0 = Math.min(...xs) - margin, y0 = Math.min(...ys) - margin;
      const w = Math.max(...xs) + margin - x0, h = Math.max(...ys) + margin - y0;
      const scope = new Scope();
      const rec = new ck.PictureRecorder();
      const cv = rec.beginRecording(ck.LTRBRect(x0, y0, x0 + w, y0 + h));
      let pic: SkPicture;
      try {
        drawNode({ c: cv, ck, scope, ctx, detail: true, hide: new Set([pn.key]), root }, root, [1, 0, 0, 1, 0, 0]);
        pic = own(rec.finishRecordingAsPicture(), 'picture');
      } finally {
        rec.delete();
        scope.dispose();
      }
      try {
        return pictureToCanvas(ck, pic, w, h, k, x0, y0);
      } finally {
        free(pic);
      }
    },
    screenRect: margin => {
      const z = useStore.getState().view.zoom;
      const sr = nodeScreenRect(pn.key);
      return sr ? new DOMRect(sr.left - margin * z, sr.top - margin * z, sr.width + margin * 2 * z, sr.height + margin * 2 * z) : null;
    },
  };
}

/** A picture's area (x0, y0, w, h in its units) drawn at k pixels per unit into a 2D canvas (shader inputs). */
function pictureToCanvas(ck: CanvasKit, pic: SkPicture, w: number, h: number, k: number, x0: number, y0: number): HTMLCanvasElement | null {
  const pw = Math.max(1, Math.round(w * k)), ph = Math.max(1, Math.round(h * k));
  const surface = ck.MakeSurface(pw, ph);
  if (!surface) return null;
  try {
    const sc = surface.getCanvas();
    sc.clear(ck.TRANSPARENT);
    sc.scale(k, k);
    sc.translate(-x0, -y0);
    sc.drawPicture(pic);
    surface.flush();
    const img = surface.makeImageSnapshot();
    const px = img.readPixels(0, 0, { width: pw, height: ph, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
    img.delete();
    if (!px) return null;
    const canvas = document.createElement('canvas');
    canvas.width = pw;
    canvas.height = ph;
    canvas.getContext('2d', { willReadFrequently: true })!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), pw, ph), 0, 0);
    return canvas;
  } finally {
    surface.delete();
  }
}

/**
 * What node `pn` looks like, for the cache key of its shader effects' output: its resolved props and box and those of
 * everything inside it, placed relative to it.
 */
function nodeSignature(ctx: PaintContext, pn: PaintNode, origin: Mat = invert(pn.world)): string {
  const m = mul(origin, pn.world).map(v => Math.round(v * 1000) / 1000);
  return JSON.stringify([pn.node.type, propsOf(ctx, pn.node), Math.round(pn.w * 100) / 100, Math.round(pn.h * 100) / 100, m, pn.children.map(ch => nodeSignature(ctx, ch, origin))]);
}

/** Node `pn` drawn alone (bare: without its shader effects, opacity and filters), in its own units. */
function recordBare(ctx: PaintContext, pn: PaintNode, margin: number, pending?: Set<string>, root?: PaintNode): SkPicture {
  const { ck } = ctx;
  const scope = new Scope();
  const rec = new ck.PictureRecorder();
  const c = rec.beginRecording(ck.LTRBRect(-margin, -margin, pn.w + margin, pn.h + margin));
  try {
    drawNode({ c, ck, scope, ctx, detail: true, pending, bare: pn.key, root }, pn, pn.world);
    return own(rec.finishRecordingAsPicture(), 'picture');
  } finally {
    rec.delete();
    scope.dispose();
  }
}

/**
 * Draws node `pn` through its still shader effects (shaderFills.ts shaderEffectImage) and returns true, or false to
 * have it drawn as it is: while its output is being made, or while what it shows is still loading, or with the dashed
 * outline the page-element renderer puts on a node whose effect fails.
 */
function drawShaderEffects(r: Rec, pn: PaintNode, p: any, effects: any[]): boolean {
  const { c, ck } = r;
  const margin = effectMargin(p);
  // What the node shows must be complete before the effect runs on it. Fonts and pictures are (skiaEligible waits for
  // them); made pictures inside it (shader fills) are the frame's dependencies, and are waited for here.
  const inside = new Set<string>();
  free(recordBare(r.ctx, pn, margin, inside, r.root));
  for (const u of inside) r.pending?.add(u);
  if ([...inside].some(u => getImage(u, false).status !== 'ready')) return false;
  const ctx = r.ctx;
  const root = r.root;
  const content = (k: number) => {
    const w = Math.max(1, Math.round((pn.w + margin * 2) * k)), h = Math.max(1, Math.round((pn.h + margin * 2) * k));
    const surface = ck.MakeSurface(w, h);
    if (!surface) return null;
    const pic = recordBare(ctx, pn, margin, undefined, root);
    try {
      const sc = surface.getCanvas();
      sc.clear(ck.TRANSPARENT);
      sc.scale(k, k);
      sc.translate(margin, margin);
      sc.drawPicture(pic);
      surface.flush();
      const img = surface.makeImageSnapshot();
      const px = img.readPixels(0, 0, { width: w, height: h, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
      img.delete();
      if (!px) return null;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d', { willReadFrequently: true })!.putImageData(new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), w, h), 0, 0);
      return canvas;
    } finally {
      free(pic);
      surface.delete();
    }
  };
  const made = shaderEffectImage(r.ctx.resolveUrl, pn.node, effects, pn.w, pn.h, margin, nodeSignature(r.ctx, pn), content, shaderEnv(r, pn));
  if (made && 'error' in made) {
    // As is, with a 1px dashed outline just outside the (margin-grown) box, as CSS draws `outline` on the canvas.
    drawBareInPlace(r, pn);
    const pt = r.scope.own(new ck.Paint(), 'paint');
    pt.setAntiAlias(true);
    pt.setStyle(ck.PaintStyle.Stroke);
    pt.setStrokeWidth(1);
    pt.setColor(color(ck, '#f43f5e'));
    pt.setPathEffect(r.scope.own(ck.PathEffect.MakeDash([3, 3], 0)!, 'pathEffect'));
    c.drawRect(ck.LTRBRect(-margin - 0.5, -margin - 0.5, pn.w + margin + 0.5, pn.h + margin + 0.5), pt);
    return true;
  }
  if (!made) return false;
  // The output replaces the node: until the first one is made, the node is drawn as it is.
  if (made.liveImage !== undefined) {
    r.pending?.add(made.url);
    if (!made.liveImage) return false;
    drawFill(r, pn.world, made, -margin, -margin, pn.w + margin * 2, pn.h + margin * 2, false);
    return true;
  }
  r.pending?.add(made.wanted);
  if (getImage(made.url, false).status !== 'ready') {
    r.pending?.add(made.url);
    return false;
  }
  drawFill(r, pn.world, made, -margin, -margin, pn.w + margin * 2, pn.h + margin * 2, false);
  return true;
}

/** The node as it is, here (inside drawNode's transform and layers), without its shader effects. */
function drawBareInPlace(r: Rec, pn: PaintNode) {
  const saved = r.bare;
  r.bare = pn.key;
  drawNode(r, pn, pn.world);
  r.bare = saved;
}

/**
 * Draws a node's children. Where they are placed freely (`masks`: groups, frames without auto layout), a child with
 * `mask: true` clips the siblings after it to its outline, as NodeView's Children does with clip-path.
 */
function drawChildren(r: Rec, pn: PaintNode, masks: boolean) {
  const { c, ck } = r;
  let saved = 0;
  for (const ch of pn.children) {
    const p = propsOf(r.ctx, ch.node);
    if (masks && p.mask === true && p.enabled !== false) {
      const local = mul(invert(pn.world), ch.world);
      c.save();
      saved++;
      // Clip in the mask's own coordinates, then go back: the clip stays, in device space.
      c.concat(skMat(local));
      const type = ch.node.type;
      if (type === 'ellipse' || type === 'polygon' || type === 'path') {
        const { path } = shapePath(ck, r.scope, type, p, ch.w, ch.h);
        if (path) c.clipPath(path, ck.ClipOp.Intersect, true);
      } else c.clipRRect(rrect(0, 0, ch.w, ch.h, radii(p.cornerRadius).map(v => Math.min(v, ch.w / 2, ch.h / 2))), ck.ClipOp.Intersect, true);
      c.concat(skMat(invert(local)));
      continue;
    }
    if (r.layers && pn === r.root && !r.bare) drawLayer(r, ch, pn);
    else drawNode(r, ch, pn.world);
  }
  for (let i = 0; i < saved; i++) c.restore();
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
    const made = fills.map(f => (isShaderFill(f) ? shaderFillImage(r.ctx.resolveUrl, pn.node, p, f, w, h, shaderEnv(r, pn)) : f));
    for (const f of made) if (!f?.errorMarker) drawFill(r, pn.world, f, 0, 0, w, h, false);
    if (isolate) c.restore();
    c.restore();
    drawErrorMarkers(r, pn, made, w, h);
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
    drawChildren(r, pn, p.layout === 'none');
    if (p.clip === true) c.restore();
  }
  boxStroke(r, pn.world, normalizeStroke(p, 'inner'), w, h, rad);
}

function boxStroke(r: Rec, world: Mat, s: StrokeInfo | null, w: number, h: number, rad: number[]) {
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
  for (const f of s.fills) drawFill(r, world, f, ox, oy, ow, oh, false);
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
    const b = ck.ParagraphBuilder.MakeFromFontCollection(style, fontCollection(ck));
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
  const builder = ck.ParagraphBuilder.MakeFromFontCollection(style, fontCollection(ck));
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
const MAX_PARAGRAPHS = 1500;

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

/**
 * A failing shader's error marker (shaderFills.ts errorFill) covers the node's whole box, not clipped to its outline or
 * corners: on the page-element renderer it is a separate box over the fills.
 */
function drawErrorMarkers(r: Rec, pn: PaintNode, made: any[], w: number, h: number) {
  for (const f of made) if (f?.errorMarker) drawFill(r, pn.world, f, 0, 0, w, h, false);
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
    const made = fills.map(f => (isShaderFill(f) ? shaderFillImage(r.ctx.resolveUrl, pn.node, p, f, w, h, shaderEnv(r, pn)) : f));
    for (const f of made) if (!f?.errorMarker) drawFill(r, pn.world, f, 0, 0, w, h, true);
    c.restore();
    drawErrorMarkers(r, pn, made, w, h);
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
  const name = String(p.icon ?? p.iconFontName ?? '');
  if (isIconFont(library)) return drawIconFont(r, pn, p, library, name, size);
  const paths = iconPaths(library, name);
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

/**
 * An icon from an icon font, as the page shows it: the glyph at font-size = the box's shorter side, line-height 1,
 * centred in the box; Material Symbols with its weight (default 400) and the optical size the browser picks for that
 * font size (font-optical-sizing: auto, within the font's 20-48 range).
 */
function drawIconFont(r: Rec, pn: PaintNode, p: any, library: string, name: string, size: number) {
  const { c, ck } = r;
  const got = iconFontText(library, name);
  if (!got || !got.text || !(size > 0)) return;
  const fill = primaryColor(fillList(p.fill).filter(isEnabled)) ?? '#000000';
  const material = !library.toLowerCase().startsWith('phosphor');
  const style = new ck.ParagraphStyle({
    textStyle: {
      color: color(ck, fill),
      fontFamilies: [got.alias],
      fontSize: size,
      heightMultiplier: 1,
      halfLeading: true,
      fontVariations: material ? [{ axis: 'wght', value: num(p.weight, 0) || 400 }, { axis: 'opsz', value: Math.max(20, Math.min(48, size)) }] : undefined,
    },
    textAlign: ck.TextAlign.Left,
  });
  const builder = r.scope.own(ck.ParagraphBuilder.MakeFromFontCollection(style, fontCollection(ck)), 'paragraphBuilder');
  builder.addText(got.text);
  const para = r.scope.own(builder.build(), 'paragraph');
  para.layout(1e6);
  const tw = para.getMaxIntrinsicWidth(), th = para.getHeight();
  c.drawParagraph(para, (pn.w - tw) / 2, (pn.h - th) / 2);
}

/**
 * Centred text in a box (the page's markers: script states, placeholders): 11px Inter, wrapped to the box less
 * `pad` on each side, cut off at the box.
 */
function drawBoxText(r: Rec, w: number, h: number, text: string, fill: string, pad: number) {
  const { c, ck } = r;
  const style = new ck.ParagraphStyle({ textStyle: { color: color(ck, fill), fontFamilies: familyList(DEFAULT_FAMILY, 400, false), fontSize: 11 }, textAlign: ck.TextAlign.Center });
  const builder = r.scope.own(ck.ParagraphBuilder.MakeFromFontCollection(style, fontCollection(ck)), 'paragraphBuilder');
  builder.addText(text);
  const para = r.scope.own(builder.build(), 'paragraph');
  para.layout(Math.max(1, w - pad * 2));
  c.save();
  c.clipRect(ck.XYWHRect(0, 0, w, h), ck.ClipOp.Intersect, true);
  c.drawParagraph(para, pad, (h - para.getHeight()) / 2);
  c.restore();
}

function dashedRect(r: Rec, w: number, h: number, stroke: string, fill?: string) {
  const { c, ck, scope } = r;
  if (fill) c.drawRect(ck.XYWHRect(0, 0, w, h), scope.own(paintWith(ck, pt => pt.setColor(color(ck, fill))), 'paint'));
  const pt = scope.own(new ck.Paint(), 'paint');
  pt.setStyle(ck.PaintStyle.Stroke);
  pt.setStrokeWidth(1);
  pt.setColor(color(ck, stroke));
  pt.setPathEffect(scope.own(ck.PathEffect.MakeDash([3, 3], 0)!, 'pathEffect'));
  c.drawRect(ck.XYWHRect(0.5, 0.5, w - 1, h - 1), pt);
}

/** A script node: its children, and (NodeView ScriptView) a marker while it has not run, has no file or failed. */
function drawScript(r: Rec, pn: PaintNode, p: any) {
  const { c, ck } = r;
  const clip = p.clip === true;
  if (clip) {
    c.save();
    c.clipRect(ck.XYWHRect(0, 0, pn.w, pn.h), ck.ClipOp.Intersect, true);
  }
  drawChildren(r, pn, true);
  if (clip) c.restore();
  const st = scriptState(pn.node.props, pn.node.theme, pn.key);
  if (st && st.status === 'ok') return;
  const failed = st?.status === 'error';
  const ink = failed ? '#f43f5e' : '#a1a1aa';
  dashedRect(r, pn.w, pn.h, ink, failed ? 'rgba(244,63,94,0.06)' : undefined);
  drawBoxText(r, pn.w, pn.h, !st ? 'Script: no file set' : st.status === 'pending' ? 'Running script…' : `Script error: ${(st as any).message}`, ink, 7);
}

/** A browser node's box (NodeView BrowserView): white, its corners rounded; the page itself is a BrowserOverlays frame. */
function drawBrowser(r: Rec, pn: PaintNode, p: any) {
  const { c, ck, scope } = r;
  const rad = radii(p.cornerRadius).map(v => Math.min(v, pn.w / 2, pn.h / 2));
  c.drawRRect(rrect(0, 0, pn.w, pn.h, rad), scope.own(paintWith(ck, pt => (pt.setColor(ck.WHITE), pt.setAntiAlias(true))), 'paint'));
  if (!p.url) {
    c.save();
    c.clipRRect(rrect(0, 0, pn.w, pn.h, rad), ck.ClipOp.Intersect, true);
    const style = new ck.ParagraphStyle({ textStyle: { color: color(ck, '#71717a'), fontFamilies: familyList(DEFAULT_FAMILY, 400, false), fontSize: 14 }, textAlign: ck.TextAlign.Center });
    const builder = scope.own(ck.ParagraphBuilder.MakeFromFontCollection(style, fontCollection(ck)), 'paragraphBuilder');
    builder.addText('No URL');
    const para = scope.own(builder.build(), 'paragraph');
    para.layout(pn.w);
    c.drawParagraph(para, 0, (pn.h - para.getHeight()) / 2);
    c.restore();
  }
}

/** A node of a type nothing draws (a missing component, an unknown type): NodeView PlaceholderView. */
function drawPlaceholder(r: Rec, pn: PaintNode) {
  dashedRect(r, pn.w, pn.h, '#a1a1aa');
  drawBoxText(r, pn.w, pn.h, pn.node.type === 'missing_ref' ? 'Missing component' : pn.node.type, '#a1a1aa', 0);
  r.c.save();
  r.c.clipRect(r.ck.XYWHRect(0, 0, pn.w, pn.h), r.ck.ClipOp.Intersect, true);
  drawChildren(r, pn, true);
  r.c.restore();
}

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

/**
 * Records a laid-out top-level frame (or any subtree) as a picture in world coordinates. `uses` collects where it
 * draws pictures; `detail` false draws them from their small versions even when a larger one is loaded.
 */
export function recordPicture(ctx: PaintContext, root: PaintNode, uses?: ImageUse[], detail = true, pending?: Set<string>, hide?: Iterable<string> | null, layers?: LayerCache): SkPicture {
  const { ck } = ctx;
  const scope = new Scope();
  const rec = new ck.PictureRecorder();
  const [a, b, cc, d, e, f] = root.world;
  const xs = [e, e + a * root.w, e + cc * root.h, e + a * root.w + cc * root.h];
  const ys = [f, f + b * root.w, f + d * root.h, f + b * root.w + d * root.h];
  // Generous bounds: shadows, outer strokes and overflowing children reach past the frame.
  const m = 2000;
  // computeBounds: the picture keeps a spatial index, so zoomed in only what is on screen is replayed, and its
  // cullRect() is what was actually drawn.
  const c = rec.beginRecording(ck.LTRBRect(Math.min(...xs) - m, Math.min(...ys) - m, Math.max(...xs) + m, Math.max(...ys) + m), true);
  try {
    // Left out: the text being edited (edited in a box over the canvas, ui/TextEditOverlay.tsx) and shapes AI Pen has
    // not traced yet (they appear as its pen reaches them, ui/AiPen.tsx).
    const hidden = hide ? new Set(hide) : undefined;
    layers?.seen.clear();
    drawNode({ c, ck, scope, ctx, uses, detail, pending, root, hide: hidden?.size ? hidden : undefined, layers }, root, [1, 0, 0, 1, 0, 0]);
    if (layers) pruneLayers(layers);
    return own(rec.finishRecordingAsPicture(), 'picture');
  } finally {
    rec.delete();
    scope.dispose();
  }
}
