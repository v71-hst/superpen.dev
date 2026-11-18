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
/**
 * Registered aliases per family and per style (`family|weight|italic`), latin subset first. Each weight gets its own
 * alias because Google's static instances can all report the same weight, which would make Skia pick any of them.
 */
const aliasesByFamily = new Map<string, Map<string, string[]>>();
/** Font file URLs already registered: variable fonts come back as the same file for every weight. */
const registeredFiles = new Map<string, Promise<void>>();
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
    const files: [number, boolean, Promise<{ default: string }>][] = [
      [400, false, import('@fontsource/inter/files/inter-latin-400-normal.woff2?url')],
      [500, false, import('@fontsource/inter/files/inter-latin-500-normal.woff2?url')],
      [600, false, import('@fontsource/inter/files/inter-latin-600-normal.woff2?url')],
      [700, false, import('@fontsource/inter/files/inter-latin-700-normal.woff2?url')],
      [800, false, import('@fontsource/inter/files/inter-latin-800-normal.woff2?url')],
      [400, true, import('@fontsource/inter/files/inter-latin-400-italic.woff2?url')],
    ];
    await Promise.all(
      files.map(async ([w, italic, mod]) => {
        const buf = await fetch((await mod).default).then(r => r.arrayBuffer());
        register(buf, bundledAlias(w, italic));
        bundledStyles.push([w, italic]);
      }),
    );
    changed();
  })();
  return bundled;
}

const key = (family: string, weight: number, italic: boolean) => `${family.toLowerCase()}|${weight}|${italic ? 1 : 0}`;
const bundledAlias = (w: number, italic: boolean) => `${BUNDLED_PREFIX} ${w}${italic ? 'i' : ''}`;
const bundledStyles: [number, boolean][] = [];

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
    const styles = aliasesByFamily.get(family.toLowerCase()) ?? new Map<string, string[]>();
    aliasesByFamily.set(family.toLowerCase(), styles);
    const known: { alias: string; order: number }[] = [];
    await Promise.all(
      blocks.map(async (b, i) => {
        const src = b.match(/url\((https:[^)]+)\)/)?.[1];
        if (!src) return;
        const subset = b.match(/\/\*\s*([\w-]+)\s*\*\//)?.[1];
        // Latin first: it is what most text needs, and the order of aliases is the fallback order.
        const alias = `${family} ${w}${italic ? 'i' : ''}${subset === 'latin' ? '' : ` (${subset ?? i})`}`;
        let done = registeredFiles.get(src);
        if (!done) {
          done = fetch(src)
            .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
            .then(buf => void register(buf, alias));
          registeredFiles.set(src, done);
          done.catch(() => registeredFiles.delete(src));
        }
        await done;
        known.push({ alias, order: subset === 'latin' ? 0 : subset === 'latin-ext' ? 1 : 2 + i });
      }),
    );
    if (!known.length) throw new Error('no font files in the stylesheet');
    styles.set(k, known.sort((a, b) => a.order - b.order).map(x => x.alias));
    state.status = 'ready';
    changed();
  })().catch(e => {
    state.status = 'failed';
    state.error = e instanceof Error ? e.message : String(e);
    changed();
  });
  return 'loading';
}

/** Aliases of a family for a style: the exact weight/italic, or (`others`) the remaining loaded styles, nearest first. */
function styleAliases(family: string, w: number, italic: boolean, others = false): string[] {
  const styles = aliasesByFamily.get(family.toLowerCase());
  if (!styles) return [];
  const exact = key(family, w, italic);
  if (!others) return styles.get(exact) ?? [];
  return [...styles.entries()]
    .filter(([k]) => k !== exact)
    .map(([k, aliases]) => {
      const [, kw, ki] = k.split('|');
      return { aliases, d: Math.abs(Number(kw) - w) + (Number(ki) === (italic ? 1 : 0) ? 0 : 1000) };
    })
    .sort((a, b) => a.d - b.d)
    .flatMap(r => r.aliases);
}

/**
 * Family list for a paragraph: the exact style of the family, then of Inter, then the bundled Inter at the nearest
 * weight; other weights come last so they only supply glyphs nothing else has (never the weight of normal text).
 */
export function familyList(family: string, weight: any = 400, italic = false): string[] {
  const w = weightNum(weight);
  const isInter = family.toLowerCase() === DEFAULT_FAMILY.toLowerCase();
  const list = styleAliases(family, w, italic);
  if (!isInter) list.push(...styleAliases(DEFAULT_FAMILY, w, italic));
  const near = [...bundledStyles].sort((a, b) => Math.abs(a[0] - w) + (a[1] === italic ? 0 : 1000) - (Math.abs(b[0] - w) + (b[1] === italic ? 0 : 1000)));
  list.push(...near.map(([bw, bi]) => bundledAlias(bw, bi)));
  list.push(...styleAliases(family, w, italic, true));
  if (!isInter) list.push(...styleAliases(DEFAULT_FAMILY, w, italic, true));
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
