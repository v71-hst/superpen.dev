// SVG path builders for ellipses/arcs, polygons and .pen path geometry mapped onto a node box.
import svgpath from 'svgpath';
import { svgPathBbox } from 'svg-path-bbox';

const f = (n: number) => Math.round(n * 1000) / 1000;

function ellipsePath(cx: number, cy: number, rx: number, ry: number): string {
  if (rx <= 0 || ry <= 0) return '';
  return `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`;
}

export function ellipseGeometry(w: number, h: number, innerRadius = 0, startAngle = 0, sweepAngle = 360): string {
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const ir = Math.max(0, Math.min(1, innerRadius || 0));
  const sweep = Math.max(-360, Math.min(360, sweepAngle ?? 360));
  if (Math.abs(sweep) >= 360) {
    return ellipsePath(cx, cy, rx, ry) + (ir > 0 ? ellipsePath(cx, cy, rx * ir, ry * ir) : '');
  }
  // Angles are CCW from the positive x axis, with y pointing down on screen.
  const pt = (a: number, k: number) => {
    const r = (a * Math.PI) / 180;
    return [cx + rx * k * Math.cos(r), cy - ry * k * Math.sin(r)];
  };
  const a0 = startAngle || 0;
  const a1 = a0 + sweep;
  const large = Math.abs(sweep) > 180 ? 1 : 0;
  const sw = sweep > 0 ? 0 : 1; // CCW on screen = sweep-flag 0
  const [x0, y0] = pt(a0, 1);
  const [x1, y1] = pt(a1, 1);
  let d = `M${f(x0)} ${f(y0)}A${f(rx)} ${f(ry)} 0 ${large} ${sw} ${f(x1)} ${f(y1)}`;
  if (ir > 0) {
    const [ix1, iy1] = pt(a1, ir);
    const [ix0, iy0] = pt(a0, ir);
    d += `L${f(ix1)} ${f(iy1)}A${f(rx * ir)} ${f(ry * ir)} 0 ${large} ${1 - sw} ${f(ix0)} ${f(iy0)}Z`;
  } else {
    d += `L${f(cx)} ${f(cy)}Z`;
  }
  return d;
}

export function polygonGeometry(w: number, h: number, count = 3, cornerRadius = 0): string {
  const k = Math.max(3, Math.round(count || 3));
  const raw: [number, number][] = [];
  for (let i = 0; i < k; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / k;
    raw.push([Math.cos(a), Math.sin(a)]);
  }
  const minX = Math.min(...raw.map(p => p[0]));
  const maxX = Math.max(...raw.map(p => p[0]));
  const minY = Math.min(...raw.map(p => p[1]));
  const maxY = Math.max(...raw.map(p => p[1]));
  const pts = raw.map(([x, y]) => [((x - minX) / (maxX - minX)) * w, ((y - minY) / (maxY - minY)) * h] as [number, number]);
  if (!cornerRadius) return 'M' + pts.map(p => `${f(p[0])} ${f(p[1])}`).join('L') + 'Z';
  let d = '';
  for (let i = 0; i < k; i++) {
    const p = pts[i];
    const prev = pts[(i - 1 + k) % k];
    const next = pts[(i + 1) % k];
    const toward = (a: [number, number], b: [number, number], dist: number) => {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t = Math.min(dist, len / 2) / len;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    const s = toward(p, prev, cornerRadius);
    const e = toward(p, next, cornerRadius);
    d += `${i === 0 ? 'M' : 'L'}${f(s[0])} ${f(s[1])}Q${f(p[0])} ${f(p[1])} ${f(e[0])} ${f(e[1])}`;
  }
  return d + 'Z';
}

const bboxCache = new Map<string, [number, number, number, number]>();

export function pathBox(geometry: string): [number, number, number, number] {
  let b = bboxCache.get(geometry);
  if (!b) {
    try {
      const [x0, y0, x1, y1] = svgPathBbox(geometry);
      b = [x0, y0, x1 - x0, y1 - y0];
    } catch {
      b = [0, 0, 0, 0];
    }
    if (bboxCache.size > 5000) bboxCache.clear();
    bboxCache.set(geometry, b);
  }
  return b;
}

/** Maps pen path geometry (in its viewBox space) onto a w×h box without scaling stroke widths. */
export function pathGeometry(geometry: string, w: number, h: number, viewBox?: number[]): string {
  if (!geometry) return '';
  const vb = Array.isArray(viewBox) && viewBox.length === 4 ? viewBox : pathBox(geometry);
  const sx = vb[2] ? w / vb[2] : 1;
  const sy = vb[3] ? h / vb[3] : 1;
  try {
    return svgpath(geometry).translate(-vb[0], -vb[1]).scale(sx, sy).round(3).toString();
  } catch {
    return '';
  }
}
