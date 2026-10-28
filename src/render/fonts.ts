// Loads Google Fonts / icon fonts on demand for families used by the document.
const loaded = new Set<string>();

const SYSTEM_FONTS = new Set(['system-ui', 'sans-serif', 'serif', 'monospace', 'arial', 'helvetica', 'times new roman', 'segoe ui', 'georgia', 'courier new', 'verdana']);

function addLink(href: string) {
  if (loaded.has(href)) return;
  loaded.add(href);
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
}

function weightNum(w: any): number {
  if (typeof w === 'number') return w;
  const s = String(w ?? '400').toLowerCase();
  const named: Record<string, number> = { thin: 100, hairline: 100, extralight: 200, light: 300, normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800, black: 900 };
  return named[s.replace(/[\s_-]/g, '')] ?? (parseInt(s, 10) || 400);
}

export function ensureFont(family: string, weight: any = 400, italic = false) {
  if (!family || typeof family !== 'string' || family.startsWith('$')) return;
  if (SYSTEM_FONTS.has(family.toLowerCase())) return;
  const w = weightNum(weight);
  const fam = family.trim().replace(/ /g, '+');
  addLink(`https://fonts.googleapis.com/css2?family=${fam}:${italic ? 'ital,' : ''}wght@${italic ? '1,' : ''}${w}&display=block`);
}

export function ensureIconFont(library: string) {
  const lib = (library || '').toLowerCase();
  if (lib.startsWith('material symbols')) {
    const fam = library.trim().replace(/ /g, '+');
    addLink(`https://fonts.googleapis.com/css2?family=${fam}:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200&display=block`);
  } else if (lib === 'phosphor') {
    addLink('https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css');
    addLink('https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css');
  }
}

export { weightNum };
