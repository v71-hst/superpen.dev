// Figma text nodes -> .pen text properties.
import type { PenNode } from '../../model/types';
import { convertPaints, type PaintCtx } from './paints';
import type { FNode, Scene } from './scene';
import { applySharedStyles } from './styles';

type TextCtx = PaintCtx & { scene: Scene };

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const round = (v: number, p: number) => Math.round(v * p) / p;

// Longest names first, so that "Semi Bold" is not read as "Bold".
const WEIGHTS: [RegExp, number][] = [
  [/(extra|ultra)[\s-]*black|extrablack|ultrablack/, 950],
  [/(extra|ultra)[\s-]*bold|extrabold|ultrabold/, 800],
  [/(semi|demi)[\s-]*bold|semibold|demibold/, 600],
  [/(extra|ultra)[\s-]*light|extralight|ultralight/, 200],
  [/hairline|thin/, 100],
  [/black|heavy/, 900],
  [/bold/, 700],
  [/medium/, 500],
  [/light/, 300],
  [/regular|normal|book|roman/, 400],
];

/** "Semi Bold Italic" -> { weight: 600, italic: true }. */
export function parseFontStyle(style: any): { weight: number; italic: boolean } {
  const s = typeof style === 'string' ? style.toLowerCase() : '';
  const italic = /italic|oblique/.test(s);
  for (const [re, weight] of WEIGHTS) if (re.test(s)) return { weight, italic };
  const n = s.match(/\b([1-9]00)\b/);
  return { weight: n ? parseInt(n[1], 10) : 400, italic };
}

function fontOf(n: FNode, style: any): { family: string; weight: number; italic: boolean } {
  const name = style.fontName ?? {};
  const family = typeof name.family === 'string' && name.family ? name.family : 'Inter';
  const parsed = parseFontStyle(name.style);
  // Figma records the real weight of each font it laid the text out with: more reliable than the style's name.
  const meta = (n.derivedTextData?.fontMetaData ?? n.textData?.fontMetaData ?? []).find((m: any) => m?.key?.family === name.family && m?.key?.style === name.style);
  const weight = meta && num(meta.fontWeight) >= 1 ? Math.round(num(meta.fontWeight)) : parsed.weight;
  const italic = meta && typeof meta.fontStyle === 'string' ? meta.fontStyle === 'ITALIC' : parsed.italic;
  return { family, weight: Math.max(1, Math.min(1000, weight)), italic };
}

/** The style that covers most of the text, when parts of it are styled differently. */
function dominantStyle(n: FNode, ctx: TextCtx): any {
  const td = n.textData ?? {};
  const ids: number[] = Array.isArray(td.characterStyleIDs) ? td.characterStyleIDs : [];
  const table: any[] = Array.isArray(td.styleOverrideTable) ? td.styleOverrideTable : [];
  if (!ids.length || !table.length) return n;
  const length = typeof td.characters === 'string' ? td.characters.length : ids.length;
  const counts = new Map<number, number>();
  for (let i = 0; i < length; i++) {
    const id = i < ids.length ? num(ids[i]) : 0;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const withOverride = (id: number) => {
    const o = id ? table.find(s => s?.styleID === id) : undefined;
    if (!o) return n;
    const merged = { ...n, ...o };
    applySharedStyles(ctx.scene, merged); // a run of text can use a shared style of its own
    return merged;
  };
  if (counts.size < 2) return withOverride([...counts.keys()][0] ?? 0);
  ctx.notes.add('text layers with more than one style (the most used style is applied to all of the text)');
  let best = 0, bestCount = -1;
  for (const [id, c] of counts) {
    if (c > bestCount) {
      best = id;
      bestCount = c;
    }
  }
  return withOverride(best);
}

function applyCase(text: string, textCase: any, ctx: PaintCtx): string {
  switch (textCase) {
    case 'UPPER':
      ctx.notes.add('text with an upper / lower / title case setting (the characters themselves were changed)');
      return text.toUpperCase();
    case 'LOWER':
      ctx.notes.add('text with an upper / lower / title case setting (the characters themselves were changed)');
      return text.toLowerCase();
    case 'TITLE':
      ctx.notes.add('text with an upper / lower / title case setting (the characters themselves were changed)');
      return text.replace(/(^|[\s\-([{"'])(\p{L})/gu, (_, pre, ch) => pre + ch.toUpperCase());
    case 'SMALL_CAPS':
    case 'SMALL_CAPS_FORCED':
      ctx.notes.add('small caps (drawn as ordinary text)');
      return text;
    default:
      return text;
  }
}

/** Bulleted and numbered lists become plain text with the bullets and numbers typed in. */
function applyLists(text: string, lines: any, ctx: PaintCtx): string {
  if (!Array.isArray(lines) || !lines.some(l => l && (l.lineType === 'ORDERED_LIST' || l.lineType === 'UNORDERED_LIST'))) return text;
  const paragraphs = text.split('\n');
  const counters: number[] = [];
  const out = paragraphs.map((p, i) => {
    const l = lines[i];
    const type = l?.lineType;
    if (type !== 'ORDERED_LIST' && type !== 'UNORDERED_LIST') {
      counters.length = 0;
      return p;
    }
    const level = Math.max(1, num(l.indentationLevel, 1));
    counters.length = level;
    const indent = '    '.repeat(level - 1);
    if (type === 'UNORDERED_LIST') {
      counters[level - 1] = 0;
      return `${indent}• ${p}`;
    }
    counters[level - 1] = l.isFirstLineOfList === true ? Math.max(1, num(l.listStartOffset) + 1) : (counters[level - 1] ?? 0) + 1;
    return `${indent}${counters[level - 1]}. ${p}`;
  });
  ctx.notes.add('bulleted / numbered lists (written out as plain text)');
  return out.join('\n');
}

const H_ALIGN: Record<string, string> = { CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };
const V_ALIGN: Record<string, string> = { CENTER: 'middle', BOTTOM: 'bottom' };

export function convertText(n: FNode, pen: PenNode, ctx: TextCtx, applySize: (pen: PenNode, hugW: boolean, hugH: boolean) => void) {
  const td = n.textData ?? {};
  const style = dominantStyle(n, ctx);
  let content = typeof td.characters === 'string' ? td.characters : '';
  content = applyLists(content, td.lines, ctx);
  content = applyCase(content, style.textCase, ctx);
  pen.content = content;

  const font = fontOf(n, style);
  const fontSize = num(style.fontSize, 12) > 0 ? num(style.fontSize, 12) : 12;
  pen.fontFamily = font.family;
  pen.fontSize = round(fontSize, 100);
  pen.fontWeight = String(font.weight);
  if (font.italic) pen.fontStyle = 'italic';

  // Line height: a .pen value is a multiple of the font size.
  const lh = style.lineHeight;
  const laidOut = num((n.derivedTextData ?? td).baselines?.[0]?.lineHeight);
  if (lh && lh.units === 'PIXELS' && num(lh.value) > 0) pen.lineHeight = round(lh.value / fontSize, 10000);
  else if (lh && lh.units === 'RAW' && num(lh.value) > 0) pen.lineHeight = round(lh.value, 10000);
  else if (laidOut > 0 && style === n) pen.lineHeight = round(laidOut / fontSize, 10000); // "auto": what Figma used
  else if (lh && lh.units === 'PERCENT' && num(lh.value) > 0 && Math.abs(lh.value - 100) > 0.01) pen.lineHeight = round((lh.value / 100) * 1.2, 10000);

  const ls = style.letterSpacing;
  if (ls && num(ls.value)) {
    const px = ls.units === 'PERCENT' ? (ls.value / 100) * fontSize : ls.value;
    if (Math.abs(px) >= 0.001) pen.letterSpacing = round(px, 1000);
  }

  if (H_ALIGN[style.textAlignHorizontal]) pen.textAlign = H_ALIGN[style.textAlignHorizontal];
  if (V_ALIGN[style.textAlignVertical]) pen.textAlignVertical = V_ALIGN[style.textAlignVertical];

  // What grows with the text: both sides, the height only, or nothing.
  const resize = n.textAutoResize;
  const growth = resize === 'WIDTH_AND_HEIGHT' ? 'auto' : resize === 'HEIGHT' ? 'fixed-width' : 'fixed-width-height';
  pen.textGrowth = growth;
  applySize(pen, growth === 'auto', growth !== 'fixed-width-height');

  if (style.textDecoration === 'UNDERLINE') pen.underline = true;
  if (style.textDecoration === 'STRIKETHROUGH') pen.strikethrough = true;

  const fill = convertPaints(style.fillPaints, num(n.size?.x), num(n.size?.y), ctx);
  if (fill !== undefined) pen.fill = fill;
  else pen.fill = '#00000000'; // no paint in Figma means invisible text; .pen text without a fill is black
}
