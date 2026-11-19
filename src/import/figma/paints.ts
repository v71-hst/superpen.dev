// Figma paints and effects -> .pen fills, strokes and effects.

export type Notes = { add(kind: string, n?: number): void };

/** An image fill that still needs its file: the importer fills in the real url (or a placeholder) at the end. */
export type ImageUse = { fill: any; hash: string; blob?: number };

export type PaintCtx = {
  notes: Notes;
  images: ImageUse[];
  /** Looks up the colour a variable binding stands for where the layer being converted is (null: use the stored copy). */
  colorOf?: (binding: any) => { r: number; g: number; b: number; a: number } | null;
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const hex2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0').toUpperCase();
const num = (v: any, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
const round = (v: number, p = 100) => Math.round(v * p) / p;

export function colorHex(c: any, alphaMul = 1): string {
  if (!c) return '#000000';
  const a = clamp01(num(c.a, 1) * alphaMul);
  const base = `#${hex2(num(c.r, 0))}${hex2(num(c.g, 0))}${hex2(num(c.b, 0))}`;
  return a >= 0.999 ? base : base + hex2(a);
}

const BLEND: Record<string, string> = {
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  LINEAR_BURN: 'linearBurn',
  COLOR_BURN: 'colorBurn',
  LIGHTEN: 'light',
  SCREEN: 'screen',
  LINEAR_DODGE: 'linearDodge',
  COLOR_DODGE: 'colorDodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'softLight',
  HARD_LIGHT: 'hardLight',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

/** .pen blend mode name, or undefined for normal / pass-through. */
export function blendName(mode: any): string | undefined {
  return typeof mode === 'string' ? BLEND[mode] : undefined;
}

export function hexOf(bytes: any): string {
  if (!bytes || typeof bytes.length !== 'number') return '';
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

type M = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number };
const IDENTITY: M = { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };

function invert(m: M): M | null {
  const det = m.m00 * m.m11 - m.m01 * m.m10;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  const a = m.m11 / det, b = -m.m01 / det, c = -m.m10 / det, d = m.m00 / det;
  return { m00: a, m01: b, m02: -(a * m.m02 + b * m.m12), m10: c, m11: d, m12: -(c * m.m02 + d * m.m12) };
}

function stopsOf(p: any): { color: string; position: number }[] {
  const stops = Array.isArray(p.stops) ? p.stops : [];
  return stops.map((s: any) => ({ color: colorHex(s.color), position: round(clamp01(num(s.position, 0)), 10000) }));
}

/**
 * A Figma gradient's `transform` maps the node's box (0..1 on both axes) into gradient space, where a linear
 * gradient runs from x=0 to x=1, and radial / angular / diamond ones are centred on (0.5, 0.5) with radius 0.5.
 * A .pen gradient is described in the box instead: a centre, a rotation (degrees counter-clockwise, 0 = up) and a
 * size, with the gradient's lines of equal colour at right angles to its direction in the 0..1 box.
 */
function gradient(p: any, w: number, h: number, ctx: PaintCtx): any | null {
  const colors = stopsOf(p);
  if (!colors.length) return null;
  const t: M = p.transform ?? IDENTITY;
  const out: any = { type: 'gradient' };
  if (p.type === 'GRADIENT_LINEAR') {
    // Only the first row matters: position along the gradient = a*u + b*v + c for a box point (u, v).
    const a = num(t.m00, 1), b = num(t.m01, 0), c = num(t.m02, 0);
    const len2 = a * a + b * b;
    if (len2 < 1e-12) return null;
    // Moving by (dx, dy) takes the position from 0 to 1.
    const dx = a / len2, dy = b / len2;
    const mid = 0.5 - (a * 0.5 + b * 0.5 + c);
    out.gradientType = 'linear';
    out.rotation = round((Math.atan2(-dx, -dy) * 180) / Math.PI);
    out.center = { x: round(0.5 + mid * dx, 10000), y: round(0.5 + mid * dy, 10000) };
    out.size = { height: round(Math.hypot(dx, dy), 10000) };
  } else {
    const inv = invert({ m00: num(t.m00, 1), m01: num(t.m01, 0), m02: num(t.m02, 0), m10: num(t.m10, 0), m11: num(t.m11, 1), m12: num(t.m12, 0) });
    if (!inv) return null;
    const cx = inv.m00 * 0.5 + inv.m01 * 0.5 + inv.m02;
    const cy = inv.m10 * 0.5 + inv.m11 * 0.5 + inv.m12;
    // The two half-axes of the gradient's ellipse, in box units.
    const ax = inv.m00 * 0.5, ay = inv.m10 * 0.5;
    const bx = inv.m01 * 0.5, by = inv.m11 * 0.5;
    out.center = { x: round(cx, 10000), y: round(cy, 10000) };
    if (p.type === 'GRADIENT_ANGULAR') {
      out.gradientType = 'angular';
      // Figma starts along the first axis and turns towards the second; .pen starts at the top and turns clockwise.
      const from = (Math.atan2(ax * (w || 1), -ay * (h || 1)) * 180) / Math.PI;
      out.rotation = round(-from);
      const clockwise = ax * (w || 1) * by * (h || 1) - ay * (h || 1) * bx * (w || 1) > 0;
      if (!clockwise) for (const s of colors) s.position = round(1 - s.position, 10000);
    } else {
      if (p.type === 'GRADIENT_DIAMOND') ctx.notes.add('diamond gradients (drawn as radial)');
      out.gradientType = 'radial';
      out.size = { width: round(Math.hypot(ax, ay) * 2, 10000), height: round(Math.hypot(bx, by) * 2, 10000) };
      // .pen rotates the ellipse in the 0..1 box, before the box is stretched to the node's size.
      const rot = round((-Math.atan2(ay, ax) * 180) / Math.PI);
      // A rotation only matters when the ellipse is not axis-aligned.
      if (Math.abs(rot % 90) > 0.01) out.rotation = rot;
      else if (Math.abs(Math.abs(rot) - 90) < 0.01) out.size = { width: out.size.height, height: out.size.width };
    }
  }
  colors.sort((x, y) => x.position - y.position);
  out.colors = colors;
  return out;
}

function imageFill(p: any, ctx: PaintCtx): any | null {
  const hash = hexOf(p.image?.hash);
  const blob = typeof p.image?.dataBlob === 'number' ? p.image.dataBlob : undefined;
  if (!hash && blob === undefined) {
    ctx.notes.add('image fills without image data');
    return null;
  }
  const out: any = { type: 'image', url: '', mode: 'cover' };
  switch (p.imageScaleMode) {
    case 'FIT':
      out.mode = 'contain';
      break;
    case 'STRETCH': {
      // Figma's "crop": the image is placed by a matrix from the box (0..1) into the image (0..1).
      out.mode = 'stretch';
      const t = p.transform;
      if (t && !(near(t.m00, 1) && near(t.m11, 1) && near(t.m01, 0) && near(t.m10, 0) && near(t.m02, 0) && near(t.m12, 0))) {
        out.transform = [t.m00, t.m10, t.m01, t.m11, t.m02, t.m12].map(v => round(num(v, 0), 100000));
        ctx.notes.add('cropped image fills (crop matrix kept, check the framing)');
      }
      break;
    }
    case 'TILE':
      ctx.notes.add('tiled image fills (drawn as cover)');
      break;
    default:
      break; // FILL
  }
  if (num(p.rotation, 0)) ctx.notes.add('rotated image fills (rotation dropped)');
  ctx.images.push({ fill: out, hash: hash || `blob${blob}`, blob });
  return out;
}

const near = (v: any, target: number) => Math.abs(num(v, target) - target) < 1e-4;

/** One Figma paint -> one .pen fill (null when it cannot be represented). */
function paint(p: any, w: number, h: number, ctx: PaintCtx): any | null {
  if (!p || typeof p !== 'object') return null;
  const opacity = clamp01(num(p.opacity, 1));
  const visible = p.visible !== false;
  const blend = blendName(p.blendMode);
  let out: any;
  switch (p.type) {
    case 'SOLID': {
      const color = colorHex((p.colorVar && ctx.colorOf?.(p.colorVar)) || p.color, opacity);
      if (visible && !blend) return color;
      out = { type: 'color', color };
      break;
    }
    case 'GRADIENT_LINEAR':
    case 'GRADIENT_RADIAL':
    case 'GRADIENT_ANGULAR':
    case 'GRADIENT_DIAMOND':
      out = gradient(p, w, h, ctx);
      if (!out) return null;
      if (opacity < 0.999) out.opacity = round(opacity, 1000);
      break;
    case 'IMAGE':
      out = imageFill(p, ctx);
      if (!out) return null;
      if (opacity < 0.999) out.opacity = round(opacity, 1000);
      break;
    default:
      // EMOJI, VIDEO, PATTERN, NOISE and whatever comes later.
      if (visible) ctx.notes.add(`${String(p.type ?? 'unknown').toLowerCase()} fills (left out)`);
      return null;
  }
  if (!visible) out.enabled = false;
  if (blend) out.blendMode = blend;
  return out;
}

/** A list of Figma paints -> a .pen `fill` / `stroke` value (undefined when there is nothing to paint). */
export function convertPaints(paints: any, w: number, h: number, ctx: PaintCtx): any {
  if (!Array.isArray(paints) || !paints.length) return undefined;
  const out: any[] = [];
  for (const p of paints) {
    const f = paint(p, w, h, ctx);
    if (f !== null) out.push(f);
  }
  if (!out.length) return undefined;
  return out.length === 1 ? out[0] : out;
}

export function hasVisiblePaint(paints: any): boolean {
  return Array.isArray(paints) && paints.some(p => p && p.visible !== false && num(p.opacity, 1) > 0);
}

/** Figma effects -> a .pen `effect` value. Blur radii mean the same in both formats. */
export function convertEffects(effects: any, ctx: PaintCtx): any {
  if (!Array.isArray(effects) || !effects.length) return undefined;
  const out: any[] = [];
  for (const e of effects) {
    if (!e || typeof e !== 'object') continue;
    let fx: any;
    switch (e.type) {
      case 'DROP_SHADOW':
      case 'INNER_SHADOW':
        fx = {
          type: 'shadow',
          shadowType: e.type === 'INNER_SHADOW' ? 'inner' : 'outer',
          offset: { x: round(num(e.offset?.x, 0)), y: round(num(e.offset?.y, 0)) },
          blur: round(num(e.radius, 0)),
          spread: round(num(e.spread, 0)),
          color: colorHex((e.colorVar && ctx.colorOf?.(e.colorVar)) || e.color || { r: 0, g: 0, b: 0, a: 0.25 }),
        };
        break;
      case 'FOREGROUND_BLUR':
        fx = { type: 'blur', radius: round(num(e.radius, 0)) };
        break;
      case 'BACKGROUND_BLUR':
        fx = { type: 'background_blur', radius: round(num(e.radius, 0)) };
        break;
      default:
        if (e.visible !== false) ctx.notes.add(`${String(e.type ?? 'unknown').toLowerCase().replace(/_/g, ' ')} effects (left out)`);
        continue;
    }
    if (e.visible === false) fx.enabled = false;
    out.push(fx);
  }
  if (!out.length) return undefined;
  return out.length === 1 ? out[0] : out;
}
