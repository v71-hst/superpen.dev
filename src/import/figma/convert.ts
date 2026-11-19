// Figma nodes -> .pen nodes.
import type { PenNode } from '../../model/types';
import { commandsToPath, decodeVectorNetwork, networkFills, networkOutline, polygonPath, starPath } from './geometry';
import { blendName, convertEffects, convertPaints, hasVisiblePaint, type ImageUse, type Notes } from './paints';
import { instanceChildren, type Expanded, type FNode, type Scene } from './scene';
import { modeScope, variableColor, type ModeScope } from './styles';
import { convertText } from './text';

export type ConvertCtx = {
  scene: Scene;
  notes: Notes;
  images: ImageUse[];
  ids: Set<string>;
  /** Main components being expanded right now (guards against a component that contains itself). */
  expanding: Set<FNode>;
  /** For tests: record Figma's own box [x, y, width, height] of every node as `figmaBox`. */
  debug?: boolean;
  /** Variable modes chosen by the layers above the one being converted. */
  modes: ModeScope | null;
  colorOf: (binding: any) => { r: number; g: number; b: number; a: number } | null;
};

export function newContext(scene: Scene, notes: Notes, debug: boolean): ConvertCtx {
  const ctx: ConvertCtx = { scene, notes, images: [], ids: new Set(), expanding: new Set(), debug, modes: null, colorOf: binding => variableColor(scene, binding, ctx.modes) };
  return ctx;
}

type Layout = 'none' | 'horizontal' | 'vertical';

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
export const r2 = (v: number) => {
  const r = Math.round(num(v) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
};

const MAX_DEPTH = 200;

function uniqueId(ctx: ConvertCtx, want: string): string {
  let id = want.replace(/[^A-Za-z0-9_-]/g, '-');
  if (ctx.ids.has(id)) {
    let i = 2;
    while (ctx.ids.has(`${id}_${i}`)) i++;
    id = `${id}_${i}`;
  }
  ctx.ids.add(id);
  return id;
}

// ---------- position, size, shared properties ----------

/**
 * Figma places a node with a 2x3 matrix. A .pen node has x/y (its top-left corner before rotating), a rotation
 * about that corner (degrees, counter-clockwise) and flips about the middle of its box.
 */
function placement(n: FNode, w: number, h: number, ctx: ConvertCtx) {
  const t = n.transform ?? {};
  const a = num(t.m00, 1), b = num(t.m10, 0), c = num(t.m01, 0), d = num(t.m11, 1);
  let x = num(t.m02), y = num(t.m12);
  const det = a * d - b * c;
  let theta = Math.atan2(b, a);
  let flipX = false, flipY = false;
  if (det < 0) {
    // A mirrored node: either flip gives the same picture with rotations 180° apart, so take the smaller turn.
    const viaX = Math.atan2(-c, d);
    if (Math.abs(viaX) <= Math.abs(theta)) {
      flipX = true;
      theta = viaX;
    } else {
      flipY = true;
    }
  }
  const cos = Math.cos(theta), sin = Math.sin(theta);
  if (flipX) {
    x -= w * cos;
    y -= w * sin;
  }
  if (flipY) {
    x += h * sin;
    y -= h * cos;
  }
  if (Math.abs(Math.hypot(a, b) - 1) > 1e-3 || Math.abs(Math.hypot(c, d) - 1) > 1e-3 || Math.abs(a * c + b * d) > 1e-3) ctx.notes.add('layers with a skewed or scaled transform (skew and scale dropped)');
  let rotation = r2((-theta * 180) / Math.PI);
  if (rotation === -180) rotation = 180;
  return { x: r2(x), y: r2(y), rotation, flipX, flipY };
}

/** True when a node is laid out by its parent's auto layout (and so has no position of its own). */
function inFlow(n: FNode, parentLayout: Layout) {
  return parentLayout !== 'none' && n.stackPositioning !== 'ABSOLUTE';
}

/** Id, name, position, rotation, opacity, visibility, mask: the things every node has. */
function base(n: FNode, type: string, parentLayout: Layout, ctx: ConvertCtx, boxW: number, boxH: number): PenNode {
  const pen: PenNode = { type, id: uniqueId(ctx, n.pid) };
  if (typeof n.name === 'string' && n.name) pen.name = n.name;
  const p = placement(n, boxW, boxH, ctx);
  if (!inFlow(n, parentLayout)) {
    pen.x = p.x;
    pen.y = p.y;
    if (parentLayout !== 'none') pen.layoutPosition = 'absolute';
  }
  if (p.rotation) pen.rotation = p.rotation;
  if (p.flipX) pen.flipX = true;
  if (p.flipY) pen.flipY = true;
  const opacity = num(n.opacity, 1);
  if (opacity < 0.999) pen.opacity = Math.max(0, Math.round(opacity * 1000) / 1000);
  if (n.visible === false) pen.enabled = false;
  if (n.mask === true) {
    pen.mask = true;
    if (n.maskType === 'LUMINANCE') ctx.notes.add('luminance masks (treated as ordinary masks)');
  }
  if (blendName(n.blendMode)) ctx.notes.add('layer blend modes (drawn as normal)');
  if (ctx.debug) pen.figmaBox = [num(n.transform?.m02), num(n.transform?.m12), num(n.size?.x), num(n.size?.y)];
  return pen;
}

/** Width and height, taking the parent's auto layout into account (fill) and the node's own (hug). */
function sizing(n: FNode, pen: PenNode, parentLayout: Layout, hugW = false, hugH = false) {
  const w = r2(num(n.size?.x)), h = r2(num(n.size?.y));
  let width: number | string = hugW ? `fit_content(${w})` : w;
  let height: number | string = hugH ? `fit_content(${h})` : h;
  if (inFlow(n, parentLayout)) {
    const grow = num(n.stackChildPrimaryGrow) > 0;
    const stretch = n.stackChildAlignSelf === 'STRETCH';
    const horizontal = parentLayout === 'horizontal';
    if (horizontal ? grow : stretch) width = `fill_container(${w})`;
    if (horizontal ? stretch : grow) height = `fill_container(${h})`;
  }
  pen.width = width;
  pen.height = height;
}

function cornerRadius(n: FNode): number | number[] | undefined {
  const all = num(n.cornerRadius);
  if (n.rectangleCornerRadiiIndependent === true) {
    const r = [n.rectangleTopLeftCornerRadius, n.rectangleTopRightCornerRadius, n.rectangleBottomRightCornerRadius, n.rectangleBottomLeftCornerRadius].map(v => r2(Math.max(0, num(v))));
    if (r.some(v => v !== r[0])) return r;
    return r[0] || undefined;
  }
  return all > 0 ? r2(all) : undefined;
}

const CAP: Record<string, string> = { ROUND: 'round', SQUARE: 'square' };
const JOIN: Record<string, string> = { ROUND: 'round', BEVEL: 'bevel' };
const ALIGN: Record<string, string> = { INSIDE: 'inner', OUTSIDE: 'outer', CENTER: 'center' };

function strokeWeight(n: FNode): number {
  return Math.max(0, num(n.strokeWeight, 1));
}

function hasStroke(n: FNode): boolean {
  if (!hasVisiblePaint(n.strokePaints)) return false;
  if (n.borderStrokeWeightsIndependent === true) return [n.borderTopWeight, n.borderRightWeight, n.borderBottomWeight, n.borderLeftWeight].some(v => num(v) > 0);
  return strokeWeight(n) > 0;
}

/** Stroke paints, weight, alignment, caps, joins and dashes. `sides` allows a different weight per side (boxes). */
function stroke(n: FNode, pen: PenNode, w: number, h: number, ctx: ConvertCtx, opts: { sides?: boolean; caps?: boolean; align?: string } = {}) {
  if (!hasStroke(n)) return;
  const paint = convertPaints(n.strokePaints, w, h, ctx);
  if (paint === undefined) return;
  pen.stroke = paint;
  if (opts.sides && n.borderStrokeWeightsIndependent === true) {
    const s = { top: r2(Math.max(0, num(n.borderTopWeight))), right: r2(Math.max(0, num(n.borderRightWeight))), bottom: r2(Math.max(0, num(n.borderBottomWeight))), left: r2(Math.max(0, num(n.borderLeftWeight))) };
    pen.strokeWidth = s.top === s.right && s.top === s.bottom && s.top === s.left ? s.top : s;
  } else {
    pen.strokeWidth = r2(strokeWeight(n));
  }
  pen.strokeAlignment = opts.align ?? ALIGN[n.strokeAlign] ?? 'center';
  if (opts.caps) {
    const cap = n.strokeCap;
    if (CAP[cap]) pen.strokeLinecap = CAP[cap];
    else if (cap && cap !== 'NONE') ctx.notes.add('arrow heads and other special line ends (drawn as plain ends)');
  }
  if (JOIN[n.strokeJoin]) pen.strokeLinejoin = JOIN[n.strokeJoin];
  if (Array.isArray(n.dashPattern) && n.dashPattern.length && n.dashPattern.some((v: any) => num(v) > 0)) pen.strokeDash = n.dashPattern.map((v: any) => r2(Math.max(0, num(v))));
}

function effects(n: FNode, pen: PenNode, ctx: ConvertCtx) {
  const fx = convertEffects(n.effects, ctx);
  if (fx !== undefined) pen.effect = fx;
}

// ---------- containers ----------

function mirrored(n: FNode): boolean {
  const t = n.transform ?? {};
  return num(t.m00, 1) * num(t.m11, 1) - num(t.m01, 0) * num(t.m10, 0) < 0;
}

function isGroup(n: FNode): boolean {
  // Figma stores a group as a frame that resizes to fit its children.
  return n.type === 'GROUP' || (n.type === 'FRAME' && n.resizeToFit === true);
}

function paddingOf(n: FNode, perSide: boolean): [number, number, number, number] {
  const all = num(n.stackPadding);
  const left = num(n.stackHorizontalPadding, all);
  const top = num(n.stackVerticalPadding, all);
  // Figma leaves out values that are 0. Files from before per-side padding have no right / bottom value at all:
  // there the horizontal / vertical one covers both sides.
  const right = num(n.stackPaddingRight, perSide ? 0 : left);
  const bottom = num(n.stackPaddingBottom, perSide ? 0 : top);
  let extra = [0, 0, 0, 0];
  // "Strokes included in layout": the stroke takes room like padding does, even while its paint is hidden.
  if (n.bordersTakeSpace === true && Array.isArray(n.strokePaints) && n.strokePaints.length && n.strokeAlign !== 'OUTSIDE') {
    const k = n.strokeAlign === 'INSIDE' ? 1 : 0.5;
    const s = strokeWeight(n);
    extra = (n.borderStrokeWeightsIndependent === true ? [num(n.borderTopWeight), num(n.borderRightWeight), num(n.borderBottomWeight), num(n.borderLeftWeight)] : [s, s, s, s]).map(v => v * k);
  }
  return [r2(top + extra[0]), r2(right + extra[1]), r2(bottom + extra[2]), r2(left + extra[3])];
}

const JUSTIFY: Record<string, string> = { CENTER: 'center', MAX: 'end', SPACE_EVENLY: 'space_between', SPACE_BETWEEN: 'space_between' };
const ALIGN_ITEMS: Record<string, string> = { CENTER: 'center', MAX: 'end' };

function container(n: FNode, parentLayout: Layout, ctx: ConvertCtx, depth: number, expanded: Expanded | null): PenNode {
  const w = num(n.size?.x), h = num(n.size?.y);
  const kids = expanded ? expanded.children : n.kids;
  const master = expanded ? expanded.master : null;
  if (expanded && num(n.symbolData?.uniformScaleFactor, 1) !== 1) ctx.notes.add('instances scaled with the Scale tool (text and stroke sizes may be off)');

  if (isGroup(n) && !mirrored(n)) {
    const pen = base(n, 'group', parentLayout, ctx, 0, 0);
    effects(n, pen, ctx);
    pen.children = children(kids, 'none', ctx, depth);
    return pen;
  }

  const pen = base(n, 'frame', parentLayout, ctx, w, h);
  if (n.type === 'SYMBOL') pen.reusable = true;

  let layout: Layout = 'none';
  if (n.stackMode === 'HORIZONTAL' || n.stackMode === 'VERTICAL') {
    if (n.stackWrap === 'WRAP') ctx.notes.add('wrapping auto layout (children placed at fixed positions instead)');
    else layout = n.stackMode === 'HORIZONTAL' ? 'horizontal' : 'vertical';
  } else if (n.stackMode === 'GRID') {
    ctx.notes.add('grid auto layout (children placed at fixed positions instead)');
  }

  let hugW = false, hugH = false;
  if (layout !== 'none') {
    // Figma only writes these when they differ from its defaults: the main axis hugs, the cross axis is fixed.
    const hugMain = n.stackPrimarySizing !== 'FIXED';
    const hugCross = typeof n.stackCounterSizing === 'string' && n.stackCounterSizing.startsWith('RESIZE_TO_FIT');
    hugW = layout === 'horizontal' ? hugMain : hugCross;
    hugH = layout === 'horizontal' ? hugCross : hugMain;
  }
  sizing(n, pen, parentLayout, hugW, hugH);
  pen.layout = layout;
  if (layout !== 'none') {
    const justify = JUSTIFY[n.stackPrimaryAlignItems];
    const gap = num(n.stackSpacing);
    if (gap && justify !== 'space_between') pen.gap = r2(gap);
    const [top, right, bottom, left] = paddingOf(n, ctx.scene.paddingPerSide);
    if (top || right || bottom || left) pen.padding = top === bottom && left === right ? (top === left ? top : [top, left]) : [top, right, bottom, left];
    if (justify) pen.justifyContent = justify;
    if (ALIGN_ITEMS[n.stackCounterAlignItems]) pen.alignItems = ALIGN_ITEMS[n.stackCounterAlignItems];
    else if (n.stackCounterAlignItems === 'BASELINE') ctx.notes.add('baseline alignment in auto layout (aligned to the top instead)');
    if (n.stackReverseZIndex === true) ctx.notes.add('auto layout with "first on top" stacking (last is on top instead)');
  }

  if (n.type !== 'SECTION' && n.frameMaskDisabled !== true && !isGroup(n)) pen.clip = true;
  const radius = cornerRadius(n);
  if (radius !== undefined) pen.cornerRadius = radius;

  let fill = convertPaints(n.fillPaints, w, h, ctx);
  if (fill === undefined && n.fillPaints === undefined && n.backgroundEnabled === true && n.backgroundColor) {
    // Very old files keep a frame's fill as a background colour.
    fill = convertPaints([{ type: 'SOLID', color: n.backgroundColor, opacity: num(n.backgroundOpacity, 1), visible: true }], w, h, ctx);
  }
  if (fill !== undefined) pen.fill = fill;
  stroke(n, pen, w, h, ctx, { sides: true });
  effects(n, pen, ctx);

  if (master) {
    if (ctx.expanding.has(master) || depth > MAX_DEPTH) {
      ctx.notes.add('components that contain themselves (left empty)');
      pen.children = [];
      return pen;
    }
    ctx.expanding.add(master);
    pen.children = children(kids, layout, ctx, depth);
    ctx.expanding.delete(master);
  } else {
    pen.children = children(kids, layout, ctx, depth);
  }
  return pen;
}

function children(kids: FNode[], layout: Layout, ctx: ConvertCtx, depth: number): PenNode[] {
  const out: PenNode[] = [];
  if (depth > MAX_DEPTH) return out;
  for (const k of kids) {
    const pen = convertNode(k, layout, ctx, depth + 1);
    if (pen) out.push(pen);
  }
  return out;
}

// ---------- shapes ----------

function rectangle(n: FNode, parentLayout: Layout, ctx: ConvertCtx): PenNode {
  const w = num(n.size?.x), h = num(n.size?.y);
  const pen = base(n, 'rectangle', parentLayout, ctx, w, h);
  sizing(n, pen, parentLayout);
  const radius = cornerRadius(n);
  if (radius !== undefined) pen.cornerRadius = radius;
  const fill = convertPaints(n.fillPaints, w, h, ctx);
  if (fill !== undefined) pen.fill = fill;
  stroke(n, pen, w, h, ctx, { sides: true });
  effects(n, pen, ctx);
  return pen;
}

function ellipse(n: FNode, parentLayout: Layout, ctx: ConvertCtx): PenNode {
  const w = num(n.size?.x), h = num(n.size?.y);
  const pen = base(n, 'ellipse', parentLayout, ctx, w, h);
  sizing(n, pen, parentLayout);
  const arc = n.arcData;
  if (arc) {
    const inner = num(arc.innerRadius);
    if (inner > 0) pen.innerRadius = Math.min(1, Math.round(inner * 10000) / 10000);
    const start = num(arc.startingAngle), end = num(arc.endingAngle, Math.PI * 2);
    const sweep = end - start;
    if (Math.abs(Math.abs(sweep) - Math.PI * 2) > 1e-3) {
      // Figma measures clockwise on screen, .pen counter-clockwise; both start at 3 o'clock.
      pen.startAngle = r2((-start * 180) / Math.PI);
      pen.sweepAngle = r2((-sweep * 180) / Math.PI);
    }
  }
  const fill = convertPaints(n.fillPaints, w, h, ctx);
  if (fill !== undefined) pen.fill = fill;
  stroke(n, pen, w, h, ctx, { caps: pen.sweepAngle !== undefined });
  effects(n, pen, ctx);
  return pen;
}

function line(n: FNode, parentLayout: Layout, ctx: ConvertCtx): PenNode {
  const w = num(n.size?.x), h = num(n.size?.y);
  const pen = base(n, 'line', parentLayout, ctx, w, h);
  sizing(n, pen, parentLayout);
  stroke(n, pen, w, h, ctx, { caps: true, align: 'center' });
  effects(n, pen, ctx);
  return pen;
}

type Piece = { d: string; evenodd: boolean; paints: any; strokeOnly?: boolean };

/** True when a stroke can be drawn by the editor itself (a centred line with plain ends), instead of as an outline. */
function plainStroke(n: FNode): boolean {
  if (n.strokeAlign !== undefined && n.strokeAlign !== 'CENTER') return false;
  if (n.strokeCap !== undefined && n.strokeCap !== 'NONE' && !CAP[n.strokeCap]) return false;
  if (Array.isArray(n.dashPattern) && n.dashPattern.some((v: any) => num(v) > 0)) return false;
  if (num(n.cornerRadius) > 0) return false;
  if (n.strokeBrushGuid || n.brushType || (Array.isArray(n.variableWidthPoints) && n.variableWidthPoints.length)) return false;
  for (const s of n.vectorData?.styleOverrideTable ?? []) {
    if (s && (s.strokeCap !== undefined || num(s.cornerRadius) > 0 || s.strokeWeight !== undefined || s.strokePaints !== undefined)) return false;
  }
  return true;
}

function geometryPieces(list: any, n: FNode, ctx: ConvertCtx, paintsFor: (styleId: number) => any): Piece[] {
  const out: Piece[] = [];
  if (!Array.isArray(list)) return out;
  for (const g of list) {
    const path = commandsToPath(ctx.scene.blobs[g?.commandsBlob]);
    if (!path) continue;
    const evenodd = g.windingRule === 'ODD';
    const paints = paintsFor(num(g.styleID));
    const last = out[out.length - 1];
    // Paths painted the same way become one path (its subpaths), as long as they fill by the same rule.
    if (last && last.paints === paints && last.evenodd === evenodd) last.d += path.d;
    else out.push({ d: path.d, evenodd, paints });
  }
  return out;
}

/** Vectors, boolean operations, stars and polygons: one or more .pen paths. */
function shape(n: FNode, parentLayout: Layout, ctx: ConvertCtx, depth: number): PenNode | null {
  const w = num(n.size?.x), h = num(n.size?.y);
  const styles = new Map<number, any>();
  for (const s of n.vectorData?.styleOverrideTable ?? []) if (s && typeof s.styleID === 'number') styles.set(s.styleID, s);
  const fillPaintsFor = (id: number) => styles.get(id)?.fillPaints ?? n.fillPaints;

  const norm = n.vectorData?.normalizedSize;
  const network = n.type === 'VECTOR' && typeof n.vectorData?.vectorNetworkBlob === 'number' ? decodeVectorNetwork(ctx.scene.blobs[n.vectorData.vectorNetworkBlob], norm && num(norm.x) ? w / norm.x : 1, norm && num(norm.y) ? h / norm.y : 1) : null;
  const stored = Array.isArray(n.fillGeometry) || Array.isArray(n.strokeGeometry);

  // The filled areas.
  let fills: Piece[] = geometryPieces(n.fillGeometry, n, ctx, fillPaintsFor);
  let outline: { d: string; allClosed: boolean } | null = null;
  if (!fills.length && !stored) {
    // Nothing stored (the clipboard does not carry outlines): rebuild what can be rebuilt.
    if (n.type === 'STAR') fills = [{ d: starPath(w, h, num(n.count, 5), num(n.starInnerScale, 0.382)), evenodd: false, paints: n.fillPaints }];
    else if (n.type === 'REGULAR_POLYGON') fills = [{ d: polygonPath(w, h, num(n.count, 3)), evenodd: false, paints: n.fillPaints }];
    else if (network) {
      fills = networkFills(network).map(f => ({ d: f.d, evenodd: f.evenodd, paints: fillPaintsFor(f.style) }));
      outline = networkOutline(network);
      // A network without regions still fills the shapes its closed lines make.
      if (!fills.length && outline.d && outline.allClosed) fills = [{ d: outline.d, evenodd: false, paints: n.fillPaints }];
    } else if (n.type === 'BOOLEAN_OPERATION') {
      ctx.notes.add('boolean operations without a stored outline (their shapes are kept as a group)');
      const pen = base(n, 'group', parentLayout, ctx, 0, 0);
      effects(n, pen, ctx);
      pen.children = children(n.kids, 'none', ctx, depth);
      return pen;
    }
    if (num(n.cornerRadius) > 0 && fills.length) ctx.notes.add('rounded corners on pasted vector shapes (drawn sharp)');
  }
  const unpainted = fills[0];
  fills = fills.filter(p => hasVisiblePaint(p.paints));

  // The stroke.
  const stroked = hasStroke(n);
  let strokeOnPath: string | null = null; // draw the stroke with the editor's own stroke, along this path
  let strokeOutline: Piece[] = [];
  if (stroked) {
    const plain = plainStroke(n);
    if (plain && n.type !== 'VECTOR' && fills.length === 1) {
      strokeOnPath = fills[0].d; // the shape's own outline is the line the stroke follows
    } else if (plain && network && (outline ??= networkOutline(network)).d) {
      // A closed shape with one filled area: its outline is the line. Otherwise stroke the network's lines.
      const loops = network.regions.length === 1 ? network.regions[0].loops.reduce((sum, l) => sum + l.length, 0) : -1;
      const sameLine = fills.length === 1 && outline.allClosed && (network.regions.length === 0 || loops === network.segments.length);
      strokeOnPath = sameLine ? fills[0].d : outline.d;
    } else {
      strokeOutline = geometryPieces(n.strokeGeometry, n, ctx, () => n.strokePaints);
      if (!strokeOutline.length) {
        // No stored outline of the stroke: stroke the best line we have, centred.
        strokeOnPath = network ? (outline ??= networkOutline(network)).d || null : (fills[0]?.d ?? null);
        if (strokeOnPath && !plain) ctx.notes.add('inside / outside or dashed strokes on pasted vector shapes (drawn as plain centred strokes)');
      }
    }
  }

  const pathNode = (id: string, name: string | undefined, d: string): PenNode => {
    const p: PenNode = { type: 'path', id };
    if (name) p.name = name;
    p.x = 0;
    p.y = 0;
    p.width = r2(w);
    p.height = r2(h);
    p.geometry = d;
    p.viewBox = [0, 0, r2(w), r2(h)];
    return p;
  };
  const paintFill = (p: PenNode, piece: Piece) => {
    const fill = convertPaints(piece.paints, w, h, ctx);
    if (fill !== undefined) p.fill = fill;
    if (piece.evenodd) p.fillRule = 'evenodd';
  };

  // One path is enough when there is a single filled area whose own outline carries the stroke, or only one thing to draw.
  const single = (fills.length === 1 && !strokeOutline.length && (!strokeOnPath || strokeOnPath === fills[0].d)) || (!fills.length && strokeOutline.length + (strokeOnPath ? 1 : 0) === 1) || (!fills.length && !strokeOutline.length && !strokeOnPath);
  if (single) {
    const pen = base(n, 'path', parentLayout, ctx, w, h);
    sizing(n, pen, parentLayout);
    if (fills.length) {
      pen.geometry = fills[0].d;
      paintFill(pen, fills[0]);
      if (strokeOnPath) stroke(n, pen, w, h, ctx, { caps: true, align: 'center' });
    } else if (strokeOnPath) {
      pen.geometry = strokeOnPath;
      stroke(n, pen, w, h, ctx, { caps: true, align: 'center' });
    } else if (strokeOutline.length) {
      pen.geometry = strokeOutline[0].d;
      paintFill(pen, strokeOutline[0]);
    } else {
      // Nothing visible to draw: keep the shape (and its hidden paints) so that it can be given a fill later.
      pen.geometry = unpainted?.d ?? outline?.d ?? '';
      if (unpainted) paintFill(pen, unpainted);
    }
    pen.viewBox = [0, 0, r2(w), r2(h)];
    effects(n, pen, ctx);
    return pen;
  }

  // Otherwise a group: filled areas first, the stroke on top.
  const pen = base(n, 'group', parentLayout, ctx, w, h);
  const flipX = pen.flipX === true, flipY = pen.flipY === true;
  delete pen.flipX;
  delete pen.flipY;
  effects(n, pen, ctx);
  const kids: PenNode[] = [];
  fills.forEach((piece, i) => {
    const p = pathNode(uniqueId(ctx, `${pen.id}_fill${fills.length > 1 ? i + 1 : ''}`), fills.length > 1 ? `Fill ${i + 1}` : 'Fill', piece.d);
    paintFill(p, piece);
    kids.push(p);
  });
  strokeOutline.forEach((piece, i) => {
    const p = pathNode(uniqueId(ctx, `${pen.id}_stroke${strokeOutline.length > 1 ? i + 1 : ''}`), 'Stroke', piece.d);
    paintFill(p, piece);
    kids.push(p);
  });
  if (strokeOnPath) {
    const p = pathNode(uniqueId(ctx, `${pen.id}_stroke`), 'Stroke', strokeOnPath);
    stroke(n, p, w, h, ctx, { caps: true, align: 'center' });
    kids.push(p);
  }
  for (const k of kids) {
    if (flipX) k.flipX = true;
    if (flipY) k.flipY = true;
  }
  pen.children = kids;
  return pen;
}

// ---------- dispatch ----------

const SILENT = new Set(['SLICE', 'VARIABLE', 'VARIABLE_SET', 'VARIABLE_OVERRIDE', 'BRUSH', 'CODE_LIBRARY', 'CODE_FILE', 'MODULE', 'MANAGED_STRING', 'KEYFRAME', 'KEYFRAME_TRACK', 'ANIMATION_PRESET_INSTANCE']);

export function convertNode(n: FNode, parentLayout: Layout, ctx: ConvertCtx, depth = 0): PenNode | null {
  // An instance is rebuilt from its main component first: that can also change the instance layer itself.
  const expanded = n.type === 'INSTANCE' ? instanceChildren(ctx.scene, n, ctx.notes) : null;
  const outer = ctx.modes;
  ctx.modes = modeScope(ctx.scene, n, outer);
  try {
    return convertKind(n, parentLayout, ctx, depth, expanded);
  } finally {
    ctx.modes = outer;
  }
}

function convertKind(n: FNode, parentLayout: Layout, ctx: ConvertCtx, depth: number, expanded: Expanded | null): PenNode | null {
  switch (n.type) {
    case 'FRAME':
    case 'GROUP':
    case 'SYMBOL':
    case 'INSTANCE':
    case 'SECTION':
      return container(n, parentLayout, ctx, depth, expanded);
    case 'RECTANGLE':
    case 'ROUNDED_RECTANGLE':
      return rectangle(n, parentLayout, ctx);
    case 'ELLIPSE':
      return ellipse(n, parentLayout, ctx);
    case 'LINE':
      return line(n, parentLayout, ctx);
    case 'VECTOR':
    case 'STAR':
    case 'REGULAR_POLYGON':
    case 'BOOLEAN_OPERATION':
      return shape(n, parentLayout, ctx, depth);
    case 'TEXT': {
      const w = num(n.size?.x), h = num(n.size?.y);
      const pen = base(n, 'text', parentLayout, ctx, w, h);
      convertText(n, pen, ctx, (p, hugW, hugH) => {
        sizing(n, p, parentLayout);
        if (hugW) delete p.width;
        if (hugH) delete p.height;
      });
      stroke(n, pen, w, h, ctx);
      effects(n, pen, ctx);
      return pen;
    }
    default:
      if (n.type && !SILENT.has(n.type)) ctx.notes.add(`${n.type.toLowerCase().replace(/_/g, ' ')} layers (left out)`);
      return null;
  }
}

/** True for node types that become something on the canvas. */
export function isConvertible(n: FNode): boolean {
  return ['FRAME', 'GROUP', 'SYMBOL', 'INSTANCE', 'SECTION', 'RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE', 'LINE', 'VECTOR', 'STAR', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION', 'TEXT'].includes(n.type ?? '');
}
