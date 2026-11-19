// Writes a design with many shader fills, for timing what zooming costs when there are lots of shader canvases:
// a grid of phone-sized frames, each with three shader-filled shapes (a still shader: no time input, so it only
// redraws when its size on screen changes) and some text.
// Usage: node make-shaders.mjs <out.spen> [frames=64]
import fs from 'node:fs';
import path from 'node:path';
const [, , out, framesArg = '64'] = process.argv;
if (!out) {
  console.error('usage: node make-shaders.mjs <out.spen> [frames]');
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
    ],
  });
}
fs.writeFileSync(out, JSON.stringify({ version: '2.21', children }, null, 1));
console.log(`${out}: ${n} frames, ${n * 3} shader fills`);
