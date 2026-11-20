// Small helpers about a node's properties that the editor, the layout engine and the Skia painter share (they lived in
// the page-element renderer, render/NodeView.tsx, which is gone).
import type React from 'react';
import * as Lucide from 'lucide-react';
import type { PenDoc } from './types';
import { deepResolve } from './resolve';

/** Keys whose values are structure, not styling: never resolved against variables or themes. */
const SKIP_RESOLVE = new Set(['children', 'descendants', 'id', 'type', 'ref', 'name', 'context', 'metadata']);

/** A node's props with variables ($name) and theme values resolved. */
export function resolveProps(doc: Pick<PenDoc, 'variables'>, props: any, theme: any) {
  const out: any = {};
  for (const k of Object.keys(props)) out[k] = SKIP_RESOLVE.has(k) ? props[k] : deepResolve(doc as PenDoc, props[k], theme);
  return out;
}

export type Sizing = { mode: 'fixed'; px: number } | { mode: 'fill'; fallback?: number } | { mode: 'fit'; fallback?: number };

/** A width or height: a number, `fill_container`, `fit_content`, either with a fallback size in brackets. */
export function parseSizing(v: any): Sizing {
  if (typeof v === 'number' && isFinite(v)) return { mode: 'fixed', px: v };
  if (typeof v === 'string') {
    const m = v.match(/^(fill_container|fit_content)(?:\(([-\d.]+)\))?$/);
    if (m) {
      const fb = m[2] !== undefined ? parseFloat(m[2]) : undefined;
      return m[1] === 'fill_container' ? { mode: 'fill', fallback: fb } : { mode: 'fit', fallback: fb };
    }
    const n = parseFloat(v);
    if (isFinite(n)) return { mode: 'fixed', px: n };
  }
  return { mode: 'fit' };
}

function toPascal(name: string) {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/** The Lucide icon component for a name (kebab or Pascal case), or null. */
export function lucideIcon(name: string): React.ComponentType<any> | null {
  const L = Lucide as any;
  const pas = toPascal(name);
  return L[pas] ?? L[pas + 'Icon'] ?? L.icons?.[pas] ?? null;
}
