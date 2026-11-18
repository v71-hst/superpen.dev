// Lazy CanvasKit (Skia's WebAssembly build). Nothing here loads until a Skia renderer mode asks for it, so the DOM
// renderer pays nothing. The wasm file is a Vite asset next to the bundle (allowed by the webview's CSP).
import type { CanvasKit } from 'canvaskit-wasm';

let loading: Promise<CanvasKit> | null = null;
let loaded: CanvasKit | null = null;

export function loadKit(): Promise<CanvasKit> {
  loading ??= (async () => {
    const [{ default: init }, { default: wasmUrl }] = await Promise.all([import('canvaskit-wasm'), import('canvaskit-wasm/bin/canvaskit.wasm?url')]);
    loaded = await init({ locateFile: () => wasmUrl });
    return loaded;
  })();
  // A failed load (network, CSP) may be retried later.
  loading.catch(() => (loading = null));
  return loading;
}

/** The loaded kit, or null before loadKit() has finished. */
export function kitIfLoaded(): CanvasKit | null {
  return loaded;
}
