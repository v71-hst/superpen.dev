// Variable/theme resolution and expansion of `ref` (component instance) nodes into render trees.
import type { PenDoc, PenNode, RNode, Theme } from './types';
import { indexDoc, type NodeIndex } from './doc';

// ---------- variables & themes ----------

export function defaultTheme(doc: PenDoc): Theme {
  const t: Theme = {};
  for (const [axis, values] of Object.entries(doc.themes ?? {})) if (values?.length) t[axis] = values[0];
  return t;
}

function pickThemed(value: any, theme: Theme): any {
  if (!Array.isArray(value)) return value;
  let best: any = undefined;
  let bestScore = -1;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || !('value' in entry)) continue;
    const cond: Theme = entry.theme ?? {};
    const keys = Object.keys(cond);
    if (keys.every(k => theme[k] === cond[k]) && keys.length >= bestScore) {
      best = entry.value;
      bestScore = keys.length;
    }
  }
  return best;
}

export function resolveVariable(doc: PenDoc, name: string, theme: Theme, depth = 0): any {
  const def = doc.variables?.[name];
  if (!def || depth > 16) return undefined;
  const v = pickThemed(def.value, theme);
  if (typeof v === 'string' && v.startsWith('$')) {
    const inner = resolveVariable(doc, v.slice(1), theme, depth + 1);
    return inner === undefined ? v : inner;
  }
  return v;
}

export function isVarRef(v: any): v is string {
  return typeof v === 'string' && v.length > 1 && v[0] === '$';
}

/** Resolves `$var` references anywhere inside a value (objects/arrays are copied only when needed). */
export function deepResolve(doc: PenDoc, v: any, theme: Theme): any {
  if (isVarRef(v)) {
    const r = resolveVariable(doc, v.slice(1), theme);
    return r === undefined ? v : r;
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map(x => {
      const r = deepResolve(doc, x, theme);
      if (r !== x) changed = true;
      return r;
    });
    return changed ? out : v;
  }
  if (v && typeof v === 'object') {
    let out: any = null;
    for (const k of Object.keys(v)) {
      const r = deepResolve(doc, v[k], theme);
      if (r !== v[k]) {
        out ??= { ...v };
        out[k] = r;
      }
    }
    return out ?? v;
  }
  return v;
}

// ---------- ref expansion ----------

const REF_OWN_SKIP = new Set(['type', 'ref', 'id', 'descendants', 'state']);
const STATE_SKIP = new Set(['id', 'type', 'children', 'reusable', 'states']);

type Overrides = Record<string, any>;

/**
 * A component state (hover, pressed, disabled, ...): property overrides for the component root and for its
 * descendants (keyed by id path, like ref descendants). Stored on the component as `states: { name: ComponentState }`;
 * an instance picks one with `state: "name"`.
 */
export type ComponentState = { root?: Record<string, any>; descendants?: Overrides };

export function stateNames(comp: PenNode | undefined): string[] {
  return comp?.states && typeof comp.states === 'object' ? Object.keys(comp.states) : [];
}

/** Merges state overrides under instance overrides (the instance wins; a whole-node replacement wins outright). */
function mergeDescendants(state: Overrides | undefined, own: Overrides | undefined): Overrides {
  if (!state) return own ?? {};
  const out: Overrides = { ...state };
  for (const [k, v] of Object.entries(own ?? {})) out[k] = v && typeof v === 'object' && !v.type && out[k] && !out[k].type ? { ...out[k], ...v } : v;
  return out;
}

const stateCache = new WeakMap<PenNode, Map<string, PenNode>>();
/** A component node as it looks in one of its states (used to preview and edit that state on the canvas). */
export function withState(node: PenNode, state: string): PenNode {
  const st: ComponentState | undefined = node.states?.[state];
  if (!st) return node;
  let m = stateCache.get(node);
  const hit = m?.get(state);
  if (hit) return hit;
  const out: PenNode = { ...node };
  for (const [k, v] of Object.entries(st.root ?? {})) if (!STATE_SKIP.has(k)) out[k] = v;
  if (node.children && st.descendants) out.children = applyOverrides(node.children, st.descendants, '');
  if (!m) stateCache.set(node, (m = new Map()));
  m.set(state, out);
  return out;
}

/** Builds the plain template tree an instance renders: component content with overrides applied. */
export function materializeRef(ref: PenNode, idx: NodeIndex, visited: Set<string> = new Set()): PenNode | null {
  const comp = idx.byId.get(ref.ref);
  if (!comp || visited.has(comp.id)) return null;
  const nextVisited = new Set(visited).add(comp.id);
  const template = comp.type === 'ref' ? materializeRef(comp, idx, nextVisited) : comp;
  if (!template) return null;
  const st: ComponentState | undefined = typeof ref.state === 'string' && ref.state ? (comp.states ?? template.states)?.[ref.state] : undefined;
  const root: PenNode = { ...template };
  delete root.reusable;
  delete root.states;
  for (const [k, v] of Object.entries(st?.root ?? {})) if (!STATE_SKIP.has(k)) root[k] = v;
  for (const k of Object.keys(ref)) if (!REF_OWN_SKIP.has(k)) root[k] = ref[k];
  root.type = template.type;
  root.id = ref.id;
  if (!('reusable' in ref)) delete root.reusable;
  if (!ref.children && template.children) root.children = applyOverrides(template.children, mergeDescendants(st?.descendants, ref.descendants), '');
  return root;
}

function applyOverrides(children: PenNode[], desc: Overrides, prefix: string): PenNode[] {
  return children.map(c => {
    const p = prefix ? `${prefix}/${c.id}` : c.id;
    const d = desc[p];
    if (d && d.type) return { ...d, id: d.id ?? c.id };
    let n: PenNode = d ? { ...c, ...d } : c;
    if (n.type === 'ref') {
      const nested: Overrides = {};
      const pre = p + '/';
      for (const k of Object.keys(desc)) if (k.startsWith(pre)) nested[k.slice(pre.length)] = desc[k];
      if (Object.keys(nested).length) n = { ...n, descendants: { ...(n.descendants ?? {}), ...nested } };
      return n;
    }
    if (n.children) n = { ...n, children: applyOverrides(n.children, desc, p) };
    return n;
  });
}

function themed(theme: Theme, n: PenNode): Theme {
  return n.theme && typeof n.theme === 'object' ? { ...theme, ...n.theme } : theme;
}

function themeKey(t: Theme) {
  return JSON.stringify(t);
}

function missingRef(n: PenNode): PenNode {
  return { ...n, type: 'missing_ref', width: n.width ?? 100, height: n.height ?? 40 };
}

/** Returns a script node's generated children (null while it is still running or failed). */
export type ScriptProvider = (props: PenNode, theme: Theme, key: string) => PenNode[] | null;

/** Keys of nodes generated by scripts contain this marker; they are rendered but not selectable or editable. */
export const GENERATED_MARK = '/§';
export const isGeneratedKey = (key: string) => key.includes(GENERATED_MARK);

export class TreeBuilder {
  private cache = new WeakMap<PenNode, Map<string, RNode>>();
  private compSig: PenNode[] = [];
  private varsRef: any = undefined;
  private scriptFlags = new WeakMap<PenNode, boolean>();
  /** Bumped when script output arrives; only subtrees containing scripts are rebuilt. */
  scriptEpoch = 0;
  scriptProvider: ScriptProvider | null = null;
  /** A component shown (and edited) in one of its states on the canvas. */
  stateView: { comp: string; state: string } | null = null;
  private stateSig = '';
  idx!: NodeIndex;

  private containsScript(n: PenNode, depth = 0): boolean {
    let f = this.scriptFlags.get(n);
    if (f !== undefined) return f;
    f = n.type === 'script' || (depth < 24 && (n.children ?? []).some(c => c && typeof c === 'object' && this.containsScript(c, depth + 1)));
    if (!f && n.type === 'ref' && depth < 24) {
      const comp = this.idx.byId.get(n.ref);
      f = !!comp && comp !== n && this.containsScript(comp, depth + 1);
    }
    this.scriptFlags.set(n, f);
    return f;
  }

  private generated(n: PenNode, theme: Theme, scriptKey: string, path: string, depth: number): RNode {
    const key = `${scriptKey}/${path}`;
    const src = { kind: 'virtual' as const, instanceId: scriptKey.split('/')[0], path: key.slice(key.indexOf('/') + 1) };
    if (n.type === 'ref') return this.instance(n, themed(theme, n), key, src, scriptKey.split('/')[0], key.slice(key.indexOf('/') + 1), true, scriptKey, depth + 1);
    return {
      key,
      type: n.type,
      props: n,
      src,
      theme,
      children: (n.children ?? []).filter(c => c && typeof c === 'object').map((c, j) => this.generated(c, theme, key, String(c.id ?? `g${j}`).replace(/\//g, '_'), depth)),
      isComponent: false,
      inInstance: true,
      instanceKey: scriptKey,
      generated: true,
    };
  }

  private scriptChildren(n: PenNode, theme: Theme, key: string, depth: number): RNode[] {
    const out = this.scriptProvider?.(n, theme, key);
    if (!out) return [];
    return out.map((c, i) => this.generated(c, theme, key, `§${i}`, depth));
  }

  build(doc: PenDoc, theme: Theme): RNode[] {
    this.idx = indexDoc(doc);
    const comps = this.idx.components;
    // Instances depend on component content, so any component change invalidates cached subtrees.
    // A state preview changes how its component's ancestors render too, so it invalidates cached subtrees.
    const sv = this.stateView ? `${this.stateView.comp}\u0000${this.stateView.state}` : '';
    if (comps.length !== this.compSig.length || comps.some((c, i) => c !== this.compSig[i]) || doc.variables !== this.varsRef || sv !== this.stateSig) {
      this.cache = new WeakMap();
      this.compSig = comps;
      this.varsRef = doc.variables;
      this.stateSig = sv;
    }
    return doc.children.filter(n => n && typeof n === 'object').map(n => this.real(n, theme));
  }

  private real(n: PenNode, parentTheme: Theme): RNode {
    if (this.stateView && n.id === this.stateView.comp) n = withState(n, this.stateView.state);
    const theme = themed(parentTheme, n);
    const tk = themeKey(theme) + (this.containsScript(n) ? `|s${this.scriptEpoch}` : '');
    const hit = this.cache.get(n)?.get(tk);
    if (hit) return hit;
    let r: RNode;
    if (n.type === 'ref') {
      r = this.instance(n, theme, n.id, { kind: 'real', id: n.id }, n.id, '', false, undefined);
    } else {
      r = {
        key: n.id,
        type: n.type,
        props: n,
        src: { kind: 'real', id: n.id },
        theme,
        children: n.type === 'script' ? this.scriptChildren(n, theme, n.id, 0) : (n.children ?? []).filter(c => c && typeof c === 'object').map(c => this.real(c, theme)),
        isComponent: !!n.reusable,
        inInstance: false,
      };
    }
    let m = this.cache.get(n);
    if (!m) this.cache.set(n, (m = new Map()));
    m.set(tk, r);
    return r;
  }

  private instance(
    ref: PenNode,
    theme: Theme,
    key: string,
    src: RNode['src'],
    instanceRealId: string,
    path: string,
    inInstance: boolean,
    instanceKey: string | undefined,
    depth = 0,
  ): RNode {
    const tree = depth < 24 ? materializeRef(ref, this.idx) : null;
    if (!tree) {
      return { key, type: 'missing_ref', props: missingRef(ref), src, theme, children: [], isComponent: false, inInstance, instanceKey };
    }
    const realChildren = !inInstance && Array.isArray(ref.children);
    const children = realChildren
      ? ref.children!.map(c => this.real(c, theme))
      : (tree.children ?? []).map(c => this.virtual(c, theme, key, instanceRealId, path, depth));
    return {
      key,
      type: tree.type,
      props: tree,
      src,
      theme,
      children,
      instanceOf: ref.ref,
      isComponent: !!ref.reusable,
      inInstance,
      instanceKey,
    };
  }

  private virtual(n: PenNode, parentTheme: Theme, instanceKey: string, instanceRealId: string, parentPath: string, depth: number): RNode {
    const theme = themed(parentTheme, n);
    const path = parentPath ? `${parentPath}/${n.id}` : n.id;
    const key = `${instanceRealId}/${path}`;
    const src = { kind: 'virtual' as const, instanceId: instanceRealId, path };
    if (n.type === 'ref') return this.instance(n, theme, key, src, instanceRealId, path, true, instanceKey, depth + 1);
    return {
      key,
      type: n.type,
      props: n,
      src,
      theme,
      children: n.type === 'script' ? this.scriptChildren(n, theme, key, depth) : (n.children ?? []).map(c => this.virtual(c, theme, instanceKey, instanceRealId, path, depth)),
      isComponent: false,
      inInstance: true,
      instanceKey,
    };
  }
}

export function indexTree(roots: RNode[]): { byKey: Map<string, RNode>; parent: Map<string, RNode | null> } {
  const byKey = new Map<string, RNode>();
  const parent = new Map<string, RNode | null>();
  const walk = (nodes: RNode[], p: RNode | null) => {
    for (const n of nodes) {
      byKey.set(n.key, n);
      parent.set(n.key, p);
      walk(n.children, n);
    }
  };
  walk(roots, null);
  return { byKey, parent };
}
