// The HTML exporter (src/export/html.ts) against how Skia draws the same frame (the agent's screenshot): for every
// top-level frame the exported page is rendered in a fresh tab at the screenshot's size and scored with compare() from
// src/editor/imageTools.ts. Shader fills and effects can't be HTML, so frames with them score lower. Writes a
// side-by-side image per frame. (Until 2026-11-20 it compared against the export that cloned the DOM renderer's
// elements: features 100%, showcase 99.7%, layout 98.0% average.)
// Usage: node htmlexport.mjs <url of a .pen> [out dir=htmlexport] [threshold %=97] [max frames=60]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { launchOptions } from './browser.mjs';
const [, , url, outDir = 'htmlexport', thresholdArg = '97', maxArg = '200'] = process.argv;
if (!url) throw new Error('usage: node htmlexport.mjs <url of a .pen> [out dir] [threshold %] [max frames]');
const threshold = Number(thresholdArg);
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
async function openApp(u) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => window.__penAgent && window.__penExport && window.__penStore?.getState().doc, { timeout: 120000 });
  await new Promise(r => setTimeout(r, 6000));
  return page;
}
const newPage = await openApp(url);
const shotPage = await browser.newPage();
const origin = new URL(url).origin;

/**
 * Renders an HTML page and screenshots its first element (or the given size) at 1x. `pin`: a size for a root element
 * that has none (the old export lost the size of hug/auto-sized frames, which then took the whole page width).
 */
async function render(html, size, pin) {
  // Same origin as the editor, so /api/file picture URLs load.
  await shotPage.goto(origin + '/__htmlexport_blank__', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await shotPage.setViewport({ width: Math.min(4000, Math.max(16, Math.ceil(size?.w ?? 1600))), height: Math.min(4000, Math.max(16, Math.ceil(size?.h ?? 1000))) });
  await shotPage.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 }).catch(() => shotPage.setContent(html, { waitUntil: 'load' }));
  if (pin)
    await shotPage.evaluate(pin => {
      const el = document.body.firstElementChild;
      if (!el.style.width) el.style.width = pin.w + 'px';
      if (!el.style.height) el.style.height = pin.h + 'px';
    }, pin);
  await shotPage.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 300));
  const box = await shotPage.evaluate(() => {
    const el = document.body.firstElementChild;
    return { w: el.offsetWidth, h: el.offsetHeight };
  });
  const w = Math.max(1, Math.min(4000, Math.ceil(size?.w ?? box.w)));
  const h = Math.max(1, Math.min(4000, Math.ceil(size?.h ?? box.h)));
  if (!size) await shotPage.setViewport({ width: w, height: h });
  const b64 = await shotPage.screenshot({ clip: { x: 0, y: 0, width: w, height: h }, encoding: 'base64', captureBeyondViewport: true });
  return { dataUrl: 'data:image/png;base64,' + b64, w, h };
}

const keys = await newPage.evaluate(n => window.__penStore.getState().doc.children.filter(c => c.enabled !== false && c.type !== 'note' && c.type !== 'prompt' && c.type !== 'context').slice(0, n).map(c => ({ id: c.id, name: c.name ?? c.id })), Number(maxArg));
const rows = [];
for (const { id, name } of keys) {
  try {
    const shot = await newPage.evaluate(id => window.__penAgent('screenshot', { id, scale: 1, max_size: 4000 }), id);
    const a = { dataUrl: shot.dataUrl, w: shot.width, h: shot.height };
    const newHtml = await newPage.evaluate(id => window.__penExport.nodeToHtmlDocument(id), id);
    fs.writeFileSync(path.join(outDir, `${id}.html`), newHtml);
    const b = await render(newHtml, { w: a.w, h: a.h });
    const r = await newPage.evaluate(
      async (a, b) => {
        const tools = await import('/src/editor/imageTools.ts');
        const [x, y] = await Promise.all([tools.loadImageData(a), tools.loadImageData(b)]);
        const cmp = tools.compare(x, y);
        return { match: Number(cmp.text.match(/match ([\d.]+)%/)?.[1] ?? 0), image: cmp.dataUrl, worst: cmp.text.split('\n').slice(1, 4).join(' | ') };
      },
      a.dataUrl,
      b.dataUrl,
    );
    fs.writeFileSync(path.join(outDir, `${id}.png`), Buffer.from(r.image.split(',')[1], 'base64'));
    rows.push({ id, name, match: r.match, size: [a.w, a.h], kb: Math.round(newHtml.length / 1024) });
    const ok = r.match >= threshold;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${id} "${name}" ${a.w}x${a.h} — ${r.match}% match (html ${Math.round(newHtml.length / 1024)} KB)${ok ? '' : ` | ${r.worst}`}`);
  } catch (e) {
    rows.push({ id, name, error: String(e) });
    console.log(`ERROR ${id} "${name}": ${String(e).slice(0, 300)}`);
  }
}
const scored = rows.filter(r => !r.error);
const avg = scored.reduce((s, r) => s + r.match, 0) / Math.max(1, scored.length);
console.log(`\n${scored.length} frames, average ${avg.toFixed(2)}% match, ${scored.filter(r => r.match >= threshold).length} at or above ${threshold}%, ${rows.length - scored.length} errors; side-by-side images and the HTML files in ${outDir}`);
await browser.close();
