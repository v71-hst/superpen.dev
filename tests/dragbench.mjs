// Frame times while dragging a layer in a big design. Drags the LAST top-level frame (the worst case for anything
// that searches the document from the top) with real mouse moves, and also times the edit itself with nothing else
// going on. Run it before and after a change to dragging or to how edits find their node.
// Usage: PEN_PROD=1 node start.mjs <folder>, then: node dragbench.mjs <url of a big design> [runs=3] [moves=150]
//        PEN_CPU_SLOW=6 slows the page's main thread 6x, to see what a weaker PC would feel.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, runs = '3', moves = '150'] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--disable-renderer-backgrounding'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await page.waitForFunction(() => window.__penStore && window.__penAgent, { timeout: 60000 });
await sleep(4000);
if (process.env.PEN_CPU_SLOW) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PEN_CPU_SLOW) });
  console.log(`processor slowed ${process.env.PEN_CPU_SLOW}x`);
}

const info = await page.evaluate(() => {
  const d = window.__penStore.getState().doc;
  let nodes = 0;
  const walk = n => { nodes++; (n.children ?? []).forEach(walk); };
  d.children.forEach(walk);
  const frames = d.children.filter(n => n.type === 'frame' && typeof n.x === 'number' && typeof n.width === 'number');
  const last = frames[frames.length - 1];
  return { nodes, top: d.children.length, id: last.id, name: last.name, x: last.x, y: last.y, w: last.width, h: typeof last.height === 'number' ? last.height : 400 };
});
console.log(`${info.nodes} nodes in ${info.top} top-level layers; dragging the last frame "${info.name ?? info.id}"`);

// Put that frame in the middle of the window at half size (in memory; this is the test's own view).
await page.evaluate(f => {
  const zoom = 0.5;
  window.__penStore.getState().setView({ zoom, x: innerWidth / 2 - (f.x + f.w / 2) * zoom, y: innerHeight / 2 - (f.y + f.h / 2) * zoom });
}, info);
await sleep(2500);

const stats = list => {
  const s = [...list].sort((a, b) => a - b);
  const at = q => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { median: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1), worst: +s[s.length - 1].toFixed(1), over33: s.filter(v => v > 33).length, frames: s.length };
};

// 1. The edit alone: how long one "move this layer" edit takes, as a drag makes on every pointer move.
// Where the time of an edit goes: the same one-property change made by going straight to the node, and by searching
// the edit copy of the document for it from the top (what a lookup by id does without an index).
const split = await page.evaluate(id => {
  const st = window.__penStore.getState();
  const direct = [], searched = [];
  for (let i = 0; i < 30; i++) {
    let t = performance.now();
    st.edit(d => { const n = d.children[d.children.length - 1]; n.x = n.x + 1; });
    direct.push(performance.now() - t);
    t = performance.now();
    st.edit(d => {
      const find = nodes => { for (const n of nodes) { if (n.id === id) return n; if (n.children) { const r = find(n.children); if (r) return r; } } return null; };
      const n = find(d.children);
      n.x = n.x - 1;
    });
    searched.push(performance.now() - t);
  }
  return { direct, searched };
}, info.id);
console.log('one edit, going straight to the node (ms):', JSON.stringify(stats(split.direct)));
console.log('one edit, searching the edit copy for it (ms):', JSON.stringify(stats(split.searched)));
const applyMs = await page.evaluate(async id => {
  const times = [];
  for (let i = 0; i < 40; i++) {
    const t = performance.now();
    await window.__penAgent('applyOps', { operations: [{ op: 'update', id, props: { x: Math.round(Math.random() * 4) + 100000 } }] }).catch(() => {});
    times.push(performance.now() - t);
  }
  return times;
}, info.id);
// Put it back where the view expects it.
await page.evaluate(f => window.__penAgent('applyOps', { operations: [{ op: 'update', id: f.id, props: { x: f.x } }] }), info);
await sleep(800);
console.log('one edit through apply_operations (ms):', JSON.stringify(stats(applyMs)));

// 2. A real drag with the mouse. The frame is put back in the middle of the window first (the edits above moved it).
await page.evaluate(f => {
  const zoom = 0.5;
  window.__penStore.getState().setView({ zoom, x: innerWidth / 2 - (f.x + f.w / 2) * zoom, y: innerHeight / 2 - (f.y + f.h / 2) * zoom });
}, info);
await sleep(1500);
const grip = await page.evaluate(name => {
  const el = [...document.querySelectorAll('.frame-label')].find(l => l.textContent.trim() === name);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + Math.min(20, r.width / 2), y: r.y + r.height / 2 };
}, info.name);
if (!grip) {
  console.log('could not find the name label of the frame to drag it by');
  await browser.close();
  process.exit(1);
}
const cx = grip.x, cy = grip.y;
console.log('under the pointer:', await page.evaluate((x, y, id) => { const el = document.elementFromPoint(x, y); const f = window.__penStore.getState().doc.children.find(c => c.id === id); const v = window.__penStore.getState().view; return `${el?.tagName}.${String(el?.className).slice(0, 40)} data-k=${el?.closest?.('[data-k]')?.getAttribute('data-k')}; frame on screen at ${Math.round(f.x * v.zoom + v.x)},${Math.round(f.y * v.zoom + v.y)} zoom ${v.zoom}`; }, cx, cy, info.id));
for (let r = 1; r <= Number(runs); r++) {
  await page.mouse.move(cx, cy);
  await sleep(300);
  await page.evaluate(() => {
    window.__frames = [];
    window.__stop = false;
    let last = performance.now();
    const tick = t => { window.__frames.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.mouse.down();
  const n = Number(moves);
  let far = NaN;
  for (let i = 1; i <= n; i++) {
    // Out and back, so the frame ends where it started.
    const k = i <= n / 2 ? i : n - i;
    await page.mouse.move(cx + k * 2, cy + k);
    if (i === Math.floor(n / 2)) far = await page.evaluate(id => window.__penStore.getState().doc.children.find(c => c.id === id)?.x ?? NaN, info.id);
  }
  await page.mouse.up();
  const frames = await page.evaluate(() => { window.__stop = true; return window.__frames.slice(2); });
  const sel = await page.evaluate(() => window.__penStore.getState().selection);
  console.log(`drag run ${r}: frame ms ${JSON.stringify(stats(frames))}  furthest x reached ${far.toFixed(0)} (started ${info.x}), selection ${JSON.stringify(sel)}`);
  await sleep(600);
}
await browser.close();
