// Ctrl+wheel over panels/toolbar must zoom the canvas (not the page); then report any "unexpected view change" logs.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 6000));
await page.evaluate(() => window.__penStore.setState({ leftOpen: true }));
await new Promise(r => setTimeout(r, 500));
const spots = { toolbar: [412, 300], leftPanel: [200, 400], zoomControl: [1530, 975], filePill: [1500, 22] };
for (const [name, [x, y]] of Object.entries(spots)) {
  const z0 = await page.evaluate(() => window.__penStore.getState().view.zoom);
  await page.mouse.move(x, y);
  await page.keyboard.down('Control');
  for (let i = 0; i < 5; i++) await page.mouse.wheel({ deltaY: -100 });
  await page.keyboard.up('Control');
  await new Promise(r => setTimeout(r, 200));
  const r = await page.evaluate(() => ({ zoom: window.__penStore.getState().view.zoom, page: window.visualViewport?.scale ?? 1 }));
  console.log(`ctrl+wheel over ${name.padEnd(11)}: canvas zoom ${z0.toFixed(3)} -> ${r.zoom.toFixed(3)}, page magnification ${r.page}`);
}
const diag = await page.evaluate(() => window.__penAgent('diagnose', {}));
const unexpected = diag.log.filter(l => /unexpected place/.test(l));
console.log('unexpected view-change warnings:', unexpected.length);
for (const u of unexpected.slice(0, 3)) console.log('  ', u.slice(0, 300));
await browser.close();
