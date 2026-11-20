// Image crop on the canvas. While it is on (store.crop), the layer's box is the crop window over the whole picture,
// which is shown faded around it: drag a handle to change what the window shows (the picture stays where it is on
// screen), drag inside to slide the picture under the window. Enter, Escape, a double-click or a click outside ends
// it. The result is the image fill's `transform` (pen.dev's crop matrix, see imageTransform in render/paint.ts).
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore, applyProps } from '../editor/store';
import { currentTree } from '../editor/tree';
import { isAbsolutelyPositioned, worldRectOf } from '../editor/ops';
import { makeUrlResolver } from '../editor/fileio';
import { resolveProps } from '../model/props';
import { fillList, imageTransform } from '../render/paint';

type Rect = { x: number; y: number; w: number; h: number };
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Where a picture of natural size iw×ih sits in a w×h box for a fill mode, relative to the box. */
export function fittedRect(w: number, h: number, iw: number, ih: number, mode: string): Rect {
  if (mode === 'stretch' || !iw || !ih) return { x: 0, y: 0, w, h };
  const k = mode === 'contain' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
  return { x: (w - iw * k) / 2, y: (h - ih * k) / 2, w: iw * k, h: ih * k };
}

/** The crop matrix that puts the whole picture at `image` (world) when the layer's box is `box` (world). */
export function cropFor(box: Rect, image: Rect, iw: number, ih: number, mode: string): number[] | undefined {
  const f = fittedRect(box.w, box.h, iw, ih, mode);
  const a = image.w / (f.w || 1), d = image.h / (f.h || 1);
  const t = [r4(a), 0, 0, r4(d), r4((image.x - box.x - a * f.x) / (box.w || 1)), r4((image.y - box.y - d * f.y) / (box.h || 1))];
  return t[0] === 1 && t[3] === 1 && t[4] === 0 && t[5] === 0 ? undefined : t;
}

/** The node's raw fill with the image fill at `index` (among its fills) given this crop matrix. */
function withTransform(rawFill: any, index: number, transform: number[] | undefined) {
  const set = (f: any) => {
    const next = { ...f };
    if (transform) next.transform = transform;
    else delete next.transform;
    return next;
  };
  if (Array.isArray(rawFill)) return rawFill.map((f, i) => (i === index && f && typeof f === 'object' ? set(f) : f));
  return rawFill && typeof rawFill === 'object' ? set(rawFill) : rawFill;
}

export function CropOverlay() {
  const crop = useStore(s => s.crop);
  const view = useStore(s => s.view);
  const doc = useStore(s => s.doc);
  const file = useStore(s => s.file);
  const [nat, setNat] = useState<{ url: string; w: number; h: number } | null>(null);
  const [box, setBox] = useState<Rect | null>(null);
  const drag = useRef<{ kind: 'pan' | string; sx: number; sy: number; box: Rect; image: Rect; px: number; py: number } | null>(null);

  const node = crop && doc ? currentTree()?.byKey.get(crop.key) : undefined;
  const p = node && doc ? resolveProps(doc, node.props, node.theme) : null;
  const fill = p ? fillList(p.fill)[crop!.index] : null;
  const isImage = !!fill && typeof fill === 'object' && fill.type === 'image' && !!fill.url;
  const url = isImage ? makeUrlResolver(file?.path ?? null)(fill.url) : '';
  const mode: string = isImage ? (fill.mode ?? 'cover') : 'cover';
  const done = () => useStore.setState({ crop: null });

  useEffect(() => {
    if (crop && (!node || !isImage)) done();
    else if (crop && p?.rotation) {
      useStore.getState().notify('Crop works on layers that are not rotated');
      done();
    }
  }, [crop, node, isImage]);

  useEffect(() => {
    if (!url) return;
    const img = new Image();
    img.onload = () => setNat({ url, w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => {
      useStore.getState().notify('Could not load the picture to crop');
      done();
    };
    img.src = url;
  }, [url]);

  // After the canvas has laid the layer out (see CanvasExtras.useMeasured for why not during render).
  useLayoutEffect(() => setBox(crop ? worldRectOf(crop.key) : null), [crop, view, doc]);

  useEffect(() => {
    if (!crop) return;
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      done();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [crop]);

  if (!crop || !node || !isImage || !box || !nat || nat.url !== url) return null;
  const t = imageTransform(fill) ?? [1, 0, 0, 1, 0, 0];
  const f = fittedRect(box.w, box.h, nat.w, nat.h, mode);
  const image: Rect = { x: box.x + t[0] * f.x + t[4] * box.w, y: box.y + t[3] * f.y + t[5] * box.h, w: t[0] * f.w, h: t[3] * f.h };
  const abs = isAbsolutelyPositioned(crop.key);
  const sx = (v: number) => view.x + v * view.zoom, sy = (v: number) => view.y + v * view.zoom;

  const write = (nextBox: Rect, nextImage: Rect, start: { box: Rect; px: number; py: number }) => {
    const transform = cropFor(nextBox, nextImage, nat.w, nat.h, mode);
    const changes: Record<string, any> = { fill: withTransform(node.props.fill, crop.index, transform) };
    if (nextBox.w !== start.box.w) changes.width = r2(nextBox.w);
    if (nextBox.h !== start.box.h) changes.height = r2(nextBox.h);
    if (abs && nextBox.x !== start.box.x) changes.x = r2(start.px + nextBox.x - start.box.x);
    if (abs && nextBox.y !== start.box.y) changes.y = r2(start.py + nextBox.y - start.box.y);
    useStore.getState().edit(d => applyProps(d, crop.key, changes), 'crop-' + crop.key);
  };

  const onDown = (e: React.PointerEvent, kind: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    drag.current = { kind, sx: e.clientX, sy: e.clientY, box, image, px: typeof p!.x === 'number' ? p!.x : 0, py: typeof p!.y === 'number' ? p!.y : 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / view.zoom, dy = (e.clientY - d.sy) / view.zoom;
    if (d.kind === 'pan') {
      // Slide the picture under the window; it keeps covering the window where it already did.
      const clamp = (pos: number, size: number, lo: number, len: number) => (size >= len ? Math.min(lo, Math.max(lo + len - size, pos)) : Math.max(lo, Math.min(lo + len - size, pos)));
      write(d.box, { ...d.image, x: clamp(d.image.x + dx, d.image.w, d.box.x, d.box.w), y: clamp(d.image.y + dy, d.image.h, d.box.y, d.box.h) }, d);
      return;
    }
    // A handle: the window's edges move, never past the picture's own edges.
    let { x, y, w, h } = d.box;
    const right = d.image.x + d.image.w, bottom = d.image.y + d.image.h;
    if (d.kind.includes('e')) w = Math.max(4, Math.min(right - x, d.box.w + dx));
    if (d.kind.includes('s')) h = Math.max(4, Math.min(bottom - y, d.box.h + dy));
    if (d.kind.includes('w')) {
      const nx = Math.max(d.image.x, Math.min(d.box.x + d.box.w - 4, d.box.x + dx));
      w = d.box.x + d.box.w - nx;
      x = nx;
    }
    if (d.kind.includes('n')) {
      const ny = Math.max(d.image.y, Math.min(d.box.y + d.box.h - 4, d.box.y + dy));
      h = d.box.y + d.box.h - ny;
      y = ny;
    }
    write({ x: r2(x), y: r2(y), w: r2(w), h: r2(h) }, d.image, d);
  };
  const onUp = () => {
    drag.current = null;
  };

  // A layer in auto layout can't move its own top-left corner: only the handles that keep it are offered.
  const handles = abs ? HANDLES : (['e', 'se', 's'] as const);
  const bx = sx(box.x), by = sy(box.y), bw = box.w * view.zoom, bh = box.h * view.zoom;
  return (
    <div className="crop-overlay" onPointerDown={e => (e.stopPropagation(), done())} onDoubleClick={done}>
      <img className="crop-ghost" src={url} alt="" draggable={false} style={{ left: sx(image.x), top: sy(image.y), width: image.w * view.zoom, height: image.h * view.zoom }} />
      <div className="crop-window" style={{ left: bx, top: by, width: bw, height: bh }} onPointerDown={e => onDown(e, 'pan')} onPointerMove={onMove} onPointerUp={onUp} />
      {handles.map(hd => (
        <div
          key={hd}
          className={'crop-handle ' + hd}
          data-crop-handle={hd}
          style={{ left: bx + (hd.includes('w') ? 0 : hd.includes('e') ? bw : bw / 2), top: by + (hd.includes('n') ? 0 : hd.includes('s') ? bh : bh / 2) }}
          onPointerDown={e => onDown(e, hd)}
          onPointerMove={onMove}
          onPointerUp={onUp}
        />
      ))}
      <div className="crop-bar" style={{ left: bx + bw / 2, top: by + bh + 10 }} onPointerDown={e => e.stopPropagation()}>
        <button
          className="rp-btn"
          disabled={!imageTransform(fill)}
          onClick={() => useStore.getState().edit(d => applyProps(d, crop.key, { fill: withTransform(node.props.fill, crop.index, undefined) }))}
        >
          Reset crop
        </button>
        <button className="rp-btn primary" onClick={done}>
          Done
        </button>
      </div>
    </div>
  );
}
