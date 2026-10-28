// Renders resolved .pen nodes as positioned DOM (frames/text/rects) and SVG (shapes).
import React, { createContext, memo, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import * as Lucide from 'lucide-react';
import feather from 'feather-icons';
import type { PenDoc, RNode } from '../model/types';
import { deepResolve } from '../model/resolve';
import { colorCss, effectList, fillList, fillsToBackground, isEnabled, linearEndpoints, normalizeStroke, primaryColor, type StrokeInfo } from './paint';
import { ellipseGeometry, pathGeometry, polygonGeometry } from './geometry';
import { ensureFont, ensureIconFont, weightNum } from './fonts';
import { ShaderEffectHost, ShaderFillCanvas } from './ShaderLayer';
import type { ShapeSpec } from './shaders';
import { scriptState } from '../editor/scriptHost';
import { useStore } from '../editor/store';

export type ParentLayout = 'none' | 'horizontal' | 'vertical';

export type RenderContextValue = {
  doc: Pick<PenDoc, 'variables'>;
  resolveUrl: (u: string) => string;
  editingKey?: string | null;
  onTextCommit?: (key: string, text: string | null) => void;
};

export const RenderCtx = createContext<RenderContextValue>({ doc: {}, resolveUrl: u => u });

const SKIP_RESOLVE = new Set(['children', 'descendants', 'id', 'type', 'ref', 'name', 'context', 'metadata']);

function resolveProps(doc: Pick<PenDoc, 'variables'>, props: any, theme: any) {
  const out: any = {};
  for (const k of Object.keys(props)) out[k] = SKIP_RESOLVE.has(k) ? props[k] : deepResolve(doc as PenDoc, props[k], theme);
  return out;
}

const num = (v: any, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

type Sizing = { mode: 'fixed'; px: number } | { mode: 'fill'; fallback?: number } | { mode: 'fit'; fallback?: number };

export function parseSizing(v: any): Sizing {
  if (typeof v === 'number' && isFinite(v)) return { mode: 'fixed', px: v };
  if (typeof v === 'string') {
    const m = v.match(/^(fill_container|fit_content)(?:\(([-\d.]+)\))?$/);
    if (m) {
      const fb = m[2] !== undefined ? parseFloat(m[2]) : undefined;
      return m[1] === 'fill_container' ? { mode: 'fill', fallback: fb } : { mode: 'fit', fallback: fb };
    }
    const n = parseFloat(v);
    if (isFinite(n)) return { mode: 'fixed', px: n };
  }
  return { mode: 'fit' };
}

/** Extent of absolutely positioned children, used for fit_content on frames without flex layout. */
function childExtent(n: RNode, axis: 'x' | 'y'): number {
  let max = 0;
  for (const c of n.children) {
    const p = c.props;
    const s = parseSizing(axis === 'x' ? p.width : p.height);
    const size = s.mode === 'fixed' ? s.px : (s.fallback ?? 0);
    max = Math.max(max, num(axis === 'x' ? p.x : p.y) + size);
  }
  return max;
}

function cornerRadius(v: any): string | undefined {
  if (Array.isArray(v)) return v.map(x => `${num(x)}px`).join(' ');
  const r = num(v);
  return r ? `${r}px` : undefined;
}

function paddingCss(v: any): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) {
    if (v.length === 2) return `${num(v[0])}px ${num(v[1])}px`;
    if (v.length === 4) return v.map(x => `${num(x)}px`).join(' ');
    return `${num(v[0])}px`;
  }
  return `${num(v)}px`;
}

const JUSTIFY: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', space_between: 'space-between', space_around: 'space-around' };
const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end' };

/** Position, size, transform and opacity shared by every node type. */
function boxStyle(n: RNode, p: any, parentLayout: ParentLayout, opts: { autoW?: boolean; autoH?: boolean; fitW?: number; fitH?: number } = {}): CSSProperties {
  const st: CSSProperties = { boxSizing: 'border-box' };
  const absolute = parentLayout === 'none' || p.layoutPosition === 'absolute';
  if (absolute) {
    st.position = 'absolute';
    st.left = num(p.x);
    st.top = num(p.y);
  } else {
    st.position = 'relative';
    st.flexShrink = 0;
  }
  const mainIsX = parentLayout === 'horizontal';
  const apply = (axis: 'x' | 'y', raw: any, auto?: boolean, fit?: number) => {
    const prop = axis === 'x' ? 'width' : 'height';
    if (auto) return;
    const s = parseSizing(raw);
    if (s.mode === 'fixed') {
      (st as any)[prop] = s.px;
    } else if (s.mode === 'fill') {
      if (!absolute) {
        const isMain = (axis === 'x') === mainIsX;
        if (isMain) {
          st.flex = '1 1 0px';
          (st as any)[axis === 'x' ? 'minWidth' : 'minHeight'] = 0;
        } else {
          st.alignSelf = 'stretch';
        }
      } else {
        (st as any)[prop] = s.fallback ?? '100%';
      }
    } else if (s.fallback !== undefined && !(fit !== undefined && fit > 0)) {
      (st as any)[prop] = s.fallback;
    } else if (fit !== undefined) {
      (st as any)[prop] = fit;
    }
  };
  apply('x', p.width, opts.autoW, opts.fitW);
  apply('y', p.height, opts.autoH, opts.fitH);
  const t: string[] = [];
  const rot = num(p.rotation);
  if (rot) t.push(`rotate(${-rot}deg)`);
  if (p.flipX === true || p.flipY === true) t.push(`translate(50%, 50%) scale(${p.flipX === true ? -1 : 1}, ${p.flipY === true ? -1 : 1}) translate(-50%, -50%)`);
  if (t.length) {
    st.transform = t.join(' ');
    st.transformOrigin = '0 0';
  }
  if (p.opacity !== undefined && p.opacity !== 1) st.opacity = num(p.opacity, 1);
  return st;
}

function shadowCss(effects: any[], kind: 'box' | 'text' | 'filter'): Partial<CSSProperties> {
  const out: CSSProperties = {};
  const shadows: string[] = [];
  const filters: string[] = [];
  for (const e of effects) {
    if (e.type === 'shadow') {
      const inner = e.shadowType === 'inner';
      const x = num(e.offset?.x);
      const y = num(e.offset?.y);
      const b = num(e.blur);
      const s = num(e.spread);
      const c = colorCss(e.color ?? '#00000040');
      if (kind === 'box') shadows.push(`${inner ? 'inset ' : ''}${x}px ${y}px ${b}px ${s}px ${c}`);
      else if (kind === 'text' && !inner) shadows.push(`${x}px ${y}px ${b}px ${c}`);
      else if (kind === 'filter' && !inner) filters.push(`drop-shadow(${x}px ${y}px ${b / 2}px ${c})`);
    } else if (e.type === 'blur') {
      filters.push(`blur(${num(e.radius) / 2}px)`);
    } else if (e.type === 'background_blur') {
      (out as any).backdropFilter = `blur(${num(e.radius) / 2}px)`;
    }
  }
  if (shadows.length) {
    if (kind === 'box') out.boxShadow = shadows.join(', ');
    else out.textShadow = shadows.join(', ');
  }
  if (filters.length) out.filter = filters.join(' ');
  return out;
}

/** Strokes for box-like nodes: CSS outline when possible, else a masked overlay. */
function boxStroke(stroke: StrokeInfo | null, resolveUrl: (u: string) => string, radius: string | undefined, w: number, h: number): { style: CSSProperties; overlay: React.ReactNode } {
  if (!stroke) return { style: {}, overlay: null };
  const solid = stroke.fills.length === 1 && (typeof stroke.fills[0] === 'string' || stroke.fills[0].type === 'color');
  if (typeof stroke.width === 'number' && solid) {
    const sw = stroke.width;
    const offset = stroke.align === 'inner' ? -sw : stroke.align === 'center' ? -sw / 2 : 0;
    const f = stroke.fills[0];
    return { style: { outline: `${sw}px solid ${colorCss(typeof f === 'string' ? f : f.color)}`, outlineOffset: offset }, overlay: null };
  }
  const widths = typeof stroke.width === 'number' ? { top: stroke.width, right: stroke.width, bottom: stroke.width, left: stroke.width } : stroke.width;
  const grow = (side: number) => (stroke.align === 'outer' ? side : stroke.align === 'center' ? side / 2 : 0);
  const bg = fillsToBackground(stroke.fills, w, h, resolveUrl);
  const style: CSSProperties = {
    position: 'absolute',
    top: -grow(widths.top),
    right: -grow(widths.right),
    bottom: -grow(widths.bottom),
    left: -grow(widths.left),
    padding: `${widths.top}px ${widths.right}px ${widths.bottom}px ${widths.left}px`,
    borderRadius: radius,
    pointerEvents: 'none',
    boxSizing: 'border-box',
    WebkitMask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
    mask: 'linear-gradient(#000 0 0) content-box exclude, linear-gradient(#000 0 0)',
    ...bg,
  };
  return { style: {}, overlay: <div style={style} data-stroke /> };
}

export const NodeView = memo(function NodeView({ n, parentLayout }: { n: RNode; parentLayout: ParentLayout }) {
  const ctx = useContext(RenderCtx);
  const p = useMemo(() => resolveProps(ctx.doc, n.props, n.theme), [n, ctx.doc]);
  if (p.enabled === false) return null;
  const view = renderView(n, p, parentLayout);
  if (hasShaderEffect(p)) return <ShaderEffectHost nodeKey={n.key} props={p}>{view}</ShaderEffectHost>;
  return view;
});

function hasShaderEffect(p: any) {
  const fx = Array.isArray(p.effect) ? p.effect : p.effect ? [p.effect] : [];
  return fx.some((e: any) => e && e.type === 'shader' && e.enabled !== false && e.url);
}

function renderView(n: RNode, p: any, parentLayout: ParentLayout) {
  switch (n.type) {
    case 'frame':
    case 'rectangle':
      return <BoxView n={n} p={p} parentLayout={parentLayout} />;
    case 'group':
      return <GroupView n={n} p={p} parentLayout={parentLayout} />;
    case 'text':
      return <TextView n={n} p={p} parentLayout={parentLayout} />;
    case 'ellipse':
    case 'polygon':
    case 'path':
    case 'line':
      return <ShapeView n={n} p={p} parentLayout={parentLayout} />;
    case 'icon':
    case 'icon_font':
      return <IconView n={n} p={p} parentLayout={parentLayout} />;
    case 'note':
    case 'prompt':
    case 'context':
      return <NoteView n={n} p={p} parentLayout={parentLayout} />;
    case 'browser':
      return <BrowserView n={n} p={p} parentLayout={parentLayout} />;
    case 'script':
      return <ScriptView n={n} p={p} parentLayout={parentLayout} />;
    default:
      return <PlaceholderView n={n} p={p} parentLayout={parentLayout} />;
  }
}

const isShaderFill = (f: any) => f && typeof f === 'object' && f.type === 'shader' && f.enabled !== false && f.url;

/**
 * Fill layers for a box: plain fills become CSS backgrounds; shader fills become canvas layers stacked in order
 * (the first plain group stays on the element itself so the common case adds no extra DOM).
 */
function FillLayers({ n, fills, w, h, radius, resolveUrl }: { n: RNode; fills: any[]; w: number; h: number; radius: string | undefined; resolveUrl: (u: string) => string }) {
  const out: React.ReactNode[] = [];
  const shape: ShapeSpec = { kind: 'rect', radius: radiusArray(n.props.cornerRadius) };
  let i = fills.findIndex(isShaderFill);
  while (i >= 0 && i < fills.length) {
    out.push(<ShaderFillCanvas key={'s' + i} nodeKey={n.key} fill={fills[i]} below={fills.slice(0, i)} shape={shape} style={{ borderRadius: radius }} />);
    let j = i + 1;
    while (j < fills.length && !isShaderFill(fills[j])) j++;
    const group = fills.slice(i + 1, j);
    if (group.length) out.push(<div key={'g' + i} style={{ position: 'absolute', inset: 0, borderRadius: radius, pointerEvents: 'none', ...fillsToBackground(group, w, h, resolveUrl) }} />);
    i = j;
  }
  return <>{out}</>;
}

function radiusArray(v: any): number[] {
  if (Array.isArray(v)) return v.map(x => num(x));
  const r = num(v);
  return [r, r, r, r];
}

function ScriptView({ n, p, parentLayout }: ViewProps) {
  useStore(s => s.assetVersion);
  const st = boxStyle(n, { ...p, width: p.width ?? 200, height: p.height ?? 200 }, parentLayout);
  const state = scriptState(n.props, n.theme, n.key);
  const style: CSSProperties = { ...st, overflow: p.clip === true ? 'hidden' : undefined };
  return (
    <div data-k={n.key} data-script style={style}>
      <Children n={n} layout="none" />
      {(!state || state.status !== 'ok') && (
        <div
          data-asset-error={state?.status === 'error' ? `Script error: ${state.message}` : !state ? 'Script node has no scriptUri' : undefined}
          title={state?.status === 'error' ? state.message : undefined}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            textAlign: 'center',
            padding: 6,
            font: '11px system-ui',
            overflow: 'hidden',
            pointerEvents: 'none',
            color: state?.status === 'error' ? '#f43f5e' : '#a1a1aa',
            border: `1px dashed ${state?.status === 'error' ? '#f43f5e' : '#a1a1aa'}`,
            background: state?.status === 'error' ? 'rgba(244,63,94,0.06)' : 'transparent',
          }}
        >
          {!state ? 'Script: no file set' : state.status === 'pending' ? 'Running script…' : `Script error: ${state.message}`}
        </div>
      )}
    </div>
  );
}

type ViewProps = { n: RNode; p: any; parentLayout: ParentLayout };

function Children({ n, layout }: { n: RNode; layout: ParentLayout }) {
  return (
    <>
      {n.children.map(c => (
        <NodeView key={c.key} n={c} parentLayout={layout} />
      ))}
    </>
  );
}

function BoxView({ n, p, parentLayout }: ViewProps) {
  const ctx = useContext(RenderCtx);
  const isFrame = n.type === 'frame';
  const layout: ParentLayout = isFrame ? (p.layout === 'none' || p.layout === 'vertical' || p.layout === 'horizontal' ? p.layout : 'horizontal') : 'none';
  const fitW = isFrame && layout === 'none' ? childExtent(n, 'x') : undefined;
  const fitH = isFrame && layout === 'none' ? childExtent(n, 'y') : undefined;
  const st = boxStyle(n, p, parentLayout, { fitW, fitH });
  const w = typeof st.width === 'number' ? st.width : 100;
  const h = typeof st.height === 'number' ? st.height : 100;
  const radius = cornerRadius(p.cornerRadius);
  const fx = effectList(p.effect);
  const stroke = boxStroke(normalizeStroke(p, 'inner'), ctx.resolveUrl, radius, w, h);
  const fills = fillList(p.fill);
  const firstShader = fills.findIndex(isShaderFill);
  const style: CSSProperties = {
    ...st,
    ...fillsToBackground(firstShader >= 0 ? fills.slice(0, firstShader) : fills, w, h, ctx.resolveUrl),
    ...shadowCss(fx, 'box'),
    ...stroke.style,
    borderRadius: radius,
  };
  if (isFrame && layout !== 'none') {
    style.display = 'flex';
    style.flexDirection = layout === 'vertical' ? 'column' : 'row';
    style.gap = num(p.gap);
    style.justifyContent = JUSTIFY[p.justifyContent] ?? 'flex-start';
    style.alignItems = ALIGN[p.alignItems] ?? 'flex-start';
  }
  if (isFrame) style.padding = paddingCss(p.padding);
  if (p.clip === true) style.overflow = 'hidden';
  return (
    <div data-k={n.key} style={style}>
      {firstShader >= 0 && <FillLayers n={n} fills={fills} w={w} h={h} radius={radius} resolveUrl={ctx.resolveUrl} />}
      {isFrame && <Children n={n} layout={layout} />}
      {stroke.overlay}
    </div>
  );
}

function GroupView({ n, p, parentLayout }: ViewProps) {
  const st = boxStyle(n, { ...p, width: undefined, height: undefined }, parentLayout, { autoW: true, autoH: true });
  if (parentLayout !== 'none' && p.layoutPosition !== 'absolute') {
    st.width = childExtent(n, 'x');
    st.height = childExtent(n, 'y');
  }
  return (
    <div data-k={n.key} data-group style={{ ...st, ...shadowCss(effectList(p.effect), 'filter') }}>
      <Children n={n} layout="none" />
    </div>
  );
}

function fontStack(ff: any) {
  const fam = typeof ff === 'string' && ff ? ff : 'Inter';
  return `"${fam}", "Inter", system-ui, sans-serif`;
}

function TextView({ n, p, parentLayout }: ViewProps) {
  const ctx = useContext(RenderCtx);
  const growth = p.textGrowth ?? 'auto';
  const autoW = growth === 'auto';
  const autoH = growth !== 'fixed-width-height';
  const st = boxStyle(n, p, parentLayout, { autoW, autoH });
  const family = typeof p.fontFamily === 'string' ? p.fontFamily : 'Inter';
  ensureFont(family, p.fontWeight, p.fontStyle === 'italic');
  const fills = fillList(p.fill ?? '#000000').filter(isEnabled);
  const gradient = fills.some(f => typeof f === 'object' && f.type !== 'color');
  const fontSize = num(p.fontSize, 14);
  const style: CSSProperties = {
    ...st,
    display: 'flex',
    flexDirection: 'column',
    justifyContent: p.textAlignVertical === 'middle' ? 'center' : p.textAlignVertical === 'bottom' ? 'flex-end' : 'flex-start',
    fontFamily: fontStack(family),
    fontSize,
    fontWeight: weightNum(p.fontWeight),
    fontStyle: p.fontStyle === 'italic' ? 'italic' : undefined,
    letterSpacing: p.letterSpacing !== undefined ? `${num(p.letterSpacing)}px` : undefined,
    lineHeight: typeof p.lineHeight === 'number' && p.lineHeight > 0 ? p.lineHeight : 'normal',
    textAlign: p.textAlign ?? 'left',
    whiteSpace: autoW ? 'pre' : 'pre-wrap',
    overflowWrap: 'break-word',
    textDecoration: [p.underline === true ? 'underline' : '', p.strikethrough === true ? 'line-through' : ''].join(' ').trim() || undefined,
    ...shadowCss(effectList(p.effect), 'text'),
  };
  const inner: CSSProperties = {};
  if (gradient) {
    Object.assign(inner, fillsToBackground(fills, typeof st.width === 'number' ? st.width : 100, typeof st.height === 'number' ? st.height : fontSize, ctx.resolveUrl));
    inner.WebkitBackgroundClip = 'text';
    inner.backgroundClip = 'text';
    inner.color = 'transparent';
  } else {
    style.color = primaryColor(fills) ?? 'transparent';
  }
  const content = typeof p.content === 'string' ? p.content : p.content === undefined ? '' : String(p.content);
  const editing = ctx.editingKey === n.key;
  return (
    <div data-k={n.key} style={style}>
      {editing ? (
        <EditableText initial={content} style={inner} onDone={t => ctx.onTextCommit?.(n.key, t)} />
      ) : gradient ? (
        <span style={inner}>{content || '​'}</span>
      ) : (
        content || '​'
      )}
    </div>
  );
}

function EditableText({ initial, style, onDone }: { initial: string; style: CSSProperties; onDone: (t: string | null) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current!;
    el.textContent = initial;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, []);
  return (
    <span
      ref={ref}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      data-editing
      style={{ ...style, outline: 'none', cursor: 'text', minWidth: 2, display: 'inline-block' }}
      onKeyDown={e => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          (e.currentTarget as HTMLElement).blur();
        }
      }}
      onPointerDown={e => e.stopPropagation()}
      onBlur={e => onDone(e.currentTarget.innerText.replace(/\n$/, ''))}
    />
  );
}

function useMeasured(st: CSSProperties) {
  const ref = useRef<HTMLDivElement>(null);
  const fixed = typeof st.width === 'number' && typeof st.height === 'number';
  const [size, setSize] = useState<[number, number]>([typeof st.width === 'number' ? st.width : 0, typeof st.height === 'number' ? st.height : 0]);
  useLayoutEffect(() => {
    if (fixed || !ref.current) return;
    const el = ref.current;
    const update = () => setSize(s => (s[0] === el.offsetWidth && s[1] === el.offsetHeight ? s : [el.offsetWidth, el.offsetHeight]));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fixed]);
  return { ref, w: fixed ? (st.width as number) : size[0], h: fixed ? (st.height as number) : size[1] };
}

function SvgPaint({ id, fill, w, h, resolveUrl }: { id: string; fill: any; w: number; h: number; resolveUrl: (u: string) => string }) {
  if (typeof fill === 'string' || fill.type === 'color') return null;
  const op = num(fill.opacity, 1);
  const stops = (fill.colors ?? [])
    .slice()
    .sort((a: any, b: any) => num(a.position) - num(b.position))
    .map((s: any, i: number) => <stop key={i} offset={num(s.position)} stopColor={colorCss(s.color, op)} />);
  if (fill.type === 'gradient') {
    const t = fill.gradientType ?? 'linear';
    if (t === 'linear') {
      const e = linearEndpoints(fill);
      return (
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2} gradientTransform={`matrix(${w} 0 0 ${h} 0 0)`}>
          {stops}
        </linearGradient>
      );
    }
    const cx = num(fill.center?.x, 0.5);
    const cy = num(fill.center?.y, 0.5);
    const sw = num(fill.size?.width, 1) / 2;
    const sh = num(fill.size?.height, 1) / 2;
    return (
      <radialGradient id={id} gradientUnits="userSpaceOnUse" cx={0} cy={0} r={1} gradientTransform={`matrix(${w} 0 0 ${h} 0 0) translate(${cx} ${cy}) rotate(${-num(fill.rotation)}) scale(${sw} ${sh})`}>
        {stops}
      </radialGradient>
    );
  }
  if (fill.type === 'image' && fill.url) {
    const mode = fill.mode ?? 'cover';
    return (
      <pattern id={id} patternUnits="userSpaceOnUse" width={w} height={h}>
        <image href={resolveUrl(fill.url)} width={w} height={h} opacity={op} preserveAspectRatio={mode === 'stretch' ? 'none' : mode === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice'} />
      </pattern>
    );
  }
  return null;
}

function paintRef(fill: any, id: string): string {
  if (typeof fill === 'string') return colorCss(fill);
  if (fill.type === 'color') return colorCss(fill.color);
  if (fill.type === 'gradient' && fill.gradientType === 'angular') return colorCss(fill.colors?.[0]?.color);
  if (fill.type === 'gradient' || fill.type === 'image') return `url(#${id})`;
  if (fill.type === 'mesh_gradient') return colorCss(fill.colors?.[0]);
  return 'none';
}

function ShapeView({ n, p, parentLayout }: ViewProps) {
  const ctx = useContext(RenderCtx);
  const st = boxStyle(n, p, parentLayout);
  const { ref, w, h } = useMeasured(st);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const open = n.type === 'line' || n.type === 'path';
  let d = '';
  if (n.type === 'ellipse') d = ellipseGeometry(w, h, num(p.innerRadius), num(p.startAngle), p.sweepAngle === undefined ? 360 : num(p.sweepAngle, 360));
  else if (n.type === 'polygon') d = polygonGeometry(w, h, num(p.polygonCount, 3), num(p.cornerRadius));
  else if (n.type === 'path') d = pathGeometry(typeof p.geometry === 'string' ? p.geometry : '', w, h, p.viewBox);
  else if (n.type === 'line') d = `M0 0L${w} ${h}`;
  const allFills = n.type === 'line' ? [] : fillList(p.fill).filter(isEnabled);
  const fills = allFills.filter(f => !isShaderFill(f) && !(f && typeof f === 'object' && f.type === 'gradient' && f.gradientType === 'angular'));
  const shaderFills = allFills.map((f, i) => [f, i] as const).filter(([f]) => isShaderFill(f));
  const stroke = normalizeStroke(p, open ? 'center' : n.type === 'ellipse' ? 'center' : 'inner');
  const fillRule = p.fillRule === 'evenodd' || (n.type === 'ellipse' && num(p.innerRadius) > 0) ? 'evenodd' : 'nonzero';
  const fx = effectList(p.effect);
  const sw = stroke ? (typeof stroke.width === 'number' ? stroke.width : Math.max(stroke.width.top, stroke.width.left)) : 0;
  const align = open ? 'center' : stroke?.align;
  const strokeProps = (paint: string) => ({
    fill: 'none',
    stroke: paint,
    strokeWidth: align === 'center' ? sw : sw * 2,
    strokeLinecap: (stroke?.cap ?? 'butt') as any,
    strokeLinejoin: (stroke?.join ?? 'miter') as any,
    clipPath: align === 'inner' ? `url(#${uid}c)` : undefined,
    mask: align === 'outer' ? `url(#${uid}m)` : undefined,
  });
  return (
    <div ref={ref} data-k={n.key} style={{ ...st, ...shadowCss(fx, 'filter') }}>
      <svg width="100%" height="100%" style={{ position: 'absolute', inset: 0, overflow: 'visible', display: 'block' }}>
        <defs>
          {fills.map((f, i) => (
            <SvgPaint key={'f' + i} id={`${uid}f${i}`} fill={f} w={w} h={h} resolveUrl={ctx.resolveUrl} />
          ))}
          {stroke?.fills.map((f, i) => (
            <SvgPaint key={'s' + i} id={`${uid}s${i}`} fill={f} w={w} h={h} resolveUrl={ctx.resolveUrl} />
          ))}
          {align === 'inner' && (
            <clipPath id={`${uid}c`}>
              <path d={d} clipRule={fillRule} />
            </clipPath>
          )}
          {align === 'outer' && (
            <mask id={`${uid}m`} maskUnits="userSpaceOnUse" x={-sw * 2 - w} y={-sw * 2 - h} width={w * 3 + sw * 4} height={h * 3 + sw * 4}>
              <rect x={-sw * 2 - w} y={-sw * 2 - h} width={w * 3 + sw * 4} height={h * 3 + sw * 4} fill="white" />
              <path d={d} fill="black" fillRule={fillRule} />
            </mask>
          )}
        </defs>
        {fills.map((f, i) => (
          <path key={'f' + i} d={d} fill={paintRef(f, `${uid}f${i}`)} fillRule={fillRule} style={f?.blendMode ? { mixBlendMode: f.blendMode } : undefined} />
        ))}
        {stroke?.fills.map((f, i) => <path key={'s' + i} d={d} {...strokeProps(paintRef(f, `${uid}s${i}`))} />)}
      </svg>
      {/* SVG has no conic gradients: draw angular fills as a CSS conic-gradient clipped to the shape. */}
      {allFills.map((f, i) =>
        f && typeof f === 'object' && f.type === 'gradient' && f.gradientType === 'angular' && d ? (
          <div
            key={'ang' + i}
            style={{
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              clipPath: `path(${fillRule === 'evenodd' ? 'evenodd, ' : ''}'${d}')`,
              ...fillsToBackground([f], w, h, ctx.resolveUrl),
            }}
          />
        ) : null,
      )}
      {shaderFills.map(([f, i]) => (
        <ShaderFillCanvas
          key={'sh' + i}
          nodeKey={n.key}
          fill={f}
          below={allFills.slice(0, i).filter(x => !isShaderFill(x))}
          shape={n.type === 'ellipse' && !num(p.innerRadius) && (p.sweepAngle === undefined || Math.abs(num(p.sweepAngle)) >= 360) ? { kind: 'ellipse' } : { kind: 'path', d, evenodd: fillRule === 'evenodd' }}
          style={{ clipPath: d ? `path(${fillRule === 'evenodd' ? 'evenodd, ' : ''}'${d}')` : undefined }}
        />
      ))}
    </div>
  );
}

function toPascal(name: string) {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

export function lucideIcon(name: string): React.ComponentType<any> | null {
  const L = Lucide as any;
  const pas = toPascal(name);
  return L[pas] ?? L[pas + 'Icon'] ?? L.icons?.[pas] ?? null;
}

function IconView({ n, p, parentLayout }: ViewProps) {
  const st = boxStyle(n, p, parentLayout);
  const library: string = String(p.library ?? p.iconFontFamily ?? 'lucide');
  const name: string = String(p.icon ?? p.iconFontName ?? '');
  const lib = library.toLowerCase();
  const w = typeof st.width === 'number' ? st.width : 24;
  const h = typeof st.height === 'number' ? st.height : 24;
  const size = Math.min(w, h);
  const color = primaryColor(fillList(p.fill).filter(isEnabled)) ?? '#000000';
  const weight = num(p.weight, 0);
  ensureIconFont(library);
  let glyph: React.ReactNode = null;
  if (lib === 'lucide') {
    const C = lucideIcon(name);
    glyph = C ? <C size={size} color={color} strokeWidth={weight ? weight / 200 : 2} /> : <MissingGlyph size={size} />;
  } else if (lib === 'feather') {
    const ic = (feather.icons as any)[name];
    glyph = ic ? (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={weight ? weight / 200 : 2} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ic.contents }} />
    ) : (
      <MissingGlyph size={size} />
    );
  } else if (lib.startsWith('material symbols')) {
    glyph = (
      <span style={{ fontFamily: `'${library}'`, fontSize: size, lineHeight: 1, color, fontVariationSettings: `'wght' ${weight || 400}`, fontFeatureSettings: "'liga'", userSelect: 'none' }}>{name}</span>
    );
  } else if (lib === 'phosphor') {
    glyph = <i className={`ph ph-${name}`} style={{ fontSize: size, color, lineHeight: 1 }} />;
  } else {
    glyph = <MissingGlyph size={size} />;
  }
  return (
    <div data-k={n.key} style={{ ...st, display: 'flex', alignItems: 'center', justifyContent: 'center', ...shadowCss(effectList(p.effect), 'filter') }}>
      {glyph}
    </div>
  );
}

function MissingGlyph({ size }: { size: number }) {
  return <div data-missing style={{ width: size, height: size, border: '1px dashed #f43f5e', boxSizing: 'border-box' }} />;
}

const NOTE_STYLES: Record<string, CSSProperties> = {
  note: { background: '#FDF6C3', color: '#3f3a1a' },
  prompt: { background: '#EDE9FE', color: '#2e1065' },
  context: { background: '#E0F2FE', color: '#0c4a6e' },
};

function NoteView({ n, p, parentLayout }: ViewProps) {
  const st = boxStyle(n, { ...p, width: p.width ?? 240, height: p.height ?? 160 }, parentLayout);
  if (p.fontFamily) ensureFont(p.fontFamily, p.fontWeight);
  return (
    <div
      data-k={n.key}
      style={{
        ...st,
        ...NOTE_STYLES[n.type],
        borderRadius: 4,
        padding: 16,
        fontFamily: fontStack(p.fontFamily),
        fontSize: num(p.fontSize, 14),
        lineHeight: 1.45,
        whiteSpace: 'pre-wrap',
        overflow: 'hidden',
        boxShadow: '0 1px 2px rgba(0,0,0,.12), 0 4px 12px rgba(0,0,0,.08)',
      }}
    >
      {n.type !== 'note' && <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.6, marginBottom: 6, textTransform: 'uppercase' }}>{n.type}{p.model ? ` · ${p.model}` : ''}</div>}
      {typeof p.content === 'string' ? p.content : ''}
    </div>
  );
}

function BrowserView({ n, p, parentLayout }: ViewProps) {
  const st = boxStyle(n, { ...p, width: p.width ?? 1280, height: p.height ?? 800 }, parentLayout);
  return (
    <div data-k={n.key} style={{ ...st, borderRadius: cornerRadius(p.cornerRadius), overflow: 'hidden', background: '#fff' }}>
      {p.url ? (
        <iframe src={p.url} title={n.props.name ?? 'browser'} style={{ border: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
      ) : (
        <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#71717a', font: '14px system-ui' }}>No URL</div>
      )}
    </div>
  );
}

function PlaceholderView({ n, p, parentLayout }: ViewProps) {
  const st = boxStyle(n, { ...p, width: p.width ?? 100, height: p.height ?? 100 }, parentLayout);
  const label = n.type === 'missing_ref' ? 'Missing component' : n.type;
  return (
    <div data-k={n.key} style={{ ...st, border: '1px dashed #a1a1aa', display: 'grid', placeItems: 'center', color: '#a1a1aa', font: '11px system-ui', overflow: 'hidden' }}>
      {label}
      {n.children.length > 0 && <Children n={n} layout="none" />}
    </div>
  );
}
