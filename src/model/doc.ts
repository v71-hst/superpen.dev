// Document tree helpers: lookups, ids, and structural edits on (immer) drafts.
import type { PenDoc, PenNode } from './types';

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function newId(existing?: Set<string>): string {
  for (;;) {
    let id = '';
    for (let i = 0; i < 5; i++) id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    if (!existing?.has(id)) return id;
  }
}

export type NodeIndex = {
  byId: Map<string, PenNode>;
  parentOf: Map<string, PenNode | null>;
  components: PenNode[];
};

export function indexDoc(doc: PenDoc): NodeIndex {
  const byId = new Map<string, PenNode>();
  const parentOf = new Map<string, PenNode | null>();
  const components: PenNode[] = [];
  const walk = (nodes: PenNode[] | undefined, parent: PenNode | null) => {
    if (!nodes) return;
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      byId.set(n.id, n);
      parentOf.set(n.id, parent);
      if (n.reusable) components.push(n);
      walk(n.children, n);
    }
  };
  walk(doc.children, null);
  return { byId, parentOf, components };
}

export function allIds(doc: PenDoc): Set<string> {
  return new Set(indexDoc(doc).byId.keys());
}

/** Finds a node and its sibling array inside a (draft) document. */
export function locate(doc: PenDoc, id: string): { node: PenNode; siblings: PenNode[]; index: number; parent: PenNode | null } | null {
  const walk = (nodes: PenNode[], parent: PenNode | null): ReturnType<typeof locate> => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { node: n, siblings: nodes, index: i, parent };
      if (n.children) {
        const r = walk(n.children, n);
        if (r) return r;
      }
    }
    return null;
  };
  return walk(doc.children, null);
}

export function isAncestor(doc: PenDoc, ancestorId: string, id: string): boolean {
  const idx = indexDoc(doc);
  let p = idx.parentOf.get(id);
  while (p) {
    if (p.id === ancestorId) return true;
    p = idx.parentOf.get(p.id) ?? null;
  }
  return false;
}

/** Deep-copies a subtree giving every node a fresh id (refs to copied components are remapped). */
export function cloneWithNewIds(node: PenNode, existing: Set<string>): PenNode {
  // Ids are assigned per node (not per old id string), so missing or duplicate ids can't collapse into one.
  const map = new Map<string, string>();
  const copy: PenNode = JSON.parse(JSON.stringify(node));
  const refs: PenNode[] = [];
  const assign = (n: PenNode) => {
    const id = newId(existing);
    existing.add(id);
    if (n.id && !map.has(n.id)) map.set(n.id, id);
    n.id = id;
    if (n.type === 'ref') refs.push(n);
    n.children?.forEach(assign);
  };
  assign(copy);
  for (const r of refs) if (map.has(r.ref)) r.ref = map.get(r.ref);
  return copy;
}

export function displayName(n: PenNode): string {
  if (n.name) return n.name;
  if (n.type === 'text' && typeof n.content === 'string') return n.content.slice(0, 40) || 'Text';
  const t = n.type === 'ref' ? 'Instance' : n.type;
  return t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ');
}
