// Right panel sections for component states, instance state and prototype links.
import React, { useState } from 'react';
import { X } from 'lucide-react';
import { useStore, keySource } from '../editor/store';
import { builderIndex, useTree } from '../editor/tree';
import { stateNames } from '../model/resolve';
import { displayName, locate } from '../model/doc';
import type { RNode } from '../model/types';
import { Select } from './common';
import { Section } from './RightPanel';

const PRESETS = ['hover', 'pressed', 'disabled', 'focused', 'selected'];

/** States of a component: pick one to preview it on the canvas; edits made while it is shown go into that state. */
export function StatesSection({ n }: { n: RNode }) {
  const doc = useStore(s => s.doc);
  const stateView = useStore(s => s.stateView);
  const [name, setName] = useState('');
  const comp = doc && keySource(n.key).kind === 'real' ? locate(doc, n.key)?.node : undefined;
  if (!comp?.reusable) return null;
  const names = stateNames(comp);
  const active = stateView?.comp === n.key ? stateView.state : null;
  const show = (state: string | null) => useStore.setState({ stateView: state ? { comp: n.key, state } : null });
  const add = (raw: string) => {
    const s = raw.trim();
    if (!s || names.includes(s)) return show(s || null);
    useStore.getState().edit(d => {
      const c = locate(d, n.key)?.node;
      if (c) (c.states ??= {})[s] = {};
    });
    setName('');
    show(s);
  };
  const remove = (s: string) => {
    useStore.getState().edit(d => {
      const c = locate(d, n.key)?.node;
      if (!c?.states) return;
      delete c.states[s];
      if (!Object.keys(c.states).length) delete c.states;
    });
    if (active === s) show(null);
  };
  return (
    <Section title="States">
      <div className="state-chips">
        <button className={'state-chip' + (active ? '' : ' on')} onClick={() => show(null)}>
          Default
        </button>
        {names.map(s => (
          <span key={s} className={'state-chip' + (active === s ? ' on' : '')} onClick={() => show(s)}>
            {s}
            <button
              className="state-chip-x"
              title={`Delete state "${s}"`}
              onClick={e => {
                e.stopPropagation();
                remove(s);
              }}
            >
              <X />
            </button>
          </span>
        ))}
      </div>
      <div className="state-add">
        <input
          className="text-input"
          placeholder="New state…"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Enter') add(name);
          }}
        />
        {PRESETS.filter(p => !names.includes(p))
          .slice(0, 3)
          .map(p => (
            <button key={p} className="rp-btn" onClick={() => add(p)}>
              + {p}
            </button>
          ))}
      </div>
      {active && <div className="hint">Editing “{active}”: changes to this component are saved to the state, not the default look.</div>}
    </Section>
  );
}

/** Which state an instance shows. */
export function InstanceStateSection({ n, set }: { n: RNode; set: (c: Record<string, any>) => void }) {
  if (!n.instanceOf) return null;
  const names = stateNames(builderIndex()?.byId.get(n.instanceOf));
  if (!names.length) return null;
  const cur = typeof n.props.state === 'string' ? n.props.state : '';
  return (
    <Section title="State">
      <Select value={cur || '__default'} options={[{ value: '__default', label: 'Default' }, ...names.map(s => ({ value: s, label: s }))]} onChange={v => set({ state: v === '__default' ? undefined : v })} />
      <div className="hint">In Present mode, “hover” and “pressed” states play automatically.</div>
    </Section>
  );
}

export const TRANSITIONS = [
  { value: 'instant', label: 'Instant' },
  { value: 'dissolve', label: 'Dissolve' },
  { value: 'slide-left', label: 'Slide left' },
  { value: 'slide-right', label: 'Slide right' },
  { value: 'slide-up', label: 'Slide up' },
  { value: 'slide-down', label: 'Slide down' },
] as const;

/** Prototype link: clicking this node in Present mode goes to another top-level frame. */
export function PrototypeSection({ n, set }: { n: RNode; set: (c: Record<string, any>) => void }) {
  const tree = useTree();
  if (!tree) return null;
  const link = n.props.link && typeof n.props.link === 'object' ? n.props.link : null;
  const frames = tree.roots.filter(r => r.key !== n.key && r.props.enabled !== false);
  const to = link?.to ?? '';
  return (
    <Section title="Prototype" collapsible={!link}>
      <div className="row2">
        <Select
          value={to || '__none'}
          title="On click, go to"
          options={[{ value: '__none', label: 'No link' }, { value: '__back', label: '← Back' }, ...frames.map(f => ({ value: f.key, label: displayName(f.props) }))]}
          onChange={v => set({ link: v === '__none' ? undefined : { ...(link ?? { transition: 'dissolve' }), to: v } })}
        />
        {link && <Select value={link.transition ?? 'instant'} title="Transition" options={TRANSITIONS.map(t => ({ ...t }))} onChange={v => set({ link: { ...link, transition: v } })} />}
      </div>
      {link && to !== '__back' && !tree.byKey.has(to) && <div className="hint" style={{ color: 'var(--danger, #e5484d)' }}>The target frame no longer exists.</div>}
      {link && <div className="hint">Click this layer in Present mode to follow the link.</div>}
    </Section>
  );
}
