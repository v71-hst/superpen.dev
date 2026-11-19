// What the Skia renderer holds at each step of the memory scenario (tests/memory.mjs gives the process totals; this
// says what is behind them): decoded pictures small and larger, far-zoom copies, Skia's GPU cache, CanvasKit objects.
// Usage: PEN_PROD=1 node start.mjs <folder>, then: node skia-mem.mjs <url> [renderer=full] [perf=0|1]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, renderer = 'full', perf = '0'] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.evaluateOnNewDocument(p => localStorage.setItem('pen.perfMode', p), perf);
await page.goto(`${url}${url.includes('?') ? '&' : '?'}renderer=${renderer}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await page.waitForFunction(() => window.__penStore && window.__penAgent, { timeout: 60000 });
await page.evaluate(() => { const st = window.__penStore.getState(); if ((st.doc.sections ?? []).some(x => x.hidden)) st.edit(d => d.sections.forEach(x => delete x.hidden)); });

const cdp = await page.createCDPSession();
const report = async step => {
  const d = await page.evaluate(() => window.__penAgent('diagnose', {}));
  const s = d.renderer?.skia ?? {};
  const procs = (await cdp.send('SystemInfo.getProcessInfo').catch(() => ({ processInfo: [] }))).processInfo;
  console.log(`${step.padEnd(26)} pictures ${s.images?.smallMB} MB small + ${s.images?.largerMB} MB in ${s.images?.larger} larger (loaded ${s.images?.sharpened}, dropped ${s.images?.dropped}, skipped ${s.images?.skipped}); copies ${s.pictureImages?.MB} MB in ${s.pictureImages?.images}; recorded pictures ${s.pictures?.pictureMB} MB (${s.pictures?.recordings} recordings); GPU cache ${s.gpu?.usedMB}/${s.gpu?.limitMB} MB; placeholders ${s.overview?.placeholders}; objects ${s.liveObjects?.total}; processes ${procs.length}`);
};
const view = v => page.evaluate(v => { const s = window.__penStore.getState(); s.setView({ ...s.view, ...v }); }, v);
const fit = () => page.evaluate(() => window.__penAgent('diagnose', {}).then(() => { const s = window.__penStore.getState(); s.setView({ x: 20, y: 20, zoom: 0.02 }); }));
const pan = async (steps, dx, dy) => { for (let i = 0; i < steps; i++) { await page.evaluate((dx, dy) => { const s = window.__penStore.getState(); s.setView({ ...s.view, x: s.view.x + dx, y: s.view.y + dy }); }, dx, dy); await sleep(60); } };

await fit();
await sleep(12000);
await report('opened, fit to screen');
await view({ x: -3000, y: -2000, zoom: 1 });
await sleep(4000);
await report('zoomed to 100%');
await pan(120, -40, -25);
await sleep(3000);
await report('after panning at 100%');
await view({ zoom: 0.5 });
await pan(80, -30, -20);
await sleep(3000);
await report('zoomed to 50%, panned');
await view({ x: 20, y: 20, zoom: 0.12 });
await sleep(4000);
await report('zoomed out to 12%');
await sleep(45000);
await report('same, 45 s idle');
await browser.close();
