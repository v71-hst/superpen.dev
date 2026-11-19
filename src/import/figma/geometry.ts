// Figma geometry -> SVG path data: the path command blobs a .fig file stores for every shape, the vector network
// blob (what the clipboard carries instead), and the star / polygon shapes that have to be rebuilt when no path
// was stored.

/** Numbers in path data: three decimals is well below anything visible, and keeps files small. */
export function fmt(n: number): string {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

export type Box = { x0: number; y0: number; x1: number; y1: number };

const emptyBox = (): Box => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });

function grow(b: Box, x: number, y: number) {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}

export type PathData = { d: string; box: Box | null; closed: boolean; commands: number };

/**
 * Decodes a path command blob: one byte per command (0 close, 1 move, 2 line, 3 quadratic, 4 cubic) followed by
 * its coordinates as little-endian 32-bit floats, in the node's own coordinate space.
 */
export function commandsToPath(blob: Uint8Array | undefined): PathData | null {
  if (!blob || !blob.length) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const box = emptyBox();
  const out: string[] = [];
  let i = 0;
  let closed = true;
  let open = false;
  let commands = 0;
  const need = (n: number) => i + n * 4 <= blob.length;
  const f = () => {
    const v = view.getFloat32(i, true);
    i += 4;
    return isFinite(v) ? v : 0;
  };
  while (i < blob.length) {
    const c = blob[i++];
    if (c === 0) {
      out.push('Z');
      open = false;
    } else if (c === 1 && need(2)) {
      if (open) closed = false;
      const x = f(), y = f();
      grow(box, x, y);
      out.push(`M${fmt(x)} ${fmt(y)}`);
      open = true;
    } else if (c === 2 && need(2)) {
      const x = f(), y = f();
      grow(box, x, y);
      out.push(`L${fmt(x)} ${fmt(y)}`);
    } else if (c === 3 && need(4)) {
      const x1 = f(), y1 = f(), x = f(), y = f();
      grow(box, x1, y1);
      grow(box, x, y);
      out.push(`Q${fmt(x1)} ${fmt(y1)} ${fmt(x)} ${fmt(y)}`);
    } else if (c === 4 && need(6)) {
      const x1 = f(), y1 = f(), x2 = f(), y2 = f(), x = f(), y = f();
      grow(box, x1, y1);
      grow(box, x2, y2);
      grow(box, x, y);
      out.push(`C${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)}`);
    } else {
      break; // unknown command or truncated data: keep what was read
    }
    commands++;
  }
  if (open) closed = false;
  if (!out.length) return null;
  return { d: out.join(''), box: isFinite(box.x0) ? box : null, closed, commands };
}

// ---------- vector networks ----------

type Vertex = { x: number; y: number; style: number };
type Segment = { a: number; b: number; ax: number; ay: number; bx: number; by: number };
type Region = { evenodd: boolean; style: number; loops: number[][] };

export type VectorNetwork = { vertices: Vertex[]; segments: Segment[]; regions: Region[] };

/**
 * Decodes a vector network blob: counts of vertices, segments and regions (uint32 each), then
 * vertices (style id, x, y), segments (style id, start vertex, start tangent, end vertex, end tangent) and
 * regions (flags, loop count, then per loop a count and that many segment indices). Coordinates are in the
 * network's "normalized size" and are scaled by sx, sy to the node's size.
 */
export function decodeVectorNetwork(blob: Uint8Array | undefined, sx: number, sy: number): VectorNetwork | null {
  if (!blob || blob.length < 12) return null;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let i = 0;
  const u32 = () => {
    const v = view.getUint32(i, true);
    i += 4;
    return v;
  };
  const f32 = () => {
    const v = view.getFloat32(i, true);
    i += 4;
    return isFinite(v) ? v : 0;
  };
  try {
    const nv = u32(), ns = u32(), nr = u32();
    if (12 + nv * 12 + ns * 28 > blob.length) return null;
    const vertices: Vertex[] = [];
    for (let k = 0; k < nv; k++) {
      const style = u32();
      vertices.push({ x: f32() * sx, y: f32() * sy, style });
    }
    const segments: Segment[] = [];
    for (let k = 0; k < ns; k++) {
      u32(); // style id
      const a = u32();
      const ax = f32() * sx, ay = f32() * sy;
      const b = u32();
      const bx = f32() * sx, by = f32() * sy;
      if (a >= nv || b >= nv) return null;
      segments.push({ a, b, ax, ay, bx, by });
    }
    const regions: Region[] = [];
    for (let k = 0; k < nr; k++) {
      const flags = u32();
      const loopCount = u32();
      const loops: number[][] = [];
      for (let l = 0; l < loopCount; l++) {
        const n = u32();
        if (i + n * 4 > blob.length) return null;
        const loop: number[] = [];
        for (let m = 0; m < n; m++) {
          const s = u32();
          if (s < ns) loop.push(s);
        }
        loops.push(loop);
      }
      regions.push({ evenodd: !(flags & 1), style: flags >>> 1, loops });
    }
    return { vertices, segments, regions };
  } catch {
    return null; // ran past the end of the blob
  }
}

function segmentTo(net: VectorNetwork, s: Segment, forward: boolean): string {
  const from = net.vertices[forward ? s.a : s.b];
  const to = net.vertices[forward ? s.b : s.a];
  const ft = forward ? [s.ax, s.ay] : [s.bx, s.by];
  const tt = forward ? [s.bx, s.by] : [s.ax, s.ay];
  if (!ft[0] && !ft[1] && !tt[0] && !tt[1]) return `L${fmt(to.x)} ${fmt(to.y)}`;
  return `C${fmt(from.x + ft[0])} ${fmt(from.y + ft[1])} ${fmt(to.x + tt[0])} ${fmt(to.y + tt[1])} ${fmt(to.x)} ${fmt(to.y)}`;
}

/** One closed subpath per loop of a region. */
function loopPath(net: VectorNetwork, loop: number[]): string {
  if (!loop.length) return '';
  const segs = loop.map(i => net.segments[i]);
  // Segments of a loop are listed in order, but each may run either way: pick the direction that chains.
  let at = segs[0].a;
  if (segs.length > 1) {
    const n = segs[1];
    at = segs[0].b === n.a || segs[0].b === n.b ? segs[0].a : segs[0].b;
  }
  let d = `M${fmt(net.vertices[at].x)} ${fmt(net.vertices[at].y)}`;
  for (const s of segs) {
    let forward = s.a === at;
    if (!forward && s.b !== at) {
      // Not connected to where we are: start again from this segment.
      d += `M${fmt(net.vertices[s.a].x)} ${fmt(net.vertices[s.a].y)}`;
      forward = true;
    }
    d += segmentTo(net, s, forward);
    at = forward ? s.b : s.a;
  }
  return d + 'Z';
}

export type NetworkFill = { d: string; evenodd: boolean; style: number };

/** Filled areas of a network, one entry per region. */
export function networkFills(net: VectorNetwork): NetworkFill[] {
  const out: NetworkFill[] = [];
  for (const r of net.regions) {
    const d = r.loops.map(l => loopPath(net, l)).join('');
    if (d) out.push({ d, evenodd: r.evenodd, style: r.style });
  }
  return out;
}

/** The network's lines as one path: segments chained into subpaths, closed where they return to their start. */
export function networkOutline(net: VectorNetwork): { d: string; allClosed: boolean; subpaths: number } {
  const { vertices, segments } = net;
  const at: number[][] = vertices.map(() => []);
  segments.forEach((s, i) => {
    at[s.a].push(i);
    if (s.b !== s.a) at[s.b].push(i);
  });
  const used = new Array<boolean>(segments.length).fill(false);
  let d = '';
  let allClosed = segments.length > 0;
  let subpaths = 0;
  const walk = (start: number) => {
    let cur = start;
    let piece = '';
    for (;;) {
      const next = at[cur].find(i => !used[i]);
      if (next === undefined) break;
      used[next] = true;
      const s = segments[next];
      const forward = s.a === cur;
      piece += segmentTo(net, s, forward);
      cur = forward ? s.b : s.a;
    }
    if (!piece) return;
    const closed = cur === start;
    if (!closed) allClosed = false;
    subpaths++;
    d += `M${fmt(vertices[start].x)} ${fmt(vertices[start].y)}${piece}${closed ? 'Z' : ''}`;
  };
  // Open ends first, so that an open line is drawn from its end rather than from the middle.
  for (let v = 0; v < vertices.length; v++) if (at[v].length === 1) walk(v);
  for (let v = 0; v < vertices.length; v++) while (at[v].some(i => !used[i])) walk(v);
  return { d, allClosed, subpaths };
}

// ---------- shapes Figma describes by parameters ----------

/** A regular polygon as Figma draws it: corners on the ellipse inscribed in the box, the first one at the top. */
export function polygonPath(w: number, h: number, count: number): string {
  const n = Math.max(3, Math.round(count || 3));
  const pts: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    pts.push(`${fmt(w / 2 + (w / 2) * Math.cos(a))} ${fmt(h / 2 + (h / 2) * Math.sin(a))}`);
  }
  return 'M' + pts.join('L') + 'Z';
}

/** A star: outer points like a polygon, inner points at `inner` (0..1) of the radius, halfway between. */
export function starPath(w: number, h: number, count: number, inner: number): string {
  const n = Math.max(3, Math.round(count || 5));
  const k = isFinite(inner) ? Math.max(0, Math.min(1, inner)) : 0.382;
  const pts: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / n;
    const r = i % 2 ? k : 1;
    pts.push(`${fmt(w / 2 + (w / 2) * r * Math.cos(a))} ${fmt(h / 2 + (h / 2) * r * Math.sin(a))}`);
  }
  return 'M' + pts.join('L') + 'Z';
}
