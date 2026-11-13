// Fast zoom bursts to extreme zoom levels: checks cursor anchoring, view sanity and wrongly-culled content.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 7000));
await page.evaluate(() => {
  window.__vlog = [];
  let prev = window.__penStore.getState().view;
  window.__penStore.subscribe(s => {
    if (s.view !== prev) {
      window.__vlog.push({ from: prev, to: s.view, stack: new Error().stack.split('\n').slice(2, 7).map(l => l.trim().replace(/\(http[^)]*\/src\//, '(').replace(/\?t=\d+/, '').slice(0, 80)).join(' < ') });
      prev = s.view;
    }
  });
});
const view = () => page.evaluate(() => ({ ...window.__penStore.getState().view }));
const canvas = await page.evaluate(() => document.getElementById('pen-canvas').getBoundingClientRect().toJSON());
let jumps = 0, culled = 0, bursts = 0;
const pts = [[800, 500], [600, 300], [1100, 700], [700, 650], [1000, 350], [900, 450]];
for (const [x, y] of pts) {
  for (const speed of ['fast', 'veryfast', 'pinch']) {
    bursts++;
    await page.mouse.move(x, y);
    await page.evaluate(() => (window.__vlog = []));
    const v0 = await view();
    const wx = (x - canvas.left - v0.x) / v0.zoom, wy = (y - canvas.top - v0.y) / v0.zoom;
    // Zoom in hard, then back out, without waiting between events.
    const n = speed === 'pinch' ? 120 : 45;
    const dy = speed === 'veryfast' ? -600 : speed === 'pinch' ? -12 : -180;
    await page.keyboard.down('Control');
    for (let i = 0; i < n; i++) await page.mouse.wheel({ deltaY: dy });
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 400));
    const v1 = await view();
    const sx = canvas.left + v1.x + wx * v1.zoom, sy = canvas.top + v1.y + wy * v1.zoom;
    const drift = Math.hypot(sx - x, sy - y);
    // Is the frame under the cursor rendered (not hidden by viewport culling)?
    const hidden = await page.evaluate((x, y) => {
      const roots = [...document.getElementById('pen-world').children];
      return roots.filter(r => { const b = r.getBoundingClientRect(); return b.left <= x && b.right >= x && b.top <= y && b.bottom >= y; }).map(r => r.style.contentVisibility || 'visible');
    }, x, y);
    const bad = drift > 2 || ![v1.x, v1.y, v1.zoom].every(Number.isFinite);
    if (bad) jumps++;
    if (hidden.includes('hidden')) culled++;
    console.log(`${speed.padEnd(8)} at ${x},${y}: zoom ${v0.zoom.toFixed(3)} -> ${v1.zoom.toFixed(1)}  drift ${drift.toFixed(1)}px  roots-under-cursor ${JSON.stringify(hidden)}${bad ? '  <-- JUMP' : ''}`);
    if (bad) console.log('   first view changes:', JSON.stringify((await page.evaluate(() => window.__vlog)).filter(e => !e.stack.includes('zoomBy')).slice(0, 3)).slice(0, 600));
    // Zoom back out fast.
    await page.keyboard.down('Control');
    for (let i = 0; i < n; i++) await page.mouse.wheel({ deltaY: -dy });
    await page.keyboard.up('Control');
    await new Promise(r => setTimeout(r, 400));
  }
}
console.log(`bursts ${bursts}, jumps ${jumps}, wrongly-culled ${culled}, page errors ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log(' -', e);
await browser.close();
