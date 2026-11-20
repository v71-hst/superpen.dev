// Still shader fills are drawn by Skia from an image of the shader's output (src/skia/shaderFills.ts); animated ones
// from a live texture (src/skia/liveShaders.ts). Checks: every frame of a design full of still shader fills is drawn
// by Skia, the fill is really on the canvas, a larger version arrives when zoomed in, changing a uniform updates the
// picture without the frame leaving Skia or blinking, and a frame with an animated shader stays with Skia and moves.
// Usage: node shaderfill.mjs <url of a make-shaders.mjs design> [shot dir]     (dev server or PEN_PROD)
import puppeteer from 'puppeteer-core';
import pngjs from 'pngjs';
import fs from 'node:fs';
import { launchOptions } from './browser.mjs';
const { PNG } = pngjs;
const [, , url, shots] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900 });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await page.goto(`${url}${url.includes('?') ? '&' : '?'}renderer=full`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__penStore?.getState().doc && window.__penAgent, { timeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (name, cond, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (!cond) process.exitCode = 1;
};
const diag = () => page.evaluate(() => window.__penAgent('diagnose').then(d => ({ active: d.renderer.active, pictures: d.renderer.skia?.pictures, images: d.renderer.skia?.images, all: d.canvas.all, onScreen: d.canvas.onScreen })));
const settle = async (want, ms = 15000) => {
  const until = Date.now() + ms;
  let d;
  do {
    await sleep(200);
    d = await diag();
  } while (!want(d) && Date.now() < until);
  return d;
};
// The colour in the middle of a small square of the window (what is really on screen: the Skia canvas).
const pixel = async (x, y) => {
  const png = PNG.sync.read(Buffer.from(await page.screenshot({ clip: { x: x - 2, y: y - 2, width: 4, height: 4 } })));
  return [png.data[0], png.data[1], png.data[2]];
};
const spread = c => Math.max(...c) - Math.min(...c);

const opened = await settle(d => d.images?.loading === 0 && d.pictures?.recorded >= d.pictures?.eligible && d.pictures?.eligible > 0 && d.images.made > 0);
const frames = await page.evaluate(() => window.__penStore.getState().doc.children.length);
ok('every frame with still shader fills is drawn by Skia', opened.active === 'full' && opened.pictures.eligible === frames && opened.all.live === 0 && opened.all.skia === frames, JSON.stringify({ frames, eligible: opened.pictures?.eligible, canvas: opened.all, reasons: opened.pictures?.reasons }));
ok('the shaders were run into images', opened.images.made > 0 && opened.images.failed === 0, `${opened.images.made} images, ${opened.images.smallMB} MB`);

// Close up on the first frame: its top shader fill covers the top of the frame.
await page.evaluate(() => {
  const f = window.__penStore.getState().doc.children[0];
  window.__penStore.getState().setView({ zoom: 0.9, x: 80 - f.x * 0.9, y: 80 - f.y * 0.9 });
});
const close = await settle(d => d.images.sharpening === 0 && d.images.larger > 0, 8000);
await sleep(400);
if (shots) await page.screenshot({ path: `${shots}/shaderfill-close.png` });
// Noise in a tint over near-black: sample a few spots of the fill; some must be coloured, and none white or blank.
const spots = [];
for (const [dx, dy] of [[60, 60], [150, 120], [250, 200], [320, 90], [100, 230]]) spots.push(await pixel(80 + dx, 80 + dy));
ok('the fill is on the canvas (coloured noise, not blank)', spots.some(c => spread(c) > 60) && new Set(spots.map(c => c.join())).size >= 3, JSON.stringify(spots));
ok('a larger version is made when the fill is shown large', close.images.larger > 0 && close.onScreen.live === 0, JSON.stringify({ larger: close.images.larger, onScreen: close.onScreen }));

// Changing an input: another picture is made, the frame stays with Skia, and what is on screen never goes blank.
const before = [];
for (const [dx, dy] of [[60, 60], [150, 120], [250, 200], [320, 90], [100, 230]]) before.push(await pixel(80 + dx, 80 + dy));
const firstFill = await page.evaluate(() => { const f = window.__penStore.getState().doc.children[0]; const n = f.children.find(c => c.fill && c.fill.type === 'shader'); return { id: n.id, fill: n.fill }; });
let blank = 0;
const watch = (async () => { for (let i = 0; i < 14; i++) { const c = await pixel(80 + 150, 80 + 120); const d = await diag(); if (d.onScreen.live > 0 || d.onScreen.placeholder > 0) blank++; void c; await sleep(40); } })();
await page.evaluate(n => window.__penAgent('applyOps', { operations: [{ op: 'update', id: n.id, props: { fill: { ...n.fill, uniforms: { ...n.fill.uniforms, u_tint: '#FFFFFF', u_scale: 9 } } } }] }), firstFill);
await watch;
await sleep(1200);
const after = [];
for (const [dx, dy] of [[60, 60], [150, 120], [250, 200], [320, 90], [100, 230]]) after.push(await pixel(80 + dx, 80 + dy));
const afterDiag = await diag();
ok('changing a uniform redraws the fill', after.some(c => c[0] > 150 && spread(c) < 40) && JSON.stringify(after) !== JSON.stringify(before), JSON.stringify({ before, after }));
ok('the frame stays with Skia while it changes', blank === 0 && afterDiag.onScreen.live === 0, `${blank} moments off Skia; ${JSON.stringify(afterDiag.onScreen)}`);
if (shots) await page.screenshot({ path: `${shots}/shaderfill-edited.png` });

// An animated shader (one that reads the time) is drawn from a live texture (src/skia/liveShaders.ts): its frame
// stays with Skia, and what is on screen moves.
await page.evaluate(async () => {
  const f = window.__penStore.getState().doc.children[1];
  const n = f.children.find(c => c.fill && c.fill.type === 'shader');
  // make-shaders.mjs writes this file next to the design.
  await window.__penAgent('applyOps', { operations: [{ op: 'update', id: n.id, props: { fill: { type: 'shader', url: './shaders/moving.glsl' } } }] });
});
await page.evaluate(() => {
  const f = window.__penStore.getState().doc.children[1];
  window.__penStore.getState().setView({ zoom: 0.9, x: 80 - f.x * 0.9, y: 80 - f.y * 0.9 });
});
const moving = await settle(d => d.all.live === 0 && Object.keys(d.pictures.reasons ?? {}).length === 0, 8000);
await sleep(1500);
const t0 = await pixel(80 + 150, 80 + 120);
await sleep(700);
const t1 = await pixel(80 + 150, 80 + 120);
ok('a frame with an animated shader stays with Skia, and the shader moves', moving.all.live === 0 && Object.keys(moving.pictures.reasons ?? {}).length === 0 && t0.join() !== t1.join(), JSON.stringify({ reasons: moving.pictures.reasons, canvas: moving.all, t0, t1 }));
ok('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
await browser.close();
