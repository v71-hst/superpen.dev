// Stage 1 of the Skia rework (docs/SKIA_REWORK.md): with pen.renderer=overview, zoomed-out snapshot frames are drawn
// on the Skia canvas instead of as <img> elements. Checks, by sampling page screenshots, that every filled frame on
// screen still shows, that Skia-drawn frames mount no <img>, that a moved frame is drawn where it now is, that zooming
// in brings frames back live, and that losing the graphics context for good puts the snapshot images back.
// Usage: node overview.mjs <url of a big file (tests/make-big.mjs)> <screenshot dir>
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { launchOptions } from './browser.mjs';
const [, , url0, shotDir] = process.argv;
const url = url0 + (url0.includes('?') ? '&' : '?') + 'renderer=overview';
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.evaluateOnNewDocument(() => localStorage.setItem('pen.perfMode', '0'));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
const diag = () => page.evaluate(() => window.__penAgent('diagnose', {}));

/** Waits until snapshots and textures are done (or 3 minutes). */
async function settle() {
  for (let quiet = 0, t = 0; quiet < 4 && t < 220; t++) {
    await sleep(800);
    const busy = await page.evaluate(async () => {
      const r = await window.__penAgent('diagnose', {});
      return r.lod.queued + (r.lod.working ? 1 : 0) + (r.renderer.skia.overview?.pending ?? 0);
    });
    quiet = busy ? 0 : quiet + 1;
  }
  await sleep(800);
}

/** Screenshot, then for every filled top-level frame on screen: is any of 25 sample points not the canvas colour? */
async function visibility(label) {
  const shot = await page.screenshot({ encoding: 'base64' });
  if (shotDir) fs.writeFileSync(`${shotDir}/overview_${label}.png`, Buffer.from(shot, 'base64'));
  return page.evaluate(async b64 => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const cr = document.getElementById('pen-canvas').getBoundingClientRect();
    const st = window.__penStore.getState();
    const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return [d[0], d[1], d[2]]; };
    const bg = px(cr.left + cr.width / 2, cr.bottom - 3);
    const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 8;
    const out = { checked: 0, kinds: {}, invisible: [], skiaKeys: [] };
    for (const el of document.querySelectorAll('#pen-world > [data-k]')) {
      const node = st.doc.children.find(x => x.id === el.dataset.k);
      if (!node || node.type !== 'frame' || node.fill === undefined) continue;
      const b = el.getBoundingClientRect();
      const x0 = Math.max(b.left, cr.left + 60), x1 = Math.min(b.right, cr.right - 60), y0 = Math.max(b.top, cr.top + 30), y1 = Math.min(b.bottom, cr.bottom - 60);
      if (x1 - x0 < 6 || y1 - y0 < 6) continue;
      const kind = 'skia' in el.dataset ? 'skia' : 'bitmap' in el.dataset ? 'bitmap' : 'placeholder' in el.dataset ? 'placeholder' : 'live';
      if (kind === 'skia') out.skiaKeys.push(el.dataset.k);
      out.checked++;
      out.kinds[kind] = (out.kinds[kind] ?? 0) + 1;
      let same = 0, n = 0;
      for (let i = 1; i <= 5; i++) for (let j = 1; j <= 5; j++) { n++; if (near(px(x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * j) / 6), bg)) same++; }
      if (same === n) out.invisible.push(`${el.dataset.k} (${kind})`);
    }
    return out;
  }, shot);
}

await settle();
let d = await diag();
ok('Skia surface ready in overview mode', d.renderer.active === 'overview' && d.renderer.skia.surface === 'ready', JSON.stringify({ active: d.renderer.active, surface: d.renderer.skia.surface }));
const v1 = await visibility('zoomed_out');
ok('zoomed out, frames are drawn by Skia', (v1.kinds.skia ?? 0) >= 10, `${v1.checked} filled frames on screen ${JSON.stringify(v1.kinds)}; overview ${JSON.stringify(d.renderer.skia.overview)}`);
ok('every filled frame on screen is visible', v1.checked >= 10 && v1.invisible.length === 0, `invisible: ${v1.invisible.slice(0, 5).join(', ') || 'none'}`);
const imgs = await page.evaluate(keys => keys.filter(k => document.querySelector(`#pen-world > img[data-k="${CSS.escape(k)}"]`)).length, v1.skiaKeys);
const allImgs = await page.evaluate(() => document.querySelectorAll('#pen-world > img[data-bitmap]').length);
ok('Skia-drawn frames mount no <img>', imgs === 0, `${imgs} of ${v1.skiaKeys.length} Skia frames have an <img>; ${allImgs} snapshot <img>s in the page`);
ok('textures are counted as live CanvasKit images', (d.renderer.skia.liveObjects.byKind.image ?? 0) === d.renderer.skia.overview.textures, JSON.stringify(d.renderer.skia.liveObjects));
ok('no scaled snapshot copies are made', d.lod.levels === d.lod.bitmaps, `${d.lod.bitmaps} snapshots, ${d.lod.levels} levels`);

// Move a Skia-drawn frame to an empty spot (the same document edit a drag makes): Skia must draw it there.
const moved = await page.evaluate(async key => {
  const s = window.__penStore.getState();
  const xs = s.doc.children.map(n => n.x + (n.width ?? 0));
  const ys = s.doc.children.map(n => n.y);
  const to = { x: Math.max(...xs) + 600, y: Math.min(...ys) };
  s.edit(dd => { const n = dd.children.find(c => c.id === key); n.x = to.x; n.y = to.y; });
  const { view } = window.__penStore.getState();
  const n = window.__penStore.getState().doc.children.find(c => c.id === key);
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  // Keep the moved frame on screen.
  const cr = document.getElementById('pen-canvas').getBoundingClientRect();
  const sx = n.x * view.zoom + view.x, sy = n.y * view.zoom + view.y;
  if (sx + n.width * view.zoom > cr.width - 80) {
    const dx = cr.width - 80 - (sx + n.width * view.zoom);
    s.setView({ ...view, x: view.x + dx });
  }
  s.select([]);
  return key;
}, v1.skiaKeys[0]);
await sleep(600);
const v2 = await visibility('moved');
const movedKind = await page.evaluate(k => { const el = document.querySelector(`#pen-world > [data-k="${CSS.escape(k)}"]`); return el ? ('skia' in el.dataset ? 'skia' : 'bitmap' in el.dataset ? 'bitmap' : 'other') : 'missing'; }, moved);
ok('a moved frame is drawn at its new place', !v2.invisible.includes(`${moved} (skia)`) && v2.invisible.length === 0 && movedKind === 'skia', `${moved} is ${movedKind}; invisible: ${v2.invisible.slice(0, 5).join(', ') || 'none'}`);

// Zoom in on one frame: frames go live again.
await page.evaluate(() => {
  const s = window.__penStore.getState();
  const f = s.doc.children[30];
  s.setView({ x: 400 - f.x * 0.6, y: 60 - f.y * 0.6, zoom: 0.6 });
});
await sleep(3000);
const v3 = await visibility('zoomed_in');
ok('zoomed in past 33%, on-screen frames are live', (v3.kinds.live ?? 0) > 0 && !v3.kinds.skia && v3.invisible.length === 0, JSON.stringify(v3.kinds));
// Off-screen frames go live a few per frame (on-screen first); until their turn they keep their snapshot.
const waiting1 = (await diag()).renderer.skia.overview.framesDrawn;
await sleep(6000);
const waiting2 = (await diag()).renderer.skia.overview.framesDrawn;
ok('zoomed in, Skia only draws off-screen frames still waiting to go live, fewer over time', waiting2 < waiting1 || waiting2 === 0, `${waiting1} -> ${waiting2} frames drawn by Skia`);

// Back out, then lose the graphics context for good: snapshots come back as images, nothing vanishes.
await page.evaluate(() => {
  const s = window.__penStore.getState();
  s.setView({ x: 60, y: 40, zoom: 0.06 });
});
await settle();
const v4 = await visibility('zoomed_out_again');
await page.evaluate(() => {
  const c = document.getElementById('pen-skia');
  (c.getContext('webgl2') || c.getContext('webgl')).getExtension('WEBGL_lose_context').loseContext();
});
await sleep(1500);
const v5 = await visibility('context_lost');
ok('while the context is lost, frames show their snapshot images', (v4.kinds.skia ?? 0) > 0 && !v5.kinds.skia && (v5.kinds.bitmap ?? 0) > 0 && v5.invisible.length === 0, `before ${JSON.stringify(v4.kinds)} -> lost ${JSON.stringify(v5.kinds)}; invisible: ${v5.invisible.slice(0, 5).join(', ') || 'none'}`);
await sleep(6000);
d = await diag();
const v6 = await visibility('fell_back');
ok('context never restored: DOM renderer, frames still visible', d.renderer.active === 'dom' && !v6.kinds.skia && v6.checked >= 10 && v6.invisible.length === 0, `${JSON.stringify(v6.kinds)}; invisible: ${v6.invisible.slice(0, 5).join(', ') || 'none'}`);
ok('textures freed after the fallback', (d.renderer.skia.liveObjects.byKind.image ?? 0) === 0, JSON.stringify(d.renderer.skia.liveObjects));
await browser.close();
