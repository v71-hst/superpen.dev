// Image measurement for agents tracing a reference: palette, shapes (connected components), colour runs along rows,
// columns and rings, zoomed crops with a pixel ruler, and comparing a rendered node against the reference.
// Pure canvas code: no store access, so it is safe anywhere in the import graph.

type Rgba = [number, number, number, number];

/** threshold: colour distance from the background that counts (default: the analysis threshold); lower it (e.g. 8) to see faint bands. */
export type Probes = { rows?: number[]; cols?: number[]; rings?: { cx: number; cy: number; r: number }[]; threshold?: number };
export type AnalyzeOptions = {
  region?: { x: number; y: number; w: number; h: number };
  /** Colour distance from the background that counts as a shape (0..441, default 40). */
  threshold?: number;
  max_shapes?: number;
  min_area?: number;
  probes?: Probes;
  zoom?: { x: number; y: number; w: number; h: number; scale?: number };
};

export async function loadImageData(src: string): Promise<ImageData> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0);
  return g.getImageData(0, 0, c.width, c.height);
}

const hex = (c: ArrayLike<number>) => '#' + [c[0], c[1], c[2]].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function at(img: ImageData, x: number, y: number): Rgba {
  const i = (y * img.width + x) * 4;
  const d = img.data;
  return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

/** Most common colours (4 bits per channel buckets, reported as the bucket's mean colour). */
function palette(img: ImageData, limit = 12) {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number; a: number }>();
  const d = img.data;
  const step = img.width * img.height > 1_000_000 ? 2 : 1;
  let total = 0;
  for (let y = 0; y < img.height; y += step)
    for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      const transparent = d[i + 3] < 128;
      const k = transparent ? -1 : ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
      const e = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0, a: 0 };
      e.n++;
      e.r += d[i];
      e.g += d[i + 1];
      e.b += d[i + 2];
      e.a += d[i + 3];
      buckets.set(k, e);
      total++;
    }
  return [...buckets.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .map(([k, e]) => ({ color: k === -1 ? 'transparent' : hex([e.r / e.n, e.g / e.n, e.b / e.n]), rgb: [e.r / e.n, e.g / e.n, e.b / e.n] as const, transparent: k === -1, share: e.n / total }));
}

type Shape = { x0: number; y0: number; x1: number; y1: number; area: number; r: number; g: number; b: number; sx: number; sy: number };

function shapeHint(s: Shape) {
  const w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1;
  const fill = s.area / (w * h);
  if (fill > 0.93) return w > 4 * h || h > 4 * w ? 'bar' : 'rect';
  if (fill > 0.72 && Math.abs(w - h) <= Math.max(2, 0.12 * Math.max(w, h))) return 'disc';
  if (fill > 0.4 && fill < 0.62) return 'triangle/diagonal';
  if (fill < 0.3) return 'outline/line-art';
  return 'shape';
}

export function analyze(img: ImageData, o: AnalyzeOptions = {}): string {
  const W = img.width, H = img.height;
  const rg = o.region ? { x: Math.max(0, Math.floor(o.region.x)), y: Math.max(0, Math.floor(o.region.y)), w: Math.floor(o.region.w), h: Math.floor(o.region.h) } : { x: 0, y: 0, w: W, h: H };
  rg.w = Math.min(rg.w, W - rg.x);
  rg.h = Math.min(rg.h, H - rg.y);
  const pal = palette(img);
  const bg = pal[0];
  const T = o.threshold ?? 40;
  const isFg = (x: number, y: number) => {
    const p = at(img, x, y);
    if (bg.transparent) return p[3] >= 128;
    return p[3] >= 128 && dist(p, bg.rgb) > T;
  };
  const out: string[] = [];
  out.push(`size ${W}×${H} px${o.region ? `; region x${rg.x} y${rg.y} ${rg.w}×${rg.h}` : ''}`);
  out.push(`background ${bg.color} (${Math.round(bg.share * 100)}%)`);
  out.push('palette: ' + pal.map(p => `${p.color} ${(p.share * 100).toFixed(1)}%`).join(', '));

  // Connected shapes (4-connected) of non-background pixels. Faint anti-aliased edge pixels connect a shape but are
  // left out of its box, area and colour (below half its peak contrast), so boxes match the shape's real edges.
  const contrast = (c: Rgba) => (bg.transparent ? c[3] : c[3] < 128 ? 0 : dist(c, bg.rgb));
  const label = new Int32Array(W * H);
  const stack = new Int32Array(W * H);
  const shapes: Shape[] = [];
  for (let y = rg.y; y < rg.y + rg.h; y++)
    for (let x = rg.x; x < rg.x + rg.w; x++) {
      const i0 = y * W + x;
      if (label[i0] || !isFg(x, y)) continue;
      const id = shapes.length + 1;
      let sp = 0;
      let peak = 0;
      let bx0 = x, bx1 = x, by0 = y, by1 = y;
      stack[sp++] = i0;
      label[i0] = id;
      while (sp) {
        const i = stack[--sp];
        const px = i % W, py = (i - px) / W;
        peak = Math.max(peak, contrast(at(img, px, py)));
        if (px < bx0) bx0 = px;
        if (px > bx1) bx1 = px;
        if (py < by0) by0 = py;
        if (py > by1) by1 = py;
        const nb = [px > rg.x ? i - 1 : -1, px < rg.x + rg.w - 1 ? i + 1 : -1, py > rg.y ? i - W : -1, py < rg.y + rg.h - 1 ? i + W : -1];
        for (const j of nb) {
          if (j < 0 || label[j]) continue;
          if (!isFg(j % W, (j - (j % W)) / W)) continue;
          label[j] = id;
          stack[sp++] = j;
        }
      }
      const s: Shape = { x0: bx1, y0: by1, x1: bx0, y1: by0, area: 0, r: 0, g: 0, b: 0, sx: 0, sy: 0 };
      for (let py = by0; py <= by1; py++)
        for (let px = bx0; px <= bx1; px++) {
          if (label[py * W + px] !== id) continue;
          const c = at(img, px, py);
          if (contrast(c) < peak / 2) continue;
          s.area++;
          s.r += c[0];
          s.g += c[1];
          s.b += c[2];
          s.sx += px;
          s.sy += py;
          if (px < s.x0) s.x0 = px;
          if (px > s.x1) s.x1 = px;
          if (py < s.y0) s.y0 = py;
          if (py > s.y1) s.y1 = py;
        }
      if (s.area >= (o.min_area ?? 4)) shapes.push(s);
      else shapes.push({ ...s, area: 0 }); // keeps ids aligned with labels; dropped below
    }
  for (let k = shapes.length - 1; k >= 0; k--) if (!shapes[k].area) shapes.splice(k, 1);
  shapes.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const max = o.max_shapes ?? 150;
  out.push(`shapes: ${shapes.length}${shapes.length > max ? ` (showing the ${max} largest, in reading order)` : ''} — bbox [x0,y0]-[x1,y1] (inclusive), size, area, fill ratio, mean colour, hint`);
  const shown = shapes.length > max ? [...shapes].sort((a, b) => b.area - a.area).slice(0, max).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0) : shapes;
  for (const s of shown) {
    const w = s.x1 - s.x0 + 1, h = s.y1 - s.y0 + 1;
    out.push(`  [${s.x0},${s.y0}]-[${s.x1},${s.y1}] ${w}×${h} area ${s.area} fill ${(s.area / (w * h)).toFixed(2)} ${hex([s.r / s.area, s.g / s.area, s.b / s.area])} centre (${(s.sx / s.area).toFixed(1)},${(s.sy / s.area).toFixed(1)}) ${shapeHint(s)}`);
  }

  // Runs of non-background colour along probes. Anti-aliased ends are trimmed at half the run's contrast, so edges
  // land where the shape covers half a pixel (what you'd type as its coordinates).
  const PT = o.probes?.threshold ?? T;
  const runs = (get: (i: number) => Rgba, len: number, label: (a: number, b: number) => string) => {
    const segs: string[] = [];
    let i = 0;
    while (i < len) {
      if (contrast(get(i)) <= PT) {
        i++;
        continue;
      }
      let j = i;
      let peak = 0;
      let core = get(i);
      while (j < len && contrast(get(j)) > PT) {
        const c = get(j);
        if (contrast(c) > peak) {
          peak = contrast(c);
          core = c;
        }
        j++;
      }
      let a = i, b = j - 1;
      while (a < b && contrast(get(a)) < peak / 2) a++;
      while (b > a && contrast(get(b)) < peak / 2) b--;
      segs.push(`${label(a, b)} ${hex(core)}`);
      i = j;
    }
    return segs.length ? segs.slice(0, 200).join(', ') + (segs.length > 200 ? ` … (${segs.length} runs)` : '') : 'only background';
  };
  for (const y of o.probes?.rows ?? []) if (y >= 0 && y < H) out.push(`row y=${y}: ` + runs(i => at(img, i, Math.round(y)), W, (a, b) => `x${a}-${b}`));
  for (const x of o.probes?.cols ?? []) if (x >= 0 && x < W) out.push(`col x=${x}: ` + runs(i => at(img, Math.round(x), i), H, (a, b) => `y${a}-${b}`));
  for (const ring of o.probes?.rings ?? []) {
    const steps = 720;
    const get = (i: number): Rgba => {
      const t = (i / 2) * (Math.PI / 180);
      const x = Math.round(ring.cx + ring.r * Math.cos(t)), y = Math.round(ring.cy + ring.r * Math.sin(t));
      return x < 0 || y < 0 || x >= W || y >= H ? [0, 0, 0, 0] : at(img, x, y);
    };
    out.push(`ring centre (${ring.cx},${ring.cy}) r=${ring.r}, degrees clockwise from +x: ` + runs(get, steps, (a, b) => `${a / 2}°-${b / 2}°`));
  }
  return out.join('\n');
}

/** A crop scaled up with hard pixels and a ruler in source-pixel coordinates, for reading small details exactly. */
export function zoomCrop(img: ImageData, z: { x: number; y: number; w: number; h: number; scale?: number }): string {
  const x = Math.max(0, Math.floor(z.x)), y = Math.max(0, Math.floor(z.y));
  const w = Math.min(Math.floor(z.w), img.width - x), h = Math.min(Math.floor(z.h), img.height - y);
  if (w <= 0 || h <= 0) throw new Error('zoom region is outside the image');
  const s = Math.max(1, Math.min(z.scale ?? Math.floor(1200 / Math.max(w, h)), 32));
  const pad = 28;
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  src.getContext('2d')!.putImageData(img, 0, 0);
  const c = document.createElement('canvas');
  c.width = w * s + pad;
  c.height = h * s + pad;
  const g = c.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = false;
  g.drawImage(src, x, y, w, h, pad, pad, w * s, h * s);
  // Ruler: a tick every source pixel when there is room, labels every 5 or 10 px.
  const every = s >= 12 ? 5 : 10;
  g.font = '10px monospace';
  g.fillStyle = '#ddd';
  g.strokeStyle = 'rgba(255,0,180,0.35)';
  for (let i = 0; i <= w; i++) {
    const px = pad + i * s;
    const v = x + i;
    if (v % every === 0) {
      g.fillText(String(v), px + 2, 11);
      g.beginPath();
      g.moveTo(px + 0.5, pad);
      g.lineTo(px + 0.5, pad + h * s);
      g.stroke();
    }
  }
  for (let j = 0; j <= h; j++) {
    const py = pad + j * s;
    const v = y + j;
    if (v % every === 0) {
      g.fillText(String(v), 1, py + 10);
      g.beginPath();
      g.moveTo(pad, py + 0.5);
      g.lineTo(pad + w * s, py + 0.5);
      g.stroke();
    }
  }
  return c.toDataURL('image/png');
}

function toCanvas(img: ImageData) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

/**
 * Compares a render with the reference at the reference's size: match score, the worst grid cells, and an image of
 * reference | render | difference (mismatched pixels in magenta over a dimmed reference).
 */
export function compare(ref: ImageData, shot: ImageData, tolerance = 48, frameScale = 1) {
  const W = ref.width, H = ref.height;
  const sc = document.createElement('canvas');
  sc.width = W;
  sc.height = H;
  const sg = sc.getContext('2d', { willReadFrequently: true })!;
  sg.imageSmoothingQuality = 'high';
  sg.drawImage(toCanvas(shot), 0, 0, W, H);
  const s = sg.getImageData(0, 0, W, H).data;
  const r = ref.data;
  const diff = new ImageData(W, H);
  const d = diff.data;
  const cells = 10;
  const cw = Math.ceil(W / cells), ch = Math.ceil(H / cells);
  const bad = new Float64Array(cells * cells);
  let mism = 0;
  const err = (a: Uint8ClampedArray, i: number, b: Uint8ClampedArray, j: number) =>
    Math.max(Math.abs(a[i] - b[j]), Math.abs(a[i + 1] - b[j + 1]), Math.abs(a[i + 2] - b[j + 2]), Math.abs(a[i + 3] - b[j + 3]));
  /**
   * True when pixel (x,y) of `a` lies within the colour range of the 3×3 neighbourhood around the same spot in `b`:
   * an edge pixel blended differently because the edge sits a fraction of a pixel elsewhere, not a real difference.
   */
  const near = (a: Uint8ClampedArray, b: Uint8ClampedArray, x: number, y: number) => {
    const i = (y * W + x) * 4;
    for (let ch = 0; ch < 4; ch++) {
      let lo = 255, hi = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const u = x + dx, v = y + dy;
          if (u < 0 || v < 0 || u >= W || v >= H) continue;
          const c = b[(v * W + u) * 4 + ch];
          if (c < lo) lo = c;
          if (c > hi) hi = c;
        }
      if (a[i + ch] < lo - tolerance || a[i + ch] > hi + tolerance) return false;
    }
    return true;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const off = err(r, i, s, i) > tolerance && !(near(r, s, x, y) && near(s, r, x, y));
      if (off) {
        mism++;
        bad[Math.floor(y / ch) * cells + Math.floor(x / cw)]++;
      }
      d[i] = off ? 255 : r[i] * 0.3;
      d[i + 1] = off ? 0 : r[i + 1] * 0.3;
      d[i + 2] = off ? 200 : r[i + 2] * 0.3;
      d[i + 3] = 255;
    }
  const worst = [...bad]
    .map((n, k) => ({ n, k }))
    .filter(c => c.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 8)
    .map(({ n, k }) => {
      const cx = (k % cells) * cw, cy = Math.floor(k / cells) * ch;
      const w = Math.min(cw, W - cx), h = Math.min(ch, H - cy);
      return `  ref x${cx}-${cx + w} y${cy}-${cy + h} (frame x${Math.round(cx / frameScale)}-${Math.round((cx + w) / frameScale)} y${Math.round(cy / frameScale)}-${Math.round((cy + h) / frameScale)}): ${((n / (w * h)) * 100).toFixed(1)}% off`;
    });
  // Side-by-side image, capped to a readable width.
  const k = Math.min(1, 1800 / (W * 3 + 40), 1400 / H);
  const pw = Math.round(W * k), ph = Math.round(H * k);
  const c = document.createElement('canvas');
  c.width = pw * 3 + 40;
  c.height = ph;
  const g = c.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, c.width, c.height);
  g.drawImage(toCanvas(ref), 0, 0, pw, ph);
  g.drawImage(sc, pw + 20, 0, pw, ph);
  g.drawImage(toCanvas(diff), pw * 2 + 40, 0, pw, ph);
  const score = 1 - mism / (W * H);
  return {
    dataUrl: c.toDataURL('image/png'),
    text: [`match ${(score * 100).toFixed(2)}% of pixels (within tolerance ${tolerance}, ignoring 1px anti-aliasing shifts; reference ${W}×${H}, render scaled to match)`, worst.length ? 'worst areas:' : 'no mismatched areas', ...worst, 'image: reference | your render | difference (magenta = mismatch)'].join('\n'),
  };
}

/** Puts a transparent screenshot on a background and/or shows it at several icon sizes side by side. */
export async function presentShot(dataUrl: string, background?: string, sizes?: number[]): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = new Image();
  img.src = dataUrl;
  await img.decode();
  const bg = background === 'dark' ? '#1E1E22' : background === 'light' ? '#FFFFFF' : background;
  const checker = (g: CanvasRenderingContext2D, w: number, h: number) => {
    if (bg && bg !== 'checker') {
      g.fillStyle = bg;
      g.fillRect(0, 0, w, h);
      return;
    }
    if (bg !== 'checker') return;
    for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) {
      g.fillStyle = (x + y) % 16 ? '#3a3a3a' : '#2a2a2a';
      g.fillRect(x, y, 8, 8);
    }
  };
  if (!sizes?.length) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d')!;
    checker(g, c.width, c.height);
    g.drawImage(img, 0, 0);
    return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
  }
  // Icon preview: each size fits the longest side, on tiles in a row.
  const list = [...sizes].sort((a, b) => b - a);
  const gap = 16;
  const tile = (n: number) => n + 16;
  const c = document.createElement('canvas');
  c.width = list.reduce((a, n) => a + tile(n) + gap, gap);
  c.height = tile(list[0]) + gap * 2 + 14;
  const g = c.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = 'high';
  let x = gap;
  for (const n of list) {
    const t = document.createElement('canvas');
    t.width = t.height = tile(n);
    const tg = t.getContext('2d')!;
    checker(tg, t.width, t.height);
    if (!bg) {
      tg.fillStyle = '#1E1E22';
      tg.fillRect(0, 0, t.width, t.height);
    }
    const k = n / Math.max(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth * k, h = img.naturalHeight * k;
    tg.imageSmoothingQuality = 'high';
    tg.drawImage(img, 8 + (n - w) / 2, 8 + (n - h) / 2, w, h);
    g.drawImage(t, x, gap);
    g.fillStyle = '#aaa';
    g.font = '11px sans-serif';
    g.fillText(`${n}px`, x, gap + t.height + 12);
    x += t.width + gap;
  }
  return { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height };
}
