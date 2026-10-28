// Find & replace (text content, layer names, variable references) and the design lint panel.
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { useStore, applyProps, keySource } from '../editor/store';
import { useTree } from '../editor/tree';
import { zoomToKeys } from '../editor/ops';
import { displayName } from '../model/doc';
import { lintDesign, type LintIssue } from '../editor/lint';
import type { RNode } from '../model/types';
import { CheckRow, Select } from './common';

type Scope = 'text' | 'names' | 'variables';
type Hit = { key: string; field: string; value: string };

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function show(key: string) {
  useStore.setState({ modal: null });
  useStore.getState().select([key]);
  zoomToKeys([key], 80);
}

export function FindReplace() {
  const tree = useTree();
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [scope, setScope] = useState<Scope>('text');
  const [caseSensitive, setCase] = useState(false);
  const [whole, setWhole] = useState(false);
  const re = useMemo(() => {
    if (!find) return null;
    const body = escapeRe(scope === 'variables' ? find.replace(/^\$/, '') : find);
    return new RegExp(whole ? `\\b${body}\\b` : body, caseSensitive ? 'g' : 'gi');
  }, [find, scope, caseSensitive, whole]);
  const hits = useMemo(() => {
    if (!tree || !re) return [];
    const out: Hit[] = [];
    const visit = (n: RNode) => {
      // Generated (script) output can't be edited; instance children are edited as overrides.
      if (n.generated) return;
      const p = n.props;
      if (scope === 'text' && n.type === 'text' && typeof p.content === 'string' && p.content.match(re)) out.push({ key: n.key, field: 'content', value: p.content });
      if (scope === 'names' && typeof p.name === 'string' && p.name.match(re)) out.push({ key: n.key, field: 'name', value: p.name });
      if (scope === 'variables')
        for (const [k, v] of Object.entries(p)) {
          if (k === 'children' || k === 'descendants') continue;
          const s = JSON.stringify(v);
          if (s && [...s.matchAll(/"\$([^"]+)"/g)].some(m => new RegExp(re.source, re.flags.replace('g', '')).test(m[1]))) out.push({ key: n.key, field: k, value: s.length > 80 ? s.slice(0, 80) + '…' : s });
        }
      n.children.forEach(visit);
    };
    tree.roots.forEach(visit);
    return out.slice(0, 500);
  }, [tree, re, scope]);

  const replaceIn = (h: Hit) => (d: any) => {
    const n = tree!.byKey.get(h.key);
    if (!n || !re) return;
    if (scope === 'variables') {
      const target = replace.replace(/^\$/, '');
      const swap = (v: any): any =>
        typeof v === 'string' && v.startsWith('$') ? '$' + v.slice(1).replace(re, target) : Array.isArray(v) ? v.map(swap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v;
      applyProps(d, h.key, { [h.field]: swap(n.props[h.field]) });
    } else applyProps(d, h.key, { [h.field]: String(n.props[h.field]).replace(re, replace) });
  };
  const replaceOne = (h: Hit) => useStore.getState().edit(replaceIn(h));
  const replaceAll = () =>
    useStore.getState().edit(d => {
      for (const h of hits) replaceIn(h)(d);
    });

  const mark = (s: string) => {
    if (!re) return s;
    const parts: React.ReactNode[] = [];
    let last = 0;
    for (const m of s.matchAll(new RegExp(re.source, re.flags))) {
      parts.push(s.slice(last, m.index), <mark key={m.index}>{m[0]}</mark>);
      last = (m.index ?? 0) + m[0].length;
      if (parts.length > 20) break;
    }
    parts.push(s.slice(last));
    return parts;
  };

  return (
    <div className="find-modal" onKeyDown={e => e.stopPropagation()}>
      <div className="find-row">
        <input className="text-input" autoFocus placeholder={scope === 'variables' ? 'Variable name, e.g. $primary' : 'Find…'} value={find} onChange={e => setFind(e.target.value)} />
        <Select<Scope>
          value={scope}
          options={[
            { value: 'text', label: 'Text content' },
            { value: 'names', label: 'Layer names' },
            { value: 'variables', label: 'Variable uses' },
          ]}
          onChange={setScope}
        />
      </div>
      <div className="find-row">
        <input className="text-input" placeholder="Replace with…" value={replace} onChange={e => setReplace(e.target.value)} />
        <button className="rp-btn" style={{ padding: '0 12px', height: 28 }} disabled={!hits.length} onClick={replaceAll}>
          Replace all ({hits.length})
        </button>
      </div>
      <div className="find-row" style={{ gap: 16 }}>
        <CheckRow checked={caseSensitive} label="Match case" onChange={setCase} />
        <CheckRow checked={whole} label="Whole word" onChange={setWhole} />
      </div>
      <div className="find-results">
        {find && !hits.length && <div className="hint">No matches.</div>}
        {hits.map((h, i) => {
          const n = tree?.byKey.get(h.key);
          return (
            <div key={h.key + h.field + i} className="find-hit" onClick={() => show(h.key)}>
              <span className="where">{n ? displayName(n.props).slice(0, 24) : h.key}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scope === 'variables' ? h.field + ': ' + h.value : mark(h.value)}</span>
              <button
                className="rp-btn"
                style={{ padding: '0 8px' }}
                title={keySource(h.key).kind === 'real' ? 'Replace' : 'Replace (saved as an instance override)'}
                onClick={e => {
                  e.stopPropagation();
                  replaceOne(h);
                }}
              >
                Replace
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function LintPanel() {
  const selection = useStore(s => s.selection);
  const tree = useTree();
  const [scope, setScope] = useState<'all' | 'selection'>(selection.length ? 'selection' : 'all');
  const [issues, setIssues] = useState<LintIssue[] | null>(null);
  const [run, setRun] = useState(0);
  const rootKey = scope === 'selection' && selection[0] ? selection[0] : undefined;
  useEffect(() => {
    let live = true;
    setIssues(null);
    lintDesign(rootKey).then(r => live && setIssues(r));
    return () => {
      live = false;
    };
  }, [rootKey, run]);
  const fix = (i: LintIssue) => {
    if (!i.key || !i.fix) return;
    useStore.getState().edit(d => applyProps(d, i.key!, i.fix!.changes));
    setIssues(list => list?.filter(x => x !== i) ?? null);
  };
  const fixable = issues?.filter(i => i.fix && i.key) ?? [];
  return (
    <div className="lint-modal" onKeyDown={e => e.stopPropagation()}>
      <div className="find-row">
        <Select
          value={scope}
          options={[
            { value: 'all', label: 'Whole file' },
            { value: 'selection', label: selection[0] && tree?.byKey.get(selection[0]) ? `Selection: ${displayName(tree.byKey.get(selection[0])!.props)}` : 'Selection' },
          ]}
          onChange={v => setScope(v as any)}
        />
        <button className="rp-btn" style={{ padding: '0 10px', height: 28 }} onClick={() => setRun(x => x + 1)}>
          <RefreshCw /> Re-run
        </button>
        {fixable.length > 1 && (
          <button
            className="rp-btn"
            style={{ padding: '0 10px', height: 28 }}
            onClick={() => {
              useStore.getState().edit(d => {
                for (const i of fixable) applyProps(d, i.key!, i.fix!.changes);
              });
              setIssues(list => list?.filter(x => !fixable.includes(x)) ?? null);
            }}
          >
            Fix all {fixable.length}
          </button>
        )}
      </div>
      <div className="hint">{issues ? `${issues.length} issue${issues.length === 1 ? '' : 's'} · ${issues.filter(i => i.severity === 'error').length} errors, ${issues.filter(i => i.severity === 'warning').length} warnings` : 'Checking…'}</div>
      <div className="lint-results">
        {issues?.length === 0 && <div className="hint">No problems found.</div>}
        {issues?.map((i, idx) => (
          <div key={idx} className="lint-hit" onClick={() => i.key && show(i.key)}>
            <span className={'sev ' + i.severity}>{i.severity}</span>
            <span>{i.message}</span>
            {i.fix && i.key ? (
              <button
                className="rp-btn"
                style={{ padding: '0 8px' }}
                onClick={e => {
                  e.stopPropagation();
                  fix(i);
                }}
              >
                {i.fix.label}
              </button>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
