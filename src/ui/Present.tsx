// Full-screen slideshow of top-level frames, and PDF export via the browser's print dialog.
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../editor/store';
import { useTree, currentTree } from '../editor/tree';
import { NodeView, RenderCtx } from '../render/NodeView';
import { makeUrlResolver } from '../editor/fileio';
import type { RNode } from '../model/types';
import { rasterize } from '../render/rasterize';
import { ensureRendered } from '../editor/culling';
import { inVsCode, post } from '../editor/host';
import { elFor } from '../editor/ops';
import { displayName } from '../model/doc';

/** VS Code webviews cannot print, so slides are exported as numbered PNGs into a folder instead. */
async function exportSlidePngs(slides: RNode[]) {
  const files: { name: string; dataUrl: string }[] = [];
  for (let i = 0; i < slides.length; i++) {
    const el = elFor(slides[i].key);
    if (!el) continue;
    ensureRendered([slides[i].key]);
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const { dataUrl } = await rasterize(el, { format: 'png', pixelRatio: 2 });
    const safe = displayName(slides[i].props).replace(/[\\/:*?"<>|]+/g, '_');
    files.push({ name: `${String(i + 1).padStart(2, '0')} ${safe}.png`, dataUrl });
  }
  post({ type: 'saveFiles', files });
}

function slidesOf(roots: RNode[]) {
  return roots.filter(n => (n.type === 'frame' || n.instanceOf) && n.props.enabled !== false);
}

function Placed({ n, w, h }: { n: RNode; w: number; h: number }) {
  const placed = useMemo(() => ({ ...n, props: { ...n.props, x: 0, y: 0, rotation: undefined } }), [n]);
  const fw = typeof n.props.width === 'number' ? n.props.width : 1280;
  const fh = typeof n.props.height === 'number' ? n.props.height : 720;
  const s = Math.min(w / fw, h / fh);
  return (
    <div className="present-stage" style={{ width: fw * s, height: fh * s }}>
      <div style={{ transform: `scale(${s})` }}>
        <NodeView n={placed} parentLayout="none" />
      </div>
    </div>
  );
}

export function Presenter() {
  const presenting = useStore(s => s.presenting);
  const tree = useTree();
  const vars = useStore(s => s.doc?.variables);
  const path = useStore(s => s.file?.path ?? null);
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  const ctx = useMemo(() => ({ doc: { variables: vars }, resolveUrl: makeUrlResolver(path) }), [vars, path]);
  useEffect(() => {
    if (presenting === null) return;
    const slides = slidesOf(currentTree()?.roots ?? []);
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      const cur = useStore.getState().presenting ?? 0;
      if (e.key === 'Escape') useStore.setState({ presenting: null });
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) useStore.setState({ presenting: Math.min(cur + 1, slides.length - 1) });
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) useStore.setState({ presenting: Math.max(cur - 1, 0) });
    };
    const resize = () => setSize({ w: innerWidth, h: innerHeight });
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', resize);
    document.documentElement.requestFullscreen?.().catch(() => undefined);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', resize);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
    };
  }, [presenting === null]);
  if (presenting === null || !tree) return null;
  const slides = slidesOf(tree.roots);
  const n = slides[Math.min(presenting, slides.length - 1)];
  if (!n) return null;
  return (
    <div className="present" onClick={() => useStore.setState({ presenting: Math.min(presenting + 1, slides.length - 1) })}>
      <RenderCtx.Provider value={ctx}>
        <Placed n={n} w={size.w} h={size.h} />
      </RenderCtx.Provider>
      <div className="present-hud">
        {presenting + 1} / {slides.length} · ←/→ to navigate · Esc to exit
      </div>
    </div>
  );
}

export function printSlides() {
  const s = useStore.getState();
  const tree = currentTree();
  if (!tree || !s.doc) return;
  const slides = slidesOf(tree.roots);
  if (!slides.length) return s.notify('No frames to export');
  if (inVsCode) return exportSlidePngs(slides);
  const host = document.createElement('div');
  host.className = 'print-root';
  document.body.appendChild(host);
  const first = slides[0];
  const pw = typeof first.props.width === 'number' ? first.props.width : 1280;
  const ph = typeof first.props.height === 'number' ? first.props.height : 720;
  const style = document.createElement('style');
  style.textContent = `@page { size: ${pw}px ${ph}px; margin: 0 }`;
  document.head.appendChild(style);
  const root = createRoot(host);
  const ctx = { doc: { variables: s.doc.variables }, resolveUrl: makeUrlResolver(s.file?.path ?? null) };
  root.render(
    <RenderCtx.Provider value={ctx}>
      {slides.map(n => (
        <div key={n.key} className="print-page" style={{ width: pw, height: ph }}>
          <Placed n={n} w={pw} h={ph} />
        </div>
      ))}
    </RenderCtx.Provider>,
  );
  document.body.classList.add('printing');
  setTimeout(async () => {
    await document.fonts.ready;
    window.print();
    document.body.classList.remove('printing');
    root.unmount();
    host.remove();
    style.remove();
  }, 600);
}
