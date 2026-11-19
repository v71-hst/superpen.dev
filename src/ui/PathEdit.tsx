// Point editing for paths (store.pathEdit; double-click a path, or select it and press Enter). The path's anchors are
// on the canvas: drag an anchor to move it, drag a handle to bend the curve (Alt bends one side only), click the
// outline to add a point, double-click an anchor to switch between corner and smooth, Delete removes the selected
// one. Enter, Escape or a click on empty canvas ends it. The layer's box follows the shape as it changes.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, applyProps } from '../editor/store';
import { currentTree } from '../editor/tree';
import { clientToWorld, isAbsolutelyPositioned, worldRectOf } from '../editor/ops';
import { resolveProps } from '../render/NodeView';
import { pathBox } from '../render/geometry';
import { clonePath, insertAnchor, nearestSide, parsePath, removeAnchor, serializePath, sidesOf, toggleSmooth, type Pt, type SubPath } from '../editor/pathModel';

type Rect = { x: number; y: number; w: number; h: number };
type Sel = { sub: number; i: number } | null;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** How a path's geometry space maps onto its layer's box: geometry units to world pixels along each axis. */
function mapping(box: Rect, vb: number[]) {
  // A path with no extent along an axis (a straight vertical or horizontal line) borrows the other axis's scale.
  const okX = vb[2] > 0.011, okY = vb[3] > 0.011;
  const sy0 = okY ? box.h / vb[3] : 1;
  const sx = okX ? box.w / vb[2] : sy0;
  const sy = okY ? sy0 : sx;
  return { sx, sy };
}

export function PathEditOverlay() {
  const pe = useStore(s => s.pathEdit);
  const view = useStore(s => s.view);
  const doc = useStore(s => s.doc);
  const [box, setBox] = useState<Rect | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const drag = useRef<((g: Pt, e: React.PointerEvent) => void) | null>(null);
  const done = () => useStore.setState({ pathEdit: null });
  useLayoutEffect(() => setBox(pe ? worldRectOf(pe.key) : null), [pe?.key, view, doc]);
  useEffect(() => setSel(null), [pe?.key]);

  const node = pe && doc ? currentTree()?.byKey.get(pe.key) : undefined;
  const p = node && doc ? resolveProps(doc, node.props, node.theme) : null;
  const geometry: string = p && typeof p.geometry === 'string' ? p.geometry : '';
  const usable = !!node && node.type === 'path' && !!geometry && !p?.rotation;

  useEffect(() => {
    if (!pe) return;
    if (!usable) {
      if (node && p?.rotation) useStore.getState().notify('Point editing works on paths that are not rotated');
      return done();
    }
  }, [pe, usable]);

  const subs = usable ? parsePath(geometry) : [];
  const vb: number[] = usable ? (Array.isArray(p!.viewBox) && p!.viewBox.length === 4 ? p!.viewBox : pathBox(geometry)) : [0, 0, 1, 1];

  /** Writes a new shape: the geometry, a viewBox that fits it, and the layer's box moved and resized to match. */
  const commit = (next: SubPath[], from: { box: Rect; vb: number[]; x: number; y: number }) => {
    const d = serializePath(next);
    if (!d) return;
    const bb = pathBox(d);
    const { sx, sy } = mapping(from.box, from.vb);
    const world = { x: from.box.x + (bb[0] - from.vb[0]) * sx, y: from.box.y + (bb[1] - from.vb[1]) * sy, w: bb[2] * sx, h: bb[3] * sy };
    const changes: Record<string, any> = { geometry: d, viewBox: [r2(bb[0]), r2(bb[1]), Math.max(r2(bb[2]), 0.01), Math.max(r2(bb[3]), 0.01)], width: Math.max(r2(world.w), 1), height: Math.max(r2(world.h), 1) };
    if (isAbsolutelyPositioned(pe!.key)) {
      changes.x = r2(from.x + world.x - from.box.x);
      changes.y = r2(from.y + world.y - from.box.y);
    }
    useStore.getState().edit(dd => applyProps(dd, pe!.key, changes), 'pathedit-' + pe!.key);
  };

  useEffect(() => {
    if (!pe || !usable) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        return done();
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel && box) {
        e.preventDefault();
        e.stopPropagation();
        const next = clonePath(subs);
        removeAnchor(next[sel.sub], sel.i);
        const left = next.filter(s => s.anchors.length > 1);
        setSel(null);
        // Nothing left to draw: the layer itself goes.
        if (!left.length) {
          const k = pe.key;
          done();
          useStore.getState().select([k]);
          return;
        }
        commit(left, { box, vb, x: typeof p!.x === 'number' ? p!.x : 0, y: typeof p!.y === 'number' ? p!.y : 0 });
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  if (!pe || !usable || !box) return null;
  const { sx, sy } = mapping(box, vb);
  const W = (g: Pt): Pt => ({ x: box.x + (g.x - vb[0]) * sx, y: box.y + (g.y - vb[1]) * sy });
  const S = (g: Pt): Pt => {
    const w = W(g);
    return { x: view.x + w.x * view.zoom, y: view.y + w.y * view.zoom };
  };
  const start = (e: React.PointerEvent, move: (g: Pt, d: Pt, e: React.PointerEvent, base: SubPath[]) => SubPath[] | null) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    // Everything during the drag is worked out from how things were when it began.
    const from = { box, vb, x: typeof p!.x === 'number' ? p!.x : 0, y: typeof p!.y === 'number' ? p!.y : 0 };
    const base = clonePath(subs);
    const w0 = clientToWorld(e.clientX, e.clientY);
    const toG = (w: Pt): Pt => ({ x: from.vb[0] + (w.x - from.box.x) / sx, y: from.vb[1] + (w.y - from.box.y) / sy });
    const g0 = toG(w0);
    drag.current = (w, ev) => {
      const g = toG(w);
      const next = move(g, { x: g.x - g0.x, y: g.y - g0.y }, ev, clonePath(base));
      if (next) commit(next, from);
    };
  };
  const handlers = {
    onPointerMove: (e: React.PointerEvent) => drag.current?.(clientToWorld(e.clientX, e.clientY), e),
    onPointerUp: () => (drag.current = null),
  };

  const out: React.ReactNode[] = [];
  // The outline: click it to add a point there.
  const d = subs
    .map(s => {
      const a = s.anchors;
      const P = (q: Pt) => {
        const t = S(q);
        return `${t.x} ${t.y}`;
      };
      let str = `M${P(a[0])}`;
      for (const [i, j] of sidesOf(s)) str += `C${P(a[i].out ?? a[i])} ${P(a[j].in ?? a[j])} ${P(a[j])}`;
      return str;
    })
    .join('');
  out.push(<path key="outline" d={d} fill="none" stroke="var(--sel)" strokeWidth={1.25} pointerEvents="none" />);
  out.push(
    <path
      key="hit"
      className="path-hit"
      d={d}
      fill="none"
      stroke="transparent"
      strokeWidth={10}
      onPointerDown={e => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const w = clientToWorld(e.clientX, e.clientY);
        const g = { x: vb[0] + (w.x - box.x) / sx, y: vb[1] + (w.y - box.y) / sy };
        const hit = nearestSide(subs, g);
        if (!hit) return;
        const next = clonePath(subs);
        const i = insertAnchor(next[hit.sub], hit.from, hit.to, Math.max(0.02, Math.min(0.98, hit.t)));
        setSel({ sub: hit.sub, i });
        commit(next, { box, vb, x: typeof p!.x === 'number' ? p!.x : 0, y: typeof p!.y === 'number' ? p!.y : 0 });
      }}
    />,
  );
  // Handles of the selected anchor.
  const sa = sel ? subs[sel.sub]?.anchors[sel.i] : null;
  if (sel && sa) {
    for (const name of ['in', 'out'] as const) {
      const h = sa[name];
      if (!h) continue;
      const a = S(sa), b = S(h);
      out.push(<line key={'hl' + name} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--sel)" strokeWidth={1} pointerEvents="none" />);
      out.push(
        <circle
          key={'h' + name}
          className="path-handle"
          data-path-handle={name}
          cx={b.x}
          cy={b.y}
          r={4}
          onPointerDown={e =>
            start(e, (g, _d, ev, base) => {
              const q = base[sel.sub].anchors[sel.i];
              q[name] = { x: g.x, y: g.y };
              // The other handle stays in line with this one (keeping its own length) unless Alt breaks the pair.
              const other = name === 'in' ? 'out' : 'in';
              if (q[other] && !ev.altKey) {
                const len = Math.hypot(q[other]!.x - q.x, q[other]!.y - q.y);
                const dx = q.x - g.x, dy = q.y - g.y;
                const dl = Math.hypot(dx, dy) || 1;
                q[other] = { x: q.x + (dx / dl) * len, y: q.y + (dy / dl) * len };
              }
              return base;
            })
          }
          {...handlers}
        />,
      );
    }
  }
  subs.forEach((s, si) =>
    s.anchors.forEach((a, i) => {
      const q = S(a);
      const on = sel?.sub === si && sel.i === i;
      out.push(
        <rect
          key={`a${si}-${i}`}
          className={'path-anchor' + (on ? ' on' : '')}
          data-path-anchor={`${si}-${i}`}
          x={q.x - 4}
          y={q.y - 4}
          width={8}
          height={8}
          onDoubleClick={e => {
            e.stopPropagation();
            const next = clonePath(subs);
            toggleSmooth(next[si], i);
            commit(next, { box, vb, x: typeof p!.x === 'number' ? p!.x : 0, y: typeof p!.y === 'number' ? p!.y : 0 });
          }}
          onPointerDown={e => {
            setSel({ sub: si, i });
            start(e, (_g, dlt, _ev, base) => {
              if (!dlt.x && !dlt.y) return null;
              const t = base[si].anchors[i];
              t.x += dlt.x;
              t.y += dlt.y;
              if (t.in) t.in = { x: t.in.x + dlt.x, y: t.in.y + dlt.y };
              if (t.out) t.out = { x: t.out.x + dlt.x, y: t.out.y + dlt.y };
              return base;
            });
          }}
          {...handlers}
        />,
      );
    }),
  );
  return (
    <svg
      className="path-edit"
      width="100%"
      height="100%"
      onPointerDown={e => {
        // Empty canvas: done.
        e.stopPropagation();
        done();
      }}
      onDoubleClick={e => e.stopPropagation()}
    >
      {out}
    </svg>
  );
}
