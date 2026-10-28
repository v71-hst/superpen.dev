/** @resolution */
uniform vec2 u_resolution;

/** @time */
uniform float u_time;

/**
 * @label Deep Color
 * @color
 * @default #0B1026
 */
uniform vec3 u_deep;

/**
 * @label Glow A
 * @color
 * @default #7C3AED
 */
uniform vec3 u_glowA;

/**
 * @label Glow B
 * @color
 * @default #06B6D4
 */
uniform vec3 u_glowB;

/**
 * @label Speed
 * @default 0.35
 * @range 0, 2
 */
uniform float u_speed;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float aspect = u_resolution.x / u_resolution.y;
  vec2 p = vec2(uv.x * aspect, uv.y) * 2.2;
  float t = u_time * u_speed;
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, -t * 0.7)));
  float f = fbm(p + 2.5 * q + vec2(t * 0.4, 0.0));
  vec3 col = u_deep;
  col = mix(col, u_glowA, smoothstep(0.35, 0.85, f) * (1.0 - uv.y * 0.6));
  col = mix(col, u_glowB, smoothstep(0.55, 0.95, q.x) * 0.75);
  float vignette = smoothstep(1.2, 0.3, length((uv - 0.5) * vec2(aspect * 0.8, 1.0)));
  col *= 0.55 + 0.45 * vignette;
  gl_FragColor = vec4(col, 1.0);
}
