// Sections: named groups of top-level frames stored in the document (`sections`). Frames in a hidden section are not
// rendered at all (no DOM, no bitmap), which keeps huge files light; they stay hidden until the user shows them.
// Agents create sections on request through MCP; the user shows/hides them in the Sections tab.
import { useStore } from './store';
import { allIds, newId } from '../model/doc';
import type { PenDoc } from '../model/types';

export type PenSection = { id: string; name: string; frames: string[]; hidden?: boolean };

export function sectionsOf(doc: PenDoc | null): PenSection[] {
  return Array.isArray(doc?.sections) ? (doc!.sections as PenSection[]) : [];
}

const hiddenCache = new WeakMap<object, Set<string>>();
const NONE = new Set<string>();

/** Ids of top-level frames in hidden sections (cached per `sections` array, which edits replace). */
export function hiddenFrameIds(doc: PenDoc | null): Set<string> {
  const list = doc?.sections;
  if (!Array.isArray(list)) return NONE;
  let set = hiddenCache.get(list);
  if (!set) {
    set = new Set(list.filter((s: PenSection) => s.hidden).flatMap((s: PenSection) => s.frames));
    hiddenCache.set(list, set);
  }
  return set;
}

/** A frame belongs to at most one section: adding it to one removes it from the others. */
function claim(list: PenSection[], frames: string[], owner: PenSection) {
  const ids = new Set(frames);
  for (const s of list) if (s !== owner) s.frames = s.frames.filter(f => !ids.has(f));
}

function topLevelIds(doc: PenDoc): Set<string> {
  return new Set((doc.children ?? []).map(n => n.id));
}

export function createSection(name: string, frames: string[], hidden = false): string {
  let id = '';
  useStore.getState().edit(d => {
    const top = topLevelIds(d);
    const bad = frames.filter(f => !top.has(f));
    if (bad.length) throw new Error(`not top-level frames: ${bad.join(', ')}`);
    id = 's' + newId(allIds(d));
    const list = ((d as any).sections ??= []) as PenSection[];
    const s: PenSection = { id, name, frames: [...new Set(frames)], ...(hidden ? { hidden: true } : {}) };
    claim(list, s.frames, s);
    list.push(s);
  });
  return id;
}

export function updateSection(id: string, change: { name?: string; add?: string[]; remove?: string[]; hidden?: boolean }) {
  useStore.getState().edit(d => {
    const list = sectionsOf(d);
    const s = list.find(x => x.id === id);
    if (!s) throw new Error(`section "${id}" not found (use list_sections)`);
    if (change.name) s.name = change.name;
    if (change.add?.length) {
      const top = topLevelIds(d);
      const bad = change.add.filter(f => !top.has(f));
      if (bad.length) throw new Error(`not top-level frames: ${bad.join(', ')}`);
      s.frames = [...new Set([...s.frames, ...change.add])];
      claim(list, change.add, s);
    }
    if (change.remove?.length) s.frames = s.frames.filter(f => !change.remove!.includes(f));
    if (change.hidden !== undefined) {
      if (change.hidden) s.hidden = true;
      else delete s.hidden;
    }
    (d as any).sections = [...list];
  });
}

export function setSectionHidden(id: string, hidden: boolean) {
  updateSection(id, { hidden });
}

export function setAllSectionsHidden(hidden: boolean) {
  useStore.getState().edit(d => {
    const list = sectionsOf(d);
    for (const s of list) {
      if (hidden) s.hidden = true;
      else delete s.hidden;
    }
    (d as any).sections = [...list];
  });
}

export function deleteSection(id: string) {
  useStore.getState().edit(d => {
    const list = sectionsOf(d);
    const i = list.findIndex(x => x.id === id);
    if (i < 0) throw new Error(`section "${id}" not found (use list_sections)`);
    list.splice(i, 1);
    (d as any).sections = [...list];
    if (!list.length) delete (d as any).sections;
  });
}
