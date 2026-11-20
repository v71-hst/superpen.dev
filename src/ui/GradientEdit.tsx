// Gradients on the canvas. While the paint popover is open on a gradient fill (store.gradientEdit), its geometry
// is drawn over the layer and can be dragged: a linear gradient's two ends and its stops, a radial gradient's centre
// and radii, an angular gradient's centre and start direction, a mesh gradient's points and their handles.
// Everything is written back into the fill in the file's own terms (render/paint.ts, render/mesh.ts).
import React, { useLayoutEffect, useRef, useState } from 'react';
import { useStore, applyProps } from '../editor/store';
import { currentTree } from '../editor/tree';
import { clientToWorld, worldRectOf } from '../editor/ops';
import { resolveProps } from '../model/props';
import { colorCss, fillList, linearEndpoints } from '../render/paint';
import { meshOf, meshToPoints, type Mesh } from '../render/mesh';

type Rect = { x: number; y: number; w: number; h: number };
type P = { x: number; y: number };
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

/** The node's raw fill with the paint at `index` (among its fills) replaced. */
function withPaint(rawFill: any, index: number, paint: any) {
  if (Array.isArray(rawFill)) return rawFill.map((f, i) => (i === index ? paint : f));
  return paint;
}

export function GradientOverlay() {
  const ge = useStore(s => s.gradientEdit);
  const view = useStore(s => s.view);
  const doc = useStore(s => s.doc);
  const [box, setBox] = useState<Rect | null>(null);
  const drag = useRef<((w: P, e: PointerEvent | React.PointerEvent) => void) | null>(null);
  useLayoutEffect(() => setBox(ge ? worldRectOf(ge.key) : null), [ge?.key, view, doc]);

  const node = ge && doc ? currentTree()?.byKey.get(ge.key) : undefined;
  if (!ge || !node || !doc || !box || !box.w || !box.h) return null;
  const p = resolveProps(doc, node.props, node.theme);
  if (p.rotation) return null; // handles are laid out in the layer's own axes
  const f: any = fillList(p.fill)[ge.index];
  const rawList = Array.isArray(node.props.fill) ? node.props.fill : [node.props.fill];
  const raw: any = rawList[ge.index];
  if (!f || typeof f !== 'object' || !raw || typeof raw !== 'object' || (f.type !== 'gradient' && f.type !== 'mesh_gradient')) return null;

  const write = (paint: any) => useStore.getState().edit(d => applyProps(d, ge.key, { fill: withPaint(node.props.fill, ge.index, paint) }), `paint-fill-${ge.index}`);
  const select = (point: number) => useStore.setState({ gradientEdit: { ...ge, point } });
  // Unit box <-> screen.
  const S = (n: P): P => ({ x: view.x + (box.x + n.x * box.w) * view.zoom, y: view.y + (box.y + n.y * box.h) * view.zoom });
  const N = (w: P): P => ({ x: (w.x - box.x) / box.w, y: (w.y - box.y) / box.h });

  const start = (e: React.PointerEvent, move: (n: P, e: PointerEvent | React.PointerEvent) => void) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = (w, ev) => move(N(w), ev);
  };
  const handlers = {
    onPointerMove: (e: React.PointerEvent) => drag.current?.(clientToWorld(e.clientX, e.clientY), e),
    onPointerUp: () => (drag.current = null),
  };
  // End handles sit a little beyond the point they set, so a colour stop at the very end stays reachable under them.
  const OUT = 14;
  /** `n` moved `px` screen pixels further away from `from`. */
  const beyond = (from: P, n: P, px: number): P => {
    const vx = (n.x - from.x) * box.w * view.zoom, vy = (n.y - from.y) * box.h * view.zoom;
    const len = Math.hypot(vx, vy);
    if (len < 1e-6) return n;
    return { x: n.x + (px * vx) / len / (box.w * view.zoom), y: n.y + (px * vy) / len / (box.h * view.zoom) };
  };
  const knob = (key: string, at: P, onDown: (e: React.PointerEvent) => void, opts: { fill?: string; on?: boolean; small?: boolean; square?: boolean; ring?: boolean } = {}) => {
    const s = S(at);
    const r = opts.ring ? 9 : opts.small ? 4 : 6;
    if (opts.ring) return <circle key={key} className="grad-knob ring" data-grad={key} cx={s.x} cy={s.y} r={r} onPointerDown={onDown} {...handlers} />;
    return opts.square ? (
      <rect key={key} className="grad-knob" data-grad={key} x={s.x - r} y={s.y - r} width={r * 2} height={r * 2} rx={2} fill={opts.fill ?? '#fff'} onPointerDown={onDown} {...handlers} />
    ) : (
      <circle key={key} className={'grad-knob' + (opts.on ? ' on' : '')} data-grad={key} cx={s.x} cy={s.y} r={r} fill={opts.fill ?? '#fff'} onPointerDown={onDown} {...handlers} />
    );
  };
  const line = (key: string, a: P, b: P, dashed = false) => {
    const sa = S(a), sb = S(b);
    return (
      <g key={key}>
        <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="rgba(0,0,0,0.45)" strokeWidth={3} />
        <line x1={sa.x} y1={sa.y} x2={sb.x} y2={sb.y} stroke="#fff" strokeWidth={1.25} strokeDasharray={dashed ? '3 3' : undefined} />
      </g>
    );
  };
  const out: React.ReactNode[] = [];
  const stops: any[] = Array.isArray(raw.colors) ? raw.colors : [];
  const stopKnobs = (a: P, b: P) =>
    stops.forEach((s, i) => {
      const t = clamp01(num(s.position));
      out.push(
        knob(`stop${i}`, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, e => {
          select(i);
          start(e, n => {
            // The stop's position is where the pointer falls along the gradient's line.
            const dx = b.x - a.x, dy = b.y - a.y;
            const len2 = dx * dx * box.w * box.w + dy * dy * box.h * box.h || 1;
            const pos = clamp01(((n.x - a.x) * dx * box.w * box.w + (n.y - a.y) * dy * box.h * box.h) / len2);
            write({ ...raw, colors: stops.map((x, j) => (j === i ? { ...x, position: Math.round(pos * 100) / 100 } : x)) });
          });
        }, { fill: colorCss(f.colors?.[i]?.color), on: ge.point === i, small: true }),
      );
    });

  if (f.type === 'gradient') {
    const type = f.gradientType ?? 'linear';
    const c = { x: num(f.center?.x, 0.5), y: num(f.center?.y, 0.5) };
    if (type === 'linear') {
      const e = linearEndpoints(f);
      const a = { x: e.x1, y: e.y1 }, b = { x: e.x2, y: e.y2 };
      const set = (na: P, nb: P) => {
        const dx = nb.x - na.x, dy = nb.y - na.y;
        write({ ...raw, center: { x: r3((na.x + nb.x) / 2), y: r3((na.y + nb.y) / 2) }, rotation: Math.round((Math.atan2(-dx, -dy) * 1800) / Math.PI) / 10, size: { ...(raw.size ?? {}), height: r3(Math.hypot(dx, dy)) } });
      };
      out.push(line('l', beyond(b, a, OUT), beyond(a, b, OUT)));
      out.push(knob('start', beyond(b, a, OUT), ev => start(ev, n => set(beyond(b, n, -OUT), b)), { square: true }));
      out.push(knob('end', beyond(a, b, OUT), ev => start(ev, n => set(a, beyond(a, n, -OUT))), { square: true }));
      stopKnobs(a, b);
    } else if (type === 'radial') {
      const rx = num(f.size?.width, 1) / 2, ry = num(f.size?.height, 1) / 2;
      const px = { x: c.x + rx, y: c.y }, py = { x: c.x, y: c.y + ry };
      out.push(line('rx', c, beyond(c, px, OUT)), line('ry', c, beyond(c, py, OUT), true));
      // The centre is a ring around the first stop; the radius handles sit just beyond the last one.
      out.push(knob('center', c, ev => start(ev, n => write({ ...raw, center: { x: r3(n.x), y: r3(n.y) } })), { ring: true }));
      out.push(knob('rx', beyond(c, px, OUT), ev => start(ev, n => write({ ...raw, size: { ...(raw.size ?? {}), width: r3(Math.max(0.02, Math.abs(beyond(c, { x: n.x, y: c.y }, -OUT).x - c.x) * 2)), height: num(raw.size?.height, 1) } })), { square: true }));
      out.push(knob('ry', beyond(c, py, OUT), ev => start(ev, n => write({ ...raw, size: { ...(raw.size ?? {}), width: num(raw.size?.width, 1), height: r3(Math.max(0.02, Math.abs(beyond(c, { x: c.x, y: n.y }, -OUT).y - c.y) * 2)) } })), { square: true }));
      stopKnobs(c, px);
    } else {
      // Angular: the start direction, a fixed distance from the centre on screen.
      const rad = (num(f.rotation) * Math.PI) / 180;
      const reach = 0.35 * Math.min(box.w, box.h);
      const h = { x: c.x + (-Math.sin(rad) * reach) / box.w, y: c.y + (-Math.cos(rad) * reach) / box.h };
      out.push(line('dir', c, h));
      out.push(knob('center', c, ev => start(ev, n => write({ ...raw, center: { x: r3(n.x), y: r3(n.y) } }))));
      out.push(knob('dir', h, ev => start(ev, n => write({ ...raw, rotation: Math.round((Math.atan2(-(n.x - c.x) * box.w, -(n.y - c.y) * box.h) * 1800) / Math.PI) / 10 })), { square: true }));
    }
  } else {
    const m = meshOf(f);
    const save = (next: Mesh) => write({ ...raw, points: meshToPoints(next) });
    const copy = (): Mesh => ({ ...m, points: m.points.map(q => ({ ...q, left: [...q.left], right: [...q.right], top: [...q.top], bottom: [...q.bottom], own: { ...q.own } })) as any });
    // Grid lines along each row and column, through the handles.
    const curve = (a: (typeof m.points)[0], b: (typeof m.points)[0], ha: [number, number], hb: [number, number], key: string) => {
      const s0 = S(a), s1 = S({ x: a.x + ha[0], y: a.y + ha[1] }), s2 = S({ x: b.x + hb[0], y: b.y + hb[1] }), s3 = S(b);
      out.push(<path key={key} d={`M${s0.x} ${s0.y}C${s1.x} ${s1.y} ${s2.x} ${s2.y} ${s3.x} ${s3.y}`} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={1} />);
    };
    for (let r = 0; r < m.rows; r++) for (let cI = 0; cI < m.cols - 1; cI++) curve(m.points[r * m.cols + cI], m.points[r * m.cols + cI + 1], m.points[r * m.cols + cI].right, m.points[r * m.cols + cI + 1].left, `h${r}-${cI}`);
    for (let cI = 0; cI < m.cols; cI++) for (let r = 0; r < m.rows - 1; r++) curve(m.points[r * m.cols + cI], m.points[(r + 1) * m.cols + cI], m.points[r * m.cols + cI].bottom, m.points[(r + 1) * m.cols + cI].top, `v${cI}-${r}`);
    const sel = m.points[ge.point];
    if (sel) {
      const r = Math.floor(ge.point / m.cols), cI = ge.point % m.cols;
      const sides = [['left', cI > 0], ['right', cI < m.cols - 1], ['top', r > 0], ['bottom', r < m.rows - 1]] as const;
      for (const [name, exists] of sides) {
        if (!exists) continue;
        const h = { x: sel.x + sel[name][0], y: sel.y + sel[name][1] };
        out.push(line('hl' + name, sel, h, true));
        out.push(
          knob('handle-' + name, h, ev =>
            start(ev, n => {
              const next = copy();
              const q = next.points[ge.point];
              q[name] = [n.x - q.x, n.y - q.y];
              q.own[name] = true;
              save(next);
            }), { small: true, square: true }),
        );
      }
    }
    m.points.forEach((q, i) => {
      const r = Math.floor(i / m.cols), cI = i % m.cols;
      const edgeX = cI === 0 || cI === m.cols - 1, edgeY = r === 0 || r === m.rows - 1;
      out.push(
        knob(`point${i}`, q, ev => {
          select(i);
          // Corners stay put; points on an edge slide along it; inner points go anywhere inside.
          if (edgeX && edgeY) return ev.stopPropagation();
          start(ev, n => {
            const next = copy();
            if (!edgeX) next.points[i].x = clamp01(n.x);
            if (!edgeY) next.points[i].y = clamp01(n.y);
            save(next);
          });
        }, { fill: colorCss(f.colors?.[i]), on: ge.point === i }),
      );
    });
  }
  return (
    <svg className="overlay grad-edit" width="100%" height="100%" style={{ zIndex: 11 }}>
      {out}
    </svg>
  );
}
