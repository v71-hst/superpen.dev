// Floating chrome: sidebar toggle, tool column, zoom control, file pill, quick-find bar and toasts.
import React, { useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronDown,
  CircleUser,
  Circle,
  Code,
  Component,
  Frame,
  Hand,
  ImagePlus,
  Keyboard,
  ListChecks,
  Lock,
  MessageSquare,
  Search,
  ShieldCheck,
  Maximize2,
  Minus,
  MousePointer2,
  Palette,
  PanelLeft,
  PenTool,
  Plus,
  Scaling,
  SlidersHorizontal,
  Square,
  Star,
  StickyNote,
  Triangle,
  Type,
  Pipette,
} from 'lucide-react';
import { useStore, isDirty, type Tool } from '../editor/store';
import { useTree } from '../editor/tree';
import { setZoom, zoomBy, zoomToFit, zoomToKeys, clientToWorld, insertSvg } from '../editor/ops';
import { openLocalFile, reloadFromDisk, saveDoc, saveDocAs, newDocument } from '../editor/fileio';
import { allIds, displayName, newId } from '../model/doc';
import { useMenu, layerIconFor, type MenuItem } from './common';
import type { RNode } from '../model/types';
import { blobToDataUrl, inVsCode, post, request } from '../editor/host';
import { createAssetFile } from './AssetControls';
import { setReviewMode } from '../editor/review';

export function SideToggle() {
  const leftOpen = useStore(s => s.leftOpen);
  return (
    <button className="island side-toggle" style={{ left: leftOpen ? 394 : 8 }} title="Toggle sidebar (Ctrl+\)" onClick={() => useStore.setState({ leftOpen: !leftOpen })}>
      <PanelLeft strokeWidth={1.75} />
    </button>
  );
}

const SHAPES = [
  { tool: 'rect', label: 'Rectangle', kbd: 'R', Icon: Square },
  { tool: 'ellipse', label: 'Ellipse', kbd: 'O', Icon: Circle },
  { tool: 'polygon', label: 'Polygon', kbd: '', Icon: Triangle },
  { tool: 'icon', label: 'Icon', kbd: '', Icon: Star },
] as const;

export function Toolbar() {
  const tool = useStore(s => s.tool);
  const shapeTool = useStore(s => s.shapeTool);
  const selectTool = useStore(s => s.selectTool);
  const leftOpen = useStore(s => s.leftOpen);
  const reviewMode = useStore(s => s.reviewMode);
  const menu = useMenu();
  const setTool = (t: Tool) => useStore.setState({ tool: t });
  const ShapeIcon = SHAPES.find(s => s.tool === shapeTool)?.Icon ?? Square;
  const btn = (t: Tool, Icon: any, title: string) => (
    <button className={'tool' + (tool === t ? ' active' : '')} title={title} onClick={() => setTool(t)}>
      <Icon strokeWidth={1.75} />
    </button>
  );
  const caret = (items: MenuItem[]) => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).previousElementSibling!.getBoundingClientRect();
    menu.open({ anchor: r, items, placement: 'right' });
  };
  return (
    <div className="island toolbar" style={{ left: leftOpen ? 394 : 8 }}>
      <button className={'tool' + (tool === 'select' || tool === 'scale' ? ' active' : '')} title={selectTool === 'scale' ? 'Scale (K)' : 'Move (V)'} onClick={() => setTool(selectTool)}>
        {selectTool === 'scale' ? <Scaling strokeWidth={1.75} /> : <MousePointer2 strokeWidth={1.75} />}
      </button>
      <button
        className="tool-caret"
        onClick={caret([
          { label: 'Move', icon: <MousePointer2 />, kbd: 'V', checked: selectTool === 'select', onClick: () => useStore.setState({ selectTool: 'select', tool: 'select' }) },
          { label: 'Scale', icon: <Scaling />, kbd: 'K', checked: selectTool === 'scale', onClick: () => useStore.setState({ selectTool: 'scale', tool: 'scale' }) },
        ])}
      >
        <ChevronDown strokeWidth={2.5} />
      </button>
      <button className={'tool' + (SHAPES.some(s => s.tool === tool) ? ' active' : '')} title="Shapes" onClick={() => setTool(shapeTool)}>
        <ShapeIcon strokeWidth={1.75} />
      </button>
      <button
        className="tool-caret"
        onClick={caret([
          ...SHAPES.map(s => ({
            label: s.label,
            icon: <s.Icon />,
            kbd: s.kbd,
            checked: shapeTool === s.tool,
            onClick: () => useStore.setState({ shapeTool: s.tool, tool: s.tool }),
          })),
          { label: 'Script', icon: <Code />, onClick: () => insertScript() },
          { label: 'Import Image or SVG...', icon: <ImagePlus />, onClick: () => importImage() },
        ])}
      >
        <ChevronDown strokeWidth={2.5} />
      </button>
      {btn('pen', PenTool, 'Pen (P)')}
      {btn('text', Type, 'Text (T)')}
      {btn('frame', Frame, 'Frame (F)')}
      {btn('note', StickyNote, 'Note (N)')}
      {btn('hand', Hand, 'Hand (H)')}
      {btn('comment', MessageSquare, 'Comment (C)')}
      {btn('eyedropper', Pipette, 'Eyedropper (I): click a layer to copy its color, or apply it to the selection (Shift: stroke)')}
      <button className="tool" title="Components" onClick={() => useStore.setState({ leftOpen: true, leftTab: 'components' })}>
        <Component strokeWidth={1.75} />
      </button>
      <button className="tool" title="Variables & themes" onClick={() => useStore.setState({ modal: 'variables' })}>
        <Palette strokeWidth={1.75} />
      </button>
      <button className="tool" title="Find & replace (Ctrl+F)" onClick={() => useStore.setState({ modal: 'find' })}>
        <Search strokeWidth={1.75} />
      </button>
      <button className="tool" title="Design lint" onClick={() => useStore.setState({ modal: 'lint' })}>
        <ShieldCheck strokeWidth={1.75} />
      </button>
      <button
        className={'tool' + (reviewMode ? ' active' : '')}
        title={reviewMode ? 'Review mode ON: AI edits wait for you to accept them' : 'Review mode OFF: AI edits apply immediately'}
        onClick={() => setReviewMode(!reviewMode)}
      >
        <ListChecks strokeWidth={1.75} />
      </button>
      <button className="tool" title="Keyboard shortcuts (Ctrl+/)" onClick={() => useStore.setState({ modal: 'shortcuts' })}>
        <Keyboard strokeWidth={1.75} />
      </button>
      <button className="tool" title="Settings" onClick={() => useStore.setState({ modal: 'settings' })}>
        <SlidersHorizontal strokeWidth={1.75} />
      </button>
      <button className="tool" title="About" onClick={() => useStore.setState({ modal: 'about' })}>
        <CircleUser strokeWidth={1.75} />
      </button>
      <button className="tool" title="Zoom to fit (Shift+1)" onClick={() => zoomToFit()}>
        <Maximize2 strokeWidth={1.75} />
      </button>
      {menu.node}
    </div>
  );
}

/** Creates a starter script file next to the .pen file and places a script node using it. */
async function insertScript() {
  const url = await createAssetFile('script');
  if (!url) return;
  const s = useStore.getState();
  const c = clientToWorld(innerWidth / 2, innerHeight / 2);
  let id = '';
  s.edit(d => {
    id = newId(allIds(d));
    d.children.push({ type: 'script', id, name: 'Script', x: Math.round(c.x - 200), y: Math.round(c.y - 150), width: 400, height: 300, scriptUri: url });
  });
  s.select([id]);
}

async function importImage() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,.svg';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    const s = useStore.getState();
    // SVG files come in as editable vector paths rather than a flat image.
    if (/\.svg$/i.test(f.name) || f.type === 'image/svg+xml') {
      try {
        const r = insertSvg(await f.text(), { name: f.name.replace(/\.svg$/i, '') });
        s.notify(`Imported ${r.paths} vector path${r.paths === 1 ? '' : 's'}${r.skipped.length ? ` (skipped ${r.skipped.join(', ')})` : ''}`);
        return;
      } catch (e) {
        s.notify(`SVG has no vector shapes (${e instanceof Error ? e.message : e}); importing as an image instead`);
      }
    }
    let url: string;
    if (inVsCode) {
      const rel = `images/${f.name}`;
      const ok = await request<boolean>('writeFile', { relPath: rel, dataUrl: await blobToDataUrl(f) });
      url = ok ? `./${rel}` : await blobToDataUrl(f);
    } else if (s.file?.path) {
      const dir = s.file.path.includes('/') ? s.file.path.slice(0, s.file.path.lastIndexOf('/') + 1) : '';
      const rel = `images/${f.name}`;
      await fetch(`/api/file?path=${encodeURIComponent(dir + rel)}`, { method: 'PUT', body: f });
      url = `./${rel}`;
    } else {
      url = await new Promise<string>(res => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.readAsDataURL(f);
      });
    }
    const img = new Image();
    img.src = URL.createObjectURL(f);
    await img.decode().catch(() => undefined);
    const w = img.naturalWidth || 200;
    const h = img.naturalHeight || 200;
    const c = clientToWorld(innerWidth / 2, innerHeight / 2);
    let id = '';
    s.edit(d => {
      id = newId(allIds(d));
      d.children.push({ type: 'rectangle', id, name: f.name, x: Math.round(c.x - w / 2), y: Math.round(c.y - h / 2), width: w, height: h, fill: { type: 'image', url, mode: 'cover' } });
    });
    s.select([id]);
  };
  input.click();
}

export function ZoomControl() {
  const zoom = useStore(s => s.view.zoom);
  const hasRight = useStore(s => s.selection.length > 0 && s.rightOpen);
  const menu = useMenu();
  return (
    <div className={'island zoom-ctl' + (hasRight ? '' : ' no-right')}>
      <button className="zbtn" title="Zoom out (Ctrl+-)" onClick={() => zoomBy(1 / 1.25)}>
        <Minus strokeWidth={1.75} />
      </button>
      <button
        className="zval"
        onClick={e =>
          menu.open({
            anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
            placement: 'above',
            align: 'right',
            items: [
              { label: 'Zoom to fit', kbd: 'Shift+1', onClick: zoomToFit },
              { label: 'Zoom to selection', kbd: 'Shift+2', onClick: () => zoomToKeys(useStore.getState().selection, 8) },
              { sep: true },
              { label: '50%', onClick: () => setZoom(0.5) },
              { label: '100%', kbd: 'Shift+0', onClick: () => setZoom(1) },
              { label: '200%', onClick: () => setZoom(2) },
            ],
          })
        }
      >
        {Math.round(zoom * 100)}%
      </button>
      <button className="zbtn" title="Zoom in (Ctrl+=)" onClick={() => zoomBy(1.25)}>
        <Plus strokeWidth={1.75} />
      </button>
      {menu.node}
    </div>
  );
}

export function FilePill() {
  const file = useStore(s => s.file);
  const dirty = useStore(isDirty);
  const hasRight = useStore(s => s.selection.length > 0 && s.rightOpen);
  const menu = useMenu();
  // In VS Code the editor tab already shows the file name and dirty state.
  if (!file || inVsCode) return null;
  const items: MenuItem[] = [
    { label: 'New file', kbd: 'Ctrl+Alt+N', onClick: () => confirmDiscard() && useStore.getState().openDoc(newDocument(), { name: 'untitled.pen', path: null }) },
    { label: 'Open…', kbd: 'Ctrl+O', onClick: () => confirmDiscard() && useStore.getState().closeDoc() },
    { label: 'Open from disk…', onClick: () => confirmDiscard() && openLocalFile().catch(e => useStore.getState().notify(String(e))) },
    { sep: true },
    { label: 'Save', kbd: 'Ctrl+S', onClick: () => saveDoc() },
    { label: 'Save as…', kbd: 'Ctrl+Shift+S', onClick: () => saveDocAs() },
    { label: 'Reload from disk', disabled: !file.path, onClick: () => reloadFromDisk() },
  ];
  return (
    <>
      <button
        className={'island file-pill' + (hasRight ? '' : ' no-right')}
        title={file.path ?? file.name}
        onClick={e => menu.open({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), items, align: 'right' })}
      >
        {dirty && <span className="dot" title="Unsaved changes" />}
        <span>{file.name}</span>
        <ChevronDown />
      </button>
      {menu.node}
    </>
  );
}

/** Shows which AI session holds the edit lock on this file; click to revoke it. */
export function LockChip() {
  const locks = useStore(s => s.locks);
  const hasRight = useStore(s => s.selection.length > 0 && s.rightOpen);
  const menu = useMenu();
  if (!locks.length) return null;
  const l = locks[0];
  const idle = Math.round((Date.now() - l.lastActive) / 1000);
  return (
    <>
      <button
        className={'island file-pill' + (hasRight ? '' : ' no-right')}
        title={`Locked for editing by AI session "${l.label}" · last active ${idle < 60 ? `${idle}s` : `${Math.round(idle / 60)}m`} ago`}
        onClick={e =>
          menu.open({
            anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
            align: 'right',
            items: [
              { label: `Locked by “${l.label}”`, disabled: true },
              { sep: true },
              { label: 'Revoke lock', onClick: () => post({ type: 'revokeLock', session: l.session }) },
            ],
          })
        }
      >
        <Lock style={{ color: '#d946ef' }} />
        <span>{l.label}</span>
      </button>
      {menu.node}
    </>
  );
}

export function confirmDiscard() {
  return !isDirty(useStore.getState()) || confirm('Discard unsaved changes?');
}

/** The bottom-left bar: quick find for layers (pen.dev uses this spot for its AI prompt). */
export function PromptBar() {
  const [q, setQ] = useState('');
  const [focus, setFocus] = useState(false);
  const [active, setActive] = useState(0);
  const tree = useTree();
  const inputRef = useRef<HTMLInputElement>(null);
  const results = useMemo(() => {
    if (!tree || !q.trim()) return [];
    const needle = q.toLowerCase();
    const out: RNode[] = [];
    for (const n of tree.byKey.values()) {
      const name = displayName(n.props).toLowerCase();
      const text = typeof n.props.content === 'string' ? n.props.content.toLowerCase() : '';
      if (name.includes(needle) || text.includes(needle)) out.push(n);
      if (out.length > 60) break;
    }
    return out;
  }, [tree, q]);
  const go = (key: string) => {
    useStore.getState().select([key]);
    zoomToKeys([key], 2);
  };
  return (
    <>
      {focus && results.length > 0 && (
        <div className="island find-results">
          {results.map((n, i) => {
            const { Icon, cls } = layerIconFor(n);
            return (
              <div key={n.key} className={'layer-row' + (i === active ? ' sel' : '')} onPointerDown={e => (e.preventDefault(), go(n.key))}>
                <span className={'layer-icon ' + cls}>
                  <Icon strokeWidth={1.75} />
                </span>
                <span className="layer-name">{displayName(n.props)}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="island prompt-bar">
        <input
          ref={inputRef}
          placeholder="Find layers…"
          value={q}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onChange={e => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') setActive(a => Math.min(a + 1, results.length - 1));
            if (e.key === 'ArrowUp') setActive(a => Math.max(a - 1, 0));
            if (e.key === 'Enter' && results[active]) go(results[active].key);
            if (e.key === 'Escape') inputRef.current?.blur();
          }}
        />
        <button className="prompt-send" onClick={() => results[active] && go(results[active].key)}>
          <ArrowUp strokeWidth={3} />
        </button>
      </div>
    </>
  );
}

export function Toast() {
  const toast = useStore(s => s.toast);
  return toast ? <div className="toast">{toast.text}</div> : null;
}
