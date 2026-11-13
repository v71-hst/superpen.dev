// Zoom-sized pictures (src/render/imageLod.ts) and performance mode, on a file of 15 frames with large image fills
// (img15.pen: 1920x1080 frames filled with 2048-3840px pictures).
// Checks: pictures are never left blank, small copies are used zoomed out, the original only for what is on screen
// when zoomed in, exports still use the original, and performance mode unloads frames away from the viewport.
// Usage: node images.mjs <url of img15.pen> <screenshot dir>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, shotDir] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function open(flags = []) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.evaluateOnNewDocument(flags => { localStorage.setItem('pen.perfMode', '0'); for (const f of flags) localStorage.setItem(f, '1'); }, flags);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
  await sleep(5000);
  return page;
}
/** For every image fill on the canvas: the node, whether it is blank, and the pixel width of the picture in use. */
const fills = page =>
  page.evaluate(async () => {
    const out = [];
    for (const el of document.querySelectorAll('#pen-world [data-k]')) {
      const m = /url\("?([^")]+)"?\)/.exec(el.style.backgroundImage || '');
      if (!m) continue;
      const img = new Image();
      img.src = m[1];
      await img.decode().catch(() => {});
      const r = el.getBoundingClientRect();
      out.push({ key: el.dataset.k, blank: m[1].startsWith('data:image/gif'), w: img.naturalWidth, onScreen: r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight });
    }
    return out;
  });
const setView = (page, zoom, key) =>
  page.evaluate(
    (zoom, key) => {
      const st = window.__penStore;
      const n = st.getState().doc.children.find(x => x.id === key);
      const c = document.getElementById('pen-canvas').getBoundingClientRect();
      st.setState({ view: { zoom, x: c.width / 2 - (n.x + n.width / 2) * zoom, y: c.height / 2 - (n.y + n.height / 2) * zoom } });
    },
    zoom,
    key,
  );

const page = await open();
let f = await fills(page);
const zoom0 = await page.evaluate(() => window.__penStore.getState().view.zoom);
ok('every picture is shown (none left blank)', f.length >= 30 && f.every(x => !x.blank && x.w > 0), `${f.length} image fills at zoom ${zoom0.toFixed(3)}`);
ok('fit to screen uses small copies', Math.max(...f.map(x => x.w)) <= 1024, `widest picture in use: ${Math.max(...f.map(x => x.w))}px (originals are 2048-3840px)`);
await page.screenshot({ path: shotDir + '/images_fit.png' });

await setView(page, 1, 'f8');
await sleep(3000);
f = await fills(page);
const on = f.filter(x => x.onScreen && x.key.startsWith('f'));
const off = f.filter(x => !x.onScreen);
ok('at 100% the frame on screen is sharp', on.some(x => x.w >= 1920), `on screen: ${on.map(x => `${x.key} ${x.w}px`).join(', ')}`);
// The frame on screen and its direct neighbours (just outside the viewport) are sharpened; the rest stay small.
const sharp = f.filter(x => x.key.startsWith('f') && x.w >= 2048).map(x => x.key);
ok('only frames on or next to the screen are sharpened', sharp.length <= 6 && off.filter(x => x.w <= 1024).length >= 18, `sharp: ${sharp.join(' ')}; ${off.filter(x => x.w <= 1024).length} of ${off.length} off-screen fills are small copies`);
ok('still none blank after zooming', f.every(x => !x.blank));
await page.screenshot({ path: shotDir + '/images_100.png' });

await setView(page, 4, 'f8');
await sleep(3000);
f = await fills(page);
ok('zoomed in past the picture size: the original', f.find(x => x.key === 'f8')?.w === 3840, `f8 ${f.find(x => x.key === 'f8')?.w}px`);
await setView(page, 0.1, 'f8');
await sleep(3000);
f = await fills(page);
ok('zoomed back out: small copies again', Math.max(...f.map(x => x.w)) <= 512, `widest ${Math.max(...f.map(x => x.w))}px`);
const stats = await page.evaluate(async () => (await window.__penAgent('diagnose', {})).images);
ok('diagnose reports picture levels', stats.images === 15 && stats.levels >= 30, JSON.stringify(stats));

// Exports are made from the originals: identical to a build without zoom-sized pictures.
const exp = p => p.evaluate(async () => (await window.__penAgent('exportNode', { id: 'f3', format: 'png', scale: 1 })).dataUrl.length);
const ref = await open(['pen.debug.noImageLod']);
const [a, b] = [await exp(page), await exp(ref)];
ok('export uses the original picture', a === b && a > 500000, `${a} vs ${b} bytes of PNG`);
await ref.close();

// Performance mode: frames away from the viewport are unloaded.
const roots = () => page.evaluate(() => { const k = [...document.querySelectorAll('#pen-world > [data-k]')]; return { live: k.filter(e => !('placeholder' in e.dataset) && !('bitmap' in e.dataset)).length, placeholder: k.filter(e => 'placeholder' in e.dataset).length }; });
await setView(page, 1, 'f8');
await sleep(1500);
const before = await roots();
await page.click('.zoom-ctl .zbtn');
await sleep(2500);
const perf = await roots();
ok('performance mode toggle unloads far frames', before.live === 15 && perf.live <= 9 && perf.placeholder >= 6 && perf.live + perf.placeholder === 15, `live ${before.live} -> ${perf.live}, placeholders ${perf.placeholder}`);
f = await fills(page);
ok('placeholders show their background picture', f.filter(x => !x.blank).length >= perf.placeholder, `${f.length} fills, ${f.filter(x => x.blank).length} blank`);
await page.screenshot({ path: shotDir + '/images_perf.png' });
await setView(page, 1, 'f1');
await sleep(2500);
const moved = await roots();
const f1 = await page.evaluate(() => !!document.querySelector('#pen-world > [data-k="f1"]:not([data-placeholder])'));
ok('panning loads the frames that come into view', f1 && moved.live < 8, `f1 live: ${f1}, live ${moved.live}`);
await page.click('.zoom-ctl .zbtn');
await sleep(2000);
ok('turning it off loads everything again', (await roots()).live === 15);
await browser.close();
