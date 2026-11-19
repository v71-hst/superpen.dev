// Mesh gradients (pen.dev's `mesh_gradient` fill): a grid of columns × rows points, each with a colour, a position
// in the unit box and four handles (relative offsets) that bend the patch edges that meet at it. Each cell of the
// grid is a Coons patch between its four edge curves, with the corner colours blended across it. Both renderers
// draw the same tessellation: the DOM renderer as a small bitmap used as a background, Skia as coloured triangles.
import { parseColor } from './paint';

export type V2 = [number, number];
export type MeshPoint = { x: number; y: number; left: V2; right: V2; top: V2; bottom: V2; /** Handles written in the file (the others are automatic). */ own: { left?: boolean; right?: boolean; top?: boolean; bottom?: boolean } };
export type Mesh = { cols: number; rows: number; points: MeshPoint[] };

const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const v2 = (v: unknown): V2 | null => (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number' ? [v[0], v[1]] : v && typeof v === 'object' && typeof (v as any).x === 'number' ? [(v as any).x, (v as any).y] : null);

/** The grid of a mesh fill: positions default to an even grid, missing handles point a third of the way to the neighbour. */
export function meshOf(f: any): Mesh {
  const cols = Math.max(2, Math.round(num(f?.columns, 2))), rows = Math.max(2, Math.round(num(f?.rows, 2)));
  const raw: any[] = Array.isArray(f?.points) ? f.points : [];
  const points: MeshPoint[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const p = raw[r * cols + c];
      const pos = v2(p) ?? v2(p?.position) ?? [c / (cols - 1), r / (rows - 1)];
      points.push({ x: pos[0], y: pos[1], left: [0, 0], right: [0, 0], top: [0, 0], bottom: [0, 0], own: {} });
    }
  const at = (r: number, c: number) => (r >= 0 && c >= 0 && r < rows && c < cols ? points[r * cols + c] : null);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const p = points[r * cols + c];
      const src = raw[r * cols + c];
      const side = (name: 'left' | 'right' | 'top' | 'bottom', n: MeshPoint | null) => {
        const given = src && typeof src === 'object' && !Array.isArray(src) ? v2(src[name + 'Handle']) : null;
        if (given) {
          p[name] = given;
          p.own[name] = true;
        } else if (n) p[name] = [(n.x - p.x) / 3, (n.y - p.y) / 3];
      };
      side('left', at(r, c - 1));
      side('right', at(r, c + 1));
      side('top', at(r - 1, c));
      side('bottom', at(r + 1, c));
    }
  return { cols, rows, points };
}

/** The mesh back as the file's `points`: plain [x, y] where a point has no handles of its own. */
export function meshToPoints(m: Mesh): any[] {
  const r4 = (v: number) => Math.round(v * 10000) / 10000;
  return m.points.map(p => {
    const pos = [r4(p.x), r4(p.y)];
    if (!p.own.left && !p.own.right && !p.own.top && !p.own.bottom) return pos;
    const out: any = { position: pos };
    for (const k of ['left', 'right', 'top', 'bottom'] as const) if (p.own[k]) out[k + 'Handle'] = [r4(p[k][0]), r4(p[k][1])];
    return out;
  });
}

const bez = (a: number, b: number, c: number, d: number, t: number) => {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
};

/**
 * The mesh as triangles in the unit box: positions (x, y per vertex), colours (r, g, b, a in 0..1 per vertex, not
 * premultiplied) and indices. `n` segments per cell edge. `colors`: one CSS colour per point (already resolved).
 */
export function tessellate(m: Mesh, colors: string[], n = 12, opacity = 1): { positions: Float32Array; colors: Float32Array; indices: number[] } {
  const cells = (m.cols - 1) * (m.rows - 1);
  const per = (n + 1) * (n + 1);
  const positions = new Float32Array(cells * per * 2);
  const cols = new Float32Array(cells * per * 4);
  const indices: number[] = [];
  const rgba = colors.map(c => {
    const p = parseColor(c) ?? { r: 0, g: 0, b: 0, a: 0 };
    return [p.r / 255, p.g / 255, p.b / 255, p.a * opacity];
  });
  const colorAt = (i: number) => rgba[i] ?? rgba[rgba.length - 1] ?? [0, 0, 0, 0];
  let cell = 0;
  for (let r = 0; r < m.rows - 1; r++)
    for (let c = 0; c < m.cols - 1; c++, cell++) {
      const i00 = r * m.cols + c, i01 = i00 + 1, i10 = i00 + m.cols, i11 = i10 + 1;
      const p00 = m.points[i00], p01 = m.points[i01], p10 = m.points[i10], p11 = m.points[i11];
      const c00 = colorAt(i00), c01 = colorAt(i01), c10 = colorAt(i10), c11 = colorAt(i11);
      const base = cell * per;
      for (let j = 0; j <= n; j++) {
        const v = j / n;
        for (let i = 0; i <= n; i++) {
          const u = i / n;
          const k = base + j * (n + 1) + i;
          for (let a = 0; a < 2; a++) {
            const P = (p: MeshPoint) => (a ? p.y : p.x);
            const top = bez(P(p00), P(p00) + p00.right[a], P(p01) + p01.left[a], P(p01), u);
            const bottom = bez(P(p10), P(p10) + p10.right[a], P(p11) + p11.left[a], P(p11), u);
            const left = bez(P(p00), P(p00) + p00.bottom[a], P(p10) + p10.top[a], P(p10), v);
            const right = bez(P(p01), P(p01) + p01.bottom[a], P(p11) + p11.top[a], P(p11), v);
            const corners = (1 - u) * (1 - v) * P(p00) + u * (1 - v) * P(p01) + (1 - u) * v * P(p10) + u * v * P(p11);
            positions[k * 2 + a] = (1 - v) * top + v * bottom + (1 - u) * left + u * right - corners;
          }
          // Colours ease in and out of each point, so neighbouring cells meet without a visible ridge.
          const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
          for (let ch = 0; ch < 4; ch++) cols[k * 4 + ch] = (1 - su) * (1 - sv) * c00[ch] + su * (1 - sv) * c01[ch] + (1 - su) * sv * c10[ch] + su * sv * c11[ch];
        }
      }
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const a = base + j * (n + 1) + i, b = a + 1, d = a + n + 1, e = d + 1;
          indices.push(a, b, d, b, e, d);
        }
    }
  return { positions, colors: cols, indices };
}

const bitmaps = new Map<string, string>();
const SIDE = 192;

/**
 * The mesh as a small bitmap (a data URL), for CSS backgrounds and SVG patterns: mesh gradients are smooth, so the
 * browser's scaling to the box loses nothing visible. Cached by the fill's content.
 */
export function meshDataUrl(f: any, colors: string[]): string {
  const key = JSON.stringify([f.columns, f.rows, f.points, colors, f.opacity]);
  const hit = bitmaps.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIDE;
  const g = canvas.getContext('2d')!;
  const m = meshOf(f);
  // About two bitmap pixels per quad whatever the grid, so the flat quads never show as steps.
  const n = Math.max(16, Math.round(96 / Math.max(m.cols - 1, m.rows - 1)));
  const t = tessellate(m, colors, n, num(f.opacity, 1));
  const px = (i: number) => [t.positions[i * 2] * SIDE, t.positions[i * 2 + 1] * SIDE];
  // Each small quad in the average of its corner colours; a hairline of the same colour hides the seams between them.
  for (let q = 0; q < t.indices.length; q += 6) {
    const a = t.indices[q], b = t.indices[q + 1], d = t.indices[q + 2], e = t.indices[q + 4];
    const col = [0, 1, 2, 3].map(ch => (t.colors[a * 4 + ch] + t.colors[b * 4 + ch] + t.colors[d * 4 + ch] + t.colors[e * 4 + ch]) / 4);
    const css = `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},${col[3]})`;
    g.fillStyle = g.strokeStyle = css;
    g.lineWidth = col[3] >= 1 ? 1 : 0.01;
    g.beginPath();
    const [ax, ay] = px(a), [bx, by] = px(b), [ex, ey] = px(e), [dx, dy] = px(d);
    g.moveTo(ax, ay);
    g.lineTo(bx, by);
    g.lineTo(ex, ey);
    g.lineTo(dx, dy);
    g.closePath();
    g.fill();
    g.stroke();
  }
  const url = canvas.toDataURL('image/png');
  if (bitmaps.size > 60) bitmaps.delete(bitmaps.keys().next().value!);
  bitmaps.set(key, url);
  return url;
}
