// Document tree helpers: lookups, ids, and structural edits on (immer) drafts.
import { isDraft, original } from 'immer';
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

export type DocIndex = NodeIndex & {
  /** Where each node sits: its parent (null at the top) and its place among the parent's children. First one wins for a repeated id, as locate() finds it. */
  at: Map<string, { parent: PenNode | null; index: number }>;
  /** Some id is used by more than one node (a broken file): such an index is always built whole. */
  repeats: boolean;
};

const docIndexes = new WeakMap<object, DocIndex>();

/** A whole index of a document, from one walk over all of it. */
export function buildDocIndex(doc: PenDoc): DocIndex {
  const byId = new Map<string, PenNode>();
  const parentOf = new Map<string, PenNode | null>();
  const components: PenNode[] = [];
  const at: DocIndex['at'] = new Map();
  let count = 0;
  const walk = (nodes: PenNode[] | undefined, parent: PenNode | null) => {
    if (!nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n || typeof n !== 'object') continue;
      count++;
      byId.set(n.id, n);
      parentOf.set(n.id, parent);
      if (!at.has(n.id)) at.set(n.id, { parent, index: i });
      if (n.reusable) components.push(n);
      walk(n.children, n);
    }
  };
  walk(doc.children, null);
  return { byId, parentOf, components, at, repeats: count !== byId.size };
}

/**
 * Turns the index of one version of a document into the index of the next, touching only what changed. An edit
 * keeps every untouched node as the same object, so the two versions are walked side by side and identical parts
 * are skipped. Returns false when the shape differs somewhere (layers added, removed, reordered, a component made
 * or unmade): the index is then half changed and must be thrown away.
 */
function patchDocIndex(idx: DocIndex, oldNodes: PenNode[] | undefined, newNodes: PenNode[] | undefined, oldParent: PenNode | null, newParent: PenNode | null): boolean {
  const reparent = (n: PenNode) => {
    idx.parentOf.set(n.id, newParent);
    const a = idx.at.get(n.id);
    if (a) a.parent = newParent;
  };
  if (oldNodes === newNodes) {
    if (oldParent !== newParent && newNodes) for (const n of newNodes) if (n && typeof n === 'object') reparent(n);
    return true;
  }
  if (!oldNodes || !newNodes) return !oldNodes?.length && !newNodes?.length;
  if (oldNodes.length !== newNodes.length) return false;
  for (let i = 0; i < newNodes.length; i++) {
    const o = oldNodes[i];
    const n = newNodes[i];
    if (o === n) {
      if (oldParent !== newParent && n && typeof n === 'object') reparent(n);
      continue;
    }
    if (!o || !n || typeof o !== 'object' || typeof n !== 'object' || o.id !== n.id || !!o.reusable !== !!n.reusable) return false;
    idx.byId.set(n.id, n);
    reparent(n);
    if (n.reusable) {
      const c = idx.components.indexOf(o);
      if (c < 0) return false;
      // A new list, never the old one changed in place: the layer tree compares the lists to notice a changed component.
      idx.components = idx.components.slice();
      idx.components[c] = n;
    }
    if (!patchDocIndex(idx, o.children, n.children, o, n)) return false;
  }
  return true;
}

/**
 * indexDoc, kept for as long as the document object lives, plus each node's place. Only for documents that are not
 * changed in place (the editor's documents: every edit makes a new one).
 *
 * `replacing`: the version of the document this one took the place of, whose index is no longer needed. Its index
 * is then brought up to date instead of walking the whole document again (8 ms per edit on a 40,000-node design,
 * on every pointer move of a drag). The old version loses its index; it gets a new one if it is ever asked for.
 */
export function docIndex(doc: PenDoc, replacing?: PenDoc | null): DocIndex {
  let idx = docIndexes.get(doc);
  if (idx) return idx;
  const old = replacing && replacing !== doc ? docIndexes.get(replacing) : undefined;
  if (old && !old.repeats) {
    docIndexes.delete(replacing!);
    if (patchDocIndex(old, replacing!.children, doc.children, null, null)) {
      docIndexes.set(doc, old);
      return old;
    }
  }
  idx = buildDocIndex(doc);
  docIndexes.set(doc, idx);
  return idx;
}

export function allIds(doc: PenDoc): Set<string> {
  return new Set(indexDoc(doc).byId.keys());
}

/**
 * The ids in the document an edit STARTED from, without touching the edit copy (walking that makes a working copy
 * of every node). Only right at the start of an edit, before it has added anything; callers add the ids they make.
 */
export function idsAtStart(doc: PenDoc): Set<string> {
  const base = isDraft(doc) ? (original(doc) as PenDoc | undefined) : undefined;
  return base ? new Set(docIndex(base).byId.keys()) : allIds(doc);
}

/** Finds a node and its sibling array inside a (draft) document. */
export function locate(doc: PenDoc, id: string): { node: PenNode; siblings: PenNode[]; index: number; parent: PenNode | null } | null {
  // Inside an edit, `doc` is the edit copy: reading a node of it makes a working copy of that node, so searching
  // from the top made one for every node on the way (all of them, for a layer at the end of a big design; this ran
  // on every pointer move of a drag). The document the edit started from says where the node is: follow only that
  // path. If the edit has already moved things, the node found there is not the one asked for, and we search.
  if (isDraft(doc)) {
    const base = original(doc) as PenDoc | undefined;
    const baseIndex = base ? docIndex(base) : null;
    // With an id used twice (a broken file) "the first one" can change during the edit: search, as before.
    const at = baseIndex && !baseIndex.repeats ? baseIndex.at : null;
    const chain: number[] = [];
    let cur = at?.get(id);
    while (cur) {
      chain.push(cur.index);
      cur = cur.parent ? at!.get(cur.parent.id) : undefined;
      if (chain.length > 512) break;
    }
    if (chain.length && chain.length <= 512) {
      let siblings: PenNode[] | undefined = doc.children;
      let parent: PenNode | null = null;
      let node: PenNode | undefined;
      for (let k = chain.length - 1; k >= 0 && siblings; k--) {
        node = siblings[chain[k]];
        if (!node || typeof node !== 'object') {
          node = undefined;
          break;
        }
        if (k > 0) {
          parent = node;
          siblings = Array.isArray(node.children) ? node.children : undefined;
          if (!siblings) node = undefined;
        }
      }
      if (node && siblings && node.id === id) return { node, siblings, index: chain[0], parent };
    }
  }
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
