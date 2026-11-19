// HTML import: a web page, an .html file or pasted markup becomes editable layers. The markup is laid out by the
// browser in a hidden frame of the chosen width (scripts are never run), then every visible element is read back:
// where it is, its background, border, radius, shadow and opacity, its text and font. Elements become frames, text
// becomes text layers, <img> becomes picture fills, inline <svg> becomes vector paths. Layers are placed where the
// browser put them (free positions, not auto layout), so the import looks like the page; restructuring into auto
// layout is left to the designer or the AI afterwards.
import type { PenNode } from '../model/types';
import { svgToNodes } from '../model/svgImport';

export type HtmlImport = { node: PenNode; count: number; warnings: string[] };
export type HtmlImportOptions = { width?: number; name?: string; baseUrl?: string; /** Stylesheets fetched for the page (a hidden frame cannot load them itself): href -> css. */ styles?: Record<string, string> };

const MAX_NODES = 5000;
const SKIP = new Set(['SCRIPT', 'STYLE', 'META', 'LINK', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE', 'BR', 'WBR', 'IFRAME', 'OBJECT', 'EMBED', 'SOURCE', 'TRACK', 'MAP', 'AREA', 'OPTION', 'DATALIST']);
const INLINE_TEXT = new Set(['SPAN', 'A', 'B', 'I', 'EM', 'STRONG', 'SMALL', 'CODE', 'SUB', 'SUP', 'U', 'S', 'MARK', 'ABBR', 'CITE', 'Q', 'LABEL', 'TIME', 'KBD', 'VAR', 'SAMP', 'BDI', 'BDO', 'FONT', 'BR', 'WBR']);

export function looksLikeHtml(text: string): boolean {
  const t = text.trim();
  if (t.length < 15 || t[0] !== '<' || /^<svg[\s>]/i.test(t) || /^<\?xml/i.test(t)) return false;
  return /<(html|body|div|section|main|header|footer|nav|article|p|h[1-6]|ul|ol|table|button|form|span|a|img)[\s>]/i.test(t) && /<\/[a-z][a-z0-9]*\s*>/i.test(t);
}

const round = (v: number) => Math.round(v * 100) / 100;

/** "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" / modern "rgb(1 2 3 / 50%)" as "#RRGGBB[AA]"; null when fully transparent. */
function cssColor(c: string): string | null {
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (!m) return null;
  const p = m[1].split(/[\s,/]+/).filter(Boolean);
  const ch = (v: string) => Math.max(0, Math.min(255, Math.round(v.endsWith('%') ? (parseFloat(v) * 255) / 100 : parseFloat(v))));
  const a = p[3] === undefined ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
  if (!(a > 0)) return null;
  const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();
  return `#${hex(ch(p[0]))}${hex(ch(p[1]))}${hex(ch(p[2]))}${a < 1 ? hex(Math.round(a * 255)) : ''}`;
}

/** Top-level comma-separated parts of a CSS value (commas inside parentheses stay). */
function splitTop(v: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const c of v) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && !depth) (out.push(cur.trim()), (cur = ''));
    else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A computed `linear-gradient(...)` as a gradient fill, or null if it is something else. */
function cssGradient(v: string): any | null {
  const m = v.match(/^(repeating-)?linear-gradient\((.*)\)$/is);
  if (!m) return null;
  const parts = splitTop(m[2]);
  let angle = 180;
  const first = parts[0] ?? '';
  if (/deg|turn|rad|^to\s/i.test(first) && !/rgb/i.test(first)) {
    parts.shift();
    const d = first.match(/(-?[\d.]+)deg/i);
    if (d) angle = parseFloat(d[1]);
    else if (/^to\s/i.test(first)) angle = ({ top: 0, right: 90, bottom: 180, left: 270 } as any)[first.replace(/^to\s+/i, '').trim()] ?? 180;
  }
  const stops = parts.map(s => {
    const color = cssColor(s) ?? '#00000000';
    const pos = s.replace(/rgba?\([^)]*\)/i, '').match(/(-?[\d.]+)%/);
    return { color, position: pos ? parseFloat(pos[1]) / 100 : NaN };
  });
  if (stops.length < 2) return null;
  stops.forEach((s, i) => {
    if (isNaN(s.position)) s.position = i / (stops.length - 1);
    s.position = Math.max(0, Math.min(1, round(s.position)));
  });
  // CSS angles run clockwise from "up"; the format's rotation runs counter-clockwise from "up".
  return { type: 'gradient', gradientType: 'linear', rotation: round((360 - angle) % 360), colors: stops };
}

function cssShadows(v: string): any[] {
  if (!v || v === 'none') return [];
  return splitTop(v)
    .map(s => {
      const color = cssColor(s) ?? '#00000040';
      const nums = (s.replace(/rgba?\([^)]*\)/i, '').match(/-?[\d.]+px/g) ?? []).map(parseFloat);
      if (nums.length < 2) return null;
      return { type: 'shadow', shadowType: /inset/.test(s) ? 'inner' : 'outer', offset: { x: nums[0], y: nums[1] }, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color };
    })
    .filter(Boolean);
}

function fontFamily(v: string): string {
  const first = (v.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
  return !first || /^(-apple-system|system-ui|blinkmacsystemfont|ui-sans-serif|sans-serif|segoe ui|helvetica neue|helvetica|arial)$/i.test(first) ? 'Inter' : /^(ui-monospace|monospace|sfmono-regular|menlo|consolas|courier new)$/i.test(first) ? 'Roboto Mono' : /^(ui-serif|serif|georgia|times new roman|times)$/i.test(first) ? 'Lora' : first;
}

/** Lays the markup out in a hidden frame and hands its document to `read`; the frame is removed afterwards. */
async function withRendered<T>(html: string, width: number, opts: HtmlImportOptions, read: (doc: Document, win: Window) => T): Promise<T> {
  // No scripts, and stylesheets the frame could not load itself are put in as text.
  let markup = html.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '').replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  if (opts.styles) markup = markup.replace(/<link\b[^>]*rel\s*=\s*["']?stylesheet["']?[^>]*>/gi, tag => {
    const href = tag.match(/href\s*=\s*["']?([^"'\s>]+)/i)?.[1];
    const css = href ? opts.styles![href] : undefined;
    return css === undefined ? tag : `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`;
  });
  const base = opts.baseUrl ? `<base href="${opts.baseUrl.replace(/"/g, '&quot;')}">` : '';
  if (!/<html[\s>]/i.test(markup)) markup = `<!doctype html><html><head>${base}<meta charset="utf-8"><style>body{margin:0;font-family:Inter,system-ui,sans-serif}</style></head><body>${markup}</body></html>`;
  else if (base) markup = markup.replace(/<head([^>]*)>/i, `<head$1>${base}`);
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:900px;border:0;visibility:hidden;pointer-events:none`;
  document.body.appendChild(frame);
  try {
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => res(), 6000);
      frame.onload = () => (clearTimeout(t), res());
      frame.onerror = () => (clearTimeout(t), rej(new Error('the page could not be laid out')));
      frame.srcdoc = markup;
    });
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win || !doc.body) throw new Error('the page could not be laid out here');
    // Web fonts and pictures change sizes: give them a moment, but never hang on a slow one.
    await Promise.race([Promise.all([(doc as any).fonts?.ready, ...[...doc.images].filter(i => !i.complete).map(i => new Promise(r => ((i.onload = r), (i.onerror = r))))]), new Promise(r => setTimeout(r, 4000))]);
    return read(doc, win);
  } finally {
    frame.remove();
  }
}

export async function htmlToNodes(html: string, opts: HtmlImportOptions = {}): Promise<HtmlImport> {
  const width = Math.max(240, Math.min(3840, Math.round(opts.width ?? 1280)));
  return withRendered(html, width, opts, (doc, win) => {
    const warn = new Map<string, number>();
    const note = (k: string) => warn.set(k, (warn.get(k) ?? 0) + 1);
    let count = 0;
    let ids = 0;
    const id = () => 'h' + (ids++).toString(36);
    const cs = (el: Element) => win.getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const pageRect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height };
    };

    /** Paint an element contributes itself (not its children), as node props; empty when it is only a wrapper. */
    const paint = (el: Element, st: CSSStyleDeclaration, w: number, h: number): Record<string, any> => {
      const out: Record<string, any> = {};
      const fills: any[] = [];
      const bg = cssColor(st.backgroundColor);
      if (bg) fills.push(bg);
      if (st.backgroundImage && st.backgroundImage !== 'none') {
        for (const layer of splitTop(st.backgroundImage).reverse()) {
          const url = layer.match(/^url\(["']?(.*?)["']?\)$/i)?.[1];
          const grad = cssGradient(layer);
          if (url) fills.push({ type: 'image', url, mode: /contain/.test(st.backgroundSize) ? 'contain' : /100% 100%/.test(st.backgroundSize) ? 'stretch' : 'cover' });
          else if (grad) fills.push(grad);
          else note('backgrounds that are not a picture or a linear gradient');
        }
      }
      if (fills.length) out.fill = fills.length === 1 ? fills[0] : fills;
      const bw = [px(st.borderTopWidth), px(st.borderRightWidth), px(st.borderBottomWidth), px(st.borderLeftWidth)];
      const bs = [st.borderTopStyle, st.borderRightStyle, st.borderBottomStyle, st.borderLeftStyle];
      const bc = [st.borderTopColor, st.borderRightColor, st.borderBottomColor, st.borderLeftColor].map(cssColor);
      const sides = bw.map((v, i) => (bs[i] !== 'none' && bs[i] !== 'hidden' && bc[i] ? v : 0));
      if (sides.some(v => v > 0)) {
        out.stroke = bc[sides.findIndex(v => v > 0)]!;
        out.strokeWidth = sides.every(v => v === sides[0]) ? sides[0] : { top: sides[0], right: sides[1], bottom: sides[2], left: sides[3] };
        out.strokeAlignment = 'inner';
        if (bs.some(s => s === 'dashed' || s === 'dotted')) out.strokeDash = bs.includes('dotted') ? [1, 3] : [6, 4];
      }
      const radius = [st.borderTopLeftRadius, st.borderTopRightRadius, st.borderBottomRightRadius, st.borderBottomLeftRadius].map(v => {
        const first = v.split(' ')[0];
        return round(Math.min(first.endsWith('%') ? (parseFloat(first) / 100) * Math.min(w, h) : px(first), Math.min(w, h) / 2));
      });
      if (radius.some(v => v > 0)) out.cornerRadius = radius.every(v => v === radius[0]) ? radius[0] : radius;
      const shadows = cssShadows(st.boxShadow);
      if (shadows.length) out.effect = shadows.length === 1 ? shadows[0] : shadows;
      return out;
    };

    const textProps = (st: CSSStyleDeclaration) => {
      const size = px(st.fontSize) || 16;
      const lh = st.lineHeight === 'normal' ? undefined : round(px(st.lineHeight) / size);
      const out: Record<string, any> = { fontFamily: fontFamily(st.fontFamily), fontSize: round(size), fontWeight: String(parseInt(st.fontWeight, 10) || 400), fill: cssColor(st.color) ?? '#000000' };
      if (lh && lh > 0) out.lineHeight = lh;
      if (st.fontStyle === 'italic' || st.fontStyle === 'oblique') out.fontStyle = 'italic';
      if (px(st.letterSpacing)) out.letterSpacing = round(px(st.letterSpacing));
      const align = st.textAlign === 'start' ? 'left' : st.textAlign === 'end' ? 'right' : st.textAlign;
      if (align === 'center' || align === 'right' || align === 'justify') out.textAlign = align;
      const deco = st.textDecorationLine || st.textDecoration;
      if (/underline/.test(deco)) out.underline = true;
      if (/line-through/.test(deco)) out.strikethrough = true;
      return out;
    };

    /** Whether an element is a run of text: nothing in it but text and plain inline tags. */
    const isTextBlock = (el: Element): boolean => {
      if (!(el as HTMLElement).innerText?.trim()) return false;
      for (const d of el.querySelectorAll('*')) {
        if (!INLINE_TEXT.has(d.tagName)) return false;
        const st = cs(d);
        if (st.display !== 'inline' && d.tagName !== 'BR') return false;
        if (cssColor(st.backgroundColor) || px(st.borderTopWidth)) return false;
      }
      return true;
    };

    const visit = (el: Element, origin: { x: number; y: number }): PenNode[] => {
      if (count >= MAX_NODES || SKIP.has(el.tagName)) return [];
      const st = cs(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.visibility === 'collapse' || parseFloat(st.opacity) === 0) return [];
      const r = pageRect(el);
      const at = { x: round(r.x - origin.x), y: round(r.y - origin.y) };
      const name = el.id ? `#${el.id}` : (el.getAttribute('aria-label') ?? (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/)[0] : el.tagName.toLowerCase()));
      const common: Record<string, any> = { name: name.slice(0, 60), ...at };
      if (parseFloat(st.opacity) < 1) common.opacity = round(parseFloat(st.opacity));
      if (st.transform && st.transform !== 'none' && !/^matrix\(1, 0, 0, 1, /.test(st.transform)) note('rotated or scaled elements (placed by their outer box)');

      if (el.tagName === 'IMG') {
        const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src;
        if (!src || r.w < 1 || r.h < 1) return [];
        count++;
        const fit = st.objectFit;
        return [{ type: 'rectangle', id: id(), ...common, name: ((el as HTMLImageElement).alt || 'image').slice(0, 60), width: round(r.w), height: round(r.h), ...paint(el, st, r.w, r.h), fill: { type: 'image', url: src, mode: fit === 'contain' || fit === 'scale-down' ? 'contain' : fit === 'cover' ? 'cover' : 'stretch' } }];
      }
      if (el.tagName === 'svg' || el.tagName === 'SVG') {
        if (r.w < 1 || r.h < 1) return [];
        try {
          const clone = el.cloneNode(true) as SVGElement;
          // currentColor and inherited fills are resolved against the page, not against the import.
          if (!clone.getAttribute('fill') && st.fill && st.fill !== 'none') clone.setAttribute('fill', st.fill);
          clone.setAttribute('color', st.color);
          if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${r.w} ${r.h}`);
          const made = svgToNodes(new XMLSerializer().serializeToString(clone).replace(/currentColor/g, cssColor(st.color) ?? '#000000'), { width: round(r.w), height: round(r.h), name: 'svg' });
          count += 1 + (made.paths ?? 0);
          return [{ ...made.node, id: id(), ...at, children: renumber(made.node.children ?? []) } as PenNode];
        } catch {
          note('inline SVGs that could not be converted');
          return [];
        }
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
        if (r.w < 1 || r.h < 1 || (el as HTMLInputElement).type === 'hidden') return [];
        const inp = el as HTMLInputElement;
        const value = inp.value || inp.placeholder || '';
        count += 2;
        const tp = textProps(st);
        if (!inp.value && inp.placeholder) tp.fill = '#9AA0A8';
        return [{ type: 'frame', id: id(), ...common, width: round(r.w), height: round(r.h), layout: 'horizontal', alignItems: 'center', padding: [0, round(px(st.paddingLeft))], ...paint(el, st, r.w, r.h), children: value ? [{ type: 'text', id: id(), content: value, ...tp }] : [] }];
      }
      if (isTextBlock(el)) {
        const own = paint(el, st, r.w, r.h);
        const content = (el as HTMLElement).innerText.replace(/ /g, ' ').trim();
        const size = px(st.fontSize) || 16;
        const lineH = st.lineHeight === 'normal' ? size * 1.2 : px(st.lineHeight);
        // The glyphs' own box: the element's content box (its padding and border belong to the frame around it).
        const pad = { l: px(st.paddingLeft) + px(st.borderLeftWidth), t: px(st.paddingTop) + px(st.borderTopWidth), r: px(st.paddingRight) + px(st.borderRightWidth), b: px(st.paddingBottom) + px(st.borderBottomWidth) };
        const tw = Math.max(1, r.w - pad.l - pad.r), th = Math.max(1, r.h - pad.t - pad.b);
        const wraps = th > lineH * 1.6 || /\n/.test(content);
        const text: PenNode = { type: 'text', id: id(), name: content.slice(0, 40), content, ...textProps(st), ...(wraps || (st.textAlign !== 'start' && st.textAlign !== 'left') ? { textGrowth: 'fixed-width', width: round(tw + 0.5) } : {}) };
        if (el.querySelector('*') && [...el.querySelectorAll('*')].some(d => { const s = cs(d); return s.fontWeight !== st.fontWeight || s.color !== st.color || s.fontSize !== st.fontSize; })) note('text with mixed styles (imported in the style of its block)');
        count++;
        if (!Object.keys(own).length) return [{ ...text, x: round(at.x + pad.l), y: round(at.y + pad.t), ...(common.opacity !== undefined ? { opacity: common.opacity } : {}) }];
        count++;
        return [{ type: 'frame', id: id(), ...common, width: round(r.w), height: round(r.h), layout: 'none', ...own, children: [{ ...text, x: round(pad.l), y: round(pad.t + Math.max(0, (th - lineH * Math.max(1, Math.round(th / lineH))) / 2)) }] }];
      }
      // A container. Text directly inside it, beside other elements, becomes text layers of its own.
      const own = paint(el, st, r.w, r.h);
      const clips = st.overflow !== 'visible' && st.overflowX !== 'visible';
      const wrapper = !Object.keys(own).length && !clips && common.opacity === undefined;
      const inner = wrapper ? origin : { x: r.x, y: r.y };
      const kids: PenNode[] = [];
      for (const c of el.childNodes) {
        if (c.nodeType === 1) kids.push(...visit(c as Element, inner));
        else if (c.nodeType === 3 && c.textContent?.trim()) {
          const range = doc.createRange();
          range.selectNodeContents(c);
          const b = range.getBoundingClientRect();
          if (b.width < 1 || b.height < 1) continue;
          count++;
          const size = px(st.fontSize) || 16;
          const lineH = st.lineHeight === 'normal' ? size * 1.2 : px(st.lineHeight);
          kids.push({ type: 'text', id: id(), content: c.textContent.replace(/\s+/g, ' ').trim(), ...textProps(st), x: round(b.left + win.scrollX - inner.x), y: round(b.top + win.scrollY - inner.y), ...(b.height > lineH * 1.6 ? { textGrowth: 'fixed-width', width: round(b.width + 0.5) } : {}) });
        }
      }
      for (const pseudo of ['::before', '::after']) {
        const ps = win.getComputedStyle(el, pseudo);
        if (ps.content && ps.content !== 'none' && ps.content !== 'normal' && (ps.content !== '""' || cssColor(ps.backgroundColor) || ps.backgroundImage !== 'none')) note('generated content (::before / ::after)');
      }
      // A wrapper that paints nothing adds no layer: its children stand in for it.
      if (wrapper) return kids;
      if (r.w < 0.5 || r.h < 0.5) return kids.length ? kids : [];
      count++;
      return [{ type: 'frame', id: id(), ...common, width: round(r.w), height: round(r.h), layout: 'none', ...(clips ? { clip: true } : {}), ...own, children: kids }];
    };
    const renumber = (nodes: PenNode[]): PenNode[] => nodes.map(n => ({ ...n, id: id(), ...(n.children ? { children: renumber(n.children) } : {}) }));

    const body = doc.body;
    const root = doc.documentElement;
    const height = Math.max(root.scrollHeight, body.scrollHeight, 1);
    const pageBg = cssColor(cs(body).backgroundColor) ?? cssColor(cs(root).backgroundColor) ?? '#FFFFFF';
    const children: PenNode[] = [];
    for (const c of body.children) children.push(...visit(c, { x: 0, y: 0 }));
    if (count >= MAX_NODES) note(`more than ${MAX_NODES} layers (the rest of the page was left out)`);
    const node: PenNode = { type: 'frame', id: id(), name: (opts.name ?? doc.title ?? 'Imported page').slice(0, 80) || 'Imported page', width, height: round(height), layout: 'none', clip: true, fill: pageBg, children };
    return { node, count: count + 1, warnings: [...warn].map(([k, n]) => `${n} × ${k}`) };
  });
}
