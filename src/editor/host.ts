// Bridge to the VS Code extension host when running inside a webview (no-op in the standalone build).
import { useStore } from './store';
import { parsePen, serialize } from './fileio';
import { handleAgentRequest } from './agent';
import { invalidateAssets } from '../render/scripts';
import { log, uiSnapshot } from './diagnostics';

declare function acquireVsCodeApi(): { postMessage(m: any): void; getState(): any; setState(s: any): void };

export const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
export const inVsCode = !!vscodeApi;

let baseUri = '';
let lastSentText: string | null = null;
let lastSyncedDoc: any = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let reqId = 0;
const pending = new Map<number, (v: any) => void>();

export function vscodeBaseUri() {
  return baseUri;
}

export function post(msg: any) {
  vscodeApi?.postMessage(msg);
}

/** Request/response round trip to the extension host. */
export function request<T = any>(type: string, payload: any = {}): Promise<T> {
  const id = ++reqId;
  return new Promise(resolve => {
    pending.set(id, resolve);
    post({ type, id, ...payload });
  });
}

/** Pushes the current document text to VS Code (which owns dirty state, undo and saving). */
export function flushEdits() {
  clearTimeout(timer);
  timer = undefined;
  const { doc } = useStore.getState();
  if (!doc || doc === lastSyncedDoc) return;
  lastSyncedDoc = doc;
  const text = serialize(doc);
  if (text === lastSentText) return;
  lastSentText = text;
  post({ type: 'edit', text });
}

export function installVsCodeBridge() {
  if (!vscodeApi) return;
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'load': {
        baseUri = m.baseUri ?? '';
        if (m.theme) useStore.setState({ uiTheme: m.theme });
        try {
          const doc = parsePen(m.text);
          lastSentText = m.text;
          lastSyncedDoc = doc;
          useStore.getState().openDoc(doc, { name: m.fileName, path: null });
        } catch (e) {
          useStore.setState({ loadError: String(e) } as any);
        }
        break;
      }
      case 'update': {
        // The document changed outside the webview (text editor, undo/redo, AI agent, git…).
        if (m.text === lastSentText) return;
        try {
          const doc = parsePen(m.text);
          lastSentText = m.text;
          lastSyncedDoc = doc;
          const s = useStore.getState();
          useStore.setState({ doc, savedDoc: doc, editingKey: null, selection: s.selection.filter(k => keyExists(doc, k)) });
        } catch {
          /* invalid JSON while the user is typing in a text editor: ignore until it parses */
        }
        break;
      }
      case 'saved':
        useStore.getState().markSaved();
        break;
      case 'theme':
        useStore.setState({ uiTheme: m.theme });
        break;
      case 'locks':
        useStore.setState({ locks: m.locks ?? [] });
        break;
      case 'assetsChanged':
        invalidateAssets();
        break;
      case 'mcp':
        // Request from an AI agent (via the extension's MCP bridge).
        {
          const t0 = performance.now();
          Promise.resolve()
            .then(() => handleAgentRequest(m.method, m.params ?? {}))
            .then(result => {
              post({ type: 'mcpResult', id: m.id, result });
              log('info', `mcp ${m.method} ok in ${Math.round(performance.now() - t0)}ms`);
              checkUiAfter(m.method);
            })
            .catch(err => {
              post({ type: 'mcpResult', id: m.id, error: err instanceof Error ? err.message : String(err) });
              log('warn', `mcp ${m.method} failed: ${err instanceof Error ? err.message : err}`);
              checkUiAfter(m.method);
            });
        }
        break;
      case 'response': {
        const r = pending.get(m.id);
        pending.delete(m.id);
        r?.(m.result);
        break;
      }
    }
  });
  useStore.subscribe((s, prev) => {
    if (s.doc && s.doc !== prev.doc && s.doc !== lastSyncedDoc) {
      clearTimeout(timer);
      timer = setTimeout(flushEdits, 250);
    }
  });
  window.addEventListener('blur', flushEdits);
  post({ type: 'ready' });
}

/** After an agent request, verify the editor UI is intact; log a full snapshot if anything is missing. */
function checkUiAfter(method: string) {
  setTimeout(() => {
    const snap = uiSnapshot();
    const v = snap.view;
    if (!snap.dom.toolbar || !snap.dom.canvas || !isFinite(v.x) || !isFinite(v.y) || !isFinite(v.zoom) || snap.presenting !== null || snap.modal) {
      log('error', `UI problem after mcp ${method}`, snap);
    }
  }, 400);
}

function keyExists(doc: any, key: string) {
  const id = key.split('/')[0];
  const walk = (nodes: any[]): boolean => nodes.some(n => n?.id === id || (n?.children && walk(n.children)));
  return walk(doc.children ?? []);
}

/** Saves a data URL to disk: via VS Code's save dialog in the extension, or a browser download. */
export function downloadDataUrl(name: string, dataUrl: string) {
  if (inVsCode) {
    post({ type: 'download', name, dataUrl });
    return;
  }
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = name;
  a.click();
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.readAsDataURL(b);
  });
}
