// Finds top-level frames the editor believes it is drawing but that show nothing on screen. After each step of a
// zoom/pan session it screenshots the page and, for every frame on screen, samples the pixels inside its rectangle:
// a frame whose area is all canvas background (while it has a fill, picture or snapshot) is reported with how it is
// being drawn. Usage: node invisible.mjs <url> <screenshot dir> [flags=a,b] [perf=0|1]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, shotDir, flags = '', perf = '0'] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.evaluateOnNewDocument((flags, perf) => { localStorage.setItem('pen.perfMode', perf); for (const f of flags) localStorage.setItem(f, '1'); }, flags.split(',').filter(Boolean), perf);
const sleep = ms => new Promise(r => setTimeout(r, ms));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });

let step = 0;
async function check(label, wait = 2500) {
  await sleep(wait);
  const shot = await page.screenshot({ encoding: 'base64' });
  const r = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const canvasEl = document.getElementById('pen-canvas');
    const cr = canvasEl.getBoundingClientRect();
    const st = window.__penStore.getState();
    // The canvas background: the most common colour along the bottom edge of the canvas, away from panels.
    const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; };
    const bg = px(cr.left + cr.width / 2, cr.bottom - 3);
    const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 10;
    const out = { zoom: +st.view.zoom.toFixed(4), onScreen: 0, invisible: [], kinds: {} };
    for (const el of document.querySelectorAll('#pen-world > [data-k]')) {
      const b = el.getBoundingClientRect();
      const x0 = Math.max(b.left, cr.left + 60), x1 = Math.min(b.right, cr.right - 60), y0 = Math.max(b.top, cr.top + 30), y1 = Math.min(b.bottom, cr.bottom - 60);
      if (x1 - x0 < 10 || y1 - y0 < 8) continue;
      const kind = 'bitmap' in el.dataset ? 'bitmap' : 'placeholder' in el.dataset ? 'placeholder' : 'live';
      out.onScreen++;
      out.kinds[kind] = (out.kinds[kind] ?? 0) + 1;
      let same = 0, n = 0;
      for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) { n++; if (near(px(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * j) / 6), bg)) same++; }
      if (same < n) continue;
      const node = st.doc.children.find(x => x.id === el.dataset.k);
      // Frames with no fill of their own and nothing but outlines can legitimately look empty: only report filled ones.
      if (!node || (node.fill === undefined && kind !== 'bitmap')) continue;
      out.invisible.push({ key: el.dataset.k, name: (node.name ?? '').slice(0, 40), kind, rect: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], cv: el.style.contentVisibility || '', img: el.tagName === 'IMG' ? { ok: el.complete && el.naturalWidth > 0, nw: el.naturalWidth, src: el.currentSrc.slice(0, 30) } : undefined, bgImg: (el.style.backgroundImage || '').slice(0, 60), fill: JSON.stringify(node.fill ?? null).slice(0, 60) });
    }
    return out;
  }, shot);
  step++;
  const tag = r.invisible.length ? 'INVISIBLE' : 'ok';
  console.log(`${String(step).padStart(2)}. ${label}: zoom ${r.zoom}, ${r.onScreen} frames on screen ${JSON.stringify(r.kinds)} -> ${tag} ${r.invisible.length}`);
  for (const x of r.invisible.slice(0, 4)) console.log('      ' + JSON.stringify(x));
  if (r.invisible.length) (await import('node:fs')).writeFileSync(`${shotDir}/invisible_${step}.png`, Buffer.from(shot, 'base64'));
  return r;
}
const view = fn => page.evaluate(fn);
const wheel = async (dy, n, x = 800, y = 500) => { await page.mouse.move(x, y); for (let i = 0; i < n; i++) { await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: dy }); await page.keyboard.up('Control'); await sleep(16); } };
const scroll = async (dx, dy, n) => { for (let i = 0; i < n; i++) { await page.mouse.wheel({ deltaX: dx, deltaY: dy }); await sleep(16); } };

const centre = (key, zoom) =>
  page.evaluate(
    (key, zoom) => {
      const st = window.__penStore;
      const n = st.getState().doc.children.find(x => x.id === key);
      const c = document.getElementById('pen-canvas').getBoundingClientRect();
      st.setState({ view: { zoom, x: c.width / 2 - (n.x + (n.width ?? 0) / 2) * zoom, y: c.height / 2 - (n.y + (n.height ?? 0) / 2) * zoom } });
    },
    key,
    zoom,
  );
const lod = () => page.evaluate(async () => { const d = await window.__penAgent('diagnose', {}); return JSON.stringify({ bitmaps: d.lod.bitmaps, queued: d.lod.queued, fail: d.lod.renderFailures, images: d.images }); });
await check('opened (fit)', 9000);
// Work on real frames the way a person does: zoom in on some, then back out so their snapshots are made from the
// live frames (not from the off-screen staging copy used when a file is first opened zoomed out).
for (const key of ['wBdZg', 'p9Yof', 'bHRyr', 'HSVA']) {
  await centre(key, 0.6); await check(`at 60% on ${key}`, 3500);
  await centre(key, 0.25); await check(`out to 25% on ${key}`, 9000);
  await centre(key, 0.05); await check(`out to 5% on ${key}`, 6000);
}
console.log('    ' + (await lod()));
await centre('wBdZg', 0.02); await check('far out (2%) near the reworks', 8000);
await page.screenshot({ path: shotDir + '/invisible_far1.png' });
await centre('bHRyr', 0.02); await check('far out (2%) near the datapads', 8000);
await page.screenshot({ path: shotDir + '/invisible_far2.png' });
console.log('    ' + (await lod()));
await browser.close();
