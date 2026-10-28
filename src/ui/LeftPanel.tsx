// Left island: Layers / Slides / Components / Libraries tabs.
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Component, Eye, EyeOff, FileDown, Layers, Library, Monitor, Play, Plus, Search, Diamond } from 'lucide-react';
import { useStore, keySource, applyProps } from '../editor/store';
import { useTree, type Tree } from '../editor/tree';
import { displayName, allIds, newId, locate } from '../model/doc';
import type { RNode } from '../model/types';
import { NodeView, RenderCtx, type RenderContextValue } from '../render/NodeView';
import { makeUrlResolver } from '../editor/fileio';
import { moveNode, toggleComponent, zoomToKeys, clientToWorld, worldRectOf } from '../editor/ops';
import { layerIconFor } from './common';
import { printSlides } from './Present';

export function LeftPanel() {
  const tab = useStore(s => s.leftTab);
  const tree = useTree();
  const set = useStore(s => s.set);
  const tabs = [
    { id: 'layers', label: 'Layers', Icon: Layers },
    { id: 'slides', label: 'Slides', Icon: Monitor },
    { id: 'components', label: 'Components', Icon: Component },
    { id: 'libraries', label: 'Libraries', Icon: Library },
  ] as const;
  return (
    <div className="island left-panel">
      <div className="tabs">
        {tabs.map(t => (
          <button key={t.id} className={'tab' + (tab === t.id ? ' active' : '')} title={t.label} onClick={() => set({ leftTab: t.id })}>
            <t.Icon strokeWidth={1.75} />
            {tab === t.id && <span>{t.label}</span>}
          </button>
        ))}
      </div>
      {tree && tab === 'layers' && <LayersTab tree={tree} />}
      {tree && tab === 'slides' && <SlidesTab tree={tree} />}
      {tree && tab === 'components' && <ComponentsTab tree={tree} />}
      {tree && tab === 'libraries' && <LibrariesTab />}
    </div>
  );
}

// ---------------- layers ----------------

type Drop = { key: string; where: 'before' | 'after' | 'into' } | null;

function LayersTab({ tree }: { tree: Tree }) {
  const selection = useStore(s => s.selection);
  const expanded = useStore(s => s.expanded);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<Drop>(null);
  const dragRef = useRef<{ keys: string[]; sy: number; active: boolean } | null>(null);

  // Reveal the selection in the tree.
  useEffect(() => {
    if (!selection.length) return;
    const add: Record<string, boolean> = {};
    for (const k of selection) {
      let p = tree.parent.get(k);
      while (p) {
        if (!expanded[p.key]) add[p.key] = true;
        p = tree.parent.get(p.key);
      }
    }
    if (Object.keys(add).length) useStore.setState({ expanded: { ...expanded, ...add } });
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-row="${CSS.escape(selection[selection.length - 1])}"]`);
      (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    });
  }, [selection, tree]);

  const rows: { n: RNode; depth: number }[] = [];
  const walk = (nodes: RNode[], depth: number) => {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      rows.push({ n, depth });
      if (expanded[n.key] && n.children.length && n.type !== 'script') walk(n.children, depth + 1);
    }
  };
  walk(tree.roots, 0);

  const selSet = new Set(selection);
  const underSel = new Set<string>();
  for (const { n } of rows) {
    let p = tree.parent.get(n.key);
    while (p) {
      if (selSet.has(p.key)) {
        underSel.add(n.key);
        break;
      }
      p = tree.parent.get(p.key);
    }
  }

  const onRowPointerDown = (e: React.PointerEvent, n: RNode) => {
    if (e.button !== 0) return;
    const s = useStore.getState();
    if (e.shiftKey && s.selection.length) {
      const flat = rows.map(r => r.n.key);
      const a = flat.indexOf(s.selection[s.selection.length - 1]);
      const b = flat.indexOf(n.key);
      const range = flat.slice(Math.min(a, b), Math.max(a, b) + 1);
      s.select([...new Set([...s.selection, ...range])]);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      s.select(s.selection.includes(n.key) ? s.selection.filter(k => k !== n.key) : [...s.selection, n.key]);
      return;
    }
    if (!s.selection.includes(n.key)) s.select([n.key]);
    dragRef.current = { keys: s.selection.includes(n.key) ? s.selection : [n.key], sy: e.clientY, active: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onRowPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.active && Math.abs(e.clientY - d.sy) < 4) return;
    d.active = true;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-row]');
    if (!el) return setDrop(null);
    const key = el.dataset.row!;
    if (d.keys.includes(key) || key.includes('/')) return setDrop(null);
    const r = el.getBoundingClientRect();
    const t = (e.clientY - r.top) / r.height;
    const n = tree.byKey.get(key);
    const container = n && (n.type === 'frame' || n.type === 'group') && !n.instanceOf;
    setDrop({ key, where: container && t > 0.25 && t < 0.75 ? 'into' : t < 0.5 ? 'before' : 'after' });
  };

  const onRowPointerUp = (e: React.PointerEvent, n: RNode) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (!d.active) {
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) useStore.getState().select([n.key]);
      return;
    }
    const target = drop;
    setDrop(null);
    if (!target) return;
    const keys = d.keys.filter(k => keySource(k).kind === 'real');
    if (!keys.length) return;
    const s = useStore.getState();
    const worlds = new Map(keys.map(k => [k, worldRectOf(k)]));
    s.edit(dd => {
      let parentId: string | null;
      let index: number;
      if (target.where === 'into') {
        parentId = target.key;
        index = locate(dd, target.key)?.node.children?.length ?? 0;
      } else {
        const loc = locate(dd, target.key);
        if (!loc) return;
        parentId = loc.parent?.id ?? null;
        // Rows are shown top-most first, so "before" (above) means a higher array index.
        index = target.where === 'before' ? loc.index + 1 : loc.index;
      }
      const parentWorld = parentId ? worldRectOf(parentId) : { x: 0, y: 0, w: 0, h: 0 };
      const pl = parentId ? tree.byKey.get(parentId)?.props.layout : 'none';
      const absolute = !parentId || pl === 'none' || tree.byKey.get(parentId)?.type === 'group';
      for (const k of [...keys].reverse()) {
        const loc = locate(dd, k);
        if (!loc) continue;
        if ((loc.parent?.id ?? null) === parentId && loc.index < index) index--;
        const sameParent = (loc.parent?.id ?? null) === parentId;
        const wr = worlds.get(k);
        moveNode(dd, k, parentId, index, absolute && !sameParent && wr ? { x: wr.x, y: wr.y } : undefined, parentWorld ?? undefined);
      }
    });
  };

  return (
    <div className="panel-scroll" ref={scrollRef} onPointerMove={onRowPointerMove}>
      {rows.map(({ n, depth }) => (
        <LayerRow
          key={n.key}
          n={n}
          depth={depth}
          sel={selSet.has(n.key)}
          underSel={underSel.has(n.key)}
          open={!!expanded[n.key]}
          drop={drop?.key === n.key ? drop.where : null}
          onPointerDown={onRowPointerDown}
          onPointerUp={onRowPointerUp}
        />
      ))}
    </div>
  );
}

const LayerRow = memo(function LayerRow({
  n,
  depth,
  sel,
  underSel,
  open,
  drop,
  onPointerDown,
  onPointerUp,
}: {
  n: RNode;
  depth: number;
  sel: boolean;
  underSel: boolean;
  open: boolean;
  drop: 'before' | 'after' | 'into' | null;
  onPointerDown: (e: React.PointerEvent, n: RNode) => void;
  onPointerUp: (e: React.PointerEvent, n: RNode) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const { Icon, cls } = layerIconFor(n);
  const hidden = n.props.enabled === false;
  const hasKids = n.children.length > 0 && n.type !== 'script';
  const toggleOpen = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    const ex = useStore.getState().expanded;
    useStore.setState({ expanded: { ...ex, [n.key]: !ex[n.key] } });
  };
  return (
    <div
      className={'layer-row' + (sel ? ' sel' : underSel ? ' sel-child' : '') + (hidden ? ' hidden-layer' : '') + (drop === 'into' ? ' drop-into' : '')}
      data-row={n.key}
      style={{ paddingLeft: depth * 12 + 4 }}
      onPointerDown={e => !renaming && onPointerDown(e, n)}
      onPointerUp={e => !renaming && onPointerUp(e, n)}
      onPointerEnter={() => useStore.getState().set({ hover: n.key })}
      onPointerLeave={() => useStore.getState().hover === n.key && useStore.getState().set({ hover: null })}
      onDoubleClick={() => setRenaming(true)}
    >
      {drop === 'before' && <div className="drop-indicator" style={{ top: -1, left: depth * 12 + 20 }} />}
      {drop === 'after' && <div className="drop-indicator" style={{ bottom: -1, left: depth * 12 + 20 }} />}
      <span className={'chev' + (open ? ' open' : '')} onPointerDown={e => e.stopPropagation()} onClick={hasKids ? toggleOpen : undefined}>
        {hasKids && <ChevronRight strokeWidth={2.5} />}
      </span>
      <span className={'layer-icon ' + cls}>
        <Icon strokeWidth={1.75} />
      </span>
      <span className={'layer-name' + (n.isComponent ? ' component-name' : n.instanceOf ? ' instance-name' : '')}>
        {renaming ? (
          <input
            autoFocus
            defaultValue={displayName(n.props)}
            onPointerDown={e => e.stopPropagation()}
            onFocus={e => e.target.select()}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={e => {
              setRenaming(false);
              const v = e.target.value.trim();
              if (v && v !== displayName(n.props)) useStore.getState().edit(d => applyProps(d, n.key, { name: v }));
            }}
          />
        ) : (
          displayName(n.props)
        )}
      </span>
      <span className={'row-actions' + (hidden ? ' pinned' : '')}>
        <button
          title={hidden ? 'Show' : 'Hide'}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => {
            e.stopPropagation();
            useStore.getState().edit(d => applyProps(d, n.key, { enabled: hidden ? undefined : false }));
          }}
        >
          {hidden ? <EyeOff /> : <Eye />}
        </button>
      </span>
    </div>
  );
});

// ---------------- thumbnails ----------------

export function ThumbProvider({ children }: { children: React.ReactNode }) {
  const vars = useStore(s => s.doc?.variables);
  const path = useStore(s => s.file?.path ?? null);
  const value: RenderContextValue = useMemo(() => ({ doc: { variables: vars }, resolveUrl: makeUrlResolver(path) }), [vars, path]);
  return <RenderCtx.Provider value={value}>{children}</RenderCtx.Provider>;
}

export function Thumb({ n, maxW, maxH }: { n: RNode; maxW: number; maxH: number }) {
  const placed = useMemo(() => ({ ...n, props: { ...n.props, x: 0, y: 0, rotation: undefined, enabled: true } }), [n]);
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number]>([typeof n.props.width === 'number' ? n.props.width : 0, typeof n.props.height === 'number' ? n.props.height : 0]);
  useEffect(() => {
    const el = ref.current?.firstElementChild as HTMLElement | null;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(s => (s[0] === el.offsetWidth && s[1] === el.offsetHeight ? s : [el.offsetWidth, el.offsetHeight])));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [w, h] = size;
  const scale = w && h ? Math.min(maxW / w, maxH / h, 4) : 0.1;
  return (
    <div className="thumb" style={{ width: Math.max(1, w * scale), height: Math.max(1, h * scale) }}>
      <div ref={ref} style={{ transform: `scale(${scale})` }}>
        <NodeView n={placed} parentLayout="none" />
      </div>
    </div>
  );
}

// ---------------- slides ----------------

function SlidesTab({ tree }: { tree: Tree }) {
  const selection = useStore(s => s.selection);
  const slides = tree.roots.filter(n => n.type === 'frame' || n.instanceOf);
  return (
    <>
      <div className="panel-scroll">
        <ThumbProvider>
          {slides.map((n, i) => (
            <div
              key={n.key}
              className={'slide' + (selection.includes(n.key) ? ' sel' : '')}
              onClick={() => {
                useStore.getState().select([n.key]);
                zoomToKeys([n.key]);
              }}
              onDoubleClick={() => useStore.setState({ presenting: i })}
            >
              <span className="slide-num">{i + 1}</span>
              <Thumb n={n} maxW={346} maxH={150} />
            </div>
          ))}
        </ThumbProvider>
        {!slides.length && <div className="help-text">Top-level frames appear here as slides.</div>}
      </div>
      <div className="panel-footer">
        <button onClick={() => slides.length && useStore.setState({ presenting: 0 })}>
          <Play size={14} /> Present
        </button>
        <button onClick={() => printSlides()}>
          <FileDown size={14} /> Export PDF
        </button>
      </div>
    </>
  );
}

// ---------------- components ----------------

function ComponentsTab({ tree }: { tree: Tree }) {
  const [q, setQ] = useState('');
  const comps = [...tree.byKey.values()].filter(n => n.isComponent && !n.inInstance);
  const shown = comps.filter(c => displayName(c.props).toLowerCase().includes(q.toLowerCase()));
  const selection = useStore(s => s.selection);

  const placeInstance = (comp: RNode, clientX?: number, clientY?: number) => {
    const s = useStore.getState();
    const center = clientX !== undefined ? clientToWorld(clientX, clientY!) : clientToWorld(innerWidth / 2, innerHeight / 2);
    let id = '';
    s.edit(d => {
      id = newId(allIds(d));
      d.children.push({ type: 'ref', id, ref: comp.key, x: Math.round(center.x), y: Math.round(center.y) });
    });
    s.select([id]);
  };

  return (
    <div className="panel-scroll" style={{ padding: 0 }}>
      <div className="search-box">
        <Search />
        <input placeholder="Search components..." value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()} />
      </div>
      <button className="wide-btn" onClick={() => (selection.length ? toggleComponent() : useStore.getState().notify('Select a layer first'))}>
        <Diamond size={14} /> Create Component
      </button>
      {shown.length ? (
        <ThumbProvider>
          <div className="comp-grid">
            {shown.map(c => (
              <div
                key={c.key}
                className="comp-card"
                draggable
                title="Click to select · drag onto the canvas to insert an instance"
                onClick={() => {
                  useStore.getState().select([c.key]);
                  zoomToKeys([c.key]);
                }}
                onDragEnd={e => {
                  const el = document.elementFromPoint(e.clientX, e.clientY);
                  if (el?.closest('#pen-canvas') && !el.closest('.island')) placeInstance(c, e.clientX, e.clientY);
                }}
              >
                <div className="thumb-wrap">
                  <Thumb n={c} maxW={140} maxH={80} />
                </div>
                <div className="name">{displayName(c.props)}</div>
              </div>
            ))}
          </div>
        </ThumbProvider>
      ) : comps.length ? (
        <div className="help-text">No components match “{q}”.</div>
      ) : (
        <div className="help-text">
          <div style={{ color: 'var(--fg)', fontWeight: 600 }}>No components created yet.</div>
          <h4>Tip: Why Use Components</h4>
          Components let you maintain consistency across your designs. Edit the main component once and every instance updates automatically.
          <h4>Creating Components</h4>
          Any standard design element — a frame, shape, or text — can be converted into a reusable component.
          <br />
          1. Select the element
          <br />
          2. Press <kbd>Ctrl</kbd> <kbd>Alt</kbd> <kbd>K</kbd> or click “Create Component” above
          <h4>Using Components</h4>
          Copy the component on the canvas, or drag it from this list, to create an instance. Instances are marked with a violet bounding box when selected.
        </div>
      )}
    </div>
  );
}

// ---------------- libraries ----------------

function LibrariesTab() {
  const doc = useStore(s => s.doc);
  const imports = Object.entries(doc?.imports ?? {});
  const themes = Object.entries(doc?.themes ?? {});
  const vars = Object.keys(doc?.variables ?? {});
  return (
    <div className="panel-scroll" style={{ padding: 0 }}>
      <div className="help-text">
        <h4 style={{ marginTop: 4 }}>Imported libraries</h4>
        {imports.length ? imports.map(([alias, uri]) => <div key={alias}>{alias} → {uri}</div>) : <div>This file does not import any libraries.</div>}
        <h4>Variables</h4>
        <div>
          {vars.length} variable{vars.length === 1 ? '' : 's'}
          {themes.length ? ` · themes: ${themes.map(([a, v]) => `${a} (${v.join(', ')})`).join('; ')}` : ''}
        </div>
      </div>
      <button className="wide-btn" style={{ marginTop: 14 }} onClick={() => useStore.setState({ modal: 'variables' })}>
        <Plus size={14} /> Edit variables
      </button>
    </div>
  );
}

export { applyProps };
