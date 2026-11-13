// Zoomed-in alignment: an info icon placed at fractional coordinates (as AI Pen icons at a scaled grid are) must keep
// its dot centred over its stem on the live canvas at 16x, and a camera's tab ends must sit on its body line.
// Usage: node subpixel.mjs <url of a copy of features.pen> <screenshot dir>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
const [, , url, shotDir] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 900 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pen-world [data-k]');
await new Promise(r => setTimeout(r, 1500));
const A = (m, p) => page.evaluate((m, p) => window.__penAgent(m, p), m, p);
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);

// Same transform as the icon sheet's info icon: translate(32.05 362.15) scale(1.4545) in a 1323-wide frame.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 80"><g fill="none" stroke="#3C505F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<g transform="translate(2.05 2.15) scale(1.4545)"><circle cx="12" cy="12" r="10"/><path d="M12 11v6"/><circle cx="12" cy="7.5" r="1" fill="#3C505F" stroke="none"/></g>
<g transform="translate(50.85 3.45) scale(1.4545)"><rect x="2.5" y="6.5" width="19" height="14.5" rx="3"/><path d="M8 6.5l1.5-3h5L16 6.5"/></g></g></svg>`;
const d = await A('aiPenDraw', { x: 3000.3, y: 3000.7, width: 120, height: 80, prompt: 'subpixel test', svg, done: true });
await page.waitForFunction(() => window.__penStore.getState().aiPenPasses.length === 0, { timeout: 20000 });
// Zoom 16x onto the frame (world point 3000.3,3000.7 at screen 100,100).
const Z = 16;
await page.evaluate(Z => window.__penStore.setState({ view: { x: 100 - 3000.3 * Z, y: 100 - 3000.7 * Z, zoom: Z } }), Z);
await new Promise(r => setTimeout(r, 1500));
const canvas = await page.evaluate(() => { const r = document.getElementById('pen-world').parentElement.getBoundingClientRect(); return { x: r.left, y: r.top }; });
const shot = await page.screenshot({ clip: { x: canvas.x + 100, y: canvas.y + 100, width: 120 * Z, height: 80 * Z }, encoding: 'base64' });
fs.writeFileSync(`${shotDir}/subpixel.png`, Buffer.from(shot, 'base64'));
const an = await A('analyzeImage', { image: 'data:image/png;base64,' + shot, max_shapes: 40 });
const shapes = an.text.split('\n').filter(l => l.startsWith('  [')).map(l => {
  const m = l.match(/\[(\d+),(\d+)\]-\[(\d+),(\d+)\]/);
  return { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], cx: (+m[1] + +m[3]) / 2 };
});
// info icon: dot = small near-square shape, stem = tall thin shape, both inside the left icon (x < 60*Z)
const left = shapes.filter(s => s.x1 < 45 * Z);
const dot = left.find(s => s.x1 - s.x0 < 3.5 * Z && s.y1 - s.y0 < 3.5 * Z);
const stem = left.find(s => s.y1 - s.y0 > 10 * Z && s.x1 - s.x0 < 5 * Z);
ok('info dot centred over its stem at 16x', dot && stem && Math.abs(dot.cx - stem.cx) <= 2, dot && stem ? `dot ${dot.cx}, stem ${stem.cx} (screen px)` : JSON.stringify(left));
// camera: look at subpixel.png (tab ends must sit on the body line, no bumps below it)
await browser.close();
