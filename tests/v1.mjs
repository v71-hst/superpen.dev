// Checks for the features added for 1.0: the Scale tool, distances on Alt + hover, and (as they land) masking, image
// crop, on-canvas gradients, curve editing, slots, libraries, background removal and imports. The script adds its own
// layers to whatever file is open (in memory, far from the file's content), so any design works; nothing is saved.
// Usage: node v1.mjs <url> [shot dir]     (needs the dev server: it imports /src modules)
import puppeteer from 'puppeteer-core';
import pngjs from 'pngjs';
import { launchOptions } from './browser.mjs';
const { PNG } = pngjs;
const [, , url, shots] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pen-world [data-k]');
await page.waitForFunction(() => window.__penStore && window.__penAgent, { timeout: 60000 });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const frames = () => ev(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const node = id => ev(id => window.__penAgent('nodes', { ids: [id], depth: 5 }).then(r => r[0] ?? r.nodes?.[0] ?? r), id);
// A layer's box on screen. In the Skia renderer a frame has no geometry until its fonts and pictures are in: wait for it.
const rect = async k => {
  for (let i = 0; i < 40; i++) {
    const r = await ev(async k => { const m = await import('/src/editor/measure.ts'); const r = m.nodeScreenRect(k); return r && { x: r.x, y: r.y, w: r.width, h: r.height }; }, k);
    if (r) return r;
    await sleep(150);
  }
  return null;
};
const ops = operations => ev(operations => window.__penAgent('applyOps', { operations }), operations);
const X = 60000, Y = 60000; // where this script's layers go

await ev((X, Y) => {
  const s = window.__penStore.getState();
  s.edit(d => {
    d.children.push({
      type: 'frame', id: 'v1', name: 'v1 checks', x: X, y: Y, width: 900, height: 600, layout: 'none', fill: '#101216',
      children: [
        {
          type: 'frame', id: 'v1card', x: 40, y: 40, width: 200, height: 120, layout: 'none', fill: '#2A2F3A', cornerRadius: 10, stroke: '#FFFFFF', strokeWidth: 2, gap: 8, padding: [4, 6],
          effect: { type: 'shadow', shadowType: 'outer', offset: { x: 0, y: 4 }, blur: 12, spread: 2, color: '#00000080' },
          children: [
            { type: 'text', id: 'v1text', x: 10, y: 10, content: 'Scale me', fontFamily: 'Inter', fontSize: 20, letterSpacing: 1, lineHeight: 1.2, fill: '#FFFFFF' },
            { type: 'rectangle', id: 'v1box', x: 20, y: 60, width: 50, height: 30, cornerRadius: [4, 4, 0, 0], fill: '#3D99FF' },
          ],
        },
        { type: 'rectangle', id: 'v1other', x: 500, y: 60, width: 100, height: 100, fill: '#D946EF' },
      ],
    });
  });
  s.setView({ x: 200 - X, y: 120 - Y, zoom: 1 });
}, X, Y);
await frames();
await sleep(600);

// ---------- Scale ----------
await ops([{ op: 'scale', id: 'v1card', factor: 2 }]);
let c = await node('v1card');
const t = c.children.find(n => n.id === 'v1text'), b = c.children.find(n => n.id === 'v1box');
ok('scale operation scales the layer and everything in it',
  c.width === 400 && c.height === 240 && c.cornerRadius === 20 && c.strokeWidth === 4 && c.gap === 16 && c.padding[0] === 8 && c.effect.blur === 24 && c.effect.offset.y === 8 && c.x === 40 &&
  t.fontSize === 40 && t.letterSpacing === 2 && t.lineHeight === 1.2 && t.x === 20 && b.width === 100 && b.x === 40 && b.y === 120 && b.cornerRadius[0] === 8,
  JSON.stringify({ w: c.width, h: c.height, r: c.cornerRadius, sw: c.strokeWidth, blur: c.effect.blur, x: c.x, font: t.fontSize, lh: t.lineHeight, box: [b.x, b.y, b.width] }));
await ops([{ op: 'scale', id: 'v1card', factor: 0.5 }]);

// Dragging the bottom-right handle with the Scale tool (K).
await ev(() => window.__penStore.setState({ selection: ['v1card'], tool: 'scale', selectTool: 'scale' }));
await frames();
let r = await rect('v1card');
await page.mouse.move(r.x + r.w, r.y + r.h);
await page.mouse.down();
await page.mouse.move(r.x + r.w + 50, r.y + r.h + 30, { steps: 4 });
await page.mouse.move(r.x + r.w + 100, r.y + r.h + 60, { steps: 4 });
await page.mouse.up();
await frames();
c = await node('v1card');
ok('dragging a corner with the Scale tool scales text, strokes and radii too',
  Math.abs(c.width - 300) <= 2 && Math.abs(c.height - 180) <= 2 && Math.abs(c.cornerRadius - 15) < 0.2 && Math.abs(c.strokeWidth - 3) < 0.05 && Math.abs(c.children[0].fontSize - 30) < 0.3 && c.x === 40 && c.y === 40,
  JSON.stringify({ w: c.width, h: c.height, r: c.cornerRadius, sw: c.strokeWidth, font: c.children[0].fontSize, x: c.x, y: c.y }));
// The same drag with the normal tool only changes the box.
await ev(() => { const s = window.__penStore.getState(); s.undo?.(); });
await ops([{ op: 'update', id: 'v1card', props: { width: 200, height: 120, cornerRadius: 10, strokeWidth: 2 } }, { op: 'update', id: 'v1text', props: { fontSize: 20, letterSpacing: 1, x: 10, y: 10 } }, { op: 'update', id: 'v1box', props: { x: 20, y: 60, width: 50, height: 30, cornerRadius: [4, 4, 0, 0] } }]);
await ev(() => window.__penStore.setState({ selection: ['v1card'], tool: 'select', selectTool: 'select' }));
await frames();
r = await rect('v1card');
await page.mouse.move(r.x + r.w, r.y + r.h);
await page.mouse.down();
await page.mouse.move(r.x + r.w + 100, r.y + r.h + 60, { steps: 6 });
await page.mouse.up();
await frames();
c = await node('v1card');
ok('the Move tool still only resizes the box', c.width === 300 && c.height === 180 && c.cornerRadius === 10 && c.children[0].fontSize === 20, JSON.stringify({ w: c.width, h: c.height, r: c.cornerRadius, font: c.children[0].fontSize }));
await ops([{ op: 'update', id: 'v1card', props: { width: 200, height: 120 } }]);

// ---------- Measurements: Alt + hover ----------
await ev(() => window.__penStore.setState({ selection: ['v1card'], tool: 'select', selectTool: 'select' }));
await frames();
const o = await rect('v1other');
await page.keyboard.down('Alt');
await page.mouse.move(o.x + o.w / 2, o.y + o.h / 2, { steps: 3 });
await frames();
await sleep(150);
let labels = await ev(() => [...document.querySelectorAll('.measure-label')].map(e => e.textContent.trim()));
if (shots) await page.screenshot({ path: `${shots}/v1-measure.png` });
// The card is at x 40..240, y 40..160; the other box at x 500..600, y 60..160: 260 apart, tops 20 apart, bottoms level.
ok('Alt + hover shows the distances to the hovered layer', labels.includes('260') && labels.includes('20') && labels.length === 2, JSON.stringify(labels));
// Hovering the parent frame gives the insets on all four sides.
await page.mouse.move(o.x + o.w + 150, o.y + o.h + 300, { steps: 3 });
await frames();
await sleep(150);
labels = await ev(() => [...document.querySelectorAll('.measure-label')].map(e => e.textContent.trim()));
ok('hovering the parent shows the insets', ['40', '660', '440'].every(v => labels.includes(v)) && labels.length === 4, JSON.stringify(labels));
await page.keyboard.up('Alt');
await page.mouse.move(o.x + o.w / 2, o.y + o.h / 2);
await frames();
ok('releasing Alt hides them', (await ev(() => document.querySelectorAll('.measure-label').length)) === 0);

// ---------- Image crop and masking (looked at as pixels, so the same checks cover both renderers) ----------
const px = async (wx, wy) => {
  await frames();
  const png = PNG.sync.read(Buffer.from(await page.screenshot({ clip: { x: Math.round(200 + wx), y: Math.round(120 + wy), width: 1, height: 1 } })));
  return [png.data[0], png.data[1], png.data[2]];
};
const isRed = c => c[0] > 200 && c[1] < 60 && c[2] < 60, isBlue = c => c[2] > 200 && c[0] < 60 && c[1] < 60, isGreen = c => c[1] > 200 && c[0] < 60 && c[2] < 60;
// A 200×100 picture: left half red, right half blue.
const picture = await ev(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 100, 100); g.fillStyle = '#0000ff'; g.fillRect(100, 0, 100, 100); return c.toDataURL('image/png'); });
await ops([
  { op: 'insert', parent: 'v1', node: { type: 'rectangle', id: 'v1img', x: 40, y: 300, width: 200, height: 100, fill: { type: 'image', url: picture, mode: 'stretch' } } },
  { op: 'insert', parent: 'v1', node: { type: 'group', id: 'v1grp', x: 320, y: 300, children: [
    { type: 'ellipse', id: 'v1mask', x: 0, y: 0, width: 100, height: 100, fill: '#FF0000', mask: true },
    { type: 'rectangle', id: 'v1masked', x: 50, y: 0, width: 50, height: 100, fill: '#00FF00' },
  ] } },
]);
await ev(() => window.__penStore.setState({ selection: [], hover: null }));
await sleep(1200);
let left = await px(60, 350), right = await px(220, 350);
ok('an image fill without a crop shows the whole picture', isRed(left) && isBlue(right), `${left} | ${right}`);
await ops([{ op: 'update', id: 'v1img', props: { fill: { type: 'image', url: picture, mode: 'stretch', transform: [2, 0, 0, 1, -1, 0] } } }]);
await sleep(500);
left = await px(60, 350); right = await px(220, 350);
ok('transform [2,0,0,1,-1,0] shows the right half', isBlue(left) && isBlue(right), `${left} | ${right}`);
await ops([{ op: 'update', id: 'v1img', props: { fill: { type: 'image', url: picture, mode: 'stretch' } } }]);

// Crop on the canvas: drag the left handle to the picture's middle; the picture stays where it is.
await ev(() => window.__penStore.setState({ selection: ['v1img'], crop: { key: 'v1img', index: 0 } }));
await page.waitForSelector('.crop-handle.w', { timeout: 5000 });
let hb = await ev(() => { const r = document.querySelector('.crop-handle.w').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(hb.x, hb.y);
await page.mouse.down();
await page.mouse.move(hb.x + 60, hb.y, { steps: 3 });
await page.mouse.move(hb.x + 100, hb.y, { steps: 3 });
await page.mouse.up();
await frames();
let im = await node('v1img');
ok('dragging a crop handle resizes the layer and writes the crop', im.x === 140 && im.width === 100 && JSON.stringify(im.fill.transform) === '[2,0,0,1,-1,0]', JSON.stringify({ x: im.x, w: im.width, t: im.fill.transform }));
// Dragging inside slides the picture: 50 px to the right brings the red half back in.
const win = await ev(() => { const r = document.querySelector('.crop-window').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(win.x, win.y);
await page.mouse.down();
await page.mouse.move(win.x + 50, win.y, { steps: 4 });
await page.mouse.up();
await frames();
im = await node('v1img');
ok('dragging inside the crop window slides the picture', JSON.stringify(im.fill.transform) === '[2,0,0,1,-0.5,0]', JSON.stringify(im.fill.transform));
if (shots) await page.screenshot({ path: `${shots}/v1-crop.png` });
await ev(() => [...document.querySelectorAll('.crop-bar button')].find(b => /Reset/.test(b.textContent)).click());
await frames();
im = await node('v1img');
ok('Reset crop removes it', im.fill.transform === undefined, JSON.stringify(im.fill));
await page.keyboard.press('Escape');
await frames();
ok('Escape ends cropping', (await ev(() => !document.querySelector('.crop-overlay') && window.__penStore.getState().crop === null)));

// Masking: the ellipse clips the green box after it and paints nothing itself.
await ev(() => window.__penStore.setState({ selection: [], hover: null }));
await sleep(300);
const inside = await px(320 + 75, 350), corner = await px(320 + 97, 303), maskOnly = await px(320 + 25, 350);
ok('a mask clips the layers after it', isGreen(inside) && !isGreen(corner), `inside ${inside} | corner ${corner}`);
ok('the mask layer itself paints nothing', !isRed(maskOnly) && !isGreen(maskOnly), String(maskOnly));
if (shots) await page.screenshot({ path: `${shots}/v1-mask.png` });

ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
