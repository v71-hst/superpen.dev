// Design shaders run by Skia on its own graphics context (runtime effects, SkSL) instead of the separate WebGL engine
// (render/shaders.ts). That engine copies every result into a 2D canvas, which makes the browser wait for the graphics
// card to finish all its work (a GPU stall per shader image: "freezes sometimes" while zooming a design with hundreds
// of shaders), and it compiles shaders through a second compiler. Here a shader image is drawn straight into a GPU
// texture Skia already owns: nothing is read back.
//
// The shaders are written for WebGL 1 with the editor's conventions (parseShader tags; gl_FragCoord in the node's own
// units, top-left origin, y down; u_resolution the node's size). translate() rewrites one into SkSL: main() returns
// the colour, gl_FragCoord is the local coordinate Skia passes, sampler2D inputs become child shaders sampled at pixel
// positions (premultiplied, as the WebGL engine uploads them), the outline input (@sdf) is stored in 8-bit channels and
// decoded and interpolated in the shader. Whatever cannot be translated faithfully (derivatives, macros with
// arguments, conditional compilation, gl_FragCoord outside main, uniform arrays) returns null: that shader keeps the
// WebGL engine, so a translation gap never draws something wrong.
import type { CanvasKit, Image as SkImage, RuntimeEffect, Shader, Surface } from 'canvaskit-wasm';
import type { ShapeSpec, UniformInfo, TexSource } from '../render/shaders';
import { isObjectRef, parseShader, sdfFromAlpha, shapeMask } from '../render/shaders';
import { loadText } from '../render/scripts';
import { free } from './lifetime';

export type Translated = { sksl: string; samplers: UniformInfo[]; uniforms: UniformInfo[] };

/** SDF distances are stored as (d * SDF_SCALE + 32768) in 16 bits: 1/16 unit steps, up to ±2048 units. */
const SDF_SCALE = 16;

const translated = new Map<string, Translated | null>();

/** Index of the bracket closing the one at `open` (balanced), or -1. */
function closing(s: string, open: number): number {
  const pair: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const want = pair[s[open]];
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === s[open]) depth++;
    else if (s[i] === want && --depth === 0) return i;
  }
  return -1;
}

/** The shader's SkSL, or null when it can't be translated faithfully (it then runs on the WebGL engine). */
export function translate(src: string): Translated | null {
  if (translated.has(src)) return translated.get(src)!;
  let out: Translated | null = null;
  try {
    out = translateUncached(src);
  } catch {
    out = null;
  }
  translated.set(src, out);
  return out;
}

function translateUncached(src: string): Translated | null {
  const uniforms = parseShader(src);
  // Comments out (tags were read above): they could hide the words matched below.
  let code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
  // Preprocessor: #version/#extension dropped, object-like #defines substituted; anything else is not translated.
  const defines: [string, string][] = [];
  const lines: string[] = [];
  for (const l of code.split('\n')) {
    const t = l.trim();
    if (!t.startsWith('#')) {
      lines.push(l);
      continue;
    }
    if (/^#\s*(version|extension)\b/.test(t)) continue;
    const m = t.match(/^#\s*define\s+(\w+)(\s+(.*))?$/);
    if (m && !/^\w+\(/.test(t.replace(/^#\s*define\s+/, ''))) {
      defines.push([m[1], (m[3] ?? '').trim()]);
      continue;
    }
    return null;
  }
  code = lines.join('\n');
  for (let pass = 0; pass < 4; pass++) for (const [name, value] of defines) code = code.replace(new RegExp(`\\b${name}\\b`, 'g'), `(${value})`);
  if (/\b(dFdx|dFdy|fwidth|gl_FragData|texture2DLod|texture2DProj|textureCube|samplerCube|gl_PointCoord|gl_FrontFacing)\b/.test(code)) return null;
  code = code.replace(/\bprecision\s+\w+\s+\w+\s*;/g, '').replace(/\b(lowp|mediump|highp)\s+/g, '');
  if (/\buniform\s+\w+\s+\w+\s*\[/.test(code)) return null;

  // Uniforms: samplers become child shaders with their size; ints and bools are passed as floats.
  const samplers: UniformInfo[] = [];
  const conversions: [string, string][] = [];
  code = code.replace(/\buniform\s+(\w+)\s+(\w+)\s*;/g, (all, type: string, name: string) => {
    const u = uniforms.find(x => x.name === name);
    if (type === 'sampler2D') {
      samplers.push(u ?? { name, type });
      // Its sampling helper right after it, so functions declared before main() can use it.
      const helper = u?.sdf ? sdfHelper(name) : `vec4 penrt_tex_${name}(vec2 uv) { return vec4(${name}.eval(uv * penrt_ts_${name})); }`;
      return `uniform shader ${name};\nuniform vec2 penrt_ts_${name};\n${helper}\n`;
    }
    const map: Record<string, [string, (v: string) => string]> = {
      int: ['float', v => `int(${v})`],
      ivec2: ['vec2', v => `ivec2(${v})`],
      ivec3: ['vec3', v => `ivec3(${v})`],
      ivec4: ['vec4', v => `ivec4(${v})`],
      bool: ['float', v => `(${v} > 0.5)`],
      bvec2: ['vec2', v => `greaterThan(${v}, vec2(0.5))`],
      bvec3: ['vec3', v => `greaterThan(${v}, vec3(0.5))`],
      bvec4: ['vec4', v => `greaterThan(${v}, vec4(0.5))`],
    };
    if (map[type]) {
      conversions.push([name, map[type][1](`penrt_u_${name}`)]);
      return `uniform ${map[type][0]} penrt_u_${name};`;
    }
    if (!/^(float|vec[234]|mat[234])$/.test(type)) throw new Error(`uniform type ${type}`);
    return all;
  });
  for (const [name, use] of conversions) code = code.replace(new RegExp(`(?<!penrt_u_)\\b${name}\\b`, 'g'), use);

  // texture2D(s, uv) / texture(s, uv) -> the sampler's helper; textureSize as the WebGL engine does it.
  code = code.replace(/\btextureSize\s*\(\s*(\w+)\s*,[^)]*\)/g, 'ivec2(penrt_ts_$1)');
  for (;;) {
    const m = /\b(texture2D|texture)\s*\(/.exec(code);
    if (!m) break;
    const open = m.index + m[0].length - 1;
    const close = closing(code, open);
    if (close < 0) return null;
    const args = code.slice(open + 1, close);
    const comma = args.indexOf(',');
    const sampler = args.slice(0, comma).trim();
    if (comma < 0 || !samplers.some(s => s.name === sampler)) return null;
    code = code.slice(0, m.index) + `penrt_tex_${sampler}(${args.slice(comma + 1)})` + code.slice(close + 1);
  }

  // main(): the colour is returned; gl_FragCoord is Skia's local coordinate (the node's units, as the engine gives).
  const mm = /\bvoid\s+main\s*\(\s*(void)?\s*\)\s*\{/.exec(code);
  if (!mm) return null;
  const bodyOpen = mm.index + mm[0].length - 1;
  const bodyClose = closing(code, bodyOpen);
  if (bodyClose < 0) return null;
  const before = code.slice(0, mm.index);
  const after = code.slice(bodyClose + 1);
  if (/\bgl_Frag(Coord|Color)\b|\bdiscard\b/.test(before + after)) return null;
  let body = code.slice(bodyOpen + 1, bodyClose);
  body = body
    .replace(/\bgl_FragColor\b/g, 'penrt_out')
    .replace(/\bgl_FragCoord\b/g, 'penrt_fc')
    .replace(/\breturn\s*;/g, 'return penrt_out;')
    .replace(/\bdiscard\s*;/g, 'return vec4(0.0);');
  const sksl = `${before}\nvec4 main(vec2 penrt_coord) {\n  vec4 penrt_fc = vec4(penrt_coord, 0.0, 1.0);\n  vec4 penrt_out = vec4(0.0);\n${body}\n  return penrt_out;\n}\n${after}`;
  return { sksl, samplers, uniforms };
}

/** The outline input: distance decoded from two 8-bit channels and interpolated between texels; gradient from them. */
function sdfHelper(name: string) {
  return `float penrt_sdf_${name}(vec2 p) {
  vec4 c = vec4(${name}.eval(p));
  return (floor(c.r * 255.0 + 0.5) * 256.0 + floor(c.g * 255.0 + 0.5) - 32768.0) / ${SDF_SCALE.toFixed(1)};
}
uniform float penrt_upt_${name};
vec4 penrt_tex_${name}(vec2 uv) {
  vec2 p = uv * penrt_ts_${name} - 0.5;
  vec2 f = fract(p);
  vec2 b = floor(p) + 0.5;
  float a = penrt_sdf_${name}(b);
  float x = penrt_sdf_${name}(b + vec2(1.0, 0.0));
  float y = penrt_sdf_${name}(b + vec2(0.0, 1.0));
  float xy = penrt_sdf_${name}(b + vec2(1.0, 1.0));
  float d = mix(mix(a, x, f.x), mix(y, xy, f.x), f.y);
  return vec4(d, mix(x - a, xy - y, f.y) / penrt_upt_${name}, mix(y - a, xy - x, f.x) / penrt_upt_${name}, 1.0);
}`;
}

// ---------- running ----------

const effects = new Map<string, RuntimeEffect | null>();
let effectErrors = 0;

/** The compiled effect for a translated shader, or null if Skia rejects it (the WebGL engine runs it then). */
export function effectFor(ck: CanvasKit, src: string): { effect: RuntimeEffect; t: Translated } | null {
  const t = translate(src);
  if (!t) return null;
  let e = effects.get(t.sksl);
  if (e === undefined) {
    e = ck.RuntimeEffect.Make(t.sksl, () => effectErrors++) ?? null;
    effects.set(t.sksl, e);
  }
  return e ? { effect: e, t } : null;
}

export function skslStats() {
  let ok = 0, rejected = 0, untranslated = 0;
  for (const t of translated.values()) if (!t) untranslated++;
  for (const e of effects.values()) e ? ok++ : rejected++;
  return { effects: ok, rejected, untranslated, errors: effectErrors };
}

/** An image input: an image (premultiplied, its pixel size), or the outline as SDF data. */
export type SkslInput = { image: SkImage } | { sdf: TexSource & { float: Float32Array }; unitsPerTexel: number };

/** SDF data as an opaque 8-bit image: distance in R and G (see SDF_SCALE). */
export function sdfImage(ck: CanvasKit, sdf: { float: Float32Array; w: number; h: number }): SkImage | null {
  const px = new Uint8Array(sdf.w * sdf.h * 4);
  for (let i = 0; i < sdf.w * sdf.h; i++) {
    const v = Math.max(0, Math.min(65535, Math.round(sdf.float[i * 4] * SDF_SCALE + 32768)));
    px[i * 4] = v >> 8;
    px[i * 4 + 1] = v & 255;
    px[i * 4 + 3] = 255;
  }
  return ck.MakeImage({ width: sdf.w, height: sdf.h, alphaType: ck.AlphaType.Opaque, colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB }, px, sdf.w * 4);
}

export type SkslPass = {
  effect: RuntimeEffect;
  t: Translated;
  /** Uniform values set in the design (by name), as for the WebGL engine. */
  values: Record<string, any>;
};

/**
 * Draws the passes into a new image on `surface`'s graphics context: the area from (-margin, -margin) over the node's
 * box (w x h units) grown by `margin`, at `scale` pixels per unit. `inputs(i, u)` gives each pass's image inputs;
 * a pass after the first gets the one before it as its @content. Returns null if the surface can't be made.
 */
export function runSksl(
  ck: CanvasKit,
  surface: Surface,
  passes: SkslPass[],
  o: { w: number; h: number; margin: number; scale: number; time?: number; mouse?: [number, number] },
  inputs: (pass: number, u: UniformInfo) => { image: SkImage; filter?: 'nearest' | 'linear'; upt?: number } | null,
): SkImage | null {
  const fullW = o.w + o.margin * 2, fullH = o.h + o.margin * 2;
  const pxW = Math.max(1, Math.round(fullW * o.scale)), pxH = Math.max(1, Math.round(fullH * o.scale));
  let prev: SkImage | null = null;
  for (let i = 0; i < passes.length; i++) {
    const { effect, t, values } = passes[i];
    const target = surface.makeSurface({ width: pxW, height: pxH, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Premul, colorSpace: ck.ColorSpace.SRGB });
    if (!target) {
      free(prev);
      return null;
    }
    const children: Shader[] = [];
    const sizes = new Map<string, [number, number, number]>();
    for (const s of t.samplers) {
      let img: SkImage | null = null;
      let nearest = false;
      let upt = 1;
      if (s.content && i > 0 && prev) img = prev;
      else {
        const got = inputs(i, s);
        if (got) {
          img = got.image;
          nearest = got.filter === 'nearest';
          upt = got.upt ?? 1;
        }
      }
      if (img) {
        children.push(img.makeShaderOptions(ck.TileMode.Clamp, ck.TileMode.Clamp, nearest ? ck.FilterMode.Nearest : ck.FilterMode.Linear, ck.MipmapMode.None));
        sizes.set(s.name, [img.width(), img.height(), upt]);
      } else {
        children.push(ck.Shader.MakeColor(ck.TRANSPARENT, ck.ColorSpace.SRGB));
        sizes.set(s.name, [1, 1, 1]);
      }
    }
    const data = new Float32Array(effect.getUniformFloatCount());
    for (let k = 0; k < effect.getUniformCount(); k++) {
      const name = effect.getUniformName(k);
      const slot = effect.getUniform(k).slot;
      const put = (v: number[]) => v.forEach((x, j) => (data[slot + j] = Number(x) || 0));
      if (name.startsWith('penrt_ts_')) put(sizes.get(name.slice(9))?.slice(0, 2) ?? [1, 1]);
      else if (name.startsWith('penrt_upt_')) put([sizes.get(name.slice(10))?.[2] ?? 1]);
      else {
        const raw = name.startsWith('penrt_u_') ? name.slice(8) : name;
        const u = t.uniforms.find(x => x.name === raw);
        if (!u) continue;
        if (u.resolution) put([o.w, o.h]);
        else if (u.time) put([o.time ?? 0]);
        else if (u.mouse) put(o.mouse ?? [o.w / 2, o.h / 2]);
        else {
          const v = coerceValue(u, values[u.name] ?? u.default);
          if (v !== undefined) put(Array.isArray(v) ? v : [v === true ? 1 : v === false ? 0 : v]);
        }
      }
    }
    const shader = effect.makeShaderWithChildren(data, children);
    const c = target.getCanvas();
    c.clear(ck.TRANSPARENT);
    c.scale(o.scale, o.scale);
    c.translate(o.margin, o.margin);
    const paint = new ck.Paint();
    paint.setShader(shader);
    c.drawRect(ck.XYWHRect(-o.margin, -o.margin, fullW, fullH), paint);
    paint.delete();
    shader.delete();
    for (const ch of children) ch.delete();
    target.flush();
    const img = target.makeImageSnapshot();
    target.delete();
    if (prev) prev.delete();
    prev = img;
  }
  return prev;
}

/** Uniform value from the design or the @default text (render/shaders.ts coerce, for the types translate() passes). */
function coerceValue(u: UniformInfo, v: any): any {
  const comps = ({ vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4, bvec2: 2, bvec3: 3, bvec4: 4 } as Record<string, number>)[u.type];
  if (v === undefined || v === null || v === '') return undefined;
  if (u.type === 'bool') return v === true || v === 'true' || v === 1;
  if (comps) {
    if (Array.isArray(v)) return v.map(Number);
    const s = String(v).trim();
    if (s.startsWith('#')) {
      const hex = s.slice(1);
      const full = hex.length <= 4 ? [...hex].map(c => c + c).join('') : hex;
      const n = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
      const arr = [n(0), n(2), n(4), full.length >= 8 ? n(6) : 1];
      return arr.slice(0, comps);
    }
    const nums = s.replace(/^\w*\(|\)$/g, '').split(/[\s,]+/).filter(Boolean).map(Number);
    return nums.length === 1 ? Array(comps).fill(nums[0]) : nums;
  }
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

// ---------- shader images (shaderFills.ts) ----------

/** A 2D canvas's pixels as a Skia image (read on the CPU: the canvases given here are CPU canvases). */
export function canvasImage(ck: CanvasKit, canvas: HTMLCanvasElement | null): SkImage | null {
  if (!canvas || !canvas.width || !canvas.height) return null;
  const d = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, canvas.width, canvas.height);
  return ck.MakeImage({ width: d.width, height: d.height, alphaType: ck.AlphaType.Unpremul, colorType: ck.ColorType.RGBA_8888, colorSpace: ck.ColorSpace.SRGB }, new Uint8Array(d.data.buffer), d.width * 4);
}

const pictureInputs = new Map<string, Promise<HTMLImageElement>>();
function loadPicture(url: string): Promise<HTMLImageElement> {
  let p = pictureInputs.get(url);
  if (!p) {
    p = new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = () => rej(new Error(`image failed to load: ${url}`));
      img.src = url;
    });
    pictureInputs.set(url, p);
  }
  return p;
}

let cpuHost: Surface | null = null;

export type SkslJob = {
  passes: { url: string; uniforms: Record<string, any> }[];
  w: number;
  h: number;
  margin: number;
  shape: ShapeSpec | null;
  resolveUrl: (u: string) => string;
  /** The fills under a fill / the node itself (effects), at k pixels per unit, margin included. */
  content: ((k: number) => HTMLCanvasElement | null) | null;
  /** What is behind the node, at k pixels per unit, margin included. */
  backdrop: ((k: number) => HTMLCanvasElement | null) | null;
};

/** What a job's passes need, made once: the effects and their image inputs, and a way to draw them. */
export type SkslPrepared = {
  draw: (o: { scale: number; time?: number; mouse?: [number, number] }, gpu: Surface | null) => SkImage | null;
  release: () => void;
};

/**
 * Prepares `job` for Skia at `scale` (inputs sized for it), or null when a pass can't run on Skia (not translated, or
 * rejected): the WebGL engine runs it then.
 */
export async function skslPrepare(ck: CanvasKit, job: SkslJob, scale: number): Promise<SkslPrepared | null> {
  const srcs = await Promise.all(job.passes.map(p => loadText(job.resolveUrl(p.url))));
  const effs = srcs.map(s => effectFor(ck, s));
  if (effs.some(e => !e)) return null;
  const passes: SkslPass[] = effs.map((e, i) => ({ effect: e!.effect, t: e!.t, values: job.passes[i].uniforms ?? {} }));
  const fullW = job.w + job.margin * 2, fullH = job.h + job.margin * 2;
  const all = passes.flatMap(p => p.t.uniforms);
  const objectInput = passes.some(p => p.t.samplers.some(s => isObjectRef(p.values[s.name] ?? s.default)));
  const owned: SkImage[] = [];
  const keep = (img: SkImage | null) => (img && owned.push(img), img);
  const contentCanvas = all.some(u => u.content) || objectInput || (all.some(u => u.sdf) && !job.shape) ? (job.content?.(Math.min(scale, 2)) ?? null) : null;
  const content = keep(canvasImage(ck, contentCanvas));
  const backdrop = all.some(u => u.backdrop) && job.backdrop ? keep(canvasImage(ck, job.backdrop(Math.min(scale, 1.5)))) : null;
  // The outline as the WebGL engine makes it: at most 512 texels, the shape (or the content's alpha) inside the margin.
  let sdf: SkImage | null = null;
  let upt = 1;
  if (all.some(u => u.sdf)) {
    const tw = Math.max(8, Math.min(512, Math.round(fullW * Math.min(scale, 1))));
    const th = Math.max(8, Math.min(512, Math.round(fullH * Math.min(scale, 1))));
    const c = document.createElement('canvas');
    c.width = tw;
    c.height = th;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    const sx = tw / fullW, sy = th / fullH;
    if (job.shape) {
      const mw = Math.max(1, Math.round(job.w * sx)), mh = Math.max(1, Math.round(job.h * sy));
      const tmp = document.createElement('canvas');
      tmp.width = mw;
      tmp.height = mh;
      tmp.getContext('2d', { willReadFrequently: true })!.putImageData(new ImageData(shapeMask(job.shape, job.w, job.h, mw, mh), mw, mh), 0, 0);
      g.drawImage(tmp, job.margin * sx, job.margin * sy);
    } else if (contentCanvas) g.drawImage(contentCanvas, 0, 0, tw, th);
    const field = sdfFromAlpha(g.getImageData(0, 0, tw, th).data, tw, th, fullW / tw) as { float: Float32Array; w: number; h: number };
    sdf = keep(sdfImage(ck, field));
    upt = fullW / tw;
  }
  // Picture files given as image inputs.
  const files = new Map<string, SkImage>();
  for (const [i, p] of passes.entries())
    for (const s of p.t.samplers) {
      if (s.sdf || s.content || s.backdrop) continue;
      const v = p.values[s.name] ?? s.default;
      if (!v || isObjectRef(v)) continue;
      try {
        const img = await loadPicture(job.resolveUrl(String(v)));
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d', { willReadFrequently: true })!.drawImage(img, 0, 0);
        const si = keep(canvasImage(ck, c));
        if (si) files.set(`${i}:${s.name}`, si);
      } catch {
        // Drawn without it, as the WebGL engine does.
      }
    }
  const inputs = (i: number, u: UniformInfo) => {
    if (u.sdf) return sdf ? { image: sdf, filter: 'nearest' as const, upt } : null;
    if (u.backdrop) return backdrop ? { image: backdrop } : null;
    if (u.content || isObjectRef(passes[i].values[u.name] ?? u.default)) return content ? { image: content } : null;
    const f = files.get(`${i}:${u.name}`);
    return f ? { image: f } : null;
  };
  return {
    draw: (o, gpu) => {
      const host = gpu ?? (cpuHost ??= ck.MakeSurface(1, 1));
      return host ? runSksl(ck, host, passes, { w: job.w, h: job.h, margin: job.margin, scale: o.scale, time: o.time, mouse: o.mouse }, inputs) : null;
    },
    release: () => owned.splice(0).forEach(img => img.delete()),
  };
}

/**
 * The shader image for `job` at `side` pixels on its longer side, made by Skia, as images.ts wants it (made later by
 * make()), or null when a pass can't run on Skia: the WebGL engine makes it then.
 */
export async function skslImage(ck: CanvasKit, job: SkslJob, side: number, maxScale: number, gpu: () => Surface | null): Promise<{ w0: number; h0: number; make: () => SkImage | null; discard: () => void } | null> {
  const fullW = job.w + job.margin * 2, fullH = job.h + job.margin * 2;
  const scale = Math.max(0.05, Math.min(maxScale, side / Math.max(fullW, fullH)));
  const prep = await skslPrepare(ck, job, scale);
  if (!prep) return null;
  return {
    w0: Math.max(1, Math.round(fullW * maxScale)),
    h0: Math.max(1, Math.round(fullH * maxScale)),
    make: () => {
      const out = prep.draw({ scale }, gpu());
      prep.release();
      return out;
    },
    discard: prep.release,
  };
}
