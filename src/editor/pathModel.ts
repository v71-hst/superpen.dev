// A path as points you can edit: each anchor with the two bezier handles that leave it (absolute coordinates, in
// the path's own geometry space). The pen tool draws with it and the point editor (ui/PathEdit.tsx) edits with it;
// SVG path data is parsed into it and written back out, so any path in a design (drawn, imported, traced) works.
import svgpath from 'svgpath';

export type Pt = { x: number; y: number };
/** `in` is the handle towards the previous anchor, `out` towards the next; a missing handle means a straight side. */
export type Anchor = { x: number; y: number; in?: Pt; out?: Pt };
export type SubPath = { anchors: Anchor[]; closed: boolean };

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const same = (a: Pt, b: Pt) => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

/** SVG path data as sub-paths of anchors. Arcs and quadratic curves become cubic ones; relative commands absolute. */
export function parsePath(d: string): SubPath[] {
  const subs: SubPath[] = [];
  let cur: SubPath | null = null;
  let last: Pt = { x: 0, y: 0 };
  const end = () => {
    if (!cur) return;
    const a = cur.anchors;
    // A closed shape whose last point repeats the first: they are one anchor.
    if (cur.closed && a.length > 1 && same(a[0], a[a.length - 1])) {
      a[0].in = a[a.length - 1].in;
      a.pop();
    }
    if (a.length) subs.push(cur);
    cur = null;
  };
  try {
    svgpath(d)
      .abs()
      .unarc()
      .unshort()
      .iterate(seg => {
        const c = seg[0];
        if (c === 'M') {
          end();
          cur = { anchors: [{ x: seg[1], y: seg[2] }], closed: false };
          last = { x: seg[1], y: seg[2] };
          return;
        }
        if (!cur) cur = { anchors: [{ ...last }], closed: false };
        const a = cur.anchors;
        const prev = a[a.length - 1];
        if (c === 'Z' || c === 'z') {
          cur.closed = true;
          last = { x: a[0].x, y: a[0].y };
          end();
          return;
        }
        let p: Pt;
        if (c === 'L') p = { x: seg[1], y: seg[2] };
        else if (c === 'H') p = { x: seg[1], y: prev.y };
        else if (c === 'V') p = { x: prev.x, y: seg[1] };
        else if (c === 'C') {
          p = { x: seg[5], y: seg[6] };
          if (!same({ x: seg[1], y: seg[2] }, prev)) prev.out = { x: seg[1], y: seg[2] };
          const inH = { x: seg[3], y: seg[4] };
          a.push(same(inH, p) ? { ...p } : { ...p, in: inH });
          last = p;
          return;
        } else if (c === 'Q') {
          p = { x: seg[3], y: seg[4] };
          prev.out = { x: prev.x + (2 / 3) * (seg[1] - prev.x), y: prev.y + (2 / 3) * (seg[2] - prev.y) };
          a.push({ ...p, in: { x: p.x + (2 / 3) * (seg[1] - p.x), y: p.y + (2 / 3) * (seg[2] - p.y) } });
          last = p;
          return;
        } else return;
        a.push({ ...p });
        last = p;
      });
  } catch {
    // Unparseable data: nothing to edit.
  }
  end();
  return subs;
}

function side(from: Anchor, to: Anchor): string {
  if (!from.out && !to.in) return `L${r3(to.x)} ${r3(to.y)}`;
  const c1 = from.out ?? from, c2 = to.in ?? to;
  return `C${r3(c1.x)} ${r3(c1.y)} ${r3(c2.x)} ${r3(c2.y)} ${r3(to.x)} ${r3(to.y)}`;
}

export function serializePath(subs: SubPath[]): string {
  let d = '';
  for (const s of subs) {
    const a = s.anchors;
    if (!a.length) continue;
    d += `M${r3(a[0].x)} ${r3(a[0].y)}`;
    for (let i = 1; i < a.length; i++) d += side(a[i - 1], a[i]);
    if (s.closed && a.length > 1) d += side(a[a.length - 1], a[0]) + 'Z';
  }
  return d;
}

/** The sides of a sub-path as [from, to] anchor indices (the closing side included). */
export function sidesOf(s: SubPath): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 1; i < s.anchors.length; i++) out.push([i - 1, i]);
  if (s.closed && s.anchors.length > 1) out.push([s.anchors.length - 1, 0]);
  return out;
}

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** The point at t along the side from one anchor to the next. */
export function pointOnSide(from: Anchor, to: Anchor, t: number): Pt {
  const p0 = from, p1 = from.out ?? from, p2 = to.in ?? to, p3 = to;
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  return lerp(lerp(a, b, t), lerp(b, c, t), t);
}

/** The side nearest to a point, and where along it. */
export function nearestSide(subs: SubPath[], p: Pt): { sub: number; from: number; to: number; t: number; dist: number } | null {
  let best: { sub: number; from: number; to: number; t: number; dist: number } | null = null;
  subs.forEach((s, si) => {
    for (const [i, j] of sidesOf(s)) {
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        const q = pointOnSide(s.anchors[i], s.anchors[j], t);
        const dist = Math.hypot(q.x - p.x, q.y - p.y);
        if (!best || dist < best.dist) best = { sub: si, from: i, to: j, t, dist };
      }
    }
  });
  return best;
}

/** Splits the side from → to at t with a new anchor (the curve keeps its shape). Returns the new anchor's index. */
export function insertAnchor(s: SubPath, from: number, to: number, t: number): number {
  const a = s.anchors[from], b = s.anchors[to];
  let added: Anchor;
  if (!a.out && !b.in) added = lerp(a, b, t);
  else {
    const p0 = a, p1 = a.out ?? a, p2 = b.in ?? b, p3 = b;
    const q0 = lerp(p0, p1, t), q1 = lerp(p1, p2, t), q2 = lerp(p2, p3, t);
    const r0 = lerp(q0, q1, t), r1 = lerp(q1, q2, t);
    a.out = q0;
    b.in = q2;
    added = { ...lerp(r0, r1, t), in: r0, out: r1 };
  }
  const at = to === 0 ? s.anchors.length : to;
  s.anchors.splice(at, 0, added);
  return at;
}

/** Removes an anchor; its neighbours join with the handles they already have. */
export function removeAnchor(s: SubPath, i: number) {
  s.anchors.splice(i, 1);
  if (s.anchors.length < 3) s.closed = false;
}

/** A corner becomes a smooth point (handles a third of the way to its neighbours, in line), a smooth point a corner. */
export function toggleSmooth(s: SubPath, i: number) {
  const a = s.anchors[i];
  if (a.in || a.out) {
    delete a.in;
    delete a.out;
    return;
  }
  const n = s.anchors.length;
  const prev = s.anchors[i > 0 ? i - 1 : s.closed ? n - 1 : -1], next = s.anchors[i < n - 1 ? i + 1 : s.closed ? 0 : -1];
  const from = prev ?? a, to = next ?? a;
  const dx = to.x - from.x, dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  if (prev) {
    const d = Math.hypot(prev.x - a.x, prev.y - a.y) / 3;
    a.in = { x: a.x - ux * d, y: a.y - uy * d };
  }
  if (next) {
    const d = Math.hypot(next.x - a.x, next.y - a.y) / 3;
    a.out = { x: a.x + ux * d, y: a.y + uy * d };
  }
}

export const clonePath = (subs: SubPath[]): SubPath[] => subs.map(s => ({ closed: s.closed, anchors: s.anchors.map(a => ({ x: a.x, y: a.y, in: a.in && { ...a.in }, out: a.out && { ...a.out } })) }));
