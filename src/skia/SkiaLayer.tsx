// The Skia canvas: one <canvas> under the editor's overlays, sized for the device pixel ratio, redrawn only when the
// view or what it shows changes. It survives graphics-context loss (the 0.3.1 invisible-frames failure): the surface
// is rebuilt on restore, and if the context does not come back, or Skia cannot start, the editor falls back to the
// DOM renderer with one log line and one toast. Frames must never go invisible.
import React, { useEffect, useRef } from 'react';
import type { CanvasKit, Surface } from 'canvaskit-wasm';
import { useStore } from '../editor/store';
import { log } from '../editor/diagnostics';
import { loadKit } from './kit';
import { failRenderer } from './renderer';
import { liveObjects } from './lifetime';
import { drawScene, resetScene, sceneStats, setDrawHooks, setSurfaceReady } from './scene';

/** How long a lost context may take to come back before Skia gives up for this session. */
const RESTORE_TIMEOUT_MS = 5000;

/** World-space rectangles drawn on top of everything Skia draws; used by tests/skia-smoke.mjs. */
type DebugRect = { x: number; y: number; width: number; height: number; color: string };

const state = {
  surface: 'none' as 'none' | 'loading' | 'ready' | 'lost' | 'failed',
  width: 0,
  height: 0,
  dpr: 1,
  draws: 0,
  lastDrawMs: 0,
  contextLosses: 0,
  restores: 0,
};
let debugRects: DebugRect[] = [];
let requestDraw: () => void = () => {};
let readPixel: (x: number, y: number) => number[] | null = () => null;

export function skiaStatus() {
  return { ...state, debugRects: debugRects.length, liveObjects: liveObjects(), overview: sceneStats() };
}

export function setDebugRects(rects: DebugRect[]) {
  debugRects = rects;
  requestDraw();
}

/** RGBA of one device pixel of the Skia surface, read back from the GPU (tests only). */
export function readSkiaPixel(x: number, y: number): number[] | null {
  return readPixel(x, y);
}

export function SkiaLayer() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    let ck: CanvasKit | null = null;
    let surface: Surface | null = null;
    let frame = 0;
    let lostTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const giveUp = (reason: string) => {
      if (disposed) return;
      state.surface = 'failed';
      setSurfaceReady(false);
      log('warn', `Skia renderer off, using the DOM renderer: ${reason}`);
      useStore.getState().notify('GPU canvas unavailable, switched back to the standard renderer');
      failRenderer(reason);
    };

    const dropSurface = () => {
      try {
        surface?.delete();
      } catch {
        // The context is already gone.
      }
      surface = null;
    };

    const makeSurface = () => {
      dropSurface();
      if (!ck || !canvas.width || !canvas.height) return;
      surface = ck.MakeWebGLCanvasSurface(canvas, ck.ColorSpace.SRGB, { antialias: 0 });
      if (!surface) return giveUp('could not create a WebGL surface');
      state.surface = 'ready';
      setSurfaceReady(true);
    };

    const fitCanvas = () => {
      const dpr = devicePixelRatio || 1;
      const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
      if (w === canvas.width && h === canvas.height && dpr === state.dpr && surface) return;
      canvas.width = w;
      canvas.height = h;
      Object.assign(state, { width: w, height: h, dpr });
      if (state.surface !== 'lost') makeSurface();
      requestDraw();
    };

    const draw = () => {
      frame = 0;
      if (!ck || !surface || state.surface !== 'ready') return;
      const t0 = performance.now();
      const c = surface.getCanvas();
      c.clear(ck.TRANSPARENT);
      const { x, y, zoom } = useStore.getState().view;
      c.save();
      c.scale(state.dpr, state.dpr);
      c.translate(x, y);
      c.scale(zoom, zoom);
      drawScene(c, ck, { x: -x / zoom, y: -y / zoom, w: canvas.clientWidth / zoom, h: canvas.clientHeight / zoom });
      if (debugRects.length) {
        const paint = new ck.Paint();
        for (const r of debugRects) {
          paint.setColor(ck.parseColorString(r.color));
          c.drawRect(ck.XYWHRect(r.x, r.y, r.width, r.height), paint);
        }
        paint.delete();
      }
      c.restore();
      surface.flush();
      state.draws++;
      state.lastDrawMs = performance.now() - t0;
    };

    requestDraw = () => {
      if (!frame && !disposed) frame = requestAnimationFrame(draw);
    };
    const drawNow = () => {
      if (disposed) return;
      if (frame) cancelAnimationFrame(frame);
      draw();
    };
    setDrawHooks({ requestDraw, drawNow });
    readPixel = (px, py) => {
      if (!ck || !surface || state.surface !== 'ready') return null;
      // Draw now so the read sees the current scene even if no animation frame has run (background tab).
      if (frame) cancelAnimationFrame(frame);
      draw();
      const info = { width: 1, height: 1, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB };
      const out = surface.getCanvas().readPixels(px, py, info);
      return out ? Array.from(out as Uint8Array) : null;
    };

    const onLost = (e: Event) => {
      e.preventDefault(); // allows webglcontextrestored
      state.surface = 'lost';
      setSurfaceReady(false);
      state.contextLosses++;
      log('warn', 'Skia canvas lost its graphics context');
      dropSurface();
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => giveUp('the graphics context was lost and did not come back'), RESTORE_TIMEOUT_MS);
    };
    const onRestored = () => {
      clearTimeout(lostTimer);
      state.restores++;
      state.surface = 'loading';
      makeSurface();
      requestDraw();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    const ro = new ResizeObserver(fitCanvas);
    ro.observe(canvas);
    window.addEventListener('resize', fitCanvas);
    let lastView = useStore.getState().view;
    const unsub = useStore.subscribe(s => {
      if (s.view !== lastView) {
        lastView = s.view;
        // Synchronously, so the canvas moves in the same frame as the DOM frames above it.
        drawNow();
      }
    });

    state.surface = 'loading';
    loadKit().then(
      kit => {
        if (disposed) return;
        ck = kit;
        canvas.width = 0; // forces fitCanvas to size the canvas and build the surface
        fitCanvas();
      },
      e => giveUp(`CanvasKit did not load (${e instanceof Error ? e.message : e})`),
    );

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      clearTimeout(lostTimer);
      ro.disconnect();
      window.removeEventListener('resize', fitCanvas);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      unsub();
      setDrawHooks(null);
      setSurfaceReady(false);
      resetScene();
      dropSurface();
      requestDraw = () => {};
      readPixel = () => null;
      if (state.surface !== 'failed') state.surface = 'none';
    };
  }, []);

  return <canvas ref={ref} id="pen-skia" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}
