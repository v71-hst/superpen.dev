// Error capture and diagnostics: in VS Code, log lines go to the extension (Output panel + ~/.pen-editor/logs).
import { useStore } from './store';
import { inVsCode, post } from './host';

type Level = 'info' | 'warn' | 'error';

const recent: string[] = [];

export function log(level: Level, message: string, detail?: unknown) {
  const text = `${message}${detail !== undefined ? ' ' + safe(detail) : ''}`.slice(0, 4000);
  recent.push(`${new Date().toISOString()} [${level}] ${text}`);
  if (recent.length > 200) recent.shift();
  if (inVsCode) post({ type: 'log', level, message: text });
  else if (level === 'error') console.error('[pen-editor]', text);
}

function safe(v: unknown): string {
  if (v instanceof Error) return `${v.message}\n${v.stack ?? ''}`;
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Snapshot of the editor UI, logged around agent operations to diagnose "the UI broke" reports. */
export function uiSnapshot() {
  const s = useStore.getState();
  const has = (sel: string) => !!document.querySelector(sel);
  return {
    view: s.view,
    tool: s.tool,
    leftOpen: s.leftOpen,
    modal: s.modal,
    presenting: s.presenting,
    selection: s.selection.length,
    editing: !!s.editingKey,
    dom: { toolbar: has('.toolbar'), canvas: has('#pen-world'), roots: document.getElementById('pen-world')?.children.length ?? 0, right: has('.right-panel'), left: has('.left-panel') },
  };
}

/**
 * How the canvas is actually drawn right now: per top-level element whether it is a bitmap, placeholder or live,
 * which on-screen ones are culled, and which bitmaps fail to load or decode (e.g. a revoked blob URL).
 */
export async function canvasSnapshot() {
  const world = document.getElementById('pen-world');
  const c = document.getElementById('pen-canvas')?.getBoundingClientRect();
  if (!world || !c) return null;
  const all = { bitmap: 0, placeholder: 0, live: 0 };
  const onScreen = { bitmap: 0, placeholder: 0, live: 0, culled: 0 };
  const imgs: HTMLImageElement[] = [];
  for (const el of Array.from(world.children) as HTMLElement[]) {
    if (!el.dataset.k) continue;
    const kind = el.dataset.bitmap !== undefined ? 'bitmap' : el.dataset.placeholder !== undefined ? 'placeholder' : 'live';
    all[kind]++;
    const r = el.getBoundingClientRect();
    if (r.right < c.left || r.left > c.right || r.bottom < c.top || r.top > c.bottom) continue;
    onScreen[kind]++;
    if (el.style.contentVisibility === 'hidden') onScreen.culled++;
    if (kind === 'bitmap') imgs.push(el as HTMLImageElement);
  }
  const broken: string[] = [];
  await Promise.all(
    imgs.slice(0, 400).map(async img => {
      const ok = img.complete && img.naturalWidth > 0 && (await img.decode().then(() => true, () => false));
      if (!ok) broken.push(`${img.dataset.k} ${img.src.slice(0, 60)}`);
    }),
  );
  return {
    dpr: devicePixelRatio,
    world: { transform: world.style.transform, willChange: world.style.willChange, pointerEvents: world.style.pointerEvents },
    all,
    onScreen,
    brokenBitmaps: broken.length,
    brokenSample: broken.slice(0, 5),
  };
}

export function recentLog() {
  return recent.slice(-50);
}

/** Set by the code that is about to change the view, so changes from anywhere else can be logged as suspicious. */
let viewSource = '';
export function viewChangeSource(source: string) {
  viewSource = source;
}
export function takeViewSource() {
  const s = viewSource;
  viewSource = '';
  return s;
}

export function installDiagnostics() {
  window.addEventListener('error', e => log('error', `uncaught: ${e.message}`, e.error ?? `${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => log('error', 'unhandled rejection', e.reason));
  // Page-level pinch-zoom or a window/display-scale change shifts the whole canvas without the view changing.
  const vv = window.visualViewport;
  let lastScale = vv?.scale ?? 1;
  vv?.addEventListener('resize', () => {
    if (Math.abs(vv.scale - lastScale) > 0.001) log('warn', `page magnification changed to ${vv.scale.toFixed(3)} (browser pinch-zoom)`, { offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop });
    lastScale = vv.scale;
  });
  let lastDpr = devicePixelRatio;
  window.addEventListener('resize', () => {
    if (devicePixelRatio !== lastDpr) log('warn', `display scale changed ${lastDpr} -> ${devicePixelRatio} (VS Code zoom level?)`);
    lastDpr = devicePixelRatio;
  });
  log('info', 'editor started', { inVsCode, ua: navigator.userAgent.slice(0, 120) });
}
