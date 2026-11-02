// Chrome snaps every box's paint offset to a whole pixel in the coordinate space of its nearest transformed ancestor,
// before that ancestor's transform applies. On the canvas that space is the design itself (#pen-world is scaled), so
// a vector shape at x = 49.5 is painted at 50, and zoomed in, parts of one drawing drift up to half a design pixel apart
// (a stroke end visibly off the line it meets, an icon's dot beside its stem). Transforms are not snapped, so each
// shape's <svg> is shifted back by its own rounding error, measured after layout. Panning and zooming don't change the
// error, so it is only re-measured when shapes mount or the document changes.

const live = new Set<SVGSVGElement>();
const pending = new Set<SVGSVGElement>();
let raf = 0;
let subscribed = false;
let docTimer = 0;

/** Registers a shape's root <svg> for alignment (call after every render of the shape). */
export function alignSubpixel(svg: SVGSVGElement | null) {
  if (!svg) return;
  live.add(svg);
  pending.add(svg);
  if (!raf) raf = requestAnimationFrame(flush);
  if (!subscribed) subscribeLazily();
}

/** Re-measures every shape: a moved parent shifts its children's rounding without re-rendering them. */
export function realignAll() {
  for (const svg of live) {
    if (svg.isConnected) pending.add(svg);
    else live.delete(svg);
  }
  if (!raf && pending.size) raf = requestAnimationFrame(flush);
}

function subscribeLazily() {
  subscribed = true;
  // Imported lazily: render modules load before the store in some import orders (see CLAUDE.md, import cycles).
  void import('../editor/store').then(({ useStore }) =>
    useStore.subscribe((s, prev) => {
      if (s.doc === prev.doc) return;
      clearTimeout(docTimer);
      docTimer = window.setTimeout(realignAll, 120);
    }),
  );
}

/** The element whose coordinate space the svg is snapped in, if it is the canvas world (rotated subtrees are skipped). */
function worldOf(svg: SVGSVGElement): HTMLElement | null {
  for (let el = svg.parentElement; el; el = el.parentElement) {
    if (el.id === 'pen-world') return el;
    if (el.style.transform) return null;
  }
  return null;
}

function flush() {
  raf = 0;
  const items = [...pending];
  pending.clear();
  // Read everything first (one layout), then write: no layout thrashing on big files.
  const scale = new Map<HTMLElement, { left: number; top: number; zoom: number }>();
  const reads: { svg: SVGSVGElement; dx: number; dy: number }[] = [];
  for (const svg of items) {
    if (!svg.isConnected) {
      live.delete(svg);
      continue;
    }
    const world = worldOf(svg);
    const host = svg.parentElement;
    if (!world || !host) {
      reads.push({ svg, dx: 0, dy: 0 });
      continue;
    }
    let w = scale.get(world);
    if (!w) {
      const r = world.getBoundingClientRect();
      w = { left: r.left, top: r.top, zoom: new DOMMatrix(getComputedStyle(world).transform).a || 1 };
      scale.set(world, w);
    }
    // The host box, not the svg: the svg's own (previous) shift must not feed back into the measurement.
    const r = host.getBoundingClientRect();
    const x = (r.left - w.left) / w.zoom;
    const y = (r.top - w.top) / w.zoom;
    reads.push({ svg, dx: x - Math.round(x), dy: y - Math.round(y) });
  }
  for (const { svg, dx, dy } of reads) {
    const t = Math.abs(dx) < 0.004 && Math.abs(dy) < 0.004 ? '' : `translate(${dx.toFixed(3)}px, ${dy.toFixed(3)}px)`;
    if (svg.style.transform !== t) svg.style.transform = t;
  }
}
