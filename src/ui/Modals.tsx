// Modal dialogs: keyboard shortcuts, variables & themes, settings, about.
import React, { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { useStore } from '../editor/store';
import { defaultTheme, resolveVariable, isVarRef } from '../model/resolve';
import { colorCss } from '../render/paint';
import { PaintPopover } from './ColorPicker';
import { CheckRow, Select } from './common';
import { FindReplace, LintPanel } from './FindLint';

export function Modals() {
  const modal = useStore(s => s.modal);
  if (!modal) return null;
  const close = () => useStore.setState({ modal: null });
  const titles: Record<string, string> = { shortcuts: 'Keyboard Shortcuts', variables: 'Variables & Themes', settings: 'Settings', about: 'About', find: 'Find & Replace', lint: 'Design Lint' };
  return (
    <div className="modal-backdrop" onPointerDown={e => e.target === e.currentTarget && close()} onKeyDown={e => e.key === 'Escape' && close()}>
      <div className="modal" style={modal === 'settings' || modal === 'about' || modal === 'find' || modal === 'lint' ? { width: 560 } : undefined}>
        <div className="modal-head">
          {titles[modal]}
          <button className="icon-btn" onClick={close}>
            <X />
          </button>
        </div>
        <div className="modal-body">
          {modal === 'shortcuts' && <Shortcuts />}
          {modal === 'variables' && <Variables />}
          {modal === 'settings' && <Settings />}
          {modal === 'about' && <About />}
          {modal === 'find' && <FindReplace />}
          {modal === 'lint' && <LintPanel />}
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, [string, string][]][] = [
  [
    'Tools',
    [
      ['Move', 'V'],
      ['Scale', 'K'],
      ['Rectangle', 'R'],
      ['Ellipse', 'O'],
      ['Pen', 'P'],
      ['Text', 'T'],
      ['Frame', 'F / A'],
      ['Note', 'N'],
      ['Eyedropper (Shift: stroke)', 'I'],
      ['Hand (hold)', 'H / Space'],
    ],
  ],
  [
    'Edit',
    [
      ['Undo', 'Ctrl Z'],
      ['Redo', 'Ctrl Shift Z'],
      ['Copy / Cut / Paste', 'Ctrl C / X / V'],
      ['Duplicate', 'Ctrl D'],
      ['Delete', 'Del'],
      ['Select all', 'Ctrl A'],
      ['Group', 'Ctrl G'],
      ['Frame selection', 'Ctrl Alt G'],
      ['Ungroup', 'Ctrl Shift G'],
      ['Create component', 'Ctrl Alt K'],
      ['Rename', 'Ctrl R'],
      ['Hide / show', 'Ctrl Shift H'],
      ['Bring forward / send backward', 'Ctrl ] / ['],
      ['Bring to front / send to back', 'Ctrl Shift ] / ['],
      ['Nudge', 'Arrows (Shift ×10)'],
      ['Select parent / children', 'Esc / Enter'],
      ['Deep select', 'Ctrl click'],
    ],
  ],
  [
    'View',
    [
      ['Zoom in / out', 'Ctrl + / -'],
      ['Zoom to fit', 'Shift 1'],
      ['Zoom to selection', 'Shift 2'],
      ['Zoom to 100%', 'Shift 0'],
      ['Toggle sidebar', 'Ctrl \\'],
      ['Present', 'Ctrl Alt Enter'],
    ],
  ],
  [
    'File',
    [
      ['Save', 'Ctrl S'],
      ['Save as', 'Ctrl Shift S'],
      ['Open', 'Ctrl O'],
    ],
  ],
];

function Shortcuts() {
  return (
    <div className="kbd-grid">
      {SHORTCUTS.map(([group, list]) => (
        <React.Fragment key={group}>
          <h4>{group}</h4>
          {list.map(([label, k]) => (
            <div key={label} className="kbd-line">
              {label} <kbd>{k}</kbd>
            </div>
          ))}
        </React.Fragment>
      ))}
    </div>
  );
}

function Variables() {
  const doc = useStore(s => s.doc);
  const preview = useStore(s => s.previewTheme);
  const edit = useStore(s => s.edit);
  const [picker, setPicker] = useState<{ name: string; idx: number; anchor: DOMRect } | null>(null);
  if (!doc) return null;
  const themes = doc.themes ?? {};
  const theme = { ...defaultTheme(doc), ...(preview ?? {}) };
  const vars = Object.entries(doc.variables ?? {});
  const axes = Object.keys(themes);
  // Columns: one per value of the first theme axis (enough for Light/Dark style files), else a single value column.
  const axis = axes[0];
  const columns: (string | null)[] = axis ? themes[axis] : [null];

  const entryFor = (v: any, col: string | null) => {
    if (!Array.isArray(v.value)) return { idx: -1, value: v.value };
    if (col === null) return { idx: 0, value: v.value[0]?.value };
    const idx = v.value.findIndex((e: any) => e.theme?.[axis] === col);
    if (idx >= 0) return { idx, value: v.value[idx].value };
    const base = v.value.findIndex((e: any) => !e.theme || !(axis in e.theme));
    return { idx: -2, value: base >= 0 ? v.value[base].value : undefined };
  };

  const setValue = (name: string, col: string | null, value: any) =>
    edit(d => {
      const v = d.variables![name];
      if (!Array.isArray(v.value)) {
        if (col === null || col === themes[axis]?.[0]) v.value = value;
        else v.value = [{ value: v.value }, { value, theme: { [axis]: col } }];
        return;
      }
      const idx = col === null ? 0 : v.value.findIndex((e: any) => e.theme?.[axis] === col);
      if (idx >= 0) v.value[idx].value = value;
      else v.value.push({ value, theme: { [axis]: col! } });
    }, `var-${name}-${col}`);

  const coerce = (type: string, text: string) => (type === 'number' ? Number(text) : type === 'boolean' ? text === 'true' : text);

  return (
    <>
      {axes.length > 0 && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
          <span style={{ color: 'var(--muted)' }}>Preview theme:</span>
          {axes.map(a => (
            <label key={a} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {a}
              <Select value={theme[a]} options={themes[a].map(v => ({ value: v, label: v }))} onChange={v => useStore.setState({ previewTheme: { ...(preview ?? {}), [a]: v } })} style={{ width: 120 }} />
            </label>
          ))}
        </div>
      )}
      <table className="var-table">
        <thead>
          <tr>
            <th style={{ width: '30%' }}>Name</th>
            <th style={{ width: 80 }}>Type</th>
            {columns.map(c => (
              <th key={String(c)}>{c ?? 'Value'}</th>
            ))}
            <th style={{ width: 32 }} />
          </tr>
        </thead>
        <tbody>
          {vars.map(([name, v]) => (
            <tr key={name}>
              <td>
                <input
                  defaultValue={name}
                  onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  onBlur={e => {
                    const nn = e.target.value.trim();
                    if (!nn || nn === name || doc.variables?.[nn]) return;
                    edit(d => {
                      const entries = Object.entries(d.variables!).map(([k, val]) => [k === name ? nn : k, val] as const);
                      d.variables = Object.fromEntries(entries);
                      const ref = `$${name}`;
                      const walk = (x: any): any => {
                        if (x === ref) return `$${nn}`;
                        if (Array.isArray(x)) return x.map(walk);
                        if (x && typeof x === 'object') {
                          for (const k of Object.keys(x)) x[k] = walk(x[k]);
                        }
                        return x;
                      };
                      walk(d.children);
                      walk(d.variables);
                    });
                  }}
                />
              </td>
              <td style={{ color: 'var(--muted)' }}>{v.type}</td>
              {columns.map(c => {
                const { value } = entryFor(v, c);
                const shown = isVarRef(value) ? resolveVariable(doc, value.slice(1), c ? { ...theme, [axis]: c } : theme) : value;
                return (
                  <td key={String(c)}>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {v.type === 'color' && (
                        <button
                          className="swatch swatch-btn"
                          style={{ margin: 0 }}
                          onClick={e => setPicker({ name, idx: columns.indexOf(c), anchor: (e.currentTarget as HTMLElement).getBoundingClientRect() })}
                        >
                          <i style={{ background: colorCss(shown) }} />
                        </button>
                      )}
                      <input key={String(value)} defaultValue={value === undefined ? '' : String(value)} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} onBlur={e => e.target.value !== String(value ?? '') && setValue(name, c, coerce(v.type, e.target.value))} />
                    </div>
                  </td>
                );
              })}
              <td>
                <button
                  className="icon-btn"
                  title="Delete variable"
                  onClick={() =>
                    edit(d => {
                      delete d.variables![name];
                    })
                  }
                >
                  <Trash2 />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        {(['color', 'number', 'string', 'boolean'] as const).map(t => (
          <button
            key={t}
            className="rp-btn"
            style={{ padding: '0 10px', height: 28 }}
            onClick={() =>
              edit(d => {
                d.variables ??= {};
                let i = 1;
                while (d.variables[`${t}-${i}`]) i++;
                d.variables[`${t}-${i}`] = { type: t, value: t === 'color' ? '#000000' : t === 'number' ? 0 : t === 'boolean' ? false : '' };
              })
            }
          >
            <Plus /> {t}
          </button>
        ))}
      </div>
      {picker && (
        <PaintPopover
          anchor={picker.anchor}
          theme={theme}
          allowImage={false}
          paint={entryFor(doc.variables![picker.name], columns[picker.idx]).value ?? '#000000'}
          onClose={() => setPicker(null)}
          onChange={p => setValue(picker.name, columns[picker.idx], typeof p === 'string' ? p : p.color ?? '#000000')}
        />
      )}
    </>
  );
}

function Settings() {
  const uiTheme = useStore(s => s.uiTheme);
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Interface theme
        <Select
          value={uiTheme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
          onChange={v => {
            useStore.setState({ uiTheme: v });
            try {
              localStorage.setItem('pen.uiTheme', v);
            } catch {
              /* ignore */
            }
          }}
          style={{ width: 140 }}
        />
      </label>
      <CheckRow checked={useStore.getState().leftOpen} label="Show layers sidebar" onChange={v => useStore.setState({ leftOpen: v })} />
    </div>
  );
}

function About() {
  return (
    <div style={{ lineHeight: 1.6, color: 'var(--muted)' }}>
      Superpencil edits <b style={{ color: 'var(--fg)' }}>.spen</b> designs (the default for new files) and pen.dev <b style={{ color: 'var(--fg)' }}>.pen</b> files. Both are the same plain JSON, so a design can
      be saved as either and opened in pen.dev too (File menu → Save a copy as .pen). When opened from the workspace, the editor reloads automatically if the file changes on disk.
    </div>
  );
}
