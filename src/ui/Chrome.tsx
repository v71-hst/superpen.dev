// Editor chrome: the top bar (sidebar toggle, file name, tools, AI lock, zoom menu, Present), the Sections viewer
// bar, the layer search of the left panel, and toasts.
import React, { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleUser,
  Ellipsis,
  PenLine,
  Play,
  Circle,
  Code,
  Component,
  Frame,
  Hand,
  ImagePlus,
  Keyboard,
  LayoutGrid,
  Zap,
  ListChecks,
  MessageSquare,
  Search,
  ShieldCheck,
  MousePointer2,
  Palette,
  PanelLeft,
  PenTool,
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

import { setPerfMode } from '../editor/perf';
import { currentTree, useTree } from '../editor/tree';
import { setZoom, zoomBy, zoomToFit, zoomToKeys, clientToWorld, insertSvg } from '../editor/ops';
import { openLocalFile, reloadFromDisk, saveDoc, saveDocAs, saveCopyAs, newDocument } from '../editor/fileio';
import { allIds, displayName, newId } from '../model/doc';
import { useMenu, layerIconFor, type MenuItem } from './common';
import type { RNode } from '../model/types';
import { blobToDataUrl, inVsCode, post, request } from '../editor/host';
import { sectionsOf, viewerSections } from '../editor/sections';
import { createAssetFile } from './AssetControls';
import { setReviewMode } from '../editor/review';

const SHAPES = [
  { tool: 'rect', label: 'Rectangle', kbd: 'R', Icon: Square },
  { tool: 'ellipse', label: 'Ellipse', kbd: 'O', Icon: Circle },
  { tool: 'polygon', label: 'Polygon', kbd: '', Icon: Triangle },
  { tool: 'icon', label: 'Icon', kbd: '', Icon: Star },
] as const;

/** The bar across the top: sidebar toggle and file on the left, tools next to them, lock, zoom and Present on the right. */
export function TopBar() {
  const leftOpen = useStore(s => s.leftOpen);
  return (
    <div className="island topbar">
      <button className={'tool' + (leftOpen ? ' active' : '')} title="Toggle sidebar (Ctrl+\)" onClick={() => useStore.setState({ leftOpen: !leftOpen })}>
        <PanelLeft strokeWidth={1.75} />
      </button>
      <FileName />
      <Tools />
      <span className="tb-space" />
      <LockChip />
      <ZoomMenu />
      <button className="tb-present" title="Present from the selected frame" onClick={present}>
        <Play strokeWidth={2} />
        <span>Present</span>
      </button>
    </div>
  );
}

/** Starts the presentation at the top-level frame the selection is in (the first frame if nothing is selected). */
function present() {
  const s = useStore.getState();
  const tree = currentTree();
  if (!tree) return;
  let n = s.selection.length ? tree.byKey.get(s.selection[0]) : undefined;
  while (n && tree.parent.get(n.key)) n = tree.parent.get(n.key) ?? undefined;
  useStore.setState({ presenting: Math.max(0, n ? tree.roots.indexOf(n) : 0) });
}

function Tools() {
  const tool = useStore(s => s.tool);
  const shapeTool = useStore(s => s.shapeTool);
  const selectTool = useStore(s => s.selectTool);
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
    menu.open({ anchor: r, items });
  };
  const more: MenuItem[] = [
    { label: 'Note', icon: <StickyNote />, kbd: 'N', onClick: () => setTool('note') },
    { label: 'Components', icon: <Component />, onClick: () => useStore.setState({ leftOpen: true, leftTab: 'components' }) },
    { label: 'Variables & themes', icon: <Palette />, onClick: () => useStore.setState({ modal: 'variables' }) },
    { sep: true },
    { label: 'Find & replace', icon: <Search />, kbd: 'Ctrl+F', onClick: () => useStore.setState({ modal: 'find' }) },
    { label: 'Design lint', icon: <ShieldCheck />, onClick: () => useStore.setState({ modal: 'lint' }) },
    { label: 'Review AI edits before they apply', icon: <ListChecks />, kbd: reviewMode ? 'On' : 'Off', onClick: () => setReviewMode(!reviewMode) },
    { sep: true },
    { label: 'Keyboard shortcuts', icon: <Keyboard />, kbd: 'Ctrl+/', onClick: () => useStore.setState({ modal: 'shortcuts' }) },
    { label: 'Settings', icon: <SlidersHorizontal />, onClick: () => useStore.setState({ modal: 'settings' }) },
    { label: 'About', icon: <CircleUser />, onClick: () => useStore.setState({ modal: 'about' }) },
  ];
  return (
    <div className="toolbar">
      <button className={'tool' + (tool === 'select' || tool === 'scale' ? ' active' : '')} title={selectTool === 'scale' ? 'Scale (K)' : 'Move (V)'} onClick={() => setTool(selectTool)}>
        {selectTool === 'scale' ? <Scaling strokeWidth={1.75} /> : <MousePointer2 strokeWidth={1.75} />}
      </button>
      <button
        className="tool-caret"
        title="Move or scale"
        onClick={caret([
          { label: 'Move', icon: <MousePointer2 />, kbd: 'V', checked: selectTool === 'select', onClick: () => useStore.setState({ selectTool: 'select', tool: 'select' }) },
          { label: 'Scale', icon: <Scaling />, kbd: 'K', checked: selectTool === 'scale', onClick: () => useStore.setState({ selectTool: 'scale', tool: 'scale' }) },
        ])}
      >
        <ChevronDown strokeWidth={2.5} />
      </button>
      {btn('frame', Frame, 'Frame (F)')}
      <button className={'tool' + (SHAPES.some(s => s.tool === tool) ? ' active' : '')} title="Shapes" onClick={() => setTool(shapeTool)}>
        <ShapeIcon strokeWidth={1.75} />
      </button>
      <button
        className="tool-caret"
        title="Shapes, scripts and images"
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
      {btn('hand', Hand, 'Hand (H)')}
      <span className="tb-sep" />
      {btn('aipen', PenLine, 'AI Pen (Shift+P): drag an area, describe what to draw, and your AI model draws it as editable vectors')}
      {btn('comment', MessageSquare, 'Comment (C)')}
      {btn('eyedropper', Pipette, 'Eyedropper (I): click a layer to copy its color, or apply it to the selection (Shift: stroke)')}
      <span className="tb-sep" />
      <button
        className={'tool' + (tool === 'note' ? ' active' : '')}
        title="More: note, components, variables, find, lint, review mode, shortcuts, settings"
        onClick={e => menu.open({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), items: more })}
      >
        <Ellipsis strokeWidth={1.75} />
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

// ---- viewers: Classic (every frame) or Sections (one section at a time, like slides) ----

/** Switches the canvas viewer; the Sections viewer opens on the last viewed (or first) section. */
export function setViewer(viewer: 'classic' | 'sections') {
  const s = useStore.getState();
  if (viewer === 'classic') return s.set({ viewer });
  const list = viewerSections(s.doc);
  const id = list.some(x => x.id === s.viewerSection) ? s.viewerSection : (list[0]?.id ?? null);
  s.set({ viewer, viewerSection: id });
  if (id) zoomToSection(id);
}

export function gotoSection(id: string) {
  useStore.getState().set({ viewerSection: id });
  zoomToSection(id);
}

/** Next/previous section in the Sections viewer (wraps around). */
export function stepSection(delta: number) {
  const s = useStore.getState();
  const list = viewerSections(s.doc);
  if (!list.length) return;
  const i = Math.max(0, list.findIndex(x => x.id === s.viewerSection));
  gotoSection(list[(i + delta + list.length) % list.length].id);
}

function zoomToSection(id: string) {
  const sec = viewerSections(useStore.getState().doc).find(x => x.id === id);
  if (sec?.frames.length) zoomToKeys(sec.frames, 1);
}

/** Top bar of the Sections viewer: previous / section picker / next. */
export function SectionBar() {
  const viewer = useStore(s => s.viewer);
  const doc = useStore(s => s.doc);
  const current = useStore(s => s.viewerSection);
  const menu = useMenu();
  if (viewer !== 'sections') return null;
  const list = viewerSections(doc);
  if (!sectionsOf(doc).length)
    return (
      <div className="island section-bar">
        <span className="section-empty">No sections yet: ask Claude to group your frames into sections.</span>
      </div>
    );
  const i = Math.max(0, list.findIndex(x => x.id === current));
  const sec = list[i];
  return (
    <div className="island section-bar">
      <button className="zbtn" title="Previous section (Page Up)" onClick={() => stepSection(-1)}>
        <ChevronLeft strokeWidth={1.75} />
      </button>
      <button
        className="section-name"
        title="Pick a section"
        onClick={e =>
          menu.open({
            anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
            items: list.map(x => ({ label: x.name, kbd: String(x.frames.length), checked: x.id === sec.id, onClick: () => gotoSection(x.id) })),
          })
        }
      >
        {sec.name}
        <span className="section-count">
          {i + 1}/{list.length}
        </span>
        <ChevronDown strokeWidth={1.75} />
      </button>
      <button className="zbtn" title="Next section (Page Down)" onClick={() => stepSection(1)}>
        <ChevronRight strokeWidth={1.75} />
      </button>
      {menu.node}
    </div>
  );
}

/** The zoom level; its menu also holds the fit commands, performance mode and the Sections viewer. */
function ZoomMenu() {
  const zoom = useStore(s => s.view.zoom);
  const viewer = useStore(s => s.viewer);
  const perfMode = useStore(s => s.perfMode);
  const menu = useMenu();
  return (
    <>
      <button
        className={'zoom-btn' + (perfMode ? ' perf' : '')}
        title={perfMode ? 'Zoom and view options (performance mode is on)' : 'Zoom and view options'}
        onClick={e =>
          menu.open({
            anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
            align: 'right',
            items: [
              { label: 'Zoom in', kbd: 'Ctrl+=', onClick: () => zoomBy(1.25) },
              { label: 'Zoom out', kbd: 'Ctrl+-', onClick: () => zoomBy(1 / 1.25) },
              { label: 'Zoom to fit', kbd: 'Shift+1', onClick: zoomToFit },
              { label: 'Zoom to selection', kbd: 'Shift+2', onClick: () => zoomToKeys(useStore.getState().selection, 8) },
              { sep: true },
              { label: '50%', onClick: () => setZoom(0.5) },
              { label: '100%', kbd: 'Shift+0', onClick: () => setZoom(1) },
              { label: '200%', onClick: () => setZoom(2) },
              { sep: true },
              {
                label: 'Performance mode',
                icon: <Zap />,
                kbd: perfMode ? 'On' : 'Off',
                onClick: () => {
                  setPerfMode(!perfMode);
                  useStore.getState().notify(perfMode ? 'Performance mode off' : 'Performance mode on: uses less memory, pictures are less sharp');
                },
              },
              { label: 'Sections viewer (one section at a time)', icon: <LayoutGrid />, kbd: viewer === 'sections' ? 'On' : 'Off', onClick: () => setViewer(viewer === 'sections' ? 'classic' : 'sections') },
            ],
          })
        }
      >
        {perfMode && <Zap strokeWidth={2} />}
        {Math.round(zoom * 100)}%
        <ChevronDown strokeWidth={2} />
      </button>
      {menu.node}
    </>
  );
}

/** The file's name. Outside VS Code (where the editor tab has no file menu of its own) it opens the file menu. */
function FileName() {
  const file = useStore(s => s.file);
  const dirty = useStore(isDirty);
  const menu = useMenu();
  if (!file) return null;
  if (inVsCode)
    return (
      <span className="tb-file" title={file.path ?? file.name}>
        <span className="tb-file-name">{file.name}</span>
      </span>
    );
  const items: MenuItem[] = [
    { label: 'New file', kbd: 'Ctrl+Alt+N', onClick: () => confirmDiscard() && useStore.getState().openDoc(newDocument(), { name: 'untitled.spen', path: null }) },
    { label: 'Open…', kbd: 'Ctrl+O', onClick: () => confirmDiscard() && useStore.getState().closeDoc() },
    { label: 'Open from disk…', onClick: () => confirmDiscard() && openLocalFile().catch(e => useStore.getState().notify(String(e))) },
    { sep: true },
    { label: 'Save', kbd: 'Ctrl+S', onClick: () => saveDoc() },
    { label: 'Save as…', kbd: 'Ctrl+Shift+S', onClick: () => saveDocAs() },
    { label: 'Save a copy as .pen (pen.dev)…', onClick: () => saveCopyAs('.pen') },
    { label: 'Save a copy as .spen (Superpencil)…', onClick: () => saveCopyAs('.spen') },
    { label: 'Reload from disk', disabled: !file.path, onClick: () => reloadFromDisk() },
  ];
  return (
    <>
      <button className="tb-file" title={file.path ?? file.name} onClick={e => menu.open({ anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(), items })}>
        <span className="tb-file-name">{file.name}</span>
        {dirty && <span className="dot" title="Unsaved changes" />}
        <ChevronDown strokeWidth={2} />
      </button>
      {menu.node}
    </>
  );
}

/** Shows which AI session holds the edit lock on this file; click to revoke it. */
function LockChip() {
  const locks = useStore(s => s.locks);
  const menu = useMenu();
  if (!locks.length) return null;
  const l = locks[0];
  const idle = Math.round((Date.now() - l.lastActive) / 1000);
  return (
    <>
      <button
        className="tb-lock"
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
        <span className="dot" />
        <span className="tb-lock-name">{l.label}</span>
      </button>
      {menu.node}
    </>
  );
}

export function confirmDiscard() {
  return !isDirty(useStore.getState()) || confirm('Discard unsaved changes?');
}

/** Layer search of the left panel: type to find layers by name or text; Enter or a click selects and zooms to one. */
export function LayerSearch({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const tree = useTree();
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
    <div className="layer-search">
      <div className="layer-search-box">
        <Search strokeWidth={1.75} />
        <input
          autoFocus
          placeholder="Find layers"
          value={q}
          onChange={e => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'ArrowDown') setActive(a => Math.min(a + 1, results.length - 1));
            if (e.key === 'ArrowUp') setActive(a => Math.max(a - 1, 0));
            if (e.key === 'Enter' && results[active]) go(results[active].key);
            if (e.key === 'Escape') onClose();
          }}
        />
      </div>
      {results.length > 0 && (
        <div className="find-results">
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
    </div>
  );
}

export function Toast() {
  const toast = useStore(s => s.toast);
  return toast ? <div className="toast">{toast.text}</div> : null;
}
