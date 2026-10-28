// Hook that turns the current document into the resolved render tree (with ref expansion).
import { useMemo } from 'react';
import { useStore } from './store';
import { TreeBuilder, defaultTheme, indexTree } from '../model/resolve';
import { onAssetsChanged, setScriptNotifier } from '../render/scripts';
import { scriptState } from './scriptHost';
import type { RNode, Theme } from '../model/types';

const builder = new TreeBuilder();

// Script nodes: look up (or start) their generated output; rebuild affected subtrees when it arrives.
builder.scriptProvider = (props, theme, key) => {
  const state = scriptState(props, theme, key);
  return state?.status === 'ok' ? state.nodes : null;
};
const rebuild = () => {
  builder.scriptEpoch++;
  useStore.setState(s => ({ assetVersion: s.assetVersion + 1 }));
};
setScriptNotifier(rebuild);
onAssetsChanged(rebuild);

export type Tree = {
  roots: RNode[];
  byKey: Map<string, RNode>;
  parent: Map<string, RNode | null>;
  theme: Theme;
};

let last: { doc: any; theme: any; epoch: number; stateView: any; tree: Tree } | null = null;

export function buildTree(doc: any, preview: Theme | null): Tree {
  const stateView = useStore.getState().stateView;
  if (last && last.doc === doc && last.theme === preview && last.epoch === builder.scriptEpoch && last.stateView === stateView) return last.tree;
  const theme = { ...defaultTheme(doc), ...(preview ?? {}) };
  builder.stateView = stateView;
  const roots = builder.build(doc, theme);
  const { byKey, parent } = indexTree(roots);
  const tree = { roots, byKey, parent, theme };
  last = { doc, theme: preview, epoch: builder.scriptEpoch, stateView, tree };
  return tree;
}

export function useTree(): Tree | null {
  const doc = useStore(s => s.doc);
  const preview = useStore(s => s.previewTheme);
  const assetVersion = useStore(s => s.assetVersion);
  const stateView = useStore(s => s.stateView);
  return useMemo(() => (doc ? buildTree(doc, preview) : null), [doc, preview, assetVersion, stateView]);
}

export function currentTree(): Tree | null {
  const s = useStore.getState();
  return s.doc ? buildTree(s.doc, s.previewTheme) : null;
}

// A second builder for documents derived from the current one (e.g. Present mode with hover states applied), so
// they don't evict the editor tree's cache.
const altBuilder = new TreeBuilder();
altBuilder.scriptProvider = builder.scriptProvider;

export function buildDetachedTree(doc: any, preview: Theme | null): Tree {
  altBuilder.scriptEpoch = builder.scriptEpoch;
  const theme = { ...defaultTheme(doc), ...(preview ?? {}) };
  const roots = altBuilder.build(doc, theme);
  const { byKey, parent } = indexTree(roots);
  return { roots, byKey, parent, theme };
}

export function builderIndex() {
  return builder.idx;
}

/** Chain of ancestor keys from the root down to (and including) `key`. */
export function ancestry(tree: Tree, key: string): string[] {
  const out: string[] = [];
  let k: string | undefined = key;
  while (k) {
    out.unshift(k);
    k = tree.parent.get(k)?.key;
  }
  return out;
}
