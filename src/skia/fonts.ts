// Fonts for Skia text. CanvasKit cannot see the browser's fonts, so font files are fetched and registered with one
// TypefaceFontProvider: Google Fonts families on demand (each @font-face subset of a family is registered under its
// own alias, so a paragraph's family list falls back through the subsets), and Inter bundled with the extension so
// text always draws. A family that cannot be fetched makes the frames using it fall back to the DOM renderer.
import type { CanvasKit, TypefaceFontProvider } from 'canvaskit-wasm';
import { own } from './lifetime';
import { weightNum } from '../render/fonts';

export const DEFAULT_FAMILY = 'Inter';
const BUNDLED_PREFIX = 'Inter (bundled)';

type FamilyState = { status: 'loading' | 'ready' | 'failed'; aliases: string[]; error?: string };

let provider: TypefaceFontProvider | null = null;
let ck: CanvasKit | null = null;
const families = new Map<string, FamilyState>(); // key: family|weight|italic
const aliasesByFamily = new Map<string, Set<string>>(); // family -> registered aliases (all weights)
let bundled: Promise<void> | null = null;
let epoch = 0;
const listeners = new Set<() => void>();

/** Bumped whenever a font finishes loading: pictures recorded before then may have used a fallback. */
export function fontEpoch() {
  return epoch;
}

export function onFontsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed() {
  epoch++;
  listeners.forEach(l => l());
}

export function fontProvider(kit: CanvasKit): TypefaceFontProvider {
  if (!provider) {
    ck = kit;
    provider = own(kit.TypefaceFontProvider.Make(), 'fontProvider');
  }
  return provider;
}

function register(buf: ArrayBuffer, alias: string) {
  provider!.registerFont(buf, alias);
  return alias;
}

/** The fonts that ship with the extension (Inter, latin, the common weights). */
export function loadBundledFonts(kit: CanvasKit): Promise<void> {
  fontProvider(kit);
  bundled ??= (async () => {
    const files = await Promise.all([
      import('@fontsource/inter/files/inter-latin-400-normal.woff2?url'),
      import('@fontsource/inter/files/inter-latin-500-normal.woff2?url'),
      import('@fontsource/inter/files/inter-latin-600-normal.woff2?url'),
      import('@fontsource/inter/files/inter-latin-700-normal.woff2?url'),
      import('@fontsource/inter/files/inter-latin-800-normal.woff2?url'),
      import('@fontsource/inter/files/inter-latin-400-italic.woff2?url'),
    ]);
    const bufs = await Promise.all(files.map(f => fetch(f.default).then(r => r.arrayBuffer())));
    for (const b of bufs) register(b, BUNDLED_PREFIX);
    changed();
  })();
  return bundled;
}

const key = (family: string, weight: number, italic: boolean) => `${family.toLowerCase()}|${weight}|${italic ? 1 : 0}`;

/**
 * Starts loading a Google Fonts family/weight/style (no-op if loaded or loading). Returns its current state:
 * 'ready' once registered, 'failed' if it can't be fetched, 'loading' meanwhile.
 */
export function requestFont(family: string, weight: any = 400, italic = false): FamilyState['status'] {
  if (!provider || !family || family.startsWith('$')) return 'failed';
  const w = weightNum(weight);
  const k = key(family, w, italic);
  const st = families.get(k);
  if (st) return st.status;
  const state: FamilyState = { status: 'loading', aliases: [] };
  families.set(k, state);
  const fam = family.trim().replace(/ /g, '+');
  const url = `https://fonts.googleapis.com/css2?family=${fam}:${italic ? 'ital,' : ''}wght@${italic ? '1,' : ''}${w}&display=block`;
  (async () => {
    const css = await fetch(url).then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))));
    // One @font-face per unicode subset; register each under its own alias so missing glyphs fall through.
    const blocks = css.split('@font-face').slice(1);
    const known = aliasesByFamily.get(family.toLowerCase()) ?? new Set<string>();
    aliasesByFamily.set(family.toLowerCase(), known);
    await Promise.all(
      blocks.map(async (b, i) => {
        const src = b.match(/url\((https:[^)]+)\)/)?.[1];
        if (!src) return;
        const buf = await fetch(src).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))));
        const subset = b.match(/\/\*\s*([\w-]+)\s*\*\//)?.[1];
        // Latin first: it is what most text needs, and the order of aliases is the fallback order.
        const alias = subset === 'latin' ? family : `${family} (${subset ?? i})`;
        register(buf, alias);
        known.add(alias);
      }),
    );
    if (!known.size) throw new Error('no font files in the stylesheet');
    state.status = 'ready';
    changed();
  })().catch(e => {
    state.status = 'failed';
    state.error = e instanceof Error ? e.message : String(e);
    changed();
  });
  return 'loading';
}

/** Family list for a paragraph: the family (and its subsets), then the bundled Inter. */
export function familyList(family: string): string[] {
  const list: string[] = [];
  const subs = aliasesByFamily.get(family.toLowerCase());
  if (subs) list.push(family, ...[...subs].filter(a => a !== family).sort((a, b) => (a.includes('latin-ext') ? -1 : b.includes('latin-ext') ? 1 : 0)));
  if (family.toLowerCase() !== DEFAULT_FAMILY.toLowerCase()) {
    const inter = aliasesByFamily.get(DEFAULT_FAMILY.toLowerCase());
    if (inter) list.push(DEFAULT_FAMILY, ...[...inter].filter(a => a !== DEFAULT_FAMILY));
  }
  list.push(BUNDLED_PREFIX);
  return list;
}

const SYSTEM = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'arial', 'helvetica', 'times new roman', 'segoe ui', 'georgia', 'courier new', 'verdana']);

/**
 * Whether text in this family can be drawn by Skia now: null if yes, else the reason (for skiaEligible).
 * Starts loading what's missing; Inter is always drawable (bundled, Google copy preferred when loaded).
 */
export function fontBlocker(family: string, weight: any, italic: boolean): string | null {
  const fam = family || DEFAULT_FAMILY;
  if (SYSTEM.has(fam.toLowerCase())) return `system font "${fam}" (Skia can only use font files)`;
  const st = requestFont(fam, weight, italic);
  if (fam.toLowerCase() === DEFAULT_FAMILY.toLowerCase()) return null;
  if (st === 'ready') return null;
  return st === 'loading' ? `font "${fam}" loading` : `font "${fam}" could not be loaded`;
}

export function fontStats() {
  const out = { ready: 0, loading: 0, failed: 0, failedFamilies: [] as string[] };
  for (const [k, s] of families) {
    out[s.status]++;
    if (s.status === 'failed') out.failedFamilies.push(k.split('|')[0]);
  }
  return out;
}

export function kitForFonts() {
  return ck;
}
