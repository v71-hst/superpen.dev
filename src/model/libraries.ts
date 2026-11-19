// UI libraries: other design files a document imports (`imports: { alias: "./kit.spen" }`). Their components can be
// used here as instances with `ref: "alias:<component id>"`, and so can their variables as "$alias:<name>". This
// module is the registry the resolver looks things up in (model/resolve.ts); editor/libraries.ts loads the files.
// pen.dev's format has `imports` but does not say how an imported component is named; "alias:id" is ours (":" can
// never be part of a variable name there, and "/" is taken by instance paths).
import type { PenDoc, PenNode, VariableDef } from './types';

export type Library = {
  alias: string;
  uri: string;
  /** Why it could not be loaded, if it could not. */
  error?: string;
  /** Reusable nodes, with ids and references rewritten into this document's namespace ("alias:id"). */
  components: PenNode[];
  byId: Map<string, PenNode>;
  variables: Record<string, VariableDef>;
};

let libs = new Map<string, Library>();
let epoch = 0;

/** Changes whenever the set of loaded libraries or their content does (caches of resolved trees key on it). */
export function libraryEpoch() {
  return epoch;
}

export function setLibraries(list: Library[]) {
  libs = new Map(list.map(l => [l.alias, l]));
  epoch++;
}

export function libraries(): Library[] {
  return [...libs.values()];
}

const split = (name: string): [string, string] | null => {
  const i = name.indexOf(':');
  return i > 0 ? [name.slice(0, i), name.slice(i + 1)] : null;
};

/** The node a "alias:id" reference names, if that library is loaded and has it. */
export function libraryNode(ref: unknown): PenNode | undefined {
  if (typeof ref !== 'string') return undefined;
  const s = split(ref);
  return s ? libs.get(s[0])?.byId.get(ref) : undefined;
}

/** The definition of an "alias:name" variable. */
export function libraryVariable(name: string): VariableDef | undefined {
  const s = split(name);
  return s ? libs.get(s[0])?.variables[s[1]] : undefined;
}

/**
 * A library file made usable from the importing document: every node id becomes "alias:id", every reference to a
 * node ("ref", slot suggestions) and to a variable ("$name") is pointed at the library's own namespace, so the
 * component brings its nested components and its colours with it.
 */
export function prepareLibrary(alias: string, uri: string, doc: PenDoc): Library {
  const ns = (id: string) => (id.includes(':') ? id : `${alias}:${id}`);
  const value = (v: any): any => {
    if (typeof v === 'string') return v.length > 1 && v[0] === '$' && !v.includes(':') ? `$${alias}:${v.slice(1)}` : v;
    if (Array.isArray(v)) return v.map(value);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, value(x)]));
    return v;
  };
  const byId = new Map<string, PenNode>();
  const components: PenNode[] = [];
  const node = (n: PenNode): PenNode => {
    const out: PenNode = { type: n.type, id: ns(n.id) };
    for (const [k, v] of Object.entries(n)) {
      if (k === 'id' || k === 'type') continue;
      if (k === 'children') out.children = (v as PenNode[]).filter(c => c && typeof c === 'object').map(node);
      else if (k === 'ref') out.ref = typeof v === 'string' ? ns(v) : v;
      else if (k === 'slot') out.slot = Array.isArray(v) ? v.map(x => (typeof x === 'string' ? ns(x) : x)) : v;
      else if (k === 'descendants' && v && typeof v === 'object') {
        // Override paths name nodes of the component the instance points at: those ids are namespaced too.
        out.descendants = Object.fromEntries(Object.entries(v as Record<string, any>).map(([path, o]) => [path.split('/').map(ns).join('/'), o && Array.isArray(o.children) ? { ...value(o), children: o.children.map(node) } : value(o)]));
      } else out[k] = value(v);
    }
    byId.set(out.id, out);
    if (out.reusable) components.push(out);
    return out;
  };
  (doc.children ?? []).filter(c => c && typeof c === 'object').forEach(node);
  const variables: Record<string, VariableDef> = {};
  for (const [name, def] of Object.entries(doc.variables ?? {})) variables[name] = { ...def, value: value(def.value) };
  return { alias, uri, components, byId, variables };
}
