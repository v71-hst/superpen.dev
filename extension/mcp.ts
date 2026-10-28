// Pen Editor MCP server (stdio). One process per Claude chat: it talks to every open VS Code window's bridge,
// lets the chat pick which .pen file to work on, and holds an edit lock on it so other chats can't clobber it.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { GUIDE } from './guide';

const BRIDGE_DIR = path.join(os.homedir(), '.pen-editor', 'bridges');

type BridgeInfo = { port: number; token: string; pid: number; window: string; folders: string[]; lastFocused: number; file: string };
type FileInfo = { path: string; name: string; open: boolean; dirty: boolean; window: string; lock: null | { session: string; label: string; you: boolean; idleSeconds: number } };

const session = { id: crypto.randomUUID(), label: `Claude chat ${crypto.randomBytes(2).toString('hex')}` };
let selected: { path: string; bridge: BridgeInfo; readOnly: boolean } | null = null;

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM';
  }
}

async function rpc(b: BridgeInfo, method: string, params: any = {}, timeoutMs = 90_000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${b.port}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pen-token': b.token },
      body: JSON.stringify({ method, params, session }),
      signal: ctl.signal,
    });
    const body: any = await res.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

/** Live VS Code windows running the Pen Editor extension (stale registry entries are removed). */
async function bridges(): Promise<BridgeInfo[]> {
  let files: string[] = [];
  try {
    files = fs.readdirSync(BRIDGE_DIR).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out: BridgeInfo[] = [];
  await Promise.all(
    files.map(async f => {
      const full = path.join(BRIDGE_DIR, f);
      let info: BridgeInfo;
      try {
        info = { ...JSON.parse(fs.readFileSync(full, 'utf8')), file: full };
      } catch {
        return;
      }
      try {
        await rpc(info, 'ping', {}, 2000);
        out.push(info);
      } catch {
        if (!pidAlive(info.pid)) fs.rmSync(full, { force: true });
      }
    }),
  );
  return out.sort((a, b) => b.lastFocused - a.lastFocused);
}

async function allFiles(includeClosed: boolean): Promise<(FileInfo & { bridge: BridgeInfo })[]> {
  const bs = await bridges();
  const lists = await Promise.all(bs.map(async b => ((await rpc(b, 'listFiles', { includeClosed }).catch(() => [])) as FileInfo[]).map(f => ({ ...f, bridge: b }))));
  // A closed file may show up in several windows; prefer the window that has it open, then the most recent window.
  const seen = new Map<string, FileInfo & { bridge: BridgeInfo }>();
  for (const f of lists.flat()) {
    const k = f.path.toLowerCase();
    const cur = seen.get(k);
    if (!cur || (f.open && !cur.open)) seen.set(k, f);
  }
  return [...seen.values()];
}

function norm(p: string) {
  return p.replace(/\\/g, '/').toLowerCase();
}

async function resolveFile(file: string) {
  const files = await allFiles(true);
  if (!files.length) throw new Error('No VS Code window with the Pen Editor extension is running (or it has no .pen files). Open VS Code with the extension installed.');
  const want = norm(file.trim());
  let hits = files.filter(f => norm(f.path) === want);
  if (!hits.length && path.isAbsolute(file)) {
    // Not in any workspace: open it in the most recently focused window.
    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    const b = (await bridges())[0];
    return { path: path.resolve(file), name: path.basename(file), open: false, dirty: false, window: b.window, lock: null, bridge: b };
  }
  if (!hits.length) hits = files.filter(f => norm(f.path).endsWith('/' + want.replace(/^\.?\//, '')));
  if (!hits.length) hits = files.filter(f => norm(f.name) === want || norm(f.name) === want + '.pen');
  if (!hits.length) hits = files.filter(f => norm(f.name).includes(want));
  if (hits.length === 1) return hits[0];
  if (!hits.length) throw new Error(`No .pen file matches "${file}". Use list_open_files (include_closed: true) to see available files.`);
  throw new Error(`"${file}" is ambiguous; use the full path. Matches:\n${hits.map(h => '- ' + h.path).join('\n')}`);
}

function requireSelected() {
  if (!selected) throw new Error('No file selected for this chat. Call list_open_files, then select_file.');
  return selected;
}

async function callEditor(method: string, params: any = {}, write = false) {
  const s = requireSelected();
  if (write && s.readOnly) throw new Error(`${path.basename(s.path)} is selected read-only because another chat holds the lock. Call select_file with force: true to take over (ask the user first).`);
  try {
    return await rpc(s.bridge, 'call', { path: s.path, method, params, write });
  } catch (e: any) {
    if (/fetch failed|ECONNREFUSED|aborted/i.test(String(e?.message))) throw new Error('Lost connection to the VS Code window that had this file open. Call select_file again.');
    throw e;
  }
}

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const json = (v: any) => text(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function tool<T extends z.ZodRawShape>(name: string, description: string, shape: T, fn: (args: z.objectOutputType<T, z.ZodTypeAny>) => Promise<any>) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: any) => {
    try {
      return await fn(args);
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e?.message ?? e}` }], isError: true };
    }
  }) as any);
}

const server = new McpServer(
  { name: 'pen-editor', version: '0.2.0' },
  {
    instructions:
      'Edits .pen design files open in VS Code (Pen Editor extension). Start with list_open_files, then select_file to choose the file this chat works on (this takes an edit lock so other chats cannot edit it at the same time). Call get_guide once for the .pen format. Edit with apply_operations, then screenshot to verify visually.',
  },
);

tool('list_open_files', 'List .pen files open in Pen Editor across all VS Code windows, with unsaved state and which chat (if any) holds the edit lock. include_closed also lists .pen files in the workspaces that are not open.', { include_closed: z.boolean().optional() }, async ({ include_closed }) => {
  const files = await allFiles(!!include_closed);
  if (!files.length) return text('No .pen files are open. Use include_closed: true to list workspace files, or ask the user to open one.');
  const lines = files.map(f => {
    const lock = f.lock ? (f.lock.you ? 'locked by you' : `LOCKED by "${f.lock.label}" (idle ${f.lock.idleSeconds}s)`) : 'unlocked';
    const sel = selected && norm(selected.path) === norm(f.path) ? ' ← selected' : '';
    return `- ${f.name}${f.open ? '' : ' (not open)'}${f.dirty ? ' (unsaved changes)' : ''} — ${lock} — window "${f.window}"\n  ${f.path}${sel}`;
  });
  return text(lines.join('\n'));
});

tool(
  'select_file',
  'Choose the .pen file this chat works on and take its edit lock (opens it in VS Code if needed). If another chat is actively editing it, the call is refused unless force is true; a holder idle for over 2 minutes is taken over with a warning. Optionally name this chat (label) so the user can see who holds the lock.',
  { file: z.string().describe('Path, workspace-relative path, or file name'), label: z.string().optional(), force: z.boolean().optional() },
  async ({ file, label, force }) => {
    if (label) session.label = label.slice(0, 60);
    const f = await resolveFile(file);
    if (selected && norm(selected.path) !== norm(f.path) && !selected.readOnly) await rpc(selected.bridge, 'release', { path: selected.path }).catch(() => undefined);
    try {
      const r = await rpc(f.bridge, 'claim', { path: f.path, force: !!force });
      selected = { path: r.path, bridge: f.bridge, readOnly: false };
      const summary = await callEditor('summary').catch(() => null);
      return text(
        `Selected ${r.name} (edit lock held by this chat as "${session.label}").${r.warning ? `\nWARNING: ${r.warning}` : ''}\n` +
          (summary ? `\n${JSON.stringify(summary, null, 2)}` : ''),
      );
    } catch (e: any) {
      if (/locked by another Claude session/.test(e.message)) {
        selected = { path: f.path, bridge: f.bridge, readOnly: true };
        return text(`Selected ${f.name} READ-ONLY. ${e.message}`);
      }
      throw e;
    }
  },
);

tool('release_file', 'Release this chat\'s edit lock on the selected file so another chat can edit it.', {}, async () => {
  const s = requireSelected();
  await rpc(s.bridge, 'release', { path: s.path });
  selected = { ...s, readOnly: true };
  return text(`Released the lock on ${path.basename(s.path)} (still selected read-only).`);
});

tool('get_editor_state', 'Summary of the selected file: top-level frames, node/component/variable counts, themes, and the user\'s current selection.', {}, async () => json(await callEditor('summary')));

tool('get_guide', 'Reference for the .pen format, node types, sizing, paints, components, and the apply_operations syntax. Read once before editing.', {}, async () => text(GUIDE));

tool(
  'get_tree',
  'Outline of the layer tree (one line per node with id, size, layout, fill, text). Start shallow and drill in with root_id.',
  { root_id: z.string().optional(), depth: z.number().int().min(1).max(20).optional(), expand_instances: z.boolean().optional() },
  async a => text(await callEditor('tree', a)),
);

tool('get_nodes', 'Full JSON for nodes by id (children truncated below depth).', { ids: z.array(z.string()).min(1), depth: z.number().int().min(0).max(10).optional() }, async a => json(await callEditor('nodes', a)));

tool(
  'search_nodes',
  'Find nodes by name, text content, icon name or id. Optional type filter (frame, text, icon, instance, ...) and root_id scope.',
  { query: z.string().optional(), type: z.string().optional(), root_id: z.string().optional(), limit: z.number().int().min(1).max(500).optional() },
  async a => {
    const r: string[] = await callEditor('search', a);
    return text(r.length ? r.join('\n') : 'No matches.');
  },
);

tool(
  'apply_operations',
  'Edit the selected file with an atomic batch of operations (insert, update, delete, move, duplicate, replace, instantiate). All succeed or none apply; the batch is one undo step for the user. Requires the edit lock. See get_guide for the syntax.',
  { operations: z.array(z.record(z.any())).min(1), description: z.string().optional() },
  async ({ operations }) => {
    const r = await callEditor('applyOps', { operations }, true);
    return json({ applied: r.length, results: r });
  },
);

tool('get_variables', 'Design tokens (variables) and themes of the selected file.', {}, async () => json(await callEditor('getVariables')));

tool(
  'set_variables',
  'Create/update variables (merge by name; null deletes one). replace: true replaces all variables. themes optionally sets theme axes, e.g. {"Mode":["Light","Dark"]}. Requires the edit lock.',
  { variables: z.record(z.any()), replace: z.boolean().optional(), themes: z.record(z.array(z.string())).optional() },
  async a => json(await callEditor('setVariables', a, true)),
);

tool('list_components', 'Reusable components in the selected file with instance counts.', {}, async () => {
  const r: string[] = await callEditor('components');
  return text(r.length ? r.join('\n') : 'No components (mark a node reusable: true to create one).');
});

tool('get_selection', 'What the user currently has selected in the editor (ids, summaries and JSON).', {}, async () => {
  const r = await callEditor('selection');
  return r.length ? json(r) : text('Nothing is selected in the editor.');
});

tool(
  'set_selection',
  'Select nodes in the editor to point the user at something. Does not move the user\'s viewport unless zoom: true (only use that when the user asked to be shown the result, since it interrupts their navigation).',
  { ids: z.array(z.string()), zoom: z.boolean().optional() },
  async a => json(await callEditor('setSelection', a)),
);

server.registerTool(
  'screenshot',
  {
    description: 'Render a node (default: the user\'s selection) to a PNG image so you can check the result visually. max_size caps the longest side in pixels (default 1280).',
    inputSchema: { id: z.string().optional(), scale: z.number().min(0.1).max(4).optional(), max_size: z.number().int().min(64).max(4096).optional() },
  },
  (async (a: any) => {
    try {
      const r = await callEditor('screenshot', a);
      const data = String(r.dataUrl).slice(String(r.dataUrl).indexOf(',') + 1);
      return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }, { type: 'text' as const, text: `${r.width}×${r.height}px` }] };
    } catch (e: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${e?.message ?? e}` }], isError: true };
    }
  }) as any,
);

tool('check_layout', 'Find problems in a node (default: whole file): overflowing or overlapping text, content hidden by clipping, missing icons/components/fonts, undefined variables, zero-size nodes.', { id: z.string().optional() }, async a => {
  const r: string[] = await callEditor('checkLayout', a);
  return text(r.length ? r.join('\n') : 'No problems found.');
});

tool(
  'export_node',
  'Export a node to a file next to the .pen file (default exports/<name>.<format>). format: png | jpg | svg | html.',
  { id: z.string(), format: z.enum(['png', 'jpg', 'svg', 'html']).optional(), scale: z.number().min(0.1).max(8).optional(), path: z.string().optional().describe('Target path, relative to the .pen file') },
  async ({ id, format, scale, path: target }) => {
    const s = requireSelected();
    const r = await rpc(s.bridge, 'export', { path: s.path, target, params: { id, format, scale } });
    return text(`Exported to ${r.path}`);
  },
);

tool(
  'insert_svg',
  'Draw vector artwork: write SVG markup and it is converted into editable vector nodes (paths, groups) inside a new frame, scaled to width×height. Supports path/rect/circle/ellipse/line/polyline/polygon, <g> transforms, <use>, fill/stroke/opacity, linear & radial gradients and <style> class rules (no text/images/filters). Use for logos, icons, illustrations and decorative artwork. Requires the edit lock.',
  {
    svg: z.string().describe('Complete <svg ...>...</svg> markup with a viewBox'),
    parent: z.string().optional().describe('Frame id to insert into (default: top level)'),
    index: z.number().int().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
    name: z.string().optional(),
  },
  async a => {
    const r = await callEditor('insertSvg', a, true);
    return text(`Inserted vector frame #${r.id} with ${r.paths} path(s)${r.skipped?.length ? `; skipped unsupported elements: ${r.skipped.join(', ')}` : ''}. Screenshot it to check the result.`);
  },
);

tool(
  'vectorize_image',
  'Trace a node\'s image fill into editable vector paths (placed in a new frame beside it). Works best on flat, high-contrast artwork like logos and icons; photos trace poorly. colors: 2 for a monochrome logo, ~8 for flat illustrations, up to 64. detail: 0 (smooth, few points) to 1 (detailed). Requires the edit lock.',
  { id: z.string(), colors: z.number().int().min(2).max(64).optional(), detail: z.number().min(0).max(1).optional() },
  async a => {
    const r = await callEditor('vectorize', a, true);
    return text(`Vectorized into frame #${r.id} with ${r.paths} path(s).`);
  },
);

tool(
  'write_asset',
  'Create or overwrite a script (.js) or shader (.glsl) file next to the selected .pen file (also .svg/.json/.txt/.css/.md). Script and shader nodes using it re-render automatically. Requires the edit lock. See get_guide for the script and shader formats.',
  { path: z.string().describe('Path relative to the .pen file, e.g. "shaders/glow.glsl"'), content: z.string() },
  async ({ path: rel, content }) => {
    const s = requireSelected();
    const r = await rpc(s.bridge, 'writeAsset', { path: s.path, rel, content });
    return text(`Wrote ${r.path}. Reference it as "${r.url}" (scriptUri for script nodes, url for shader fills/effects).`);
  },
);

tool('read_asset', 'Read a text asset (script, shader, svg…) next to the selected .pen file.', { path: z.string() }, async ({ path: rel }) => {
  const s = requireSelected();
  const r = await rpc(s.bridge, 'readAsset', { path: s.path, rel });
  return text(r.content);
});

tool('diagnose_editor', 'Debugging aid: the editor UI state (viewport, panels present, modal, selection) and its recent internal log (errors, agent requests). Use when the user reports the editor misbehaving.', {}, async () => json(await callEditor('diagnose')));

tool('save_file', 'Save the selected file to disk (requires the edit lock).', {}, async () => {
  const s = requireSelected();
  const r = await rpc(s.bridge, 'save', { path: s.path });
  return text(r.saved ? `Saved ${path.basename(s.path)}.` : 'Save was not completed.');
});

// Keep locks alive while this chat is running; release them when it ends.
const heartbeat = setInterval(async () => {
  for (const b of await bridges().catch(() => [])) rpc(b, 'heartbeat', {}, 5000).catch(() => undefined);
}, 15_000);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  await Promise.all((await bridges().catch(() => [])).map(b => rpc(b, 'release', {}, 2000).catch(() => undefined)));
  process.exit(0);
}
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.connect(new StdioServerTransport()).catch(e => {
  console.error('[pen-editor mcp] failed to start', e);
  process.exit(1);
});
