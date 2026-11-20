// Full-screen slideshow of top-level frames, and PDF export via the browser's print dialog.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { produce } from 'immer';
import { useStore, applyProps } from '../editor/store';
import { useTree, currentTree, buildDetachedTree, builderIndex } from '../editor/tree';
import { stateNames } from '../model/resolve';
import type { RNode } from '../model/types';
import { inVsCode, post } from '../editor/host';
import { displayName } from '../model/doc';
import { renderNodeImage } from '../skia/offscreen';
import { SkiaStage, type StageHit } from './SkiaStage';

/** VS Code webviews cannot print, so slides are exported as numbered PNGs into a folder instead. */
async function exportSlidePngs(slides: RNode[]) {
  const files: { name: string; dataUrl: string }[] = [];
  for (let i = 0; i < slides.length; i++) {
    const { dataUrl } = await renderNodeImage(slides[i].key, { scale: 2, maxSize: 8192 });
    const safe = displayName(slides[i].props).replace(/[\\/:*?"<>|]+/g, '_');
    files.push({ name: `${String(i + 1).padStart(2, '0')} ${safe}.png`, dataUrl });
  }
  post({ type: 'saveFiles', files });
}

function slidesOf(roots: RNode[]) {
  return roots.filter(n => (n.type === 'frame' || n.instanceOf) && n.props.enabled !== false);
}


export function Presenter() {
  const presenting = useStore(s => s.presenting);
  const baseTree = useTree();
  const doc = useStore(s => s.doc);
  const previewTheme = useStore(s => s.previewTheme);
  const [size, setSize] = useState({ w: innerWidth, h: innerHeight });
  // Prototype playback: instances with "hover"/"pressed" states switch automatically; links navigate.
  const [hovered, setHovered] = useState<string[]>([]);
  const [pressed, setPressed] = useState<string | null>(null);
  const [transition, setTransition] = useState('instant');
  const history = useRef<number[]>([]);
  // Layers under the pointer, innermost first (the slide's layout, SkiaStage).
  const hit = useRef<StageHit | null>(null);
  // React derives onPointerLeave from pointerout, and redrawing the slide makes the browser report the pointer
  // leaving the slide's canvas for nowhere and coming straight back over it (which cleared the hover it had just
  // set). A leave is real when the pointer does not come back over the slideshow a moment later.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const leave = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        setHovered([]);
        setPressed(null);
      }, 80);
    };
    const over = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };
    el.addEventListener('pointerleave', leave);
    el.addEventListener('pointerover', over);
    return () => {
      if (timer) clearTimeout(timer);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('pointerover', over);
    };
  }, [presenting === null]);
  const keysAt = (e: { clientX: number; clientY: number }) => hit.current?.(e.clientX, e.clientY) ?? [];
  const tree = useMemo(() => {
    if (!doc || !baseTree || (!hovered.length && !pressed)) return baseTree;
    const want = new Map<string, string>();
    const idx = builderIndex();
    for (const k of hovered) {
      const n = baseTree.byKey.get(k);
      const comp = n?.instanceOf ? idx?.byId.get(n.instanceOf) : undefined;
      const names = stateNames(comp);
      if (k === pressed && names.includes('pressed')) want.set(k, 'pressed');
      else if (names.includes('hover')) want.set(k, 'hover');
    }
    if (!want.size) return baseTree;
    const next = produce(doc, d => {
      for (const [k, st] of want) applyProps(d, k, { state: st });
    });
    return buildDetachedTree(next, previewTheme);
  }, [doc, baseTree, hovered, pressed, previewTheme]);
  const go = (i: number, how = 'instant', push = true) => {
    const cur = useStore.getState().presenting ?? 0;
    if (i === cur) return;
    if (push) history.current.push(cur);
    setTransition(how);
    setHovered([]);
    useStore.setState({ presenting: i });
  };
  useEffect(() => {
    if (presenting === null) return;
    history.current = [];
    useStore.setState({ stateView: null });
    const slides = slidesOf(currentTree()?.roots ?? []);
    const key = (e: KeyboardEvent) => {
      e.stopPropagation();
      const cur = useStore.getState().presenting ?? 0;
      if (e.key === 'Escape') useStore.setState({ presenting: null });
      if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) go(Math.min(cur + 1, slides.length - 1));
      if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) go(Math.max(cur - 1, 0));
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
  const linkOf = (k: string) => {
    const l = tree.byKey.get(k)?.props.link;
    return l && typeof l === 'object' && typeof l.to === 'string' ? l : null;
  };
  let slideHasLinks = false;
  const scan = (x: RNode) => {
    if (slideHasLinks) return;
    if (linkOf(x.key)) slideHasLinks = true;
    else x.children.forEach(scan);
  };
  scan(n);
  const onClick = (e: React.MouseEvent) => {
    const target = keysAt(e).find(k => linkOf(k));
    if (target) {
      const l = linkOf(target)!;
      if (l.to === '__back') {
        const prev = history.current.pop();
        if (prev !== undefined) go(prev, l.transition ?? 'instant', false);
        return;
      }
      const i = slides.findIndex(s => s.key === l.to);
      if (i >= 0) go(i, l.transition ?? 'instant');
      return;
    }
    // Slides without prototype links advance on any click, like a deck.
    if (!slideHasLinks) go(Math.min(presenting + 1, slides.length - 1));
  };
  const onMove = (e: React.PointerEvent) => {
    const ks = keysAt(e).filter(k => tree.byKey.get(k)?.instanceOf || baseTree?.byKey.get(k)?.instanceOf);
    if (ks.join() !== hovered.join()) setHovered(ks);
  };
  const linkCursor = hovered.some(k => linkOf(k));
  return (
    <div
      ref={root}
      className={'present' + (linkCursor ? ' present-hit' : '')}
      onClick={onClick}
      onPointerMove={onMove}
      onPointerDown={e => setPressed(keysAt(e).find(k => hovered.includes(k)) ?? null)}
      onPointerUp={() => setPressed(null)}
    >
      <div key={n.key} className={'present-anim t-' + transition}>
        <SkiaStage n={n} width={size.w} height={size.h} hitRef={hit} />
      </div>
      <div className="present-hud">
        {presenting + 1} / {slides.length} · ←/→ to navigate{slideHasLinks ? ' · click links to follow them' : ''} · Esc to exit
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
  void (async () => {
    // Each slide drawn by Skia at twice its size, fitted to the page like the slideshow does.
    const pages = await Promise.all(slides.map(n => renderNodeImage(n.key, { scale: 2, maxSize: 8192 }).catch(() => null)));
    root.render(
      <>
        {slides.map((n, i) => (
          <div key={n.key} className="print-page" style={{ width: pw, height: ph, display: 'grid', placeItems: 'center' }}>
            {pages[i] && <img src={pages[i]!.dataUrl} style={{ maxWidth: pw, maxHeight: ph }} alt="" />}
          </div>
        ))}
      </>,
    );
    document.body.classList.add('printing');
    await new Promise(r => setTimeout(r, 300));
    window.print();
    document.body.classList.remove('printing');
    root.unmount();
    host.remove();
    style.remove();
  })();
}
