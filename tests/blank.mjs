// Frames must never vanish because a snapshot or one of its smaller copies came out blank (what a GPU-backed canvas
// returns after the graphics process hiccups). This sabotages canvas drawing the same way and checks, by sampling a
// screenshot of the page, that every frame with a fill still shows something when zoomed far out.
// Usage: node blank.mjs <url of a big file> <screenshot dir>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
const [, , url, shotDir] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run(label, sabotage) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.evaluateOnNewDocument(mode => {
    localStorage.setItem('pen.perfMode', '0');
    // The 16×16 canvas is the editor's own blank probe and must keep working.
    const probe = c => c.width === 16 && c.height === 16;
    if (mode === 'levels') {
      // Every scaled copy (snapshot levels and picture levels) is drawn on an OffscreenCanvas: make those draws no-ops.
      const d = OffscreenCanvasRenderingContext2D.prototype.drawImage;
      OffscreenCanvasRenderingContext2D.prototype.drawImage = function (...a) { if (probe(this.canvas)) return d.apply(this, a); };
    }
    if (mode === 'snapshots') {
      // Snapshots are an SVG image drawn onto a canvas: make drawing SVG images a no-op.
      const d = CanvasRenderingContext2D.prototype.drawImage;
      CanvasRenderingContext2D.prototype.drawImage = function (src, ...a) { if (src instanceof HTMLImageElement && src.src.startsWith('data:image/svg')) return; return d.call(this, src, ...a); };
    }
  }, sabotage);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
  // Opens zoomed far out: wait for the background snapshot work to go quiet.
  for (let quiet = 0, t = 0; quiet < 4 && t < 120; t++) {
    await sleep(800);
    quiet = (await page.evaluate(async () => { const r = await window.__penAgent('diagnose', {}); return r.lod.queued + r.lod.levelQueue + (r.lod.working ? 1 : 0); })) ? 0 : quiet + 1;
  }
  await sleep(2500);
  const shot = await page.screenshot({ encoding: 'base64' });
  fs.writeFileSync(`${shotDir}/blank_${sabotage || 'none'}.png`, Buffer.from(shot, 'base64'));
  const r = await page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    // The page's drawImage may be sabotaged for SVG images only; this is a PNG.
    g.drawImage(img, 0, 0);
    const cr = document.getElementById('pen-canvas').getBoundingClientRect();
    const st = window.__penStore.getState();
    const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; };
    const bg = px(cr.left + cr.width / 2, cr.bottom - 3);
    const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 8;
    const out = { zoom: st.view.zoom, checked: 0, kinds: {}, invisible: [] };
    for (const el of document.querySelectorAll('#pen-world > [data-k]')) {
      const node = st.doc.children.find(x => x.id === el.dataset.k);
      // Only frames that paint their whole box in a colour clearly different from the canvas can be judged.
      if (!node || node.type !== 'frame' || node.fill === undefined || node.fill === '#00000000') continue;
      const b = el.getBoundingClientRect();
      const x0 = Math.max(b.left, cr.left + 60), x1 = Math.min(b.right, cr.right - 60), y0 = Math.max(b.top, cr.top + 30), y1 = Math.min(b.bottom, cr.bottom - 60);
      if (x1 - x0 < 10 || y1 - y0 < 8) continue;
      const kind = 'bitmap' in el.dataset ? 'bitmap' : 'placeholder' in el.dataset ? 'placeholder' : 'live';
      out.checked++;
      out.kinds[kind] = (out.kinds[kind] ?? 0) + 1;
      let same = 0, n = 0;
      for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) { n++; if (near(px(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * j) / 6), bg)) same++; }
      if (same === n) out.invisible.push(`${el.dataset.k} (${kind})`);
    }
    const d = await window.__penAgent('diagnose', {});
    return { ...out, lod: d.lod, blankSnapshots: d.blankSnapshots ?? { blank: 0, note: 'not reported by this build' }, images: d.images ?? {} };
  }, shot);
  console.log(`-- ${label}: zoom ${r.zoom}, ${r.checked} filled frames on screen ${JSON.stringify(r.kinds)}; lod ${JSON.stringify({ bitmaps: r.lod.bitmaps, levels: r.lod.levels, blankSnapshots: r.lod.blankSnapshots, blankLevels: r.lod.blankLevels, liveOnly: r.lod.liveOnly })}; pictures failed ${r.images.failed}; diagnose blank check ${JSON.stringify(r.blankSnapshots)}`);
  await page.close();
  return r;
}

const base = await run('no sabotage', '');
ok('baseline: every filled frame is visible', base.checked >= 10 && base.invisible.length === 0, `${base.checked} checked, invisible: ${base.invisible.slice(0, 5).join(', ') || 'none'}`);
ok('baseline: nothing reported blank', base.lod.blankSnapshots === 0 && base.lod.blankLevels === 0 && base.blankSnapshots.blank === 0);

const lv = await run('scaled copies come out blank', 'levels');
ok('blank copies are detected', lv.lod.blankLevels > 0, `${lv.lod.blankLevels} blank levels refused`);
ok('frames stay visible (their snapshot is shown instead)', lv.checked >= 10 && lv.invisible.length === 0, `${lv.checked} checked, invisible: ${lv.invisible.slice(0, 5).join(', ') || 'none'}`);
ok('pictures fall back to the original', lv.images.failed > 0, `${lv.images.failed} pictures shown as-is`);

const sn = await run('snapshots come out blank', 'snapshots');
ok('blank snapshots are detected and not used', sn.lod.blankSnapshots > 0 && sn.blankSnapshots.blank === 0, `${sn.lod.blankSnapshots} refused, ${sn.lod.liveOnly} frames kept live`);
ok('frames stay visible (kept live or as their background)', sn.checked >= 10 && sn.invisible.length === 0, `${sn.checked} checked, invisible: ${sn.invisible.slice(0, 5).join(', ') || 'none'}`);
await browser.close();
