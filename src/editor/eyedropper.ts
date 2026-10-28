// Eyedropper: pick a color from a layer on the canvas (keeps $variable links) or, where the browser supports it,
// from any pixel on screen.
import { useStore, applyProps } from './store';
import { currentTree } from './tree';
import { fillList, isEnabled } from '../render/paint';

/** First solid color (hex or $variable) of a paint value; gradients give their first stop. */
function solidOf(paint: any): string | null {
  for (const f of fillList(paint)) {
    if (!isEnabled(f)) continue;
    if (typeof f === 'string') return f;
    if (f?.type === 'color' && typeof f.color === 'string') return f.color;
    if (f?.type === 'gradient' && typeof f.colors?.[0]?.color === 'string') return f.colors[0].color;
  }
  return null;
}

/** Color of the deepest node in the chain that has a visible fill, walking up to its ancestors. */
export function colorFromChain(chain: string[]): { key: string; color: string } | null {
  const tree = currentTree();
  if (!tree) return null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const n = tree.byKey.get(chain[i]);
    const c = n && solidOf(n.props.fill);
    if (c) return { key: chain[i], color: c };
  }
  return null;
}

/** Starts picking for a color field: the next canvas click (or Escape) ends it. */
export function startPicking(onPick: (color: string) => void) {
  const s = useStore.getState();
  s.set({ pickColor: onPick, tool: 'eyedropper', prevTool: s.tool === 'eyedropper' ? s.prevTool : s.tool });
}

export function stopPicking() {
  const s = useStore.getState();
  if (s.tool === 'eyedropper' && s.pickColor) s.set({ pickColor: null, tool: s.prevTool ?? 'select' });
  else s.set({ pickColor: null });
}

/** Canvas click with the eyedropper: feed a color field, or apply the color to the selection (Shift: as stroke). */
export function pickAt(chain: string[], asStroke: boolean) {
  const s = useStore.getState();
  const hit = colorFromChain(chain);
  if (!hit) return s.notify('No solid color here');
  if (s.pickColor) {
    const cb = s.pickColor;
    stopPicking();
    return cb(hit.color);
  }
  const targets = s.selection.filter(k => k !== hit.key);
  if (!targets.length) {
    navigator.clipboard?.writeText(hit.color).catch(() => {});
    return s.notify(`Picked ${hit.color} (copied)`);
  }
  s.edit(d => {
    for (const k of targets) applyProps(d, k, { [asStroke ? 'stroke' : 'fill']: hit.color });
  });
  s.notify(`${asStroke ? 'Stroke' : 'Fill'} set to ${hit.color}`);
}

/** The browser's screen color picker (Chromium), when available. */
export const screenPickerSupported = typeof window !== 'undefined' && 'EyeDropper' in window;

export async function pickFromScreen(): Promise<string | null> {
  if (!screenPickerSupported) return null;
  try {
    const r = await new (window as any).EyeDropper().open();
    return typeof r?.sRGBHex === 'string' ? r.sRGBHex.toUpperCase() : null;
  } catch {
    return null; // cancelled
  }
}
