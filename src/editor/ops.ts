// Editing commands shared by keyboard shortcuts, menus, panels and canvas gestures.
import type { PenDoc, PenNode } from '../model/types';
import { htmlToNodes, looksLikeHtml } from '../import/html';
import { figmaClipboard, importFigFile, importFigmaClipboard, isFigFile, type FigmaImport } from '../import/figma';
import { inVsCode, request } from './host';
import { removeBackground, type RemoveBgOptions } from './removeBg';
import { SOFT } from '../render/pixels';
import { saveAsset } from './fileio';
import { canvasHiddenIds } from './sections';
import { allIds, cloneWithNewIds, locate, newId } from '../model/doc';
import { materializeRef } from '../model/resolve';
import { applyProps, keySource, useStore } from './store';
import { builderIndex, currentTree } from './tree';
import { parseSizing } from '../model/props';
import { viewChangeSource } from './diagnostics';
import { svgToNodes, looksLikeSvg } from '../model/svgImport';
import { vectorizeImage, type VectorizeOptions } from '../render/vectorize';
import { makeUrlResolver } from './fileio';

// ---------- DOM geometry ----------

// Geometry lives in measure.ts (one seam for the DOM and, later, the Skia layout tree); these names stay for callers.
import { canvasRect, clientToWorld, nodeEl as elFor, nodeRect as worldRectOf, nodeScreenRect as screenRectOf } from './measure';
export { canvasRect, clientToWorld, elFor, screenRectOf, worldRectOf };

// ---------- tree queries ----------

export function parentLayoutOf(key: string): 'none' | 'horizontal' | 'vertical' {
  const tree = currentTree();
  const parent = tree?.parent.get(key);
  if (!parent) return 'none';
  if (parent.type === 'frame') {
    const l = parent.props.layout;
    return l === 'none' || l === 'vertical' ? l : 'horizontal';
  }
  return 'none';
}

export function isAbsolutelyPositioned(key: string): boolean {
  const tree = currentTree();
  const n = tree?.byKey.get(key);
  if (!n) return false;
  return parentLayoutOf(key) === 'none' || n.props.layoutPosition === 'absolute';
}

function realParentId(key: string): string | null {
  const tree = currentTree();
  const p = tree?.parent.get(key);
  return p ? p.key : null;
}

// ---------- mutations ----------

export function insertNode(node: PenNode, parentKey: string | null, index?: number) {
  useStore.getState().edit(d => {
    const list = parentKey && keySource(parentKey).kind === 'real' ? (locate(d, parentKey)?.node.children ?? (locate(d, parentKey)!.node.children = [])) : d.children;
    if (index === undefined || index < 0 || index > list.length) list.push(node);
    else list.splice(index, 0, node);
  });
  useStore.getState().select([node.id]);
}

export function deleteSelection() {
  const { selection } = useStore.getState();
  if (!selection.length) return;
  useStore.getState().edit(d => {
    for (const key of selection) {
      const src = keySource(key);
      if (src.kind === 'real') {
        const loc = locate(d, src.id);
        if (loc) loc.siblings.splice(loc.index, 1);
      } else {
        applyProps(d, key, { enabled: false });
      }
    }
  });
  useStore.getState().select([]);
}

function topLevelOffset(node: PenNode, d: PenDoc) {
  const loc = locate(d, node.id);
  if (loc && !loc.parent && typeof node.x === 'number') {
    const w = parseSizing(node.width);
    return { x: node.x + (w.mode === 'fixed' ? w.px : 100) + 40, y: node.y ?? 0 };
  }
  return null;
}

export function duplicateSelection() {
  const { selection, doc } = useStore.getState();
  if (!doc) return;
  const keys = selection.filter(k => keySource(k).kind === 'real');
  if (!keys.length) return;
  const created: string[] = [];
  useStore.getState().edit(d => {
    const ids = allIds(d);
    for (const key of keys) {
      const loc = locate(d, key);
      if (!loc) continue;
      const copy = cloneWithNewIds(loc.node, ids);
      const off = topLevelOffset(loc.node, d);
      if (off) Object.assign(copy, off);
      loc.siblings.splice(loc.index + 1, 0, copy);
      created.push(copy.id);
    }
  });
  useStore.getState().select(created);
}

/** Plain node trees for the selection (instance children are materialized). */
function selectionAsNodes(): PenNode[] {
  const { selection, doc } = useStore.getState();
  const tree = currentTree();
  if (!doc || !tree) return [];
  const out: PenNode[] = [];
  for (const key of selection) {
    const src = keySource(key);
    if (src.kind === 'real') {
      const loc = locate(doc, src.id);
      if (loc) out.push(JSON.parse(JSON.stringify(loc.node)));
    } else {
      const n = tree.byKey.get(key);
      if (n) out.push(JSON.parse(JSON.stringify(n.props)));
    }
  }
  return out;
}

export async function copySelection(cut = false) {
  const nodes = selectionAsNodes();
  if (!nodes.length) return;
  useStore.setState({ clipboard: nodes });
  try {
    await navigator.clipboard.writeText(JSON.stringify({ penNodes: nodes }));
  } catch {
    /* clipboard permission denied: internal clipboard still works */
  }
  if (cut) deleteSelection();
}

export async function paste() {
  let nodes = useStore.getState().clipboard;
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch {
    /* clipboard not readable */
  }
  // Layers copied in Figma arrive as HTML with Figma's data inside.
  let html = '';
  try {
    for (const item of await navigator.clipboard.read()) if (item.types.includes('text/html')) html = await (await item.getType('text/html')).text();
  } catch {
    /* no HTML on the clipboard, or it is not readable */
  }
  if (html && figmaClipboard(html)) {
    const notify = useStore.getState().notify;
    try {
      const sel = useStore.getState().selection[0];
      const picked = sel ? currentTree()?.byKey.get(sel) : undefined;
      const target = sel && picked?.type === 'frame' && !picked.instanceOf && keySource(sel).kind === 'real' ? sel : null;
      const r = await importFigma({ html }, { where: target ? { parent: target } : 'view' });
      useStore.getState().select(r.ids);
      notify(figmaSummary(r));
    } catch (e) {
      notify(`Could not paste from Figma: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }
  // Pasted SVG markup becomes editable vectors.
  if (looksLikeSvg(text)) {
    try {
      const sel = useStore.getState().selection[0];
      const target = sel && currentTree()?.byKey.get(sel)?.type === 'frame' && keySource(sel).kind === 'real' ? sel : null;
      const r = insertSvg(text, { parent: target });
      useStore.getState().notify(`Pasted SVG as ${r.paths} vector path${r.paths === 1 ? '' : 's'}${r.skipped.length ? ` (skipped ${r.skipped.join(', ')})` : ''}`);
    } catch (e) {
      useStore.getState().notify(`Could not paste SVG: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }
  // Pasted HTML markup becomes editable layers.
  if (looksLikeHtml(text)) {
    const notify = useStore.getState().notify;
    notify('Importing the pasted HTML…');
    try {
      const r = await importHtml({ html: text });
      useStore.getState().select([r.id]);
      zoomToKeys([r.id]);
      notify(`Imported ${r.layers} layers from HTML${r.warnings.length ? ` (left out: ${r.warnings.join('; ')})` : ''}`);
    } catch (e) {
      notify(`Could not import the HTML: ${e instanceof Error ? e.message : e}`);
    }
    return;
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed?.penNodes) nodes = parsed.penNodes;
  } catch {
    /* not pen data */
  }
  if (!nodes?.length) return;
  const { selection } = useStore.getState();
  const tree = currentTree();
  let parentKey: string | null = null;
  const sel = selection[0];
  if (sel && keySource(sel).kind === 'real') {
    const n = tree?.byKey.get(sel);
    if (n && n.type === 'frame' && !n.instanceOf) parentKey = sel;
    else parentKey = realParentId(sel);
  }
  const created: string[] = [];
  useStore.getState().edit(d => {
    const ids = allIds(d);
    const list = parentKey ? (locate(d, parentKey)!.node.children ??= []) : d.children;
    for (const n of nodes!) {
      const copy = cloneWithNewIds(n, ids);
      list.push(copy);
      created.push(copy.id);
    }
  });
  useStore.getState().select(created);
}

export function groupSelection(asFrame = false) {
  const { selection } = useStore.getState();
  const keys = selection.filter(k => keySource(k).kind === 'real');
  if (!keys.length) return;
  const parents = new Set(keys.map(k => realParentId(k)));
  if (parents.size !== 1) return useStore.getState().notify('Select layers with the same parent to group');
  const parentKey = [...parents][0];
  const rects = keys.map(k => worldRectOf(k)).filter(Boolean) as { x: number; y: number; w: number; h: number }[];
  const parentRect = parentKey ? worldRectOf(parentKey) : { x: 0, y: 0, w: 0, h: 0 };
  if (!rects.length || !parentRect) return;
  const x0 = Math.min(...rects.map(r => r.x));
  const y0 = Math.min(...rects.map(r => r.y));
  const x1 = Math.max(...rects.map(r => r.x + r.w));
  const y1 = Math.max(...rects.map(r => r.y + r.h));
  const absolute = keys.every(k => isAbsolutelyPositioned(k));
  let gid = '';
  useStore.getState().edit(d => {
    gid = newId(allIds(d));
    const locs = keys.map(k => locate(d, k)!).filter(Boolean).sort((a, b) => a.index - b.index);
    const siblings = locs[0].siblings;
    const insertAt = locs[locs.length - 1].index - (locs.length - 1);
    const moved = locs.map(l => l.node);
    for (const l of [...locs].reverse()) siblings.splice(l.index, 1);
    const gx = Math.round(x0 - parentRect.x);
    const gy = Math.round(y0 - parentRect.y);
    for (const m of moved) {
      if (absolute) {
        m.x = Math.round(((m.x ?? 0) as number) - gx);
        m.y = Math.round(((m.y ?? 0) as number) - gy);
      }
    }
    const g: PenNode = asFrame
      ? { type: 'frame', id: gid, x: gx, y: gy, name: 'Frame', width: Math.round(x1 - x0), height: Math.round(y1 - y0), layout: 'none', children: moved }
      : { type: 'group', id: gid, x: gx, y: gy, name: 'Group', children: moved };
    siblings.splice(insertAt, 0, g);
  });
  useStore.getState().select([gid]);
}

export function ungroupSelection() {
  const { selection } = useStore.getState();
  const key = selection[0];
  if (!key || keySource(key).kind !== 'real') return;
  const created: string[] = [];
  useStore.getState().edit(d => {
    const loc = locate(d, key);
    if (!loc || !(loc.node.type === 'group' || loc.node.type === 'frame') || !loc.node.children?.length) return;
    const g = loc.node;
    const kids = g.children!;
    for (const c of kids) {
      if (typeof c.x === 'number') c.x = c.x + (g.x ?? 0);
      if (typeof c.y === 'number') c.y = c.y + (g.y ?? 0);
      created.push(c.id);
    }
    loc.siblings.splice(loc.index, 1, ...kids);
  });
  if (created.length) useStore.getState().select(created);
}

export function toggleComponent() {
  const { selection } = useStore.getState();
  for (const key of selection) {
    if (keySource(key).kind !== 'real') continue;
    const n = currentTree()?.byKey.get(key);
    useStore.getState().edit(d => applyProps(d, key, { reusable: n?.isComponent ? undefined : true }));
  }
}

export function detachInstance(key: string) {
  const { doc } = useStore.getState();
  if (!doc || keySource(key).kind !== 'real') return;
  useStore.getState().edit(d => {
    const loc = locate(d, key);
    if (!loc || loc.node.type !== 'ref') return;
    const tree = materializeRef(loc.node, builderIndex());
    if (!tree) return;
    const ids = allIds(d);
    const deep = (n: PenNode): PenNode => {
      if (n.type === 'ref') {
        const m = materializeRef(n, builderIndex());
        return m ? deep(m) : n;
      }
      return n.children ? { ...n, children: n.children.map(deep) } : n;
    };
    const copy = cloneWithNewIds(deep(tree), ids);
    copy.id = loc.node.id;
    loc.siblings.splice(loc.index, 1, copy);
  });
}

export function goToComponent(key: string) {
  const n = currentTree()?.byKey.get(key);
  if (!n?.instanceOf) return;
  useStore.getState().select([n.instanceOf]);
  zoomToKeys([n.instanceOf]);
}

export function reorder(dir: 'forward' | 'backward' | 'front' | 'back') {
  const { selection } = useStore.getState();
  useStore.getState().edit(d => {
    for (const key of selection) {
      if (keySource(key).kind !== 'real') continue;
      const loc = locate(d, key);
      if (!loc) continue;
      const { siblings, index } = loc;
      const target = dir === 'forward' ? index + 1 : dir === 'backward' ? index - 1 : dir === 'front' ? siblings.length - 1 : 0;
      if (target < 0 || target >= siblings.length || target === index) continue;
      const [n] = siblings.splice(index, 1);
      siblings.splice(target, 0, n);
    }
  });
}

/** Moves a real node to another parent/index, converting its position into the new parent's space. */
export function moveNode(d: PenDoc, id: string, newParentId: string | null, index: number, worldPos?: { x: number; y: number }, parentWorld?: { x: number; y: number }) {
  const loc = locate(d, id);
  if (!loc) return;
  const [node] = loc.siblings.splice(loc.index, 1);
  const list = newParentId ? (locate(d, newParentId)!.node.children ??= []) : d.children;
  if (worldPos) {
    node.x = Math.round(worldPos.x - (parentWorld?.x ?? 0));
    node.y = Math.round(worldPos.y - (parentWorld?.y ?? 0));
  }
  const i = Math.max(0, Math.min(index, list.length));
  list.splice(i, 0, node);
}

export function nudge(dx: number, dy: number) {
  const { selection } = useStore.getState();
  const tree = currentTree();
  useStore.getState().edit(d => {
    for (const key of selection) {
      if (!isAbsolutelyPositioned(key)) continue;
      const n = tree?.byKey.get(key);
      if (!n) continue;
      applyProps(d, key, { x: Math.round(((n.props.x ?? 0) + dx) * 100) / 100, y: Math.round(((n.props.y ?? 0) + dy) * 100) / 100 });
    }
  }, 'nudge');
}

export function align(mode: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom') {
  const { selection } = useStore.getState();
  const keys = selection.filter(isAbsolutelyPositioned);
  if (!keys.length) return;
  const rects = keys.map(k => [k, worldRectOf(k)] as const).filter(([, r]) => r) as [string, { x: number; y: number; w: number; h: number }][];
  let bounds: { x: number; y: number; w: number; h: number } | null;
  if (rects.length === 1) {
    const p = realParentId(rects[0][0]);
    bounds = p ? worldRectOf(p) : null;
    if (!bounds) return;
  } else {
    const x0 = Math.min(...rects.map(([, r]) => r.x));
    const y0 = Math.min(...rects.map(([, r]) => r.y));
    bounds = { x: x0, y: y0, w: Math.max(...rects.map(([, r]) => r.x + r.w)) - x0, h: Math.max(...rects.map(([, r]) => r.y + r.h)) - y0 };
  }
  const tree = currentTree();
  useStore.getState().edit(d => {
    for (const [key, r] of rects) {
      const n = tree?.byKey.get(key);
      if (!n) continue;
      let dx = 0, dy = 0;
      if (mode === 'left') dx = bounds!.x - r.x;
      if (mode === 'hcenter') dx = bounds!.x + bounds!.w / 2 - (r.x + r.w / 2);
      if (mode === 'right') dx = bounds!.x + bounds!.w - (r.x + r.w);
      if (mode === 'top') dy = bounds!.y - r.y;
      if (mode === 'vcenter') dy = bounds!.y + bounds!.h / 2 - (r.y + r.h / 2);
      if (mode === 'bottom') dy = bounds!.y + bounds!.h - (r.y + r.h);
      applyProps(d, key, { x: Math.round((n.props.x ?? 0) + dx), y: Math.round((n.props.y ?? 0) + dy) });
    }
  });
}

export function selectAll() {
  const { selection } = useStore.getState();
  const tree = currentTree();
  if (!tree) return;
  const parent = selection[0] ? tree.parent.get(selection[0]) : null;
  const list = parent ? parent.children : tree.roots;
  useStore.getState().select(list.map(n => n.key));
}

// ---------- SVG import & vectorize ----------

export type InsertSvgOptions = {
  parent?: string | null;
  index?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
  /** Extra properties stored on the new frame (e.g. AI Pen's prompt). */
  meta?: Record<string, unknown>;
  /** Replace this node (same parent and position in the layer list) in the same undo step. */
  replace?: string;
};

/** Converts SVG markup to editable vector nodes and inserts them as a frame. Returns the new frame id. */
export function insertSvg(markup: string, opts: InsertSvgOptions = {}): { id: string; paths: number; skipped: string[] } {
  const { node, paths, skipped } = svgToNodes(markup, { width: opts.width, height: opts.height, name: opts.name });
  if (!paths) throw new Error('the SVG has no drawable shapes (paths, rects, circles, polygons…)' + (skipped.length ? `; skipped: ${skipped.join(', ')}` : ''));
  const s = useStore.getState();
  let id = '';
  s.edit(d => {
    const copy = cloneWithNewIds(node, allIds(d));
    id = copy.id;
    if (opts.meta) Object.assign(copy, opts.meta);
    if (opts.replace) {
      const old = locate(d, opts.replace);
      if (old) {
        const at = old.siblings.indexOf(old.node);
        old.siblings.splice(at, 1);
        if (opts.index === undefined) opts = { ...opts, index: at };
      }
    }
    let parent = opts.parent ?? null;
    if (parent && keySource(parent).kind !== 'real') parent = null;
    const loc = parent ? locate(d, parent) : null;
    if (parent && !loc) throw new Error(`parent "${parent}" not found`);
    const list = loc ? (loc.node.children ??= []) : d.children;
    if (opts.x !== undefined || opts.y !== undefined || !loc) {
      const c = clientToWorld(innerWidth / 2, innerHeight / 2);
      copy.x = Math.round(opts.x ?? (loc ? 0 : c.x - copy.width / 2));
      copy.y = Math.round(opts.y ?? (loc ? 0 : c.y - copy.height / 2));
    } else {
      copy.x = 0;
      copy.y = 0;
    }
    if (opts.index === undefined || opts.index < 0 || opts.index >= list.length) list.push(copy);
    else list.splice(opts.index, 0, copy);
  });
  s.select([id]);
  return { id, paths, skipped };
}

/** Traces a node's image fill into vector paths, placed in a new frame beside it. */
export async function vectorizeNode(key: string, opts: VectorizeOptions = {}): Promise<{ id: string; paths: number }> {
  const tree = currentTree();
  const n = tree?.byKey.get(key);
  if (!n) throw new Error(`node "${key}" not found`);
  const fills = Array.isArray(n.props.fill) ? n.props.fill : [n.props.fill];
  const img = [...fills].reverse().find((f: any) => f && typeof f === 'object' && f.type === 'image' && f.url);
  if (!img) throw new Error('that node has no image fill to vectorize');
  const s = useStore.getState();
  const url = makeUrlResolver(s.file?.path ?? null)(img.url);
  const traced = await vectorizeImage(url, opts);
  const wr = worldRectOf(key);
  const w = typeof n.props.width === 'number' ? n.props.width : (wr?.w ?? traced.width);
  const h = typeof n.props.height === 'number' ? n.props.height : (wr?.h ?? traced.height);
  const parent = keySource(key).kind === 'real' ? (tree?.parent.get(key)?.key ?? null) : null;
  const parentLayout = parent ? parentLayoutOf(key) : 'none';
  const r = insertSvg(traced.svg, {
    parent,
    x: parentLayout === 'none' ? (n.props.x ?? 0) + w + 40 : undefined,
    y: parentLayout === 'none' ? (n.props.y ?? 0) : undefined,
    width: w,
    height: h,
    name: `${n.props.name ?? 'Image'} (vector)`,
  });
  return { id: r.id, paths: r.paths };
}

/**
 * Removes the background of a node's image fill (editor/removeBg.ts: plain or gently graded backgrounds, no model).
 * The result is saved as a new PNG next to the design and the fill is pointed at it; the original file is kept.
 */
export async function removeBackgroundOf(key: string, opts: RemoveBgOptions & { index?: number } = {}): Promise<{ url: string; removed: number; background: number[]; tolerance: number; note?: string }> {
  const tree = currentTree();
  const n = tree?.byKey.get(key);
  if (!n) throw new Error(`node "${key}" not found`);
  const isList = Array.isArray(n.props.fill);
  const fills: any[] = isList ? n.props.fill : [n.props.fill];
  const isImg = (f: any) => !!f && typeof f === 'object' && f.type === 'image' && !!f.url;
  const index = opts.index !== undefined && isImg(fills[opts.index]) ? opts.index : fills.map(isImg).lastIndexOf(true);
  if (index < 0) throw new Error('that node has no image fill');
  const fill = fills[index];
  const s = useStore.getState();
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = makeUrlResolver(s.file?.path ?? null)(fill.url);
  await img.decode().catch(() => {
    throw new Error('the picture could not be loaded');
  });
  // Work on the picture's own pixels, up to 4096 on the long side.
  const k = Math.min(1, 4096 / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * k));
  c.height = Math.max(1, Math.round(img.naturalHeight * k));
  const g = c.getContext('2d', SOFT)!;
  g.drawImage(img, 0, 0, c.width, c.height);
  const r = removeBackground(g.getImageData(0, 0, c.width, c.height), opts);
  // Every note is a reason the result should not be used (not plain, nothing removed, nothing left, already transparent).
  if (r.note || r.removed < 0.01 || r.borderShare < 0.35) throw new Error(r.note ?? 'the background could not be told from the subject');
  g.putImageData(r.image, 0, 0);
  const blob = await new Promise<Blob | null>(res => c.toBlob(res, 'image/png'));
  if (!blob) throw new Error('the result could not be saved');
  const base = (String(fill.url).startsWith('data:') ? 'picture' : String(fill.url).split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, '')).replace(/[^A-Za-z0-9_-]+/g, '-') || 'picture';
  const url = await saveAsset(`images/${base}-nobg-${Date.now().toString(36).slice(-4)}.png`, blob);
  const next = { ...fill, url };
  useStore.getState().edit(d => applyProps(d, key, { fill: isList ? fills.map((f, i) => (i === index ? next : f)) : next }));
  return { url: url.startsWith('data:') ? '(embedded)' : url, removed: r.removed, background: r.background, tolerance: r.tolerance, note: r.note };
}

/**
 * HTML import (import/html.ts): markup, or a web address that is fetched outside the webview, becomes a top-level
 * frame of editable layers placed to the right of what the design already has.
 */
export async function importHtml(source: { html?: string; url?: string }, opts: { width?: number; name?: string } = {}): Promise<{ id: string; layers: number; warnings: string[] }> {
  let html = source.html ?? '';
  let extra: { baseUrl?: string; styles?: Record<string, string> } = {};
  if (source.url) {
    const page: any = inVsCode
      ? await request('fetchPage', { url: source.url })
      : await fetch(`/api/fetch-page?url=${encodeURIComponent(source.url)}`)
          .then(r => r.json())
          .catch(() => ({ error: 'the page could not be fetched from here' }));
    if (!page || page.error || !page.html) throw new Error(page?.error ?? 'the page could not be fetched');
    html = page.html;
    extra = { baseUrl: page.baseUrl, styles: page.styles };
  }
  if (!html.trim()) throw new Error('there is no HTML to import');
  const made = await htmlToNodes(html, { ...opts, ...extra });
  if (!made.node.children?.length) throw new Error('nothing visible was found in that HTML');
  const s = useStore.getState();
  let id = '';
  s.edit(d => {
    const copy = cloneWithNewIds(made.node, allIds(d));
    id = copy.id;
    // To the right of everything that has a place on the canvas.
    let right = -Infinity, top = Infinity;
    for (const n of d.children) {
      if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
      right = Math.max(right, n.x + (typeof n.width === 'number' ? n.width : 0));
      top = Math.min(top, n.y);
    }
    copy.x = isFinite(right) ? Math.round(right + 120) : 0;
    copy.y = isFinite(top) ? Math.round(top) : 0;
    d.children.push(copy);
  });
  return { id, layers: made.count, warnings: made.warnings };
}

/** Layers in a list of nodes, counting everything inside them. */
function countLayers(nodes: PenNode[]): number {
  let n = 0;
  const walk = (x: PenNode) => {
    n++;
    x.children?.forEach(walk);
  };
  nodes.forEach(walk);
  return n;
}

/**
 * Adds nodes made elsewhere (an import) to the design in one undo step, keeping their places relative to each other:
 * "right" puts them beside everything the design already has, "view" in the middle of what the user is looking at,
 * and a frame id puts them inside that frame. Ids are made new, so importing the same thing twice is fine.
 */
export function insertImported(nodes: PenNode[], where: 'right' | 'view' | { parent: string } = 'right'): string[] {
  if (!nodes.length) return [];
  const xy = (n: PenNode) => ({ x: typeof n.x === 'number' ? n.x : 0, y: typeof n.y === 'number' ? n.y : 0, w: typeof n.width === 'number' ? n.width : 0, h: typeof n.height === 'number' ? n.height : 0 });
  const boxes = nodes.map(xy);
  const left = Math.min(...boxes.map(b => b.x)), top = Math.min(...boxes.map(b => b.y));
  const right = Math.max(...boxes.map(b => b.x + b.w)), bottom = Math.max(...boxes.map(b => b.y + b.h));
  const ids: string[] = [];
  const centre = clientToWorld(innerWidth / 2, innerHeight / 2);
  useStore.getState().edit(d => {
    const loc = typeof where === 'object' && keySource(where.parent).kind === 'real' ? locate(d, where.parent) : null;
    let dx = -left, dy = -top;
    if (!loc && where === 'view') {
      dx += Math.round(centre.x - (right - left) / 2);
      dy += Math.round(centre.y - (bottom - top) / 2);
    } else if (!loc) {
      let r = -Infinity, t = Infinity;
      for (const n of d.children) {
        if (typeof n.x !== 'number' || typeof n.y !== 'number') continue;
        r = Math.max(r, n.x + (typeof n.width === 'number' ? n.width : 0));
        t = Math.min(t, n.y);
      }
      dx += isFinite(r) ? Math.round(r + 120) : 0;
      dy += isFinite(t) ? Math.round(t) : 0;
    }
    const list = loc ? (loc.node.children ??= []) : d.children;
    const taken = allIds(d);
    for (const n of nodes) {
      const copy = cloneWithNewIds(n, taken);
      const b = xy(n);
      copy.x = Math.round((b.x + dx) * 100) / 100;
      copy.y = Math.round((b.y + dy) * 100) / 100;
      list.push(copy);
      ids.push(copy.id);
    }
  });
  return ids;
}

export type FigmaResult = { ids: string[]; layers: number; images: number; page?: string; pages: FigmaImport['pages']; warnings: string[] };

/** What is in a .fig file: its pages, and how many layers each has at the top. */
export async function figmaPages(bytes: Uint8Array): Promise<{ pages: FigmaImport['pages']; page?: string }> {
  if (!isFigFile(bytes)) throw new Error('that is not a Figma file (.fig)');
  const r = await importFigFile(bytes);
  return { pages: r.pages, page: r.page };
}

/**
 * Figma import (import/figma): a .fig file's page, or layers copied in Figma (the clipboard's HTML), become
 * editable layers. Pictures are saved in images/ next to the design.
 */
export async function importFigma(source: { bytes?: Uint8Array; html?: string }, opts: { page?: string | number; where?: 'right' | 'view' | { parent: string } } = {}): Promise<FigmaResult> {
  let r: FigmaImport;
  if (source.bytes) {
    if (!isFigFile(source.bytes)) throw new Error('that is not a Figma file (.fig)');
    r = await importFigFile(source.bytes, { page: opts.page });
  } else if (source.html && figmaClipboard(source.html)) {
    r = await importFigmaClipboard(source.html);
  } else {
    throw new Error('there is nothing from Figma to import');
  }
  if (!r.nodes.length) throw new Error(r.page ? `the page "${r.page}" has nothing that can be imported` : 'nothing that can be imported was found');
  // Pictures first, so the layers never point at files that are not there. A design with no place on disk gets
  // them embedded instead, and the fills are pointed at those.
  const moved = new Map<string, string>();
  for (const img of r.images) {
    const url = await saveAsset(img.path, new Blob([img.bytes as BlobPart]));
    if (url !== `./${img.path}`) moved.set(`./${img.path}`, url);
  }
  if (moved.size) {
    const fix = (n: any) => {
      for (const key of ['fill', 'stroke']) {
        const v = n[key];
        for (const f of Array.isArray(v) ? v : [v]) if (f && typeof f === 'object' && f.type === 'image' && moved.has(f.url)) f.url = moved.get(f.url);
      }
      n.children?.forEach(fix);
    };
    r.nodes.forEach(fix);
  }
  const ids = insertImported(r.nodes, opts.where ?? (source.bytes ? 'right' : 'view'));
  return { ids, layers: countLayers(r.nodes), images: r.images.length, page: r.page, pages: r.pages, warnings: r.warnings };
}

/** One line for the user about a finished Figma import. */
export function figmaSummary(r: FigmaResult): string {
  const left = r.warnings.length ? ` Not exact: ${r.warnings.slice(0, 4).join('; ')}${r.warnings.length > 4 ? `; and ${r.warnings.length - 4} more kinds` : ''}.` : '';
  return `Imported ${r.layers} layer${r.layers === 1 ? '' : 's'} from Figma${r.page ? ` (page "${r.page}")` : ''}${r.images ? `, with ${r.images} picture${r.images === 1 ? '' : 's'}` : ''}.${left}`;
}

// ---------- viewport ----------

export function zoomToRect(r: { x: number; y: number; w: number; h: number }, maxZoom = 1, pad = 80) {
  const c = canvasRect();
  const { leftOpen, selection } = useStore.getState();
  // The panels and the top bar lie over the canvas: fit into what is left (see styles.css for their sizes).
  const { rightOpen } = useStore.getState();
  const left = leftOpen ? 248 : 0;
  const right = selection.length && rightOpen ? 248 : 0;
  const top = 40;
  const availW = Math.max(100, c.width - left - right - pad * 2);
  const availH = Math.max(100, c.height - top - pad * 2);
  const zoom = Math.max(0.02, Math.min(maxZoom, availW / Math.max(r.w, 1), availH / Math.max(r.h, 1)));
  const x = left + pad + (availW - r.w * zoom) / 2 - r.x * zoom;
  const y = top + pad + (availH - r.h * zoom) / 2 - r.y * zoom;
  viewChangeSource('zoomTo');
  useStore.getState().setView({ x, y, zoom });
}

/** Bounds from document positions for top-level nodes with fixed sizes (no rendering needed). */
export function propsRect(key: string) {
  const tree = currentTree();
  const n = tree?.byKey.get(key);
  if (!n || tree?.parent.get(key)) return null;
  const p = n.props;
  if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.width !== 'number' || typeof p.height !== 'number' || p.rotation) return null;
  return { x: p.x, y: p.y, w: p.width, h: p.height };
}

/** Bumped by every direct user pan/zoom; a deferred "zoom to" is dropped if the user moved the view meanwhile. */
let userViewEpoch = 0;
export function markUserViewChange() {
  userViewEpoch++;
  viewChangeSource('user');
}

export function zoomToKeys(keys: string[], maxZoom = 1) {
  // Document positions first; otherwise measure whatever is on the page right now (top-level frames always are,
  // as live DOM, a bitmap or a placeholder), so a zoom-to almost never has to wait for a frame.
  const fromProps = keys.map(k => propsRect(k) ?? (elFor(k) ? worldRectOf(k) : null));
  const apply = () => {
    const rects = keys.map((k, i) => fromProps[i] ?? worldRectOf(k)).filter(Boolean) as { x: number; y: number; w: number; h: number }[];
    if (!rects.length) return;
    const x0 = Math.min(...rects.map(r => r.x));
    const y0 = Math.min(...rects.map(r => r.y));
    const x1 = Math.max(...rects.map(r => r.x + r.w));
    const y1 = Math.max(...rects.map(r => r.y + r.h));
    zoomToRect({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, maxZoom);
  };
  // Bounds known from the document: apply right away, so a late frame can't override the user's next zoom.
  if (fromProps.every(Boolean)) return apply();
  // Otherwise the nodes must render before they can be measured.
  const epoch = userViewEpoch;
  requestAnimationFrame(() => {
    if (epoch === userViewEpoch) apply();
  });
}

export function zoomToFit() {
  const tree = currentTree();
  if (!tree?.roots.length) {
    viewChangeSource('zoomTo');
    return useStore.getState().setView({ x: 400, y: 100, zoom: 1 });
  }
  const hidden = canvasHiddenIds(useStore.getState());
  const shown = tree.roots.filter(r => r.props.enabled !== false && !hidden.has(r.key));
  zoomToKeys((shown.length ? shown : tree.roots).map(r => r.key), 1);
}

export function zoomBy(factor: number, cx?: number, cy?: number) {
  markUserViewChange();
  const { view } = useStore.getState();
  const c = canvasRect();
  const px = cx ?? c.left + c.width / 2;
  const py = cy ?? c.top + c.height / 2;
  const zoom = Math.max(0.02, Math.min(256, view.zoom * factor));
  const wx = (px - c.left - view.x) / view.zoom;
  const wy = (py - c.top - view.y) / view.zoom;
  useStore.getState().setView({ zoom, x: px - c.left - wx * zoom, y: py - c.top - wy * zoom });
}

export function setZoom(z: number) {
  zoomBy(z / useStore.getState().view.zoom);
}
