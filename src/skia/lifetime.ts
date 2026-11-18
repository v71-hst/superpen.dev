// CanvasKit objects live in WebAssembly memory and are never garbage-collected: each one must be freed with
// .delete(). Every object the Skia renderer keeps goes through own() / free() (or a Scope for objects used within one
// draw), so diagnose_editor can report the live count and a leak shows up as a growing number.

type Deletable = { delete(): void };

const live = new Map<Deletable, string>();

/** Registers a CanvasKit object under a kind ("path", "paint", "picture", ...) and returns it. */
export function own<T extends Deletable>(obj: T, kind: string): T {
  live.set(obj, kind);
  return obj;
}

/** Deletes an object registered with own(). Safe to call twice, or with null. */
export function free(obj: Deletable | null | undefined) {
  if (!obj || !live.has(obj)) return;
  live.delete(obj);
  try {
    obj.delete();
  } catch {
    // Already deleted by CanvasKit (e.g. its surface was torn down with a lost context).
  }
}

/** Objects created for one piece of work, freed together. */
export class Scope {
  private objs: Deletable[] = [];
  own<T extends Deletable>(obj: T, kind: string): T {
    this.objs.push(own(obj, kind));
    return obj;
  }
  dispose() {
    for (const o of this.objs) free(o);
    this.objs = [];
  }
}

export function liveObjects(): { total: number; byKind: Record<string, number> } {
  const byKind: Record<string, number> = {};
  for (const kind of live.values()) byKind[kind] = (byKind[kind] ?? 0) + 1;
  return { total: live.size, byKind };
}
