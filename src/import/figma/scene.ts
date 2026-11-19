// Turns the flat list of node changes in a Figma message into a tree, and expands component instances.
//
// A .fig file does not store what is inside an instance. It stores a link to the main component (`symbolData`),
// the overrides the user made (`symbolOverrides`, addressed by a path of ids), values for component properties
// (`componentPropAssignments`) and the sizes and positions Figma worked out for the instance's layers
// (`derivedSymbolData`). `instanceChildren` rebuilds the layers from those, the way Figma's "detach instance" does.
import type { FigMessage } from './container';
import type { Notes } from './paints';
import { applySharedStyles, guidKey, linksStyle } from './styles';

export { guidKey };

/** A Figma node: the decoded NodeChange plus the tree links added here. */
export type FNode = {
  guid?: { sessionID: number; localID: number };
  type?: string;
  name?: string;
  /** Children in layer order (bottom first), which is also the order auto layout places them in. */
  kids: FNode[];
  /** Stable id for the .pen node made from this one. */
  pid: string;
  /** Set on copies made while expanding an instance: overrides and derived layout meant for deeper instances. */
  passedOverrides?: any[];
  passedDerived?: any[];
  [key: string]: any;
};

export type Scene = {
  pages: FNode[];
  /** Pages Figma keeps for its own use (they hold copies of components from other files). */
  internalPages: FNode[];
  blobs: (Uint8Array | undefined)[];
  /** Nodes by guid, and by override key where one is set. */
  byKey: Map<string, FNode>;
  /** Shared styles, variables and variable collections by their library key. */
  byAssetKey: Map<string, FNode>;
  /** Component property definitions: local id -> the id it stands for in the component set. */
  propParent: Map<string, string>;
  refsCache: Map<FNode, PropRef[]>;
  /**
   * True when the file was written by a Figma that stores padding per side. Then a missing right / bottom padding
   * means 0; in older files it means "same as left / top".
   */
  paddingPerSide: boolean;
};

type PropRef = { def: string; field: string; node: string };

const INVALID = 0xffffffff;

const validGuid = (g: any) => !!g && typeof g.sessionID === 'number' && !(g.sessionID === INVALID && g.localID === INVALID);

/** The id other nodes use to address this one in override paths. */
function addressOf(n: FNode): string {
  return validGuid(n.overrideKey) ? guidKey(n.overrideKey) : guidKey(n.guid);
}

const idOf = (key: string) => 'f' + key.replace(':', '-');

export function buildScene(message: FigMessage, fields: ReadonlySet<string> = new Set()): Scene {
  const byKey = new Map<string, FNode>();
  const nodes: FNode[] = [];
  for (const raw of message.nodeChanges ?? []) {
    if (!raw || !raw.guid || raw.phase === 'REMOVED') continue;
    const n = raw as FNode;
    n.kids = [];
    n.pid = idOf(guidKey(n.guid));
    byKey.set(guidKey(n.guid), n);
    nodes.push(n);
  }
  let root: FNode | undefined;
  for (const n of nodes) {
    if (n.type === 'DOCUMENT' && !root) root = n;
    const parent = n.parentIndex ? byKey.get(guidKey(n.parentIndex.guid)) : undefined;
    if (parent && parent !== n) parent.kids.push(n);
  }
  const position = (n: FNode) => String(n.parentIndex?.position ?? '');
  for (const n of nodes) {
    if (n.kids.length > 1) n.kids.sort((a, b) => (position(a) < position(b) ? -1 : position(a) > position(b) ? 1 : 0));
  }
  // Override keys are a second address for a node; real guids win when both exist.
  for (const n of nodes) {
    if (validGuid(n.overrideKey)) {
      const k = guidKey(n.overrideKey);
      if (!byKey.has(k)) byKey.set(k, n);
    }
  }
  const byAssetKey = new Map<string, FNode>();
  for (const n of nodes) if (typeof n.key === 'string' && n.key && !byAssetKey.has(n.key)) byAssetKey.set(n.key, n);
  const propParent = new Map<string, string>();
  for (const n of nodes) {
    for (const d of n.componentPropDefs ?? []) {
      if (d && validGuid(d.id) && validGuid(d.parentPropDefId)) propParent.set(guidKey(d.id), guidKey(d.parentPropDefId));
    }
  }
  const canvases = root ? root.kids.filter(n => n.type === 'CANVAS') : nodes.filter(n => n.type === 'CANVAS');
  const scene: Scene = {
    pages: canvases.filter(c => c.internalOnly !== true),
    internalPages: canvases.filter(c => c.internalOnly === true),
    blobs: (message.blobs ?? []).map(b => b?.bytes),
    byKey,
    byAssetKey,
    propParent,
    refsCache: new Map(),
    paddingPerSide: fields.has('NodeChange.stackPaddingRight'),
  };
  // Layers that use a shared style show the style's values, not their own (possibly stale) copies.
  for (const n of nodes) if (!n.styleType && linksStyle(n)) applySharedStyles(scene, n);
  return scene;
}

// ---------- instances ----------

function pathOf(o: any): string[] {
  const guids = o?.guidPath?.guids;
  return Array.isArray(guids) ? guids.map(guidKey) : [];
}

/** Where a main component's layers use component properties (not looking inside nested instances). */
function propRefs(scene: Scene, master: FNode): PropRef[] {
  let refs = scene.refsCache.get(master);
  if (refs) return refs;
  refs = [];
  const walk = (n: FNode) => {
    for (const r of n.componentPropRefs ?? []) {
      if (!r || r.isDeleted === true || !validGuid(r.defID) || typeof r.componentPropNodeField !== 'string') continue;
      refs!.push({ def: guidKey(r.defID), field: r.componentPropNodeField, node: addressOf(n) });
    }
    for (const c of n.kids) walk(c);
  };
  for (const c of master.kids) walk(c);
  scene.refsCache.set(master, refs);
  return refs;
}

/** The value a property assignment gives to a layer field (older files use `value`, newer ones `varValue`). */
function assignmentValue(a: any, field: string): { key: string; value: any } | null {
  const v = a?.value ?? {};
  const vv = a?.varValue?.value ?? {};
  if (field === 'VISIBLE') {
    const b = typeof v.boolValue === 'boolean' ? v.boolValue : typeof vv.boolValue === 'boolean' ? vv.boolValue : undefined;
    return b === undefined ? null : { key: 'visible', value: b };
  }
  if (field === 'TEXT_DATA') {
    const t = v.textValue ?? vv.textDataValue;
    return t && typeof t.characters === 'string' ? { key: 'textData', value: t } : null;
  }
  if (field === 'OVERRIDDEN_SYMBOL_ID') {
    const g = validGuid(v.guidValue) ? v.guidValue : validGuid(vv.symbolIdValue?.guid) ? vv.symbolIdValue.guid : validGuid(vv.symbolIdValue) ? vv.symbolIdValue : undefined;
    return g ? { key: 'overriddenSymbolID', value: g } : null;
  }
  return null;
}

/** Properties of an instance layer that stay its own when its main component is swapped for another. */
const KEPT_ON_SWAP = [
  'guid', 'parentIndex', 'type', 'name', 'visible', 'locked', 'transform', 'size', 'opacity', 'kids', 'pid',
  'stackPositioning', 'stackChildPrimaryGrow', 'stackChildAlignSelf', 'horizontalConstraint', 'verticalConstraint',
  'componentPropRefs', 'componentPropAssignments', 'overrideKey', 'passedOverrides', 'passedDerived', 'mask', 'maskType',
];

function swapMaster(scene: Scene, node: FNode, to: any) {
  const master = scene.byKey.get(guidKey(to));
  if (!master || master.type !== 'SYMBOL') return;
  const kept: any = {};
  for (const k of KEPT_ON_SWAP) if (k in node) kept[k] = node[k];
  for (const k of Object.keys(node)) delete node[k];
  Object.assign(node, master, kept);
  for (const k of ['componentPropDefs', 'isSymbolPublishable', 'sharedSymbolVersion', 'publishedVersion', 'symbolDescription', 'isStateGroup']) delete node[k];
  node.type = 'INSTANCE';
  // The new main component's own layers have no overrides from the old one.
  node.symbolData = { symbolID: to, symbolOverrides: [] };
  node.derivedSymbolData = [];
}

function mergeAssignments(base: any[] | undefined, extra: any[]): any[] {
  const out = (base ?? []).slice();
  for (const a of extra) {
    const k = guidKey(a?.defID);
    const i = out.findIndex(b => guidKey(b?.defID) === k);
    if (i >= 0) out[i] = a;
    else out.push(a);
  }
  return out;
}

/** Applies overrides (already known to address this node, lowest priority first) to a copy of a layer. */
function applyOverrides(scene: Scene, node: FNode, list: any[]) {
  // A swap of the main component first, so that the other overridden properties land on the new component's layer.
  let swap: any;
  for (const o of list) if (validGuid(o.overriddenSymbolID)) swap = o.overriddenSymbolID;
  if (swap && node.type === 'INSTANCE' && guidKey(swap) !== guidKey(node.symbolData?.symbolID)) swapMaster(scene, node, swap);
  for (const o of list) {
    for (const k of Object.keys(o)) {
      if (SKIPPED_IN_OVERRIDES.has(k)) continue;
      if (k === 'componentPropAssignments') {
        if (Array.isArray(o[k])) node.componentPropAssignments = mergeAssignments(node.componentPropAssignments, o[k]);
        continue;
      }
      node[k] = o[k];
    }
    // An override that links a shared style means the style's values, whatever copy came with it.
    if (linksStyle(o)) applySharedStyles(scene, node, o);
  }
}

const SKIPPED_IN_OVERRIDES = new Set(['guidPath', '__path', 'overriddenSymbolID', 'guid', 'parentIndex', 'type']);

export type Expanded = { children: FNode[]; master: FNode | null };

/**
 * The layers inside an instance: copies of its main component's layers with overrides, property values and
 * derived layout applied. Nested instances are returned unexpanded, carrying what was addressed to their insides.
 */
export function instanceChildren(scene: Scene, inst: FNode, notes: Notes): Expanded {
  const symbolID = inst.symbolData?.symbolID;
  const master = validGuid(symbolID) ? scene.byKey.get(guidKey(symbolID)) : undefined;
  if (!master || master === inst) {
    notes.add('instances whose main component is not in the file (left empty)');
    return { children: [], master: null };
  }
  const rootKey = addressOf(master);
  const rootGuid = guidKey(master.guid);

  // Lowest priority first: what the main component's own nested instances say, then what outer instances said
  // about this one, then component properties (a layer bound to a property always shows the property's value).
  const overrides: any[] = [...(inst.symbolData?.symbolOverrides ?? []), ...(inst.passedOverrides ?? [])];
  const assigned = inst.componentPropAssignments;
  if (Array.isArray(assigned) && assigned.length) {
    const refs = propRefs(scene, master);
    const canon = (k: string) => scene.propParent.get(k) ?? k;
    for (const a of assigned) {
      if (!validGuid(a?.defID)) continue;
      const def = guidKey(a.defID);
      for (const r of refs) {
        if (r.def !== def && canon(r.def) !== canon(def)) continue;
        const v = assignmentValue(a, r.field);
        if (v) overrides.push({ guidPath: { guids: [r.node] }, __path: [r.node], [v.key]: v.value });
      }
    }
  }
  const derived: any[] = [...(inst.derivedSymbolData ?? []), ...(inst.passedDerived ?? [])];

  const index = (list: any[]) => {
    const map = new Map<string, { path: string[]; o: any }[]>();
    for (const o of list) {
      const path: string[] = o.__path ?? pathOf(o);
      if (!path.length) continue;
      const first = path[0];
      let bucket = map.get(first);
      if (!bucket) map.set(first, (bucket = []));
      bucket.push({ path, o });
    }
    return map;
  };
  const ovIndex = index(overrides);
  const dvIndex = index(derived);

  const copy = (m: FNode): FNode => {
    const c: FNode = { ...m, kids: m.kids, pid: `${inst.pid}_${guidKey(m.guid).replace(':', '-')}` };
    delete c.passedOverrides;
    delete c.passedDerived;
    const address = addressOf(m);
    const guid = guidKey(m.guid);
    const collect = (map: Map<string, { path: string[]; o: any }[]>) => {
      const a = map.get(address) ?? [];
      return address !== guid && map.has(guid) ? [...a, ...map.get(guid)!] : a;
    };
    let passedOverrides: any[] | undefined;
    let passedDerived: any[] | undefined;
    const own: any[] = [];
    for (const { path, o } of collect(ovIndex)) {
      if (path.length === 1) own.push(o);
      else (passedOverrides ??= []).push({ ...o, __path: path.slice(1) });
    }
    if (own.length) applyOverrides(scene, c, own);
    for (const { path, o } of collect(dvIndex)) {
      if (path.length === 1) {
        for (const k of Object.keys(o)) if (k !== 'guidPath' && k !== '__path') c[k] = o[k];
      } else (passedDerived ??= []).push({ ...o, __path: path.slice(1) });
    }
    if (c.type === 'INSTANCE') {
      // Expanded later, when this layer is converted; until then it keeps what was meant for its insides.
      if (passedOverrides) c.passedOverrides = passedOverrides;
      if (passedDerived) c.passedDerived = passedDerived;
      c.kids = [];
    } else {
      c.kids = m.kids.map(copy);
    }
    return c;
  };

  // Overrides addressed to the main component itself describe the instance layer. A top-level instance already
  // carries those values; for a nested one they arrive from outside and are applied here.
  for (const key of rootKey === rootGuid ? [rootKey] : [rootKey, rootGuid]) {
    for (const { path, o } of (inst.passedOverrides ?? []).map(o => ({ path: (o.__path ?? pathOf(o)) as string[], o }))) {
      if (path.length === 1 && path[0] === key) {
        for (const k of Object.keys(o)) if (!SKIPPED_IN_OVERRIDES.has(k) && k !== 'componentPropAssignments') inst[k] = o[k];
        if (linksStyle(o)) applySharedStyles(scene, inst, o);
      }
    }
    for (const { path, o } of (inst.passedDerived ?? []).map(o => ({ path: (o.__path ?? pathOf(o)) as string[], o }))) {
      if (path.length === 1 && path[0] === key) {
        for (const k of Object.keys(o)) if (k !== 'guidPath' && k !== '__path') inst[k] = o[k];
      }
    }
  }

  return { children: master.kids.map(copy), master };
}
