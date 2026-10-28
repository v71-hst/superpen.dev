/** @resolution */
uniform vec2 u_resolution;

/** @content */
uniform sampler2D u_content;

/** @time */
uniform float u_time;

/**
 * @label Line Spacing
 * @default 3
 * @range 1, 12
 */
uniform float u_spacing;

/**
 * @label Chromatic Shift
 * @default 1.5
 * @range 0, 8
 */
uniform float u_shift;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float wobble = sin(gl_FragCoord.y * 0.05 + u_time * 2.0) * 0.6;
  vec2 o = vec2((u_shift + wobble) / u_resolution.x, 0.0);
  vec4 c = texture2D(u_content, uv);
  float r = texture2D(u_content, uv + o).r;
  float b = texture2D(u_content, uv - o).b;
  float line = 0.82 + 0.18 * step(0.5, fract(gl_FragCoord.y / u_spacing));
  gl_FragColor = vec4(vec3(r, c.g, b) * line, c.a);
}
