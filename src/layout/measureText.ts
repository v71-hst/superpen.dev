// A first-approximation MeasureText for src/layout/layout.ts, using canvas 2D text metrics. It follows TextView's CSS:
// white-space pre (auto growth) or pre-wrap with break-word (fixed widths), letter spacing after every character,
// line height as a multiplier of the font size or the font's own height for "normal". The Skia painter supplies a
// paragraph-based one with the same interface; tests/layout-diff.mjs reports how close this one is to the browser.
import type { PenDoc, RNode } from '../model/types';
import type { MeasureText } from './layout';
import { resolvedProps } from './layout';
import { weightNum } from '../render/fonts';

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

export function canvasMeasureText(doc?: Pick<PenDoc, 'variables'>): MeasureText {
  const ctx = (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  const cache = new WeakMap<RNode, Map<number | null, { w: number; h: number }>>();
  return (n, maxWidth) => {
    let byW = cache.get(n);
    if (!byW) cache.set(n, (byW = new Map()));
    const hit = byW.get(maxWidth);
    if (hit) return hit;
    const p = resolvedProps(n, doc);
    const size = num(p.fontSize, 14);
    const family = typeof p.fontFamily === 'string' && p.fontFamily ? p.fontFamily : 'Inter';
    ctx.font = `${p.fontStyle === 'italic' ? 'italic ' : ''}${weightNum(p.fontWeight)} ${size}px "${family}", "Inter", system-ui, sans-serif`;
    const ls = p.letterSpacing !== undefined ? num(p.letterSpacing) : 0;
    (ctx as any).letterSpacing = `${ls}px`;
    const m = ctx.measureText('Hg');
    const lineH = typeof p.lineHeight === 'number' && p.lineHeight > 0 ? p.lineHeight * size : m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
    const content = typeof p.content === 'string' ? p.content : p.content === undefined ? '' : String(p.content);
    const width = (s: string) => (s ? ctx.measureText(s).width : 0);
    // An empty text still has one line (TextView renders a zero-width space).
    const paras = (content || '​').split('\n');
    // Max-content (longest hard line) and min-content (longest word) widths.
    let maxContent = 0;
    let minContent = 0;
    for (const para of paras) {
      maxContent = Math.max(maxContent, width(para));
      for (const word of para.split(' ')) minContent = Math.max(minContent, width(word));
    }
    let r: { w: number; h: number };
    if (maxWidth === null) r = { w: maxContent, h: paras.length * lineH };
    else {
      // pre-wrap: break at spaces (trailing spaces hang); a word longer than the line breaks anywhere
      // (overflow-wrap: break-word).
      // Chrome compares in 1/64 px units, so a word exactly as wide as the line still fits.
      const fits = (s: string) => width(s.trimEnd()) <= maxWidth + 1 / 64;
      let lines = 0;
      for (const para of paras) {
        let line = '';
        // A line holding only a word too long for it breaks inside the word.
        const breakLong = () => {
          while (maxWidth > 0 && line.trimEnd().length > 1 && !fits(line)) {
            let k = line.length - 1;
            while (k > 1 && !fits(line.slice(0, k))) k--;
            lines++;
            line = line.slice(k);
          }
        };
        for (const word of para.split(/(?<= )/)) {
          if (!line || fits(line + word)) {
            line += word;
            if (line === word) breakLong();
            continue;
          }
          lines++;
          line = word;
          breakLong();
        }
        lines++;
      }
      // Width as the layout's contract says: shrink-to-fit at maxWidth.
      r = { w: Math.min(maxContent, Math.max(minContent, maxWidth)), h: lines * lineH };
    }
    byW.set(maxWidth, r);
    return r;
  };
}
