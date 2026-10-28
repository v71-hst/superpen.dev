/**
 * @schema 2.11
 * @input count: number(min=12, max=240) = 96
 * @input innerRadius: number = 132
 * @input minLength: number = 6
 * @input maxLength: number = 46
 * @input baseWidth: number = 5
 * @input color: color = #D9FBE8
 * @input tint: color = #5CE39A
 * @input denseSide: number(min=0, max=360) = 225
 */
// Radial "frost" spikes around a dial. Spikes are longer and denser toward denseSide (degrees, 0 = right, CCW).
const cx = pencil.width / 2;
const cy = pencil.height / 2;
const n = Math.floor(pencil.input.count);
const r0 = pencil.input.innerRadius;
const nodes = [];
const dense = (pencil.input.denseSide * Math.PI) / 180;

for (let i = 0; i < n; i++) {
  const a = (i / n) * Math.PI * 2 + (Math.random() - 0.5) * (Math.PI / n);
  // Bias: 0..1, highest facing denseSide.
  const bias = 0.5 + 0.5 * Math.cos(a - dense);
  if (Math.random() > 0.55 + 0.45 * bias) continue;
  const len = pencil.input.minLength + (pencil.input.maxLength - pencil.input.minLength) * Math.pow(Math.random(), 1.6) * (0.45 + 0.55 * bias);
  const w = pencil.input.baseWidth * (0.5 + Math.random() * 0.7);
  const dx = Math.cos(a), dy = -Math.sin(a);
  const px = -dy, py = dx;
  const bx = cx + dx * r0, by = cy + dy * r0;
  const tx = cx + dx * (r0 + len), ty = cy + dy * (r0 + len);
  const pts = [
    [bx + px * w / 2, by + py * w / 2],
    [tx, ty],
    [bx - px * w / 2, by - py * w / 2],
  ];
  const x0 = Math.min(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1]));
  const x1 = Math.max(...pts.map(p => p[0])), y1 = Math.max(...pts.map(p => p[1]));
  const geometry = "M" + pts.map(p => (p[0] - x0).toFixed(2) + " " + (p[1] - y0).toFixed(2)).join("L") + "Z";
  const bright = Math.random() < 0.35 + 0.4 * bias;
  nodes.push({
    type: "path",
    name: "Spike " + i,
    x: x0,
    y: y0,
    width: Math.max(0.5, x1 - x0),
    height: Math.max(0.5, y1 - y0),
    viewBox: [0, 0, Math.max(0.5, x1 - x0), Math.max(0.5, y1 - y0)],
    geometry,
    fill: {
      type: "gradient",
      gradientType: "linear",
      rotation: (Math.atan2(-dx, -dy) * 180) / Math.PI + 180,
      colors: [
        { color: (bright ? pencil.input.color : pencil.input.tint) + "00", position: 0 },
        { color: bright ? pencil.input.color : pencil.input.tint + "CC", position: 1 },
      ],
    },
  });
}
return nodes;
