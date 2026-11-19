// Loads the design files a document imports (see model/libraries.ts) and keeps them current: again whenever the
// document's imports change, a file next to the design changes, or the user asks. The files are read the way
// pictures and scripts are (relative to the design), so it works the same in VS Code and in the browser build.
import { useStore } from './store';
import { makeUrlResolver, parsePen } from './fileio';
import { libraries, prepareLibrary, setLibraries, type Library } from '../model/libraries';
import { log } from './diagnostics';

let loadedFor = '';
let run = 0;

/** A short name for a library file, usable as an alias: letters, digits, dashes. */
export function aliasFor(path: string, taken: string[]): string {
  const base = (path.split('/').pop() ?? 'library').replace(/\.(spen|pen)$/i, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'library';
  let alias = base;
  for (let i = 2; taken.includes(alias); i++) alias = `${base}-${i}`;
  return alias;
}

/** Reads every import of the open document. `force`: even if nothing about the imports changed (the files may have). */
export async function syncLibraries(force = false) {
  const s = useStore.getState();
  const imports = Object.entries(s.doc?.imports ?? {}).filter(([a, u]) => typeof u === 'string' && u && !a.includes(':') && !a.includes('/')) as [string, string][];
  const sig = JSON.stringify([s.file?.path ?? null, imports]);
  if (!force && sig === loadedFor) return;
  loadedFor = sig;
  if (!imports.length && !libraries().length) return;
  const mine = ++run;
  const resolve = makeUrlResolver(s.file?.path ?? null);
  const list: Library[] = await Promise.all(
    imports.map(async ([alias, uri]) => {
      try {
        const r = await fetch(resolve(uri), { cache: 'no-store' });
        if (!r.ok) throw new Error(`could not read ${uri} (${r.status})`);
        return prepareLibrary(alias, uri, parsePen(await r.text()));
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        log('warn', `Library "${alias}" did not load`, error);
        return { alias, uri, error, components: [], byId: new Map(), variables: {} };
      }
    }),
  );
  if (mine !== run) return; // a newer load is under way
  setLibraries(list);
  // The canvas resolves instances again.
  useStore.setState(st => ({ assetVersion: st.assetVersion + 1 }));
}

/** Adds an import to the document (or returns the alias it already has) and loads it. */
export function addLibrary(uri: string): string {
  const s = useStore.getState();
  const rel = uri.startsWith('.') || /^[a-z]+:/i.test(uri) ? uri : './' + uri;
  const existing = Object.entries(s.doc?.imports ?? {}).find(([, u]) => u === rel);
  if (existing) return existing[0];
  const alias = aliasFor(rel, Object.keys(s.doc?.imports ?? {}));
  s.edit(d => {
    d.imports = { ...(d.imports ?? {}), [alias]: rel };
  });
  void syncLibraries();
  return alias;
}

export function removeLibrary(alias: string) {
  useStore.getState().edit(d => {
    if (!d.imports) return;
    const { [alias]: _, ...rest } = d.imports;
    if (Object.keys(rest).length) d.imports = rest;
    else delete d.imports;
  });
  void syncLibraries();
}

/** Starts keeping libraries in step with the store; returns how to stop. */
export function installLibraries(): () => void {
  let lastImports: unknown = undefined;
  let lastPath: unknown = undefined;
  const check = () => {
    const s = useStore.getState();
    if (s.doc?.imports === lastImports && s.file?.path === lastPath) return;
    lastImports = s.doc?.imports;
    lastPath = s.file?.path;
    void syncLibraries();
  };
  check();
  const off = useStore.subscribe(check);
  // Coming back to the window: a library edited in another tab or program is picked up.
  const focus = () => void syncLibraries(true);
  window.addEventListener('focus', focus);
  return () => {
    off();
    window.removeEventListener('focus', focus);
  };
}
