// Small shared controls used by the panels: menus, numeric fields, selects, checkboxes, layer icons.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  ChevronDown,
  Circle,
  Code,
  Columns3,
  Component,
  Diamond,
  FileText,
  Frame,
  Globe,
  Group,
  MessageSquare,
  Minus,
  Rows3,
  Spline,
  Square,
  Star,
  StickyNote,
  Triangle,
  Type,
  type LucideIcon,
} from 'lucide-react';
import type { RNode } from '../model/types';

// ---------- menus ----------

export type MenuItem =
  | { sep: true }
  | { label: string; icon?: React.ReactNode; kbd?: string; checked?: boolean; disabled?: boolean; onClick?: () => void };

export function Menu({ anchor, items, onClose, align = 'left', placement = 'below' }: { anchor: DOMRect; items: MenuItem[]; onClose: () => void; align?: 'left' | 'right'; placement?: 'below' | 'right' | 'above' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current!;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = placement === 'right' ? anchor.right + 8 : align === 'right' ? anchor.right - w : anchor.left;
    let top = placement === 'right' ? anchor.top : placement === 'above' ? anchor.top - h - 6 : anchor.bottom + 6;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    top = Math.max(8, Math.min(top, innerHeight - h - 8));
    setPos({ left, top });
  }, [anchor, align, placement]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    setTimeout(() => window.addEventListener('pointerdown', down, true));
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
    };
  }, [onClose]);
  return createPortal(
    <div className="menu" ref={ref} style={pos}>
      {items.map((it, i) =>
        'sep' in it ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            className={'menu-item' + (it.disabled ? ' disabled' : '')}
            onClick={() => {
              onClose();
              it.onClick?.();
            }}
          >
            {it.checked !== undefined && <span className="check">{it.checked ? <Check /> : null}</span>}
            {it.icon && <span className="mi-icon">{it.icon}</span>}
            <span>{it.label}</span>
            {it.kbd && <span className="kbd">{it.kbd}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [menu, setMenu] = useState<{ anchor: DOMRect; items: MenuItem[]; align?: 'left' | 'right'; placement?: 'below' | 'right' | 'above' } | null>(null);
  const node = menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null;
  return { open: setMenu, node, isOpen: !!menu };
}

// ---------- number field ----------

function evalNumber(s: string): number | null {
  const t = s.trim().replace(/,/g, '.').replace(/[a-z%°]+$/i, '');
  if (!t) return null;
  if (!/^[\d.+\-*/() ]+$/.test(t)) return null;
  try {
    const v = Function(`"use strict";return (${t})`)();
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export const fmt = (n: number, digits = 2) => {
  if (!isFinite(n)) return '';
  const r = Math.round(n * 10 ** digits) / 10 ** digits;
  return String(r);
};

export function NumberField({
  label,
  value,
  display,
  onChange,
  onText,
  suffix,
  min,
  max,
  step = 1,
  disabled,
  varName,
  title,
  scale = 1,
  style,
}: {
  label?: React.ReactNode;
  value: number | undefined;
  display?: string;
  onChange: (v: number, scrubbing?: boolean) => void;
  onText?: (text: string) => boolean;
  suffix?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  varName?: string;
  title?: string;
  scale?: number;
  style?: React.CSSProperties;
}) {
  const shown = display ?? (value === undefined ? '' : fmt(value * scale));
  const [text, setText] = useState(shown);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(shown);
  }, [shown, focused]);
  const clamp = (v: number) => Math.max(min ?? -Infinity, Math.min(max ?? Infinity, v));
  const commit = () => {
    if (text === shown) return;
    if (onText?.(text)) return;
    const v = evalNumber(text);
    if (v !== null) onChange(clamp(v / scale));
    else setText(shown);
  };
  const scrub = (e: React.PointerEvent) => {
    if (disabled || value === undefined) return;
    e.preventDefault();
    const startX = e.clientX;
    const start = value;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const d = Math.round((ev.clientX - startX) / 2) * step * (ev.shiftKey ? 10 : 1);
      onChange(clamp(Math.round((start + d / scale) * 1000) / 1000), true);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return (
    <div className={'field' + (disabled ? ' disabled' : '') + (varName ? ' var-bound' : '')} title={title ?? (varName ? `$${varName}` : undefined)} style={style}>
      {label !== undefined && (
        <span className="lbl" onPointerDown={scrub}>
          {label}
        </span>
      )}
      <input
        value={focused ? text : varName ? varName : text}
        disabled={disabled}
        onFocus={e => {
          setFocused(true);
          setText(shown);
          requestAnimationFrame(() => e.target.select());
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(shown);
            requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
          }
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && value !== undefined) {
            e.preventDefault();
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const v = clamp(value + d / scale);
            onChange(v);
            setText(fmt(v * scale));
          }
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </div>
  );
}

// ---------- select ----------

export function Select<T extends string>({ value, options, onChange, style, title }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; style?: React.CSSProperties; title?: string }) {
  const cur = options.find(o => o.value === value);
  return (
    <label className="select" style={style} title={title}>
      <span>{cur?.label ?? value}</span>
      <ChevronDown />
      <select value={value} onChange={e => onChange(e.target.value as T)}>
        {!cur && <option value={value}>{value}</option>}
        {options.map(o => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function CheckRow({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <label className="check-row" onClick={() => onChange(!checked)}>
      <span className={'checkbox' + (checked ? ' on' : '')}>{checked && <Check strokeWidth={3} />}</span>
      {label}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T | undefined; options: { value: T; icon: React.ReactNode; title: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o.value} className={value === o.value ? 'on' : ''} title={o.title} onClick={() => onChange(o.value)}>
          {o.icon}
        </button>
      ))}
    </div>
  );
}

// ---------- layer icons ----------

export function layerIconFor(n: RNode): { Icon: LucideIcon; cls: string } {
  if (n.isComponent) return { Icon: Component, cls: 'component' };
  if (n.instanceOf) return { Icon: Diamond, cls: 'instance' };
  switch (n.type) {
    case 'frame': {
      const l = n.props.layout;
      if (l === 'vertical') return { Icon: Rows3, cls: '' };
      if (l === undefined || l === 'horizontal') return { Icon: Columns3, cls: '' };
      return { Icon: Frame, cls: '' };
    }
    case 'text':
      return { Icon: Type, cls: '' };
    case 'rectangle':
      return { Icon: Square, cls: '' };
    case 'ellipse':
      return { Icon: Circle, cls: '' };
    case 'polygon':
      return { Icon: Triangle, cls: '' };
    case 'path':
      return { Icon: Spline, cls: '' };
    case 'line':
      return { Icon: Minus, cls: '' };
    case 'icon':
    case 'icon_font':
      return { Icon: Star, cls: '' };
    case 'group':
      return { Icon: Group, cls: '' };
    case 'note':
      return { Icon: StickyNote, cls: '' };
    case 'prompt':
      return { Icon: MessageSquare, cls: '' };
    case 'context':
      return { Icon: FileText, cls: '' };
    case 'script':
      return { Icon: Code, cls: '' };
    case 'browser':
      return { Icon: Globe, cls: '' };
    default:
      return { Icon: Square, cls: '' };
  }
}

export function useOutside(ref: React.RefObject<HTMLElement>, onOut: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const h = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOut();
    };
    const t = setTimeout(() => window.addEventListener('pointerdown', h, true));
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', h, true);
    };
  }, [ref, onOut, active]);
}
