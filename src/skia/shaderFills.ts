// Shader fills in frames Skia draws. A shader fill used to send its whole frame back to the page-element renderer,
// the slow path, however small the fill. A STILL shader (one that reads no time, pointer or backdrop) always gives
// the same picture for the same inputs, so it is run once into an image, and Skia draws that image like any picture
// fill: a small version first, a larger one while something on screen shows it bigger (images.ts does both; here the
// "file" is the shader run at the size asked for). Animated shaders are drawn from live textures (liveShaders.ts);
// shaders that read what is behind them get the frame drawn without the node (ShaderEnv); effects run on the node
// drawn alone (painter.ts drawShaderEffects). A still shader that fails
// (compile error, unreadable file, no WebGL) is drawn as the same error marker that path shows (errorFill).
import type { RNode } from '../model/types';
import { parseShader, ShaderRunner, type ShapeSpec, type UniformInfo } from '../render/shaders';
import { paintFills } from '../render/ShaderLayer';
import { onAssetsChanged } from '../render/scripts';
import { fillList } from '../render/paint';
import { ellipseGeometry, pathGeometry, polygonGeometry } from '../render/geometry';
import { perfLimits } from '../editor/perfLimits';
import { kitIfLoaded } from './kit';
import { bumpImageStamp, forgetImages, getImage, registerImageSource } from './images';
import { liveKey, liveScale, liveShaderError, liveShaderImage } from './liveShaders';

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
/**
 * Shader files that did not compile or run (or could not be read, or WebGL is missing), with the message: Skia draws
 * the same error marker the page-element renderer shows (errorFill). Those frames used to go back to that renderer for
 * the marker, which kept every node and shader canvas of the frame live at every zoom (docs/SKIA_REWORK.md, 2026-11-20).
 */
const broken = new Map<string, string>();
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
    brokenEffects.clear();
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

/**
 * The outline a shader is told about (its @sdf input); undefined when Skia cannot supply it for this node. Without
 * the node's size (w, h) it only answers whether it can.
 */
function shapeFor(n: RNode, p: any, needsOutline: boolean, w?: number, h?: number): ShapeSpec | null | undefined {
  if (n.type === 'frame' || n.type === 'rectangle') return { kind: 'rect', radius: radii(p.cornerRadius) };
  if (n.type === 'ellipse' && !num(p.innerRadius) && (p.sweepAngle === undefined || Math.abs(num(p.sweepAngle)) >= 360)) return { kind: 'ellipse' };
  // Paths, polygons, partial ellipses, lines: Skia clips the result to the outline itself, so only a shader that READS
  // the outline needs it.
  if (!needsOutline) return null;
  if (n.type !== 'path' && n.type !== 'polygon' && n.type !== 'ellipse' && n.type !== 'line') return undefined;
  if (w === undefined || h === undefined) return { kind: 'path', d: '' };
  // The same outline the page-element renderer gives this shader (NodeView ShapeView). Frames with such shapes used to
  // stay on that renderer, and its zoomed-out snapshots skip frames with shaders: hundreds of live shader canvases
  // far out (docs/SKIA_REWORK.md, 2026-11-20).
  let d = '';
  if (n.type === 'ellipse') d = ellipseGeometry(w, h, num(p.innerRadius), num(p.startAngle), p.sweepAngle === undefined ? 360 : num(p.sweepAngle, 360));
  else if (n.type === 'polygon') d = polygonGeometry(w, h, num(p.polygonCount, 3), num(p.cornerRadius));
  else if (n.type === 'path') d = pathGeometry(typeof p.geometry === 'string' ? p.geometry : '', w, h, p.viewBox);
  else d = `M0 0L${w} ${h}`;
  return { kind: 'path', d, evenodd: p.fillRule === 'evenodd' || (n.type === 'ellipse' && num(p.innerRadius) > 0) };
}

/**
 * Why Skia cannot draw this shader fill: null when it can, SHADERS_LOADING while the shader file is being read
 * (the frame is tried again when it is), otherwise the reason its frame is left to the page-element renderer.
 */
export function shaderFillBlocker(resolveUrl: (u: string) => string, n: RNode, p: any, f: any): string | null {
  const url = resolveUrl(f.url);
  if (broken.has(url)) return null;
  const info = infoOf(url);
  if (info.state === 'loading') return SHADERS_LOADING;
  // Not readable: it is run anyway, and fails with the page-element renderer's own message (then drawn as an error).
  if (info.state === 'failed') return null;
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
 * What a shader may need from the frame it is in (painter.ts shaderEnv): what is behind the node (@backdrop: the frame
 * drawn without it, cropped to the node's box grown by `margin`, at k pixels per unit), something that changes when
 * that does, and where the node is on screen (the pointer uniform of animated shaders).
 */
export type ShaderEnv = {
  backdrop: (k: number, margin: number) => HTMLCanvasElement | null;
  backdropSig: () => string;
  screenRect: (margin: number) => DOMRect | null;
};

/**
 * The shader fill `f` of node `n` (w x h node units) as a picture fill Skia can draw, or null when there is nothing
 * to draw yet. Asking starts the shader running if its image does not exist; the frame records again when it does.
 * An animated one is drawn from a live texture (liveShaders.ts).
 */
export function shaderFillImage(resolveUrl: (u: string) => string, n: RNode, p: any, f: any, w: number, h: number, env?: ShaderEnv): any | null {
  if (!isShader(f) || !(w > 0) || !(h > 0)) return null;
  const url = resolveUrl(f.url);
  const W = Math.round(w * 100) / 100, H = Math.round(h * 100) / 100;
  const message = broken.get(url);
  if (message !== undefined) return errorFill(message, W, H);
  const info = infoOf(url);
  if (info.state === 'loading') return null;
  const shape = shapeFor(n, p, info.state === 'ready' && info.sdf, W, H);
  if (shape === undefined) return null;
  const all = fillList(p.fill);
  const at = all.indexOf(f);
  const below = (at > 0 ? all.slice(0, at) : []).filter(x => !isShader(x));
  const readsBackdrop = info.state === 'ready' && info.backdrop && !!env;
  const backdropSig = readsBackdrop ? env!.backdropSig() : '';
  if (info.state === 'ready' && info.animated) {
    const id = `${n.key}#fill${at}`;
    const cfgKey = hash(JSON.stringify([url, f.uniforms ?? {}, W, H, shape, below, assetEpoch, backdropSig]));
    const img = liveShaderImage(
      id,
      cfgKey,
      () => {
        const scale = liveScale();
        return {
          passes: [{ url: f.url, uniforms: f.uniforms ?? {} }],
          width: W,
          height: H,
          margin: 0,
          shape,
          content: async () => paintFills(below, W, H, Math.min(scale, 2), shape),
          backdrop: readsBackdrop ? async () => env!.backdrop(Math.min(scale, 1.5), 0) : null,
          resolveUrl,
          scale,
        };
      },
      () => env?.screenRect(0) ?? null,
    );
    const err = liveShaderError(id);
    if (err) {
      broken.set(url, err);
      bumpImageStamp(shaderInfoKey(url));
      return errorFill(err, W, H);
    }
    return { type: 'image', url: liveKey(id), liveImage: img, mode: 'stretch', opacity: f.opacity, blendMode: f.blendMode, shader: true };
  }
  const key = PREFIX + hash(JSON.stringify([url, f.uniforms ?? {}, W, H, shape, below, assetEpoch, backdropSig]));
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
        backdrop: readsBackdrop ? async () => env!.backdrop(Math.min(scale, 1.5), 0) : null,
        resolveUrl,
        scale,
      });
      if (runner.error) {
        // The page-element renderer shows the message on the node: hand the frame back to it.
        broken.set(url, runner.error);
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

// ---------- shader effects ----------
// A shader effect reads the node's own rendering (@content) and draws its output in the node's place, over the node's
// box grown by a margin for shadows and blurs. A still one (no time, pointer or backdrop) is run once into a picture,
// like a still shader fill: the node is drawn alone by Skia for its @content (painter.ts drawShaderEffects). On the
// page-element renderer every effect captured its node again each time the zoom grew 1.4x, which made zooming crawl
// on designs with many of them (2 fps on a friend's PC, docs/SKIA_REWORK.md 2026-11-20).

export const isShaderEffect = (e: any) => e && typeof e === 'object' && e.type === 'shader' && e.enabled !== false && e.url;

/** Chains of effects (urls in order) that failed, with the message: the node is drawn as is with a dashed outline. */
const brokenEffects = new Map<string, string>();

/** The page-element renderer's margin around a node with a shader effect (ShaderLayer.tsx visualMargin). */
export function effectMargin(p: any): number {
  let m = 2;
  const sw = typeof p.strokeWidth === 'number' ? p.strokeWidth : 1;
  if (p.stroke) m = Math.max(m, sw + 2);
  const fx = Array.isArray(p.effect) ? p.effect : p.effect ? [p.effect] : [];
  for (const e of fx) {
    if (e.enabled === false) continue;
    if (e.type === 'shadow') m = Math.max(m, Math.abs(e.offset?.x ?? 0) + Math.abs(e.offset?.y ?? 0) + (e.blur ?? 0) * 1.5 + Math.abs(e.spread ?? 0) + 4);
    if (e.type === 'blur') m = Math.max(m, (e.radius ?? 0) * 1.5 + 4);
  }
  return Math.min(400, Math.ceil(m));
}

/** Why Skia cannot draw this shader effect (as for shaderFillBlocker); a failing one is drawn, with its outline. */
export function shaderEffectBlocker(resolveUrl: (u: string) => string, n: RNode, e: any): string | null {
  const url = resolveUrl(e.url);
  if (broken.has(url)) return null;
  const info = infoOf(url);
  if (info.state === 'loading') return SHADERS_LOADING;
  if (info.state === 'failed') return null;
  return null;
}

/**
 * The still shader effects `effects` of node `n` (w x h, output over the box grown by `margin`) as a picture fill for
 * that grown box; { error } when they fail (the page-element renderer then shows the node as is, outlined); null while
 * not ready. `signature` identifies what the node looks like (a new one runs the effects again); `content(k)` draws the
 * node alone, without these effects, at k pixels per unit, margin included.
 */
export function shaderEffectImage(
  resolveUrl: (u: string) => string,
  n: RNode,
  effects: any[],
  w: number,
  h: number,
  margin: number,
  signature: string,
  content: (k: number) => HTMLCanvasElement | null,
  env?: ShaderEnv,
): { error: string } | any | null {
  if (!effects.length || !(w > 0) || !(h > 0)) return null;
  const urls = effects.map(e => resolveUrl(e.url));
  const chain = JSON.stringify(urls);
  const failed = brokenEffects.get(chain) ?? urls.map(u => broken.get(u)).find(m => m !== undefined);
  if (failed !== undefined) return { error: failed };
  const infos = urls.map(infoOf);
  if (infos.some(i => i.state === 'loading')) return null;
  const W = Math.round(w * 100) / 100, H = Math.round(h * 100) / 100;
  const passes = effects.map(e => ({ url: e.url, uniforms: e.uniforms ?? {} }));
  const readsBackdrop = !!env && infos.some(i => i.state === 'ready' && i.backdrop);
  const backdropSig = readsBackdrop ? env!.backdropSig() : '';
  const backdrop = (scale: number) => (readsBackdrop ? async () => env!.backdrop(Math.min(scale, 1.5), margin) : null);
  const fullW = W + margin * 2, fullH = H + margin * 2;
  if (infos.some(i => i.state === 'ready' && i.animated)) {
    const id = `${n.key}#effect`;
    const cfgKey = hash(JSON.stringify([urls, passes.map(p => p.uniforms), W, H, margin, signature, assetEpoch, backdropSig]));
    const img = liveShaderImage(
      id,
      cfgKey,
      () => {
        const scale = liveScale();
        return { passes, width: W, height: H, margin, shape: null, content: async () => content(Math.min(scale, 2)), backdrop: backdrop(scale), resolveUrl, scale };
      },
      () => env?.screenRect(margin) ?? null,
    );
    const err = liveShaderError(id);
    if (err) {
      brokenEffects.set(chain, err);
      return { error: err };
    }
    return { type: 'image', url: liveKey(id), liveImage: img, mode: 'stretch', shader: true };
  }
  const key = PREFIX + 'fx/' + hash(JSON.stringify([urls, passes.map(p => p.uniforms), W, H, margin, signature, assetEpoch, backdropSig]));
  registerImageSource(key, async side => {
    const maxScale = perfLimits().shaderMaxScale;
    const scale = Math.max(0.05, Math.min(maxScale, side / Math.max(fullW, fullH)));
    const canvas = document.createElement('canvas');
    const runner = new ShaderRunner(canvas, true);
    try {
      await runner.update({ passes, width: W, height: H, margin, shape: null, content: async () => content(Math.min(scale, 2)), backdrop: backdrop(scale), resolveUrl, scale });
      if (runner.error) {
        brokenEffects.set(chain, runner.error);
        for (const u of urls) bumpImageStamp(shaderInfoKey(u));
        throw new Error(runner.error);
      }
    } finally {
      runner.dispose();
    }
    return {
      w0: Math.max(1, Math.round(fullW * maxScale)),
      h0: Math.max(1, Math.round(fullH * maxScale)),
      make: () => {
        const ck = kitIfLoaded();
        return ck && canvas.width > 0 && canvas.height > 0 ? ck.MakeImageFromCanvasImageSource(canvas) : null;
      },
      discard: () => undefined,
    };
  });
  const slot = `${n.key}#effect`;
  let use = key;
  if (getImage(key, false).status === 'ready') lastReady.set(slot, key);
  else {
    const prev = lastReady.get(slot);
    if (prev && prev !== key && getImage(prev, false).status === 'ready') use = prev;
  }
  return { type: 'image', url: use, wanted: key, mode: 'stretch', shader: true };
}

/**
 * The errors of node `n`'s shaders that have run and failed, worded as the page-element renderer's markers were
 * (data-asset-error): for the design check (agent.ts checkLayout).
 */
export function shaderErrorsOf(resolveUrl: (u: string) => string, n: RNode, p: any): string[] {
  const out: string[] = [];
  for (const f of fillList(p.fill)) {
    if (!isShader(f)) continue;
    const m = broken.get(resolveUrl(f.url));
    if (m !== undefined) out.push(`Shader error: ${m}`);
  }
  const fx = (Array.isArray(p.effect) ? p.effect : p.effect ? [p.effect] : []).filter(isShaderEffect);
  if (fx.length) {
    const urls = fx.map((e: any) => resolveUrl(e.url));
    const m = brokenEffects.get(JSON.stringify(urls)) ?? urls.map((u: string) => broken.get(u)).find((x: string | undefined) => x !== undefined);
    if (m !== undefined) out.push(`Shader effect error: ${m}`);
  }
  return out;
}

/**
 * The page-element renderer's marker for a shader that fails (ShaderLayer.tsx ShaderError: a dashed red box with
 * "Shader error: …" in it, over a cleared canvas) as a picture fill of the node's size. Not given the fill's opacity
 * or blend mode: the marker there is a separate element without them.
 */
function errorFill(message: string, W: number, H: number) {
  const key = PREFIX + 'error/' + hash(JSON.stringify([message, W, H]));
  registerImageSource(key, async side => {
    const maxScale = perfLimits().shaderMaxScale;
    const k = Math.max(0.05, Math.min(maxScale, side / Math.max(W, H)));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(W * k));
    canvas.height = Math.max(1, Math.round(H * k));
    const g = canvas.getContext('2d')!;
    g.scale(canvas.width / W, canvas.height / H);
    g.fillStyle = 'rgba(244,63,94,0.06)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#f43f5e';
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
    // 10px system-ui, 4px padding inside the 1px border, words wrapped to the box; a line that does not fit in it is
    // left out (there a cut-off line shows nothing, the room left under the last line being only its leading).
    g.save();
    g.fillStyle = '#f43f5e';
    g.font = '10px system-ui';
    g.textBaseline = 'top';
    const width = W - 10;
    let line = '', y = 5;
    for (const word of `Shader error: ${message}`.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (line && g.measureText(next).width > width) {
        g.fillText(line, 5, y);
        y += 12;
        line = word;
        if (y + 12 > H - 1) {
          line = '';
          break;
        }
      } else line = next;
    }
    if (line && y + 12 <= H - 1) g.fillText(line, 5, y);
    g.restore();
    return {
      w0: Math.max(1, Math.round(W * maxScale)),
      h0: Math.max(1, Math.round(H * maxScale)),
      make: () => {
        const ck = kitIfLoaded();
        return ck ? ck.MakeImageFromCanvasImageSource(canvas) : null;
      },
      discard: () => undefined,
    };
  });
  return { type: 'image', url: key, mode: 'stretch', shader: true, errorMarker: true };
}

/** Forget everything (Skia switched off, or another design). */
export function resetShaderFills() {
  infos.clear();
  broken.clear();
  brokenEffects.clear();
  lastReady.clear();
  textCache.clear();
}
