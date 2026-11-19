// Remove background, built in (no model, nothing downloaded): for pictures on a plain or gently graded background,
// which is most icons, product shots, renders and generated art. The background is what you can reach from the
// picture's border without crossing a clear change of colour. What it cannot do is tell a subject from a busy
// background (a photo of a person in a street); the result says how much was removed so the caller can tell.
//
// Steps: (1) the background's colour is the commonest colour along the border; (2) a flood from every border pixel
// takes pixels close to that colour, or continuing a smooth gradient from an already taken neighbour; (3) optionally
// enclosed areas of the same colour go too (the hole of an "O"); (4) the subject's outermost pixels, which are a blend
// of subject and background, get a matching alpha and have the background's colour taken back out of them, so no
// halo of the old background is left.

export type RemoveBgOptions = {
  /** How different from the background a pixel may be and still count as background (0–100, default: from the border's own variation). */
  tolerance?: number;
  /** Also remove enclosed areas of the background colour that the flood cannot reach from the border (default true). */
  inner?: boolean;
};

export type RemoveBgResult = {
  image: ImageData;
  /** Share of the picture that became transparent (0..1). */
  removed: number;
  /** Share of the picture's border that was background (0..1): low means the background is not one plain colour. */
  borderShare: number;
  /** The background colour that was found. */
  background: [number, number, number];
  tolerance: number;
  /** Set when nothing sensible could be done (and `image` is the input unchanged). */
  note?: string;
};

export function removeBackground(src: ImageData, opts: RemoveBgOptions = {}): RemoveBgResult {
  const { width: w, height: h } = src;
  const n = w * h;
  const d = new Uint8ClampedArray(src.data);
  const out = new ImageData(d, w, h);
  const idx = (x: number, y: number) => y * w + x;

  // ---- border: already transparent? which colour?
  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(idx(x, 0), idx(x, h - 1));
  for (let y = 1; y < h - 1; y++) border.push(idx(0, y), idx(w - 1, y));
  const clear = border.filter(i => d[i * 4 + 3] < 16).length;
  if (clear > border.length * 0.6) return { image: src, removed: 0, borderShare: 1, background: [0, 0, 0], tolerance: 0, note: 'the picture already has a transparent background' };
  // The commonest colour on the border, in coarse steps, then the mean of the pixels in that step.
  const bins = new Map<number, number[]>();
  for (const i of border) {
    if (d[i * 4 + 3] < 16) continue;
    const k = ((d[i * 4] >> 3) << 10) | ((d[i * 4 + 1] >> 3) << 5) | (d[i * 4 + 2] >> 3);
    const b = bins.get(k);
    if (b) b.push(i);
    else bins.set(k, [i]);
  }
  let top: number[] = [];
  for (const b of bins.values()) if (b.length > top.length) top = b;
  const bg: [number, number, number] = [0, 0, 0];
  for (const i of top) for (let c = 0; c < 3; c++) bg[c] += d[i * 4 + c] / top.length;
  const dist = (i: number, r: number, g: number, b: number) => Math.hypot(d[i * 4] - r, d[i * 4 + 1] - g, d[i * 4 + 2] - b);
  // How much the border itself varies sets the tolerance: a flat background needs little, a graded one more.
  let spread = 0;
  for (const i of border) spread += dist(i, bg[0], bg[1], bg[2]) ** 2;
  spread = Math.sqrt(spread / border.length);
  const tol = opts.tolerance !== undefined ? Math.max(1, Math.min(100, opts.tolerance)) * 2.2 : Math.max(26, Math.min(80, spread * 1.5 + 22));

  // ---- flood from the border
  const BG = 1;
  const mark = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  const near = (i: number) => d[i * 4 + 3] < 16 || dist(i, bg[0], bg[1], bg[2]) <= tol;
  for (const i of border) if (!mark[i] && near(i)) (mark[i] = BG), (stack[sp++] = i);
  const STEP = 9; // a smooth gradient changes less than this from one pixel to the next
  while (sp) {
    const i = stack[--sp];
    const x = i % w, y = (i / w) | 0;
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    for (let k = 0; k < 4; k++) {
      const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = idx(nx, ny);
      if (mark[j]) continue;
      if (near(j) || (dist(j, r, g, b) <= STEP && dist(j, bg[0], bg[1], bg[2]) <= tol * 2.4)) (mark[j] = BG), (stack[sp++] = j);
    }
  }

  // ---- enclosed areas of the background colour (tighter: a white highlight on the subject must survive)
  if (opts.inner !== false) {
    const tight = Math.min(tol * 0.55, 30);
    const seen = new Uint8Array(n);
    const minArea = Math.max(12, Math.round(n * 0.0004));
    for (let s = 0; s < n; s++) {
      if (mark[s] || seen[s] || dist(s, bg[0], bg[1], bg[2]) > tight) continue;
      // Collect this island.
      let from = sp = 0;
      stack[sp++] = s;
      seen[s] = 1;
      while (from < sp) {
        const i = stack[from++];
        const x = i % w, y = (i / w) | 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + (k === 0 ? 1 : k === 1 ? -1 : 0), ny = y + (k === 2 ? 1 : k === 3 ? -1 : 0);
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = idx(nx, ny);
          if (mark[j] || seen[j] || dist(j, bg[0], bg[1], bg[2]) > tight) continue;
          seen[j] = 1;
          stack[sp++] = j;
        }
      }
      if (sp >= minArea) for (let k = 0; k < sp; k++) mark[stack[k]] = BG;
      sp = 0;
    }
  }

  // ---- the subject's rim: depth 1 and 2 from the background are blends
  const depth = new Uint8Array(n); // 0 = background or deep inside, 1/2 = rim
  let rim: number[] = [];
  for (let i = 0; i < n; i++) {
    if (mark[i]) continue;
    const x = i % w, y = (i / w) | 0;
    if ((x > 0 && mark[i - 1]) || (x < w - 1 && mark[i + 1]) || (y > 0 && mark[i - w]) || (y < h - 1 && mark[i + w])) (depth[i] = 1), rim.push(i);
  }
  const second: number[] = [];
  for (const i of rim) {
    const x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) if (j >= 0 && !mark[j] && !depth[j]) (depth[j] = 2), second.push(j);
  }
  rim = rim.concat(second);
  const alpha = new Float32Array(rim.length);
  const solid: [number, number, number][] = [];
  rim.forEach((i, q) => {
    // The subject's own colour here: nearby pixels that are neither background nor rim.
    const x = i % w, y = (i / w) | 0;
    let r = 0, g = 0, b = 0, c = 0;
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = idx(nx, ny);
        if (mark[j] || depth[j]) continue;
        r += d[j * 4];
        g += d[j * 4 + 1];
        b += d[j * 4 + 2];
        c++;
      }
    // A thin feature (a line 1–2 px wide) has no inside: keep it as it is.
    if (!c) return void ((alpha[q] = 1), solid.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]));
    const f: [number, number, number] = [r / c, g / c, b / c];
    const vx = f[0] - bg[0], vy = f[1] - bg[1], vz = f[2] - bg[2];
    const len2 = vx * vx + vy * vy + vz * vz;
    // Where the pixel lies between the background's colour (0) and the subject's (1).
    const a = len2 < 60 ? 1 : Math.max(0, Math.min(1, ((d[i * 4] - bg[0]) * vx + (d[i * 4 + 1] - bg[1]) * vy + (d[i * 4 + 2] - bg[2]) * vz) / len2));
    alpha[q] = a;
    solid.push(f);
  });
  rim.forEach((i, q) => {
    const a = alpha[q];
    if (a >= 0.98) return;
    const o = i * 4;
    if (a <= 0.02) return void (d[o + 3] = 0);
    // Take the background back out of the blend; never invent a colour far from the subject's.
    for (let c = 0; c < 3; c++) d[o + c] = Math.max(0, Math.min(255, (d[o + c] - (1 - a) * bg[c]) / a)) * 0.5 + solid[q][c] * 0.5;
    d[o + 3] = Math.round(d[o + 3] * a);
  });
  let removed = 0;
  for (let i = 0; i < n; i++) if (mark[i]) (d[i * 4 + 3] = 0), removed++;
  const share = removed / n;
  const borderShare = border.filter(i => mark[i]).length / border.length;
  let note: string | undefined;
  if (borderShare < 0.35) note = 'the background is not plain: only part of the border of the picture matched one colour (this works on plain or gently graded backgrounds)';
  else if (share < 0.01) note = 'almost nothing was removed: the background is probably not plain (this works on plain or gently graded backgrounds)';
  else if (share > 0.998 || n - removed < 64) note = 'nearly everything was removed: the subject is probably too close in colour to the background (try a lower tolerance)';
  return { image: out, removed: share, borderShare, background: [Math.round(bg[0]), Math.round(bg[1]), Math.round(bg[2])], tolerance: Math.round(tol / 2.2), note };
}
