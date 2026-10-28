// Right island: the design/properties panel for the current selection.
import React, { useState } from 'react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  ChevronDown,
  ChevronRight,
  Diamond,
  Eye,
  EyeOff,
  FlipHorizontal2,
  FlipVertical2,
  FoldVertical,
  Grid2x2,
  Maximize,
  Minus,
  MoveHorizontal,
  PanelRight,
  Play,
  Plus,
  RotateCw,
  Scan,
  SlidersHorizontal,
  Spline,
  SquareDashed,
  Unlink,
  Variable,
  WrapText,
  Blend,
  Expand,
  Type as TypeIcon,
  ALargeSmall,
  Baseline,
} from 'lucide-react';
import { rasterize } from '../render/rasterize';
import { useStore, applyProps, keySource } from '../editor/store';
import { useTree } from '../editor/tree';
import type { RNode } from '../model/types';
import { deepResolve, isVarRef, resolveVariable } from '../model/resolve';
import { displayName } from '../model/doc';
import { fillList, parseColor, toHex } from '../render/paint';
import { parseSizing } from '../render/NodeView';
import { align, detachInstance, elFor, goToComponent, parentLayoutOf, toggleComponent, vectorizeNode, worldRectOf } from '../editor/ops';
import { CheckRow, NumberField, Seg, Select, fmt, layerIconFor, useMenu } from './common';
import { PaintPopover, paintSwatch } from './ColorPicker';
import { ICON_NAMES } from './icons';
import { blobToDataUrl, downloadDataUrl } from '../editor/host';
import { ScriptControls, ShaderControls } from './AssetControls';

type Ctx = {
  n: RNode;
  p: any; // raw (unresolved) props
  r: any; // resolved props
  set: (changes: Record<string, any>, merge?: string) => void;
  theme: any;
};

export function RightPanel() {
  const selection = useStore(s => s.selection);
  const tree = useTree();
  const doc = useStore(s => s.doc);
  const rightOpen = useStore(s => s.rightOpen);
  if (!tree || !doc || !selection.length) return null;
  if (!rightOpen)
    return (
      <button className="island side-toggle" style={{ right: 8, top: 8 }} title="Show design panel" onClick={() => useStore.setState({ rightOpen: true })}>
        <PanelRight strokeWidth={1.75} />
      </button>
    );
  const n = tree.byKey.get(selection[0]);
  if (!n) return null;
  const p = n.props;
  const r = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, k === 'children' ? v : deepResolve(doc, v, n.theme)]));
  const set = (changes: Record<string, any>, merge?: string) =>
    useStore.getState().edit(d => {
      for (const k of useStore.getState().selection) applyProps(d, k, changes);
    }, merge);
  const ctx: Ctx = { n, p, r, set, theme: n.theme };
  const isText = n.type === 'text';
  const isFrame = n.type === 'frame';
  const hasGraphics = !['group', 'icon', 'icon_font', 'note', 'prompt', 'context', 'script', 'missing_ref'].includes(n.type);
  const hasStroke = hasGraphics && n.type !== 'text';
  const { Icon, cls } = layerIconFor(n);
  const multi = selection.length > 1;
  return (
    <div className="island right-panel">
      <div className="rp-head">
        <span className={'type-icon layer-icon ' + cls} style={{ margin: 0 }}>
          <Icon strokeWidth={1.75} />
        </span>
        <input
          key={n.key}
          defaultValue={multi ? `${selection.length} layers` : displayName(p)}
          disabled={multi}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={e => {
            const v = e.target.value.trim();
            if (!multi && v && v !== displayName(p)) set({ name: v });
          }}
        />
        <button
          className="icon-btn"
          title="Present"
          onClick={() => {
            const i = tree.roots.findIndex(x => x.key === (ancestorRoot(tree, n.key) ?? n.key));
            useStore.setState({ presenting: Math.max(0, i) });
          }}
        >
          <Play />
        </button>
        <button className="icon-btn" title="Hide design panel" onClick={() => useStore.setState({ rightOpen: false })}>
          <PanelRight />
        </button>
      </div>
      <div className="right-scroll">
        <ComponentButtons n={n} />
        <ContextSection {...ctx} />
        <AlignmentSection />
        <PositionSection {...ctx} />
        {isFrame || n.type !== 'group' ? <LayoutSection {...ctx} /> : null}
        <AppearanceSection {...ctx} />
        {n.type === 'script' && (
          <Section title="Script">
            <ScriptControls props={p} theme={n.theme} set={set} />
          </Section>
        )}
        {hasGraphics && n.type !== 'line' && <PaintSection {...ctx} prop="fill" title="Fill" />}
        {(hasStroke || n.type === 'line') && <PaintSection {...ctx} prop="stroke" title="Stroke" />}
        {isText && <TypographySection {...ctx} />}
        {(n.type === 'icon' || n.type === 'icon_font') && <IconSection {...ctx} />}
        {(n.type === 'icon' || n.type === 'icon_font') && <PaintSection {...ctx} prop="fill" title="Color" />}
        <EffectsSection {...ctx} />
        <CodeSection n={n} />
        <ExportSection n={n} />
      </div>
    </div>
  );
}

function ancestorRoot(tree: ReturnType<typeof useTree>, key: string): string | null {
  let k: string | undefined = key;
  let last: string | null = null;
  while (k && tree) {
    last = k;
    k = tree.parent.get(k)?.key;
  }
  return last;
}

function Section({ title, children, onAdd, extra, collapsible, empty }: { title: string; children?: React.ReactNode; onAdd?: () => void; extra?: React.ReactNode; collapsible?: boolean; empty?: boolean }) {
  const [open, setOpen] = useState(!collapsible);
  return (
    <div className={'section' + (empty || (collapsible && !open) ? ' empty' : '')}>
      <div className="section-head">
        <span>{title}</span>
        <span style={{ display: 'flex', gap: 2 }}>
          {extra}
          {onAdd && (
            <button className="icon-btn" title={`Add ${title.toLowerCase()}`} onClick={onAdd}>
              <Plus />
            </button>
          )}
          {collapsible && (
            <button className="icon-btn" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown /> : <ChevronDown style={{ transform: 'rotate(-90deg)' }} />}
            </button>
          )}
        </span>
      </div>
      {(!collapsible || open) && children}
    </div>
  );
}

function ComponentButtons({ n }: { n: RNode }) {
  const real = keySource(n.key).kind === 'real';
  if (n.instanceOf && real)
    return (
      <div className="row2 rp-top-btn">
        <button className="rp-btn" onClick={() => goToComponent(n.key)}>
          <Diamond /> Go to component
        </button>
        <button className="rp-btn" onClick={() => detachInstance(n.key)}>
          <Unlink /> Detach
        </button>
      </div>
    );
  if (!real) return <div className="rp-top-btn" style={{ color: 'var(--muted)', fontSize: 10 }}>Inside an instance — edits are saved as overrides.</div>;
  return (
    <div className="rp-top-btn">
      <button className="rp-btn" style={{ width: '100%' }} onClick={toggleComponent}>
        <Diamond /> {n.isComponent ? 'Remove Component' : 'Create Component'}
      </button>
    </div>
  );
}

function ContextSection({ p, set }: Ctx) {
  return (
    <Section title="Context" collapsible>
      <textarea
        className="textarea"
        placeholder="Describe what this layer is for (shared with AI agents)…"
        defaultValue={p.context ?? ''}
        key={p.id}
        onKeyDown={e => e.stopPropagation()}
        onBlur={e => {
          const v = e.target.value;
          if (v !== (p.context ?? '')) set({ context: v || undefined });
        }}
      />
    </Section>
  );
}

function AlignmentSection() {
  return (
    <Section title="Alignment">
      <div className="align-row">
        <div className="seg">
          <button title="Align left" onClick={() => align('left')}>
            <AlignStartVertical />
          </button>
          <button title="Align horizontal centers" onClick={() => align('hcenter')}>
            <AlignCenterVertical />
          </button>
          <button title="Align right" onClick={() => align('right')}>
            <AlignEndVertical />
          </button>
        </div>
        <div className="seg">
          <button title="Align top" onClick={() => align('top')}>
            <AlignStartHorizontal />
          </button>
          <button title="Align vertical centers" onClick={() => align('vcenter')}>
            <AlignCenterHorizontal />
          </button>
          <button title="Align bottom" onClick={() => align('bottom')}>
            <AlignEndHorizontal />
          </button>
        </div>
      </div>
    </Section>
  );
}

function numOrVar(raw: any, resolved: any) {
  return { value: typeof resolved === 'number' ? resolved : undefined, varName: isVarRef(raw) ? raw.slice(1) : undefined };
}

function PositionSection({ n, p, r, set }: Ctx) {
  const inFlex = parentLayoutOf(n.key) !== 'none';
  const absolute = p.layoutPosition === 'absolute';
  const disabled = inFlex && !absolute;
  return (
    <Section title="Position">
      <div className="row2">
        <NumberField label="X" {...numOrVar(p.x, r.x ?? 0)} value={typeof r.x === 'number' ? r.x : 0} disabled={disabled} onChange={(v, s) => set({ x: v }, s ? 'scrub-x' : undefined)} />
        <NumberField label="Y" {...numOrVar(p.y, r.y ?? 0)} value={typeof r.y === 'number' ? r.y : 0} disabled={disabled} onChange={(v, s) => set({ y: v }, s ? 'scrub-y' : undefined)} />
      </div>
      <div className="row2">
        <NumberField label="∟" value={typeof r.rotation === 'number' ? r.rotation : 0} suffix="°" onChange={(v, s) => set({ rotation: v || undefined }, s ? 'scrub-rot' : undefined)} title="Rotation (counter-clockwise)" />
        <div className="seg" style={{ background: 'transparent' }}>
          <button title="Rotate 90°" onClick={() => set({ rotation: (((r.rotation ?? 0) + 90) % 360) || undefined })}>
            <RotateCw />
          </button>
          <button title="Flip vertical" onClick={() => set({ flipY: p.flipY === true ? undefined : true })}>
            <FlipVertical2 />
          </button>
          <button title="Flip horizontal" onClick={() => set({ flipX: p.flipX === true ? undefined : true })}>
            <FlipHorizontal2 />
          </button>
        </div>
      </div>
      {inFlex && <CheckRow checked={absolute} label="Absolute position (ignore auto layout)" onChange={v => set({ layoutPosition: v ? 'absolute' : undefined })} />}
    </Section>
  );
}

function sizeDisplay(raw: any, measured: number | undefined): { value: number | undefined; display?: string } {
  const s = parseSizing(raw);
  if (s.mode === 'fixed') return { value: s.px };
  const label = s.mode === 'fill' ? 'Fill' : 'Hug';
  return { value: measured, display: measured !== undefined ? `${fmt(measured, 1)} (${label})` : label };
}

function LayoutSection({ n, p, r, set }: Ctx) {
  const isFrame = n.type === 'frame';
  const isText = n.type === 'text';
  const layout = isFrame ? (p.layout === 'none' || p.layout === 'vertical' ? p.layout : r.layout === 'none' || r.layout === 'vertical' ? r.layout : 'horizontal') : 'none';
  const wr = worldRectOf(n.key);
  const parentFlex = parentLayoutOf(n.key) !== 'none';
  const growth = p.textGrowth ?? 'auto';
  const sizeText = (axis: 'width' | 'height') => (text: string) => {
    const t = text.trim().toLowerCase();
    if (t === 'fill' || t === 'fill_container') return set({ [axis]: 'fill_container' }), true;
    if (t === 'hug' || t === 'fit' || t === 'fit_content' || t === 'auto') return set({ [axis]: 'fit_content' }), true;
    return false;
  };
  const W = sizeDisplay(p.width, wr?.w);
  const H = sizeDisplay(p.height, wr?.h);
  const setSize = (axis: 'width' | 'height', v: number, scrub?: boolean) => {
    const ch: any = { [axis]: v };
    if (isText && growth === 'auto') ch.textGrowth = axis === 'width' ? 'fixed-width' : 'fixed-width-height';
    if (isText && growth === 'fixed-width' && axis === 'height') ch.textGrowth = 'fixed-width-height';
    set(ch, scrub ? 'scrub-' + axis : undefined);
  };
  const pad = p.padding;
  const padArr: number[] | null = Array.isArray(r.padding) ? (r.padding.length === 2 ? [r.padding[0], r.padding[1], r.padding[0], r.padding[1]] : r.padding) : null;
  const [padOpen, setPadOpen] = useState(Array.isArray(pad));
  return (
    <Section
      title="Layout"
      extra={
        isFrame && layout === 'none' ? (
          <button className="icon-btn" title="Add auto layout" onClick={() => set({ layout: 'vertical' })}>
            <SquareDashed />
          </button>
        ) : undefined
      }
    >
      {isFrame && (
        <Seg
          value={layout}
          onChange={v => set({ layout: v === 'horizontal' && p.layout === undefined ? undefined : v })}
          options={[
            { value: 'none', icon: <Grid2x2 />, title: 'Freeform (no auto layout)' },
            { value: 'vertical', icon: <ArrowDownToLine />, title: 'Vertical auto layout' },
            { value: 'horizontal', icon: <ArrowRightToLine />, title: 'Horizontal auto layout' },
          ]}
        />
      )}
      {isFrame && layout !== 'none' && (
        <>
          <div className="row2">
            <NumberField label={<MoveHorizontal />} {...numOrVar(p.gap, r.gap)} value={typeof r.gap === 'number' ? r.gap : 0} min={0} onChange={(v, s) => set({ gap: v || undefined }, s ? 'scrub-gap' : undefined)} title="Gap" />
            {!padOpen ? (
              <div className="row-flex">
                <NumberField label={<Scan />} value={typeof r.padding === 'number' ? r.padding : padArr ? padArr[0] : 0} display={padArr ? 'Mixed' : undefined} min={0} onChange={(v, s) => set({ padding: v || undefined }, s ? 'scrub-pad' : undefined)} title="Padding" />
                <button className="icon-btn sm" title="Padding per side" onClick={() => setPadOpen(true)}>
                  <Expand />
                </button>
              </div>
            ) : (
              <button className="icon-btn sm" style={{ justifySelf: 'end' }} title="Uniform padding" onClick={() => setPadOpen(false)}>
                <FoldVertical />
              </button>
            )}
          </div>
          {padOpen && (
            <div className="row2">
              {(['Top', 'Right', 'Bottom', 'Left'] as const).map((side, i) => (
                <NumberField
                  key={side}
                  label={side[0]}
                  value={padArr ? padArr[i] : typeof r.padding === 'number' ? r.padding : 0}
                  min={0}
                  title={`Padding ${side.toLowerCase()}`}
                  onChange={(v, s) => {
                    const cur = padArr ? [...padArr] : Array(4).fill(typeof r.padding === 'number' ? r.padding : 0);
                    cur[i] = v;
                    set({ padding: cur }, s ? 'scrub-pad' + i : undefined);
                  }}
                />
              ))}
            </div>
          )}
          <div className="row2">
            <Select
              value={p.justifyContent ?? 'start'}
              title="Distribution along the main axis"
              options={[
                { value: 'start', label: 'Start' },
                { value: 'center', label: 'Center' },
                { value: 'end', label: 'End' },
                { value: 'space_between', label: 'Space between' },
                { value: 'space_around', label: 'Space around' },
              ]}
              onChange={v => set({ justifyContent: v === 'start' ? undefined : v })}
            />
            <Select
              value={p.alignItems ?? 'start'}
              title="Alignment on the cross axis"
              options={[
                { value: 'start', label: layout === 'vertical' ? 'Left' : 'Top' },
                { value: 'center', label: 'Center' },
                { value: 'end', label: layout === 'vertical' ? 'Right' : 'Bottom' },
              ]}
              onChange={v => set({ alignItems: v === 'start' ? undefined : v })}
            />
          </div>
        </>
      )}
      {n.type !== 'group' && (
        <>
          <div className="sub-label">Dimensions</div>
          <div className="row2">
            <NumberField label="W" {...W} disabled={isText && growth === 'auto' && false} onText={sizeText('width')} min={0} onChange={(v, s) => setSize('width', v, s)} />
            <NumberField label="H" {...H} disabled={isText && growth !== 'fixed-width-height'} onText={sizeText('height')} min={0} onChange={(v, s) => setSize('height', v, s)} />
          </div>
          <div className="row2">
            {parentFlex || p.width === 'fill_container' ? (
              <CheckRow checked={parseSizing(p.width).mode === 'fill'} label="Fill Width" onChange={v => set({ width: v ? 'fill_container' : Math.round(wr?.w ?? 100) })} />
            ) : isFrame && layout !== 'none' ? (
              <CheckRow checked={parseSizing(p.width).mode === 'fit'} label="Hug Width" onChange={v => set({ width: v ? 'fit_content' : Math.round(wr?.w ?? 100) })} />
            ) : (
              <CheckRow checked={false} label="Fill Width" onChange={v => v && set({ width: 'fill_container' })} />
            )}
            {parentFlex || p.height === 'fill_container' ? (
              <CheckRow checked={parseSizing(p.height).mode === 'fill'} label="Fill Height" onChange={v => set({ height: v ? 'fill_container' : Math.round(wr?.h ?? 100) })} />
            ) : isFrame && layout !== 'none' ? (
              <CheckRow checked={parseSizing(p.height).mode === 'fit'} label="Hug Height" onChange={v => set({ height: v ? 'fit_content' : Math.round(wr?.h ?? 100) })} />
            ) : (
              <CheckRow checked={false} label="Fill Height" onChange={v => v && set({ height: 'fill_container' })} />
            )}
          </div>
          {isText && (
            <>
              <div className="sub-label">Resizing</div>
              <Seg
                value={growth}
                onChange={v => {
                  if (v === 'auto') set({ textGrowth: undefined, width: undefined, height: undefined });
                  else if (v === 'fixed-width') set({ textGrowth: v, width: p.width ?? Math.round(wr?.w ?? 100), height: undefined });
                  else set({ textGrowth: v, width: p.width ?? Math.round(wr?.w ?? 100), height: p.height ?? Math.round(wr?.h ?? 20) });
                }}
                options={[
                  { value: 'auto', icon: <ArrowRightToLine />, title: 'Auto width' },
                  { value: 'fixed-width', icon: <WrapText />, title: 'Auto height (fixed width)' },
                  { value: 'fixed-width-height', icon: <Maximize />, title: 'Fixed size' },
                ]}
              />
            </>
          )}
        </>
      )}
    </Section>
  );
}

function AppearanceSection({ n, p, r, set }: Ctx) {
  const radius = r.cornerRadius;
  const perCorner = Array.isArray(radius);
  const [open, setOpen] = useState(perCorner);
  const hasRadius = ['frame', 'rectangle', 'polygon', 'browser'].includes(n.type);
  return (
    <Section title="Appearance">
      <div className="row-flex">
        <NumberField label={<Blend />} value={Math.round((typeof r.opacity === 'number' ? r.opacity : 1) * 100)} suffix="%" min={0} max={100} title="Opacity" onChange={(v, s) => set({ opacity: v >= 100 ? undefined : v / 100 }, s ? 'scrub-op' : undefined)} />
        {hasRadius && (
          <>
            <NumberField
              label={<SquareDashed />}
              {...numOrVar(p.cornerRadius, radius)}
              value={perCorner ? radius[0] : typeof radius === 'number' ? radius : 0}
              display={perCorner ? 'Mixed' : undefined}
              min={0}
              title="Corner radius"
              onChange={(v, s) => set({ cornerRadius: v || undefined }, s ? 'scrub-rad' : undefined)}
            />
            <button className={'icon-btn sm' + (open ? ' on' : '')} title="Independent corners" onClick={() => setOpen(!open)}>
              <Expand />
            </button>
          </>
        )}
      </div>
      {hasRadius && open && (
        <div className="row2">
          {['↖', '↗', '↘', '↙'].map((lbl, i) => (
            <NumberField
              key={i}
              label={lbl}
              value={perCorner ? radius[i] : typeof radius === 'number' ? radius : 0}
              min={0}
              onChange={(v, s) => {
                const cur = perCorner ? [...radius] : Array(4).fill(typeof radius === 'number' ? radius : 0);
                cur[i] = v;
                set({ cornerRadius: cur }, s ? 'scrub-rad' + i : undefined);
              }}
            />
          ))}
        </div>
      )}
      {n.type === 'frame' && <CheckRow checked={r.clip === true} label="Clip Content" onChange={v => set({ clip: v || undefined })} />}
      {n.type === 'ellipse' && (
        <>
          <div className="sub-label">Ellipse</div>
          <div className="row2">
            <NumberField label="⟳" value={r.startAngle ?? 0} suffix="°" title="Start angle" onChange={(v, s) => set({ startAngle: v || undefined }, s ? 'scrub-sa' : undefined)} />
            <NumberField label="◔" value={r.sweepAngle ?? 360} suffix="°" min={-360} max={360} title="Sweep" onChange={(v, s) => set({ sweepAngle: v === 360 ? undefined : v }, s ? 'scrub-sw' : undefined)} />
          </div>
          <div className="row2">
            <NumberField label="◎" value={Math.round((r.innerRadius ?? 0) * 100)} suffix="%" min={0} max={100} title="Inner radius" onChange={(v, s) => set({ innerRadius: v ? v / 100 : undefined }, s ? 'scrub-ir' : undefined)} />
          </div>
        </>
      )}
      {n.type === 'polygon' && (
        <div className="row2">
          <NumberField label="#" value={r.polygonCount ?? 3} min={3} max={60} title="Sides" onChange={(v, s) => set({ polygonCount: Math.round(v) }, s ? 'scrub-pc' : undefined)} />
        </div>
      )}
    </Section>
  );
}

// ---------- fill / stroke ----------

function strokeParts(p: any) {
  const s = p.stroke;
  if (s && typeof s === 'object' && !Array.isArray(s) && ('thickness' in s || 'align' in s || ('fill' in s && !s.type))) {
    return { fills: fillList(s.fill), width: p.strokeWidth ?? s.thickness, align: p.strokeAlignment ?? s.align, legacy: true };
  }
  return { fills: fillList(s), width: p.strokeWidth, align: p.strokeAlignment, legacy: false };
}

function PaintSection({ n, p, set, theme, prop, title }: Ctx & { prop: 'fill' | 'stroke'; title: string }) {
  const doc = useStore(s => s.doc)!;
  const [editing, setEditing] = useState<{ i: number; anchor: DOMRect } | null>(null);
  const vmenu = useMenu();
  const sp = prop === 'stroke' ? strokeParts(p) : null;
  const list: any[] = sp ? sp.fills : fillList(p.fill);
  const write = (next: any[], merge?: string) => {
    const value = next.length === 0 ? undefined : next.length === 1 && !Array.isArray(prop === 'fill' ? p.fill : p.stroke) ? next[0] : next;
    if (sp?.legacy) set({ stroke: value, strokeWidth: sp.width ?? 1, strokeAlignment: sp.align === 'inside' ? 'inner' : sp.align === 'outside' ? 'outer' : sp.align }, merge);
    else set({ [prop]: value }, merge);
  };
  const add = () => {
    const def = prop === 'fill' ? (n.type === 'text' ? '#000000' : '#D9D9D9') : '#000000';
    const next = [...list, def];
    if (prop === 'stroke' && !list.length && p.strokeWidth === undefined) set({ stroke: def, strokeWidth: 1 });
    else write(next);
  };
  const enabled = (f: any) => !(typeof f === 'object' && f.enabled === false);
  const label = (f: any) => {
    const v = typeof f === 'string' ? f : f.type === 'color' ? f.color : null;
    if (v !== null) return isVarRef(v) ? v.slice(1) : null;
    if (f.type === 'gradient') return (f.gradientType ?? 'linear').replace(/^./, (c: string) => c.toUpperCase());
    if (f.type === 'image') return 'Image';
    if (f.type === 'mesh_gradient') return 'Mesh gradient';
    if (f.type === 'shader') return 'Shader';
    return f.type;
  };
  const strokeWidth = sp?.width;
  const perSide = strokeWidth && typeof strokeWidth === 'object';
  return (
    <Section title={title} onAdd={add} empty={!list.length}>
      {list
        .map((f, i) => ({ f, i }))
        .reverse()
        .map(({ f, i }) => {
          const solid = typeof f === 'string' || f.type === 'color';
          const raw = typeof f === 'string' ? f : f.color;
          const isVar = solid && isVarRef(raw);
          const resolved = solid ? (isVar ? resolveVariable(doc, raw.slice(1), theme) : raw) : null;
          const rgba = resolved ? parseColor(resolved) : null;
          const opacity = solid ? Math.round((rgba?.a ?? 1) * 100) : Math.round((f.opacity ?? 1) * 100);
          return (
            <div className="paint-row" key={i}>
              <div className="paint-main">
                <button className="swatch swatch-btn" onClick={e => setEditing({ i, anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}>
                  <i style={{ background: paintSwatch(f, doc, theme) }} />
                </button>
                <span className="paint-label">
                  {solid && !isVar ? (
                    <input
                      key={raw}
                      defaultValue={toHex({ ...(rgba ?? { r: 0, g: 0, b: 0, a: 1 }), a: 1 }).slice(1)}
                      onKeyDown={e => {
                        e.stopPropagation();
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={e => {
                        const c = parseColor('#' + e.target.value.replace('#', ''));
                        if (!c) return;
                        const hex = toHex({ ...c, a: rgba?.a ?? 1 });
                        write(list.map((x, j) => (j === i ? (typeof x === 'string' ? hex : { ...x, color: hex }) : x)));
                      }}
                    />
                  ) : (
                    label(f)
                  )}
                </span>
                {isVar ? (
                  <span className="var-chip" title={`Bound to $${raw.slice(1)}`}>
                    <Variable />
                  </span>
                ) : (
                  <span className="paint-opacity">
                    <input
                      key={opacity}
                      defaultValue={opacity}
                      onKeyDown={e => {
                        e.stopPropagation();
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={e => {
                        const v = Math.max(0, Math.min(100, parseFloat(e.target.value)));
                        if (!isFinite(v) || v === opacity) return;
                        if (solid && rgba) {
                          const hex = toHex({ ...rgba, a: v / 100 });
                          write(list.map((x, j) => (j === i ? (typeof x === 'string' ? hex : { ...x, color: hex }) : x)));
                        } else write(list.map((x, j) => (j === i ? { ...x, opacity: v / 100 } : x)));
                      }}
                    />
                    %
                  </span>
                )}
              </div>
              {prop === 'fill' && typeof f === 'object' && f.type === 'image' && f.url && (
                <button
                  className="icon-btn"
                  title="Vectorize image (trace to editable paths)"
                  onClick={e =>
                    vmenu.open({
                      anchor: (e.currentTarget as HTMLElement).getBoundingClientRect(),
                      align: 'right',
                      items: [
                        { label: 'Vectorize as logo (2 colors)', onClick: () => runVectorize(n.key, { colors: 2, detail: 0.6 }) },
                        { label: 'Vectorize as illustration (8 colors)', onClick: () => runVectorize(n.key, { colors: 8, detail: 0.5 }) },
                        { label: 'Vectorize detailed (24 colors)', onClick: () => runVectorize(n.key, { colors: 24, detail: 0.9 }) },
                      ],
                    })
                  }
                >
                  <Spline />
                </button>
              )}
              <button
                className="icon-btn"
                title={enabled(f) ? 'Hide' : 'Show'}
                onClick={() =>
                  write(
                    list.map((x, j) => {
                      if (j !== i) return x;
                      const obj = typeof x === 'string' ? { type: 'color', color: x } : { ...x };
                      if (obj.enabled === false) delete obj.enabled;
                      else obj.enabled = false;
                      return obj;
                    }),
                  )
                }
              >
                {enabled(f) ? <Eye /> : <EyeOff />}
              </button>
              <button className="icon-btn" title="Remove" onClick={() => write(list.filter((_, j) => j !== i))}>
                <Minus />
              </button>
            </div>
          );
        })}
      {prop === 'stroke' && list.length > 0 && (
        <>
          <div className="row2" style={{ marginTop: 2 }}>
            <div className="sub-label">Position</div>
            <div className="sub-label">Weight</div>
            <Select
              value={(sp!.align === 'inside' ? 'inner' : sp!.align === 'outside' ? 'outer' : sp!.align) ?? (n.type === 'ellipse' || n.type === 'path' || n.type === 'line' ? 'center' : 'inner')}
              options={[
                { value: 'inner', label: 'Inside' },
                { value: 'center', label: 'Center' },
                { value: 'outer', label: 'Outside' },
              ]}
              onChange={v => set({ strokeAlignment: v })}
            />
            <NumberField
              label="W"
              value={perSide ? strokeWidth.top : typeof strokeWidth === 'number' ? strokeWidth : 1}
              display={perSide ? 'Mixed' : undefined}
              min={0}
              step={0.5}
              onChange={(v, s) => set({ strokeWidth: v }, s ? 'scrub-sw' : undefined)}
            />
          </div>
          <div className="row2">
            <div className="sub-label">Join</div>
            <div className="sub-label">Cap</div>
            <Select value={p.strokeLinejoin ?? 'miter'} options={[{ value: 'miter', label: 'Miter' }, { value: 'round', label: 'Round' }, { value: 'bevel', label: 'Bevel' }]} onChange={v => set({ strokeLinejoin: v === 'miter' ? undefined : v })} />
            <Select value={p.strokeLinecap ?? 'butt'} options={[{ value: 'butt', label: 'Butt' }, { value: 'round', label: 'Round' }, { value: 'square', label: 'Square' }]} onChange={v => set({ strokeLinecap: v === 'butt' ? undefined : v })} />
          </div>
        </>
      )}
      {vmenu.node}
      {editing && list[editing.i] !== undefined && (
        <PaintPopover
          anchor={editing.anchor}
          paint={list[editing.i]}
          theme={theme}
          allowImage={prop === 'fill'}
          onClose={() => setEditing(null)}
          onChange={np => write(list.map((x, j) => (j === editing.i ? np : x)), `paint-${prop}-${editing.i}`)}
        />
      )}
    </Section>
  );
}

function runVectorize(key: string, opts: { colors: number; detail: number }) {
  const notify = useStore.getState().notify;
  notify('Tracing image…');
  vectorizeNode(key, opts)
    .then(r => notify(`Vectorized into ${r.paths} editable path${r.paths === 1 ? '' : 's'}`))
    .catch(e => notify(`Vectorize failed: ${e instanceof Error ? e.message : e}`));
}

// ---------- typography ----------

const FONTS = [
  'Inter',
  'Roboto',
  'Roboto Condensed',
  'Roboto Mono',
  'Open Sans',
  'Lato',
  'Montserrat',
  'Poppins',
  'Source Sans 3',
  'Oswald',
  'Raleway',
  'Nunito',
  'Ubuntu',
  'Merriweather',
  'Playfair Display',
  'Rubik',
  'Work Sans',
  'DM Sans',
  'Manrope',
  'Space Grotesk',
  'IBM Plex Sans',
  'IBM Plex Mono',
  'JetBrains Mono',
  'Geist',
  'Barlow',
  'Barlow Condensed',
  'Bebas Neue',
  'Orbitron',
  'Rajdhani',
  'Share Tech Mono',
  'Exo 2',
  'Titillium Web',
];
const WEIGHTS = [
  { value: '100', label: 'Thin' },
  { value: '200', label: 'Extra Light' },
  { value: '300', label: 'Light' },
  { value: 'normal', label: 'Regular' },
  { value: '500', label: 'Medium' },
  { value: '600', label: 'Semi Bold' },
  { value: '700', label: 'Bold' },
  { value: '800', label: 'Extra Bold' },
  { value: '900', label: 'Black' },
];

function weightKey(w: any): string {
  const s = String(w ?? 'normal');
  if (s === '400' || s === 'regular') return 'normal';
  if (s === 'bold') return '700';
  return s;
}

function TypographySection({ p, r, set }: Ctx) {
  const usedFonts = FONTS;
  return (
    <Section title="Typography">
      <div className="field">
        <input
          list="pen-fonts"
          key={String(p.fontFamily)}
          defaultValue={isVarRef(p.fontFamily) ? p.fontFamily : r.fontFamily ?? 'Inter'}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={e => e.target.value.trim() && e.target.value !== (p.fontFamily ?? 'Inter') && set({ fontFamily: e.target.value.trim() })}
          style={{ paddingLeft: 8 }}
        />
        <datalist id="pen-fonts">
          {usedFonts.map(f => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>
      <div className="row2">
        <Select value={weightKey(r.fontWeight)} options={WEIGHTS} onChange={v => set({ fontWeight: v === 'normal' ? undefined : v })} />
        <NumberField label={<ALargeSmall />} {...numOrVar(p.fontSize, r.fontSize)} value={typeof r.fontSize === 'number' ? r.fontSize : 14} min={1} onChange={(v, s) => set({ fontSize: v }, s ? 'scrub-fs' : undefined)} title="Font size" />
      </div>
      <div className="row2">
        <div className="sub-label">Line height</div>
        <div className="sub-label">Letter spacing</div>
        <NumberField
          label={<Baseline />}
          value={typeof r.lineHeight === 'number' ? r.lineHeight : undefined}
          display={typeof r.lineHeight === 'number' ? undefined : 'Auto'}
          step={0.05}
          min={0}
          onText={t => (t.trim().toLowerCase() === 'auto' || t.trim() === '' ? (set({ lineHeight: undefined }), true) : false)}
          onChange={(v, s) => set({ lineHeight: v || undefined }, s ? 'scrub-lh' : undefined)}
          title="Line height (× font size)"
        />
        <NumberField label="|A|" value={typeof r.letterSpacing === 'number' ? r.letterSpacing : 0} suffix="px" step={0.1} onChange={(v, s) => set({ letterSpacing: v || undefined }, s ? 'scrub-ls' : undefined)} title="Letter spacing" />
      </div>
      <div className="row2">
        <div className="sub-label">Horizontal</div>
        <div className="sub-label">Vertical</div>
        <Seg
          value={p.textAlign ?? 'left'}
          onChange={v => set({ textAlign: v === 'left' ? undefined : v })}
          options={[
            { value: 'left', icon: <AlignLeft />, title: 'Left' },
            { value: 'center', icon: <AlignCenter />, title: 'Center' },
            { value: 'right', icon: <AlignRight />, title: 'Right' },
            { value: 'justify', icon: <AlignJustify />, title: 'Justify' },
          ]}
        />
        <Seg
          value={p.textAlignVertical ?? 'top'}
          onChange={v => set({ textAlignVertical: v === 'top' ? undefined : v })}
          options={[
            { value: 'top', icon: <ArrowUpToLine />, title: 'Top' },
            { value: 'middle', icon: <AlignCenterHorizontal />, title: 'Middle' },
            { value: 'bottom', icon: <ArrowDownToLine />, title: 'Bottom' },
          ]}
        />
      </div>
      <div className="row-flex">
        <button className={'icon-btn' + (p.fontStyle === 'italic' ? ' on' : '')} title="Italic" onClick={() => set({ fontStyle: p.fontStyle === 'italic' ? undefined : 'italic' })}>
          <i style={{ fontFamily: 'serif', fontSize: 13 }}>I</i>
        </button>
        <button className={'icon-btn' + (p.underline === true ? ' on' : '')} title="Underline" onClick={() => set({ underline: p.underline === true ? undefined : true })}>
          <u style={{ fontSize: 12 }}>U</u>
        </button>
        <button className={'icon-btn' + (p.strikethrough === true ? ' on' : '')} title="Strikethrough" onClick={() => set({ strikethrough: p.strikethrough === true ? undefined : true })}>
          <s style={{ fontSize: 12 }}>S</s>
        </button>
      </div>
      <textarea
        className="textarea"
        key={String(p.content)}
        defaultValue={typeof p.content === 'string' ? p.content : ''}
        onKeyDown={e => e.stopPropagation()}
        onBlur={e => e.target.value !== p.content && set({ content: e.target.value })}
        title="Text content"
      />
    </Section>
  );
}

// ---------- icons ----------

function IconSection({ p, set }: Ctx) {
  const legacy = p.type === 'icon_font' || (p.iconFontName !== undefined && p.icon === undefined);
  const lib = String(legacy ? p.iconFontFamily ?? 'lucide' : p.library ?? 'lucide');
  const name = String(legacy ? p.iconFontName ?? '' : p.icon ?? '');
  const [q, setQ] = useState('');
  const setIcon = (v: string) => set(legacy ? { iconFontName: v } : { icon: v });
  const matches = lib === 'lucide' && q ? ICON_NAMES.filter(x => x.includes(q.toLowerCase())).slice(0, 48) : [];
  return (
    <Section title="Icon">
      <Select
        value={lib}
        options={['lucide', 'feather', 'Material Symbols Outlined', 'Material Symbols Rounded', 'Material Symbols Sharp', 'phosphor'].map(v => ({ value: v, label: v }))}
        onChange={v => set(legacy ? { iconFontFamily: v } : { library: v })}
      />
      <div className="field">
        <input
          key={name}
          defaultValue={name}
          placeholder="icon name"
          style={{ paddingLeft: 8 }}
          onChange={e => setQ(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
          onBlur={e => e.target.value.trim() && e.target.value !== name && setIcon(e.target.value.trim())}
        />
      </div>
      {matches.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 120, overflow: 'auto' }}>
          {matches.map(m => (
            <button
              key={m}
              className="rp-btn"
              style={{ padding: '0 6px', background: m === name ? 'var(--control-active)' : undefined }}
              onMouseDown={e => {
                e.preventDefault();
                setIcon(m);
                setQ('');
              }}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      <NumberField label="wt" value={typeof p.weight === 'number' ? p.weight : 400} min={100} max={700} step={50} onChange={(v, s) => set({ weight: v === 400 ? undefined : v }, s ? 'scrub-iw' : undefined)} title="Icon weight" />
    </Section>
  );
}

// ---------- effects ----------

const EFFECT_TYPES = [
  { value: 'drop', label: 'Drop Shadow' },
  { value: 'inner', label: 'Inner Shadow' },
  { value: 'blur', label: 'Layer Blur' },
  { value: 'background_blur', label: 'Background Blur' },
  { value: 'shader', label: 'Shader' },
];

function effectKind(e: any) {
  if (e.type === 'shadow') return e.shadowType === 'inner' ? 'inner' : 'drop';
  return e.type;
}

function EffectsSection({ p, set, theme }: Ctx) {
  const doc = useStore(s => s.doc)!;
  const list: any[] = p.effect === undefined ? [] : Array.isArray(p.effect) ? p.effect : [p.effect];
  const [open, setOpen] = useState<number | null>(null);
  const [colorEdit, setColorEdit] = useState<{ i: number; anchor: DOMRect } | null>(null);
  const write = (next: any[], merge?: string) => set({ effect: next.length === 0 ? undefined : next.length === 1 && !Array.isArray(p.effect) ? next[0] : next }, merge);
  const upd = (i: number, ch: any, merge?: string) => write(list.map((e, j) => (j === i ? { ...e, ...ch } : e)), merge);
  return (
    <Section title="Effects" onAdd={() => write([...list, { type: 'shadow', shadowType: 'outer', color: '#00000040', offset: { x: 0, y: 4 }, blur: 8 }])} empty={!list.length}>
      {list.map((e, i) => {
        const kind = effectKind(e);
        return (
          <React.Fragment key={i}>
            <div className="paint-row">
              <button className={'icon-btn' + (open === i ? ' on' : '')} title="Effect settings" onClick={() => setOpen(open === i ? null : i)}>
                <SlidersHorizontal />
              </button>
              <Select
                value={kind}
                options={EFFECT_TYPES}
                onChange={v => {
                  if (v === 'drop' || v === 'inner') upd(i, { type: 'shadow', shadowType: v === 'inner' ? 'inner' : 'outer', offset: e.offset ?? { x: 0, y: 4 }, blur: e.blur ?? 8, color: e.color ?? '#00000040' });
                  else if (v === 'shader') {
                    write(list.map((x, j) => (j === i ? { type: 'shader', url: x.url ?? '', uniforms: x.uniforms ?? {}, ...(x.enabled === false ? { enabled: false } : {}) } : x)));
                    setOpen(i);
                  } else write(list.map((x, j) => (j === i ? { type: v, radius: x.radius ?? x.blur ?? 8, ...(x.enabled === false ? { enabled: false } : {}) } : x)));
                }}
              />
              <button className="icon-btn" onClick={() => upd(i, { enabled: e.enabled === false ? undefined : false })}>
                {e.enabled === false ? <EyeOff /> : <Eye />}
              </button>
              <button className="icon-btn" onClick={() => write(list.filter((_, j) => j !== i))}>
                <Minus />
              </button>
            </div>
            {open === i &&
              (e.type === 'shader' ? (
                <ShaderControls value={e} theme={theme} onChange={(nv, merge) => upd(i, { url: nv.url, uniforms: nv.uniforms }, merge)} />
              ) : e.type === 'shadow' ? (
                <>
                  <div className="row2">
                    <NumberField label="X" value={e.offset?.x ?? 0} onChange={(v, s) => upd(i, { offset: { ...(e.offset ?? { y: 0 }), x: v } }, s ? 'fx' : undefined)} />
                    <NumberField label="Y" value={e.offset?.y ?? 0} onChange={(v, s) => upd(i, { offset: { ...(e.offset ?? { x: 0 }), y: v } }, s ? 'fx' : undefined)} />
                    <NumberField label="B" value={e.blur ?? 0} min={0} title="Blur" onChange={(v, s) => upd(i, { blur: v }, s ? 'fx' : undefined)} />
                    <NumberField label="S" value={e.spread ?? 0} title="Spread" onChange={(v, s) => upd(i, { spread: v || undefined }, s ? 'fx' : undefined)} />
                  </div>
                  <div className="paint-main">
                    <button className="swatch swatch-btn" onClick={ev => setColorEdit({ i, anchor: (ev.currentTarget as HTMLElement).getBoundingClientRect() })}>
                      <i style={{ background: paintSwatch(e.color ?? '#00000040', doc, theme) }} />
                    </button>
                    <span className="paint-label">{isVarRef(e.color) ? e.color.slice(1) : String(e.color ?? '#00000040').replace('#', '')}</span>
                  </div>
                </>
              ) : (
                <NumberField label="R" value={e.radius ?? 0} min={0} title="Radius" onChange={(v, s) => upd(i, { radius: v }, s ? 'fx' : undefined)} />
              ))}
          </React.Fragment>
        );
      })}
      {colorEdit && list[colorEdit.i] && (
        <PaintPopover
          anchor={colorEdit.anchor}
          paint={list[colorEdit.i].color ?? '#00000040'}
          theme={theme}
          allowImage={false}
          onClose={() => setColorEdit(null)}
          onChange={np => upd(colorEdit.i, { color: typeof np === 'string' ? np : np.color ?? np.colors?.[0]?.color }, 'fx-color')}
        />
      )}
    </Section>
  );
}

// ---------- code & export ----------

function cleanHtml(el: HTMLElement): string {
  const clone = el.cloneNode(true) as HTMLElement;
  clone.style.left = '0px';
  clone.style.top = '0px';
  clone.style.position = 'relative';
  clone.querySelectorAll('[data-k]').forEach(x => x.removeAttribute('data-k'));
  clone.removeAttribute('data-k');
  return clone.outerHTML;
}

function htmlDocument(el: HTMLElement, title: string) {
  const fonts = [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet][href*="fonts.googleapis"]')].map(l => `<link rel="stylesheet" href="${l.href}">`).join('\n');
  return `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n${fonts}\n</head>\n<body style="margin:0">\n${cleanHtml(el)}\n</body>\n</html>\n`;
}

function download(name: string, href: string) {
  downloadDataUrl(name, href);
}

function CodeSection({ n }: { n: RNode }) {
  const notify = useStore(s => s.notify);
  return (
    <Section title="Code">
      <Select value="html" options={[{ value: 'html', label: 'HTML + inline CSS' }]} onChange={() => undefined} />
      <div className="row2">
        <button
          className="rp-btn"
          onClick={async () => {
            const el = elFor(n.key);
            if (!el) return;
            await navigator.clipboard.writeText(cleanHtml(el));
            notify('HTML copied to clipboard');
          }}
        >
          Copy HTML
        </button>
        <button
          className="rp-btn"
          onClick={() => {
            const el = elFor(n.key);
            if (!el) return;
            const name = displayName(n.props);
            blobToDataUrl(new Blob([htmlDocument(el, name)], { type: 'text/html' })).then(url => download(`${name}.html`, url));
          }}
        >
          Export HTML
        </button>
      </div>
    </Section>
  );
}

function ExportSection({ n }: { n: RNode }) {
  const [scale, setScale] = useState('1');
  const [format, setFormat] = useState('png');
  const notify = useStore(s => s.notify);
  const run = async () => {
    const el = elFor(n.key);
    if (!el) return;
    try {
      const { dataUrl: url } = await rasterize(el, { format: format === 'jpeg' ? 'jpg' : (format as 'png' | 'svg'), pixelRatio: Number(scale) });
      download(`${displayName(n.props)}${scale === '1' ? '' : `@${scale}x`}.${format === 'jpeg' ? 'jpg' : format}`, url);
    } catch (e) {
      notify(`Export failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  return (
    <Section title="Export">
      <div className="row2">
        <Select value={scale} options={['0.5', '1', '2', '3', '4'].map(v => ({ value: v, label: `${v}x` }))} onChange={setScale} />
        <Select value={format} options={[{ value: 'png', label: 'PNG' }, { value: 'jpeg', label: 'JPG' }, { value: 'svg', label: 'SVG' }]} onChange={setFormat} />
      </div>
      <button className="rp-btn" onClick={run}>
        Export layer
      </button>
    </Section>
  );
}

export { TypeIcon, AlignHorizontalSpaceAround, ChevronRight };
