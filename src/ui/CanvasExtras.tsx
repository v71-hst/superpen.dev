// Canvas overlays beyond selection: smart guides, auto-layout gap handles, prototype links, comment pins, and the
// banners for component-state editing and pending AI changes (review mode).
import React, { useLayoutEffect, useState } from 'react';
import { Check, Trash2, Undo2 } from 'lucide-react';
import { useStore } from '../editor/store';
import type { Tree } from '../editor/tree';
import { worldRectOf, zoomToKeys } from '../editor/ops';
import { displayName } from '../model/doc';
import type { Guides } from '../editor/snapping';
import { commentPos, commentsOf, deleteComment, dropIfEmpty, postMessage, setResolved, type PenComment } from '../editor/comments';
import { acceptPending, rejectPending } from '../editor/review';

type Rect = { x: number; y: number; w: number; h: number };
const stop = (e: React.PointerEvent | React.MouseEvent) => e.stopPropagation();

/**
 * Measures after the canvas has committed its new transform. Measuring during render would combine the previous
 * frame's DOM with the new view, so overlays would lag or jump while panning and zooming.
 */
function useMeasured<T>(measure: () => T, deps: React.DependencyList): T | null {
  const [v, setV] = useState<T | null>(null);
  useLayoutEffect(() => setV(measure()), deps);
  return v;
}

export function CanvasExtras({ tree, draft, onGapStart, dragging }: { tree: Tree; draft: any; onGapStart: (e: React.PointerEvent, key: string, horiz: boolean) => void; dragging: boolean }) {
  const view = useStore(s => s.view);
  const toScreen = (x: number, y: number) => ({ x: view.x + x * view.zoom, y: view.y + y * view.zoom });
  return (
    <>
      <div className="overlay" style={{ zIndex: 3 }}>
        {draft?.guides && <GuideLines guides={draft.guides} toScreen={toScreen} />}
        {draft?.gapLabel && <GapLabel {...draft.gapLabel} />}
        {!dragging && <GapHandles tree={tree} onGapStart={onGapStart} />}
        <PrototypeArrows tree={tree} />
        <CommentPins tree={tree} />
      </div>
      <Banners tree={tree} />
    </>
  );
}

function GuideLines({ guides, toScreen }: { guides: Guides; toScreen: (x: number, y: number) => { x: number; y: number } }) {
  const box = (l: { x1: number; y1: number; x2: number; y2: number }) => {
    const a = toScreen(l.x1, l.y1);
    const b = toScreen(l.x2, l.y2);
    return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.max(1, Math.abs(b.x - a.x)), height: Math.max(1, Math.abs(b.y - a.y)), a, b };
  };
  return (
    <>
      {guides.lines.map((l, i) => {
        const r = box(l);
        return <div key={'l' + i} className="space-guide" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />;
      })}
      {guides.gaps.map((g, i) => {
        const r = box(g);
        return (
          <React.Fragment key={'g' + i}>
            <div className="space-guide" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
            <div className="space-guide-label" style={{ left: (r.a.x + r.b.x) / 2, top: (r.a.y + r.b.y) / 2 }}>
              {g.label}
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
}

function GapLabel({ value, x, y }: { value: number; x: number; y: number }) {
  const c = document.getElementById('pen-canvas')!.getBoundingClientRect();
  return (
    <div className="gap-label" style={{ left: x - c.left, top: y - c.top - 18 }}>
      gap {value}
    </div>
  );
}

/** Draggable handles in the gaps between the children of a selected auto-layout frame. */
function GapHandles({ tree, onGapStart }: { tree: Tree; onGapStart: (e: React.PointerEvent, key: string, horiz: boolean) => void }) {
  const selection = useStore(s => s.selection);
  const view = useStore(s => s.view);
  const doc = useStore(s => s.doc);
  const editingKey = useStore(s => s.editingKey);
  const [rects, setRects] = useState<{ horiz: boolean; gaps: Rect[] } | null>(null);
  const n = selection.length === 1 ? tree.byKey.get(selection[0]) : undefined;
  const layout = n?.type === 'frame' ? (n.props.layout === 'vertical' ? 'vertical' : n.props.layout === 'none' ? 'none' : 'horizontal') : 'none';
  useLayoutEffect(() => {
    if (!n || layout === 'none' || editingKey) return setRects(null);
    const kids = n.children.filter(c => c.props.enabled !== false && !(c.props.layoutPosition === 'absolute')).map(c => worldRectOf(c.key)).filter((r): r is Rect => !!r);
    if (kids.length < 2) return setRects(null);
    const horiz = layout === 'horizontal';
    const gaps: Rect[] = [];
    for (let i = 0; i + 1 < kids.length; i++) {
      const a = kids[i];
      const b = kids[i + 1];
      if (horiz) {
        const top = Math.min(a.y, b.y);
        gaps.push({ x: a.x + a.w, y: top, w: Math.max(0, b.x - (a.x + a.w)), h: Math.max(a.y + a.h, b.y + b.h) - top });
      } else {
        const left = Math.min(a.x, b.x);
        gaps.push({ x: left, y: a.y + a.h, w: Math.max(a.x + a.w, b.x + b.w) - left, h: Math.max(0, b.y - (a.y + a.h)) });
      }
    }
    setRects({ horiz, gaps });
  }, [n, layout, view, doc, editingKey]);
  if (!n || !rects) return null;
  return (
    <>
      {rects.gaps.map((g, i) => {
        // Keep a grabbable area even when the gap is 0 or tiny on screen.
        const z = view.zoom;
        const w = rects.horiz ? Math.max(8, g.w * z) : g.w * z;
        const h = rects.horiz ? g.h * z : Math.max(8, g.h * z);
        const cx = view.x + (g.x + g.w / 2) * z;
        const cy = view.y + (g.y + g.h / 2) * z;
        if ((rects.horiz ? h : w) < 10) return null;
        return (
          <div
            key={i}
            className={'gap-handle ' + (rects.horiz ? 'h' : 'v')}
            title="Drag to change the gap"
            style={{ left: cx - w / 2, top: cy - h / 2, width: w, height: h }}
            onPointerDown={e => onGapStart(e, n.key, rects.horiz)}
          />
        );
      })}
    </>
  );
}

/** Links from the selected layer (or any layer inside the selected frame) to their target frames. */
function PrototypeArrows({ tree }: { tree: Tree }) {
  const selection = useStore(s => s.selection);
  const view = useStore(s => s.view);
  const sel = selection.length === 1 ? tree.byKey.get(selection[0]) : undefined;
  const paths = useMeasured(() => {
    if (!sel) return [];
    const links: { from: string; to: string }[] = [];
    const visit = (n: typeof sel, depth: number) => {
      const l = n.props.link;
      if (l && typeof l === 'object' && typeof l.to === 'string' && tree.byKey.has(l.to)) links.push({ from: n.key, to: l.to });
      if (depth < 12 && links.length < 40) n.children.forEach(c => visit(c, depth + 1));
    };
    visit(sel, 0);
    return arrowPaths(links, view);
  }, [sel, tree, view]);
  if (!paths?.length) return null;
  return (
    <svg className="proto-arrows" width="100%" height="100%">
      {paths.map((p, i) => (
        <g key={i}>
          <path d={p.d} />
          <circle cx={p.sx} cy={p.sy} r={3.5} />
          <path d={`M${p.ex + (p.right ? -7 : 7)},${p.ey - 5} L${p.ex},${p.ey} L${p.ex + (p.right ? -7 : 7)},${p.ey + 5}`} />
        </g>
      ))}
    </svg>
  );
}

function arrowPaths(links: { from: string; to: string }[], view: { x: number; y: number; zoom: number }) {
  const z = view.zoom;
  return links
    .map(({ from, to }) => {
      const a = worldRectOf(from);
      const b = worldRectOf(to);
      if (!a || !b) return null;
      const right = b.x >= a.x + a.w;
      const sx = view.x + (right ? a.x + a.w : a.x) * z;
      const sy = view.y + (a.y + a.h / 2) * z;
      const ex = view.x + (right ? b.x : b.x + b.w) * z;
      const ey = view.y + (b.y + Math.min(b.h / 2, 40)) * z;
      const k = Math.max(40, Math.abs(ex - sx) / 2) * (right ? 1 : -1);
      return { d: `M${sx},${sy} C${sx + k},${sy} ${ex - k},${ey} ${ex},${ey}`, sx, sy, ex, ey, right };
    })
    .filter(Boolean) as { d: string; sx: number; sy: number; ex: number; ey: number; right: boolean }[];
}

function CommentPins({ tree }: { tree: Tree }) {
  const doc = useStore(s => s.doc);
  const view = useStore(s => s.view);
  const open = useStore(s => s.openComment);
  const comments = commentsOf(doc);
  const pos = useMeasured(() => new Map(comments.map(c => [c.id, commentPos(c)])), [doc, view, tree]);
  if (!comments.length || !pos) return null;
  const numbered = comments.map((c, i) => ({ c, i: i + 1 }));
  return (
    <>
      {numbered.map(({ c, i }) => {
        const p = pos.get(c.id) ?? commentPos(c);
        const last = c.messages[c.messages.length - 1];
        return (
          <div
            key={c.id}
            className={'comment-pin' + (c.resolved ? ' resolved' : last?.author === 'agent' ? ' agent' : '')}
            style={{ left: view.x + p.x * view.zoom, top: view.y + p.y * view.zoom }}
            title={last ? `${last.author === 'agent' ? last.name ?? 'Claude' : 'You'}: ${last.text}` : 'New comment'}
            onPointerDown={stop}
            onClick={() => useStore.setState({ openComment: open === c.id ? null : c.id })}
          >
            {i}
          </div>
        );
      })}
      {open && comments.some(c => c.id === open) && <CommentPopover c={comments.find(c => c.id === open)!} tree={tree} at={pos.get(open) ?? null} />}
    </>
  );
}

function CommentPopover({ c, tree, at }: { c: PenComment; tree: Tree; at: { x: number; y: number } | null }) {
  const view = useStore(s => s.view);
  const [text, setText] = useState('');
  const p = at ?? commentPos(c);
  const close = () => {
    useStore.setState({ openComment: null });
    dropIfEmpty(c.id);
  };
  const send = () => {
    const t = text.trim();
    if (!t) return;
    postMessage(c.id, { author: 'user', text: t, t: Date.now() });
    setText('');
  };
  const target = c.node ? tree.byKey.get(c.node) : undefined;
  const node = target ? displayName(target.props) : null;
  return (
    <div className="comment-pop" style={{ left: view.x + p.x * view.zoom + 16, top: view.y + p.y * view.zoom - 12 }} onPointerDown={stop} onWheel={e => e.stopPropagation()}>
      {c.node && <div className="hint">On {node ?? '#' + c.node}</div>}
      {c.messages.map((m, i) => (
        <div key={i} className="comment-msg">
          <span className="who">
            {m.author === 'agent' ? m.name ?? 'Claude' : 'You'} · {new Date(m.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          <span>{m.text}</span>
        </div>
      ))}
      <textarea
        autoFocus
        placeholder={c.messages.length ? 'Reply…' : 'Leave a comment for yourself or Claude…'}
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
          if (e.key === 'Escape') close();
        }}
      />
      <div className="comment-actions">
        <button className="rp-btn" title="Delete thread" onClick={() => (deleteComment(c.id), useStore.setState({ openComment: null }))}>
          <Trash2 />
        </button>
        {c.messages.length > 0 && (
          <button className="rp-btn" onClick={() => setResolved(c.id, !c.resolved)}>
            {c.resolved ? 'Reopen' : 'Resolve'}
          </button>
        )}
        <button className="rp-btn" onClick={close}>
          Close
        </button>
        <button className="rp-btn" style={{ background: 'var(--primary)', color: 'var(--primary-fg)' }} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}

function Banners({ tree }: { tree: Tree }) {
  const stateView = useStore(s => s.stateView);
  const pending = useStore(s => s.pending);
  if (pending) {
    const live = pending.touched.filter(k => tree.byKey.has(k));
    return (
      <div className="canvas-banner review" onPointerDown={stop}>
        <span>
          <b>Claude</b> made {pending.batches} change{pending.batches > 1 ? 's' : ''} ({pending.touched.length} layer{pending.touched.length === 1 ? '' : 's'})
          {pending.mixed ? ' · you edited since' : ''}
        </span>
        {live.length > 0 && (
          <button className="rp-btn" onClick={() => (useStore.getState().select(live), zoomToKeys(live, 40))}>
            Show
          </button>
        )}
        <button className="rp-btn" title={pending.mixed ? 'Restores the file to before Claude’s first pending change (your later edits are undone too)' : 'Restore the file to before these changes'} onClick={rejectPending}>
          <Undo2 /> Reject
        </button>
        <button className="rp-btn primary" onClick={acceptPending}>
          <Check /> Accept
        </button>
      </div>
    );
  }
  if (stateView) {
    const comp = tree.byKey.get(stateView.comp);
    return (
      <div className="canvas-banner state" onPointerDown={stop}>
        <span>
          Editing state <b>{stateView.state}</b> of <b>{comp ? displayName(comp.props) : stateView.comp}</b>
        </span>
        <button className="rp-btn primary" onClick={() => useStore.setState({ stateView: null })}>
          Done
        </button>
      </div>
    );
  }
  return null;
}
