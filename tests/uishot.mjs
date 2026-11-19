// Screenshots of the whole editor UI to look at: <out>-dark.png and <out>-light.png (top bar, both panels), then in
// the dark theme <out>-more.png (the "more" menu), <out>-zoom.png (the zoom menu), <out>-search.png (layer search)
// and <out>-narrow.png (a 640 px wide pane). The first top-level frame's first child is selected so the Design panel
// has something to show.
// Usage: node uishot.mjs <url> <out prefix> [width=1500] [height=900]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, out, w = '1500', h = '900'] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const shot = async (page, name) => {
  await page.screenshot({ path: `${out}-${name}.png` });
  console.log(`${out}-${name}.png`);
};
for (const scheme of ['dark', 'light']) {
  const page = await browser.newPage();
  await page.setViewport({ width: +w, height: +h });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 200)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#pen-world [data-k]', { timeout: 120000 });
  await page.waitForFunction(() => window.__penStore, { timeout: 60000 });
  await page.evaluate(scheme => {
    const s = window.__penStore;
    const f = s.getState().doc.children[0];
    const pick = (f.children ?? [])[0] ?? f;
    s.setState({ uiTheme: scheme, leftOpen: true, rightOpen: true, selection: [pick.id], expanded: { ...s.getState().expanded, [f.id]: true } });
  }, scheme);
  await sleep(2500);
  await shot(page, scheme);
  if (scheme === 'dark') {
    await page.click('.toolbar .tool:last-of-type');
    await sleep(300);
    await shot(page, 'more');
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 500);
    await page.click('.zoom-btn');
    await sleep(300);
    await shot(page, 'zoom');
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 500);
    await page.click('.tabs .tab:last-of-type');
    await page.keyboard.type('hero');
    await sleep(400);
    await shot(page, 'search');
    // F8: the frame-rate readout (bottom left), on and off again.
    await page.keyboard.press('Escape');
    await page.mouse.click(700, 500);
    await page.keyboard.press('F8');
    await sleep(1300);
    const fps = await page.evaluate(() => document.querySelector('.fps')?.textContent ?? null);
    await shot(page, 'fps');
    await page.keyboard.press('F8');
    await sleep(200);
    console.log(`F8 readout: ${fps}; hidden again: ${await page.evaluate(() => !document.querySelector('.fps'))}`);
    await page.evaluate(() => window.__penStore.setState({ leftOpen: false, selection: [] }));
    await page.setViewport({ width: 640, height: 700 });
    await sleep(600);
    await shot(page, 'narrow');
  }
  await page.close();
}
await browser.close();
