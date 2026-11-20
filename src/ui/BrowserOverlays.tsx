// Browser nodes show a live web page, which no canvas can draw: Skia draws their box (painter.ts drawBrowser) and the
// page is an iframe placed over it here, at the node's design size and scaled with the view, as it was inside the
// page-element renderer. Only while the box is large enough on screen to be read (zoomed out, hundreds of live pages
// would cost far more than they show) and at most MAX_PAGES of them, the largest. The page sits above everything
// drawn on the canvas, also what overlaps it in the design.
import React from 'react';
import { useStore } from '../editor/store';
import type { Tree } from '../editor/tree';
import { nodeRect, skiaOwns } from '../editor/measure';
import { canvasRect } from '../editor/ops';
import { resolveProps } from '../model/props';
import { usePictureFramesVersion } from '../skia/pictureFrames';

const MIN_SCREEN_WIDTH = 160;
const MAX_PAGES = 8;

export function BrowserOverlays({ tree }: { tree: Tree }) {
  const view = useStore(s => s.view);
  const doc = useStore(s => s.doc);
  usePictureFramesVersion();
  if (!doc) return null;
  const c = canvasRect();
  const shown: { key: string; url: string; x: number; y: number; w: number; h: number; radius: any; area: number }[] = [];
  for (const n of tree.byKey.values()) {
    if (n.type !== 'browser' || !skiaOwns(n.key)) continue;
    const p = resolveProps(doc, n.props, n.theme);
    if (p.enabled === false || !p.url) continue;
    const r = nodeRect(n.key);
    if (!r || r.w * view.zoom < MIN_SCREEN_WIDTH) continue;
    const sx = view.x + r.x * view.zoom, sy = view.y + r.y * view.zoom;
    if (sx > c.width || sy > c.height || sx + r.w * view.zoom < 0 || sy + r.h * view.zoom < 0) continue;
    shown.push({ key: n.key, url: String(p.url), x: sx, y: sy, w: r.w, h: r.h, radius: p.cornerRadius, area: r.w * r.h });
  }
  shown.sort((a, b) => b.area - a.area);
  return (
    <>
      {shown.slice(0, MAX_PAGES).map(b => (
        <div
          key={b.key}
          data-browser-overlay={b.key}
          style={{ position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h, transform: `scale(${view.zoom})`, transformOrigin: '0 0', overflow: 'hidden', borderRadius: radiusCss(b.radius), background: '#fff', pointerEvents: 'none', contain: 'strict' }}
        >
          <iframe src={b.url} title={b.key} style={{ display: 'block', border: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
        </div>
      ))}
    </>
  );
}

function radiusCss(v: any): string | undefined {
  if (Array.isArray(v)) return v.map(x => `${Number(x) || 0}px`).join(' ');
  return typeof v === 'number' && v > 0 ? `${v}px` : undefined;
}
