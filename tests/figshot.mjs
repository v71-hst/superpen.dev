// Screenshots of an imported Figma page, to look at: the whole of each top-level layer (up to a limit) and close-ups
// of layers with cropped pictures. Convert a file first with fig-import.mjs --out <folder served by the dev server>.
// Usage: node figshot.mjs <url of the converted .spen> <out prefix> [max top-level layers, default 4]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { launchOptions } from './browser.mjs';
const [, , url, out, max = '4'] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__penStore?.getState().doc && window.__penAgent, { timeout: 60000 });
await new Promise(r => setTimeout(r, 2500));
const info = await page.evaluate(() => {
  const d = window.__penStore.getState().doc;
  const crops = [];
  const walk = n => {
    const fills = Array.isArray(n.fill) ? n.fill : [n.fill];
    const f = fills.find(f => f && typeof f === 'object' && f.type === 'image' && f.transform);
    if (f) crops.push({ id: n.id, name: n.name, w: n.width, h: n.height, transform: f.transform });
    (n.children ?? []).forEach(walk);
  };
  d.children.forEach(walk);
  return { top: d.children.map(c => ({ id: c.id, name: c.name, w: c.width, h: c.height })), crops };
});
console.log(`${info.top.length} top-level layers, ${info.crops.length} cropped pictures`);
const shot = async (id, name, size) => {
  const r = await page.evaluate((id, size) => window.__penAgent('screenshot', { id, max_size: size }).catch(e => ({ error: String(e) })), id, size);
  if (r.error) return console.log('  failed', name, r.error);
  fs.writeFileSync(`${out}-${name}.png`, Buffer.from(r.dataUrl.slice(r.dataUrl.indexOf(',') + 1), 'base64'));
  console.log(`  ${out}-${name}.png ${r.width}x${r.height}`);
};
for (const [i, t] of info.top.slice(0, Number(max)).entries()) await shot(t.id, `top${i}`, 1400);
for (const [i, c] of info.crops.slice(0, 4).entries()) {
  console.log(`  crop ${c.name} ${c.w}x${c.h} ${JSON.stringify(c.transform)}`);
  await shot(c.id, `crop${i}`, 500);
}
await browser.close();
