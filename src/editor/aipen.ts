// AI Pen: the AI connected over MCP (Claude Code, Codex, ...) is the pen. The user drags a box and describes a
// drawing (or asks for a change); the agent sees the request in its tool notes and draws it in passes with
// ai_pen_draw, and each pass is replayed on the canvas stroke by stroke under an "AI Pen" cursor.
import { useStore, type AiPenBox, type AiPenRequest } from './store';
import { currentTree } from './tree';
import { worldRectOf } from './ops';
import { allIds, cloneWithNewIds, locate, newId } from '../model/doc';
import { svgToNodes } from '../model/svgImport';
import type { PenNode } from '../model/types';

/** Stored on frames AI Pen draws, so later requests know what they were for. */
export type AiPenMeta = { prompt: string };

let passSeq = 0;

function shortName(prompt: string) {
  const s = prompt.trim().replace(/\s+/g, ' ');
  return `AI Pen – ${s.length > 40 ? s.slice(0, 40) + '…' : s}`;
}

function addRequest(r: Omit<AiPenRequest, 'id' | 't' | 'status'>): string {
  const id = 'p' + Math.random().toString(36).slice(2, 7);
  useStore.setState(s => ({ aiPenRequests: [...s.aiPenRequests, { ...r, id, status: 'waiting', t: Date.now() }] }));
  return id;
}

/** The user dragged a box and described a drawing. */
export function requestDrawing(prompt: string, box: AiPenBox) {
  return addRequest({ prompt: prompt.trim(), box });
}

/** The user asked for a change to a drawing (any frame, not only ones AI Pen made). */
export function requestRefine(key: string, change: string) {
  const n = currentTree()?.byKey.get(key);
  if (!n) throw new Error('that layer no longer exists');
  const p = n.props;
  const wr = worldRectOf(key);
  const width = typeof p.width === 'number' ? p.width : (wr?.w ?? 256);
  const height = typeof p.height === 'number' ? p.height : (wr?.h ?? 256);
  const parent = currentTree()?.parent.get(key)?.key ?? null;
  return addRequest({ prompt: change.trim(), refine: key, frame: key, box: { x: p.x ?? 0, y: p.y ?? 0, wx: wr?.x ?? 0, wy: wr?.y ?? 0, width, height, parent } });
}

export function cancelRequest(id: string) {
  useStore.setState(s => ({ aiPenRequests: s.aiPenRequests.filter(r => r.id !== id) }));
}

/** Waiting and in-progress requests, as the agent sees them. */
export function requestsForAgent() {
  const tree = currentTree();
  return useStore.getState().aiPenRequests.map(r => {
    const target = r.refine ? tree?.byKey.get(r.refine) : undefined;
    const meta = target?.props.aiPen as AiPenMeta | undefined;
    return {
      request_id: r.id,
      kind: r.refine ? 'change' : 'draw',
      prompt: r.prompt,
      ...(r.refine ? { frame_id: r.refine, original_prompt: meta?.prompt } : {}),
      ...(r.frame && !r.refine ? { frame_id: r.frame } : {}),
      status: r.status,
      box: { x: r.box.x, y: r.box.y, width: r.box.width, height: r.box.height, parent: r.box.parent },
      waiting_seconds: Math.round((Date.now() - r.t) / 1000),
    };
  });
}

/** Removes scripts, event handlers and external references before agent markup is shown in the editor. */
function sanitize(svg: SVGSVGElement) {
  svg.querySelectorAll('script, foreignObject, image, iframe').forEach(el => el.remove());
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/href$/i.test(a.name) && !a.value.startsWith('#'))) el.removeAttribute(a.name);
    }
  }
}

export type AiPenDrawParams = {
  request_id?: string;
  frame_id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  parent?: string | null;
  name?: string;
  prompt?: string;
  svg?: string;
  clear?: boolean;
  done?: boolean;
};

/**
 * One drawing pass from the agent: SVG elements in the frame's own coordinates (0..width, 0..height) are added to
 * the frame (created on the first pass), then replayed on the canvas. `clear` empties the frame first; `done`
 * finishes the request.
 */
export function aiPenDraw(p: AiPenDrawParams): { frame_id: string; added: number; frame_size: [number, number]; done: boolean } {
  const s = useStore.getState();
  const req = p.request_id ? s.aiPenRequests.find(r => r.id === p.request_id) : undefined;
  if (p.request_id && !req) throw new Error(`AI Pen request "${p.request_id}" not found (it may have been cancelled); call ai_pen_requests`);
  let frameId = p.frame_id ?? req?.frame ?? null;
  if (frameId && !locate(s.doc!, frameId)) throw new Error(`frame "${frameId}" not found`);

  const box = req?.box;
  let width = p.width ?? box?.width;
  let height = p.height ?? box?.height;
  if (frameId) {
    const fp = currentTree()?.byKey.get(frameId)?.props;
    if (typeof fp?.width === 'number') width = fp.width;
    if (typeof fp?.height === 'number') height = fp.height;
  }
  if (!width || !height) throw new Error('width and height are required for a new drawing (or pass request_id / frame_id)');

  let markup = '';
  let nodes: PenNode[] = [];
  if (p.svg?.trim()) {
    const src = /^\s*<svg[\s>]/i.test(p.svg) ? p.svg : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${p.svg}</svg>`;
    const parsed = new DOMParser().parseFromString(src, 'image/svg+xml');
    const svg = parsed.querySelector('svg');
    if (!svg || parsed.querySelector('parsererror')) throw new Error('svg is not valid SVG markup');
    sanitize(svg as unknown as SVGSVGElement);
    if (!svg.getAttribute('xmlns')) svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    markup = new XMLSerializer().serializeToString(svg);
    nodes = svgToNodes(markup, { width, height }).node.children ?? [];
  }

  const keys: string[] = [];
  s.edit(d => {
    if (!frameId) {
      const parent = p.parent ?? box?.parent ?? null;
      const list = parent ? (locate(d, parent)?.node.children ?? null) : d.children;
      if (!list) throw new Error(`parent "${parent}" not found`);
      frameId = newId(allIds(d));
      const prompt = p.prompt ?? req?.prompt ?? '';
      list.push({
        type: 'frame',
        id: frameId,
        name: p.name ?? shortName(prompt || 'drawing'),
        x: Math.round(p.x ?? box?.x ?? 0),
        y: Math.round(p.y ?? box?.y ?? 0),
        width,
        height,
        layout: 'none',
        children: [],
        aiPen: { prompt } satisfies AiPenMeta,
      } as PenNode);
    }
    const frame = locate(d, frameId)!.node;
    if (p.clear) frame.children = [];
    const kids = (frame.children ??= []);
    for (const n of nodes) {
      const copy = cloneWithNewIds(n, allIds(d));
      kids.push(copy);
      keys.push(copy.id);
    }
  });

  useStore.setState(st => ({
    aiPenRequests: p.done
      ? st.aiPenRequests.filter(r => r.id !== req?.id)
      : st.aiPenRequests.map(r => (r.id === req?.id ? { ...r, status: 'drawing', frame: frameId! } : r)),
    aiPenPasses: markup && keys.length ? [...st.aiPenPasses, { id: ++passSeq, frame: frameId!, markup, keys }] : st.aiPenPasses,
  }));
  return { frame_id: frameId!, added: keys.length, frame_size: [width, height], done: !!p.done };
}
