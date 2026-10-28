// Smart guides: snapping a moving box to sibling/parent edges and centers, and to equal spacing between neighbours.
// Everything here is in world (document) units.

export type Rect = { x: number; y: number; w: number; h: number };
export type Line = { x1: number; y1: number; x2: number; y2: number };
export type Guides = { lines: Line[]; gaps: (Line & { label: string })[] };

type AxisHit = { off: number; dist: number; lines: Line[]; gaps: Guides['gaps'] };

const lo = (r: Rect, ax: 'x' | 'y') => (ax === 'x' ? r.x : r.y);
const size = (r: Rect, ax: 'x' | 'y') => (ax === 'x' ? r.w : r.h);
const hi = (r: Rect, ax: 'x' | 'y') => lo(r, ax) + size(r, ax);
const other = (ax: 'x' | 'y') => (ax === 'x' ? 'y' : 'x');
const overlaps = (a: Rect, b: Rect, ax: 'x' | 'y') => lo(a, ax) < hi(b, ax) && hi(a, ax) > lo(b, ax);

/** A segment along `ax` at cross-axis position `at`. */
function seg(ax: 'x' | 'y', from: number, to: number, at: number): Line {
  return ax === 'x' ? { x1: from, y1: at, x2: to, y2: at } : { x1: at, y1: from, x2: at, y2: to };
}

function snapAxis(r: Rect, targets: Rect[], parent: Rect | null, ax: 'x' | 'y', threshold: number): AxisHit | null {
  let best: AxisHit | null = null;
  const consider = (off: number, make: () => Pick<AxisHit, 'lines' | 'gaps'>) => {
    const dist = Math.abs(off);
    if (dist > threshold || (best && dist >= best.dist - 1e-6)) return;
    best = { off, dist, ...make() };
  };
  // Edge / center alignment.
  const mine = [lo(r, ax), lo(r, ax) + size(r, ax) / 2, hi(r, ax)];
  const all = parent ? [...targets, parent] : targets;
  for (const t of all) {
    const theirs = [lo(t, ax), lo(t, ax) + size(t, ax) / 2, hi(t, ax)];
    for (const m of mine)
      for (const v of theirs)
        consider(v - m, () => {
          const ox = other(ax);
          const a = Math.min(lo(r, ox), lo(t, ox));
          const b = Math.max(hi(r, ox), hi(t, ox));
          // A line across both boxes at the aligned coordinate (perpendicular to `ax`).
          return { lines: [ax === 'x' ? { x1: v, y1: a, x2: v, y2: b } : { x1: a, y1: v, x2: b, y2: v }], gaps: [] };
        });
  }
  // Equal spacing with neighbours in the same row (ax = 'x') or column (ax = 'y').
  const ox = other(ax);
  const row = targets.filter(t => overlaps(t, r, ox)).sort((a, b) => lo(a, ax) - lo(b, ax));
  const before = row.filter(t => hi(t, ax) <= lo(r, ax) + threshold).pop();
  const after = row.find(t => lo(t, ax) >= hi(r, ax) - threshold);
  const gaps: { g: number; a: Rect; b: Rect }[] = [];
  for (let i = 0; i + 1 < row.length; i++) {
    const g = lo(row[i + 1], ax) - hi(row[i], ax);
    if (g > 0) gaps.push({ g, a: row[i], b: row[i + 1] });
  }
  const mid = (t: Rect, u: Rect) => (Math.max(lo(t, ox), lo(u, ox)) + Math.min(hi(t, ox), hi(u, ox))) / 2;
  const gapLine = (from: number, to: number, a: Rect, b: Rect) => ({ ...seg(ax, from, to, mid(a, b)), label: String(Math.round(to - from)) });
  if (before && after) {
    const target = (hi(before, ax) + lo(after, ax) - size(r, ax)) / 2;
    consider(target - lo(r, ax), () => {
      const s = target;
      return { lines: [], gaps: [gapLine(hi(before, ax), s, before, r), gapLine(s + size(r, ax), lo(after, ax), r, after)] };
    });
  }
  for (const { g, a, b } of gaps) {
    if (before && before !== b) {
      const target = hi(before, ax) + g;
      consider(target - lo(r, ax), () => ({ lines: [], gaps: [gapLine(hi(before, ax), target, before, r), gapLine(hi(a, ax), lo(b, ax), a, b)] }));
    }
    if (after && after !== a) {
      const target = lo(after, ax) - g - size(r, ax);
      consider(target - lo(r, ax), () => ({ lines: [], gaps: [gapLine(target + size(r, ax), lo(after, ax), r, after), gapLine(hi(a, ax), lo(b, ax), a, b)] }));
    }
  }
  return best;
}

/** Offsets that snap `r` (the moving selection's bounds) plus the guides to draw. */
export function snapMove(r: Rect, targets: Rect[], parent: Rect | null, threshold: number): { dx: number; dy: number; guides: Guides } {
  const hx = snapAxis(r, targets, parent, 'x', threshold);
  const moved = hx ? { ...r, x: r.x + hx.off } : r;
  const hy = snapAxis(moved, targets, parent, 'y', threshold);
  const guides: Guides = { lines: [...(hx?.lines ?? []), ...(hy?.lines ?? [])], gaps: [...(hx?.gaps ?? []), ...(hy?.gaps ?? [])] };
  // Alignment lines were computed before the other axis snapped; extend them over the final box.
  const fin = { ...moved, y: moved.y + (hy?.off ?? 0) };
  guides.lines = guides.lines.map(l => (l.x1 === l.x2 ? { ...l, y1: Math.min(l.y1, fin.y), y2: Math.max(l.y2, fin.y + fin.h) } : { ...l, x1: Math.min(l.x1, fin.x), x2: Math.max(l.x2, fin.x + fin.w) }));
  return { dx: hx?.off ?? 0, dy: hy?.off ?? 0, guides };
}
