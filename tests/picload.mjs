// How pictures load in the Skia renderer, in numbers: (1) from opening a design until every picture's small version
// is in and every frame is drawn by Skia, with the longest frame on the way; (2) after zooming in on frames with
// pictures, how long until they are sharp, and the longest frame while they sharpen. Run before and after a change to
// src/skia/images.ts. Usage: PEN_PROD=1 node start.mjs <folder>, then:
//   node picload.mjs <url of a design with many large pictures> [perf=0|1]     (PEN_CPU_SLOW=4 for a weaker PC)
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, perf = '0'] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-renderer-backgrounding'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
if (process.env.PEN_CPU_SLOW) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PEN_CPU_SLOW) });
  console.log(`processor slowed ${process.env.PEN_CPU_SLOW}x`);
}
// PEN_LINKS=1: note every program the graphics card is asked to compile, when, and what its code says it draws.
if (process.env.PEN_LINKS) {
  await page.evaluateOnNewDocument(() => {
    window.__links = [];
    for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
      if (!C) continue;
      const link = C.prototype.linkProgram;
      C.prototype.linkProgram = function (prog) {
        const t = performance.now();
        let frag = '';
        try { for (const sh of this.getAttachedShaders(prog) ?? []) if (this.getShaderParameter(sh, this.FRAGMENT_SHADER ? this.SHADER_TYPE : 0) === this.FRAGMENT_SHADER) frag = this.getShaderSource(sh) ?? ''; } catch (e) {}
        window.__links.push({ t, frag });
        return link.call(this, prog);
      };
    }
  });
}
await page.evaluateOnNewDocument(p => {
  localStorage.setItem('pen.perfMode', p);
  // Frame times from the very start.
  window.__frames = [];
  let last = performance.now();
  const tick = t => { window.__frames.push([t, t - last]); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}, perf);
// PEN_PROFILE=1 (with the dev server, for readable names): where the editor's thread spends its time in each phase.
const prof = process.env.PEN_PROFILE ? await page.createCDPSession() : null;
const topOf = profile => {
  const self = new Map();
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  profile.samples.forEach((id, i) => { const cf = byId.get(id).callFrame; const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber}`; self.set(k, (self.get(k) || 0) + (profile.timeDeltas[i] || 0)); });
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(6)} ms  ${k}`).join('\n');
};
if (prof) { await prof.send('Profiler.enable'); await prof.send('Profiler.setSamplingInterval', { interval: 250 }); await prof.send('Profiler.start'); }
const t0 = Date.now();
await page.goto(`${url}${url.includes('?') ? '&' : '?'}renderer=full`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__penStore?.getState().doc && window.__penAgent, { timeout: 120000 });
const skia = () => page.evaluate(() => window.__penAgent('diagnose').then(d => ({ images: d.renderer.skia?.images, pictures: d.renderer.skia?.pictures, active: d.renderer.active })).catch(() => null));
const worst = (from, to) => page.evaluate((from, to) => { const f = window.__frames.filter(x => x[0] >= from && x[0] <= to).map(x => x[1]); f.sort((a, b) => a - b); return f.length ? { worst: +f[f.length - 1].toFixed(0), over50: f.filter(v => v > 50).length, p95: +f[Math.floor(f.length * 0.95)].toFixed(1), frames: f.length } : null; }, from, to);
const now = () => page.evaluate(() => performance.now());

// 1. Opening: until nothing is loading and every frame Skia can draw is recorded.
let s = null;
for (let i = 0; i < 600; i++) {
  s = await skia();
  if (s?.images && s.images.loading === 0 && s.images.ready > 0 && s.pictures.recorded >= s.pictures.eligible && s.pictures.eligible > 0) break;
  await sleep(100);
}
const opened = await now();
console.log(`opened: ${s?.images?.ready} pictures in (${s?.images?.failed} failed), ${s?.pictures?.recorded}/${s?.pictures?.eligible} frames drawn by Skia after ${(opened / 1000).toFixed(2)} s (page clock; ${((Date.now() - t0) / 1000).toFixed(1)} s wall)`);
console.log('  frames while opening:', JSON.stringify(await worst(0, opened)));
if (prof) { console.log('--- where the time went while opening:\n' + topOf((await prof.send('Profiler.stop')).profile)); }
// A person looks at a design for a moment before zooming in; the editor uses that moment (see scene.ts warm).
await sleep(3000);
const warmSteps = () => page.evaluate(() => window.__penAgent('diagnose').then(d => d.renderer.skia?.overview?.programSteps ?? null));
console.log(`  warm-up steps drawn before the zoom-in: ${await warmSteps()}`);
if (prof) await prof.send('Profiler.start');

// 2. Sharpening: put a block of frames with pictures large on screen and wait until nothing is sharpening.
const target = await page.evaluate(() => {
  const d = window.__penStore.getState().doc;
  const has = n => { const f = Array.isArray(n.fill) ? n.fill : [n.fill]; return f.some(x => x && typeof x === 'object' && x.type === 'image') || (n.children ?? []).some(has); };
  const frames = d.children.filter(n => n.type === 'frame' && typeof n.x === 'number' && has(n));
  const f = frames[Math.floor(frames.length / 2)] ?? d.children[0];
  return { x: f.x, y: f.y, w: f.width, h: typeof f.height === 'number' ? f.height : 800 };
});
const start = await now();
await page.evaluate(f => {
  const zoom = Math.min(1.2, (innerHeight - 160) / f.h);
  window.__penStore.getState().setView({ zoom, x: innerWidth / 2 - (f.x + f.w / 2) * zoom, y: innerHeight / 2 - (f.y + f.h / 2) * zoom });
}, target);
let sharp = null;
let sawSharpening = false;
for (let i = 0; i < 400; i++) {
  await sleep(50);
  sharp = await skia();
  if (sharp.images.sharpening > 0 || sharp.images.larger > 0) sawSharpening = true;
  if (sawSharpening && sharp.images.sharpening === 0 && i > 8) break;
  if (!sawSharpening && i > 80) break;
}
const done = await now();
console.log(`zoomed in: ${sharp.images.larger} larger versions (${sharp.images.largerMB} MB) after ${((done - start) / 1000).toFixed(2)} s${sawSharpening ? '' : '  (nothing needed sharpening here)'}`);
console.log('  frames while sharpening:', JSON.stringify(await worst(start, done)));
console.log('  totals:', JSON.stringify(sharp.images));
if (process.env.PEN_LINKS) {
  const links = await page.evaluate((from, to) => ({ before: window.__links.filter(l => l.t < from).length, during: window.__links.filter(l => l.t >= from && l.t <= to).map(l => ({ at: Math.round(l.t - from), frag: l.frag })) }), start, done);
  console.log(`--- programs compiled: ${links.before} before the zoom-in, ${links.during.length} during it`);
  for (const l of links.during) {
    // The telling parts of the program: the calls it makes and the names of what it reads.
    const words = [...new Set((l.frag.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? []).filter(w => /Effect|Texture|Gradient|Blur|Circle|RRect|Ellipse|Distance|Coverage|Clamp|Subset|Blend|Matrix|Dither|Mip|sample|Color/i.test(w)))].slice(0, 40);
    console.log(`  +${l.at} ms, ${l.frag.length} chars: ${words.join(' ')}`);
  }
}
if (prof) console.log('--- where the time went while sharpening:\n' + topOf((await prof.send('Profiler.stop')).profile));

// 3. The same again on other frames: anything that only happens the first time (the graphics card being handed a
// new program to compile, mostly) is over by now, so this is what every later zoom-in feels like.
const others = await page.evaluate(() => {
  const d = window.__penStore.getState().doc;
  const has = n => { const f = Array.isArray(n.fill) ? n.fill : [n.fill]; return f.some(x => x && typeof x === 'object' && x.type === 'image') || (n.children ?? []).some(has); };
  const frames = d.children.filter(n => n.type === 'frame' && typeof n.x === 'number' && has(n));
  return [frames[0], frames[frames.length - 1]].filter(Boolean).map(f => ({ x: f.x, y: f.y, w: f.width, h: typeof f.height === 'number' ? f.height : 800 }));
});
for (const [i, f] of others.entries()) {
  await page.evaluate(() => { const s = window.__penStore.getState(); s.setView({ zoom: 0.08, x: 40, y: 60 }); });
  await sleep(900);
  const a = await now();
  await page.evaluate(f => {
    const zoom = Math.min(1.2, (innerHeight - 160) / f.h);
    window.__penStore.getState().setView({ zoom, x: innerWidth / 2 - (f.x + f.w / 2) * zoom, y: innerHeight / 2 - (f.y + f.h / 2) * zoom });
  }, f);
  for (let k = 0; k < 60; k++) { await sleep(50); const q = await skia(); if (k > 10 && q.images.sharpening === 0) break; }
  const b = await now();
  console.log(`zoomed in again (${i + 1}): ${((b - a) / 1000).toFixed(2)} s, frames ${JSON.stringify(await worst(a, b))}`);
}
await browser.close();
