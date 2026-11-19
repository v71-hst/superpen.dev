// The Skia canvas: one <canvas> under the editor's overlays, sized for the device pixel ratio, redrawn only when the
// view or what it shows changes. It survives graphics-context loss (the 0.3.1 invisible-frames failure): the surface
// is rebuilt on restore, and if the context does not come back, or Skia cannot start, the editor falls back to the
// DOM renderer with one log line and one toast. Frames must never go invisible.
import React, { useEffect, useRef } from 'react';
import type { CanvasKit, GrDirectContext, Surface } from 'canvaskit-wasm';
import { useStore } from '../editor/store';
import { log } from '../editor/diagnostics';
import { loadKit } from './kit';
import { failRenderer } from './renderer';
import { perfLimits } from '../editor/perfLimits';
import { liveObjects } from './lifetime';
import { drawScene, invalidateScene, noteViewChange, resetScene, sceneStats, setDrawHooks, setSceneSurface, setSurfaceReady } from './scene';
import { loadBundledFonts, onFontsChanged, fontStats, resetFonts } from './fonts';
import { onImagesChanged, imageStats, resetImages } from './images';
import { clearFrames, frameStats, onPictureDropped } from './frames';
import { dropPictureImages, pictureImageStats, resetPictureImages } from './pictureTextures';
import { registerPictureGeometry } from './pictureFrames';
import { clearParagraphs } from './painter';

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
/** What Skia holds on the graphics card (textures of pictures, copies and glyphs), for diagnose_editor. */
let gpuUsage: () => { usedMB: number; limitMB: number } | null = () => null;
let requestDraw: () => void = () => {};
let readPixel: (x: number, y: number) => number[] | null = () => null;

export function skiaStatus() {
  return { ...state, debugRects: debugRects.length, gpu: gpuUsage(), liveObjects: liveObjects(), overview: sceneStats(), pictures: frameStats(), pictureImages: pictureImageStats(), fonts: fontStats(), images: imageStats() };
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
    // One graphics context for the life of the WebGL context: a resize only replaces the surface, so everything
    // already on the graphics card (far-zoom copies, uploaded pictures) stays valid.
    let gr: GrDirectContext | null = null;
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
      setSceneSurface(null);
      try {
        surface?.delete();
      } catch {
        // The context is already gone.
      }
      surface = null;
    };

    /** The WebGL context is gone (or the layer is): everything made in it goes too. */
    const dropContext = () => {
      // Far-zoom copies are textures of this graphics context.
      resetPictureImages();
      dropSurface();
      try {
        gr?.releaseResourcesAndAbandonContext();
        gr?.delete();
      } catch {
        // Already gone.
      }
      gr = null;
      cacheLimit = 0;
    };

    const makeSurface = () => {
      dropSurface();
      if (!ck || !canvas.width || !canvas.height) return;
      if (!gr) {
        const handle = ck.GetWebGLContext(canvas, { antialias: 0 });
        gr = handle ? ck.MakeWebGLContext(handle) : null;
        if (!gr) return giveUp('could not create a WebGL context');
      }
      surface = ck.MakeOnScreenGLSurface(gr, canvas.width, canvas.height, ck.ColorSpace.SRGB);
      if (!surface) return giveUp('could not create a WebGL surface');
      setSceneSurface(surface);
      state.surface = 'ready';
      setSurfaceReady(true);
    };
    // CanvasKit 0.42's own getResourceCache…Bytes() wrappers forget to return the value: call what they wrap.
    gpuUsage = () => {
      const g = gr as any;
      return g ? { usedMB: Math.round(g._getResourceCacheUsageBytes() / 1048576), limitMB: Math.round(g._getResourceCacheLimitBytes() / 1048576) } : null;
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

    // How much Skia may keep on the graphics card. Its default (256 MB) is less than the pictures of a big design
    // take once uploaded, so they would be thrown out and uploaded again while moving around; performance mode
    // (pictures at half size) stays at the default.
    let cacheLimit = 0;
    const fitCache = () => {
      const want = (perfLimits().bitmapSide < 2048 ? 256 : 512) * 1024 * 1024;
      if (!gr || want === cacheLimit) return;
      gr.setResourceCacheLimitBytes(want);
      cacheLimit = want;
    };

    const draw = () => {
      frame = 0;
      if (!ck || !surface || state.surface !== 'ready') return;
      fitCache();
      const t0 = performance.now();
      const c = surface.getCanvas();
      c.clear(ck.TRANSPARENT);
      const { x, y, zoom } = useStore.getState().view;
      c.save();
      c.scale(state.dpr, state.dpr);
      c.translate(x, y);
      c.scale(zoom, zoom);
      try {
        drawScene(c, ck, { x: -x / zoom, y: -y / zoom, w: canvas.clientWidth / zoom, h: canvas.clientHeight / zoom });
      } catch (e) {
        // A CanvasKit failure (an abort leaves it unusable): the DOM renderer takes over; frames never go missing.
        return giveUp(`Skia failed while drawing (${e instanceof Error ? e.message : e})`);
      }
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
      dropContext();
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
    // CanvasKit aborting (e.g. out of WebAssembly memory) can surface as an uncaught error from inside the kit.
    const onError = (e: ErrorEvent) => {
      if (/Aborted\(/.test(String(e.message ?? e.error))) giveUp('CanvasKit aborted');
    };
    window.addEventListener('error', onError);
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    const ro = new ResizeObserver(fitCanvas);
    ro.observe(canvas);
    window.addEventListener('resize', fitCanvas);
    let lastView = useStore.getState().view;
    const unsub = useStore.subscribe(s => {
      if (s.view !== lastView) {
        lastView = s.view;
        noteViewChange();
        // Synchronously, so the canvas moves in the same frame as the DOM frames above it.
        drawNow();
      }
    });

    state.surface = 'loading';
    // Fonts or pictures that frames were waiting for arrived: Roots re-renders, frames re-record their pictures.
    const offFonts = onFontsChanged(invalidateScene);
    const offImages = onImagesChanged(invalidateScene);
    const offDropped = onPictureDropped(dropPictureImages);
    registerPictureGeometry(true);
    loadKit().then(
      async kit => {
        if (disposed) return;
        ck = kit;
        // Text needs a font file before Skia can draw it; the bundled Inter is the fallback for every family.
        await loadBundledFonts(kit).catch(e => log('warn', 'Skia: bundled fonts did not load', String(e)));
        if (disposed) return;
        canvas.width = 0; // forces fitCanvas to size the canvas and build the surface
        fitCanvas();
      },
      e => giveUp(`CanvasKit did not load (${e instanceof Error ? e.message : e})`),
    );

    return () => {
      disposed = true;
      offFonts();
      offImages();
      offDropped();
      registerPictureGeometry(false);
      // Everything Skia holds lives in WebAssembly memory: free it all when the layer goes away.
      clearFrames();
      clearParagraphs();
      resetPictureImages();
      resetImages();
      resetFonts();
      cancelAnimationFrame(frame);
      clearTimeout(lostTimer);
      ro.disconnect();
      window.removeEventListener('resize', fitCanvas);
      canvas.removeEventListener('webglcontextlost', onLost);
      window.removeEventListener('error', onError);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      unsub();
      setDrawHooks(null);
      setSurfaceReady(false);
      resetScene();
      dropContext();
      gpuUsage = () => null;
      requestDraw = () => {};
      readPixel = () => null;
      if (state.surface !== 'failed') state.surface = 'none';
    };
  }, []);

  return <canvas ref={ref} id="pen-skia" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />;
}
