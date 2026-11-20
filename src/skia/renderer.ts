// The canvas is drawn by Skia (CanvasKit): on the graphics card, or in software when there is none (SkiaLayer.tsx).
// The page-element renderer that drew every layer as browser elements (before 0.4.0, then the fallback) was removed on
// 2026-11-20 (docs/SKIA_REWORK.md, "Skia only"). What is left here: whether Skia itself failed (CanvasKit did not load,
// or aborted), which the editor reports instead of drawing.
import { useSyncExternalStore } from 'react';

let failure: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** Why Skia stopped (null while it draws). */
export function rendererFailure(): string | null {
  return failure;
}

/** Called by the Skia layer when it cannot draw at all, even in software. */
export function failRenderer(reason: string) {
  if (failure) return;
  failure = reason;
  emit();
}

export function useRendererFailure(): string | null {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    rendererFailure,
  );
}
