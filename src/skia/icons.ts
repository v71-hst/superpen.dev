// Lucide and Feather icons as SVG path strings (24×24 viewBox, stroked), for Skia. Lucide components carry their
// shape list (`iconNode`) on the element they render; Feather ships SVG markup. Icon fonts (Material Symbols,
// Phosphor) are drawn as text in their font (fonts.ts requestIconFont, painter.ts drawIcon).
import feather from 'feather-icons';
import { lucideIcon } from '../render/NodeView';
import { isIconFont, requestIconFont } from './fonts';

const cache = new Map<string, string[] | null>();

type El = [string, Record<string, any>];

const n = (v: any) => Number(v) || 0;

function elementPath([tag, a]: El): string | null {
  switch (tag) {
    case 'path':
      return a.d ?? null;
    case 'circle':
      return ellipse(n(a.cx), n(a.cy), n(a.r), n(a.r));
    case 'ellipse':
      return ellipse(n(a.cx), n(a.cy), n(a.rx), n(a.ry));
    case 'line':
      return `M${n(a.x1)} ${n(a.y1)}L${n(a.x2)} ${n(a.y2)}`;
    case 'polyline':
    case 'polygon': {
      const pts = String(a.points ?? '').trim().split(/[\s,]+/).map(Number);
      if (pts.length < 4) return null;
      let d = `M${pts[0]} ${pts[1]}`;
      for (let i = 2; i + 1 < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`;
      return tag === 'polygon' ? d + 'Z' : d;
    }
    case 'rect': {
      const x = n(a.x), y = n(a.y), w = n(a.width), h = n(a.height);
      let rx = a.rx !== undefined ? n(a.rx) : a.ry !== undefined ? n(a.ry) : 0;
      let ry = a.ry !== undefined ? n(a.ry) : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    default:
      return null;
  }
}

function ellipse(cx: number, cy: number, rx: number, ry: number) {
  return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
}

function lucideNodes(name: string): El[] | null {
  const C: any = lucideIcon(name);
  if (!C) return null;
  try {
    // forwardRef component: its render function returns <Icon iconNode={...} />.
    const el = typeof C.render === 'function' ? C.render({}, null) : null;
    const nodes = el?.props?.iconNode;
    return Array.isArray(nodes) ? nodes : null;
  } catch {
    return null;
  }
}

function featherNodes(name: string): El[] | null {
  const ic = (feather.icons as any)[name];
  if (!ic) return null;
  const doc = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">${ic.contents}</svg>`, 'image/svg+xml');
  return [...doc.documentElement.children].map(e => [e.tagName, Object.fromEntries([...e.attributes].map(a => [a.name, a.value]))] as El);
}

/** Path strings of an icon in its 24×24 box, or null if the library/name is unknown (a missing glyph is drawn). */
export function iconPaths(library: string, name: string): string[] | null {
  const lib = library.toLowerCase();
  const k = `${lib}:${name}`;
  if (!cache.has(k)) {
    const nodes = lib === 'lucide' ? lucideNodes(name) : lib === 'feather' ? featherNodes(name) : null;
    cache.set(k, nodes ? (nodes.map(elementPath).filter(Boolean) as string[]) : null);
  }
  return cache.get(k)!;
}

/**
 * Whether an icon is drawn as the missing-glyph box (the page-element renderer marked it data-missing): a Lucide or
 * Feather name that does not exist, or a library no one knows. Icon fonts are not checked (an unknown name shows as
 * text or nothing there too).
 */
export function iconMissing(library: string, name: string): boolean {
  if (isIconFont(library)) return false;
  return iconPaths(library, name) === null;
}

/**
 * Why Skia cannot draw icons from this library now: null when it can. Icon fonts (Material Symbols, Phosphor) are
 * drawn as text once their font has loaded; an unknown library is drawn as a missing glyph, as on the page.
 */
export function iconLibraryBlocker(library: string): string | null {
  if (!isIconFont(library)) return null;
  const st = requestIconFont(library);
  if (st === 'ready') return null;
  return st === 'loading' ? `icon font "${library}" loading` : `icon font "${library}" could not be loaded`;
}
