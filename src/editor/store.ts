// Editor state (zustand): document + history, selection, tools, viewport and UI flags.
import { create } from 'zustand';
import { produce, setAutoFreeze } from 'immer';
import type { PenDoc, PenNode, Theme } from '../model/types';
import { locate } from '../model/doc';
import { log, takeViewSource } from './diagnostics';

setAutoFreeze(false);

export type Tool = 'select' | 'scale' | 'rect' | 'ellipse' | 'polygon' | 'icon' | 'text' | 'frame' | 'note' | 'hand' | 'pen';
export type LeftTab = 'layers' | 'slides' | 'components' | 'libraries';
export type Modal = null | 'shortcuts' | 'variables' | 'settings' | 'about' | 'iconPicker';

export type FileRef = {
  name: string;
  /** Workspace-relative path when opened through the local server. */
  path: string | null;
  handle?: any;
  mtime?: number;
};

type View = { x: number; y: number; zoom: number };

type State = {
  file: FileRef | null;
  doc: PenDoc | null;
  savedDoc: PenDoc | null;
  past: PenDoc[];
  future: PenDoc[];
  lastMerge: { key: string; t: number } | null;
  selection: string[];
  hover: string | null;
  editingKey: string | null;
  tool: Tool;
  shapeTool: 'rect' | 'ellipse' | 'polygon' | 'icon';
  selectTool: 'select' | 'scale';
  view: View;
  previewTheme: Theme | null;
  leftOpen: boolean;
  leftTab: LeftTab;
  rightOpen: boolean;
  uiTheme: 'dark' | 'light';
  modal: Modal;
  presenting: number | null;
  toast: { text: string; id: number } | null;
  expanded: Record<string, boolean>;
  clipboard: PenNode[] | null;
  /** Nodes recently changed by an AI agent, briefly highlighted on the canvas. */
  flashes: { key: string; t: number }[];
  /** MCP sessions holding locks on this file (shown in the editor). */
  locks: { session: string; label: string; since: number; lastActive: number }[];
  /** Bumped whenever a zoomed-out bitmap finishes rendering. */
  lodVersion: number;
  /** Top-level frames forced to render live (root key -> expiry time), e.g. for agent screenshots. */
  pinnedRoots: Record<string, number>;
  /** Bumped when script output or script/shader files change. */
  assetVersion: number;
};

type Actions = {
  openDoc: (doc: PenDoc, file: FileRef) => void;
  closeDoc: () => void;
  edit: (recipe: (d: PenDoc) => void, mergeKey?: string) => void;
  undo: () => void;
  redo: () => void;
  markSaved: (mtime?: number) => void;
  replaceDocFromDisk: (doc: PenDoc, mtime?: number) => void;
  select: (keys: string[]) => void;
  set: (partial: Partial<State>) => void;
  setView: (v: Partial<View>) => void;
  notify: (text: string) => void;
};

export const useStore = create<State & Actions>((set, get) => ({
  file: null,
  doc: null,
  savedDoc: null,
  past: [],
  future: [],
  lastMerge: null,
  selection: [],
  hover: null,
  editingKey: null,
  tool: 'select',
  shapeTool: 'rect',
  selectTool: 'select',
  view: { x: 0, y: 0, zoom: 1 },
  previewTheme: null,
  leftOpen: false,
  leftTab: 'layers',
  rightOpen: true,
  uiTheme: (localStorage.getItem('pen.uiTheme') as 'dark' | 'light') || 'dark',
  modal: null,
  presenting: null,
  toast: null,
  expanded: {},
  clipboard: null,
  flashes: [],
  locks: [],
  lodVersion: 0,
  pinnedRoots: {},
  assetVersion: 0,

  openDoc: (doc, file) =>
    set({ doc, savedDoc: doc, file, past: [], future: [], selection: [], hover: null, editingKey: null, previewTheme: null, expanded: {}, lastMerge: null, view: fitViewForDoc(doc) }),
  closeDoc: () => set({ doc: null, savedDoc: null, file: null, past: [], future: [], selection: [] }),

  edit: (recipe, mergeKey) => {
    const { doc, past, lastMerge } = get();
    if (!doc) return;
    const next = produce(doc, recipe);
    if (next === doc) return;
    const now = Date.now();
    const merge = mergeKey && lastMerge && lastMerge.key === mergeKey && now - lastMerge.t < 1500;
    set({
      doc: next,
      past: merge ? past : [...past.slice(-199), doc],
      future: [],
      lastMerge: mergeKey ? { key: mergeKey, t: now } : null,
    });
  },
  undo: () => {
    const { past, doc, future } = get();
    if (!past.length || !doc) return;
    set({ doc: past[past.length - 1], past: past.slice(0, -1), future: [doc, ...future], lastMerge: null, editingKey: null });
  },
  redo: () => {
    const { past, doc, future } = get();
    if (!future.length || !doc) return;
    set({ doc: future[0], future: future.slice(1), past: [...past, doc], lastMerge: null, editingKey: null });
  },
  markSaved: mtime => {
    const { doc, file } = get();
    set({ savedDoc: doc, file: file ? { ...file, mtime: mtime ?? file.mtime } : file });
  },
  replaceDocFromDisk: (doc, mtime) => {
    const { file } = get();
    set({ doc, savedDoc: doc, file: file ? { ...file, mtime } : file, past: [], future: [], editingKey: null });
  },
  select: keys => set({ selection: keys, editingKey: null }),
  set: partial => set(partial as any),
  setView: v => {
    const next = { ...get().view, ...v };
    // A non-finite value would freeze the canvas (every later pan/zoom stays NaN); ignore such updates.
    if (!isFinite(next.x) || !isFinite(next.y) || !isFinite(next.zoom) || next.zoom <= 0) return;
    // Every intended view change names its source; anything else is logged with a stack to find stray jumps.
    if (!takeViewSource()) log('warn', 'view changed from an unexpected place', { from: get().view, to: next, stack: new Error().stack?.split('\n').slice(2, 7).join(' < ') });
    set({ view: next });
  },
  notify: text => {
    const id = Date.now();
    set({ toast: { text, id } });
    setTimeout(() => {
      if (get().toast?.id === id) set({ toast: null });
    }, 2600);
  },
}));

/** Zoom-to-fit computed from document positions, so a large file never renders everything at 100% first. */
function fitViewForDoc(doc: PenDoc): View {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of doc.children) {
    if (!n || n.enabled === false || typeof n.x !== 'number' || typeof n.y !== 'number') continue;
    const w = typeof n.width === 'number' ? n.width : 100;
    const h = typeof n.height === 'number' ? n.height : 100;
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x + w);
    y1 = Math.max(y1, n.y + h);
  }
  if (!isFinite(x0)) return { x: 120, y: 80, zoom: 1 };
  const availW = Math.max(200, innerWidth - 140);
  const availH = Math.max(200, innerHeight - 200);
  const zoom = Math.max(0.02, Math.min(1, availW / (x1 - x0), availH / (y1 - y0)));
  return { zoom, x: 70 + (availW - (x1 - x0) * zoom) / 2 - x0 * zoom, y: 100 + (availH - (y1 - y0) * zoom) / 2 - y0 * zoom };
}

// ---------- node editing helpers ----------

/** Splits a render key into its document source: a real node id, or (instance id, override path). */
export function keySource(key: string): { kind: 'real'; id: string } | { kind: 'virtual'; instanceId: string; path: string } {
  const i = key.indexOf('/');
  if (i < 0) return { kind: 'real', id: key };
  return { kind: 'virtual', instanceId: key.slice(0, i), path: key.slice(i + 1) };
}

/** Applies property changes to a node; nodes inside instances get written as overrides on the instance. */
export function applyProps(d: PenDoc, key: string, changes: Record<string, any>) {
  const src = keySource(key);
  if (src.kind === 'real') {
    const loc = locate(d, src.id);
    if (!loc) return;
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) delete loc.node[k];
      else loc.node[k] = v;
    }
    return;
  }
  const loc = locate(d, src.instanceId);
  if (!loc) return;
  const desc = (loc.node.descendants ??= {});
  const entry = (desc[src.path] ??= {});
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined) delete entry[k];
    else entry[k] = v;
  }
  if (!Object.keys(entry).length) delete desc[src.path];
}

export function updateProps(key: string, changes: Record<string, any>, mergeKey?: string) {
  useStore.getState().edit(d => applyProps(d, key, changes), mergeKey);
}

export function isDirty(s: { doc: PenDoc | null; savedDoc: PenDoc | null }) {
  return !!s.doc && s.doc !== s.savedDoc;
}
