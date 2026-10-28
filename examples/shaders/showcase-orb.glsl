/** @resolution */
uniform vec2 u_resolution;

/** @sdf */
uniform sampler2D u_shape;

/** @time */
uniform float u_time;

/** @mouse */
uniform vec2 u_mouse;

/**
 * @label Core
 * @color
 * @default #F472B6
 */
uniform vec3 u_core;

/**
 * @label Rim
 * @color
 * @default #6366F1
 */
uniform vec3 u_rim;

/**
 * @label Glow Depth
 * @default 60
 * @range 5, 200
 */
uniform float u_depth;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec4 sdf = texture2D(u_shape, uv);
  float d = sdf.r;
  if (d < -1.0) { gl_FragColor = vec4(0.0); return; }
  float inside = smoothstep(-1.0, 1.0, d);
  float depth = clamp(d / u_depth, 0.0, 1.0);
  vec2 light = (u_mouse / u_resolution) - uv;
  float spec = pow(max(0.0, 1.0 - length(light) * 1.6), 3.0);
  float pulse = 0.5 + 0.5 * sin(u_time * 1.5 + depth * 6.0);
  vec3 col = mix(u_rim, u_core, pow(depth, 0.6));
  col += 0.15 * pulse * u_core;
  col += spec * 0.6;
  gl_FragColor = vec4(col * inside, inside);
}
