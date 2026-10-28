// Panel controls generated from script @input annotations and shader uniform annotations, plus asset file helpers.
import React, { useEffect, useState } from 'react';
import { FilePlus, RefreshCw } from 'lucide-react';
import { useStore } from '../editor/store';
import { useTree } from '../editor/tree';
import { makeUrlResolver } from '../editor/fileio';
import { inVsCode, request } from '../editor/host';
import { invalidateAssets, loadText, parseScriptHeader, SCRIPT_TEMPLATE, type ScriptInput } from '../render/scripts';
import { isUserUniform, parseShader, SHADER_TEMPLATE, type UniformInfo } from '../render/shaders';
import { colorCss, parseColor, toHex } from '../render/paint';
import { resolveVariable, isVarRef } from '../model/resolve';
import { displayName } from '../model/doc';
import { CheckRow, NumberField, Select } from './common';
import { PaintPopover } from './ColorPicker';

/** Writes a text asset next to the .pen file (via VS Code or the local server). Returns the ./relative URL. */
export async function writeAsset(relPath: string, text: string): Promise<string | null> {
  const s = useStore.getState();
  const rel = relPath.replace(/^\.?\//, '');
  if (inVsCode) {
    const ok = await request<boolean>('writeFile', { relPath: rel, dataUrl: 'data:text/plain;charset=utf-8,' + encodeURIComponent(text) });
    return ok ? `./${rel}` : null;
  }
  if (s.file?.path) {
    const dir = s.file.path.includes('/') ? s.file.path.slice(0, s.file.path.lastIndexOf('/') + 1) : '';
    const r = await fetch(`/api/file?path=${encodeURIComponent(dir + rel)}`, { method: 'PUT', body: text });
    return r.ok ? `./${rel}` : null;
  }
  return null;
}

export async function createAssetFile(kind: 'script' | 'shader'): Promise<string | null> {
  const name = `${kind === 'script' ? 'scripts/script' : 'shaders/shader'}-${Math.random().toString(36).slice(2, 6)}.${kind === 'script' ? 'js' : 'glsl'}`;
  const url = await writeAsset(name, kind === 'script' ? SCRIPT_TEMPLATE : SHADER_TEMPLATE);
  if (!url) useStore.getState().notify('Could not create the file (open the .pen file from a folder first)');
  else useStore.getState().notify(`Created ${name} next to the .pen file — edit it and the canvas updates`);
  return url;
}

function useAssetText(url: string | undefined) {
  const path = useStore(s => s.file?.path ?? null);
  const version = useStore(s => s.assetVersion);
  const [state, setState] = useState<{ text?: string; error?: string }>({});
  useEffect(() => {
    if (!url) return setState({});
    let live = true;
    loadText(makeUrlResolver(path)(url))
      .then(text => live && setState({ text }))
      .catch(e => live && setState({ error: String(e?.message ?? e) }));
    return () => {
      live = false;
    };
  }, [url, path, version]);
  return state;
}

function ColorValue({ value, onChange, theme }: { value: any; onChange: (v: string) => void; theme: any }) {
  const doc = useStore(s => s.doc)!;
  const [open, setOpen] = useState<DOMRect | null>(null);
  const shown = isVarRef(value) ? resolveVariable(doc, value.slice(1), theme) : value;
  return (
    <div className="paint-main">
      <button className="swatch swatch-btn" onClick={e => setOpen((e.currentTarget as HTMLElement).getBoundingClientRect())}>
        <i style={{ background: colorCss(shown ?? '#000000') }} />
      </button>
      <span className="paint-label">{isVarRef(value) ? value.slice(1) : String(value ?? '').replace('#', '')}</span>
      {open && <PaintPopover anchor={open} paint={value ?? '#000000'} theme={theme} allowImage={false} onClose={() => setOpen(null)} onChange={p => onChange(typeof p === 'string' ? p : p.color ?? '#000000')} />}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <div className="sub-label">{label}</div>
      {children}
    </>
  );
}

/** Controls for one script input. */
function InputControl({ input, value, onChange, theme }: { input: ScriptInput; value: any; onChange: (v: any, scrub?: boolean) => void; theme: any }) {
  const tree = useTree();
  const v = value ?? input.default;
  switch (input.type) {
    case 'number':
      return <NumberField label="#" value={typeof v === 'number' ? v : Number(v) || 0} min={input.min} max={input.max} onChange={onChange} />;
    case 'boolean':
      return <CheckRow checked={v === true || v === 'true'} label={input.name} onChange={onChange} />;
    case 'color':
      return <ColorValue value={v} onChange={onChange} theme={theme} />;
    case 'enum':
      return <Select value={String(v ?? '')} options={(input.options ?? []).map(o => ({ value: o, label: o }))} onChange={onChange} />;
    case 'ref': {
      const comps = tree ? [...tree.byKey.values()].filter(n => n.isComponent && !n.inInstance) : [];
      return <Select value={String(v ?? '')} options={[{ value: '', label: '(none)' }, ...comps.map(c => ({ value: c.key, label: displayName(c.props) }))]} onChange={x => onChange(x || undefined)} />;
    }
    default:
      return (
        <div className="field">
          <input
            key={String(v)}
            defaultValue={v ?? ''}
            style={{ paddingLeft: 8 }}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={e => e.target.value !== String(v ?? '') && onChange(e.target.value)}
          />
        </div>
      );
  }
}

export function ScriptControls({ props, theme, set }: { props: any; theme: any; set: (ch: Record<string, any>, merge?: string) => void }) {
  const { text, error } = useAssetText(props.scriptUri);
  const header = text ? parseScriptHeader(text) : null;
  const inputs = props.inputs ?? {};
  return (
    <>
      <div className="sub-label">File (relative to the .pen file)</div>
      <div className="row-flex">
        <div className="field" style={{ flex: 1 }}>
          <input
            key={props.scriptUri}
            defaultValue={props.scriptUri ?? ''}
            placeholder="./scripts/chart.js"
            style={{ paddingLeft: 8 }}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={e => e.target.value !== (props.scriptUri ?? '') && set({ scriptUri: e.target.value || undefined })}
          />
        </div>
        <button className="icon-btn" title="Reload scripts and shaders" onClick={invalidateAssets}>
          <RefreshCw />
        </button>
        <button
          className="icon-btn"
          title="New script file from a template"
          onClick={async () => {
            const url = await createAssetFile('script');
            if (url) set({ scriptUri: url });
          }}
        >
          <FilePlus />
        </button>
      </div>
      {error && <div style={{ color: '#f43f5e', fontSize: 10 }}>{error}</div>}
      {header?.inputs.map(i => (
        <Labeled key={i.name} label={i.name}>
          <InputControl input={i} value={inputs[i.name]} theme={theme} onChange={(v, scrub) => set({ inputs: { ...inputs, [i.name]: v } }, scrub ? 'scrub-in-' + i.name : undefined)} />
        </Labeled>
      ))}
    </>
  );
}

function uniformValueToColor(v: any): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return toHex({ r: (v[0] ?? 0) * 255, g: (v[1] ?? 0) * 255, b: (v[2] ?? 0) * 255, a: v[3] ?? 1 });
  return '#000000';
}

function UniformControl({ u, value, onChange, theme }: { u: UniformInfo; value: any; onChange: (v: any, scrub?: boolean) => void; theme: any }) {
  const v = value ?? u.default;
  if (u.color || (/^vec[34]$/.test(u.type) && typeof v === 'string' && v.startsWith('#'))) {
    return <ColorValue value={uniformValueToColor(v)} theme={theme} onChange={c => onChange(u.type === 'vec4' ? c : (parseColor(c) ? toHex({ ...parseColor(c)!, a: 1 }) : c))} />;
  }
  if (u.type === 'float' || u.type === 'int') {
    const n = Number(v ?? 0);
    const range = u.min !== undefined && u.max !== undefined ? u.max - u.min : 0;
    return (
      <div className="row-flex">
        {range > 0 && (
          <input
            type="range"
            min={u.min}
            max={u.max}
            step={u.type === 'int' ? 1 : range / 200}
            value={n}
            onChange={e => onChange(Number(e.target.value), true)}
            style={{ flex: 1, minWidth: 0, accentColor: 'var(--sel)' }}
          />
        )}
        <NumberField value={n} min={u.min} max={u.max} step={u.type === 'int' ? 1 : 0.1} onChange={onChange} style={{ width: range > 0 ? 64 : undefined, flex: range > 0 ? 'none' : 1 }} />
      </div>
    );
  }
  if (u.type === 'bool') return <CheckRow checked={v === true || v === 'true'} label={u.label ?? u.name} onChange={onChange} />;
  return (
    <div className="field">
      <input
        key={JSON.stringify(v)}
        defaultValue={Array.isArray(v) ? v.join(', ') : (v ?? '')}
        placeholder={u.type === 'sampler2D' ? './image.png' : '0, 0'}
        style={{ paddingLeft: 8 }}
        onKeyDown={e => {
          e.stopPropagation();
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
        onBlur={e => {
          const t = e.target.value.trim();
          onChange(u.type === 'sampler2D' ? t : t.split(/[\s,]+/).filter(Boolean).map(Number));
        }}
      />
    </div>
  );
}

/** URL field + uniform controls for a shader fill or shader effect. */
export function ShaderControls({ value, onChange, theme }: { value: { url?: string; uniforms?: Record<string, any> }; onChange: (v: { url?: string; uniforms?: Record<string, any> }, merge?: string) => void; theme: any }) {
  const { text, error } = useAssetText(value.url);
  const uniforms = text ? parseShader(text).filter(isUserUniform) : [];
  const cur = value.uniforms ?? {};
  return (
    <>
      <div className="sub-label">Shader file (relative to the .pen file)</div>
      <div className="row-flex">
        <div className="field" style={{ flex: 1 }}>
          <input
            key={value.url}
            defaultValue={value.url ?? ''}
            placeholder="./shaders/effect.glsl"
            style={{ paddingLeft: 8 }}
            onKeyDown={e => {
              e.stopPropagation();
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            onBlur={e => e.target.value !== (value.url ?? '') && onChange({ ...value, url: e.target.value })}
          />
        </div>
        <button className="icon-btn" title="Reload scripts and shaders" onClick={invalidateAssets}>
          <RefreshCw />
        </button>
        <button
          className="icon-btn"
          title="New shader file from a template"
          onClick={async () => {
            const url = await createAssetFile('shader');
            if (url) onChange({ ...value, url });
          }}
        >
          <FilePlus />
        </button>
      </div>
      {error && <div style={{ color: '#f43f5e', fontSize: 10 }}>{error}</div>}
      {uniforms.map(u => (
        <Labeled key={u.name} label={u.label ?? u.name}>
          <UniformControl u={u} value={cur[u.name]} theme={theme} onChange={(v, scrub) => onChange({ ...value, uniforms: { ...cur, [u.name]: v } }, scrub ? 'scrub-u-' + u.name : undefined)} />
        </Labeled>
      ))}
    </>
  );
}
