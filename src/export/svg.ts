// SVG export: the layer as HTML (export/html.ts) inside an SVG <foreignObject>, with its pictures and the latin
// subsets of its Google fonts inlined (an SVG image can't load anything). Replaces the export that cloned the
// page-element renderer's elements (render/rasterize.ts, removed with that renderer on 2026-11-20).
import { nodeToHtmlDocument } from './html';

const dataUrlCache = new Map<string, Promise<string>>();

function toDataUrl(url: string): Promise<string> {
  let p = dataUrlCache.get(url);
  if (!p) {
    p = fetch(url)
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then(
        b =>
          new Promise<string>(res => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result as string);
            fr.readAsDataURL(b);
          }),
      )
      .catch(() => url);
    dataUrlCache.set(url, p);
  }
  return p;
}

/** Pictures as data URLs (CSS backgrounds and SVG <image>s). */
async function inlineImages(root: HTMLElement): Promise<void> {
  const jobs: Promise<void>[] = [];
  for (const el of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
    const bg = el.style?.backgroundImage;
    if (bg && bg.includes('url(')) {
      jobs.push(
        (async () => {
          let out = bg;
          for (const m of bg.matchAll(/url\("?([^")]+)"?\)/g)) if (!m[1].startsWith('data:')) out = out.split(m[1]).join(await toDataUrl(new URL(m[1], location.href).href));
          el.style.backgroundImage = out;
        })(),
      );
    }
    if (el.tagName.toLowerCase() === 'image') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('data:')) jobs.push(toDataUrl(new URL(href, location.href).href).then(d => el.setAttribute('href', d)));
    }
  }
  await Promise.all(jobs);
}

const fontCssCache = new Map<string, Promise<string>>();

/** The @font-face rules (latin subsets) of these Google Fonts stylesheets, font files inlined. */
async function embeddedFontCss(hrefs: string[]): Promise<string> {
  const parts = await Promise.all(
    hrefs.map(href => {
      let p = fontCssCache.get(href);
      if (!p) {
        p = fetch(href)
          .then(r => r.text())
          .then(async css => {
            const blocks = css.split(/(?=\/\*\s*[\w-]+\s*\*\/)/).filter(b => !/^\/\*/.test(b) || /\/\*\s*(latin|latin-ext)\s*\*\//.test(b));
            let out = blocks.join('');
            const urls = [...new Set([...out.matchAll(/url\((https:[^)]+)\)/g)].map(m => m[1]))];
            for (const u of urls) out = out.split(u).join(await toDataUrl(u));
            return out;
          })
          .catch(() => '');
        fontCssCache.set(href, p);
      }
      return p;
    }),
  );
  return parts.join('\n');
}

/** Layer `key` as an SVG data URL (its own size, in design units). */
export async function nodeToSvg(key: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const page = new DOMParser().parseFromString(nodeToHtmlDocument(key), 'text/html');
  const parsed = page.body.firstElementChild as HTMLElement | null;
  if (!parsed) throw new Error(`layer "${key}" exported nothing`);
  const root = document.importNode(parsed, true) as HTMLElement;
  const w = Math.max(1, Math.ceil(parseFloat(root.style.width) || 1));
  const h = Math.max(1, Math.ceil(parseFloat(root.style.height) || 1));
  root.style.position = 'absolute';
  root.style.left = '0';
  root.style.top = '0';
  await inlineImages(root);
  const fonts = [...page.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].map(l => l.getAttribute('href') ?? '').filter(h => h.includes('fonts.googleapis.com'));
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.cssText = `position:relative;width:${w}px;height:${h}px;overflow:hidden;`;
  const style = document.createElement('style');
  style.textContent = await embeddedFontCss(fonts);
  wrapper.appendChild(style);
  wrapper.appendChild(root);
  const xhtml = new XMLSerializer().serializeToString(wrapper);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  return { dataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width: w, height: h };
}
