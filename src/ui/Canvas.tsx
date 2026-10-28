// Infinite canvas: renders the document, selection/hover overlay, frame labels and all pointer gestures.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NodeView, RenderCtx, type RenderContextValue } from '../render/NodeView';
import { pickAt, colorFromChain } from '../editor/eyedropper';
import { useStore, keySource, applyProps } from '../editor/store';
import { useTree, ancestry, currentTree, type Tree } from '../editor/tree';
import { canvasRect, clientToWorld, elFor, isAbsolutelyPositioned, markUserViewChange, moveNode, parentLayoutOf, screenRectOf, worldRectOf, zoomBy } from '../editor/ops';
import { makeUrlResolver } from '../editor/fileio';
import { allIds, displayName, locate, newId } from '../model/doc';
import type { PenNode, RNode } from '../model/types';
import { fmt } from './common';
import { onViewChanged, pointerTarget, rootWorldRect, scheduleCull } from '../editor/culling';
import { LOD_ZOOM, bitmapUrl, getBitmap, hasFixedSize, lodEligible, lodInteraction, requestBitmap, type Bitmap } from '../editor/lod';
import { deepResolve, isGeneratedKey } from '../model/resolve';
import { fillList, primaryColor } from '../render/paint';
import { ErrorBoundary, NodeErrorBox } from './ErrorBoundary';
import { snapMove, type Guides } from '../editor/snapping';
import { addComment } from '../editor/comments';
import { CanvasExtras } from './CanvasExtras';

function unionRect(rs: Rect[]): Rect {
  const x0 = Math.min(...rs.map(r => r.x));
  const y0 = Math.min(...rs.map(r => r.y));
  return { x: x0, y: y0, w: Math.max(...rs.map(r => r.x + r.w)) - x0, h: Math.max(...rs.map(r => r.y + r.h)) - y0 };
}

type Rect = { x: number; y: number; w: number; h: number };

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | {
      kind: 'move';
      sx: number;
      sy: number;
      keys: string[];
      starts: Map<string, { x: number; y: number; abs: boolean; world: Rect | null }>;
      moved: boolean;
      fromLabel: boolean;
      /** Selected on mouse-up if the press turns out to be a click rather than a drag. */
      clickKey?: string;
      /** Smart-guide targets (world rects of siblings and the parent) and the moving selection's starting bounds. */
      snap?: { targets: Rect[]; parent: Rect | null; box: Rect };
    }
  | { kind: 'gap'; key: string; sx: number; sy: number; start: number; horiz: boolean }
  | { kind: 'marquee'; sx: number; sy: number; scope: string | null; base: string[] }
  | { kind: 'resize'; key: string; handle: string; sx: number; sy: number; start: Rect; props: any; abs: boolean }
  | { kind: 'draw'; tool: string; sx: number; sy: number; parent: string | null };

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** Ancestor chain of render keys for a DOM element inside the world. */
function chainFromElement(el: Element | null): string[] {
  const out: string[] = [];
  while (el && el.id !== 'pen-world') {
    const k = (el as HTMLElement).dataset?.k;
    // Script output isn't selectable on its own; clicks land on the script node.
    if (k && !isGeneratedKey(k)) out.unshift(k);
    el = el.parentElement;
  }
  return out;
}

/** Figma-style target picking: stay at the depth of the current selection, else the first level inside top frames. */
export function pickFromChain(chain: string[], selection: string[], tree: Tree, deep: boolean): string | null {
  if (!chain.length) return null;
  if (deep) return chain[chain.length - 1];
  let best = -1;
  for (const s of selection) {
    const i = chain.indexOf(s);
    if (i >= 0) best = Math.max(best, Math.min(i + 1, chain.length - 1) === i + 1 ? i + 1 : i);
    const p = tree.parent.get(s);
    if (p) {
      const j = chain.indexOf(p.key);
      if (j >= 0 && j + 1 < chain.length) best = Math.max(best, j + 1);
    }
  }
  if (best >= 0) return chain[best];
  const root = tree.byKey.get(chain[0]);
  if (chain.length > 1 && root && (root.type === 'frame' || root.type === 'group')) return chain[1];
  return chain[0];
}

function containerAt(clientX: number, clientY: number, exclude: Set<string>): string | null {
  const els = document.elementsFromPoint(clientX, clientY);
  const tree = currentTree();
  for (const el of els) {
    if (!(el as HTMLElement).dataset) continue;
    const chain = chainFromElement(el);
    for (let i = chain.length - 1; i >= 0; i--) {
      const k = chain[i];
      if (k.includes('/')) continue;
      if ([...exclude].some(x => chain.slice(0, i + 1).includes(x))) {
        continue;
      }
      const n = tree?.byKey.get(k);
      if (n && n.type === 'frame' && !n.instanceOf && !n.inInstance) return k;
    }
    if (chain.length) {
      if (chain.some(k => exclude.has(k))) continue;
      return null;
    }
  }
  return null;
}

function nodeColorClass(n: RNode | undefined) {
  if (!n) return '';
  if (n.isComponent) return ' component';
  if (n.instanceOf) return ' instance';
  return '';
}

export function Canvas() {
  const doc = useStore(s => s.doc);
  const file = useStore(s => s.file);
  const view = useStore(s => s.view);
  const tool = useStore(s => s.tool);
  const editingKey = useStore(s => s.editingKey);
  const tree = useTree();
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [space, setSpace] = useState(false);
  const [draft, setDraft] = useState<{
    marquee?: Rect;
    draw?: Rect;
    dropLine?: Rect;
    target?: string | null;
    guides?: Guides;
    gapLabel?: { key: string; value: number; x: number; y: number };
  } | null>(null);
  const [penPoints, setPenPoints] = useState<{ x: number; y: number }[]>([]);
  const [penHover, setPenHover] = useState<{ x: number; y: number } | null>(null);

  const resolveUrl = useMemo(() => makeUrlResolver(file?.path ?? null), [file?.path]);
  const onTextCommit = useCallback((key: string, text: string | null) => {
    const s = useStore.getState();
    if (s.editingKey !== key) return;
    useStore.setState({ editingKey: null });
    const n = currentTree()?.byKey.get(key);
    if (text === null || !n) return;
    if (text === '' && keySource(key).kind === 'real' && n.props.content === 'Text' && n.props.name === undefined) {
      s.edit(d => {
        const loc = locate(d, key);
        if (loc) loc.siblings.splice(loc.index, 1);
      });
      s.select([]);
      return;
    }
    if (text !== n.props.content) s.edit(d => applyProps(d, key, { content: text }));
  }, []);
  const vars = doc?.variables;
  const renderCtx: RenderContextValue = useMemo(() => ({ doc: { variables: vars }, resolveUrl, editingKey, onTextCommit }), [vars, resolveUrl, editingKey, onTextCommit]);

  // ---- keyboard: space to pan, pen tool finish ----
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTyping(e)) {
        e.preventDefault();
        setSpace(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpace(false);
    };
    // In a VS Code webview, keyup can be lost when focus moves to the workbench; never leave Space "held".
    const reset = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const finishPen = useCallback(
    (close: boolean) => {
      const pts = penPoints;
      setPenPoints([]);
      setPenHover(null);
      useStore.setState({ tool: 'select' });
      if (pts.length < 2) return;
      const x0 = Math.min(...pts.map(p => p.x));
      const y0 = Math.min(...pts.map(p => p.y));
      const x1 = Math.max(...pts.map(p => p.x));
      const y1 = Math.max(...pts.map(p => p.y));
      const geometry = 'M' + pts.map(p => `${fmt(p.x - x0)} ${fmt(p.y - y0)}`).join('L') + (close ? 'Z' : '');
      const parent = containerAt(...worldToClient(pts[0]), new Set());
      const pr = parent ? worldRectOf(parent) : null;
      const s = useStore.getState();
      let id = '';
      s.edit(d => {
        id = newId(allIds(d));
        const node: PenNode = {
          type: 'path',
          id,
          x: Math.round(x0 - (pr?.x ?? 0)),
          y: Math.round(y0 - (pr?.y ?? 0)),
          name: 'Path',
          geometry,
          viewBox: [0, 0, Math.max(x1 - x0, 0.01), Math.max(y1 - y0, 0.01)],
          width: Math.max(1, Math.round(x1 - x0)),
          height: Math.max(1, Math.round(y1 - y0)),
          stroke: '#000000',
          strokeWidth: 2,
          ...(close ? { fill: '#D9D9D9' } : {}),
        };
        const list = parent ? (locate(d, parent)!.node.children ??= []) : d.children;
        list.push(node);
      });
      s.select([id]);
    },
    [penPoints],
  );

  useEffect(() => {
    if (tool !== 'pen') return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Enter') finishPen(false);
      if (e.key === 'Escape') {
        if (penPoints.length > 1) finishPen(false);
        else {
          setPenPoints([]);
          useStore.setState({ tool: 'select' });
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [tool, finishPen, penPoints.length]);

  // ---- wheel: pan / zoom ----
  useEffect(() => {
    const el = canvasRef.current!;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.island, .menu, .popover')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0035));
        // One event never zooms more than 4x either way, however large the reported delta.
        zoomBy(Math.min(4, Math.max(0.25, factor)), e.clientX, e.clientY);
      } else {
        const { view } = useStore.getState();
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        const mul = e.deltaMode === 1 ? 16 : 1;
        markUserViewChange();
        useStore.getState().setView({ x: view.x - dx * mul, y: view.y - dy * mul });
      }
    };
    // Ctrl+wheel / touchpad pinch anywhere in the editor (panels, toolbar, labels) zooms the canvas. Letting it
    // through would make the browser engine zoom or pinch-magnify the whole page, shifting everything at once.
    const globalZoom = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      if (el.contains(e.target as Node) && !(e.target as HTMLElement).closest('.island, .menu, .popover')) return; // canvas handler zooms
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0035));
      const c = el.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX, c.left), c.right);
      const y = Math.min(Math.max(e.clientY, c.top), c.bottom);
      zoomBy(Math.min(4, Math.max(0.25, factor)), x, y);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('wheel', globalZoom, { passive: false, capture: true });
    return () => {
      el.removeEventListener('wheel', wheel);
      window.removeEventListener('wheel', globalZoom, { capture: true } as any);
    };
  }, []);

  useEffect(() => onViewChanged(), [view]);

  // The view is positioned purely by transform; if anything ever scrolls the canvas container or the page
  // (focus, scrollIntoView, drag auto-scroll), snap it back so the screen and the editor's math stay in sync.
  useEffect(() => {
    const el = canvasRef.current!;
    const targets: (Element | null)[] = [el, document.getElementById('root'), document.body, document.documentElement];
    const fix = () => {
      for (const t of targets) if (t && (t.scrollLeft || t.scrollTop)) {
        t.scrollLeft = 0;
        t.scrollTop = 0;
      }
    };
    for (const t of targets) t?.addEventListener('scroll', fix, { passive: true });
    document.addEventListener('scroll', fix, { passive: true });
    return () => {
      for (const t of targets) t?.removeEventListener('scroll', fix);
      document.removeEventListener('scroll', fix);
    };
  }, []);
  useEffect(() => scheduleCull(), [tree]);

  const panning = space || tool === 'hand';

  // ---- pointer gestures ----
  const onPointerDown = (e: React.PointerEvent) => {
    const target = pointerTarget(e);
    if (target.closest('[data-editing]')) return;
    if (target.closest('.island, .menu, .popover')) return;
    // Stop the browser's own text selection / native drag-and-drop: they cancel our pointer gestures mid-drag
    // (pointercancel) and can auto-scroll the canvas container, shifting the whole view.
    if (e.pointerType === 'mouse') e.preventDefault();
    const s = useStore.getState();
    if (s.editingKey) (document.activeElement as HTMLElement)?.blur?.();
    if (!tree) return;
    (document.activeElement as HTMLElement)?.blur?.();
    canvasRef.current?.focus({ preventScroll: true });
    if (e.button === 1 || panning || (e.button === 0 && e.altKey && e.shiftKey === false && false)) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: s.view.x, vy: s.view.y };
      capture(e);
      return;
    }
    if (e.button === 2) {
      return;
    }
    if (e.button !== 0) return;

    if (tool === 'pen') {
      const w = clientToWorld(e.clientX, e.clientY);
      if (penPoints.length > 2) {
        const first = penPoints[0];
        if (Math.hypot(first.x - w.x, first.y - w.y) * s.view.zoom < 8) return finishPen(true);
      }
      if (e.detail >= 2 && penPoints.length >= 2) return finishPen(false);
      setPenPoints(p => [...p, { x: Math.round(w.x), y: Math.round(w.y) }]);
      return;
    }

    if (tool === 'eyedropper') {
      pickAt(chainFromElement(target), e.shiftKey);
      return;
    }

    if (tool === 'comment') {
      // Pin to the deepest real node under the pointer so the comment follows it.
      const chain = chainFromElement(target).filter(k => keySource(k).kind === 'real');
      const id = addComment(clientToWorld(e.clientX, e.clientY), chain[chain.length - 1] ?? null);
      useStore.setState({ openComment: id, tool: 'select' });
      return;
    }

    if (tool !== 'select' && tool !== 'scale') {
      const parent = containerAt(e.clientX, e.clientY, new Set());
      drag.current = { kind: 'draw', tool, sx: e.clientX, sy: e.clientY, parent };
      capture(e);
      return;
    }

    // Frame label: select / drag the top-level node.
    const labelKey = target.closest<HTMLElement>('[data-label-k]')?.dataset.labelK;
    if (labelKey) {
      if (e.detail >= 2) return;
      if (e.shiftKey) s.select(s.selection.includes(labelKey) ? s.selection.filter(k => k !== labelKey) : [...s.selection, labelKey]);
      else if (!s.selection.includes(labelKey)) s.select([labelKey]);
      startMove(e, true);
      return;
    }

    // Zoomed-out bitmap/placeholder frames: select the frame (it then renders live for detailed editing).
    if (target.dataset.bitmap !== undefined || target.dataset.placeholder !== undefined) {
      const k = target.dataset.k!;
      if (e.shiftKey) s.select(s.selection.includes(k) ? s.selection.filter(x => x !== k) : [...s.selection, k]);
      else if (!s.selection.includes(k)) s.select([k]);
      startMove(e, true);
      return;
    }

    const chain = chainFromElement(target);
    if (!chain.length) {
      drag.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY, scope: null, base: e.shiftKey ? s.selection : [] };
      if (!e.shiftKey) s.select([]);
      capture(e);
      return;
    }

    const deep = e.ctrlKey || e.metaKey;
    let key = pickFromChain(chain, s.selection, tree, deep)!;

    // Pressing on a top-level frame's own background starts a marquee over its children.
    if (!deep && chain.length === 1 && !s.selection.includes(key)) {
      const root = tree.byKey.get(key);
      if (root && root.type === 'frame' && root.children.length) {
        drag.current = { kind: 'marquee', sx: e.clientX, sy: e.clientY, scope: key, base: e.shiftKey ? s.selection : [] };
        if (!e.shiftKey) s.select([]);
        capture(e);
        return;
      }
    }

    if (e.detail >= 2) {
      // Double click: drill one level deeper, or edit text.
      const cur = s.selection[0];
      const i = cur ? chain.indexOf(cur) : -1;
      const n = tree.byKey.get(cur ?? '');
      if (n && n.type === 'text' && i === chain.length - 1) {
        useStore.setState({ editingKey: cur });
        return;
      }
      if (i >= 0 && i + 1 < chain.length) {
        key = chain[i + 1];
        const nn = tree.byKey.get(key);
        s.select([key]);
        if (nn?.type === 'text' && i + 1 === chain.length - 1) useStore.setState({ editingKey: key });
        return;
      }
    }

    if (e.shiftKey) {
      s.select(s.selection.includes(key) ? s.selection.filter(k => k !== key) : [...s.selection.filter(k => !chain.includes(k)), key]);
      return;
    }
    // Pressing inside an already selected node drags it; a plain click then selects the child.
    const selectedAncestor = !deep && s.selection.find(k => chain.includes(k) && chain.indexOf(k) < chain.indexOf(key));
    if (selectedAncestor) {
      startMove(e, false);
      if (drag.current?.kind === 'move') drag.current.clickKey = key;
      return;
    }
    if (!s.selection.includes(key)) s.select([key]);
    startMove(e, false);
  };

  function capture(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function startMove(e: React.PointerEvent, fromLabel: boolean) {
    const s = useStore.getState();
    const starts = new Map<string, { x: number; y: number; abs: boolean; world: Rect | null }>();
    for (const k of s.selection) {
      const n = currentTree()?.byKey.get(k);
      if (!n) continue;
      starts.set(k, { x: n.props.x ?? 0, y: n.props.y ?? 0, abs: isAbsolutelyPositioned(k), world: worldRectOf(k) });
    }
    drag.current = { kind: 'move', sx: e.clientX, sy: e.clientY, keys: [...s.selection], starts, moved: false, fromLabel, snap: snapContext(s.selection, starts) };
    capture(e);
  }

  /** Snap targets for freely positioned nodes that share one parent: the other children and the parent itself. */
  function snapContext(keys: string[], starts: Map<string, { abs: boolean; world: Rect | null }>) {
    const tr = currentTree();
    if (!tr || !keys.length || !keys.every(k => starts.get(k)?.abs && starts.get(k)?.world)) return undefined;
    const parents = new Set(keys.map(k => tr.parent.get(k)?.key ?? null));
    if (parents.size !== 1) return undefined;
    const parentKey = [...parents][0];
    const siblings = parentKey ? (tr.byKey.get(parentKey)?.children ?? []) : tr.roots;
    // Only nearby siblings matter; capping keeps the start of a drag fast in huge files.
    const worlds = keys.map(k => starts.get(k)!.world!);
    const box = unionRect(worlds);
    const v = useStore.getState().view;
    const c = canvasRect();
    const viewW = { x: -v.x / v.zoom, y: -v.y / v.zoom, w: c.width / v.zoom, h: c.height / v.zoom };
    const targets: Rect[] = [];
    for (const n of siblings) {
      if (keys.includes(n.key) || n.props.enabled === false) continue;
      const p = n.props;
      // Top-level frames: use document positions (no layout read); nested children are measured.
      const r = !parentKey && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.width === 'number' && typeof p.height === 'number' ? { x: p.x, y: p.y, w: p.width, h: p.height } : worldRectOf(n.key);
      if (!r) continue;
      if (r.x > viewW.x + viewW.w * 2 || r.x + r.w < viewW.x - viewW.w || r.y > viewW.y + viewW.h * 2 || r.y + r.h < viewW.y - viewW.h) continue;
      targets.push(r);
      if (targets.length > 400) break;
    }
    return { targets, parent: parentKey ? worldRectOf(parentKey) : null, box };
  }

  const onGapStart = (e: React.PointerEvent, key: string, horiz: boolean) => {
    if (panning || e.button !== 0) return;
    e.stopPropagation();
    const n = currentTree()?.byKey.get(key);
    if (!n) return;
    const g = deepResolve(useStore.getState().doc as any, n.props.gap, n.theme);
    drag.current = { kind: 'gap', key, sx: e.clientX, sy: e.clientY, start: typeof g === 'number' ? g : 0, horiz };
    canvasRef.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    lodInteraction();
    // A release outside the webview (or a lost pointer capture) can swallow pointerup. If no button is down any
    // more, finish the gesture instead of letting a stale drag yank the view or the selection around.
    if (drag.current && e.buttons === 0 && e.pointerType === 'mouse') {
      onPointerUp(e);
      return;
    }
    const d = drag.current;
    const s = useStore.getState();
    if (!d) {
      if (tool === 'pen') setPenHover(clientToWorld(e.clientX, e.clientY));
      if (tool === 'eyedropper' && !panning) {
        const k = colorFromChain(chainFromElement(pointerTarget(e)))?.key ?? null;
        if (k !== s.hover) s.set({ hover: k });
      }
      if ((tool === 'select' || tool === 'scale') && !panning && tree) {
        const t = pointerTarget(e);
        const lk = t.closest<HTMLElement>('[data-label-k]')?.dataset.labelK;
        const chain = chainFromElement(t);
        const k = lk ?? (chain.length ? pickFromChain(chain, s.selection, tree, e.ctrlKey || e.metaKey) : null);
        if (k !== s.hover) s.set({ hover: k });
      }
      return;
    }
    const z = s.view.zoom;
    if (d.kind === 'pan') {
      markUserViewChange();
      s.setView({ x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy });
      return;
    }
    if (d.kind === 'marquee') {
      const c = canvasRect();
      const r = { x: Math.min(d.sx, e.clientX) - c.left, y: Math.min(d.sy, e.clientY) - c.top, w: Math.abs(e.clientX - d.sx), h: Math.abs(e.clientY - d.sy) };
      setDraft({ marquee: r });
      const candidates = d.scope ? (tree?.byKey.get(d.scope)?.children ?? []) : (tree?.roots ?? []);
      const hits: string[] = [];
      for (const n of candidates) {
        const sr = screenRectOf(n.key);
        if (!sr) continue;
        const x = sr.left - c.left;
        const y = sr.top - c.top;
        if (x < r.x + r.w && x + sr.width > r.x && y < r.y + r.h && y + sr.height > r.y) hits.push(n.key);
      }
      const next = [...new Set([...d.base, ...hits])];
      if (next.join() !== s.selection.join()) s.select(next);
      return;
    }
    if (d.kind === 'draw') {
      const c = canvasRect();
      let w = Math.abs(e.clientX - d.sx);
      let h = Math.abs(e.clientY - d.sy);
      if (e.shiftKey) w = h = Math.max(w, h);
      const x = (e.clientX < d.sx ? d.sx - w : d.sx) - c.left;
      const y = (e.clientY < d.sy ? d.sy - h : d.sy) - c.top;
      setDraft({ draw: { x, y, w, h } });
      return;
    }
    if (d.kind === 'resize') {
      const dx = (e.clientX - d.sx) / z;
      const dy = (e.clientY - d.sy) / z;
      let { x, y, w, h } = d.start;
      const hd = d.handle;
      if (hd.includes('e')) w = d.start.w + dx;
      if (hd.includes('w')) {
        w = d.start.w - dx;
        x = d.start.x + dx;
      }
      if (hd.includes('s')) h = d.start.h + dy;
      if (hd.includes('n')) {
        h = d.start.h - dy;
        y = d.start.y + dy;
      }
      if (e.shiftKey && d.start.w && d.start.h) {
        const ratio = d.start.w / d.start.h;
        if (hd === 'n' || hd === 's') w = h * ratio;
        else if (hd === 'e' || hd === 'w') h = w / ratio;
        else if (Math.abs(w / d.start.w) > Math.abs(h / d.start.h)) h = w / ratio;
        else w = h * ratio;
        if (hd.includes('w')) x = d.start.x + d.start.w - w;
        if (hd.includes('n')) y = d.start.y + d.start.h - h;
      }
      if (e.altKey) {
        const cx = d.start.x + d.start.w / 2;
        const cy = d.start.y + d.start.h / 2;
        if (hd.includes('e') || hd.includes('w')) {
          w = hd.includes('e') ? d.start.w + dx * 2 : d.start.w - dx * 2;
          x = cx - w / 2;
        }
        if (hd.includes('n') || hd.includes('s')) {
          h = hd.includes('s') ? d.start.h + dy * 2 : d.start.h - dy * 2;
          y = cy - h / 2;
        }
      }
      w = Math.max(1, w);
      h = Math.max(1, h);
      const changes: any = {};
      const horiz = hd.includes('e') || hd.includes('w') || e.shiftKey;
      const vert = hd.includes('n') || hd.includes('s') || e.shiftKey;
      if (horiz) changes.width = Math.round(w * 100) / 100;
      if (vert) changes.height = Math.round(h * 100) / 100;
      if (d.abs) {
        if (horiz) changes.x = Math.round((d.props.x + (x - d.start.x)) * 100) / 100;
        if (vert) changes.y = Math.round((d.props.y + (y - d.start.y)) * 100) / 100;
      }
      const n = currentTree()?.byKey.get(d.key);
      if (n?.type === 'text') {
        const g = n.props.textGrowth ?? 'auto';
        if (vert && (hd.includes('n') || hd.includes('s'))) {
          changes.textGrowth = 'fixed-width-height';
          changes.width = changes.width ?? Math.round(d.start.w * 100) / 100;
        } else if (g === 'auto') changes.textGrowth = 'fixed-width';
        if (changes.textGrowth === 'fixed-width') delete changes.height;
      }
      s.edit(dd => applyProps(dd, d.key, changes), 'resize-' + d.key);
      return;
    }
    if (d.kind === 'gap') {
      const delta = (d.horiz ? e.clientX - d.sx : e.clientY - d.sy) / z;
      const gap = Math.max(0, Math.round(d.start + delta));
      s.edit(dd => applyProps(dd, d.key, { gap }), 'gap-' + d.key);
      setDraft({ gapLabel: { key: d.key, value: gap, x: e.clientX, y: e.clientY } });
      return;
    }
    if (d.kind === 'move') {
      const dxs = e.clientX - d.sx;
      const dys = e.clientY - d.sy;
      if (!d.moved && Math.hypot(dxs, dys) < 3) return;
      d.moved = true;
      let dx = dxs / z;
      let dy = dys / z;
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      // Smart guides (hold Ctrl to move freely).
      let guides: Guides | null = null;
      if (d.snap && !e.ctrlKey && !e.metaKey) {
        const b = d.snap.box;
        const r = snapMove({ x: b.x + dx, y: b.y + dy, w: b.w, h: b.h }, d.snap.targets, d.snap.parent, 5 / z);
        // Rounded positions must still line up with the guide.
        if (!(e.shiftKey && dx === 0)) dx = Math.round(b.x + dx + r.dx) - b.x;
        if (!(e.shiftKey && dy === 0)) dy = Math.round(b.y + dy + r.dy) - b.y;
        guides = r.guides;
      }
      const absKeys = d.keys.filter(k => d.starts.get(k)?.abs);
      setDraft(guides && (guides.lines.length || guides.gaps.length) ? { guides } : null);
      if (absKeys.length) {
        s.edit(dd => {
          for (const k of absKeys) {
            const st = d.starts.get(k)!;
            applyProps(dd, k, { x: Math.round(st.x + dx), y: Math.round(st.y + dy) });
          }
        }, 'move');
      }
      // Drop target feedback for reparenting / flex reordering.
      const realKeys = d.keys.filter(k => keySource(k).kind === 'real');
      const isTop = realKeys.every(k => !currentTree()?.parent.get(k));
      if (realKeys.length && !(isTop && absKeys.length === realKeys.length)) {
        const target = containerAt(e.clientX, e.clientY, new Set(realKeys));
        const line = flexDropLine(target, e.clientX, e.clientY, realKeys);
        setDraft({ target, dropLine: line?.rect, guides: guides ?? undefined });
      }
      return;
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    const s = useStore.getState();
    setDraft(null);
    if (!d) return;
    if (d.kind === 'draw') return finishDraw(d, e);
    if (d.kind === 'move' && !d.moved && d.clickKey) {
      s.select([d.clickKey]);
      return;
    }
    if (d.kind === 'move' && d.moved) {
      const realKeys = d.keys.filter(k => keySource(k).kind === 'real');
      const tr = currentTree();
      const isTop = realKeys.every(k => !tr?.parent.get(k));
      if (!realKeys.length || (isTop && d.keys.every(k => d.starts.get(k)?.abs))) return;
      const target = containerAt(e.clientX, e.clientY, new Set(realKeys));
      const first = realKeys[0];
      const curParent = tr?.parent.get(first)?.key ?? null;
      const targetLayout = target ? flexLayoutOf(target) : 'none';
      if (target === curParent && targetLayout === 'none') return;
      const line = flexDropLine(target, e.clientX, e.clientY, realKeys);
      const targetWorld = target ? worldRectOf(target) : { x: 0, y: 0, w: 0, h: 0 };
      const worlds = new Map(realKeys.map(k => [k, worldRectOf(k)]));
      s.edit(dd => {
        let index = line ? line.index : Number.MAX_SAFE_INTEGER;
        for (const k of realKeys) {
          const loc = locate(dd, k);
          if (!loc) continue;
          // Removing from the same list shifts later indices.
          if (target === (loc.parent?.id ?? null) && loc.index < index && index !== Number.MAX_SAFE_INTEGER) index--;
          const wr = worlds.get(k);
          moveNode(dd, k, target, index, targetLayout === 'none' && wr ? { x: wr.x, y: wr.y } : undefined, targetWorld ?? undefined);
          if (index !== Number.MAX_SAFE_INTEGER) index++;
        }
      }, 'move');
      return;
    }
  };

  function flexLayoutOf(key: string): 'none' | 'horizontal' | 'vertical' {
    const n = currentTree()?.byKey.get(key);
    if (!n || n.type !== 'frame') return 'none';
    const l = n.props.layout;
    return l === 'none' || l === 'vertical' ? l : 'horizontal';
  }

  function flexDropLine(target: string | null, cx: number, cy: number, dragged: string[]): { index: number; rect: Rect } | null {
    if (!target) return null;
    const layout = flexLayoutOf(target);
    if (layout === 'none') return null;
    const n = currentTree()?.byKey.get(target);
    const tr = screenRectOf(target);
    if (!n || !tr) return null;
    const c = canvasRect();
    const kids = n.children.filter(k => !dragged.includes(k.key) && k.props.enabled !== false);
    const horiz = layout === 'horizontal';
    let index = n.children.length;
    let pos = horiz ? tr.right - 4 : tr.bottom - 4;
    for (const k of kids) {
      const r = screenRectOf(k.key);
      if (!r) continue;
      const mid = horiz ? r.left + r.width / 2 : r.top + r.height / 2;
      if ((horiz ? cx : cy) < mid) {
        index = n.children.indexOf(k);
        pos = (horiz ? r.left : r.top) - 2;
        break;
      }
    }
    const rect = horiz ? { x: pos - c.left, y: tr.top - c.top, w: 2, h: tr.height } : { x: tr.left - c.left, y: pos - c.top, w: tr.width, h: 2 };
    return { index, rect };
  }

  function finishDraw(d: Extract<Drag, { kind: 'draw' }>, e: React.PointerEvent) {
    const s = useStore.getState();
    const a = clientToWorld(d.sx, d.sy);
    const b = clientToWorld(e.clientX, e.clientY);
    let w = Math.abs(b.x - a.x);
    let h = Math.abs(b.y - a.y);
    if (e.shiftKey) w = h = Math.max(w, h);
    const clicked = w * s.view.zoom < 3 && h * s.view.zoom < 3;
    const x0 = clicked ? a.x : b.x < a.x ? a.x - w : a.x;
    const y0 = clicked ? a.y : b.y < a.y ? a.y - h : a.y;
    const defaults: Record<string, [number, number]> = { frame: [400, 300], rect: [100, 100], ellipse: [100, 100], polygon: [100, 100], icon: [24, 24], note: [240, 160], text: [0, 0] };
    if (clicked) [w, h] = defaults[d.tool] ?? [100, 100];
    const pr = d.parent ? worldRectOf(d.parent) : null;
    const x = Math.round(x0 - (pr?.x ?? 0));
    const y = Math.round(y0 - (pr?.y ?? 0));
    w = Math.round(w);
    h = Math.round(h);
    let node: PenNode;
    const base = { x, y };
    switch (d.tool) {
      case 'frame':
        node = { type: 'frame', id: '', ...base, name: 'Frame', width: w, height: h, fill: '#FFFFFF', layout: 'none', children: [] };
        break;
      case 'rect':
        node = { type: 'rectangle', id: '', ...base, name: 'Rectangle', width: w, height: h, fill: '#D9D9D9' };
        break;
      case 'ellipse':
        node = { type: 'ellipse', id: '', ...base, name: 'Ellipse', width: w, height: h, fill: '#D9D9D9' };
        break;
      case 'polygon':
        node = { type: 'polygon', id: '', ...base, name: 'Polygon', polygonCount: 3, width: w, height: h, fill: '#D9D9D9' };
        break;
      case 'icon':
        node = { type: 'icon', id: '', ...base, name: 'Icon', width: w, height: h, icon: 'star', library: 'lucide', fill: '#000000' };
        break;
      case 'note':
        node = { type: 'note', id: '', ...base, width: w, height: h, content: '' };
        break;
      case 'text':
      default:
        node = clicked
          ? { type: 'text', id: '', ...base, fill: '#000000', content: 'Text', fontFamily: 'Inter', fontSize: 14 }
          : { type: 'text', id: '', ...base, fill: '#000000', textGrowth: 'fixed-width', width: w, content: 'Text', fontFamily: 'Inter', fontSize: 14 };
    }
    if (d.parent && flexLayoutOf(d.parent) !== 'none') {
      delete node.x;
      delete node.y;
    }
    let id = '';
    s.edit(dd => {
      id = newId(allIds(dd));
      node.id = id;
      const list = d.parent ? (locate(dd, d.parent)!.node.children ??= []) : dd.children;
      list.push(node);
    });
    useStore.setState({ tool: 'select', selection: [id], editingKey: d.tool === 'text' ? id : null });
  }

  function worldToClient(p: { x: number; y: number }): [number, number] {
    const c = canvasRect();
    const v = useStore.getState().view;
    return [c.left + v.x + p.x * v.zoom, c.top + v.y + p.y * v.zoom];
  }

  const onResizeStart = (e: React.PointerEvent, key: string, handle: string) => {
    // Space / hand tool always pans, even when the press lands on a selection handle.
    if (panning || e.button !== 0) return;
    e.stopPropagation();
    const n = currentTree()?.byKey.get(key);
    const wr = worldRectOf(key);
    if (!n || !wr) return;
    drag.current = {
      kind: 'resize',
      key,
      handle,
      sx: e.clientX,
      sy: e.clientY,
      start: wr,
      props: { x: n.props.x ?? 0, y: n.props.y ?? 0 },
      abs: isAbsolutelyPositioned(key),
    };
    canvasRef.current!.setPointerCapture(e.pointerId);
  };

  const cursor = drag.current?.kind === 'pan' ? 'grabbing' : panning ? 'grab' : tool !== 'select' && tool !== 'scale' ? 'crosshair' : 'default';

  return (
    <div
      id="pen-canvas"
      ref={canvasRef}
      tabIndex={-1}
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onLostPointerCapture={e => drag.current && onPointerUp(e)}
      onDragStart={e => e.preventDefault()}
      onPointerLeave={() => useStore.getState().hover && useStore.getState().set({ hover: null })}
      onContextMenu={e => e.preventDefault()}
    >
      <div id="pen-world" aria-hidden style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
        <RenderCtx.Provider value={renderCtx}>{tree && <Roots tree={tree} />}</RenderCtx.Provider>
      </div>
      {tree && <Overlay tree={tree} onResizeStart={onResizeStart} draft={draft} />}
      {tree && <CanvasExtras tree={tree} draft={draft} onGapStart={onGapStart} dragging={!!drag.current} />}
      {tool === 'pen' && penPoints.length > 0 && <PenPreview points={penPoints} hover={penHover} />}
    </div>
  );
}

function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

function PenPreview({ points, hover }: { points: { x: number; y: number }[]; hover: { x: number; y: number } | null }) {
  const view = useStore(s => s.view);
  const pts = hover ? [...points, hover] : points;
  const sp = (p: { x: number; y: number }) => `${view.x + p.x * view.zoom},${view.y + p.y * view.zoom}`;
  return (
    <svg className="overlay" width="100%" height="100%">
      <polyline points={pts.map(sp).join(' ')} fill="none" stroke="#3d99ff" strokeWidth={1.5} />
      {points.map((p, i) => {
        const [x, y] = sp(p).split(',').map(Number);
        return <rect key={i} x={x - 3.5} y={y - 3.5} width={7} height={7} fill="#fff" stroke="#3d99ff" />;
      })}
    </svg>
  );
}

/** Selection boxes, hover outline, handles, size badge and top-level frame labels (screen space). */
function Overlay({ tree, onResizeStart, draft }: { tree: Tree; onResizeStart: (e: React.PointerEvent, key: string, handle: string) => void; draft: any }) {
  const selection = useStore(s => s.selection);
  const hover = useStore(s => s.hover);
  const view = useStore(s => s.view);
  const doc = useStore(s => s.doc);
  const editingKey = useStore(s => s.editingKey);
  const [tick, setTick] = useState(0);
  const [boxes, setBoxes] = useState<{ sel: { key: string; r: Rect }[]; hover: Rect | null; labels: { key: string; r: Rect }[] }>({ sel: [], hover: null, labels: [] });
  const [renaming, setRenaming] = useState<string | null>(null);

  useEffect(() => {
    const bump = () => setTick(t => t + 1);
    document.fonts?.addEventListener?.('loadingdone', bump);
    window.addEventListener('resize', bump);
    const t = setTimeout(bump, 400);
    return () => {
      document.fonts?.removeEventListener?.('loadingdone', bump);
      window.removeEventListener('resize', bump);
      clearTimeout(t);
    };
  }, [doc]);

  useLayoutEffect(() => {
    const c = canvasRect();
    const toLocal = (r: DOMRect): Rect => ({ x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height });
    const sel = selection.map(key => ({ key, r: screenRectOf(key) })).filter(x => x.r).map(x => ({ key: x.key, r: toLocal(x.r!) }));
    const hr = hover && !selection.includes(hover) ? screenRectOf(hover) : null;
    // Label positions come from the document and the view where possible: measuring every frame on each zoom step
    // forces a layout of the whole design.
    const labels = tree.roots
      .filter(n => n.props.enabled !== false && (n.type === 'frame' || n.instanceOf || n.isComponent || n.type === 'group'))
      .map(n => {
        const w = rootWorldRect(n);
        if (w) return { key: n.key, r: { x: view.x + w.x * view.zoom, y: view.y + w.y * view.zoom, w: w.w * view.zoom, h: w.h * view.zoom } as Rect | null };
        const b = elFor(n.key)?.getBoundingClientRect();
        return { key: n.key, r: b ? toLocal(b) : null };
      })
      .filter((x): x is { key: string; r: Rect } => !!x.r && x.r.x + x.r.w > 0 && x.r.x < c.width && x.r.y + x.r.h > -24 && x.r.y - 24 < c.height);
    setBoxes({ sel, hover: hr ? toLocal(hr) : null, labels });
  }, [tree, selection, hover, view, tick, editingKey]);

  const single = boxes.sel.length === 1 ? boxes.sel[0] : null;
  const singleNode = single ? tree.byKey.get(single.key) : undefined;
  const multi = boxes.sel.length > 1;
  const union = multi
    ? (() => {
        const x0 = Math.min(...boxes.sel.map(b => b.r.x));
        const y0 = Math.min(...boxes.sel.map(b => b.r.y));
        return { x: x0, y: y0, w: Math.max(...boxes.sel.map(b => b.r.x + b.r.w)) - x0, h: Math.max(...boxes.sel.map(b => b.r.y + b.r.h)) - y0 };
      })()
    : null;
  const z = view.zoom;
  const canResize = single && singleNode && singleNode.type !== 'group' && !editingKey;
  const hoverNode = hover ? tree.byKey.get(hover) : undefined;

  return (
    <div className="overlay">
      {boxes.labels.map(({ key, r }) => {
        // Label boxes are measured after render, so they can still list a frame an edit just deleted.
        const n = tree.byKey.get(key);
        if (!n) return null;
        // Hover does not restyle labels: any DOM change forces the browser to re-process the whole document's paint.
        const cls = 'frame-label' + (selection.includes(key) ? ' sel' : '') + (n.isComponent ? ' component' : '');
        return (
          <div
            key={key}
            className={cls}
            data-label-k={key}
            style={{ left: r.x, top: r.y - 20, maxWidth: Math.max(r.w, 24), pointerEvents: 'auto', height: 18 }}
            onDoubleClick={() => keySource(key).kind === 'real' && setRenaming(key)}
          >
            {renaming === key ? (
              <input
                className="rename"
                autoFocus
                defaultValue={displayName(n.props)}
                onPointerDown={e => e.stopPropagation()}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                }}
                onBlur={e => {
                  const v = e.target.value.trim();
                  setRenaming(null);
                  if (v && v !== n.props.name) useStore.getState().edit(d => applyProps(d, key, { name: v }));
                }}
              />
            ) : (
              displayName(n.props)
            )}
          </div>
        );
      })}
      <HoverCanvas rect={draft?.target ? null : boxes.hover} color={hoverNode?.isComponent ? '#d946ef' : hoverNode?.instanceOf ? '#8b5cf6' : '#3d99ff'} />
      {draft?.target &&
        (() => {
          const r = screenRectOf(draft.target);
          if (!r) return null;
          const c = canvasRect();
          return <div className="hover-box" style={{ left: r.left - c.left, top: r.top - c.top, width: r.width, height: r.height }} />;
        })()}
      {boxes.sel.map(({ key, r }) => (
        <div key={key} className={'sel-box' + nodeColorClass(tree.byKey.get(key))} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
      ))}
      {union && <div className="sel-box" style={{ left: union.x, top: union.y, width: union.w, height: union.h }} />}
      {canResize &&
        HANDLES.filter(h => h.length === 2 || (single!.r.w > 24 && single!.r.h > 24)).map(h => {
          const r = single!.r;
          const x = h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2;
          const y = h.includes('n') ? r.y : h.includes('s') ? r.y + r.h : r.y + r.h / 2;
          const cursor = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' }[h];
          const edge = h.length === 1;
          return (
            <div
              key={h}
              className="handle"
              style={{
                left: x,
                top: y,
                cursor,
                ...(edge ? { opacity: 0, width: h === 'n' || h === 's' ? Math.max(r.w - 16, 4) : 8, height: h === 'e' || h === 'w' ? Math.max(r.h - 16, 4) : 8 } : {}),
              }}
              onPointerDown={e => onResizeStart(e, single!.key, h)}
            />
          );
        })}
      {(single || union) &&
        !editingKey &&
        (() => {
          const r = single ? single.r : union!;
          let w = r.w / z;
          let h = r.h / z;
          if (single && singleNode) {
            const p = singleNode.props;
            if (typeof p.width === 'number' && !p.rotation) w = p.width;
            if (typeof p.height === 'number' && !p.rotation && !(singleNode.type === 'text' && !p.textGrowth)) h = p.height;
          }
          return (
            <div className={'size-badge' + (single ? nodeColorClass(singleNode) : '')} style={{ left: r.x + r.w / 2, top: r.y + r.h + 6 }}>
              {fmt(w, 1)} × {fmt(h, 1)}
            </div>
          );
        })()}
      {draft?.marquee && <div className="marquee" style={{ left: draft.marquee.x, top: draft.marquee.y, width: draft.marquee.w, height: draft.marquee.h }} />}
      {draft?.draw && <div className="draw-box" style={{ left: draft.draw.x, top: draft.draw.y, width: draft.draw.w, height: draft.draw.h }} />}
      {draft?.dropLine && <div className="drop-line" style={{ left: draft.dropLine.x, top: draft.dropLine.y, width: draft.dropLine.w, height: draft.dropLine.h }} />}
    </div>
  );
}

/**
 * Top-level frames. When zoomed out, big frames are drawn from background-rendered bitmaps (GPU textures) instead
 * of live DOM; a frame switches back to live as soon as it is selected/edited, pinned by an agent, or zoomed into.
 */
const LIVE_MOUNTS_PER_FRAME = 3;

function Roots({ tree }: { tree: Tree }) {
  const zoom = useStore(s => s.view.zoom);
  const selection = useStore(s => s.selection);
  const editingKey = useStore(s => s.editingKey);
  const pinnedRoots = useStore(s => s.pinnedRoots);
  useStore(s => s.lodVersion);
  const mounted = useRef(new Set<string>());
  const [, setTick] = useState(0);

  const active = new Set<string>();
  const now = Date.now();
  let nextExpiry = Infinity;
  for (const [k, until] of Object.entries(pinnedRoots)) {
    if (until > now) {
      active.add(k);
      nextExpiry = Math.min(nextExpiry, until);
    }
  }
  for (const k of [...selection, ...(editingKey ? [editingKey] : [])]) active.add(ancestry(tree, k)[0]);

  // Re-render when a pin expires so the frame can drop back to its bitmap.
  useEffect(() => {
    if (!isFinite(nextExpiry)) return;
    const t = setTimeout(() => setTick(x => x + 1), nextExpiry - Date.now() + 20);
    return () => clearTimeout(t);
  }, [nextExpiry]);

  const lodOn = zoom < LOD_ZOOM;
  const dpr = devicePixelRatio || 1;
  const want: string[] = [];
  const nextMounted = new Set<string>();
  // Switching many frames from bitmap to live at once stalls a frame, so only a few go live per frame (on-screen
  // first); the others keep showing their (stretched) bitmap until their turn. Selected frames always go live.
  const { x: vx, y: vy } = useStore.getState().view;
  const onScreen = (p: RNode['props']) =>
    (p.x ?? 0) * zoom + vx < innerWidth && ((p.x ?? 0) + (p.width ?? 0)) * zoom + vx > 0 && (p.y ?? 0) * zoom + vy < innerHeight && ((p.y ?? 0) + (p.height ?? 0)) * zoom + vy > 0;
  let budget = LIVE_MOUNTS_PER_FRAME;
  let deferred = false;
  const live = (n: RNode, bm: Bitmap | undefined) => {
    if (bm && !mounted.current.has(n.key) && !active.has(n.key)) {
      if (budget <= 0 || (budget < LIVE_MOUNTS_PER_FRAME && !onScreen(n.props))) {
        deferred = true;
        return <BitmapRoot key={n.key} n={n} bm={bm} zoom={zoom} />;
      }
      budget--;
    }
    nextMounted.add(n.key);
    return <SafeRoot key={n.key} n={n} />;
  };
  const order = [...tree.roots].sort((a, b) => +onScreen(b.props) - +onScreen(a.props));
  const byKey = new Map<string, React.ReactNode>();
  for (const n of order) {
    if (n.props.enabled === false) continue;
    const eligible = lodEligible(n);
    const bm = eligible ? getBitmap(n.key) : undefined;
    if (!lodOn || active.has(n.key) || !eligible) {
      byKey.set(n.key, live(n, bm));
      continue;
    }
    if (bm && bm.node !== n) want.push(n.key);
    if (bm && zoom * dpr <= bm.ratio * 1.15) {
      byKey.set(n.key, <BitmapRoot key={n.key} n={n} bm={bm} zoom={zoom} />);
      continue;
    }
    if (!bm) want.push(n.key);
    if (mounted.current.has(n.key) || bm || !hasFixedSize(n)) byKey.set(n.key, live(n, bm));
    else byKey.set(n.key, <PlaceholderRoot key={n.key} n={n} />);
  }
  // Document order is kept so stacking doesn't change while frames switch.
  const out = tree.roots.map(n => byKey.get(n.key) ?? null);
  mounted.current = nextMounted;
  useEffect(() => {
    for (const k of want) requestBitmap(k);
    if (!deferred) return;
    const id = requestAnimationFrame(() => setTick(x => x + 1));
    return () => cancelAnimationFrame(id);
  });
  return <>{out}</>;
}

/** A top-level frame that renders an error box instead of crashing the editor if something inside it throws. */
function SafeRoot({ n }: { n: RNode }) {
  return (
    <ErrorBoundary name={`frame #${n.key}`} resetKey={n} fallback={error => <NodeErrorBox n={n} error={error} />}>
      <NodeView n={n} parentLayout="none" />
    </ErrorBoundary>
  );
}

function BitmapRoot({ n, bm, zoom }: { n: RNode; bm: Bitmap; zoom: number }) {
  const p = n.props;
  return (
    <img
      data-k={n.key}
      data-bitmap
      src={bitmapUrl(bm, zoom)}
      draggable={false}
      alt=""
      style={{ position: 'absolute', left: p.x, top: p.y, width: bm.w, height: bm.h, display: 'block', userSelect: 'none' }}
    />
  );
}

function PlaceholderRoot({ n }: { n: RNode }) {
  const p = n.props;
  const vars = useStore(s => s.doc?.variables);
  const fill = primaryColor(fillList(deepResolve({ variables: vars } as any, p.fill, n.theme)));
  return <div data-k={n.key} data-placeholder style={{ position: 'absolute', left: p.x, top: p.y, width: p.width, height: p.height, background: fill ?? 'rgba(128,128,128,0.12)', borderRadius: typeof p.cornerRadius === 'number' ? p.cornerRadius : undefined }} />;
}

/**
 * Hover outline (and agent-edit flashes) drawn on a <canvas>: updating canvas pixels avoids the document-wide
 * paint/layerize work that changing any DOM element triggers on very large designs.
 */
function HoverCanvas({ rect, color }: { rect: Rect | null; color: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const flashes = useStore(s => s.flashes);
  const [, setTick] = useState(0);
  useLayoutEffect(() => {
    const cv = ref.current!;
    const dpr = devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (rect) {
      g.strokeStyle = color;
      g.lineWidth = 1.5;
      g.strokeRect(rect.x + 0.75, rect.y + 0.75, Math.max(0, rect.w - 1.5), Math.max(0, rect.h - 1.5));
    }
    const now = performance.now();
    const live = flashes.filter(f => now - f.t < 1400);
    if (live.length) {
      const c = canvasRect();
      for (const f of live) {
        const r = screenRectOf(f.key);
        if (!r) continue;
        const a = 1 - (now - f.t) / 1400;
        g.fillStyle = `rgba(217, 70, 239, ${0.18 * a})`;
        g.strokeStyle = `rgba(217, 70, 239, ${a})`;
        g.lineWidth = 2;
        g.fillRect(r.left - c.left, r.top - c.top, r.width, r.height);
        g.strokeRect(r.left - c.left + 1, r.top - c.top + 1, Math.max(0, r.width - 2), Math.max(0, r.height - 2));
      }
      const id = requestAnimationFrame(() => setTick(t => t + 1));
      return () => cancelAnimationFrame(id);
    }
  });
  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />;
}

export { chainFromElement, elFor, parentLayoutOf, ancestry };
