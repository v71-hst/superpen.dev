// Animated shaders (fills and effects that read the time or the pointer) in frames Skia draws. Each frame of
// animation is drawn by Skia into a new GPU texture (sksl.ts: the shader translated to SkSL, its inputs made once), so
// nothing is read back from the graphics card. A shader that can't run on Skia keeps the WebGL engine: a ShaderRunner
// animating an offscreen canvas, copied into a texture each frame (Surface.updateTextureFromSource). Either way the
// frame's picture is recorded again for each new frame of animation (liveStamp), a frame holding one is replayed at
// every zoom (scene.ts: never from a still copy), and a shader not drawn for a moment stops; one not drawn for a while
// is freed.
import type { Image as SkImage, Surface } from 'canvaskit-wasm';
import { ShaderRunner, type ShaderConfig } from '../render/shaders';
import { bumpImageStamp } from './images';
import { free, own } from './lifetime';
import { kitIfLoaded } from './kit';
import { skslPrepare, type SkslPrepared } from './sksl';
import { useStore } from '../editor/store';
import { perfLimits } from '../editor/perfLimits';

type Live = {
  /** The WebGL engine's runner, for a shader that can't run on Skia (null while that is being found out, or on Skia). */
  runner: ShaderRunner | null;
  canvas: HTMLCanvasElement;
  /** On Skia: the prepared shader, and when its last frame was drawn. */
  sk: SkslPrepared | null;
  skAt: number;
  cfg: ShaderConfig;
  screenRect: () => DOMRect | null;
  image: SkImage | null;
  w: number;
  h: number;
  usedAt: number;
  config: string;
  version: number;
};
const T0 = performance.now();
let pointer: [number, number] | null = null;
let viewMovedAt = 0;

const PREFIX = 'blob:pen-live/';
const PAUSE_MS = 400;
const FREE_MS = 15000;

const lives = new Map<string, Live>();
let gpu: Surface | null = null;
/** Drawing in software: live shaders are copied into a new CPU image each frame (no textures to update). */
let software = false;
export function setLiveSoftware(on: boolean) {
  software = on;
}
let requestDraw: () => void = () => {};
let ticking = false;

/** Pixels per unit a live shader renders at: what the zoom shows (the runner caps animated output's pixel count). */
export function liveScale(): number {
  return Math.max(0.05, Math.min(perfLimits().shaderMaxScale, useStore.getState().view.zoom * (devicePixelRatio || 1)));
}

let watching = false;
function watchZoom() {
  if (watching) return;
  watching = true;
  // Zooming changes how many pixels each needs (its texture is made again at the new size, see ensureImage).
  useStore.subscribe((st, prev) => {
    if (st.view !== prev.view) viewMovedAt = performance.now();
    if (st.view.zoom === prev.view.zoom) return;
    const scale = liveScale();
    for (const l of lives.values()) l.runner?.setScale(scale);
  });
  window.addEventListener('pointermove', e => (pointer = [e.clientX, e.clientY]), { passive: true });
}

/** The key a live shader's image is tracked under (a frame lists it among its pictures and records again on a bump). */
export const liveKey = (id: string) => PREFIX + id;
export const isLiveKey = (k: string) => k.startsWith(PREFIX);

/** The Skia canvas's surface (live textures belong to its graphics context) and how to ask for a draw. */
export function setLiveSurface(surface: Surface | null, draw: () => void) {
  if (surface !== gpu) {
    // Textures of another context can't be drawn: made again on the new one.
    for (const [k, l] of lives) {
      free(l.image);
      l.image = null;
      bumpImageStamp(k);
    }
  }
  gpu = surface;
  requestDraw = draw;
}

/**
 * The texture showing live shader `id` (made, and started, on first use; `config()` gives what it runs, and
 * `configKey` changes when that does), or null until its first frame exists: the frame records again then.
 */
export function liveShaderImage(id: string, configKey: string, config: () => ShaderConfig, screenRect: () => DOMRect | null): SkImage | null {
  const k = liveKey(id);
  let l = lives.get(k);
  if (l && l.config !== configKey) {
    disposeLive(k, l);
    l = undefined;
  }
  if (!l) {
    watchZoom();
    const cfg = config();
    l = { runner: null, canvas: document.createElement('canvas'), sk: null, skAt: 0, cfg, screenRect, image: null, w: 0, h: 0, usedAt: performance.now(), config: configKey, version: 0 };
    lives.set(k, l);
    const made = l;
    void (async () => {
      // On Skia if the shader translates; else the WebGL engine.
      const ck = kitIfLoaded();
      let prep: SkslPrepared | null = null;
      if (ck) {
        try {
          const content = cfg.content ? await cfg.content() : null;
          const backdrop = cfg.backdrop ? await cfg.backdrop() : null;
          prep = await skslPrepare(ck, { passes: cfg.passes, w: cfg.width, h: cfg.height, margin: cfg.margin, shape: cfg.shape, resolveUrl: cfg.resolveUrl, content: () => content, backdrop: () => backdrop }, cfg.scale);
        } catch {
          prep = null;
        }
      }
      if (lives.get(k) !== made) return prep?.release();
      if (prep) {
        made.sk = prep;
        drawSk(made);
      } else {
        const runner = new ShaderRunner(made.canvas, true);
        runner.screenRect = screenRect;
        made.runner = runner;
        await runner.update(cfg);
      }
      if (lives.get(k) === made) bumpImageStamp(k);
    })();
  }
  l.usedAt = performance.now();
  ensureImage(k, l);
  if (l.image) tick();
  return l.image;
}

/** Whether the live shader under this key (liveKey) has its first frame. */
export function liveReady(key: string): boolean {
  return !!lives.get(key)?.image;
}

/** The error of live shader `id`, once it has failed (it is then drawn like a failing still shader). */
export function liveShaderError(id: string): string {
  return lives.get(liveKey(id))?.runner?.error ?? '';
}

/** Draws the next frame of a live shader on Skia (time, pointer, the zoom's pixels) into a new texture. */
function drawSk(l: Live) {
  if (!l.sk) return;
  const now = performance.now();
  let mouse: [number, number] | undefined;
  const r = pointer && l.screenRect();
  if (r && pointer && r.width && r.height) {
    const fullW = l.cfg.width + l.cfg.margin * 2, fullH = l.cfg.height + l.cfg.margin * 2;
    mouse = [((pointer[0] - r.left) / r.width) * fullW - l.cfg.margin, ((pointer[1] - r.top) / r.height) * fullH - l.cfg.margin];
  }
  const img = l.sk.draw({ scale: liveScale(), time: (now - T0) / 1000, mouse }, gpu);
  l.skAt = now;
  if (!img) return;
  free(l.image);
  l.image = own(img, 'liveImage');
  l.w = img.width();
  l.h = img.height();
  l.version++;
}

function ensureImage(k: string, l: Live) {
  if (!l.runner || !gpu || !l.canvas.width || !l.canvas.height) return;
  if (l.image && l.w === l.canvas.width && l.h === l.canvas.height) return;
  // A new size (the zoom changed how many pixels it needs) needs a new texture: the frame records again with it.
  const had = !!l.image;
  free(l.image);
  const ck = kitIfLoaded();
  if (software) {
    if (!ck) return;
    l.image = own(ck.MakeImageFromCanvasImageSource(l.canvas), 'liveImage');
    l.w = l.canvas.width;
    l.h = l.canvas.height;
    l.version++;
    if (had) bumpImageStamp(k);
    return;
  }
  // A canvas is a texture source the browser uploads like an image; CanvasKit can't read its size itself.
  const info = ck ? { width: l.canvas.width, height: l.canvas.height, alphaType: ck.AlphaType.Unpremul, colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB } : undefined;
  l.image = own(gpu.makeImageFromTextureSource(l.canvas as any, info, false) as SkImage, 'liveImage');
  l.w = l.canvas.width;
  l.h = l.canvas.height;
  l.version++;
  if (had) bumpImageStamp(k);
}

/**
 * Changes each time one of these live shaders shows a new frame of animation. Updating a texture from its source gives
 * the image a new texture (the old one is gone), so a picture drawing it is recorded again (frames.ts framePicture).
 */
export function liveStamp(keys: readonly string[]): number {
  let s = 0;
  for (const k of keys) s += (lives.get(k)?.version ?? 0) + 1;
  return s;
}

/** The scene drew these live shaders (keys from liveKey): they keep animating. */
export function noteLiveDrawn(keys: Iterable<string>) {
  const now = performance.now();
  for (const k of keys) {
    const l = lives.get(k);
    if (!l) continue;
    if (now - l.usedAt > PAUSE_MS) l.runner?.pause(false);
    l.usedAt = now;
  }
  tick();
}

function tick() {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const now = performance.now();
    let any = false;
    // A live shader not due for its next frame yet: look again on the next frame (nothing else would ask).
    let waiting = false;
    for (const [k, l] of lives) {
      const idle = now - l.usedAt;
      if (idle > FREE_MS) {
        disposeLive(k, l);
        continue;
      }
      if (idle > PAUSE_MS) {
        l.runner?.pause(true);
        continue;
      }
      if (l.sk) {
        // At the shader frame rate, and not while the view moves (as the WebGL engine's loop does).
        if (now - l.skAt >= perfLimits().shaderFrameMs - 2 && now - viewMovedAt >= 140) {
          drawSk(l);
          any = true;
        } else waiting = true;
        continue;
      }
      ensureImage(k, l);
      if (l.image && gpu && l.canvas.width) {
        if (software) {
          // A new image each frame; the frame records again with it (liveStamp).
          free(l.image);
          l.image = null;
          ensureImage(k, l);
        } else {
          gpu.updateTextureFromSource(l.image, l.canvas as any, false);
          l.version++;
        }
        any = true;
      }
    }
    if (any) requestDraw();
    else if (waiting) tick();
  });
}

function disposeLive(k: string, l: Live) {
  l.runner?.dispose();
  l.sk?.release();
  free(l.image);
  lives.delete(k);
}

/** Frees every live shader (Skia switched off, another design). */
export function resetLiveShaders() {
  for (const [k, l] of lives) disposeLive(k, l);
}

export function liveShaderStats() {
  let running = 0;
  const now = performance.now();
  for (const l of lives.values()) if (now - l.usedAt <= PAUSE_MS) running++;
  return { live: lives.size, running };
}

