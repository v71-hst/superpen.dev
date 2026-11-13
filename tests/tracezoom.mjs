// Traces hover and sums renderer event durations by name.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
const [, , url, out] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await new Promise(r => setTimeout(r, 3000));
await page.mouse.move(900, 500);
await new Promise(r => setTimeout(r, 1000));
if (process.argv[4] === 'nohover') await page.evaluate(() => { const s = window.__penStore; const orig = s.getState().set; s.setState({ set: p => (p && 'hover' in p ? undefined : orig(p)) }); });
await page.tracing.start({ path: out, categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink', 'cc', 'viz'] });
for (let i = 0; i < 60; i++) { await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: 40 }); await page.keyboard.up('Control'); await new Promise(r => setTimeout(r, 16)); }
await new Promise(r => setTimeout(r, 600));
await page.tracing.stop();
await browser.close();
const ev = JSON.parse(fs.readFileSync(out, 'utf8')).traceEvents ?? JSON.parse(fs.readFileSync(out, 'utf8'));
const sums = new Map();
for (const e of ev) if (e.ph === 'X' && e.dur) sums.set(e.name, (sums.get(e.name) || 0) + e.dur);
console.log([...sums].sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(7)}ms ${k}`).join('\n'));

const long = ev.filter(e => e.ph === 'X' && e.dur > 200000).sort((a, b) => b.dur - a.dur).slice(0, 10);
console.log('--- events > 200ms'); for (const e of long) console.log((e.dur/1000).toFixed(0).padStart(6)+'ms', e.name, e.tid, JSON.stringify(e.args).slice(0, 160));
