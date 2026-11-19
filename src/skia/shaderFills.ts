// Shader fills in frames Skia draws. A shader fill used to send its whole frame back to the page-element renderer,
// the slow path, however small the fill. A STILL shader (one that reads no time, pointer or backdrop) always gives
// the same picture for the same inputs, so it is run once into an image, and Skia draws that image like any picture
// fill: a small version first, a larger one while something on screen shows it bigger (images.ts does both; here the
// "file" is the shader run at the size asked for). Animated shaders, shaders that read what is behind them, and
// shader effects keep the old path: their frames are drawn with page elements as before.
import type { RNode } from '../model/types';
import { parseShader, ShaderRunner, type ShapeSpec, type UniformInfo } from '../render/shaders';
import { paintFills } from '../render/ShaderLayer';
import { onAssetsChanged } from '../render/scripts';
import { fillList } from '../render/paint';
import { perfLimits } from '../editor/perfLimits';
import { kitIfLoaded } from './kit';
import { bumpImageStamp, forgetImages, getImage, registerImageSource } from './images';

/** Addresses of shader images: nothing is fetched from them (see registerImageSource); url resolvers leave blob: alone. */
const PREFIX = 'blob:pen-shader/';
export const SHADERS_LOADING = 'shaders loading';
/**
 * What a frame with a shader fill depends on besides the image: whether the shader file has been read, what it
 * needs, and whether it runs. The frame lists this key among its pictures and is checked again when it is bumped.
 */
export const shaderInfoKey = (url: string) => PREFIX + 'info/' + url;

type Info = { state: 'loading' } | { state: 'ready'; animated: boolean; backdrop: boolean; sdf: boolean } | { state: 'failed' };
const infos = new Map<string, Info>();
/** Shader files that did not compile or run: their frames go back to page elements, which show the error on the node. */
const broken = new Set<string>();
/** The last image that was ready for a fill (by node and position), shown while a changed one is being made. */
const lastReady = new Map<string, string>();
let assetEpoch = 0;
let watching = false;

function watchAssets() {
  if (watching) return;
  watching = true;
  // A shader file (or a picture it reads) changed on disk: everything made from it is made again.
  onAssetsChanged(() => {
    assetEpoch++;
    const known = [...infos.keys()];
    infos.clear();
    broken.clear();
    lastReady.clear();
    textCache.clear();
    forgetImages(PREFIX);
    for (const url of known) bumpImageStamp(shaderInfoKey(url));
  });
}

const textCache = new Map<string, Promise<string>>();
const loadText = (url: string) => {
  let p = textCache.get(url);
  if (!p) textCache.set(url, (p = fetch(url).then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))));
  return p;
};

function infoOf(url: string): Info {
  let info = infos.get(url);
  if (info) return info;
  watchAssets();
  info = { state: 'loading' };
  infos.set(url, info);
  const epoch = assetEpoch;
  loadText(url)
    .then(src => {
      if (epoch !== assetEpoch) return;
      const u: UniformInfo[] = parseShader(src);
      infos.set(url, { state: 'ready', animated: u.some(x => x.time || x.mouse), backdrop: u.some(x => x.backdrop), sdf: u.some(x => x.sdf) });
    })
    .catch(() => {
      if (epoch === assetEpoch) infos.set(url, { state: 'failed' });
    })
    .finally(() => bumpImageStamp(shaderInfoKey(url)));
  return info;
}

const isShader = (f: any) => f && typeof f === 'object' && f.type === 'shader' && f.enabled !== false && f.url;
const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

function radii(v: any): number[] {
  const r = Array.isArray(v) ? v.map(x => Math.max(0, num(x))) : [num(v), num(v), num(v), num(v)].map(x => Math.max(0, x));
  while (r.length < 4) r.push(r[r.length - 1] ?? 0);
  return r.slice(0, 4);
}

/** The outline a shader is told about (its @sdf input); undefined when Skia cannot supply it for this node. */
function shapeFor(n: RNode, p: any, needsOutline: boolean): ShapeSpec | null | undefined {
  if (n.type === 'frame' || n.type === 'rectangle') return { kind: 'rect', radius: radii(p.cornerRadius) };
  if (n.type === 'ellipse' && !num(p.innerRadius) && (p.sweepAngle === undefined || Math.abs(num(p.sweepAngle)) >= 360)) return { kind: 'ellipse' };
  // Paths, polygons, partial ellipses: Skia clips the result to the outline itself, so only a shader that READS the
  // outline needs it, and that stays with the page-element renderer.
  return needsOutline ? undefined : null;
}

/**
 * Why Skia cannot draw this shader fill: null when it can, SHADERS_LOADING while the shader file is being read
 * (the frame is tried again when it is), otherwise the reason its frame is left to the page-element renderer.
 */
export function shaderFillBlocker(resolveUrl: (u: string) => string, n: RNode, p: any, f: any): string | null {
  const url = resolveUrl(f.url);
  if (broken.has(url)) return `shader fill on ${n.key} (the shader has an error)`;
  const info = infoOf(url);
  if (info.state === 'loading') return SHADERS_LOADING;
  if (info.state === 'failed') return `shader fill on ${n.key} (the file could not be read)`;
  if (info.animated) return `animated shader fill on ${n.key}`;
  if (info.backdrop) return `shader fill on ${n.key} reads what is behind it`;
  if (shapeFor(n, p, info.sdf) === undefined) return `shader fill on ${n.key} reads the outline of a ${n.type}`;
  return null;
}

function hash(s: string): string {
  let a = 5381, b = 52711;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = (Math.imul(a, 33) ^ c) >>> 0;
    b = (Math.imul(b, 31) + c) >>> 0;
  }
  return a.toString(36) + b.toString(36) + s.length.toString(36);
}

/**
 * The shader fill `f` of node `n` (w x h node units) as a picture fill Skia can draw, or null when there is nothing
 * to draw yet. Asking starts the shader running if its image does not exist; the frame records again when it does.
 */
export function shaderFillImage(resolveUrl: (u: string) => string, n: RNode, p: any, f: any, w: number, h: number): any | null {
  if (!isShader(f) || !(w > 0) || !(h > 0)) return null;
  const url = resolveUrl(f.url);
  const info = infoOf(url);
  if (info.state !== 'ready' || info.animated || info.backdrop || broken.has(url)) return null;
  const shape = shapeFor(n, p, info.sdf);
  if (shape === undefined) return null;
  const all = fillList(p.fill);
  const at = all.indexOf(f);
  const below = (at > 0 ? all.slice(0, at) : []).filter(x => !isShader(x));
  const W = Math.round(w * 100) / 100, H = Math.round(h * 100) / 100;
  const key = PREFIX + hash(JSON.stringify([url, f.uniforms ?? {}, W, H, shape, below, assetEpoch]));
  registerImageSource(key, async side => {
    const maxScale = perfLimits().shaderMaxScale;
    const scale = Math.max(0.05, Math.min(maxScale, side / Math.max(W, H)));
    const canvas = document.createElement('canvas');
    const runner = new ShaderRunner(canvas, true);
    try {
      await runner.update({
        passes: [{ url: f.url, uniforms: f.uniforms ?? {} }],
        width: W,
        height: H,
        margin: 0,
        shape,
        content: async () => paintFills(below, W, H, Math.min(scale, 2), shape),
        backdrop: null,
        resolveUrl,
        scale,
      });
      if (runner.error) {
        // The page-element renderer shows the message on the node: hand the frame back to it.
        broken.add(url);
        bumpImageStamp(shaderInfoKey(url));
        throw new Error(runner.error);
      }
    } finally {
      runner.dispose();
    }
    return {
      // "The original" is the shader at the most it is ever drawn at: larger versions stop there.
      w0: Math.max(1, Math.round(W * maxScale)),
      h0: Math.max(1, Math.round(H * maxScale)),
      make: () => {
        const ck = kitIfLoaded();
        return ck && canvas.width > 0 && canvas.height > 0 ? ck.MakeImageFromCanvasImageSource(canvas) : null;
      },
      discard: () => undefined,
    };
  });
  // While a changed fill (a uniform being dragged) is made, the one before it stays, so the frame does not blink.
  const slot = `${n.key}#${at}`;
  let use = key;
  if (getImage(key, false).status === 'ready') lastReady.set(slot, key);
  else {
    const prev = lastReady.get(slot);
    if (prev && prev !== key && getImage(prev, false).status === 'ready') use = prev;
  }
  return { type: 'image', url: use, wanted: key, mode: 'stretch', opacity: f.opacity, blendMode: f.blendMode, shader: true };
}

/** Forget everything (Skia switched off, or another design). */
export function resetShaderFills() {
  infos.clear();
  broken.clear();
  lastReady.clear();
  textCache.clear();
}
