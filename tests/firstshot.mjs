// The first capture of a picture must not come out blank. Pictures are made to load slowly (as they do inside
// VS Code), then a picture layer is measured and screenshotted straight after the page opens, before anything has
// had a reason to load it. Seen in VS Code on 2026-11-19: analyze_image on an image layer said "transparent 100%".
// Usage: node firstshot.mjs <url of a design with picture fills, e.g. img15.pen> [delay ms, default 1500]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, delay = '1500'] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
// Slow pictures: every picture file takes `delay` ms longer to arrive.
await page.setRequestInterception(true);
let slowed = 0;
page.on('request', req => {
  const u = req.url();
  if (/\.(png|jpe?g|webp)(\?|$|&)/i.test(decodeURIComponent(u)) && !u.startsWith('data:')) {
    slowed++;
    setTimeout(() => req.continue().catch(() => {}), Number(delay));
  } else req.continue().catch(() => {});
});
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__penStore?.getState().doc && window.__penAgent, { timeout: 60000 });
const ok = (name, cond, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (!cond) process.exitCode = 1;
};
// Two picture layers that are far from what is on screen, so nothing has loaded their pictures yet.
const ids = await page.evaluate(() => {
  const out = [];
  const walk = n => {
    const fills = Array.isArray(n.fill) ? n.fill : [n.fill];
    if (fills.some(f => f && typeof f === 'object' && f.type === 'image' && f.url && !String(f.url).startsWith('data:'))) out.push(n.id);
    (n.children ?? []).forEach(walk);
  };
  window.__penStore.getState().doc.children.forEach(walk);
  return out;
});
if (ids.length < 2) {
  console.log('FAIL the design needs at least two picture fills from files');
  await browser.close();
  process.exit(1);
}
const a = ids[ids.length - 1];
const b = ids[ids.length - 2];
const measured = await page.evaluate(id => window.__penAgent('analyzeImage', { id, max_shapes: 3 }).then(r => r.text).catch(e => 'ERROR ' + e), a);
ok('the first measurement of a picture layer sees the picture', !/transparent \(100%\)|^ERROR/.test(measured), measured.split('\n').slice(0, 2).join(' | '));
const shot = await page.evaluate(async id => {
  const r = await window.__penAgent('screenshot', { id, max_size: 200 }).catch(e => ({ error: String(e) }));
  if (r.error) return r;
  const img = new Image();
  img.src = r.dataUrl;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let solid = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 200) solid++;
  return { share: solid / (d.length / 4), w: c.width, h: c.height };
}, b);
ok('the first screenshot of another picture layer shows the picture', !shot.error && shot.share > 0.5, JSON.stringify(shot));
ok('pictures were slowed and no page errors', slowed > 0 && errors.length === 0, `${slowed} picture requests delayed ${delay} ms; ${errors.slice(0, 2).join(' | ')}`);
await browser.close();
