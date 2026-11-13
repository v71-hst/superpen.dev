// Zooming a file with large images: how much work the browser does per zoom change. Zooms in five stages (wheel steps,
// then a pause, as a person does) and back out, tracing image decode/scale/upload work, long main-thread tasks and
// memory. Usage: node imgzoom.mjs <url of img15.pen> <trace.json>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const [, , url, out] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000 }));
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
const bcdp = await browser.target().createCDPSession();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function procMem() {
  const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo');
  const ids = processInfo.map(p => p.id).join(',');
  const o = execFileSync('powershell', ['-NoProfile', '-Command', `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.PrivateMemorySize64)" }; exit 0`]).toString();
  const mem = new Map(o.trim().split(/\r?\n/).map(l => l.trim().split(' ').map(Number)));
  const by = {};
  for (const p of processInfo) by[p.type] = (by[p.type] ?? 0) + (mem.get(p.id) ?? 0);
  const mb = v => Math.round((v ?? 0) / 1048576);
  return `renderer ${mb(by.renderer)}MB, gpu ${mb(by.GPU)}MB, total ${mb(Object.values(by).reduce((a, b) => a + b, 0))}MB`;
}
for (const f of (process.env.FLAGS ?? '').split(',').filter(Boolean)) await page.evaluateOnNewDocument(f => localStorage.setItem(f, '1'), f);
const t0 = Date.now();
await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await sleep(6000);
console.log(`loaded in ${Date.now() - t0}ms incl. 6s settle; zoom ${await page.evaluate(() => window.__penStore.getState().view.zoom.toFixed(3))}; ${await procMem()}`);
await page.mouse.move(960, 540);
await page.tracing.start({ path: out, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'gpu', 'viz'] });
const wheel = async (dy, n) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.down('Control');
    await page.mouse.wheel({ deltaY: dy });
    await page.keyboard.up('Control');
    await sleep(16);
  }
};
const stageTimes = [];
for (const dy of [-60, -60, -60, 60, 60, 60, -60, -60, -60, 60, 60, 60]) {
  const s = Date.now();
  await wheel(dy, 10);
  stageTimes.push(Date.now() - s);
  await sleep(900);
  if (process.env.STAGES) console.log(`  zoom ${await page.evaluate(() => window.__penStore.getState().view.zoom.toFixed(3))}: ${await procMem()} ${await page.evaluate(async () => JSON.stringify((await window.__penAgent('diagnose', {})).images ?? ''))}`);
}
await page.tracing.stop();
console.log(`after zooming: zoom ${await page.evaluate(() => window.__penStore.getState().view.zoom.toFixed(3))}; ${await procMem()}`);
await browser.close();
const raw = JSON.parse(fs.readFileSync(out, 'utf8'));
const ev = raw.traceEvents ?? raw;
const X = ev.filter(e => e.ph === 'X' && e.dur);
const sum = re => X.filter(e => re.test(e.name)).reduce((a, e) => a + e.dur, 0) / 1000;
const count = re => X.filter(e => re.test(e.name)).length;
const decode = /^ImageDecodeTask$/;
const upload = /^ImageUploadTask$/;
const big = X.filter(e => decode.test(e.name) && e.dur > 20000).length;
console.log(`picture decodes taking over 20ms: ${big}`);
console.log(`image decode/scale work: ${sum(decode).toFixed(0)}ms in ${count(decode)} tasks; image uploads: ${sum(upload).toFixed(0)}ms in ${count(upload)} tasks`);
console.log(`raster tasks: ${sum(/^RasterTask$|RasterizerTaskImpl::RunOnWorkerThread|GpuRasterization|Rasterize/).toFixed(0)}ms`);
const mainLong = X.filter(e => e.name === 'RunTask' && e.dur > 50000);
console.log(`main-thread tasks over 50ms: ${mainLong.length}, worst ${Math.round(Math.max(0, ...mainLong.map(e => e.dur)) / 1000)}ms, total ${(mainLong.reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0)}ms`);
console.log(`time to run each 10-step zoom stage (ideal ~${10 * 16}ms+): ${stageTimes.join(', ')}ms`);
const sums = new Map();
for (const e of X) sums.set(e.name, (sums.get(e.name) || 0) + e.dur);
console.log('top work by name:\n' + [...sums].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(7)}ms ${k}`).join('\n'));
fs.rmSync(out, { force: true });
