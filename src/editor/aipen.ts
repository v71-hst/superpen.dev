// AI Pen: a prompt becomes editable vector paths. The extension asks the user's model provider for SVG (keys never
// reach the webview); the SVG goes through the normal SVG import, so the result is ordinary frames and paths.
import { useStore, type AiPenBox } from './store';
import { inVsCode, request } from './host';
import { elFor, insertSvg, worldRectOf } from './ops';
import { currentTree } from './tree';
import { rasterize } from '../render/rasterize';
import { log } from './diagnostics';

/** Stored on the frame AI Pen creates, so it can be refined later. */
export type AiPenMeta = { prompt: string; svg: string; model?: string };

type ModelRequest = { prompt: string; width: number; height: number; feedback?: string; previousSvg?: string; image?: string };

let seq = 0;

async function askModel(req: ModelRequest): Promise<{ svg: string; model?: string }> {
  // In VS Code the extension calls the model; the standalone editor (start.mjs) has a matching endpoint.
  const r = inVsCode
    ? await request<any>('aiPen', { request: req })
    : await fetch('/api/aipen', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }).then(x => x.json());
  if (!r || r.error) throw new Error(r?.error ?? 'no response from the extension');
  return r;
}

/** Shows a "drawing…" placeholder at the box while the model works. */
async function withJob<T>(box: AiPenBox, prompt: string, run: () => Promise<T>): Promise<T> {
  const id = ++seq;
  useStore.setState(s => ({ aiPenJobs: [...s.aiPenJobs, { id, box, prompt }] }));
  try {
    return await run();
  } finally {
    useStore.setState(s => ({ aiPenJobs: s.aiPenJobs.filter(j => j.id !== id) }));
  }
}

function nameFor(prompt: string) {
  const short = prompt.trim().replace(/\s+/g, ' ');
  return `AI Pen – ${short.length > 40 ? short.slice(0, 40) + '…' : short}`;
}

/** Draws `prompt` into `box` and returns the new frame's id. */
export async function drawWithAiPen(prompt: string, box: AiPenBox): Promise<{ id: string; paths: number }> {
  return withJob(box, prompt, async () => {
    const { svg, model } = await askModel({ prompt, width: box.width, height: box.height });
    const meta: { aiPen: AiPenMeta } = { aiPen: { prompt, svg, model } };
    const r = insertSvg(svg, { parent: box.parent, x: box.x, y: box.y, width: box.width, height: box.height, name: nameFor(prompt), meta });
    log('info', `AI Pen drew "${prompt.slice(0, 80)}" (${r.paths} paths, ${model ?? 'model'})`);
    return { id: r.id, paths: r.paths };
  });
}

/**
 * Redraws an AI Pen frame: the model sees the original prompt, the previous SVG and a picture of the frame as it is now
 * (so hand edits count), plus what to change. The new drawing replaces the old one in one undo step.
 */
export async function refineAiPen(key: string, feedback: string): Promise<{ id: string; paths: number }> {
  const n = currentTree()?.byKey.get(key);
  const meta = n?.props.aiPen as AiPenMeta | undefined;
  if (!n || !meta?.prompt) throw new Error('this layer was not drawn with AI Pen');
  const p = n.props;
  const width = typeof p.width === 'number' ? p.width : 256;
  const height = typeof p.height === 'number' ? p.height : 256;
  const parent = currentTree()?.parent.get(key)?.key ?? null;
  const wr = worldRectOf(key);
  const box: AiPenBox = { x: p.x ?? 0, y: p.y ?? 0, wx: wr?.x ?? 0, wy: wr?.y ?? 0, width, height, parent };
  return withJob(box, feedback || meta.prompt, async () => {
    let image: string | undefined;
    const el = elFor(key);
    if (el) {
      try {
        image = (await rasterize(el, { format: 'png', pixelRatio: Math.min(2, 768 / Math.max(width, height, 1)) })).dataUrl;
      } catch {
        image = undefined;
      }
    }
    const { svg, model } = await askModel({ prompt: meta.prompt, width, height, feedback, previousSvg: meta.svg, image });
    const r = insertSvg(svg, {
      parent,
      x: box.x,
      y: box.y,
      width,
      height,
      name: typeof p.name === 'string' ? p.name : nameFor(meta.prompt),
      meta: { aiPen: { prompt: meta.prompt, svg, model } },
      replace: key,
    });
    return { id: r.id, paths: r.paths };
  });
}

/** Runs AI Pen from the UI, reporting failures as a toast instead of throwing. */
export function runAiPen(task: () => Promise<unknown>) {
  task().catch(e => {
    log('warn', 'AI Pen failed', e);
    useStore.getState().notify(`AI Pen: ${String(e?.message ?? e)}`);
  });
}
