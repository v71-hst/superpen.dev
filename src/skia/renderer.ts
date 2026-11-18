// Which renderer draws the canvas (docs/SKIA_REWORK.md). `pen.renderer` in localStorage picks it: `dom` (the default,
// the browser draws every node), `overview` (Skia draws far frames) or `full` (Skia draws everything). If Skia cannot
// start, or loses its graphics context for good, the editor falls back to `dom` for the rest of the session.
import { useSyncExternalStore } from 'react';

export type RendererMode = 'dom' | 'overview' | 'full';

const KEY = 'pen.renderer';
const MODES: RendererMode[] = ['dom', 'overview', 'full'];

function readMode(): RendererMode {
  try {
    const v = localStorage.getItem(KEY) as RendererMode | null;
    return v && MODES.includes(v) ? v : 'dom';
  } catch {
    return 'dom';
  }
}

let requested: RendererMode = readMode();
let failure: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

/** The mode the user asked for. */
export function requestedRenderer(): RendererMode {
  return requested;
}

/** The mode in effect: the requested one, or `dom` once Skia has failed. */
export function activeRenderer(): RendererMode {
  return failure ? 'dom' : requested;
}

export function rendererFailure(): string | null {
  return failure;
}

/** Changes the switch (persisted). A new choice clears an earlier failure so Skia gets another try. */
export function setRenderer(mode: RendererMode) {
  if (!MODES.includes(mode)) throw new Error(`renderer must be one of ${MODES.join(', ')}`);
  requested = mode;
  failure = null;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // Storage blocked: the choice lasts for this session only.
  }
  emit();
}

/** Called by the Skia layer when it cannot draw: the current renderer takes over. */
export function failRenderer(reason: string) {
  if (failure) return;
  failure = reason;
  emit();
}

export function useActiveRenderer(): RendererMode {
  return useSyncExternalStore(
    l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    activeRenderer,
  );
}
