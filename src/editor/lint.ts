// Design lint: style problems (hard-coded tokens, tiny or low-contrast text, off-grid values, clutter) plus the
// rendering checks from check_layout. Shared by the Lint panel and the lint_design MCP tool.
import { useStore } from './store';
import { currentTree } from './tree';
import { checkLayout } from './agent';
import { deepResolve, resolveVariable } from '../model/resolve';
import { displayName } from '../model/doc';
import { fillList, parseColor, toHex } from '../render/paint';
import type { RNode } from '../model/types';

export type LintIssue = {
  severity: 'error' | 'warning' | 'info';
  rule: string;
  message: string;
  key?: string;
  /** A one-click fix: property changes for `key`. */
  fix?: { label: string; changes: Record<string, any> };
};

type RGBA = { r: number; g: number; b: number; a: number };

function luminance(c: RGBA) {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

function contrast(a: RGBA, b: RGBA) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Solid color of a paint value (first visible solid fill), resolved. */
function solid(v: any): RGBA | null {
  for (const f of fillList(v)) {
    if (typeof f === 'string') {
      const c = parseColor(f);
      if (c) return c;
    } else if (f && typeof f === 'object' && f.enabled !== false && (f.type === 'color' || f.type === undefined) && typeof f.color === 'string') {
      const c = parseColor(f.color);
      if (c) return c;
    }
  }
  return null;
}

export async function lintDesign(rootKey?: string): Promise<LintIssue[]> {
  const s = useStore.getState();
  const doc = s.doc;
  const tree = currentTree();
  if (!doc || !tree) return [];
  const roots = rootKey ? [tree.byKey.get(rootKey)].filter((x): x is RNode => !!x) : tree.roots;
  const issues: LintIssue[] = [];
  const label = (n: RNode) => `${n.type} “${displayName(n.props)}”`;

  // Color variables by hex value, so literal colors that match a token can point at it.
  const colorVars = new Map<string, string>();
  for (const [name, def] of Object.entries(doc.variables ?? {})) {
    if (def?.type !== 'color') continue;
    const v = resolveVariable(doc, name, tree.theme);
    const c = parseColor(v);
    if (c && !colorVars.has(toHex(c))) colorVars.set(toHex(c), name);
  }

  const fonts = new Set<string>();
  const visit = (n: RNode, bg: RGBA | null) => {
    const p = n.props;
    if (p.enabled === false) {
      if (!n.inInstance) issues.push({ severity: 'info', rule: 'hidden-layer', message: `${label(n)} is hidden`, key: n.key });
      return;
    }
    const editable = !n.inInstance;
    // Literal colors that equal a variable.
    for (const prop of ['fill', 'stroke'] as const) {
      const raw = p[prop];
      if (!editable || typeof raw !== 'string' || raw.startsWith('$')) continue;
      const c = parseColor(raw);
      const v = c ? colorVars.get(toHex(c)) : undefined;
      if (v) issues.push({ severity: 'warning', rule: 'use-variable', message: `${label(n)} uses ${raw} for ${prop}; the variable $${v} has the same value`, key: n.key, fix: { label: `Use $${v}`, changes: { [prop]: '$' + v } } });
    }
    const r = (k: string) => deepResolve(doc, p[k], n.theme);
    // Off-grid geometry (fractional pixels blur edges and text).
    if (editable && !n.isComponent) {
      const frac = ['x', 'y', 'width', 'height'].filter(k => typeof p[k] === 'number' && Math.abs(p[k] - Math.round(p[k])) > 0.01);
      if (frac.length) issues.push({ severity: 'info', rule: 'off-grid', message: `${label(n)} has fractional ${frac.join('/')}`, key: n.key, fix: { label: 'Round', changes: Object.fromEntries(frac.map(k => [k, Math.round(p[k])])) } });
    }
    const myBg = n.type !== 'text' ? solid(r('fill')) : null;
    const under = myBg && myBg.a > 0.9 ? myBg : bg;
    if (n.type === 'text') {
      const size = r('fontSize') ?? 14;
      if (typeof r('fontFamily') === 'string') fonts.add(r('fontFamily'));
      if (typeof size === 'number' && size < 10) issues.push({ severity: 'warning', rule: 'tiny-text', message: `${label(n)} is ${size}px; text under 10px is hard to read (on mobile aim for 12px+)`, key: n.key });
      const fg = solid(r('fill'));
      if (fg && under && fg.a > 0.5) {
        const ratio = contrast(fg, under);
        const large = typeof size === 'number' && (size >= 24 || (size >= 18.5 && Number(r('fontWeight')) >= 700));
        const need = large ? 3 : 4.5;
        if (ratio < need) issues.push({ severity: ratio < need - 1.5 ? 'warning' : 'info', rule: 'contrast', message: `${label(n)} has contrast ${ratio.toFixed(2)}:1 against its background (WCAG AA needs ${need}:1)`, key: n.key });
      }
    }
    if (editable && n.type === 'frame' && !n.children.length && !solid(r('fill')) && !p.stroke && !p.effect && !n.instanceOf) issues.push({ severity: 'info', rule: 'empty-frame', message: `${label(n)} is empty and invisible`, key: n.key });
    n.children.forEach(c => visit(c, under));
  };
  roots.forEach(n => visit(n, null));
  if (fonts.size > 3) issues.push({ severity: 'info', rule: 'font-count', message: `${fonts.size} font families are used (${[...fonts].join(', ')}); most designs use 1–2` });

  // Rendering problems (overflowing text, missing components/variables/icons/fonts, clipped children).
  for (const line of await checkLayout(rootKey)) {
    const m = /^(error|warning|info): (.*)$/s.exec(line);
    const key = /#([^\s)"]+)/.exec(line)?.[1];
    issues.push({ severity: (m?.[1] as LintIssue['severity']) ?? 'warning', rule: 'layout', message: m?.[2] ?? line, key: key && tree.byKey.has(key) ? key : undefined });
  }
  const order = { error: 0, warning: 1, info: 2 };
  return issues.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, 300);
}
