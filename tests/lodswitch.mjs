import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pen-world [data-k]');
await new Promise(r => setTimeout(r, 8000));
const modes = () => page.evaluate(() => { const els = [...document.getElementById('pen-world').children]; return { bitmap: els.filter(e => e.dataset.bitmap !== undefined).length, zoom: +window.__penStore.getState().view.zoom.toFixed(3) }; });
console.log('zoomed out', JSON.stringify(await modes()));
for (const z of [0.5, 0.1, 1, 0.05, 0.35]) {
  await page.evaluate(z => { window.__penStore.getState().setView({ zoom: z }); }, z);
  const seen = [];
  for (let i = 0; i < 12; i++) { await page.evaluate(() => new Promise(r => requestAnimationFrame(r))); seen.push((await modes()).bitmap); }
  await new Promise(r => setTimeout(r, 300));
  console.log(`zoom ${z}: bitmaps per frame ${seen.join(',')} -> settled ${(await modes()).bitmap}`);
}
await browser.close();
