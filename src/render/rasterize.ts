// Renders a canvas node to PNG/JPEG/SVG. Nodes are drawn with inline styles only, so a plain DOM clone inside an
// SVG <foreignObject> reproduces them; fonts and images are inlined because SVG images cannot load external resources.

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

const fontCssCache = new Map<string, Promise<string>>();

/** @font-face rules (latin subsets) for every Google Fonts stylesheet on the page, with font files inlined. */
async function embeddedFontCss(): Promise<string> {
  const hrefs = [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet][href*="fonts.googleapis.com"]')].map(l => l.href);
  const parts = await Promise.all(
    hrefs.map(href => {
      let p = fontCssCache.get(href);
      if (!p) {
        p = fetch(href)
          .then(r => r.text())
          .then(async css => {
            // Keep only latin subsets to keep the image small.
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

const scaledCache = new Map<string, Promise<string>>();

/**
 * Data URL of an image downscaled so its longest side is at most `maxSide` (rounded up to a power of two so
 * captures at similar scales share one copy). Small images, SVGs and anything that can't be decoded are inlined
 * unchanged.
 */
function toScaledDataUrl(url: string, maxSide: number): Promise<string> {
  const side = 2 ** Math.ceil(Math.log2(Math.max(64, maxSide)));
  const key = side + '|' + url;
  let p = scaledCache.get(key);
  if (!p) {
    p = (async () => {
      try {
        const blob = await (await fetch(url)).blob();
        if (blob.type === 'image/svg+xml') return toDataUrl(url);
        const probe = await createImageBitmap(blob);
        const { width: w, height: h } = probe;
        probe.close();
        if (Math.max(w, h) <= side) return toDataUrl(url);
        const k = side / Math.max(w, h);
        const rw = Math.max(1, Math.round(w * k));
        const rh = Math.max(1, Math.round(h * k));
        const img = await createImageBitmap(blob, { resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' });
        const cv = new OffscreenCanvas(rw, rh);
        cv.getContext('2d')!.drawImage(img, 0, 0);
        img.close();
        const out = await cv.convertToBlob({ type: 'image/webp', quality: 0.9 });
        return await new Promise<string>(res => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result as string);
          fr.readAsDataURL(out);
        });
      } catch {
        return toDataUrl(url);
      }
    })();
    scaledCache.set(key, p);
  }
  return p;
}

/** Thrown with `requireImages` when an image could not be embedded (e.g. a remote host that blocks cross-origin reads). */
export class ImagesUnavailableError extends Error {}

/** Inlines images as data URLs; returns how many could not be fetched (they would render blank in the SVG). */
async function inlineImages(root: HTMLElement, maxSide?: number): Promise<number> {
  const jobs: Promise<void>[] = [];
  let missing = 0;
  const inline = async (url: string) => {
    const d = await (maxSide ? toScaledDataUrl(url, maxSide) : toDataUrl(url));
    if (!d.startsWith('data:')) missing++;
    return d;
  };
  const all = [root, ...root.querySelectorAll<HTMLElement>('*')];
  for (const el of all) {
    const bg = el.style?.backgroundImage;
    if (bg && bg.includes('url(')) {
      jobs.push(
        (async () => {
          let out = bg;
          for (const m of bg.matchAll(/url\("?([^")]+)"?\)/g)) if (!m[1].startsWith('data:')) out = out.split(m[1]).join(await inline(new URL(m[1], location.href).href));
          el.style.backgroundImage = out;
        })(),
      );
    }
    if (el.tagName.toLowerCase() === 'image') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('data:')) jobs.push(inline(new URL(href, location.href).href).then(d => el.setAttribute('href', d)));
    }
  }
  await Promise.all(jobs);
  return missing;
}

export type RasterOptions = {
  format: 'png' | 'jpg' | 'svg';
  pixelRatio: number;
  background?: string;
  /** Extra area captured around the element on every side (node units). */
  margin?: number;
  /** Render the element even if it is visibility:hidden (used to capture a shader effect's input). */
  forceVisible?: boolean;
  /** Node keys to hide in the capture (e.g. the node itself for @backdrop). */
  hideKeys?: string[];
  /** Elements to drop from the capture. */
  dropSelector?: string;
  /** Crop to this rectangle relative to the element (node units) instead of the element box. */
  crop?: { x: number; y: number; w: number; h: number };
  /** Throw ImagesUnavailableError instead of rendering images that could not be embedded as blanks. */
  requireImages?: boolean;
  /** Downscale embedded images to at most this many pixels on their longest side (small captures don't need more). */
  maxImageSide?: number;
};

/** Clone of `el` with canvases replaced by images (canvas pixels are not part of a DOM clone). */
function cloneWithCanvases(el: HTMLElement): HTMLElement {
  const clone = el.cloneNode(true) as HTMLElement;
  const src = [el, ...el.querySelectorAll('canvas')].filter(c => c instanceof HTMLCanvasElement) as HTMLCanvasElement[];
  const dst = [clone, ...clone.querySelectorAll('canvas')].filter(c => c instanceof HTMLCanvasElement) as HTMLCanvasElement[];
  src.forEach((c, i) => {
    const d = dst[i];
    if (!d || !c.width || !c.height) return;
    const img = document.createElement('img');
    try {
      img.src = c.toDataURL();
    } catch {
      return;
    }
    img.style.cssText = d.style.cssText;
    for (const a of ['data-shader-fx', 'data-k']) if (d.hasAttribute(a)) img.setAttribute(a, d.getAttribute(a)!);
    d.replaceWith(img);
  });
  return clone;
}

export async function rasterizeToCanvas(el: HTMLElement, opts: Omit<RasterOptions, 'format'>): Promise<HTMLCanvasElement> {
  const { svgUrl, w, h } = await buildSvg(el, opts);
  const img = new Image();
  img.src = svgUrl;
  await img.decode();
  await new Promise(r => setTimeout(r, 30));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * opts.pixelRatio));
  canvas.height = Math.max(1, Math.round(h * opts.pixelRatio));
  const g = canvas.getContext('2d')!;
  g.scale(opts.pixelRatio, opts.pixelRatio);
  g.drawImage(img, 0, 0, w, h);
  return canvas;
}

async function buildSvg(el: HTMLElement, opts: Omit<RasterOptions, 'format'>) {
  const bw = Math.max(1, Math.ceil(el.offsetWidth || el.getBoundingClientRect().width));
  const bh = Math.max(1, Math.ceil(el.offsetHeight || el.getBoundingClientRect().height));
  const m = opts.margin ?? 0;
  const crop = opts.crop ?? { x: -m, y: -m, w: bw + m * 2, h: bh + m * 2 };
  const w = Math.max(1, Math.ceil(crop.w));
  const h = Math.max(1, Math.ceil(crop.h));
  const clone = cloneWithCanvases(el);
  for (const key of opts.hideKeys ?? []) {
    const t = clone.getAttribute('data-k') === key ? clone : clone.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);
    if (t) t.style.visibility = 'hidden';
  }
  if (opts.dropSelector) clone.querySelectorAll(opts.dropSelector).forEach(x => x.remove());
  clone.style.position = 'absolute';
  clone.style.left = `${-crop.x}px`;
  clone.style.top = `${-crop.y}px`;
  // Pin the measured size: fill_container/flex sizing is lost once the clone leaves its parent layout.
  clone.style.width = `${bw}px`;
  clone.style.height = `${bh}px`;
  clone.style.flex = 'none';
  clone.style.boxSizing = 'border-box';
  clone.style.transform = 'none';
  clone.style.margin = '0';
  clone.style.contentVisibility = '';
  if (opts.forceVisible) clone.style.visibility = 'visible';
  clone.querySelectorAll('[data-k]').forEach(x => x.removeAttribute('data-k'));
  if ((await inlineImages(clone, opts.maxImageSide)) && opts.requireImages) throw new ImagesUnavailableError('some images could not be embedded');
  const wrapper = document.createElement('div');
  wrapper.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrapper.style.cssText = `position:relative;width:${w}px;height:${h}px;overflow:hidden;${opts.background ? `background:${opts.background};` : ''}`;
  const style = document.createElement('style');
  style.textContent = await embeddedFontCss();
  wrapper.appendChild(style);
  wrapper.appendChild(clone);
  const xhtml = new XMLSerializer().serializeToString(wrapper);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  return { svgUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), w, h };
}

export async function rasterize(el: HTMLElement, opts: RasterOptions): Promise<{ dataUrl: string; width: number; height: number }> {
  const { svgUrl, w, h } = await buildSvg(el, opts);
  if (opts.format === 'svg') return { dataUrl: svgUrl, width: w, height: h };
  const img = new Image();
  img.src = svgUrl;
  await img.decode();
  // Give the browser a moment to apply embedded fonts inside the SVG document.
  await new Promise(r => setTimeout(r, 30));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * opts.pixelRatio));
  canvas.height = Math.max(1, Math.round(h * opts.pixelRatio));
  const g = canvas.getContext('2d')!;
  if (opts.background || opts.format === 'jpg') {
    g.fillStyle = opts.background ?? '#ffffff';
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  g.scale(opts.pixelRatio, opts.pixelRatio);
  g.drawImage(img, 0, 0, w, h);
  return { dataUrl: canvas.toDataURL(opts.format === 'jpg' ? 'image/jpeg' : 'image/png', 0.92), width: canvas.width, height: canvas.height };
}

