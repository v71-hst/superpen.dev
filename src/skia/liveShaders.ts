// Animated shaders (fills and effects that read the time or the pointer) in frames Skia draws. Each one is a
// ShaderRunner animating an offscreen canvas on the shared animation loop (render/shaders.ts); its pixels are copied
// into one GPU texture per frame of animation (Surface.updateTextureFromSource), and the frame's recorded picture
// draws that texture, so the picture never has to be recorded again for the animation to move. A frame holding one
// is drawn by replaying its picture at every zoom (scene.ts: never from a still copy) and drawn again while its
// shaders animate. A shader not drawn for a moment stops animating; one not drawn for a while is freed.
import type { Image as SkImage, Surface } from 'canvaskit-wasm';
import { ShaderRunner, type ShaderConfig } from '../render/shaders';
import { bumpImageStamp } from './images';
import { free, own } from './lifetime';
import { kitIfLoaded } from './kit';
import { useStore } from '../editor/store';
import { perfLimits } from '../editor/perfLimits';

type Live = { runner: ShaderRunner; canvas: HTMLCanvasElement; image: SkImage | null; w: number; h: number; usedAt: number; config: string; version: number };

const PREFIX = 'blob:pen-live/';
const PAUSE_MS = 400;
const FREE_MS = 15000;

const lives = new Map<string, Live>();
let gpu: Surface | null = null;
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
    if (st.view.zoom === prev.view.zoom) return;
    const scale = liveScale();
    for (const l of lives.values()) l.runner.setScale(scale);
  });
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
    const canvas = document.createElement('canvas');
    const runner = new ShaderRunner(canvas, true);
    runner.screenRect = screenRect;
    l = { runner, canvas, image: null, w: 0, h: 0, usedAt: performance.now(), config: configKey, version: 0 };
    lives.set(k, l);
    const made = l;
    void runner.update(config()).then(() => {
      if (lives.get(k) === made) bumpImageStamp(k);
    });
  }
  l.usedAt = performance.now();
  ensureImage(k, l);
  if (l.image) tick();
  return l.image;
}

/** The error of live shader `id`, once it has failed (it is then drawn like a failing still shader). */
export function liveShaderError(id: string): string {
  return lives.get(liveKey(id))?.runner.error ?? '';
}

function ensureImage(k: string, l: Live) {
  if (!gpu || !l.canvas.width || !l.canvas.height) return;
  if (l.image && l.w === l.canvas.width && l.h === l.canvas.height) return;
  // A new size (the zoom changed how many pixels it needs) needs a new texture: the frame records again with it.
  const had = !!l.image;
  free(l.image);
  // A canvas is a texture source the browser uploads like an image; CanvasKit can't read its size itself.
  const ck = kitIfLoaded();
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
    if (now - l.usedAt > PAUSE_MS) l.runner.pause(false);
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
    for (const [k, l] of lives) {
      const idle = now - l.usedAt;
      if (idle > FREE_MS) {
        disposeLive(k, l);
        continue;
      }
      if (idle > PAUSE_MS) {
        l.runner.pause(true);
        continue;
      }
      ensureImage(k, l);
      if (l.image && gpu && l.canvas.width) {
        gpu.updateTextureFromSource(l.image, l.canvas as any, false);
        l.version++;
        any = true;
      }
    }
    if (any) requestDraw();
  });
}

function disposeLive(k: string, l: Live) {
  l.runner.dispose();
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

