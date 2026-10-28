// WebGL runtime for .pen shader fills and shader effects. One shared GL context renders every shader and copies the
// result into each node's own 2D canvas, so any number of shader nodes can exist without exhausting GL contexts.
import { loadText } from './scripts';
import { parseColor } from './paint';
import { log } from '../editor/diagnostics';

// ---------- parsing ----------

export type UniformInfo = {
  name: string;
  type: string;
  label?: string;
  color?: boolean;
  default?: any;
  min?: number;
  max?: number;
  resolution?: boolean;
  time?: boolean;
  mouse?: boolean;
  sdf?: boolean;
  content?: boolean;
  backdrop?: boolean;
  mipmap?: boolean;
  description?: string;
};

export function parseShader(src: string): UniformInfo[] {
  const out: UniformInfo[] = [];
  const re = /(?:\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*)?uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+(\w+)\s*;/g;
  for (const m of src.matchAll(re)) {
    const u: UniformInfo = { name: m[3], type: m[2] };
    const desc: string[] = [];
    for (const raw of (m[1] ?? '').split('\n')) {
      const l = raw.replace(/^\s*\*?\s?/, '').trim();
      if (!l.startsWith('@')) {
        if (l) desc.push(l);
        continue;
      }
      // A line may hold several tags, e.g. "@color @default #0b0b12".
      for (const [, tag, rawArg] of l.matchAll(/@(\w+)\s*([^@]*)/g)) {
      const arg = rawArg.trim();
      switch (tag) {
        case 'label': u.label = arg.trim(); break;
        case 'color': u.color = true; break;
        case 'default': u.default = arg.trim(); break;
        case 'min': u.min = Number(arg); break;
        case 'max': u.max = Number(arg); break;
        case 'range': {
          const [lo, hi] = arg.split(',').map(Number);
          u.min = lo;
          u.max = hi;
          break;
        }
        case 'resolution': u.resolution = true; break;
        case 'time': u.time = true; break;
        case 'mouse': u.mouse = true; break;
        case 'sdf': u.sdf = true; break;
        case 'content': u.content = true; break;
        case 'backdrop': u.backdrop = true; break;
        case 'mipmap': u.mipmap = true; break;
      }
      }
    }
    if (desc.length) u.description = desc.join(' ');
    out.push(u);
  }
  return out;
}

export function isUserUniform(u: UniformInfo) {
  return !(u.resolution || u.time || u.mouse || u.sdf || u.content || u.backdrop);
}

/** Uniform value from an override (number, bool, array, "#hex", "$var" already resolved) or the @default text. */
function coerce(u: UniformInfo, v: any): any {
  const comps = ({ vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4, bvec2: 2, bvec3: 3, bvec4: 4 } as Record<string, number>)[u.type];
  if (v === undefined || v === null || v === '') return undefined;
  if (u.type === 'sampler2D') return String(v);
  if (u.type === 'bool') return v === true || v === 'true' || v === 1;
  if (comps) {
    if (Array.isArray(v)) return v.map(Number);
    const s = String(v).trim();
    if (s.startsWith('#')) {
      const c = parseColor(s);
      if (!c) return undefined;
      const arr = [c.r / 255, c.g / 255, c.b / 255, c.a];
      return arr.slice(0, comps);
    }
    const nums = s.replace(/^\w*\(|\)$/g, '').split(/[\s,]+/).filter(Boolean).map(Number);
    return nums.length === 1 ? Array(comps).fill(nums[0]) : nums;
  }
  const n = Number(v);
  return isFinite(n) ? n : undefined;
}

// ---------- engine ----------

type Compiled = { program: WebGLProgram; uniforms: UniformInfo[]; locs: Map<string, WebGLUniformLocation | null> } | { error: string };

export type TexSource = { image: TexImageSource; w: number; h: number; mipmap?: boolean } | { float: Float32Array; w: number; h: number };

const VERT = 'attribute vec2 p; void main(){ gl_Position = vec4(p, 0.0, 1.0); }';

function transformSource(src: string, uniforms: UniformInfo[]): string {
  const lines = src.split('\n');
  const head: string[] = [];
  const body: string[] = [];
  for (const l of lines) {
    if (/^\s*#\s*version/.test(l)) continue;
    if (/^\s*#\s*extension/.test(l)) head.push(l);
    else body.push(l);
  }
  let code = body.join('\n');
  code = code.replace(/\bgl_FragCoord\b/g, 'penrt_fc');
  code = code.replace(/\btextureSize\s*\(\s*(\w+)\s*,[^)]*\)/g, 'ivec2(penrt_ts_$1)');
  code = code.replace(/\bvoid\s+main\s*\(\s*(void)?\s*\)/, 'void penrt_main()');
  const samplers = uniforms.filter(u => u.type === 'sampler2D');
  return [
    ...head,
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'uniform vec2 penrt_px;',
    'uniform float penrt_scale;',
    'uniform vec2 penrt_origin;',
    'vec4 penrt_fc;',
    ...samplers.map(s => `uniform vec2 penrt_ts_${s.name};`),
    code,
    // Node coordinates: origin at the node's top-left, y pointing down, in node units (not device pixels).
    'void main(){ penrt_fc = vec4(gl_FragCoord.x / penrt_scale + penrt_origin.x, (penrt_px.y - gl_FragCoord.y) / penrt_scale + penrt_origin.y, gl_FragCoord.z, gl_FragCoord.w); penrt_main(); }',
  ].join('\n');
}

class Engine {
  canvas = document.createElement('canvas');
  gl: WebGLRenderingContext;
  floatTex: boolean;
  floatLinear: boolean;
  private programs = new Map<string, Compiled>();
  private textures = new WeakMap<object, { tex: WebGLTexture; version: number }>();
  private buffer: WebGLBuffer;

  constructor() {
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    // If the GPU drops the context (driver reset, memory pressure), start over with a fresh one on the next frame.
    this.canvas.addEventListener('webglcontextlost', e => {
      e.preventDefault();
      log('warn', 'WebGL context lost; shaders will be re-created');
      if (engine === this) engine = null;
    });
    this.floatTex = !!gl.getExtension('OES_texture_float');
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear');
    gl.getExtension('OES_standard_derivatives');
    this.buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  }

  compile(src: string): Compiled {
    const hit = this.programs.get(src);
    if (hit) return hit;
    const gl = this.gl;
    const uniforms = parseShader(src);
    const mk = (type: number, code: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, code);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile error');
      return s;
    };
    let result: Compiled;
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, mk(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, mk(gl.FRAGMENT_SHADER, transformSource(src, uniforms)));
      gl.bindAttribLocation(p, 0, 'p');
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
      const locs = new Map<string, WebGLUniformLocation | null>();
      for (const u of uniforms) {
        locs.set(u.name, gl.getUniformLocation(p, u.name));
        if (u.type === 'sampler2D') locs.set(`penrt_ts_${u.name}`, gl.getUniformLocation(p, `penrt_ts_${u.name}`));
      }
      for (const n of ['penrt_px', 'penrt_scale', 'penrt_origin']) locs.set(n, gl.getUniformLocation(p, n));
      result = { program: p, uniforms, locs };
    } catch (e) {
      result = { error: e instanceof Error ? e.message : String(e) };
    }
    this.programs.set(src, result);
    return result;
  }

  private texture(src: TexSource, key: object, version: number): WebGLTexture {
    const gl = this.gl;
    let t = this.textures.get(key);
    if (t && t.version === version) return t.tex;
    const tex = t?.tex ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if ('float' in src) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      if (this.floatTex) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, src.w, src.h, 0, gl.RGBA, gl.FLOAT, src.float);
      else {
        // Without float textures, store clamped values (distance range Â±127 units) in bytes.
        const b = new Uint8Array(src.float.length);
        for (let i = 0; i < b.length; i++) b[i] = Math.max(0, Math.min(255, src.float[i] + 128));
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, src.w, src.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, b);
      }
      const f = this.floatLinear ? gl.LINEAR : gl.NEAREST;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    } else {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src.image);
      const pot = (n: number) => (n & (n - 1)) === 0;
      if (src.mipmap && pot(src.w) && pot(src.h)) {
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      } else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.textures.set(key, { tex, version });
    return tex;
  }

  /** Renders one shader pass into `target` (a 2D canvas of pxWÃ—pxH). */
  draw(
    prog: Extract<Compiled, { program: WebGLProgram }>,
    target: HTMLCanvasElement,
    job: { pxW: number; pxH: number; scale: number; origin: [number, number]; values: Map<string, any>; textures: Map<string, { src: TexSource; key: object; version: number }> },
  ) {
    const gl = this.gl;
    if (this.canvas.width !== job.pxW || this.canvas.height !== job.pxH) {
      this.canvas.width = job.pxW;
      this.canvas.height = job.pxH;
    }
    gl.viewport(0, 0, job.pxW, job.pxH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const L = prog.locs;
    gl.uniform2f(L.get('penrt_px')!, job.pxW, job.pxH);
    gl.uniform1f(L.get('penrt_scale')!, job.scale);
    gl.uniform2f(L.get('penrt_origin')!, job.origin[0], job.origin[1]);
    let unit = 0;
    for (const u of prog.uniforms) {
      const loc = L.get(u.name);
      if (u.type === 'sampler2D') {
        const t = job.textures.get(u.name);
        gl.activeTexture(gl.TEXTURE0 + unit);
        if (t) {
          gl.bindTexture(gl.TEXTURE_2D, this.texture(t.src, t.key, t.version));
          const ts = L.get(`penrt_ts_${u.name}`);
          if (ts) gl.uniform2f(ts, t.src.w, t.src.h);
        } else gl.bindTexture(gl.TEXTURE_2D, null);
        if (loc) gl.uniform1i(loc, unit);
        unit++;
        continue;
      }
      if (!loc) continue;
      const v = job.values.get(u.name);
      if (v === undefined) continue;
      const arr = Array.isArray(v) ? v : [v];
      switch (u.type) {
        case 'float': gl.uniform1f(loc, Number(arr[0])); break;
        case 'int': case 'bool': gl.uniform1i(loc, Number(arr[0])); break;
        case 'vec2': gl.uniform2f(loc, arr[0] ?? 0, arr[1] ?? 0); break;
        case 'vec3': gl.uniform3f(loc, arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0); break;
        case 'vec4': gl.uniform4f(loc, arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 1); break;
        case 'ivec2': case 'bvec2': gl.uniform2i(loc, arr[0] ?? 0, arr[1] ?? 0); break;
        case 'ivec3': case 'bvec3': gl.uniform3i(loc, arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0); break;
        case 'ivec4': case 'bvec4': gl.uniform4i(loc, arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0, arr[3] ?? 0); break;
      }
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (target.width !== job.pxW || target.height !== job.pxH) {
      target.width = job.pxW;
      target.height = job.pxH;
    }
    const g = target.getContext('2d')!;
    g.clearRect(0, 0, job.pxW, job.pxH);
    g.drawImage(this.canvas, 0, 0);
  }
}

let engine: Engine | null = null;
let engineError = '';
function getEngine(): Engine | null {
  if (!engine && !engineError) {
    try {
      engine = new Engine();
    } catch (e) {
      engineError = String(e);
    }
  }
  return engine;
}

// ---------- signed distance fields ----------

/** 1-D squared Euclidean distance transform (Felzenszwalb & Huttenlocher). */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

function edt(grid: Float64Array, w: number, h: number) {
  const n = Math.max(w, h);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, h, d, v, z);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, w, d, v, z);
    for (let x = 0; x < w; x++) grid[y * w + x] = Math.sqrt(d[x]);
  }
}

/** SDF texture from an alpha mask: r = signed distance in node units (positive inside), gb = gradient (texel space). */
export function sdfFromAlpha(alpha: Uint8ClampedArray, w: number, h: number, unitsPerTexel: number): TexSource {
  const inside = new Float64Array(w * h);
  const outside = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = alpha[i * 4 + 3] >= 128;
    inside[i] = a ? 1e20 : 0;
    outside[i] = a ? 0 : 1e20;
  }
  edt(inside, w, h); // distance from inside pixels to the nearest outside pixel
  edt(outside, w, h);
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) dist[i] = (inside[i] > 0 ? inside[i] - 0.5 : -(outside[i] - 0.5)) * unitsPerTexel;
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = dist[y * w + Math.max(0, x - 1)];
      const r = dist[y * w + Math.min(w - 1, x + 1)];
      const u = dist[Math.max(0, y - 1) * w + x];
      const dn = dist[Math.min(h - 1, y + 1) * w + x];
      out[i * 4] = dist[i];
      out[i * 4 + 1] = (r - l) / 2 / unitsPerTexel;
      out[i * 4 + 2] = (dn - u) / 2 / unitsPerTexel;
      out[i * 4 + 3] = 1;
    }
  return { float: out, w, h };
}

// ---------- shader instances ----------

export type ShapeSpec = { kind: 'rect'; radius: number[] } | { kind: 'ellipse' } | { kind: 'path'; d: string; evenodd?: boolean };

export type ShaderPass = { url: string; uniforms: Record<string, any> };

export type ShaderConfig = {
  passes: ShaderPass[];
  /** Node size in node units. */
  width: number;
  height: number;
  /** Extra area around the node covered by the output (effects: visual bounds). */
  margin: number;
  shape: ShapeSpec | null;
  /** Fills below the shader (fill mode) or the rendered node (effect mode), in output space. */
  content: (() => Promise<HTMLCanvasElement | null>) | null;
  backdrop: (() => Promise<HTMLCanvasElement | null>) | null;
  resolveUrl: (u: string) => string;
  scale: number;
};

const imageCache = new Map<string, Promise<HTMLImageElement>>();
function loadImage(url: string): Promise<HTMLImageElement> {
  let p = imageCache.get(url);
  if (!p) {
    p = new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = () => rej(new Error(`image failed to load: ${url}`));
      img.src = url;
    });
    imageCache.set(url, p);
  }
  return p;
}

function shapeMask(shape: ShapeSpec | null, w: number, h: number, tw: number, th: number): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = tw;
  c.height = th;
  const g = c.getContext('2d')!;
  g.scale(tw / w, th / h);
  g.fillStyle = '#000';
  if (!shape || shape.kind === 'rect') {
    g.beginPath();
    const r = shape?.kind === 'rect' ? shape.radius : [0, 0, 0, 0];
    (g as any).roundRect ? (g as any).roundRect(0, 0, w, h, r) : g.rect(0, 0, w, h);
    g.fill();
  } else if (shape.kind === 'ellipse') {
    g.beginPath();
    g.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    g.fill();
  } else g.fill(new Path2D(shape.d), shape.evenodd ? 'evenodd' : 'nonzero');
  return g.getImageData(0, 0, tw, th).data;
}

/** Live animated shader instances; one requestAnimationFrame loop drives them all. */
const animated = new Set<ShaderRunner>();
let rafId = 0;
const t0 = performance.now();
function loop() {
  rafId = 0;
  if (document.hidden) {
    setTimeout(() => !rafId && animated.size && (rafId = requestAnimationFrame(loop)), 500);
    return;
  }
  for (const r of animated) r.frame();
  if (animated.size) rafId = requestAnimationFrame(loop);
}

export class ShaderRunner {
  private cfg: ShaderConfig | null = null;
  private srcs: string[] = [];
  private tex = new Map<string, { src: TexSource; key: object; version: number }>();
  private version = 0;
  private mouse: [number, number] | null = null;
  private visible = true;
  private io: IntersectionObserver;
  private moveHandler = (e: PointerEvent) => {
    const r = this.canvas.getBoundingClientRect();
    if (!this.cfg || !r.width) return;
    const s = r.width / (this.cfg.width + this.cfg.margin * 2);
    this.mouse = [(e.clientX - r.left) / s - this.cfg.margin, (e.clientY - r.top) / s - this.cfg.margin];
  };
  error = '';
  onError: ((msg: string) => void) | null = null;
  private needsAnim = false;
  private disposed = false;
  private intermediate = document.createElement('canvas');

  constructor(public canvas: HTMLCanvasElement) {
    this.io = new IntersectionObserver(es => {
      this.visible = es.some(e => e.isIntersecting);
      if (this.visible && this.needsAnim && !rafId) rafId = requestAnimationFrame(loop);
    });
    this.io.observe(canvas);
  }

  async update(cfg: ShaderConfig) {
    const v = ++this.version;
    const eng = getEngine();
    if (!eng) return this.fail(`WebGL unavailable: ${engineError}`);
    try {
      // Everything is built off to the side; the previous image keeps rendering until the new state is complete.
      const srcs = await Promise.all(cfg.passes.map(p => loadText(cfg.resolveUrl(p.url))));
      if (v !== this.version || this.disposed) return;
      const progs = srcs.map(s => eng.compile(s));
      const bad = progs.find(p => 'error' in p) as { error: string } | undefined;
      if (bad) return this.fail(`shader compile error: ${bad.error.split('\n').slice(0, 4).join(' ')}`);
      const all = progs.flatMap(p => (p as any).uniforms as UniformInfo[]);
      // Static textures: SDF of the shape, images, content and backdrop.
      const tw = Math.max(8, Math.min(512, Math.round((cfg.width + cfg.margin * 2) * Math.min(cfg.scale, 1))));
      const th = Math.max(8, Math.min(512, Math.round((cfg.height + cfg.margin * 2) * Math.min(cfg.scale, 1))));
      const fullW = cfg.width + cfg.margin * 2;
      const fullH = cfg.height + cfg.margin * 2;
      const tex = new Map<string, { src: TexSource; key: object; version: number }>();
      const content = all.some(u => u.content) || (all.some(u => u.sdf) && !cfg.shape) ? await cfg.content?.() : null;
      if (v !== this.version || this.disposed) return;
      if (content) tex.set('@content', { src: { image: content, w: content.width, h: content.height, mipmap: all.some(u => u.content && u.mipmap) }, key: content, version: v });
      if (all.some(u => u.sdf)) {
        let alpha: Uint8ClampedArray;
        if (cfg.shape) {
          // The shape occupies the node box inside the (margin-extended) output area.
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = th;
          const g = c.getContext('2d')!;
          const sx = tw / fullW;
          const sy = th / fullH;
          const mask = shapeMask(cfg.shape, cfg.width, cfg.height, Math.max(1, Math.round(cfg.width * sx)), Math.max(1, Math.round(cfg.height * sy)));
          const tmp = document.createElement('canvas');
          tmp.width = Math.max(1, Math.round(cfg.width * sx));
          tmp.height = Math.max(1, Math.round(cfg.height * sy));
          tmp.getContext('2d')!.putImageData(new ImageData(mask, tmp.width, tmp.height), 0, 0);
          g.drawImage(tmp, cfg.margin * sx, cfg.margin * sy);
          alpha = g.getImageData(0, 0, tw, th).data;
        } else if (content) {
          const c = document.createElement('canvas');
          c.width = tw;
          c.height = th;
          const g = c.getContext('2d')!;
          g.drawImage(content, 0, 0, tw, th);
          alpha = g.getImageData(0, 0, tw, th).data;
        } else alpha = new Uint8ClampedArray(tw * th * 4);
        tex.set('@sdf', { src: sdfFromAlpha(alpha, tw, th, fullW / tw), key: {}, version: v });
      }
      if (all.some(u => u.backdrop) && cfg.backdrop) {
        const bd = await cfg.backdrop();
        if (v !== this.version || this.disposed) return;
        if (bd) tex.set('@backdrop', { src: { image: bd, w: bd.width, h: bd.height, mipmap: all.some(u => u.backdrop && u.mipmap) }, key: bd, version: v });
      }
      for (const [i, p] of progs.entries()) {
        for (const u of (p as any).uniforms as UniformInfo[]) {
          if (u.type !== 'sampler2D' || !isUserUniform(u)) continue;
          const url = coerce(u, cfg.passes[i].uniforms?.[u.name] ?? u.default);
          if (!url) continue;
          try {
            const img = await loadImage(cfg.resolveUrl(url));
            tex.set(`${i}:${u.name}`, { src: { image: img, w: img.naturalWidth, h: img.naturalHeight, mipmap: u.mipmap }, key: img, version: 1 });
          } catch (e) {
            console.warn(e);
          }
        }
      }
      if (v !== this.version || this.disposed) return;
      this.cfg = cfg;
      this.srcs = srcs;
      this.tex = tex;
      this.error = '';
      this.needsAnim = all.some(u => u.time || u.mouse);
      if (this.needsAnim) {
        animated.add(this);
        if (all.some(u => u.mouse)) window.addEventListener('pointermove', this.moveHandler, { passive: true });
        if (!rafId) rafId = requestAnimationFrame(loop);
      } else {
        animated.delete(this);
        window.removeEventListener('pointermove', this.moveHandler);
      }
      this.render();
    } catch (e) {
      this.fail(e instanceof Error ? e.message : String(e));
    }
  }

  private fail(msg: string) {
    this.error = msg;
    animated.delete(this);
    const g = this.canvas.getContext('2d');
    g?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.onError?.(msg);
  }

  frame() {
    if (this.visible) this.render();
  }

  /** Zoom changed: re-render at the new resolution without rebuilding textures (no flash). */
  setScale(scale: number) {
    if (!this.cfg || this.cfg.scale === scale) return;
    this.cfg = { ...this.cfg, scale };
    if (!this.needsAnim) this.render();
  }

  hasConfig() {
    return !!this.cfg;
  }

  render() {
    const cfg = this.cfg;
    const eng = getEngine();
    if (!cfg || !eng || this.error || !this.srcs.length) return;
    const fullW = cfg.width + cfg.margin * 2;
    const fullH = cfg.height + cfg.margin * 2;
    const scale = Math.max(0.05, Math.min(cfg.scale, 2048 / Math.max(fullW, fullH)));
    const pxW = Math.max(1, Math.round(fullW * scale));
    const pxH = Math.max(1, Math.round(fullH * scale));
    const time = (performance.now() - t0) / 1000;
    let prevOut: HTMLCanvasElement | null = null;
    this.srcs.forEach((src, i) => {
      const prog = eng.compile(src);
      if ('error' in prog) return;
      const values = new Map<string, any>();
      const textures = new Map<string, { src: TexSource; key: object; version: number }>();
      for (const u of prog.uniforms) {
        if (u.resolution) values.set(u.name, [cfg.width, cfg.height]);
        else if (u.time) values.set(u.name, time);
        else if (u.mouse) values.set(u.name, this.mouse ?? [cfg.width / 2, cfg.height / 2]);
        else if (u.type === 'sampler2D') {
          const t = u.sdf
            ? this.tex.get('@sdf')
            : u.content
              ? i > 0 && prevOut
                ? { src: { image: prevOut, w: prevOut.width, h: prevOut.height, mipmap: u.mipmap }, key: prevOut, version: Math.random() }
                : this.tex.get('@content')
              : u.backdrop
                ? this.tex.get('@backdrop')
                : this.tex.get(`${i}:${u.name}`);
          if (t) textures.set(u.name, t);
        } else {
          const v = coerce(u, cfg.passes[i].uniforms?.[u.name] ?? u.default);
          if (v !== undefined) values.set(u.name, v);
        }
      }
      const last = i === this.srcs.length - 1;
      const target = last ? this.canvas : i % 2 === 0 ? this.intermediate : document.createElement('canvas');
      eng.draw(prog, target, { pxW, pxH, scale, origin: [-cfg.margin, -cfg.margin], values, textures });
      prevOut = target;
    });
  }

  dispose() {
    this.disposed = true;
    animated.delete(this);
    this.io.disconnect();
    window.removeEventListener('pointermove', this.moveHandler);
  }
}

export async function shaderUniformsFor(url: string): Promise<UniformInfo[]> {
  return parseShader(await loadText(url));
}

export const SHADER_TEMPLATE = `/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Color A
 * @color
 * @default #3B82F6
 */
uniform vec3 u_colorA;

/**
 * @label Color B
 * @color
 * @default #EC4899
 */
uniform vec3 u_colorB;

/**
 * @label Speed
 * @default 0.5
 * @range 0, 3
 */
uniform float u_speed;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float t = u_time * u_speed;
  float wave = 0.5 + 0.5 * sin(uv.x * 6.0 + t) * cos(uv.y * 4.0 - t * 0.7);
  gl_FragColor = vec4(mix(u_colorA, u_colorB, wave), 1.0);
}
`;


