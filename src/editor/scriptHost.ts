// Resolves a script node's request (file URL, inputs with variables resolved, size) for the script runtime.
import type { PenNode, Theme } from '../model/types';
import { deepResolve } from '../model/resolve';
import { scriptOutput, type ScriptState } from '../render/scripts';
import { makeUrlResolver } from './fileio';
import { useStore } from './store';

export function scriptState(props: PenNode, theme: Theme, key: string): ScriptState | null {
  const s = useStore.getState();
  if (!s.doc || typeof props.scriptUri !== 'string' || !props.scriptUri) return null;
  const num = (v: any, d: number) => (typeof v === 'number' ? v : d);
  return scriptOutput({
    key,
    url: makeUrlResolver(s.file?.path ?? null)(props.scriptUri),
    inputs: deepResolve(s.doc, props.inputs ?? {}, theme),
    width: num(deepResolve(s.doc, props.width, theme), 200),
    height: num(deepResolve(s.doc, props.height, theme), 200),
  });
}
