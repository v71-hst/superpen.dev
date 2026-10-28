// Global keyboard shortcuts (mirroring pen.dev / Figma conventions).
import { useStore, applyProps } from './store';
import { currentTree } from './tree';
import {
  copySelection,
  deleteSelection,
  duplicateSelection,
  groupSelection,
  nudge,
  paste,
  reorder,
  selectAll,
  setZoom,
  toggleComponent,
  ungroupSelection,
  zoomBy,
  zoomToFit,
  zoomToKeys,
} from './ops';
import { saveDoc, saveDocAs } from './fileio';
import { confirmDiscard } from '../ui/Chrome';
import { flushEdits, inVsCode } from './host';

function typing(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    const s = useStore.getState();
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    // File shortcuts work everywhere.
    if (mod && k === 's') {
      e.preventDefault();
      if (s.doc) (e.shiftKey ? saveDocAs : saveDoc)();
      return;
    }
    if (mod && k === 'o' && !inVsCode) {
      e.preventDefault();
      if (confirmDiscard()) s.closeDoc();
      return;
    }
    if (!s.doc || typing(e) || s.modal || s.presenting !== null) return;

    if (mod) {
      // In VS Code, undo/redo belong to the text document (VS Code routes Ctrl+Z there).
      if (inVsCode && (k === 'z' || k === 'y')) {
        flushEdits();
        return;
      }
      if (k === 'z') {
        e.preventDefault();
        return e.shiftKey ? s.redo() : s.undo();
      }
      if (k === 'y') {
        e.preventDefault();
        return s.redo();
      }
      if (k === 'c') return void copySelection();
      if (k === 'x') return void copySelection(true);
      if (k === 'v') {
        e.preventDefault();
        return void paste();
      }
      if (k === 'd') {
        e.preventDefault();
        return duplicateSelection();
      }
      if (k === 'a') {
        e.preventDefault();
        return selectAll();
      }
      if (k === 'g') {
        e.preventDefault();
        if (e.shiftKey) return ungroupSelection();
        return groupSelection(e.altKey);
      }
      if (k === 'k' && e.altKey) {
        e.preventDefault();
        return toggleComponent();
      }
      if (k === 'h' && e.shiftKey) {
        e.preventDefault();
        const tree = currentTree();
        return s.edit(d => {
          for (const key of s.selection) applyProps(d, key, { enabled: tree?.byKey.get(key)?.props.enabled === false ? undefined : false });
        });
      }
      if (k === 'r') {
        e.preventDefault();
        const row = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(s.selection[0] ?? '')}"]`);
        row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return;
      }
      if (e.key === ']' || e.key === '}') {
        e.preventDefault();
        return reorder(e.shiftKey ? 'front' : 'forward');
      }
      if (e.key === '[' || e.key === '{') {
        e.preventDefault();
        return reorder(e.shiftKey ? 'back' : 'backward');
      }
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        return zoomBy(1.25);
      }
      if (e.key === '-') {
        e.preventDefault();
        return zoomBy(1 / 1.25);
      }
      if (e.key === '0') {
        e.preventDefault();
        return setZoom(1);
      }
      if (e.key === '\\') {
        e.preventDefault();
        return s.set({ leftOpen: !s.leftOpen });
      }
      if (e.key === '/') {
        e.preventDefault();
        return s.set({ modal: 'shortcuts' });
      }
      if (e.key === 'Enter' && e.altKey) return s.set({ presenting: 0 });
      return;
    }

    if (e.shiftKey && (e.code === 'Digit1' || e.key === '!')) return zoomToFit();
    if (e.shiftKey && (e.code === 'Digit2' || e.key === '@')) return zoomToKeys(s.selection, 8);
    if (e.shiftKey && (e.code === 'Digit0' || e.key === ')')) return setZoom(1);

    switch (e.key) {
      case 'Delete':
      case 'Backspace':
        e.preventDefault();
        return deleteSelection();
      case 'Escape': {
        if (s.tool !== 'select') return s.set({ tool: 'select' });
        const tree = currentTree();
        const p = s.selection[0] ? tree?.parent.get(s.selection[0]) : null;
        return s.select(p ? [p.key] : []);
      }
      case 'Enter': {
        const tree = currentTree();
        const n = s.selection[0] ? tree?.byKey.get(s.selection[0]) : null;
        if (!n) return;
        e.preventDefault();
        if (n.type === 'text') return s.set({ editingKey: n.key });
        if (n.children.length) return s.select(n.children.map(c => c.key));
        return;
      }
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        return nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0);
      }
    }
    if (e.altKey || e.shiftKey) return;
    const tools: Record<string, any> = { v: 'select', k: 'scale', r: 'rect', o: 'ellipse', p: 'pen', t: 'text', f: 'frame', a: 'frame', n: 'note', h: 'hand' };
    if (tools[k]) {
      const t = tools[k];
      if (t === 'rect' || t === 'ellipse') s.set({ shapeTool: t });
      if (t === 'select' || t === 'scale') s.set({ selectTool: t });
      s.set({ tool: t });
    }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
