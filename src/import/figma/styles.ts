// Shared styles and variables.
//
// A layer that uses a shared style keeps a copy of the style's values next to the link, and that copy can be out
// of date; Figma draws what the style says. A colour bound to a variable also keeps a copy of the colour, which is
// wrong when the layer sits somewhere that uses another mode of the variable (a "dark" frame, for example), most
// often for layers inside instances. Both are looked up here so that the import shows what Figma shows.
import type { FNode, Scene } from './scene';

export function guidKey(g: any): string {
  return g && typeof g.sessionID === 'number' ? `${g.sessionID}:${g.localID}` : '';
}

const INVALID = 0xffffffff;
const validGuid = (g: any) => !!g && typeof g.sessionID === 'number' && !(g.sessionID === INVALID && g.localID === INVALID);

/** Finds what a style / variable / collection reference points at: a node in this file, by id or by library key. */
export function referenced(scene: Scene, ref: any): FNode | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  if (validGuid(ref.guid)) return scene.byKey.get(guidKey(ref.guid));
  if (typeof ref.assetRef?.key === 'string') return scene.byAssetKey.get(ref.assetRef.key);
  if (validGuid(ref)) return scene.byKey.get(guidKey(ref)); // older files store the bare id
  return undefined;
}

const TEXT_STYLE_PROPS = ['fontSize', 'fontName', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'paragraphSpacing', 'paragraphIndent'];

const FILL_LINKS = ['styleIdForFill', 'inheritFillStyleID'];
const STROKE_LINKS = ['styleIdForStrokeFill', 'inheritFillStyleIDForStroke'];
const EFFECT_LINKS = ['styleIdForEffect', 'inheritEffectStyleID'];
const TEXT_LINKS = ['styleIdForText', 'inheritTextStyleID'];

/** True when an object (a node or an override) links any shared style. */
export function linksStyle(o: any): boolean {
  return [...FILL_LINKS, ...STROKE_LINKS, ...EFFECT_LINKS, ...TEXT_LINKS].some(k => o[k] !== undefined);
}

/**
 * Replaces a layer's copies of shared-style values with what the styles say now. `only` limits this to the kinds
 * of style that the given object (an override) links. Safe to call more than once.
 */
export function applySharedStyles(scene: Scene, n: any, only?: any) {
  const wanted = (links: string[]) => !only || links.some(k => only[k] !== undefined);
  if (wanted(FILL_LINKS)) {
    const fill = referenced(scene, n.styleIdForFill ?? n.inheritFillStyleID);
    if (fill && fill.styleType === 'FILL' && Array.isArray(fill.fillPaints)) n.fillPaints = fill.fillPaints;
  }
  if (wanted(STROKE_LINKS)) {
    const stroke = referenced(scene, n.styleIdForStrokeFill ?? n.inheritFillStyleIDForStroke);
    if (stroke && stroke.styleType === 'FILL' && Array.isArray(stroke.fillPaints)) n.strokePaints = stroke.fillPaints;
  }
  if (wanted(EFFECT_LINKS)) {
    const effect = referenced(scene, n.styleIdForEffect ?? n.inheritEffectStyleID);
    if (effect && effect.styleType === 'EFFECT' && Array.isArray(effect.effects)) n.effects = effect.effects;
  }
  if (wanted(TEXT_LINKS)) {
    const text = referenced(scene, n.styleIdForText ?? n.inheritTextStyleID);
    if (text && text.styleType === 'TEXT') {
      for (const k of TEXT_STYLE_PROPS) {
        if (text[k] !== undefined) n[k] = text[k];
        else delete n[k];
      }
    }
  }
}

// ---------- variables ----------

/** Variable modes in force at some point of the tree: collection (by node id) -> mode id. */
export type ModeScope = { modes: Map<string, string>; parent: ModeScope | null };

export function modeScope(scene: Scene, n: any, parent: ModeScope | null): ModeScope | null {
  const entries = n?.variableModeBySetMap?.entries;
  if (!Array.isArray(entries) || !entries.length) return parent;
  const modes = new Map<string, string>();
  for (const e of entries) {
    const set = referenced(scene, e?.variableSetID);
    if (set && validGuid(e.variableModeID)) modes.set(guidKey(set.guid), guidKey(e.variableModeID));
  }
  return modes.size ? { modes, parent } : parent;
}

function modeFor(scope: ModeScope | null, set: FNode): string | undefined {
  const id = guidKey(set.guid);
  for (let s = scope; s; s = s.parent) {
    const m = s.modes.get(id);
    if (m !== undefined) return m;
  }
  // No layer above chooses a mode: the collection's first mode is the default.
  const list: any[] = Array.isArray(set.variableSetModes) ? set.variableSetModes.slice() : [];
  list.sort((a, b) => (String(a?.sortPosition ?? '') < String(b?.sortPosition ?? '') ? -1 : String(a?.sortPosition ?? '') > String(b?.sortPosition ?? '') ? 1 : 0));
  return list.length && validGuid(list[0].id) ? guidKey(list[0].id) : undefined;
}

/** The colour a variable binding stands for where the layer is, or null when it cannot be worked out from the file. */
export function variableColor(scene: Scene, binding: any, scope: ModeScope | null, depth = 0): { r: number; g: number; b: number; a: number } | null {
  if (depth > 8) return null;
  const value = binding?.value;
  if (!value) return null;
  if (value.colorValue && typeof value.colorValue.r === 'number') return value.colorValue;
  const variable = referenced(scene, value.alias);
  if (!variable || variable.type !== 'VARIABLE') return null;
  const entries: any[] = variable.variableDataValues?.entries;
  if (!Array.isArray(entries) || !entries.length) return null;
  const set = referenced(scene, variable.variableSetID);
  const mode = set ? modeFor(scope, set) : undefined;
  const entry = (mode !== undefined ? entries.find(e => guidKey(e?.modeID) === mode) : undefined) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!entry) return null;
  return variableColor(scene, entry.variableData, scope, depth + 1);
}
