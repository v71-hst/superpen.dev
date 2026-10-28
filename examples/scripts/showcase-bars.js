/**
 * @schema 2.11
 * @input values: string = "42,58,51,73,66,88,79,95,84,102,97,118"
 * @input labels: string = "J,F,M,A,M,J,J,A,S,O,N,D"
 * @input barColor: color = #7C3AED
 * @input highlightColor: color = #22D3EE
 * @input highlight: number(min=0, max=11) = 11
 * @input gridColor: color = #FFFFFF14
 * @input labelColor: color = #94A3B8
 */
const values = pencil.input.values.split(",").map(Number).filter(v => !isNaN(v));
const labels = pencil.input.labels.split(",");
const W = pencil.width;
const H = pencil.height;
const labelH = 22;
const chartH = H - labelH;
const max = Math.max(...values) * 1.1;
const n = values.length;
const slot = W / n;
const barW = Math.max(4, slot * 0.56);
const nodes = [];

for (let g = 0; g <= 4; g++) {
  const y = Math.round(chartH - (chartH * g) / 4);
  nodes.push({ type: "rectangle", name: "Grid " + g, x: 0, y, width: W, height: 1, fill: pencil.input.gridColor });
}

values.forEach((v, i) => {
  const h = (v / max) * chartH;
  const active = i === Math.floor(pencil.input.highlight);
  const x = i * slot + (slot - barW) / 2;
  nodes.push({
    type: "rectangle",
    name: "Bar " + (i + 1),
    x,
    y: chartH - h,
    width: barW,
    height: h,
    cornerRadius: [6, 6, 2, 2],
    fill: {
      type: "gradient",
      gradientType: "linear",
      rotation: 0,
      colors: [
        { color: (active ? pencil.input.highlightColor : pencil.input.barColor) + "55", position: 0 },
        { color: active ? pencil.input.highlightColor : pencil.input.barColor, position: 1 },
      ],
    },
    effect: active ? { type: "shadow", shadowType: "outer", color: pencil.input.highlightColor + "88", offset: { x: 0, y: 0 }, blur: 18 } : undefined,
  });
  nodes.push({
    type: "text",
    name: "Label " + (i + 1),
    x: i * slot,
    y: chartH + 6,
    width: slot,
    textGrowth: "fixed-width",
    textAlign: "center",
    content: labels[i] || "",
    fontFamily: "Inter",
    fontSize: 11,
    fontWeight: active ? "700" : "500",
    fill: active ? pencil.input.highlightColor : pencil.input.labelColor,
  });
});

return nodes;
