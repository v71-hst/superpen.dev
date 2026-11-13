// Compares where the browser actually draws frames with where the view math says they should be, at high zoom.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 7000));
const frames = await page.evaluate(() => window.__penStore.getState().doc.children
  .filter(c => typeof c.x === 'number' && typeof c.y === 'number')
  .map(c => ({ id: c.id, x: c.x, y: c.y, w: c.width, h: c.height, name: c.name }))
  .sort((a, b) => Math.hypot(b.x, b.y) - Math.hypot(a.x, a.y)));
console.log('frames:', frames.length, 'farthest from origin:', JSON.stringify(frames.slice(0, 2)));
const targets = [frames[0], frames[Math.floor(frames.length / 2)], frames[frames.length - 1]];
for (const f of targets) {
  for (const zoom of [1, 8, 32, 64, 128, 256]) {
    const r = await page.evaluate(async (f, zoom) => {
      const c = document.getElementById('pen-canvas').getBoundingClientRect();
      // Put the frame's top-left corner 200px into the canvas.
      window.__penStore.getState().setView({ zoom, x: 200 - f.x * zoom, y: 200 - f.y * zoom });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      await new Promise(r => setTimeout(r, 350));
      const el = document.querySelector(`#pen-world > [data-k="${CSS.escape(f.id)}"]`);
      if (!el) return { missing: true };
      const b = el.getBoundingClientRect();
      const v = window.__penStore.getState().view;
      return { wantX: c.left + v.x + f.x * v.zoom, wantY: c.top + v.y + f.y * v.zoom, gotX: b.left, gotY: b.top, cv: el.style.contentVisibility || 'visible', wc: document.getElementById('pen-world').style.willChange, tx: Math.round(v.x), ty: Math.round(v.y) };
    }, f, zoom);
    if (r.missing) { console.log(`  ${f.id} z${zoom}: element missing`); continue; }
    const err = Math.hypot(r.gotX - r.wantX, r.gotY - r.wantY);
    console.log(`  frame @(${f.x},${f.y}) zoom ${String(zoom).padStart(3)}: translate(${r.tx}, ${r.ty})  drawn off by ${err.toFixed(2)}px  ${r.cv}${err > 1 ? '  <-- WRONG PLACE' : ''}`);
  }
}
await browser.close();
