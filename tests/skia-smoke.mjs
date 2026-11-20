// Stage 0 of the Skia rework (docs/SKIA_REWORK.md): with pen.renderer=overview the Skia layer starts, draws a known
// rectangle that reads back from the GPU, survives a forced graphics-context loss, and falls back to the DOM renderer
// (frames still drawn, one toast) when the context never comes back. With the switch off, CanvasKit is not even
// downloaded. Usage: node skia-smoke.mjs <url of a .pen with frames>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url] = process.argv;
// Software WebGL for machines without a GPU (containers); harmless where a GPU exists.
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 120000, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }));
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
const waitFor = async (fn, ms = 30000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true;
    await sleep(100);
  }
  return false;
};
const open = async mode => {
  await page.evaluateOnNewDocument(m => localStorage.setItem('pen.renderer', m), mode);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
  await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
  await sleep(1500);
};
const canvaskitRequests = () => page.evaluate(() => performance.getEntriesByType('resource').filter(r => /canvaskit/i.test(r.name)).length);

// 1. Switch off: nothing Skia is loaded.
await open('dom');
ok('switch off: no Skia canvas and CanvasKit not downloaded', !(await page.$('#pen-skia')) && (await canvaskitRequests()) === 0, `${await canvaskitRequests()} CanvasKit requests`);

// 2. Switch on: the surface comes up and draws.
await open('overview');
const ready = await waitFor(() => window.__penSkia.skiaStatus().surface === 'ready');
const st = await page.evaluate(() => window.__penSkia.skiaStatus());
ok('overview: Skia surface ready', ready, JSON.stringify({ surface: st.surface, size: [st.width, st.height], dpr: st.dpr }));

/** Puts a red square at the canvas centre (world coordinates from the current view) and reads its middle pixel. */
const probe = () =>
  page.evaluate(async () => {
    const { view } = window.__penStore.getState();
    const c = document.getElementById('pen-skia');
    if (!c) return null;
    const sx = c.clientWidth / 2;
    const sy = c.clientHeight / 2;
    const size = 40 / view.zoom;
    window.__penSkia.setDebugRects([{ x: (sx - view.x) / view.zoom - size / 2, y: (sy - view.y) / view.zoom - size / 2, width: size, height: size, color: '#FF0000' }]);
    const dpr = window.__penSkia.skiaStatus().dpr;
    return window.__penSkia.readSkiaPixel(Math.round(sx * dpr), Math.round(sy * dpr));
  });
const isRed = px => !!px && px[0] > 240 && px[1] < 15 && px[2] < 15 && px[3] > 240;
const px1 = await probe();
ok('draws a known rectangle (GPU readback)', isRed(px1), JSON.stringify(px1));
const corner = await page.evaluate(() => window.__penSkia.readSkiaPixel(2, 2));
ok('the rest of the canvas is transparent', !!corner && corner[3] === 0, JSON.stringify(corner));

// 3. Context lost and restored: drawing recovers.
const loseCtx = restore =>
  page.evaluate(restore => {
    const c = document.getElementById('pen-skia');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const ext = gl.getExtension('WEBGL_lose_context');
    ext.loseContext();
    if (restore) setTimeout(() => ext.restoreContext(), 300);
    return !!ext;
  }, restore);
await loseCtx(true);
const sawLoss = await waitFor(() => window.__penSkia.skiaStatus().contextLosses >= 1, 5000);
const back = await waitFor(() => window.__penSkia.skiaStatus().surface === 'ready' && window.__penSkia.skiaStatus().restores >= 1, 10000);
const px2 = await probe();
ok('context loss is noticed and the surface rebuilt on restore', sawLoss && back, JSON.stringify(await page.evaluate(() => window.__penSkia.skiaStatus())));
ok('drawing recovers after the restore', isRed(px2), JSON.stringify(px2));

// 4. Lost for good: Skia draws in software, frames still drawn, one toast.
await page.evaluate(() => window.__penSkia.setDebugRects([]));
const framesBefore = await page.evaluate(() => document.querySelectorAll('#pen-world > [data-k]').length);
await loseCtx(false);
// Never restored: Skia goes on drawing in software, on a new canvas (no graphics card needed).
const fellBack = await waitFor(() => window.__penSkia.skiaStatus().mode === 'software' && window.__penSkia.skiaStatus().surface === 'ready', 12000);
await sleep(500);
const after = await page.evaluate(() => ({
  active: window.__penSkia.activeRenderer(),
  mode: window.__penSkia.skiaStatus().mode,
  canvas: !!document.getElementById('pen-skia'),
  frames: document.querySelectorAll('#pen-world > [data-k]').length,
  toast: window.__penStore.getState().toast?.text ?? null,
}));
ok('context never restored: Skia draws in software', fellBack && after.canvas && after.active !== 'dom', JSON.stringify({ active: after.active, mode: after.mode }));
ok('frames are still drawn after the fallback', after.frames > 0 && after.frames === framesBefore, `${framesBefore} -> ${after.frames} top-level frames`);
ok('the user is told once', /drawing in software/.test(after.toast ?? ''), after.toast ?? 'no toast');
const diag = await page.evaluate(() => window.__penAgent('diagnose', {}));
ok('diagnose_editor reports the renderer', diag.renderer?.requested === 'overview' && diag.renderer?.active === 'overview' && diag.renderer?.skia?.mode === 'software', JSON.stringify({ requested: diag.renderer?.requested, active: diag.renderer?.active, mode: diag.renderer?.skia?.mode }));
const px3 = await probe();
ok('and draws in software (readback of the known rectangle)', isRed(px3), JSON.stringify(px3));
await page.evaluate(() => window.__penSkia.setDebugRects([]));

await page.evaluate(() => localStorage.removeItem('pen.renderer'));
await browser.close();
