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

let last: { doc: any; theme: any; epoch: number; tree: Tree } | null = null;

export function buildTree(doc: any, preview: Theme | null): Tree {
  if (last && last.doc === doc && last.theme === preview && last.epoch === builder.scriptEpoch) return last.tree;
  const theme = { ...defaultTheme(doc), ...(preview ?? {}) };
  const roots = builder.build(doc, theme);
  const { byKey, parent } = indexTree(roots);
  const tree = { roots, byKey, parent, theme };
  last = { doc, theme: preview, epoch: builder.scriptEpoch, tree };
  return tree;
}

export function useTree(): Tree | null {
  const doc = useStore(s => s.doc);
  const preview = useStore(s => s.previewTheme);
  const assetVersion = useStore(s => s.assetVersion);
  return useMemo(() => (doc ? buildTree(doc, preview) : null), [doc, preview, assetVersion]);
}

export function currentTree(): Tree | null {
  const s = useStore.getState();
  return s.doc ? buildTree(s.doc, s.previewTheme) : null;
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
