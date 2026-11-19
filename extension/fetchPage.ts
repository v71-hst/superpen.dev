// Fetches a web page for HTML import (src/import/html.ts): the markup and the stylesheets it links, as text. It runs
// outside the editor's webview (in the extension host, or the dev server) because a web page there cannot read other
// sites. Only http(s), with size limits and a time limit; nothing is executed and nothing is stored.
export type FetchedPage = { html: string; baseUrl: string; styles: Record<string, string> };

const MAX_HTML = 4 * 1024 * 1024;
const MAX_CSS = 1024 * 1024;
const MAX_SHEETS = 30;

async function text(url: string, limit: number, ms: number): Promise<string> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; design-import)', accept: 'text/html,text/css,*/*;q=0.8' } });
    if (!r.ok) throw new Error(`the site answered ${r.status}`);
    const body = await r.text();
    if (body.length > limit) throw new Error('the page is too large to import');
    return body;
  } finally {
    clearTimeout(t);
  }
}

export async function fetchPage(input: string): Promise<FetchedPage> {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : 'https://' + input);
  } catch {
    throw new Error('that is not a web address');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https addresses can be imported');
  const html = await text(url.href, MAX_HTML, 15000);
  // The page's own <base>, if it has one, decides what relative addresses mean.
  const baseTag = html.match(/<base\b[^>]*href\s*=\s*["']?([^"'\s>]+)/i)?.[1];
  const baseUrl = baseTag ? new URL(baseTag, url.href).href : url.href;
  const hrefs = [...html.matchAll(/<link\b[^>]*>/gi)]
    .map(m => m[0])
    .filter(tag => /rel\s*=\s*["']?[^"'>]*stylesheet/i.test(tag) && !/media\s*=\s*["']?print/i.test(tag))
    .map(tag => tag.match(/href\s*=\s*["']?([^"'\s>]+)/i)?.[1])
    .filter((h): h is string => !!h)
    .slice(0, MAX_SHEETS);
  const styles: Record<string, string> = {};
  await Promise.all(
    hrefs.map(async href => {
      try {
        const abs = new URL(href.replace(/&amp;/g, '&'), baseUrl).href;
        const css = await text(abs, MAX_CSS, 10000);
        // url(...) inside a stylesheet is relative to the stylesheet, which the import inlines into the page.
        styles[href] = css.replace(/url\(\s*(["']?)(?!data:|https?:|\/\/|#)([^)"']+)\1\s*\)/gi, (_, q, u) => {
          try {
            return `url(${q}${new URL(u, abs).href}${q})`;
          } catch {
            return `url(${q}${u}${q})`;
          }
        });
      } catch {
        // A stylesheet that does not load is left out; the page is imported without it.
      }
    }),
  );
  return { html, baseUrl, styles };
}
