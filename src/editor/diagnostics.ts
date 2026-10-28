// Error capture and diagnostics: in VS Code, log lines go to the extension (Output panel + ~/.pen-editor/logs).
import { useStore } from './store';
import { inVsCode, post } from './host';

type Level = 'info' | 'warn' | 'error';

const recent: string[] = [];

export function log(level: Level, message: string, detail?: unknown) {
  const text = `${message}${detail !== undefined ? ' ' + safe(detail) : ''}`.slice(0, 4000);
  recent.push(`${new Date().toISOString()} [${level}] ${text}`);
  if (recent.length > 200) recent.shift();
  if (inVsCode) post({ type: 'log', level, message: text });
  else if (level === 'error') console.error('[pen-editor]', text);
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.message}\n${v.stack ?? ''}`;
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Snapshot of the editor UI, logged around agent operations to diagnose "the UI broke" reports. */
export function uiSnapshot() {
  const s = useStore.getState();
  const has = (sel: string) => !!document.querySelector(sel);
  return {
    view: s.view,
    tool: s.tool,
    leftOpen: s.leftOpen,
    modal: s.modal,
    presenting: s.presenting,
    selection: s.selection.length,
    editing: !!s.editingKey,
    dom: { toolbar: has('.toolbar'), canvas: has('#pen-world'), roots: document.getElementById('pen-world')?.children.length ?? 0, right: has('.right-panel'), left: has('.left-panel') },
  };
}

export function recentLog() {
  return recent.slice(-50);
}

export function installDiagnostics() {
  window.addEventListener('error', e => log('error', `uncaught: ${e.message}`, e.error ?? `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => log('error', 'unhandled rejection', e.reason));
  log('info', 'editor started', { inVsCode, ua: navigator.userAgent.slice(0, 120) });
}
