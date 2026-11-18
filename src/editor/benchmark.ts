// Benchmark for the Skia rework (docs/SKIA_REWORK.md): plays a fixed zoom-out, zoom-in and two pans over the open
// design and times every frame from inside the page. It runs only when the user asks (the `benchmark` MCP tool),
// edits nothing, and puts the view back. Numbers from a machine without a GPU (a container) are not meaningful.
import { useStore } from './store';
import { currentTree } from './tree';
import { canvasRect, elFor, propsRect, worldRectOf } from './ops';
import { viewChangeSource } from './diagnostics';
import { canvasHiddenIds } from './sections';
import { activeRenderer } from '../skia/renderer';

/** Frames per phase; with settling, the whole run takes 10–20 s at 60 fps. */
const STEPS = 120;
const SETTLE = 20;
/** Stops early so the reply arrives within the MCP bridge's 60 s limit even when frames are very slow. */
const TIME_LIMIT_MS = 45_000;

type View = { x: number; y: number; zoom: number };

export type PhaseResult = {
  phase: string;
  frames: number;
  medianMs: number;
  p95Ms: number;
  worstMs: number;
  over33ms: number;
  over50ms: number;
  /** Elements on the page, and inside #pen-world, when the phase ended. */
  domElements: number;
  worldElements: number;
};

const frame = () => new Promise<number>(r => requestAnimationFrame(r));

function stats(phase: string, deltas: number[]): PhaseResult {
  const s = [...deltas].sort((a, b) => a - b);
  const at = (q: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return {
    phase,
    frames: s.length,
    medianMs: r1(at(0.5)),
    p95Ms: r1(at(0.95)),
    worstMs: r1(s[s.length - 1] ?? 0),
    over33ms: s.filter(d => d > 33.4).length,
    over50ms: s.filter(d => d > 50).length,
    domElements: document.getElementsByTagName('*').length,
    worldElements: document.getElementById('pen-world')?.getElementsByTagName('*').length ?? 0,
  };
}

function setView(v: View) {
  viewChangeSource('benchmark');
  useStore.getState().setView(v);
}

export async function runBenchmark() {
  if (document.hidden) throw new Error('The editor tab must be visible: a background tab gets no animation frames to time.');
  const s = useStore.getState();
  const tree = currentTree();
  if (!tree?.roots.length) throw new Error('The design has no frames to benchmark.');
  const hidden = canvasHiddenIds(s);
  const roots = tree.roots.filter(r => r.props.enabled !== false && !hidden.has(r.key));
  const rects = roots.map(r => propsRect(r.key) ?? (elFor(r.key) ? worldRectOf(r.key) : null)).filter(Boolean) as { x: number; y: number; w: number; h: number }[];
  if (!rects.length) throw new Error('Could not find where the frames are.');
  const b = { x0: Math.min(...rects.map(r => r.x)), y0: Math.min(...rects.map(r => r.y)), x1: Math.max(...rects.map(r => r.x + r.w)), y1: Math.max(...rects.map(r => r.y + r.h)) };
  const c = canvasRect();
  const cx = (b.x0 + b.x1) / 2;
  const cy = (b.y0 + b.y1) / 2;
  const fit = Math.min(c.width / Math.max(1, b.x1 - b.x0), c.height / Math.max(1, b.y1 - b.y0)) * 0.9;
  const at = (zoom: number, x: number, y: number): View => ({ x: c.width / 2 - x * zoom, y: c.height / 2 - y * zoom, zoom });
  const lerp = (a: number, z: number, t: number) => a + (z - a) * t;
  const geo = (a: number, z: number, t: number) => a * Math.pow(z / a, t);

  const top = Math.max(1, fit);
  const far = fit * 0.8;
  const panFar = Math.min(fit * 1.5, 0.25);
  const span = (b.x1 - b.x0) / 3;
  const phases: { name: string; view: (t: number) => View }[] = [
    { name: 'zoom out', view: t => at(geo(top, far, t), cx, cy) },
    { name: 'zoom in', view: t => at(geo(far, top, t), cx, cy) },
    { name: 'pan zoomed out', view: t => at(panFar, lerp(cx - span, cx + span, t), cy) },
    { name: 'pan at 50%', view: t => at(0.5, lerp(cx - c.width / 0.5, cx + c.width / 0.5, t), cy) },
  ];

  const original = s.view;
  const t0 = performance.now();
  const results: PhaseResult[] = [];
  let stopped: string | null = null;
  try {
    for (const p of phases) {
      if (performance.now() - t0 > TIME_LIMIT_MS) {
        stopped = `stopped before "${p.name}" after ${Math.round((performance.now() - t0) / 1000)} s`;
        break;
      }
      setView(p.view(0));
      for (let i = 0; i < SETTLE; i++) await frame();
      const deltas: number[] = [];
      let last = await frame();
      for (let i = 1; i <= STEPS; i++) {
        setView(p.view(i / STEPS));
        const now = await frame();
        deltas.push(now - last);
        last = now;
        if (performance.now() - t0 > TIME_LIMIT_MS + 10_000) break;
      }
      results.push(stats(p.name, deltas));
    }
  } finally {
    setView(original);
  }
  const mem = (performance as any).memory;
  return {
    renderer: activeRenderer(),
    performanceMode: s.perfMode,
    dpr: devicePixelRatio,
    canvas: { width: Math.round(c.width), height: Math.round(c.height) },
    design: { topLevelFrames: roots.length, nodes: tree.byKey.size },
    zooms: { fit: Math.round(fit * 1000) / 1000, zoomOutFrom: top, zoomOutTo: Math.round(far * 1000) / 1000, panZoomedOut: Math.round(panFar * 1000) / 1000 },
    phases: results,
    jsHeapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    totalSeconds: Math.round((performance.now() - t0) / 100) / 10,
    stopped,
    note: 'Frame times from requestAnimationFrame in this window. JS heap only, not GPU or process memory (tests/memory.mjs measures those). Compare runs on the same machine, file and window size.',
  };
}
