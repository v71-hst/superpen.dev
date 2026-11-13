// Measures load time and frame times while panning/zooming the editor.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';

const [, , url, shot] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, args: ['--enable-gpu-rasterization', '--disable-renderer-backgrounding'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
console.log('load ms', Date.now() - t0, 'dom nodes', await page.evaluate(() => document.querySelectorAll('#pen-world *').length));
const modes = () => page.evaluate(() => {
  const els = [...document.getElementById('pen-world').children];
  return { bitmap: els.filter(e => e.dataset.bitmap !== undefined).length, placeholder: els.filter(e => e.dataset.placeholder !== undefined).length, live: els.filter(e => e.dataset.k && e.dataset.bitmap === undefined && e.dataset.placeholder === undefined).length, dom: document.querySelectorAll('#pen-world *').length, zoom: window.__penStore?.getState().view.zoom };
});
console.log('after load', JSON.stringify(await modes()));
for (const t of [5, 15, 30]) {
  await new Promise(r => setTimeout(r, t === 5 ? 5000 : 10000 + (t === 30 ? 5000 : 0)));
  console.log(`after ${t}s`, JSON.stringify(await modes()));
}
if (shot) await page.screenshot({ path: shot.replace('.png', '-overview.png') });
await new Promise(r => setTimeout(r, 1500));

const cdp = await page.createCDPSession();
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
async function measure(label, fn) {
  const m0 = await metrics();
  await page.evaluate(() => {
    window.__frames = [];
    let last = performance.now();
    window.__stop = false;
    const tick = t => { window.__frames.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const start = Date.now();
  await fn();
  const total = Date.now() - start;
  const f = await page.evaluate(() => { window.__stop = true; return window.__frames.slice(1); });
  f.sort((a, b) => a - b);
  const avg = f.reduce((a, b) => a + b, 0) / Math.max(1, f.length);
  const m1 = await metrics();
  const d = k => ((m1[k] - m0[k]) * 1000).toFixed(0);
  console.log(label, `total ${total}ms frames ${f.length} avg ${avg.toFixed(1)}ms p95 ${f[Math.floor(f.length * 0.95)]?.toFixed(1)}ms max ${f[f.length - 1]?.toFixed(1)}ms | script ${d('ScriptDuration')} style ${d('RecalcStyleDuration')} layout ${d('LayoutDuration')} task ${d('TaskDuration')} layouts ${m1.LayoutCount - m0.LayoutCount} styles ${m1.RecalcStyleCount - m0.RecalcStyleCount}`);
}

await page.mouse.move(900, 500);
await measure('zoom-in ', async () => { for (let i = 0; i < 40; i++) { await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: -40 }); await page.keyboard.up('Control'); await new Promise(r => setTimeout(r, 16)); } await new Promise(r => setTimeout(r, 400)); });
await measure('pan     ', async () => { for (let i = 0; i < 60; i++) { await page.mouse.wheel({ deltaY: 60, deltaX: 40 }); await new Promise(r => setTimeout(r, 16)); } await new Promise(r => setTimeout(r, 400)); });
await measure('zoom-out', async () => { for (let i = 0; i < 60; i++) { await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: 40 }); await page.keyboard.up('Control'); await new Promise(r => setTimeout(r, 16)); } await new Promise(r => setTimeout(r, 400)); });
await measure('hover   ', async () => { for (let i = 0; i < 60; i++) { await page.mouse.move(500 + i * 12, 300 + (i % 7) * 40); await new Promise(r => setTimeout(r, 16)); } });
if (shot) await page.screenshot({ path: shot });
await browser.close();

