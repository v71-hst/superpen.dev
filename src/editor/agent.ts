// Handles MCP requests forwarded by the extension: reads, atomic edits, screenshots, layout checks, exports.
import { useStore } from './store';
import { rasterize } from '../render/rasterize';
import { recentLog, uiSnapshot } from './diagnostics';
import { currentTree } from './tree';
import { elFor, insertSvg, vectorizeNode, zoomToKeys } from './ops';
import { ensureRendered } from './culling';
import { flushEdits } from './host';
import { applyOperations, describe, nodeJson, outline, searchNodes, type Operation } from '../model/operations';
import { defaultTheme, isVarRef } from '../model/resolve';
import { displayName } from '../model/doc';
import type { RNode } from '../model/types';

const frames = (n = 2) => new Promise<void>(r => { const step = (k: number) => (k <= 0 ? r() : requestAnimationFrame(() => step(k - 1))); step(n); });

function requireNode(key: string): RNode {
  const n = currentTree()?.byKey.get(key);
  if (!n) throw new Error(`node "${key}" not found. Use search_nodes or get_tree to find ids.`);
  return n;
}

function rootOf(key: string): string {
  const tree = currentTree()!;
  let k = key;
  let p = tree.parent.get(k);
  while (p) {
    k = p.key;
    p = tree.parent.get(k);
  }
  return k;
}

async function capture(key: string, format: 'png' | 'jpg' | 'svg', scale: number, maxSize: number) {
  ensureRendered([key]);
  await frames(3);
  await document.fonts.ready;
  const el = elFor(key);
  if (!el) throw new Error(`node "${key}" is not rendered (it may be hidden: enabled false)`);
  const w = el.offsetWidth || el.getBoundingClientRect().width;
  const h = el.offsetHeight || el.getBoundingClientRect().height;
  const ratio = Math.max(0.05, Math.min(scale, maxSize / Math.max(w, h, 1)));
  return rasterize(el, { format, pixelRatio: ratio });
}

function flash(keys: string[]) {
  const t = performance.now();
  useStore.setState(s => ({ flashes: [...s.flashes.filter(f => t - f.t < 1400), ...keys.map(key => ({ key, t }))] }));
}

function cleanHtml(el: HTMLElement) {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.style.left = '0px';
  clone.style.top = '0px';
  clone.style.position = 'relative';
  clone.querySelectorAll('[data-k]').forEach(x => x.removeAttribute('data-k'));
  clone.removeAttribute('data-k');
  const fonts = [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet][href*="fonts.googleapis"]')].map(l => `<link rel="stylesheet" href="${l.href}">`).join('\n');
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n${fonts}\n</head>\n<body style="margin:0">\n${clone.outerHTML}\n</body>\n</html>\n`;
}

/** Visual/layout problems an agent should know about. */
async function checkLayout(rootKey?: string): Promise<string[]> {
  const s = useStore.getState();
  const tree = currentTree()!;
  const roots = rootKey ? [requireNode(rootKey)] : tree.roots;
  ensureRendered(roots.map(r => r.key));
  await frames(3);
  await document.fonts.ready;
  const issues: string[] = [];
  const vars = s.doc?.variables ?? {};
  const fontsUsed = new Set<string>();
  const label = (n: RNode) => `${n.type} ${JSON.stringify(displayName(n.props))} #${n.key}`;
  const visit = (n: RNode) => {
    const p = n.props;
    if (p.enabled === false) return;
    if (n.type === 'missing_ref') issues.push(`error: ${label(n)} references a component that does not exist (ref: ${p.ref})`);
    for (const [k, v] of Object.entries(p)) {
      if (k === 'children' || k === 'descendants') continue;
      const scan = (x: any) => {
        if (isVarRef(x) && !(x.slice(1) in vars)) issues.push(`error: ${label(n)} uses undefined variable ${x} in "${k}"`);
        else if (Array.isArray(x)) x.forEach(scan);
        else if (x && typeof x === 'object') Object.values(x).forEach(scan);
      };
      scan(v);
    }
    if (typeof p.fontFamily === 'string' && !p.fontFamily.startsWith('$')) fontsUsed.add(p.fontFamily);
    const el = elFor(n.key);
    if (el) {
      const r = el.getBoundingClientRect();
      if (n.type === 'text' && p.textGrowth === 'fixed-width-height' && el.scrollHeight > el.clientHeight + 1) issues.push(`warning: ${label(n)} text overflows its fixed-height box (${el.scrollHeight}px of content in ${el.clientHeight}px)`);
      if (n.type === 'text' && p.textGrowth === 'fixed-width' && el.scrollWidth > el.clientWidth + 1) issues.push(`warning: ${label(n)} has a word wider than its fixed width`);
      if ((n.type === 'icon' || n.type === 'icon_font') && el.querySelector('[data-missing]')) issues.push(`error: ${label(n)} icon "${p.icon ?? p.iconFontName}" not found in library "${p.library ?? p.iconFontFamily ?? 'lucide'}"`);
      if ((r.width < 0.5 || r.height < 0.5) && n.type !== 'group' && n.type !== 'line' && n.type !== 'path') issues.push(`warning: ${label(n)} has zero size`);
      if (p.clip === true && n.children.length) {
        for (const c of n.children) {
          if (c.props.enabled === false) continue;
          const cr = elFor(c.key)?.getBoundingClientRect();
          if (!cr || (!cr.width && !cr.height)) continue;
          const outside = cr.left < r.left - 0.5 || cr.top < r.top - 0.5 || cr.right > r.right + 0.5 || cr.bottom > r.bottom + 0.5;
          const fully = cr.right <= r.left || cr.left >= r.right || cr.bottom <= r.top || cr.top >= r.bottom;
          if (fully) issues.push(`warning: ${label(c)} is completely hidden outside its clipping parent ${label(n)}`);
          else if (outside) issues.push(`info: ${label(c)} is partly clipped by ${label(n)}`);
        }
      }
      // Overlapping text in freeform (layout: none) containers is usually a mistake.
      if (n.type === 'frame' && p.layout === 'none') {
        const texts = n.children.filter(c => c.type === 'text' && c.props.enabled !== false).map(c => ({ c, r: elFor(c.key)?.getBoundingClientRect() })).filter(x => x.r && x.r.width && x.r.height);
        for (let a = 0; a < texts.length; a++)
          for (let b = a + 1; b < texts.length; b++) {
            const A = texts[a].r!, B = texts[b].r!;
            const ix = Math.min(A.right, B.right) - Math.max(A.left, B.left);
            const iy = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
            if (ix > 2 && iy > 2) issues.push(`warning: texts ${label(texts[a].c)} and ${label(texts[b].c)} overlap`);
          }
      }
    }
    n.children.forEach(visit);
  };
  roots.forEach(visit);
  // Script and shader errors are rendered as markers inside the affected node.
  for (const r of roots) {
    elFor(r.key)?.querySelectorAll<HTMLElement>('[data-asset-error]').forEach(m => {
      const owner = m.parentElement?.closest<HTMLElement>('[data-k]');
      const k = owner?.dataset.k ?? r.key;
      const n = tree.byKey.get(k);
      issues.push(`error: ${n ? label(n) : '#' + k}: ${m.dataset.assetError}`);
    });
  }
  for (const f of fontsUsed) if (!document.fonts.check(`16px "${f}"`)) issues.push(`warning: font "${f}" did not load (check the family name on fonts.google.com)`);
  return issues.slice(0, 200);
}

export async function handleAgentRequest(method: string, params: any): Promise<any> {
  const s = useStore.getState();
  const doc = s.doc;
  const tree = currentTree();
  if (!doc || !tree) throw new Error('document is not loaded yet');
  switch (method) {
    case 'summary': {
      const comps = [...tree.byKey.values()].filter(n => n.isComponent && !n.inInstance);
      return {
        file: s.file?.name,
        version: doc.version,
        topLevel: tree.roots.map(describe),
        nodeCount: tree.byKey.size,
        components: comps.length,
        variables: Object.keys(doc.variables ?? {}).length,
        themes: doc.themes ?? {},
        selection: s.selection.map(k => (tree.byKey.get(k) ? describe(tree.byKey.get(k)!) : k)),
      };
    }
    case 'tree': {
      const roots = params.root_id ? [requireNode(params.root_id)] : tree.roots;
      return outline(roots, Math.max(1, params.depth ?? 3), !!params.expand_instances) || '(empty document)';
    }
    case 'nodes':
      return (params.ids ?? []).map((id: string) => nodeJson(doc, tree, id, params.depth ?? 1) ?? { id, error: 'not found' });
    case 'search':
      return searchNodes(tree, params.query ?? '', params.type, params.limit ?? 50, params.root_id);
    case 'applyOps': {
      let out: ReturnType<typeof applyOperations> | null = null;
      s.edit(d => {
        out = applyOperations(d, params.operations as Operation[]);
      });
      flushEdits();
      const r = out as ReturnType<typeof applyOperations> | null;
      if (r) requestAnimationFrame(() => flash(r.touched));
      return r?.results ?? [];
    }
    case 'getVariables':
      return { variables: doc.variables ?? {}, themes: doc.themes ?? {}, activeTheme: { ...defaultTheme(doc), ...(s.previewTheme ?? {}) } };
    case 'setVariables': {
      s.edit(d => {
        if (params.replace) d.variables = {};
        d.variables ??= {};
        for (const [k, v] of Object.entries(params.variables ?? {})) {
          if (v === null) delete d.variables[k];
          else d.variables[k] = v as any;
        }
        if (params.themes) d.themes = params.themes;
      });
      flushEdits();
      return { ok: true, count: Object.keys(useStore.getState().doc?.variables ?? {}).length };
    }
    case 'components':
      return [...tree.byKey.values()].filter(n => n.isComponent && !n.inInstance).map(n => {
        const inst = [...tree.byKey.values()].filter(x => x.instanceOf === n.key).length;
        return `${describe(n)} — ${inst} instance(s)`;
      });
    case 'selection':
      return s.selection.map(k => {
        const n = tree.byKey.get(k);
        return n ? { id: k, summary: describe(n), node: nodeJson(doc, tree, k, 1) } : { id: k };
      });
    case 'setSelection': {
      const ids: string[] = (params.ids ?? []).filter((k: string) => tree.byKey.has(k));
      s.select(ids);
      // Agents never move the user's viewport unless they explicitly ask to.
      if (params.zoom === true && ids.length) zoomToKeys(ids, 2);
      return { selected: ids };
    }
    case 'screenshot': {
      const key = params.id ?? s.selection[0];
      if (!key) throw new Error(`pass "id" (or select something in the editor). Top-level frames: ${tree.roots.map(r => `#${r.key} ${JSON.stringify(displayName(r.props))}`).join(', ')}`);
      requireNode(key);
      const shot = await capture(key, 'png', params.scale ?? 1, params.max_size ?? 1280);
      return { ...shot, dataUrl: shot.dataUrl };
    }
    case 'checkLayout':
      return checkLayout(params.id);
    case 'exportNode': {
      const n = requireNode(params.id);
      const name = displayName(n.props).replace(/[\\/:*?"<>|]+/g, '_');
      const format = params.format ?? 'png';
      if (format === 'html') {
        ensureRendered([n.key]);
        await frames(2);
        const el = elFor(n.key);
        if (!el) throw new Error('node is not rendered');
        return { name: `${name}.html`, dataUrl: 'data:text/html;charset=utf-8,' + encodeURIComponent(cleanHtml(el)) };
      }
      const shot = await capture(n.key, format, params.scale ?? 2, 16384);
      return { name: `${name}.${format}`, dataUrl: shot.dataUrl };
    }
    case 'insertSvg': {
      const r = insertSvg(String(params.svg ?? ''), { parent: params.parent ?? null, index: params.index, x: params.x, y: params.y, width: params.width, height: params.height, name: params.name });
      flushEdits();
      requestAnimationFrame(() => flash([r.id]));
      return r;
    }
    case 'vectorize': {
      const r = await vectorizeNode(String(params.id), { colors: params.colors, detail: params.detail });
      flushEdits();
      requestAnimationFrame(() => flash([r.id]));
      return r;
    }
    case 'diagnose':
      return { ui: uiSnapshot(), log: recentLog() };
    case 'root':
      return rootOf(params.id);
    default:
      throw new Error(`unknown method ${method}`);
  }
}
