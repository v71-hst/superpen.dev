// Converts .pen fills, strokes and effects (already variable-resolved) into CSS / SVG paint.
import type { CSSProperties } from 'react';

export type RGBA = { r: number; g: number; b: number; a: number };

export function parseColor(c: any): RGBA | null {
  if (typeof c !== 'string') return null;
  let s = c.trim();
  if (s[0] !== '#') {
    const m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
    }
    return null;
  }
  s = s.slice(1);
  if (s.length === 3 || s.length === 4) s = s.split('').map(ch => ch + ch).join('');
  if (s.length !== 6 && s.length !== 8) return null;
  const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: s.length === 8 ? n(6) / 255 : 1 };
}

export function rgbaCss(c: RGBA, alphaMul = 1): string {
  const a = Math.round(c.a * alphaMul * 1000) / 1000;
  return a >= 1 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${a})`;
}

export function colorCss(c: any, alphaMul = 1): string {
  const p = parseColor(c);
  if (!p) return typeof c === 'string' ? c : 'transparent';
  return rgbaCss(p, alphaMul);
}

export function toHex(c: RGBA, withAlpha = true): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase();
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return withAlpha && c.a < 1 ? base + h(c.a * 255) : base;
}

export type Fill = any;

export function fillList(f: any): Fill[] {
  if (f === undefined || f === null || f === '') return [];
  return Array.isArray(f) ? f : [f];
}

export function isEnabled(f: Fill): boolean {
  return !(f && typeof f === 'object' && f.enabled === false);
}

export function fillKind(f: Fill): string {
  if (typeof f === 'string') return 'color';
  return f?.type ?? 'color';
}

const num = (v: any, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);

/** First solid color of a fill list (used for text/icon colors and fallbacks). */
export function primaryColor(fills: Fill[]): string | null {
  for (let i = fills.length - 1; i >= 0; i--) {
    const f = fills[i];
    if (!isEnabled(f)) continue;
    if (typeof f === 'string') return colorCss(f);
    if (f.type === 'color') return colorCss(f.color);
    if (f.type === 'gradient' && f.colors?.length) return colorCss(f.colors[0].color, num(f.opacity, 1));
  }
  return null;
}

type Stop = { color: string; position: number };

function stops(f: any, map: (t: number) => number = t => t, unit = '%'): string {
  const op = num(f.opacity, 1);
  const list: Stop[] = (f.colors ?? []).slice().sort((a: Stop, b: Stop) => num(a.position, 0) - num(b.position, 0));
  if (!list.length) return 'transparent, transparent';
  if (list.length === 1) list.push(list[0]);
  return list.map(s => `${colorCss(s.color, op)} ${round(map(num(s.position, 0)) * 100)}${unit}`).join(', ');
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Linear gradient endpoints in normalized bbox space (pen: rotation CCW, 0° = up). */
export function linearEndpoints(f: any) {
  const r = (num(f.rotation, 0) * Math.PI) / 180;
  const cx = num(f.center?.x, 0.5);
  const cy = num(f.center?.y, 0.5);
  const len = num(f.size?.height, 1);
  const dx = -Math.sin(r);
  const dy = -Math.cos(r);
  return { x1: cx - (dx * len) / 2, y1: cy - (dy * len) / 2, x2: cx + (dx * len) / 2, y2: cy + (dy * len) / 2, dx, dy };
}

function linearCss(f: any, w: number, h: number): string {
  const { x1, y1, x2, y2, dx, dy } = linearEndpoints(f);
  w = w || 1;
  h = h || 1;
  // Isolines are perpendicular in normalized space; find the matching pixel-space gradient normal.
  let gx = dx * h;
  let gy = dy * w;
  const gl = Math.hypot(gx, gy) || 1;
  gx /= gl;
  gy /= gl;
  const theta = Math.atan2(gx, -gy);
  const lineLen = Math.abs(w * Math.sin(theta)) + Math.abs(h * Math.cos(theta));
  const P0 = { x: x1 * w, y: y1 * h };
  const P1 = { x: x2 * w, y: y2 * h };
  const a = ((P0.x - w / 2) * gx + (P0.y - h / 2) * gy) / lineLen + 0.5;
  const b = ((P1.x - P0.x) * gx + (P1.y - P0.y) * gy) / lineLen;
  return `linear-gradient(${round((theta * 180) / Math.PI)}deg, ${stops(f, t => a + b * t)})`;
}

function radialCss(f: any, w: number, h: number): string {
  const cx = num(f.center?.x, 0.5);
  const cy = num(f.center?.y, 0.5);
  const rx = (num(f.size?.width, 1) * (w || 1)) / 2;
  const ry = (num(f.size?.height, 1) * (h || 1)) / 2;
  return `radial-gradient(${round(Math.max(rx, 0.01))}px ${round(Math.max(ry, 0.01))}px at ${round(cx * 100)}% ${round(cy * 100)}%, ${stops(f)})`;
}

function angularCss(f: any): string {
  const cx = num(f.center?.x, 0.5);
  const cy = num(f.center?.y, 0.5);
  return `conic-gradient(from ${round(-num(f.rotation, 0))}deg at ${round(cx * 100)}% ${round(cy * 100)}%, ${stops(f)})`;
}

function meshCss(f: any): string {
  const cols: string[] = (f.colors ?? []).map((c: any) => colorCss(c, num(f.opacity, 1)));
  const n = num(f.columns, 2);
  const m = num(f.rows, 2);
  if (cols.length < 4) return `linear-gradient(${cols[0] ?? 'transparent'}, ${cols[0] ?? 'transparent'})`;
  const tl = cols[0];
  const tr = cols[n - 1];
  const bl = cols[(m - 1) * n];
  const br = cols[m * n - 1];
  return `linear-gradient(to bottom, transparent, ${br}), linear-gradient(to right, ${tl}, ${tr}), linear-gradient(to right, ${bl}, ${br})`;
}

export type CssLayer = { image: string; size?: string; position?: string; repeat?: string; blend?: string };

export function fillToLayers(f: Fill, w: number, h: number, resolveUrl: (u: string) => string): CssLayer[] {
  if (!isEnabled(f)) return [];
  if (typeof f === 'string') {
    const c = colorCss(f);
    return [{ image: `linear-gradient(${c}, ${c})` }];
  }
  const blend = f.blendMode && f.blendMode !== 'normal' ? cssBlend(f.blendMode) : undefined;
  switch (f.type) {
    case 'color': {
      const c = colorCss(f.color);
      return [{ image: `linear-gradient(${c}, ${c})`, blend }];
    }
    case 'gradient': {
      const t = f.gradientType ?? 'linear';
      const img = t === 'radial' ? radialCss(f, w, h) : t === 'angular' ? angularCss(f) : linearCss(f, w, h);
      return [{ image: img, blend }];
    }
    case 'image': {
      if (!f.url) return [];
      const mode = f.mode ?? 'cover';
      const size = mode === 'stretch' ? '100% 100%' : mode;
      return [{ image: `url("${resolveUrl(f.url)}")`, size, position: 'center', repeat: 'no-repeat', blend }];
    }
    case 'mesh_gradient':
      return meshCss(f)
        .split(/,\s(?=linear)/)
        .map(image => ({ image, blend }));
    default:
      return [];
  }
}

export function fillsToBackground(fills: Fill[], w: number, h: number, resolveUrl: (u: string) => string, opacityMul = 1): CSSProperties {
  const layers: CssLayer[] = [];
  for (const f of fills) layers.push(...fillToLayers(f, w, h, resolveUrl));
  if (!layers.length) return {};
  layers.reverse(); // pen paints the last fill on top; CSS paints the first layer on top
  const style: CSSProperties = {
    backgroundImage: layers.map(l => l.image).join(', '),
    backgroundSize: layers.map(l => l.size ?? '100% 100%').join(', '),
    backgroundPosition: layers.map(l => l.position ?? '0 0').join(', '),
    backgroundRepeat: layers.map(l => l.repeat ?? 'no-repeat').join(', '),
  };
  if (layers.some(l => l.blend)) style.backgroundBlendMode = layers.map(l => l.blend ?? 'normal').join(', ');
  if (opacityMul !== 1) style.opacity = opacityMul;
  return style;
}

export function cssBlend(m: string): string {
  const map: Record<string, string> = {
    linearBurn: 'color-burn',
    colorBurn: 'color-burn',
    linearDodge: 'color-dodge',
    colorDodge: 'color-dodge',
    softLight: 'soft-light',
    hardLight: 'hard-light',
    light: 'lighten',
    normal: 'normal',
  };
  return map[m] ?? m.replace(/[A-Z]/g, c => '-' + c.toLowerCase());
}

// ---------- strokes ----------

export type StrokeInfo = {
  fills: Fill[];
  width: number | { top: number; right: number; bottom: number; left: number };
  align: 'inner' | 'center' | 'outer';
  cap?: string;
  join?: string;
};

export function normalizeStroke(p: any, defaultAlign: StrokeInfo['align']): StrokeInfo | null {
  let s = p.stroke;
  let width = p.strokeWidth;
  let align = p.strokeAlignment;
  if (s && typeof s === 'object' && !Array.isArray(s) && ('thickness' in s || 'align' in s || ('fill' in s && !s.type))) {
    // Legacy stroke object: { align, thickness, fill }
    width = width ?? s.thickness;
    align = align ?? s.align;
    s = s.fill;
  }
  const fills = fillList(s).filter(isEnabled);
  if (!fills.length) return null;
  let w: StrokeInfo['width'];
  if (width && typeof width === 'object') {
    w = { top: num(width.top, 0), right: num(width.right, 0), bottom: num(width.bottom, 0), left: num(width.left, 0) };
    if (!w.top && !w.right && !w.bottom && !w.left) return null;
  } else {
    w = num(width, 1);
    if (w <= 0) return null;
  }
  const a = align === 'inside' ? 'inner' : align === 'outside' ? 'outer' : align;
  return { fills, width: w, align: a === 'inner' || a === 'outer' || a === 'center' ? a : defaultAlign, cap: p.strokeLinecap, join: p.strokeLinejoin };
}

// ---------- effects ----------

export function effectList(e: any): any[] {
  return (e === undefined || e === null ? [] : Array.isArray(e) ? e : [e]).filter(x => x && x.enabled !== false);
}
