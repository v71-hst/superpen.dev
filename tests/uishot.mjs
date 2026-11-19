// Screenshots of the whole editor UI to look at (panels, toolbar, zoom control), dark and light:
// <out>-dark.png, <out>-light.png, <out>-dark-menus.png. The first top-level frame's first child is selected so the
// Design panel has something to show.
// Usage: node uishot.mjs <url> <out prefix> [width=1500] [height=900]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, out, w = '1500', h = '900'] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true }));
for (const scheme of ['dark', 'light']) {
  const page = await browser.newPage();
  await page.setViewport({ width: +w, height: +h });
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#pen-world [data-k]', { timeout: 120000 });
  await page.waitForFunction(() => window.__penStore, { timeout: 60000 });
  await page.evaluate(() => {
    const s = window.__penStore;
    const f = s.getState().doc.children[0];
    const pick = (f.children ?? [])[0] ?? f;
    s.setState({ leftOpen: true, rightOpen: true, selection: [pick.id] });
  });
  await sleep(2500);
  await page.screenshot({ path: `${out}-${scheme}.png` });
  console.log(`${out}-${scheme}.png`);
  await page.close();
}
await browser.close();
