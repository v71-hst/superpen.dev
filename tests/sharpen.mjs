// Skia's two sizes of pictures (src/skia/images.ts): zoomed out only the small version of each picture is held; a
// picture seen close up gets a larger version and then looks like the DOM renderer's; zoomed out again the larger
// versions are let go after a while; and at no point is a frame drawn as its flat colour while its picture changes.
// Usage: node sharpen.mjs <url of a make-big.mjs file with big pictures, e.g. make-big.mjs big2k.spen 60 3 12 2048> [shot dir]
// Needs the dev server (imports /src modules). Takes about a minute and a half: it waits for the idle drop.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { launchOptions } from './browser.mjs';
const [, , url, shots] = process.argv;
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
const errors = [];
const ZOOM = 3;

async function open(mode) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', e => errors.push(`${mode}: ${String(e).slice(0, 200)}`));
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}renderer=${mode}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
  await page.waitForFunction(() => window.__penStore && window.__penSkia, { timeout: 60000 });
  return page;
}

// Puts the largest picture-filled layer of the first few frames at the top left of the canvas, at `zoom`.
const closeUp = async zoom => {
  const s = window.__penStore.getState();
  let pic = null;
  const walk = n => {
    if (n.fill && n.fill.type === 'image' && typeof n.width === 'number' && typeof n.height === 'number' && (!pic || n.width * n.height > pic.width * pic.height)) pic = n;
    (n.children ?? []).forEach(walk);
  };
  s.doc.children.slice(0, 8).forEach(walk);
  if (!pic) return null;
  const m = await import('/src/editor/measure.ts');
  s.setView({ ...s.view, zoom });
  await new Promise(r => setTimeout(r, 300));
  const r = m.nodeScreenRect(pic.id);
  const v = window.__penStore.getState().view;
  s.setView({ x: v.x + 340 - r.x, y: v.y + 120 - r.y, zoom });
  await new Promise(r => setTimeout(r, 300));
  const q = m.nodeScreenRect(pic.id);
  return { id: pic.id, x: q.x, y: q.y, w: q.width, h: q.height };
};
const clipOf = r => ({ x: Math.round(r.x) + 4, y: Math.round(r.y) + 4, width: Math.min(900, Math.floor(r.w) - 8), height: Math.min(700, Math.floor(r.h) - 8) });
const status = page => page.evaluate(() => { const s = window.__penSkia.skiaStatus(); return { images: s.images, placeholders: s.overview.placeholders, pictures: { eligible: s.pictures.eligible, recorded: s.pictures.recorded, recordings: s.pictures.recordings }, copies: s.pictureImages, live: s.liveObjects.byKind.image ?? 0, gpu: s.gpu }; });
const until = async (page, fn, ms) => {
  const end = Date.now() + ms;
  for (;;) {
    const s = await status(page);
    if (fn(s) || Date.now() > end) return s;
    await sleep(250);
  }
};

// --- reference: the DOM renderer, same view
const dom = await open('dom');
const domRect = await dom.evaluate(closeUp, ZOOM);
if (!domRect) {
  console.log('FAIL the file has no picture fills');
  process.exit(1);
}
await sleep(10000); // the DOM renderer sharpens its pictures progressively too
const domShot = await dom.screenshot({ clip: clipOf(domRect), encoding: 'base64' });
await dom.close();

// --- full, opened zoomed out
const page = await open('full');
const far = () => window.__penStore.getState().setView({ x: 20, y: 20, zoom: 0.05 });
await page.evaluate(far);
// Everything recorded and copied ahead of need, so later counts are about pictures changing size only.
const opened = await until(page, s => s.images.ready > 0 && !s.images.loading && s.pictures.recorded >= s.pictures.eligible && s.copies.images >= s.pictures.eligible, 60000);
ok('zoomed out, every frame is recorded from the small versions alone', opened.images.ready > 0 && opened.images.larger === 0 && opened.pictures.recorded >= opened.pictures.eligible, JSON.stringify(opened.images));

// --- close up: the picture in view gets a larger version
const rect = await page.evaluate(closeUp, ZOOM);
const sharp = await until(page, s => s.images.larger > 0 && !s.images.sharpening, 20000);
await sleep(400);
ok('close up, a larger version is loaded for what is in view', sharp.images.larger > 0 && sharp.images.larger < sharp.images.ready, JSON.stringify(sharp.images));
const sharpShot = await page.screenshot({ clip: clipOf(rect), encoding: 'base64' });
const cmp = await page.evaluate(async (a, b) => {
  const t = await import('/src/editor/imageTools.ts');
  const [x, y] = await Promise.all([a, b].map(s => t.loadImageData('data:image/png;base64,' + s)));
  // Edge energy: a blurry drawing of the generated pictures' fine checker has much less of it than a sharp one.
  const detail = d => { let e = 0; for (let i = 4; i < d.data.length; i += 4) e += Math.abs(d.data[i + 1] - d.data[i - 3]); return e / (d.data.length / 4); };
  const m = t.compare(x, y);
  return { match: Number(m.text.match(/match ([\d.]+)%/)?.[1] ?? 0), image: m.dataUrl, dom: detail(x), sharp: detail(y) };
}, domShot, sharpShot);
if (shots) {
  fs.writeFileSync(`${shots}/sharpen-dom.png`, Buffer.from(domShot, 'base64'));
  fs.writeFileSync(`${shots}/sharpen-full.png`, Buffer.from(sharpShot, 'base64'));
  fs.writeFileSync(`${shots}/sharpen-diff.png`, Buffer.from(cmp.image.split(',')[1], 'base64'));
}
ok('the picture then looks like the DOM renderer shows it', cmp.match >= 97 && cmp.dom > 1 && cmp.sharp >= cmp.dom * 0.85, `${cmp.match}% match; fine detail: dom ${cmp.dom.toFixed(2)}, full ${cmp.sharp.toFixed(2)}`);
ok('no frame was drawn as its flat colour meanwhile', sharp.placeholders === opened.placeholders, `${opened.placeholders} -> ${sharp.placeholders} placeholder draws`);
// The file's few pictures are shared by all its frames: only the frames in view take the larger version.
const rerecorded = sharp.pictures.recordings - opened.pictures.recordings;
ok('frames out of view keep their recordings', rerecorded > 0 && rerecorded <= 10, `${rerecorded} of ${sharp.pictures.eligible} frames recorded again`);

// --- panning along at the same zoom brings in others without dropping what is on screen
await page.evaluate(() => { const s = window.__penStore.getState(); s.setView({ ...s.view, y: s.view.y - 500 }); });
const panned = await until(page, s => !s.images.sharpening, 15000);
ok('every CanvasKit image is accounted for', panned.live === panned.copies.levelImages + panned.images.held, `${panned.live} live = ${panned.copies.levelImages} in copies + ${panned.images.held} pictures (${panned.images.ready} small, ${panned.images.larger} larger)`);

// --- zoomed out again: copies are remade from the sharp pictures without a flash, then the larger versions go
await page.evaluate(far);
await sleep(1500);
const out = await status(page);
ok('zooming out again draws no flat-colour frames', out.placeholders === opened.placeholders, `${opened.placeholders} -> ${out.placeholders} placeholder draws`);
const dropped = await until(page, s => s.images.larger === 0, 60000);
await sleep(1500);
const end = await status(page);
ok('larger versions nothing needs are let go', dropped.images.larger === 0 && dropped.images.dropped > 0, JSON.stringify(dropped.images));
ok('and the frames stay drawn while their pictures are recorded again', end.placeholders === opened.placeholders && end.live === end.copies.levelImages + end.images.held, `${opened.placeholders} -> ${end.placeholders} placeholder draws; ${end.live} live images = ${end.copies.levelImages} + ${end.images.held}`);
const farShot = await page.screenshot({ encoding: 'base64' });
const filled = await page.evaluate(async b => {
  const t = await import('/src/editor/imageTools.ts');
  const d = await t.loadImageData('data:image/png;base64,' + b);
  const bg = [...d.data.slice((d.width * 450 + 1380) * 4, (d.width * 450 + 1380) * 4 + 3)];
  let differ = 0, n = 0;
  for (let y = 60; y < 300; y += 12) for (let x = 60; x < 500; x += 12) { n++; const i = (y * d.width + x) * 4; if (Math.abs(d.data[i] - bg[0]) + Math.abs(d.data[i + 1] - bg[1]) + Math.abs(d.data[i + 2] - bg[2]) > 12) differ++; }
  return { differ, n };
}, farShot);
if (shots) fs.writeFileSync(`${shots}/sharpen-far.png`, Buffer.from(farShot, 'base64'));
ok('frames are still painted', filled.differ > filled.n * 0.3, `${filled.differ}/${filled.n} samples painted`);
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
