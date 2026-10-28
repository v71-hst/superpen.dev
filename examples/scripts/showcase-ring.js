/**
 * @schema 2.11
 * @input value: number(min=0, max=100) = 72
 * @input thickness: number(min=2, max=60) = 16
 * @input trackColor: color = #FFFFFF14
 * @input colorStart: color = #22D3EE
 * @input colorEnd: color = #7C3AED
 * @input label: string = "Uptime"
 */
const W = pencil.width;
const H = pencil.height;
const size = Math.min(W, H);
const x0 = (W - size) / 2;
const y0 = (H - size) / 2;
const t = pencil.input.thickness;
const pct = Math.max(0, Math.min(100, pencil.input.value));
const inner = 1 - (2 * t) / size;

return [
  { type: "ellipse", name: "Track", x: x0, y: y0, width: size, height: size, innerRadius: inner, fill: pencil.input.trackColor },
  {
    type: "ellipse",
    name: "Progress",
    x: x0,
    y: y0,
    width: size,
    height: size,
    innerRadius: inner,
    startAngle: 90,
    sweepAngle: -3.6 * pct,
    fill: {
      type: "gradient",
      gradientType: "angular",
      colors: [
        { color: pencil.input.colorStart, position: 0 },
        { color: pencil.input.colorEnd, position: 1 },
      ],
    },
  },
  {
    type: "text",
    name: "Value",
    x: x0,
    y: y0 + size / 2 - size * 0.16,
    width: size,
    textGrowth: "fixed-width",
    textAlign: "center",
    content: Math.round(pct) + "%",
    fontFamily: "Inter",
    fontSize: Math.round(size * 0.2),
    fontWeight: "800",
    fill: "#F8FAFC",
  },
  {
    type: "text",
    name: "Caption",
    x: x0,
    y: y0 + size / 2 + size * 0.06,
    width: size,
    textGrowth: "fixed-width",
    textAlign: "center",
    content: pencil.input.label,
    fontFamily: "Inter",
    fontSize: Math.round(size * 0.075),
    fontWeight: "500",
    fill: "#94A3B8",
  },
];
