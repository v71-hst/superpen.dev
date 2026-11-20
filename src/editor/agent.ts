// Handles MCP requests forwarded by the extension: reads, atomic edits, screenshots, layout checks, exports.
import { useStore } from './store';
import { libraries } from '../model/libraries';
import { canvasSnapshot, recentLog, uiSnapshot } from './diagnostics';
import { currentTree } from './tree';
import { clientToWorld, insertSvg, importHtml, insertImported, removeBackgroundOf, vectorizeNode, worldRectOf, zoomToKeys } from './ops';
import { nodeScreenRect, nodeSize } from './measure';
import { flushEdits } from './host';
import { applyOperations, describe, nodeJson, outline, searchNodes, type Operation } from '../model/operations';
import { defaultTheme, isVarRef } from '../model/resolve';
import { displayName } from '../model/doc';
import type { RNode } from '../model/types';
import { agentEdit, recordAgentChange, reviewStatus } from './review';
import { commentsOf, openForAgent, postMessage, setResolved } from './comments';
import { lintDesign } from './lint';
import { exportRoblox } from './roblox';
import { aiPenDraw, requestsForAgent } from './aipen';
import { createSection, deleteSection, focusSections, hiddenFrameIds, sectionsOf, updateSection, viewerSections } from './sections';
import { analyze, closeupGrid, compare, loadImageData, presentShot, zoomCrop, type Closeup } from './imageTools';
import { checkDrawing } from './drawingCheck';
import { nodeToHtmlDocument } from '../export/html';
import { nodeToSvg } from '../export/svg';
import { nextFrames } from '../render/frames';
import { rendererFailure } from '../skia/renderer';
import { skiaStatus } from '../skia/SkiaLayer';
import { renderNodeImage } from '../skia/offscreen';
import { skiaTextMeasurer } from '../skia/layoutIndex';
import { propsOf } from '../skia/painter';
import { shaderErrorsOf } from '../skia/shaderFills';
import { iconMissing } from '../skia/icons';
import { fontStats, skiaFamily } from '../skia/fonts';
import { scriptState } from './scriptHost';
import { makeUrlResolver } from './fileio';
import { runBenchmark } from './benchmark';

/** Things the agent should know after any call: review mode, and comments from the user waiting for an answer. */
function agentNotes(): string[] {
  const notes: string[] = [];
  const r = reviewStatus();
  if (r) notes.push(r);
  const open = openForAgent(useStore.getState().doc);
  if (open.length) notes.push(`The user left ${open.length} open comment${open.length > 1 ? 's' : ''} on the canvas waiting for a reply: call get_comments.`);
  const doc = useStore.getState().doc;
  const sections = sectionsOf(doc);
  const roots = doc?.children?.length ?? 0;
  if (!sections.length && roots >= 30)
    notes.push(`This file has ${roots} top-level frames and no sections. Grouping them with create_section (one section per feature or area, e.g. "HUD", "Menus") lets you and the user hide whole groups, and hidden frames aren't rendered, which keeps a big file fast. Offer this to the user, or do it when they ask to organise the file.`);
  const hidden = sections.filter(x => x.hidden);
  const st = useStore.getState();
  const pen = st.aiPenRequests.filter(r => r.status === 'waiting');
  if (pen.length)
    notes.unshift(`AI Pen: the user is waiting for ${pen.length} drawing request${pen.length > 1 ? 's' : ''} (${pen.map(r => `"${r.prompt.slice(0, 60)}"`).join(', ')}). Call ai_pen_requests, then draw each with ai_pen_draw.`);
  if (sections.length && !hidden.length && roots >= 30 && st.viewer !== 'sections')
    notes.push(`All ${sections.length} sections are visible. Before working on one area, call focus_sections with the section(s) you need: the others stop rendering, so the editor (and your screenshots) stay fast. Tell the user which sections you hid; they can show them again in the Sections tab.`);
  if (hidden.length) notes.push(`Hidden sections (not drawn on the canvas): ${hidden.map(x => x.name).join(', ')}. You can still read, edit, screenshot and export their frames. Show a hidden section only if the task needs it on screen.`);
  if (st.viewer === 'sections') {
    const cur = viewerSections(doc).find(x => x.id === st.viewerSection) ?? viewerSections(doc)[0];
    if (cur) notes.push(`The user is in the Sections viewer looking at "${cur.name}" (only that section is drawn).`);
  }
  return notes;
}

const frames = nextFrames;

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

/** The image an agent wants to measure: a file the MCP server read (data URL), or a node rendered at `scale`. */
async function imageSource(params: { image?: string; id?: string; scale?: number }): Promise<ImageData> {
  if (params.image) return loadImageData(params.image);
  if (!params.id) throw new Error('pass path (an image file) or id (a node: an image layer or any frame)');
  requireNode(params.id);
  const shot = await capture(params.id, 'png', params.scale ?? 1, 4096);
  return loadImageData(shot.dataUrl);
}

/** A picture that is still loading is drawn from this one transparent pixel (render/imageLod.ts BLANK). */
const BLANK_PIXEL = 'R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw';

async function capture(key: string, format: 'png' | 'jpg' | 'svg', scale: number, maxSize: number) {
  // PNG/JPEG drawn by Skia off screen (skia/offscreen.ts); SVG is the layer as HTML in an SVG (export/svg.ts).
  if (format === 'svg') return nodeToSvg(key);
  const r = await renderNodeImage(key, { scale, maxSize, format });
  return { dataUrl: r.dataUrl, width: r.width, height: r.height };
}

function flash(keys: string[]) {
  const t = performance.now();
  useStore.setState(s => ({ flashes: [...s.flashes.filter(f => t - f.t < 1400), ...keys.map(key => ({ key, t }))] }));
}


/** Visual/layout problems an agent should know about. */
export async function checkLayout(rootKey?: string): Promise<string[]> {
  const s = useStore.getState();
  const tree = currentTree()!;
  const roots = rootKey ? [requireNode(rootKey)] : tree.roots;
  // Checked from the layout engine and what Skia knows (its text measurer, icon libraries, the shaders that failed
  // when run); drawing the frames small first runs their shaders.
  for (const r of roots.slice(0, 30)) await renderNodeImage(r.key, { scale: 0.2, maxSize: 400, waitMs: 4000 }).catch(() => undefined);
  const measure = skiaTextMeasurer();
  const resolveUrl = makeUrlResolver(s.file?.path ?? null);
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
    const r = nodeScreenRect(n.key, { ownBox: true });
    if (r) {
      // Text that does not fit its fixed-height box: Skia's paragraph at the box's width. (Long words break onto the
      // next line, so a fixed width never overflows.)
      if (n.type === 'text' && p.textGrowth === 'fixed-width-height') {
        const size = nodeSize(n.key);
        const content = size ? measure(n, size.w) : null;
        if (content && size && content.h > size.h + 1) issues.push(`warning: ${label(n)} text overflows its fixed-height box (${Math.round(content.h)}px of content in ${Math.round(size.h)}px)`);
      }
      const missing = iconMissing(String(p.library ?? p.iconFontFamily ?? 'lucide'), String(p.icon ?? p.iconFontName ?? ''));
      if ((n.type === 'icon' || n.type === 'icon_font') && missing) issues.push(`error: ${label(n)} icon "${p.icon ?? p.iconFontName}" not found in library "${p.library ?? p.iconFontFamily ?? 'lucide'}"`);
      if ((r.width < 0.5 || r.height < 0.5) && n.type !== 'group' && n.type !== 'line' && n.type !== 'path') issues.push(`warning: ${label(n)} has zero size`);
      if (p.clip === true && n.children.length) {
        for (const c of n.children) {
          if (c.props.enabled === false) continue;
          const cr = nodeScreenRect(c.key, { ownBox: true });
          if (!cr || (!cr.width && !cr.height)) continue;
          const outside = cr.left < r.left - 0.5 || cr.top < r.top - 0.5 || cr.right > r.right + 0.5 || cr.bottom > r.bottom + 0.5;
          const fully = cr.right <= r.left || cr.left >= r.right || cr.bottom <= r.top || cr.top >= r.bottom;
          if (fully) issues.push(`warning: ${label(c)} is completely hidden outside its clipping parent ${label(n)}`);
          else if (outside) issues.push(`info: ${label(c)} is partly clipped by ${label(n)}`);
        }
      }
      // Overlapping text in freeform (layout: none) containers is usually a mistake.
      if (n.type === 'frame' && p.layout === 'none') {
        const texts = n.children.filter(c => c.type === 'text' && c.props.enabled !== false).map(c => ({ c, r: nodeScreenRect(c.key, { ownBox: true }) })).filter(x => x.r && x.r.width && x.r.height);
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
  // Script and shader errors: Skia's records of them.
  {
    const visitErrors = (n: RNode) => {
      const p = propsOf({ doc: s.doc! }, n);
      if (p.enabled === false) return;
      for (const e of shaderErrorsOf(resolveUrl, n, p)) issues.push(`error: ${label(n)}: ${e}`);
      if (n.type === 'script') {
        const st = scriptState(n.props, n.theme, n.key);
        if (!st) issues.push(`error: ${label(n)}: Script node has no scriptUri`);
        else if (st.status === 'error') issues.push(`error: ${label(n)}: Script error: ${(st as any).message}`);
      }
      n.children.forEach(visitErrors);
    };
    roots.forEach(visitErrors);
  }

  // Fonts are loaded by Skia (its own files, not the page's): the ones it could not fetch. System fonts are drawn in
  // open stand-ins, so they are not reported.
  const failedFonts = new Set(fontStats().failedFamilies);
  for (const f of fontsUsed) if (failedFonts.has(skiaFamily(f).toLowerCase())) issues.push(`warning: font "${f}" did not load (check the family name on fonts.google.com)`);
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
        topLevel: tree.roots.map(n => describe(n) + (hiddenFrameIds(doc).has(n.key) ? ' [in hidden section]' : '')),
        sections: sectionsOf(doc).map(x => `${x.name} #${x.id}: ${x.frames.length} frames${x.hidden ? ' (hidden)' : ''}`),
        nodeCount: tree.byKey.size,
        components: comps.length,
        variables: Object.keys(doc.variables ?? {}).length,
        themes: doc.themes ?? {},
        selection: s.selection.map(k => (tree.byKey.get(k) ? describe(tree.byKey.get(k)!) : k)),
        notes: agentNotes(),
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
      agentEdit(
        params.description ?? 'apply_operations',
        () =>
          s.edit(d => {
            out = applyOperations(d, params.operations as Operation[]);
          }),
        () => (out as ReturnType<typeof applyOperations> | null)?.touched ?? [],
      );
      flushEdits();
      const r = out as ReturnType<typeof applyOperations> | null;
      if (r) requestAnimationFrame(() => flash(r.touched));
      return { results: r?.results ?? [], notes: agentNotes() };
    }
    case 'sections': {
      const grouped = new Set(sectionsOf(doc).flatMap(x => x.frames));
      return {
        sections: sectionsOf(doc).map(x => ({
          id: x.id,
          name: x.name,
          hidden: !!x.hidden,
          frames: x.frames.map(k => (tree.byKey.get(k) ? `${displayName(tree.byKey.get(k)!.props)} #${k}` : `#${k} (deleted)`)),
        })),
        ungrouped: tree.roots.filter(n => !grouped.has(n.key)).map(n => `${displayName(n.props)} #${n.key}`),
      };
    }
    case 'createSection': {
      const frames: string[] = params.frame_ids ?? [];
      if (!params.name || !frames.length) throw new Error('name and frame_ids are required');
      const id = createSection(String(params.name), frames, !!params.hidden);
      flushEdits();
      return { id, notes: agentNotes() };
    }
    case 'updateSection': {
      updateSection(params.id, { name: params.name, add: params.add_frame_ids, remove: params.remove_frame_ids, hidden: params.hidden });
      flushEdits();
      return { ok: true, notes: agentNotes() };
    }
    case 'focusSections': {
      const ids: string[] = params.ids ?? [];
      if (!ids.length) throw new Error('ids is required (section ids from list_sections)');
      focusSections(ids);
      flushEdits();
      return { ok: true, hidden: sectionsOf(useStore.getState().doc).filter(x => x.hidden).map(x => x.name), notes: agentNotes() };
    }
    case 'deleteSection': {
      deleteSection(params.id);
      flushEdits();
      return { ok: true };
    }
    case 'comments': {
      const all = commentsOf(doc);
      return all
        .filter(c => params.include_resolved || !c.resolved)
        .map(c => {
          const n = c.node ? tree.byKey.get(c.node) : undefined;
          return { id: c.id, on: n ? describe(n) : c.node ? `#${c.node} (deleted)` : `canvas at ${c.x},${c.y}`, node_id: c.node, resolved: !!c.resolved, thread: c.messages.map(m => `${m.author === 'agent' ? (m.name ?? 'agent') : 'user'}: ${m.text}`) };
        });
    }
    case 'replyComment': {
      const c = commentsOf(doc).find(x => x.id === params.id);
      if (!c) throw new Error(`comment "${params.id}" not found (use get_comments)`);
      if (params.text) postMessage(c.id, { author: 'agent', name: params.name, text: String(params.text).slice(0, 4000), t: Date.now() });
      if (params.resolve !== undefined) setResolved(c.id, !!params.resolve);
      flushEdits();
      return { ok: true };
    }
    case 'lint':
      return lintDesign(params.id);
    case 'exportRoblox': {
      requireNode(params.id);
      return exportRoblox(params.id, { units: params.units, center: params.center });
    }
    case 'getVariables':
      return { variables: doc.variables ?? {}, themes: doc.themes ?? {}, activeTheme: { ...defaultTheme(doc), ...(s.previewTheme ?? {}) } };
    case 'setVariables': {
      agentEdit('set_variables', () => s.edit(d => {
        if (params.replace) d.variables = {};
        d.variables ??= {};
        for (const [k, v] of Object.entries(params.variables ?? {})) {
          if (v === null) delete d.variables[k];
          else d.variables[k] = v as any;
        }
        if (params.themes) d.themes = params.themes;
      }), () => []);
      flushEdits();
      return { ok: true, count: Object.keys(useStore.getState().doc?.variables ?? {}).length };
    }
    case 'components': {
      const own = [...tree.byKey.values()].filter(n => n.isComponent && !n.inInstance).map(n => {
        const inst = [...tree.byKey.values()].filter(x => x.instanceOf === n.key).length;
        return `${describe(n)} — ${inst} instance(s)`;
      });
      // Components of imported libraries: instantiate them by their "alias:id".
      const fromLibs = libraries().flatMap(l =>
        l.error ? [`library "${l.alias}" (${l.uri}) did not load: ${l.error}`] : l.components.map(c => `${c.type} "${c.name ?? c.id}" #${c.id} — from library "${l.alias}" (${l.uri})`),
      );
      return [...own, ...fromLibs];
    }
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
      const sizes: number[] | undefined = Array.isArray(params.sizes) && params.sizes.length ? params.sizes.map(Number).filter((n: number) => n >= 8 && n <= 1024) : undefined;
      // Icon previews render once at twice the largest size, then scale down like a game engine would.
      const shot = sizes ? await capture(key, 'png', 8, Math.max(...sizes) * 2) : await capture(key, 'png', params.scale ?? 1, params.max_size ?? 1280);
      if (!params.background && !sizes) return shot;
      return presentShot(shot.dataUrl, params.background, sizes);
    }
    case 'analyzeImage': {
      const img = await imageSource(params);
      const text = analyze(img, params);
      return { text, zoom: params.zoom ? zoomCrop(img, params.zoom) : undefined };
    }
    case 'checkDrawing': {
      const key = String(params.id ?? '');
      requireNode(key);
      const { issues } = checkDrawing(key);
      const regions: { x: number; y: number; w: number; h: number }[] = Array.isArray(params.regions) ? params.regions : [];
      if (!issues.length && !regions.length) return { issues, text: 'No problem joints found: every stroke end either sits on the line it meets or is clear of it.' };
      // Render the drawing large once and cut magnified tiles out of it.
      const size = nodeSize(key)!;
      const k = Math.max(1, Math.min(10, 6000 / Math.max(size.w, size.h, 1)));
      const img = await loadImageData((await capture(key, 'png', k, 8192)).dataUrl);
      const spots: Closeup[] = [
        ...issues.slice(0, 24).map((x, i) => ({ x: x.at.x * k, y: x.at.y * k, half: Math.max(6, x.off * 6) * k, label: `${i + 1}. ${x.name} (${x.end})`, fix: { x: x.fix.x * k, y: x.fix.y * k } })),
        ...regions.slice(0, 12).map((r, i) => ({ x: (r.x + r.w / 2) * k, y: (r.y + r.h / 2) * k, half: (Math.max(r.w, r.h) / 2) * k, label: `region ${i + 1}` })),
      ];
      const text = issues.length
        ? `${issues.length} joint problem${issues.length > 1 ? 's' : ''} (coordinates in the drawing's own units, top-left 0,0):\n` +
          issues.map((x, i) => `${i + 1}. ${x.name} #${x.node}, ${x.end} at (${x.at.x}, ${x.at.y}) meets ${x.meets.name} #${x.meets.node}: ${x.problem}. Move it to (${x.fix.x}, ${x.fix.y}).`).join('\n') +
          '\nClose-ups: red ring = the stroke end, green dot = where it should be.'
        : 'No problem joints found. Close-ups of the requested regions:';
      return { issues, text, closeups: closeupGrid(img, spots) };
    }
    case 'compareReference': {
      const key = String(params.id ?? '');
      requireNode(key);
      const ref = await imageSource({ image: params.image, id: params.reference_id });

      // Render at the reference's pixel size so the two line up pixel for pixel.
      const k = ref.width / Math.max(1, nodeSize(key)!.w);
      const shot = await capture(key, 'png', k, 8192);
      return compare(ref, await loadImageData(shot.dataUrl), params.tolerance ?? 48, k);
    }
    case 'checkLayout':
      return checkLayout(params.id);
    case 'exportNode': {
      const n = requireNode(params.id);
      const name = displayName(n.props).replace(/[\\/:*?"<>|]+/g, '_');
      const format = params.format ?? 'png';
      if (format === 'html') {
        return { name: `${name}.html`, dataUrl: 'data:text/html;charset=utf-8,' + encodeURIComponent(nodeToHtmlDocument(n.key)) };
      }
      const shot = await capture(n.key, format, params.scale ?? 2, 16384);
      return { name: `${name}.${format}`, dataUrl: shot.dataUrl };
    }
    case 'insertSvg': {
      const r = agentEdit('insert_svg', () => insertSvg(String(params.svg ?? ''), { parent: params.parent ?? null, index: params.index, x: params.x, y: params.y, width: params.width, height: params.height, name: params.name }), x => [x.id]);
      flushEdits();
      requestAnimationFrame(() => flash([r.id]));
      return r;
    }
    case 'aiPenRequests':
      return { requests: requestsForAgent(), notes: agentNotes() };
    case 'aiPenDraw': {
      const before = useStore.getState().doc;
      const r = aiPenDraw(params);
      recordAgentChange(before, 'ai_pen_draw', () => [r.frame_id]);
      flushEdits();
      return { ...r, notes: agentNotes() };
    }
    case 'vectorize': {
      const before = useStore.getState().doc;
      const r = await vectorizeNode(String(params.id), { colors: params.colors, detail: params.detail });
      recordAgentChange(before, 'vectorize_image', () => [r.id]);
      flushEdits();
      requestAnimationFrame(() => flash([r.id]));
      return r;
    }
    case 'importHtml': {
      const before = useStore.getState().doc;
      const r = await importHtml({ html: typeof params.html === 'string' ? params.html : undefined, url: typeof params.url === 'string' ? params.url : undefined }, { width: params.width, name: params.name });
      recordAgentChange(before, 'import_html', () => [r.id]);
      flushEdits();
      return r;
    }
    case 'insertImported': {
      // Nodes converted outside the editor (import_figma runs in the MCP server, which can read the file).
      if (!Array.isArray(params.nodes) || !params.nodes.length) throw new Error('there are no layers to insert');
      const before = useStore.getState().doc;
      const ids = insertImported(params.nodes, 'right');
      recordAgentChange(before, String(params.source ?? 'import'), () => ids);
      flushEdits();
      return { ids };
    }
    case 'removeBackground': {
      const before = useStore.getState().doc;
      const r = await removeBackgroundOf(String(params.id), { tolerance: params.tolerance, inner: params.keep_enclosed === true ? false : undefined });
      recordAgentChange(before, 'remove_background', () => [String(params.id)]);
      flushEdits();
      return r;
    }
    case 'diagnose':
      return {
        ui: uiSnapshot(),
        performanceMode: useStore.getState().perfMode,
        renderer: { failure: rendererFailure(), skia: skiaStatus() },
        canvas: await canvasSnapshot(),
        log: recentLog(),
      };
    case 'benchmark':
      return runBenchmark();
    case 'root':
      return rootOf(params.id);
    default:
      throw new Error(`unknown method ${method}`);
  }
}
