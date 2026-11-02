// Close-up checks for vector drawings: stroke ends that stop just short of (or just past) the line they meet. With round
// or square caps the cap then shows as a bump where the lines join; with butt caps as a gap or overshoot. Invisible at
// 1x, obvious zoomed in. Works on the document geometry, so it finds every such joint, not only the ones on screen.
import svgpath from 'svgpath';
import { currentTree } from './tree';
import { worldRectOf } from './ops';
import type { RNode } from '../model/types';
import { displayName } from '../model/doc';

type Seg = { key: string; name: string; sub: number; closed: boolean; width: number; cap: string; pts: { x: number; y: number }[] };
export type DrawingIssue = {
  node: string;
  name: string;
  /** Which end: start or end of subpath n (1-based) of the node's geometry. */
  end: string;
  /** In the checked node's coordinates (its top-left is 0,0). */
  at: { x: number; y: number };
  meets: { node: string; name: string };
  /** Distance from the stroke end to the other stroke's centre line, in the same units. */
  off: number;
  fix: { x: number; y: number };
  problem: string;
};

const round2 = (v: number) => Math.round(v * 100) / 100;

function strokeWidth(n: RNode) {
  const w = n.props.strokeWidth;
  return typeof w === 'number' ? w : typeof w === 'object' && w ? Math.max(...Object.values(w as Record<string, number>).map(Number)) : 1;
}

/** World-space polylines of every subpath of the stroked paths under `root`. */
function strokedSegments(root: RNode): Seg[] {
  const out: Seg[] = [];
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden');
  document.body.appendChild(host);
  try {
    const visit = (n: RNode) => {
      if (n.props.enabled === false) return;
      n.children.forEach(visit);
      if (n.type !== 'path' || !n.props.stroke || typeof n.props.geometry !== 'string' || n.props.rotation) return;
      const wr = worldRectOf(n.key);
      if (!wr) return;
      const vb: number[] = Array.isArray(n.props.viewBox) && n.props.viewBox.length === 4 ? n.props.viewBox : [0, 0, n.props.width, n.props.height];
      const w = typeof n.props.width === 'number' ? n.props.width : wr.w;
      const h = typeof n.props.height === 'number' ? n.props.height : wr.h;
      const sx = vb[2] ? w / vb[2] : 1;
      const sy = vb[3] ? h / vb[3] : 1;
      let d: string;
      try {
        d = svgpath(n.props.geometry).translate(-vb[0], -vb[1]).scale(sx, sy).translate(wr.x, wr.y).abs().toString();
      } catch {
        return;
      }
      const width = strokeWidth(n);
      const step = Math.max(0.15, Math.min(0.6, width / 5));
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      host.appendChild(el);
      d.split(/(?=M)/).forEach((sub, i) => {
        if (!sub.trim()) return;
        // Sample segment by segment so every corner is a sample point (sampling the whole length cuts corners).
        const pts: { x: number; y: number }[] = [];
        let start = { x: 0, y: 0 };
        svgpath(sub)
          .unshort()
          .iterate((seg, _i, x, y) => {
            const cmd = seg[0];
            if (cmd === 'M') {
              start = { x: Number(seg[1]), y: Number(seg[2]) };
              pts.push(start);
              return;
            }
            el.setAttribute('d', cmd === 'Z' || cmd === 'z' ? `M${x} ${y}L${start.x} ${start.y}` : `M${x} ${y}${seg.join(' ')}`);
            const len = el.getTotalLength();
            for (let t = step; t < len; t += step) pts.push(el.getPointAtLength(t));
            pts.push(el.getPointAtLength(len));
          });
        out.push({ key: n.key, name: displayName(n.props), sub: i + 1, closed: /z\s*$/i.test(sub.trim()), width, cap: String(n.props.strokeLinecap ?? 'butt'), pts });
      });
      el.remove();
    };
    visit(root);
  } finally {
    host.remove();
  }
  return out;
}

export function checkDrawing(key: string): { issues: DrawingIssue[]; origin: { x: number; y: number } } {
  const root = currentTree()?.byKey.get(key);
  if (!root) throw new Error(`node "${key}" not found`);
  const origin = worldRectOf(key);
  if (!origin) throw new Error(`node "${key}" is not rendered`);
  const segs = strokedSegments(root);
  const issues: DrawingIssue[] = [];
  // Strokes only interact within a couple of stroke widths: bucket the samples on a grid of that size.
  const cell = Math.max(1, ...segs.map(s => s.width));
  const grid = new Map<string, { i: number; seg: Seg }[]>();
  for (const seg of segs)
    seg.pts.forEach((p, i) => {
      const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push({ i, seg });
    });
  const near = (e: { x: number; y: number }) => {
    const cx = Math.floor(e.x / cell), cy = Math.floor(e.y / cell);
    const out: { i: number; seg: Seg }[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) out.push(...(grid.get(`${cx + dx},${cy + dy}`) ?? []));
    return out;
  };
  /** Nearest point on another stroke's centre line, and how far `pt` lies outside that stroke (negative = covered). */
  const nearest = (pt: { x: number; y: number }, a: Seg) => {
    let best: { d: number; p: { x: number; y: number }; seg: Seg } | null = null;
    let excess = Infinity;
    for (const { i, seg: b } of near(pt)) {
      if (b === a) continue;
      // Exact distance to the centre line: project onto the polyline pieces either side of the sample.
      for (const j of [i - 1, i]) {
        const p0 = b.pts[j], p1 = b.pts[j + 1];
        if (!p0 || !p1) continue;
        const vx = p1.x - p0.x, vy = p1.y - p0.y;
        const l2 = vx * vx + vy * vy;
        const t = l2 ? Math.max(0, Math.min(1, ((pt.x - p0.x) * vx + (pt.y - p0.y) * vy) / l2)) : 0;
        const q = { x: p0.x + t * vx, y: p0.y + t * vy };
        const d = Math.hypot(q.x - pt.x, q.y - pt.y);
        if (!best || d < best.d) best = { d, p: q, seg: b };
        excess = Math.min(excess, d - b.width / 2);
      }
    }
    return { best, excess };
  };
  for (const a of segs) {
    if (a.closed || a.pts.length < 2) continue;
    const n = a.pts.length;
    const ends: [string, { x: number; y: number }, { x: number; y: number }][] = [
      ['start', a.pts[0], a.pts.find(p => p !== a.pts[0] && Math.hypot(p.x - a.pts[0].x, p.y - a.pts[0].y) > 0.01) ?? a.pts[1]],
      ['end', a.pts[n - 1], [...a.pts].reverse().find(p => Math.hypot(p.x - a.pts[n - 1].x, p.y - a.pts[n - 1].y) > 0.01) ?? a.pts[n - 2]],
    ];
    for (const [which, e, prev] of ends) {
      const { best } = nearest(e, a);
      if (!best) continue;
      const reach = (a.width + best.seg.width) / 2;
      const tol = Math.max(0.12, 0.05 * Math.min(a.width, best.seg.width));
      // Only ends that touch another stroke and aren't on its centre line.
      if (best.d <= tol || best.d >= reach) continue;
      // Trace round the end's cap: fully inside the stroke it meets means hidden, fully clear of it a deliberate stub or
      // notch (calendar rings, a trash lid's overhang); partly inside and partly out is a bump or notch at the join.
      const len = Math.hypot(e.x - prev.x, e.y - prev.y) || 1;
      const tx = (e.x - prev.x) / len, ty = (e.y - prev.y) / len;
      const r = a.width / 2;
      const capPts: { x: number; y: number }[] = [];
      if (a.cap === 'round') for (let deg = -75; deg <= 75; deg += 15) {
        const th = (deg * Math.PI) / 180;
        capPts.push({ x: e.x + r * (Math.cos(th) * tx - Math.sin(th) * ty), y: e.y + r * (Math.cos(th) * ty + Math.sin(th) * tx) });
      }
      else {
        const ext = a.cap === 'square' ? r : 0;
        for (const k of [-0.9, -0.45, 0, 0.45, 0.9]) capPts.push({ x: e.x + ext * tx - k * r * ty, y: e.y + ext * ty + k * r * tx });
      }
      const excess = capPts.map(p => nearest(p, a).excess);
      const covered = excess.filter(x => x <= 0.05).length;
      const out = excess.filter(x => x > 0.12).length;
      if (!covered || !out) continue;
      const capped = a.cap === 'round' || a.cap === 'square';
      issues.push({
        node: a.key,
        name: a.name,
        end: `${which} of subpath ${a.sub}`,
        at: { x: round2(e.x - origin.x), y: round2(e.y - origin.y) },
        meets: { node: best.seg.key, name: best.seg.name },
        off: round2(best.d),
        fix: { x: round2(best.p.x - origin.x), y: round2(best.p.y - origin.y) },
        problem: capped
          ? `stroke end is ${round2(best.d)} off the line it meets, so its ${a.cap} cap shows as a bump at the join`
          : `stroke end is ${round2(best.d)} off the line it meets, leaving a gap or overshoot`,
      });
    }
  }
  return { issues, origin };
}
