/** @resolution */
uniform vec2 u_resolution;

/**
 * @content
 * @mipmap
 */
uniform sampler2D u_content;

/** @time */
uniform float u_time;

/**
 * @label Chromatic Aberration
 * @default 2.2
 * @range 0, 8
 */
uniform float u_aberration;

/**
 * @label Bloom
 * @default 0.9
 * @range 0, 3
 */
uniform float u_bloom;

/**
 * @label Bloom Radius
 * @default 7
 * @range 1, 30
 */
uniform float u_bloomRadius;

/**
 * @label Grain
 * @default 0.05
 * @range 0, 0.3
 */
uniform float u_grain;

/**
 * @label Vignette
 * @default 0.45
 * @range 0, 1
 */
uniform float u_vignette;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + u_time * 3.1) * 43758.5453); }

vec3 sampleRGB(vec2 uv, vec2 dir) {
  float r = texture2D(u_content, uv + dir).r;
  float g = texture2D(u_content, uv).g;
  float b = texture2D(u_content, uv - dir).b;
  return vec3(r, g, b);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 fromCenter = uv - 0.5;
  // Aberration grows toward the edges, like a lens.
  vec2 dir = fromCenter * (u_aberration / u_resolution) * 2.0;
  vec3 col = sampleRGB(uv, dir);
  float alpha = texture2D(u_content, uv).a;

  // Cheap bloom: bright parts spread into a soft halo.
  vec3 glow = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5236;
    for (int j = 1; j <= 2; j++) {
      vec2 o = vec2(cos(a), sin(a)) * u_bloomRadius * float(j) / u_resolution;
      vec3 s = texture2D(u_content, uv + o).rgb;
      glow += max(s - 0.45, 0.0);
    }
  }
  col += glow / 24.0 * u_bloom * vec3(0.75, 1.0, 0.85);

  float v = 1.0 - u_vignette * smoothstep(0.35, 0.85, length(fromCenter * vec2(1.0, 1.1)));
  col *= v;
  col += (hash(gl_FragCoord.xy) - 0.5) * u_grain;
  gl_FragColor = vec4(col * alpha, alpha);
}
