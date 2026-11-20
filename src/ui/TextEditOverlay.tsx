// Editing a text layer in a frame Skia draws: the frame stays on the canvas without that text (painter.ts, the
// recording leaves the edited node out) and the text is edited in a box over it, styled like the text and scaled with
// the view, as the page-element renderer's own editor was (NodeView TextView / EditableText).
import React, { useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useStore } from '../editor/store';
import type { Tree } from '../editor/tree';
import { nodeRect, skiaOwns } from '../editor/measure';
import { resolveProps } from '../model/props';
import { fillList, isEnabled, primaryColor } from '../render/paint';
import { ensureFont, weightNum } from '../render/fonts';

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

export function TextEditOverlay({ tree, onCommit }: { tree: Tree; onCommit: (key: string, text: string | null) => void }) {
  const key = useStore(s => s.editingKey);
  const view = useStore(s => s.view);
  const doc = useStore(s => s.doc);
  const n = key ? tree.byKey.get(key) : null;
  if (!key || !n || !doc || n.type !== 'text' || !skiaOwns(key)) return null;
  const r = nodeRect(key);
  if (!r) return null;
  const p = resolveProps(doc, n.props, n.theme);
  const family = typeof p.fontFamily === 'string' && p.fontFamily ? p.fontFamily : 'Inter';
  ensureFont(family, p.fontWeight, p.fontStyle === 'italic');
  const growth = p.textGrowth ?? 'auto';
  const autoW = growth === 'auto';
  const autoH = growth !== 'fixed-width-height';
  const style: CSSProperties = {
    position: 'absolute',
    left: view.x + r.x * view.zoom,
    top: view.y + r.y * view.zoom,
    transform: `scale(${view.zoom})`,
    transformOrigin: '0 0',
    ...(autoW ? { minWidth: r.w } : { width: r.w }),
    ...(autoH ? { minHeight: r.h } : { height: r.h }),
    display: 'flex',
    flexDirection: 'column',
    justifyContent: p.textAlignVertical === 'middle' ? 'center' : p.textAlignVertical === 'bottom' ? 'flex-end' : 'flex-start',
    fontFamily: `"${family}", "Inter", system-ui, sans-serif`,
    fontSize: num(p.fontSize, 14),
    fontWeight: weightNum(p.fontWeight),
    fontStyle: p.fontStyle === 'italic' ? 'italic' : undefined,
    letterSpacing: p.letterSpacing !== undefined ? `${num(p.letterSpacing)}px` : undefined,
    lineHeight: typeof p.lineHeight === 'number' && p.lineHeight > 0 ? p.lineHeight : 'normal',
    textAlign: p.textAlign ?? 'left',
    whiteSpace: autoW ? 'pre' : 'pre-wrap',
    overflowWrap: 'break-word',
    textDecoration: [p.underline === true ? 'underline' : '', p.strikethrough === true ? 'line-through' : ''].join(' ').trim() || undefined,
    color: primaryColor(fillList(p.fill ?? '#000000').filter(isEnabled)) ?? '#000000',
    zIndex: 1,
  };
  const content = typeof p.content === 'string' ? p.content : p.content === undefined ? '' : String(p.content);
  return (
    <div className="text-edit-overlay" style={style}>
      <EditableText key={key} initial={content} onDone={t => onCommit(key, t)} />
    </div>
  );
}

function EditableText({ initial, onDone }: { initial: string; onDone: (t: string | null) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.textContent = initial;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);
  return (
    <span
      ref={ref}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      data-editing
      style={{ outline: 'none', cursor: 'text', minWidth: 2, display: 'inline-block' }}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
      }}
      onPointerDown={e => e.stopPropagation()}
      onBlur={e => onDone(e.currentTarget.innerText.replace(/\n$/, ''))}
    />
  );
}
