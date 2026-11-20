// Writes a design with many shader fills, for timing what zooming costs when there are lots of shader canvases:
// a grid of phone-sized frames, each with three shader-filled shapes (a still shader: no time input, so it only
// redraws when its size on screen changes) and some text. `sdfPaths`: also that many path shapes per frame filled with
// a still shader that reads the shape's outline (@sdf), like chrome or steel effects on icons: before 2026-11-20 such
// frames stayed on the page-element renderer and were never snapshotted, so they kept every shader canvas live far out.
// `broken=1`: those paths use a shader with a compile error instead (sdf-broken.glsl): such a frame used to go back to the
// page-element renderer too, for its error marker.
// `effects`: that many small shapes per frame with a still shader EFFECT (it reads the node's own rendering, @content),
// like a halftone or CRT look: before the skia-only work such frames went to the page-element renderer, which captures
// the node again for each effect whenever the zoom grows 1.4x (2 fps while zooming on a friend's PC, 2026-11-20).
// Usage: node make-shaders.mjs <out.spen> [frames=64] [sdfPaths=0] [broken=0] [effects=0]
import fs from 'node:fs';
import path from 'node:path';
const [, , out, framesArg = '64', sdfArg = '0', brokenArg = '0', fxArg = '0'] = process.argv;
if (!out) {
  console.error('usage: node make-shaders.mjs <out.spen> [frames] [sdfPaths] [broken]');
  process.exit(2);
}
const dir = path.dirname(path.resolve(out));
fs.mkdirSync(path.join(dir, 'shaders'), { recursive: true });
// Layered value noise: enough work per pixel that redrawing a canvas is not free.
fs.writeFileSync(
  path.join(dir, 'shaders', 'still-noise.glsl'),
  `precision highp float;
/** @resolution */ uniform vec2 u_resolution;
/**
 * @label Tint
 * @color
 * @default #3A86FF
 */
uniform vec3 u_tint;
/**
 * @label Scale
 * @default 6
 * @range 1, 24
 */
uniform float u_scale;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float n = 0.0, a = 0.5;
  vec2 p = uv * u_scale;
  for (int i = 0; i < 6; i++) { n += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  vec3 c = mix(vec3(0.05, 0.06, 0.09), u_tint, smoothstep(0.25, 0.8, n));
  gl_FragColor = vec4(c, 1.0);
}
`,
);
// A still one that reads the shape's outline (@sdf): brushed metal, darker towards the edges.
fs.writeFileSync(
  path.join(dir, 'shaders', 'sdf-metal.glsl'),
  `precision highp float;
/** @resolution */ uniform vec2 u_resolution;
/** @sdf */ uniform sampler2D u_shape;
/**
 * @label Tint
 * @color
 * @default #C0C8D8
 */
uniform vec3 u_tint;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float d = texture2D(u_shape, uv).r;
  if (d < -1.0) { gl_FragColor = vec4(0.0); return; }
  float inside = smoothstep(-1.0, 1.0, d);
  float bevel = clamp(d / 6.0, 0.0, 1.0);
  float brush = 0.5 + 0.5 * sin(uv.y * 240.0 + sin(uv.x * 9.0) * 3.0);
  vec3 c = u_tint * (0.55 + 0.35 * bevel + 0.1 * brush);
  gl_FragColor = vec4(c * inside, inside);
}
`,
);
// The same with a compile error (an undeclared name), as a shader being written or one from an older version might have.
fs.writeFileSync(
  path.join(dir, 'shaders', 'sdf-broken.glsl'),
  `precision highp float;
/** @resolution */ uniform vec2 u_resolution;
/** @sdf */ uniform sampler2D u_shape;
void main() {
  float d = texture2D(u_shape, gl_FragCoord.xy / u_resolution).r;
  gl_FragColor = vec4(chrome(d), 1.0);
}
`,
);
// A still effect: halftone dots from the node's own rendering.
fs.writeFileSync(
  path.join(dir, 'shaders', 'still-halftone.glsl'),
  `precision highp float;
/** @resolution */ uniform vec2 u_resolution;
/** @content */ uniform sampler2D u_content;
/**
 * @label Dot size
 * @default 6
 * @range 2, 24
 */
uniform float u_dot;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec4 c = texture2D(u_content, uv);
  vec2 cell = mod(gl_FragCoord.xy, u_dot) - u_dot * 0.5;
  float l = dot(c.rgb, vec3(0.3, 0.59, 0.11));
  float r = u_dot * 0.5 * sqrt(1.0 - l);
  float ink = 1.0 - smoothstep(r - 0.75, r + 0.75, length(cell));
  gl_FragColor = vec4(mix(c.rgb, c.rgb * 0.35, ink), c.a);
}
`,
);
// An animated one (it reads the time), not used by the design: shaderfill.mjs switches a fill to it.
fs.writeFileSync(
  path.join(dir, 'shaders', 'moving.glsl'),
  `precision highp float;
/** @resolution */ uniform vec2 u_resolution;
/** @time */ uniform float u_time;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  gl_FragColor = vec4(uv.x, 0.5 + 0.5 * sin(u_time), uv.y, 1.0);
}
`,
);
const n = Number(framesArg);
const sdfPaths = Number(sdfArg);
// A star and a shield, in a 24-unit box like icon paths.
const SHAPES = ['M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z', 'M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z'];
const cols = Math.ceil(Math.sqrt(n));
const tints = ['#3A86FF', '#FF006E', '#8338EC', '#06D6A0', '#FFBE0B', '#FB5607'];
const children = [];
for (let i = 0; i < n; i++) {
  const fill = k => ({ type: 'shader', url: './shaders/still-noise.glsl', uniforms: { u_tint: tints[(i + k) % tints.length], u_scale: 4 + ((i + k) % 5) * 3 } });
  children.push({
    type: 'frame', id: `f${i}`, name: `Shader screen ${i + 1}`, x: (i % cols) * 470, y: Math.floor(i / cols) * 930, width: 390, height: 844, layout: 'none', fill: '#0B0C10', clip: true,
    children: [
      { type: 'rectangle', id: `f${i}a`, x: 0, y: 0, width: 390, height: 300, fill: fill(0) },
      { type: 'text', id: `f${i}t`, x: 24, y: 330, content: `Screen ${i + 1}`, fontFamily: 'Inter', fontSize: 28, fontWeight: '700', fill: '#FFFFFF' },
      { type: 'rectangle', id: `f${i}b`, x: 24, y: 400, width: 342, height: 180, cornerRadius: 24, fill: fill(1) },
      { type: 'ellipse', id: `f${i}c`, x: 115, y: 620, width: 160, height: 160, fill: fill(2) },
      ...Array.from({ length: sdfPaths }, (_, k) => ({
        type: 'path', id: `f${i}p${k}`, x: 24 + (k % 6) * 58, y: 300 + Math.floor(k / 6) * 58, width: 48, height: 48,
        geometry: SHAPES[k % SHAPES.length], viewBox: [0, 0, 24, 24],
        fill: { type: 'shader', url: Number(brokenArg) ? './shaders/sdf-broken.glsl' : './shaders/sdf-metal.glsl', uniforms: { u_tint: tints[(i + k) % tints.length] } },
      })),
      ...Array.from({ length: Number(fxArg) }, (_, k) => ({
        type: 'rectangle', id: `f${i}e${k}`, x: 24 + (k % 6) * 58, y: 790 - Math.floor(k / 6) * 58, width: 48, height: 48, cornerRadius: 10,
        fill: { type: 'gradient', gradientType: 'linear', rotation: 45, colors: [{ color: tints[(i + k) % tints.length], position: 0 }, { color: '#FFFFFF', position: 1 }] },
        effect: { type: 'shader', url: './shaders/still-halftone.glsl', uniforms: { u_dot: 4 + (k % 3) * 2 } },
      })),
    ],
  });
}
fs.writeFileSync(out, JSON.stringify({ version: '2.21', children }, null, 1));
console.log(`${out}: ${n} frames, ${n * (3 + sdfPaths)} shader fills (${n * sdfPaths} on paths reading their outline), ${n * Number(fxArg)} shader effects`);
