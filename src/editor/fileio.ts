// Opening/saving designs via the local workspace server, or the browser File System Access API.
// .spen (Superpencil, the default for new files) and .pen (pen.dev) hold the same JSON, so either converts losslessly.
import type { PenDoc } from '../model/types';
import { useStore, isDirty } from './store';
import { flushEdits, inVsCode, post, vscodeBaseUri } from './host';

export const serverAvailable = (async () => {
  if (typeof (globalThis as any).acquireVsCodeApi === 'function') return false;
  try {
    const r = await fetch('/api/info');
    return r.ok;
  } catch {
    return false;
  }
})();

export async function workspaceInfo(): Promise<{ workspace: string; files: string[] } | null> {
  try {
    const r = await fetch('/api/info');
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

export const DESIGN_EXTS = ['.spen', '.pen'];
const PICKER_TYPES = [{ description: 'Superpencil / pen.dev design', accept: { 'application/json': DESIGN_EXTS } }];

export function isDesignFile(name: string): boolean {
  const n = name.toLowerCase();
  return DESIGN_EXTS.some(x => n.endsWith(x));
}

/** Adds .spen unless the name already ends in a design extension. */
export function withDesignExt(name: string): string {
  return isDesignFile(name) ? name : `${name}.spen`;
}

/** Same name with the other design extension (a.pen <-> a.spen). */
export function swapDesignExt(name: string, ext: '.pen' | '.spen'): string {
  return name.replace(/\.s?pen$/i, '') + ext;
}

export function serialize(doc: PenDoc): string {
  return JSON.stringify(doc, null, 2);
}

export function parsePen(text: string): PenDoc {
  const doc = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.children)) throw new Error('Not a .spen/.pen design (missing "children")');
  return doc as PenDoc;
}

export async function openFromWorkspace(path: string) {
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`Could not open ${path}`);
  const doc = parsePen(await r.text());
  const st = await fetch(`/api/stat?path=${encodeURIComponent(path)}`).then(x => x.json()).catch(() => ({}));
  useStore.getState().openDoc(doc, { name: path.split('/').pop()!, path, mtime: st.mtime });
  rememberRecent(path);
  const url = new URL(location.href);
  url.searchParams.set('file', path);
  history.replaceState(null, '', url);
}

export async function openLocalFile() {
  const w = window as any;
  if (w.showOpenFilePicker) {
    const [handle] = await w.showOpenFilePicker({ types: PICKER_TYPES });
    const file = await handle.getFile();
    useStore.getState().openDoc(parsePen(await file.text()), { name: file.name, path: null, handle });
    return;
  }
  const file = await pickFileFallback();
  if (file) useStore.getState().openDoc(parsePen(await file.text()), { name: file.name, path: null });
}

function pickFileFallback(): Promise<File | null> {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.spen,.pen,application/json';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

export async function openDroppedFile(file: File) {
  useStore.getState().openDoc(parsePen(await file.text()), { name: file.name, path: null });
}

export function newDocument(): PenDoc {
  return { version: '2.21', children: [] };
}

export async function saveDoc(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.doc || !s.file) return false;
  if (inVsCode) {
    flushEdits();
    post({ type: 'save' });
    return true;
  }
  const text = serialize(s.doc);
  try {
    if (s.file.path) {
      const r = await fetch(`/api/file?path=${encodeURIComponent(s.file.path)}`, { method: 'PUT', body: text });
      if (!r.ok) throw new Error(await r.text());
      const { mtime } = await r.json();
      useStore.getState().markSaved(mtime);
    } else if (s.file.handle) {
      const w = await s.file.handle.createWritable();
      await w.write(text);
      await w.close();
      useStore.getState().markSaved();
    } else {
      return saveDocAs();
    }
    useStore.getState().notify('Saved');
    return true;
  } catch (e) {
    useStore.getState().notify(`Save failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

export async function saveDocAs(): Promise<boolean> {
  const s = useStore.getState();
  if (!s.doc) return false;
  if (inVsCode) {
    flushEdits();
    post({ type: 'saveAs' });
    return true;
  }
  const text = serialize(s.doc);
  if (await serverAvailable) {
    const suggested = s.file?.path ?? s.file?.name ?? 'untitled.spen';
    const name = prompt('Save as (path relative to the workspace folder):', suggested);
    if (!name) return false;
    const path = withDesignExt(name);
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: text });
    if (!r.ok) {
      s.notify('Save failed');
      return false;
    }
    const { mtime } = await r.json();
    useStore.setState({ file: { name: path.split('/').pop()!, path, mtime } });
    useStore.getState().markSaved(mtime);
    rememberRecent(path);
    s.notify('Saved');
    return true;
  }
  const w = window as any;
  if (w.showSaveFilePicker) {
    const handle = await w.showSaveFilePicker({ suggestedName: s.file?.name ?? 'untitled.spen', types: PICKER_TYPES });
    const wr = await handle.createWritable();
    await wr.write(text);
    await wr.close();
    useStore.setState({ file: { name: handle.name, path: null, handle } });
    useStore.getState().markSaved();
    return true;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = s.file?.name ?? 'untitled.spen';
  a.click();
  useStore.getState().markSaved();
  return true;
}

/** Writes a copy in the other format (.pen for pen.dev, .spen for Superpencil); the open file stays as it is. */
export async function saveCopyAs(ext: '.pen' | '.spen'): Promise<boolean> {
  const s = useStore.getState();
  if (!s.doc) return false;
  if (inVsCode) {
    flushEdits();
    post({ type: 'saveCopy', ext });
    return true;
  }
  const text = serialize(s.doc);
  const suggested = swapDesignExt(s.file?.path ?? s.file?.name ?? 'untitled', ext);
  if (await serverAvailable) {
    const name = prompt(`Save a copy as ${ext} (path relative to the workspace folder):`, suggested);
    if (!name) return false;
    const path = swapDesignExt(name, ext);
    const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: text });
    s.notify(r.ok ? `Saved a copy as ${path}` : 'Save failed');
    return r.ok;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = suggested.split('/').pop()!;
  a.click();
  return true;
}

/** Reloads the document when the file changes on disk (e.g. edited by an AI agent through MCP). */
export function watchFile(path: string): () => void {
  const es = new EventSource(`/api/watch?path=${encodeURIComponent(path)}`);
  es.onmessage = async ev => {
    const { mtime } = JSON.parse(ev.data);
    const s = useStore.getState();
    if (!s.file || s.file.path !== path || s.file.mtime === mtime) return;
    try {
      const text = await fetch(`/api/file?path=${encodeURIComponent(path)}`).then(r => r.text());
      if (s.doc && text === serialize(s.doc)) {
        useStore.setState({ file: { ...s.file, mtime } });
        return;
      }
      const doc = parsePen(text);
      if (isDirty(useStore.getState())) {
        s.notify('File changed on disk — save to overwrite, or use File › Reload');
        return;
      }
      useStore.getState().replaceDocFromDisk(doc, mtime);
      s.notify('Reloaded from disk');
    } catch {
      /* partial write; the next event will retry */
    }
  };
  return () => es.close();
}

export async function reloadFromDisk() {
  const s = useStore.getState();
  if (!s.file?.path) return;
  const text = await fetch(`/api/file?path=${encodeURIComponent(s.file.path)}`).then(r => r.text());
  const st = await fetch(`/api/stat?path=${encodeURIComponent(s.file.path)}`).then(x => x.json());
  useStore.getState().replaceDocFromDisk(parsePen(text), st.mtime);
}

export function makeUrlResolver(path: string | null): (u: string) => string {
  const dir = path && path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  return (u: string) => {
    if (!u || /^(https?:|data:|blob:)/i.test(u)) return u;
    if (inVsCode) return vscodeBaseUri() + u.replace(/^\.\//, '');
    if (path === null) return u;
    const rel = u.replace(/^\.\//, '');
    return `/api/file?path=${encodeURIComponent(dir + rel)}`;
  };
}

const RECENT_KEY = 'pen.recent';

export function recentFiles(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function rememberRecent(path: string) {
  try {
    const list = [path, ...recentFiles().filter(p => p !== path)].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
}
