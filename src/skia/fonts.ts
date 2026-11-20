// Fonts for Skia text. CanvasKit cannot see the browser's fonts, so font files are fetched and registered with one
// TypefaceFontProvider: Google Fonts families on demand (each @font-face subset of a family is registered under its
// own alias, so a paragraph's family list falls back through the subsets), and Inter bundled with the extension so
// text always draws. A family that cannot be fetched makes the frames using it fall back to the DOM renderer.
import type { CanvasKit, FontCollection, TypefaceFontProvider } from 'canvaskit-wasm';
import { free, own } from './lifetime';
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
/** The epoch at which each style (`family|weight|italic`) last finished loading or failed. */
const styleEpochs = new Map<string, number>();
/** The epoch at which something every text depends on last changed (the bundled fonts arrived, or a reset). */
let baseEpoch = 0;
const listeners = new Set<() => void>();

/** Bumped whenever a font finishes loading: pictures recorded before then may have used a fallback. */
export function fontEpoch() {
  return epoch;
}

/** The key a text style is tracked under; what fontStamp() takes. */
export function fontStyleKey(family: string, weight: any = 400, italic = false) {
  return key(family || DEFAULT_FAMILY, weightNum(weight), italic);
}

/**
 * A number that changes when one of these styles finishes loading or fails (or the bundled fonts arrive). A frame
 * whose text only uses those styles keeps its picture when some other font arrives.
 */
export function fontStamp(styles: Iterable<string>): number {
  let stamp = baseEpoch;
  for (const k of styles) stamp = Math.max(stamp, styleEpochs.get(k) ?? 0);
  return stamp;
}

export function onFontsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function changed(style?: string) {
  epoch++;
  if (style) styleEpochs.set(style, epoch);
  else baseEpoch = epoch;
  listeners.forEach(l => l());
}

let collection: { fc: FontCollection; epoch: number } | null = null;

/**
 * The one font collection every paragraph is built with. A collection caches typefaces and shaping data per font, so
 * one per paragraph (MakeFromFontProvider) costs megabytes per frame once a family has a dozen subset files; this one
 * is rebuilt only when a font arrives (its family lookups may have missed it).
 */
export function fontCollection(kit: CanvasKit): FontCollection {
  if (!collection || collection.epoch !== epoch) {
    if (collection) free(collection.fc);
    const fc = own(kit.FontCollection.Make(), 'fontCollection');
    fc.setDefaultFontManager(fontProvider(kit));
    fc.enableFontFallback();
    collection = { fc, epoch };
  }
  return collection.fc;
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
    changed(k);
  })().catch(e => {
    state.status = 'failed';
    state.error = e instanceof Error ? e.message : String(e);
    changed(k);
  });
  return 'loading';
}

// ---------- icon fonts ----------
// Material Symbols (one variable font: weight and optical size are set per icon) and Phosphor (codepoints by name,
// from its stylesheet), fetched from the same addresses the page-element renderer uses (render/fonts.ts).

type IconFont = { status: 'loading' | 'ready' | 'failed'; alias: string; codepoints?: Map<string, string>; error?: string };
const iconFonts = new Map<string, IconFont>();

/** The key an icon library's font is tracked under (in FrameDeps.fonts, for fontStamp). */
export const iconFontKey = (library: string) => `icon|${library.trim().toLowerCase()}`;

const isMaterial = (lib: string) => lib.startsWith('material symbols');
const PHOSPHOR_CSS = 'https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css';

/** Whether this library is an icon font Skia draws as text (Material Symbols, Phosphor). */
export function isIconFont(library: string) {
  const lib = library.trim().toLowerCase();
  return isMaterial(lib) || lib === 'phosphor';
}

/** Starts loading an icon library's font (no-op when loaded or loading); its state, as for requestFont. */
export function requestIconFont(library: string): IconFont['status'] {
  if (!provider) return 'failed';
  const k = iconFontKey(library);
  const known = iconFonts.get(k);
  if (known) return known.status;
  const lib = library.trim().toLowerCase();
  const state: IconFont = { status: 'loading', alias: `Icons: ${library.trim()}` };
  iconFonts.set(k, state);
  (async () => {
    const cssUrl = isMaterial(lib)
      ? `https://fonts.googleapis.com/css2?family=${library.trim().replace(/ /g, '+')}:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block`
      : PHOSPHOR_CSS;
    const css = await fetch(cssUrl).then(r => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))));
    const src = css.match(/url\((['"]?)([^'")]+\.(?:woff2|ttf|otf)[^'")]*)\1\)/)?.[2];
    if (!src) throw new Error('no font file in the stylesheet');
    const buf = await fetch(new URL(src, cssUrl).href).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))));
    register(buf, state.alias);
    if (!isMaterial(lib)) {
      // .ph.ph-acorn:before { content: "\e9b4"; }
      state.codepoints = new Map();
      for (const m of css.matchAll(/\.ph-([\w-]+):before\s*\{\s*content:\s*"\\([0-9a-fA-F]+)"/g)) state.codepoints.set(m[1], String.fromCodePoint(parseInt(m[2], 16)));
    }
    state.status = 'ready';
    changed(k);
  })().catch(e => {
    state.status = 'failed';
    state.error = e instanceof Error ? e.message : String(e);
    changed(k);
  });
  return 'loading';
}

/**
 * What to draw for an icon from an icon font: the font's alias and the text (Material Symbols: the name, which the
 * font turns into the icon by ligature; Phosphor: its codepoint, '' for an unknown name), or null until loaded.
 */
export function iconFontText(library: string, name: string): { alias: string; text: string } | null {
  const f = iconFonts.get(iconFontKey(library));
  if (!f || f.status !== 'ready') return null;
  return { alias: f.alias, text: f.codepoints ? (f.codepoints.get(name) ?? '') : name };
}

/** Aliases of a family for a style: the exact weight/italic, or (`others`) the remaining loaded styles, nearest first. */
function styleAliases(family: string, w: number, italic: boolean, others = false): string[] {
  const styles = aliasesByFamily.get(family.toLowerCase());
  if (!styles) return [];
  const exact = key(family, w, italic);
  if (!others) return [...(styles.get(exact) ?? [])];
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

/** Frees the font provider and forgets every registered font (Skia switched off); they load again when needed. */
export function resetFonts() {
  if (collection) free(collection.fc);
  collection = null;
  if (provider) free(provider);
  provider = null;
  families.clear();
  iconFonts.clear();
  aliasesByFamily.clear();
  registeredFiles.clear();
  styleEpochs.clear();
  bundled = null;
  bundledStyles.length = 0;
  changed();
}

export function kitForFonts() {
  return ck;
}
