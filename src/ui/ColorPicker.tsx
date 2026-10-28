// Paint editor popover: solid / gradient / image fills, alpha, gradient stops and variable binding.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { parseColor, toHex, colorCss, type RGBA } from '../render/paint';
import { useStore } from '../editor/store';
import { resolveVariable, isVarRef } from '../model/resolve';
import { NumberField, Select, fmt } from './common';
import { currentTree } from '../editor/tree';
import { ShaderControls } from './AssetControls';

type HSV = { h: number; s: number; v: number; a: number };

function rgbToHsv({ r, g, b, a }: RGBA): HSV {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max, a };
}

function hsvToRgb({ h, s, v, a }: HSV): RGBA {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a };
}

/** Color editing widget for a single color value (hex string or $variable). */
function ColorArea({ value, onChange, theme }: { value: string; onChange: (v: string) => void; theme: any }) {
  const doc = useStore(s => s.doc)!;
  const resolved = isVarRef(value) ? resolveVariable(doc, value.slice(1), theme) : value;
  const rgba = parseColor(resolved) ?? { r: 0, g: 0, b: 0, a: 1 };
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(rgba));
  const lastOut = useRef<string>('');
  useEffect(() => {
    if (resolved !== lastOut.current) setHsv(rgbToHsv(parseColor(resolved) ?? rgba));
  }, [resolved]);
  const emit = (next: HSV) => {
    setHsv(next);
    const hex = toHex(hsvToRgb(next));
    lastOut.current = hex;
    onChange(hex);
  };
  const drag = (e: React.PointerEvent, fn: (x: number, y: number) => void) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    const at = (ev: { clientX: number; clientY: number }) => fn(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    at(e);
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => at(ev);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const pure = toHex(hsvToRgb({ h: hsv.h, s: 1, v: 1, a: 1 }));
  const solid = toHex(hsvToRgb({ ...hsv, a: 1 }));
  const [hexText, setHexText] = useState('');
  const hexShown = toHex({ ...hsvToRgb(hsv), a: 1 }).slice(1);
  return (
    <>
      <div className="sv-box" style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})` }} onPointerDown={e => drag(e, (x, y) => emit({ ...hsv, s: x, v: 1 - y }))}>
        <div className="knob" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: solid }} />
      </div>
      <div className="slider hue" onPointerDown={e => drag(e, x => emit({ ...hsv, h: x * 359.9 }))}>
        <div className="knob" style={{ left: `${(hsv.h / 360) * 100}%`, background: pure }} />
      </div>
      <div className="slider alpha-track" onPointerDown={e => drag(e, x => emit({ ...hsv, a: Math.round(x * 100) / 100 }))}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 6, background: `linear-gradient(to right, transparent, ${solid})` }} />
        <div className="knob" style={{ left: `${hsv.a * 100}%`, background: colorCss(toHex(hsvToRgb(hsv))) }} />
      </div>
      <div className="row-flex">
        <div className="field" style={{ flex: 1 }}>
          <span className="lbl">#</span>
          <input
            value={hexText || hexShown}
            onChange={e => setHexText(e.target.value)}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={() => {
              const p = parseColor('#' + hexText.replace('#', ''));
              setHexText('');
              if (p) emit({ ...rgbToHsv(p), a: hexText.replace('#', '').length === 8 ? p.a : hsv.a });
            }}
          />
        </div>
        <NumberField value={Math.round(hsv.a * 100)} suffix="%" min={0} max={100} onChange={v => emit({ ...hsv, a: v / 100 })} style={{ width: 64 }} />
      </div>
    </>
  );
}

function VariableList({ value, onPick, theme }: { value: any; onPick: (v: string) => void; theme: any }) {
  const doc = useStore(s => s.doc)!;
  const vars = Object.entries(doc.variables ?? {}).filter(([, v]) => v.type === 'color');
  if (!vars.length) return null;
  return (
    <>
      <div className="sub-label">Variables</div>
      <div className="var-list">
        {vars.map(([name]) => {
          const c = resolveVariable(doc, name, theme);
          return (
            <button key={name} className={'var-item' + (value === `$${name}` ? ' on' : '')} onClick={() => onPick(`$${name}`)}>
              <span className="swatch" style={{ margin: 0 }}>
                <i style={{ background: colorCss(c) }} />
              </span>
              {name}
            </button>
          );
        })}
      </div>
    </>
  );
}

export function PaintPopover({ anchor, paint, onChange, onClose, allowImage = true, theme }: { anchor: DOMRect; paint: any; onChange: (p: any) => void; onClose: () => void; allowImage?: boolean; theme: any }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: -9999, top: 0 });
  const [stop, setStop] = useState(0);
  useLayoutEffect(() => {
    const h = ref.current!.offsetHeight;
    setPos({ left: Math.max(8, anchor.left - 252), top: Math.max(8, Math.min(anchor.top - 40, innerHeight - h - 8)) });
  }, [anchor]);
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.swatch-btn')) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const t = setTimeout(() => window.addEventListener('pointerdown', down, true));
    window.addEventListener('keydown', key);
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);

  const kind = typeof paint === 'string' ? 'color' : paint?.type === 'gradient' ? (paint.gradientType ?? 'linear') : (paint?.type ?? 'color');
  const solidValue = typeof paint === 'string' ? paint : paint?.type === 'color' ? paint.color : '#000000';
  const setSolid = (c: string) => onChange(typeof paint === 'object' && paint?.type === 'color' ? { ...paint, color: c } : c);

  const switchKind = (k: string) => {
    if (k === kind) return;
    const base = typeof paint === 'object' && paint?.enabled === false ? { enabled: false } : {};
    const first = kind === 'color' ? solidValue : paint?.colors?.[0]?.color ?? '#000000';
    if (k === 'color') return onChange(first);
    if (k === 'image') return onChange({ type: 'image', ...base, url: '', mode: 'cover' });
    if (k === 'shader') return onChange({ type: 'shader', ...base, url: '', uniforms: {} });
    const colors = paint?.colors ?? [
      { color: isVarRef(first) ? first : toHex({ ...(parseColor(first) ?? { r: 0, g: 0, b: 0, a: 1 }) }), position: 0 },
      { color: '#FFFFFF00', position: 1 },
    ];
    onChange({ type: 'gradient', ...base, gradientType: k, rotation: paint?.rotation ?? 180, size: k === 'linear' ? { height: 1 } : { width: 1, height: 1 }, colors });
  };

  const colors: any[] = paint?.colors ?? [];
  const cur = colors[Math.min(stop, colors.length - 1)];
  const setStopColor = (c: string) => onChange({ ...paint, colors: colors.map((s, i) => (i === stop ? { ...s, color: c } : s)) });
  const doc = useStore(s => s.doc)!;
  const resolveC = (c: any) => colorCss(isVarRef(c) ? resolveVariable(doc, c.slice(1), theme) : c);

  const barDrag = (e: React.PointerEvent) => {
    const bar = e.currentTarget as HTMLElement;
    const r = bar.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const hitStop = (e.target as HTMLElement).dataset.stop;
    let idx = hitStop !== undefined ? Number(hitStop) : -1;
    let list = colors;
    if (idx < 0) {
      list = [...colors, { color: cur?.color ?? '#000000', position: Math.round(t * 100) / 100 }];
      idx = list.length - 1;
      onChange({ ...paint, colors: list });
    }
    setStop(idx);
    bar.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      list = list.map((s, i) => (i === idx ? { ...s, position: Math.round(p * 100) / 100 } : s));
      onChange({ ...paint, colors: list });
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  };

  const sorted = [...colors].sort((a, b) => a.position - b.position);
  const kinds = [
    { value: 'color', label: 'Solid' },
    { value: 'linear', label: 'Linear' },
    { value: 'radial', label: 'Radial' },
    { value: 'angular', label: 'Angular' },
    ...(allowImage ? [{ value: 'image', label: 'Image' }, { value: 'shader', label: 'Shader' }] : []),
  ];

  return createPortal(
    <div className="popover" ref={ref} style={pos} onKeyDown={e => e.stopPropagation()}>
      <div className="popover-head">
        <Select value={kind} options={kinds} onChange={switchKind} style={{ width: 110 }} />
        <button className="icon-btn" onClick={onClose}>
          <X />
        </button>
      </div>
      {kind === 'color' && (
        <>
          <ColorArea value={solidValue} onChange={setSolid} theme={theme} />
          <VariableList value={solidValue} onPick={setSolid} theme={theme} />
        </>
      )}
      {(kind === 'linear' || kind === 'radial' || kind === 'angular') && (
        <>
          <div className="grad-bar alpha-track" onPointerDown={barDrag} title="Click to add a stop, drag to move">
            <div style={{ position: 'absolute', inset: 0, borderRadius: 4, background: `linear-gradient(to right, ${sorted.map(s => `${resolveC(s.color)} ${s.position * 100}%`).join(', ')})` }} />
            {colors.map((s, i) => (
              <div key={i} data-stop={i} className={'grad-stop' + (i === stop ? ' on' : '')} style={{ left: `${s.position * 100}%`, background: resolveC(s.color) }} />
            ))}
          </div>
          <div className="row-flex">
            <NumberField label="∠" value={paint.rotation ?? 0} suffix="°" onChange={v => onChange({ ...paint, rotation: v })} />
            <NumberField label="%" value={Math.round((paint.opacity ?? 1) * 100)} min={0} max={100} onChange={v => onChange({ ...paint, opacity: v / 100 })} title="Opacity" />
            <button
              className="rp-btn"
              style={{ padding: '0 8px' }}
              disabled={colors.length <= 2}
              onClick={() => {
                if (colors.length <= 2) return;
                onChange({ ...paint, colors: colors.filter((_, i) => i !== stop) });
                setStop(0);
              }}
            >
              Remove stop
            </button>
          </div>
          {cur && (
            <>
              <div className="sub-label">Stop {fmt(cur.position * 100, 0)}%</div>
              <ColorArea value={cur.color} onChange={setStopColor} theme={theme} />
              <VariableList value={cur.color} onPick={setStopColor} theme={theme} />
            </>
          )}
        </>
      )}
      {kind === 'shader' && <ShaderControls value={paint} theme={theme} onChange={nv => onChange({ ...paint, url: nv.url, uniforms: nv.uniforms })} />}
      {kind === 'image' && (
        <>
          <div className="sub-label">Image URL (relative to the .pen file)</div>
          <div className="field">
            <input defaultValue={paint.url ?? ''} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} onBlur={e => onChange({ ...paint, url: e.target.value })} />
          </div>
          <Select value={paint.mode ?? 'cover'} options={[{ value: 'cover', label: 'Fill (cover)' }, { value: 'contain', label: 'Fit (contain)' }, { value: 'stretch', label: 'Stretch' }]} onChange={v => onChange({ ...paint, mode: v })} />
          <NumberField label="%" value={Math.round((paint.opacity ?? 1) * 100)} min={0} max={100} onChange={v => onChange({ ...paint, opacity: v / 100 })} title="Opacity" />
        </>
      )}
    </div>,
    document.body,
  );
}

export function paintSwatch(paint: any, doc: any, theme: any): string {
  const res = (c: any) => colorCss(isVarRef(c) ? resolveVariable(doc, c.slice(1), theme) : c);
  if (typeof paint === 'string') return res(paint);
  if (!paint) return 'transparent';
  if (paint.type === 'color') return res(paint.color);
  if (paint.type === 'gradient') {
    const stops = (paint.colors ?? []).map((s: any) => `${res(s.color)} ${s.position * 100}%`).join(', ');
    return paint.gradientType === 'radial' ? `radial-gradient(${stops || 'transparent, transparent'})` : `linear-gradient(${180 - (paint.rotation ?? 0)}deg, ${stops || 'transparent, transparent'})`;
  }
  if (paint.type === 'image') return '#71717a';
  if (paint.type === 'shader') return 'conic-gradient(#f43f5e, #f59e0b, #22c55e, #3b82f6, #a855f7, #f43f5e)';
  return '#71717a';
}

export { currentTree };
