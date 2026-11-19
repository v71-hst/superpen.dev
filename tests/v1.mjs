// Checks for the features added for 1.0: the Scale tool, distances on Alt + hover, and (as they land) masking, image
// crop, on-canvas gradients, curve editing, slots, libraries, background removal and imports. The script adds its own
// layers to whatever file is open (in memory, far from the file's content), so any design works; nothing is saved.
// Usage: node v1.mjs <url> [shot dir]     (needs the dev server: it imports /src modules)
import puppeteer from 'puppeteer-core';
import pngjs from 'pngjs';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ---------- Gradients: mesh rendering, and handles on the canvas ----------
await ops([
  { op: 'insert', parent: 'v1', node: { type: 'rectangle', id: 'v1mesh', x: 640, y: 300, width: 200, height: 200, fill: { type: 'mesh_gradient', columns: 2, rows: 2, colors: ['#FF0000', '#00FF00', '#0000FF', '#FFFFFF'] } } },
  { op: 'insert', parent: 'v1', node: { type: 'rectangle', id: 'v1mesh3', x: 640, y: 40, width: 200, height: 200, fill: { type: 'mesh_gradient', columns: 3, rows: 3, colors: ['#000000', '#000000', '#000000', '#000000', '#FFFFFF', '#000000', '#000000', '#000000', '#000000'], points: [[0, 0], [0.5, 0], [1, 0], [0, 0.5], [0.25, 0.25], [1, 0.5], [0, 1], [0.5, 1], [1, 1]] } } },
  { op: 'insert', parent: 'v1', node: { type: 'rectangle', id: 'v1grad', x: 300, y: 40, width: 160, height: 160, fill: { type: 'gradient', gradientType: 'linear', rotation: 0, colors: [{ color: '#000000', position: 0 }, { color: '#FFFFFF', position: 1 }] } } },
]);
await sleep(700);
const tl = await px(650, 310), tr = await px(830, 310), bl = await px(650, 490), br = await px(830, 490);
ok('a mesh gradient blends its corner colours', tl[0] > 190 && tl[1] < 70 && tr[1] > 190 && tr[0] < 70 && bl[2] > 190 && bl[0] < 70 && br[0] > 190 && br[1] > 190 && br[2] > 190, `tl ${tl} tr ${tr} bl ${bl} br ${br}`);
const moved = await px(640 + 50, 40 + 50), middle = await px(640 + 150, 40 + 150);
ok('a moved mesh point carries its colour with it', moved[0] > 200 && middle[0] < 60, `at the point ${moved} | far side ${middle}`);

// Handles: the popover would set store.gradientEdit; here the test does.
const knobAt = sel => ev(sel => { const r = document.querySelector(sel)?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, sel);
await ev(() => window.__penStore.setState({ selection: ['v1grad'], gradientEdit: { key: 'v1grad', index: 0, point: 0 } }));
await page.waitForSelector('[data-grad="end"]', { timeout: 5000 });
let k = await knobAt('[data-grad="end"]');
// The end handle sits 14 px beyond the gradient's end, which starts at the top middle (rotation 0 runs bottom to
// top). Drag it so the end lands on the right middle: the handle then sits 14 px further along the new direction.
await page.mouse.move(k.x, k.y);
await page.mouse.down();
await page.mouse.move(k.x + 40, k.y + 40, { steps: 3 });
await page.mouse.move(k.x + 80 + 14 * Math.SQRT1_2, k.y + 14 + 80 - 14 * Math.SQRT1_2, { steps: 3 });
await page.mouse.up();
await frames();
let g = (await node('v1grad')).fill;
ok('dragging a linear gradient\'s end sets its angle, centre and length', Math.abs(g.rotation + 45) < 1 && Math.abs(g.center.x - 0.75) < 0.01 && Math.abs(g.center.y - 0.75) < 0.01 && Math.abs(g.size.height - 0.707) < 0.01, JSON.stringify({ rotation: g.rotation, center: g.center, size: g.size }));
k = await knobAt('[data-grad="stop0"]');
const kEnd = await knobAt('[data-grad="stop1"]');
await page.mouse.move(k.x, k.y);
await page.mouse.down();
await page.mouse.move((k.x + kEnd.x) / 2, (k.y + kEnd.y) / 2, { steps: 4 });
await page.mouse.up();
await frames();
g = (await node('v1grad')).fill;
ok('dragging a stop along the line moves it', Math.abs(g.colors[0].position - 0.5) < 0.03, JSON.stringify(g.colors));
await ev(() => window.__penStore.setState({ selection: ['v1mesh3'], gradientEdit: { key: 'v1mesh3', index: 0, point: 4 } }));
await page.waitForSelector('[data-grad="point4"]', { timeout: 5000 });
k = await knobAt('[data-grad="point4"]');
await page.mouse.move(k.x, k.y);
await page.mouse.down();
await page.mouse.move(k.x + 30, k.y + 15, { steps: 3 });
await page.mouse.move(k.x + 50, k.y + 30, { steps: 3 });
await page.mouse.up();
await frames();
let mp = (await node('v1mesh3')).fill.points[4];
ok('dragging a mesh point moves it', Math.abs(mp[0] - 0.5) < 0.01 && Math.abs(mp[1] - 0.4) < 0.01, JSON.stringify(mp));
k = await knobAt('[data-grad="handle-right"]');
await page.mouse.move(k.x, k.y);
await page.mouse.down();
await page.mouse.move(k.x + 10, k.y - 20, { steps: 4 });
await page.mouse.up();
await frames();
mp = (await node('v1mesh3')).fill.points[4];
ok('dragging a handle bends the patch (the handle is written to the file)', !!mp.position && Array.isArray(mp.rightHandle) && mp.rightHandle[1] < 0, JSON.stringify(mp));
if (shots) await page.screenshot({ path: `${shots}/v1-gradients.png` });
await ev(() => window.__penStore.setState({ selection: [], gradientEdit: null }));

// ---------- Pen tool: editing points, drawing curves ----------
const model = await ev(async () => {
  const m = await import('/src/editor/pathModel.ts');
  const subs = m.parsePath('M10 10 h80 v60 q-40 30 -80 0 z');
  const round = m.serializePath(m.parsePath(m.serializePath(subs)));
  const tri = m.parsePath('M0 0L100 0L50 80Z');
  const at = m.insertAnchor(tri[0], 0, 1, 0.5);
  return { anchors: subs[0].anchors.length, closed: subs[0].closed, stable: round === m.serializePath(subs), curve: /C/.test(round), inserted: [at, tri[0].anchors.length, tri[0].anchors[at].x, tri[0].anchors[at].y] };
});
ok('path data parses into anchors and writes back unchanged', model.anchors === 4 && model.closed && model.stable && model.curve && JSON.stringify(model.inserted) === '[1,4,50,0]', JSON.stringify(model));

await ops([{ op: 'insert', parent: 'v1', node: { type: 'path', id: 'v1path', x: 60, y: 440, width: 100, height: 80, geometry: 'M0 0L100 0L50 80Z', viewBox: [0, 0, 100, 80], stroke: '#FFFFFF', strokeWidth: 2 } }]);
await ev(() => window.__penStore.setState({ selection: ['v1path'], pathEdit: { key: 'v1path' } }));
await page.waitForSelector('[data-path-anchor="0-2"]', { timeout: 5000 });
const dragBy = async (sel, dx, dy) => {
  const k = await knobAt(sel);
  await page.mouse.move(k.x, k.y);
  await page.mouse.down();
  await page.mouse.move(k.x + dx / 2, k.y + dy / 2, { steps: 3 });
  await page.mouse.move(k.x + dx, k.y + dy, { steps: 3 });
  await page.mouse.up();
  await frames();
};
await dragBy('[data-path-anchor="0-2"]', 0, 40);
let pn = await node('v1path');
ok('dragging an anchor reshapes the path and its box follows', pn.height === 120 && pn.viewBox[3] === 120 && /50 120/.test(pn.geometry) && pn.x === 60 && pn.y === 440, JSON.stringify({ g: pn.geometry, vb: pn.viewBox, h: pn.height, x: pn.x }));
await dragBy('[data-path-anchor="0-0"]', -20, 0);
pn = await node('v1path');
ok('moving a point past the left edge moves the layer, not the other points', pn.x === 40 && pn.width === 120 && pn.viewBox[0] === -20 && /-20 0/.test(pn.geometry), JSON.stringify({ g: pn.geometry, vb: pn.viewBox, w: pn.width, x: pn.x }));
// Click the middle of the top side: a new point.
const a0 = await knobAt('[data-path-anchor="0-0"]'), a1 = await knobAt('[data-path-anchor="0-1"]');
await page.mouse.click((a0.x + a1.x) / 2, (a0.y + a1.y) / 2);
await frames();
ok('clicking the outline adds a point', (await ev(() => document.querySelectorAll('[data-path-anchor]').length)) === 4, (await node('v1path')).geometry);
// The new point is selected: double-click makes it smooth, a handle bends the curve, Delete removes it.
const mid = await knobAt('[data-path-anchor="0-1"]');
await page.mouse.click(mid.x, mid.y, { clickCount: 2 });
await frames();
pn = await node('v1path');
const hasHandles = await ev(() => document.querySelectorAll('[data-path-handle]').length);
ok('double-clicking a point makes it smooth', /C/.test(pn.geometry) && hasHandles === 2, `${pn.geometry} | ${hasHandles} handles`);
await dragBy('[data-path-handle="out"]', 0, -30);
pn = await node('v1path');
ok('dragging a handle bends the curve above the old top edge', pn.viewBox[1] < 0 && pn.y < 440, JSON.stringify({ vb: pn.viewBox, y: pn.y }));
if (shots) await page.screenshot({ path: `${shots}/v1-path.png` });
await page.keyboard.press('Delete');
await frames();
ok('Delete removes the selected point', (await ev(() => document.querySelectorAll('[data-path-anchor]').length)) === 3 && !!(await node('v1path')).geometry);
await page.keyboard.press('Escape');
await frames();
ok('Escape ends point editing and keeps the layer', (await ev(() => window.__penStore.getState().pathEdit === null && !document.querySelector('.path-edit'))) && !!(await node('v1path')).id);

// Drawing: a click, then a press-and-drag (a smooth point), then a double-click to finish.
await ev(() => window.__penStore.setState({ selection: [], tool: 'pen' }));
const base = { x: 200 + 300, y: 120 + 470 };
await page.mouse.click(base.x, base.y);
await page.mouse.move(base.x + 80, base.y - 40);
await page.mouse.down();
await page.mouse.move(base.x + 110, base.y - 40, { steps: 4 });
await page.mouse.up();
await page.mouse.click(base.x + 160, base.y);
await page.mouse.click(base.x + 160, base.y);
await frames();
const drawn = await ev(() => { const s = window.__penStore.getState(); const find = (ns, id) => { for (const n of ns || []) { if (n.id === id) return n; const r = find(n.children, id); if (r) return r; } }; return find(s.doc.children, s.selection[0]); });
ok('the pen tool draws curves when you drag', drawn?.type === 'path' && /C/.test(drawn.geometry) && drawn.width >= 150, JSON.stringify(drawn && { g: drawn.geometry, w: drawn.width, h: drawn.height }));
await ev(() => window.__penStore.setState({ selection: [], tool: 'select' }));

// ---------- Component slots ----------
await ops([
  { op: 'update', id: 'v1', props: { height: 1000 } },
  { op: 'insert', parent: 'v1', node: { type: 'frame', id: 'v1chip', name: 'Chip', reusable: true, x: 700, y: 640, width: 80, height: 24, cornerRadius: 12, fill: '#00FF00' } },
  { op: 'insert', parent: 'v1', node: { type: 'frame', id: 'v1comp', name: 'Card', reusable: true, x: 40, y: 640, width: 200, height: 'fit_content', layout: 'vertical', gap: 6, padding: 10, fill: '#2A2F3A', children: [
    { type: 'text', id: 'v1ctitle', content: 'Card', fontFamily: 'Inter', fontSize: 14, fill: '#FFFFFF' },
    { type: 'frame', id: 'v1slot', name: 'Body', slot: ['v1chip'], layout: 'vertical', gap: 4, width: 'fill_container', height: 'fit_content(40)' },
  ] } },
  { op: 'instantiate', component: 'v1comp', parent: 'v1', props: { id: 'x', x: 280, y: 640 }, overrides: { v1slot: { children: [{ type: 'ref', ref: 'v1chip' }, { type: 'ref', ref: 'v1chip' }] } } },
  { op: 'instantiate', component: 'v1comp', parent: 'v1', props: { x: 520, y: 640 } },
]);
await ev(() => window.__penStore.setState({ selection: [], hover: null }));
await sleep(500);
const insts = await ev(() => { const v = window.__penStore.getState().doc.children.find(n => n.id === 'v1'); return v.children.filter(n => n.type === 'ref').map(n => ({ id: n.id, kids: n.descendants?.v1slot?.children?.map(c => c.id) ?? [] })); });
const filled = insts.find(i => i.kids.length === 2), empty = insts.find(i => i.kids.length === 0);
const chipRect = filled ? await rect(`${filled.id}/v1slot/${filled.kids[1]}`) : null;
ok('an instance fills a slot with its own children', !!filled && new Set(filled.kids).size === 2 && !!chipRect && Math.round(chipRect.w) === 80 && Math.round(chipRect.h) === 24, JSON.stringify({ insts, chipRect }));
let marks = await ev(() => [...document.querySelectorAll('.slot-mark')].map(e => e.dataset.slot));
ok('empty slots are marked on the canvas, filled ones are not', marks.includes('v1slot') && marks.includes(`${empty.id}/v1slot`) && !marks.includes(`${filled.id}/v1slot`), JSON.stringify(marks));
// The design panel on the empty instance's slot: one click puts the suggested component in.
await ev(k => window.__penStore.setState({ selection: [k], rightOpen: true }), `${empty.id}/v1slot`);
await page.waitForFunction(() => [...document.querySelectorAll('.right-panel .rp-btn')].some(b => /Chip/.test(b.textContent)), { timeout: 5000 });
await ev(() => [...document.querySelectorAll('.right-panel .rp-btn')].find(b => /Chip/.test(b.textContent)).click());
await frames();
let slotKids = await ev(id => window.__penStore.getState().doc.children.find(n => n.id === 'v1').children.find(n => n.id === id).descendants?.v1slot?.children ?? [], empty.id);
ok('the panel inserts a suggested component into the slot', slotKids.length === 1 && slotKids[0].ref === 'v1chip' && !!(await rect(`${empty.id}/v1slot/${slotKids[0].id}`)), JSON.stringify(slotKids));
await ev(() => [...document.querySelectorAll('.right-panel .rp-btn')].find(b => /^Clear/.test(b.textContent.trim())).click());
await frames();
slotKids = await ev(id => window.__penStore.getState().doc.children.find(n => n.id === 'v1').children.find(n => n.id === id).descendants?.v1slot?.children ?? [], empty.id);
ok('Clear empties it again', slotKids.length === 0);
if (shots) await page.screenshot({ path: `${shots}/v1-slots.png` });
await ev(() => window.__penStore.setState({ selection: [] }));

// ---------- UI libraries: components of another file ----------
// The library is a real file next to the open one (written through the dev server), imported under the alias "kit".
const libDoc = { version: '2.21', variables: { accent: { type: 'color', value: '#FF00FF' } }, children: [
  { type: 'frame', id: 'badge', name: 'Badge', reusable: true, x: 0, y: 0, width: 60, height: 20, cornerRadius: 4, fill: '$accent' },
  { type: 'frame', id: 'row', name: 'Row', reusable: true, x: 0, y: 60, width: 160, height: 40, layout: 'horizontal', alignItems: 'center', padding: 10, fill: '#202530', children: [{ type: 'ref', id: 'b1', ref: 'badge' }] },
] };
const libPath = new URL(url).searchParams.get('file').replace(/[^/]+$/, '') + 'v1-lib.spen';
const wrote = await ev(async (path, text) => (await fetch(`/api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: text })).ok, libPath, JSON.stringify(libDoc));
await ev(() => window.__penStore.getState().edit(d => { d.imports = { kit: './v1-lib.spen' }; }));
let listed = [];
for (let i = 0; i < 40 && !listed.some(c => /kit:row/.test(c)); i++) {
  await sleep(150);
  listed = await ev(() => window.__penAgent('components', {}));
}
ok('an imported library\'s components are listed', wrote && listed.some(c => /#kit:row/.test(c)) && listed.some(c => /#kit:badge/.test(c)), JSON.stringify(listed.filter(c => /kit/.test(c))));
const made = await ops([{ op: 'instantiate', component: 'kit:row', parent: 'v1', props: { x: 40, y: 780 } }]);
const libInst = made.results?.[0]?.id ?? made[0]?.id;
await ev(() => window.__penStore.setState({ selection: [], hover: null }));
await sleep(500);
const badgeRect = await rect(`${libInst}/kit:b1`);
const badgePx = await px(40 + 10 + 30, 780 + 20);
ok('an instance of a library component renders, with its nested component and its variables', !!badgeRect && Math.round(badgeRect.w) === 60 && badgePx[0] > 200 && badgePx[1] < 60 && badgePx[2] > 200, JSON.stringify({ badgeRect, badgePx }));
// The Components tab offers them: a click puts an instance on the canvas.
await ev(() => window.__penStore.setState({ leftOpen: true, leftTab: 'components' }));
await page.waitForSelector('[data-library="kit"] .lib-item', { timeout: 5000 });
const before = await ev(() => window.__penStore.getState().doc.children.length);
await ev(() => document.querySelector('[data-library="kit"] .lib-item').click());
await frames();
const placed = await ev(() => { const s = window.__penStore.getState(); const n = s.doc.children[s.doc.children.length - 1]; return { count: s.doc.children.length, ref: n.ref, selected: s.selection[0] === n.id }; });
ok('the Components tab inserts a library component', placed.count === before + 1 && /^kit:/.test(placed.ref) && placed.selected, JSON.stringify(placed));
if (shots) await page.screenshot({ path: `${shots}/v1-libraries.png` });
await ev(() => window.__penStore.setState({ leftOpen: false, selection: [] }));

// ---------- Remove background (built in) ----------
const bgUnit = await ev(async () => {
  const m = await import('/src/editor/removeBg.ts');
  const make = draw => { const c = document.createElement('canvas'); c.width = 240; c.height = 160; const g = c.getContext('2d', { willReadFrequently: true }); draw(g); return g.getImageData(0, 0, 240, 160); };
  const at = (img, x, y) => [...img.data.slice((y * 240 + x) * 4, (y * 240 + x) * 4 + 4)];
  // A red disc with a hole on white; then the same on a soft grey gradient.
  const disc = g => { g.fillStyle = '#e02020'; g.beginPath(); g.arc(120, 80, 60, 0, 7); g.fill(); };
  const hole = (g, fill) => { g.fillStyle = fill; g.beginPath(); g.arc(120, 80, 20, 0, 7); g.fill(); };
  const plain = m.removeBackground(make(g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 240, 160); disc(g); hole(g, '#ffffff'); }));
  const kept = m.removeBackground(make(g => { g.fillStyle = '#ffffff'; g.fillRect(0, 0, 240, 160); disc(g); hole(g, '#ffffff'); }), { inner: false });
  const graded = m.removeBackground(make(g => { const gr = g.createLinearGradient(0, 0, 240, 160); gr.addColorStop(0, '#f2f2f2'); gr.addColorStop(1, '#b8b8c4'); g.fillStyle = gr; g.fillRect(0, 0, 240, 160); disc(g); }));
  const busy = m.removeBackground(make(g => { for (let y = 0; y < 160; y += 8) for (let x = 0; x < 240; x += 8) { g.fillStyle = `hsl(${(x * 7 + y * 13) % 360} 80% 50%)`; g.fillRect(x, y, 8, 8); } }));
  // The disc's edge: partly transparent pixels must not carry the white of the old background.
  let fringe = 0, soft = 0;
  for (let i = 0; i < plain.image.data.length; i += 4) { const al = plain.image.data[i + 3]; if (al > 20 && al < 235) { soft++; if (plain.image.data[i + 1] > 150 && plain.image.data[i + 2] > 150) fringe++; } }
  return { plain: { corner: at(plain.image, 3, 3), body: at(plain.image, 120, 30), hole: at(plain.image, 120, 80), removed: plain.removed, bg: plain.background }, keptHole: at(kept.image, 120, 80), graded: { corner: at(graded.image, 3, 3), far: at(graded.image, 236, 156), body: at(graded.image, 120, 80), removed: graded.removed }, busy: { removed: busy.removed, note: busy.note }, soft, fringe };
});
ok('a plain background is removed, the subject kept, enclosed areas too',
  bgUnit.plain.corner[3] === 0 && bgUnit.plain.body[3] === 255 && bgUnit.plain.body[0] > 200 && bgUnit.plain.hole[3] === 0 && bgUnit.keptHole[3] === 255 && bgUnit.plain.removed > 0.6 && bgUnit.plain.removed < 0.8,
  JSON.stringify({ ...bgUnit.plain, keptHole: bgUnit.keptHole }));
ok('a gently graded background goes too', bgUnit.graded.corner[3] === 0 && bgUnit.graded.far[3] === 0 && bgUnit.graded.body[3] === 255, JSON.stringify(bgUnit.graded));
ok('the cut edge is soft and carries no halo of the old background', bgUnit.soft > 40 && bgUnit.fringe <= bgUnit.soft * 0.05, `${bgUnit.soft} soft edge pixels, ${bgUnit.fringe} still whitish`);
ok('a busy background is reported, not mangled', bgUnit.busy.removed < 0.2 && /plain/.test(bgUnit.busy.note ?? ''), JSON.stringify(bgUnit.busy));
// Through the editor: the fill is pointed at a new file and the picture's corner now shows what is behind it.
const onWhite = await ev(() => { const c = document.createElement('canvas'); c.width = 200; c.height = 100; const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, 200, 100); g.fillStyle = '#0000ff'; g.fillRect(60, 20, 80, 60); return c.toDataURL('image/png'); });
await ops([{ op: 'insert', parent: 'v1', node: { type: 'rectangle', id: 'v1cut', x: 500, y: 520, width: 200, height: 100, fill: { type: 'image', url: onWhite, mode: 'stretch' } } }]);
await sleep(500);
const beforeCut = await px(505, 525);
const cut = await ev(() => window.__penAgent('removeBackground', { id: 'v1cut' }).catch(e => ({ error: String(e) })));
await sleep(900);
const afterCut = await px(505, 525), keptCut = await px(600, 570);
const cutFill = (await node('v1cut')).fill;
ok('remove_background rewrites the fill to a new picture with a transparent background', !cut.error && cut.removed > 0.6 && cutFill.url !== onWhite && beforeCut[0] > 240 && afterCut[0] < 40 && keptCut[2] > 200 && keptCut[0] < 60, JSON.stringify({ cut, url: String(cutFill.url).slice(0, 60), beforeCut, afterCut, keptCut }));

// ---------- HTML import ----------
const pageHtml = `<style>
 body{margin:0;background:#101820;font-family:Inter,sans-serif}
 .card{position:absolute;left:40px;top:30px;width:300px;padding:20px;border-radius:16px;background:#ffffff;box-shadow:0 8px 20px rgba(0,0,0,.3);border:2px solid #ff0000}
 h1{margin:0 0 10px;font-size:24px;color:#112233}
 p{margin:0 0 16px;font-size:14px;line-height:20px;color:#445566}
 .btn{display:inline-block;padding:8px 16px;border-radius:8px;background:linear-gradient(90deg,#0000ff,#00ffff);color:#fff;font-weight:700}
 img{display:block;width:60px;height:40px;margin-top:10px}
 .gone{display:none}
</style>
<div class="card"><h1>Hello import</h1><p>This paragraph is long enough to wrap onto a second line inside the card for sure.</p><a class="btn">Buy now</a><img src="${picture}" alt="pic"><svg width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#00ff00"/></svg><div class="gone">hidden</div><script>document.body.innerHTML = 'scripts must not run'</script></div>`;
const imported = await ev(async html => {
  const m = await import('/src/import/html.ts');
  const r = await m.htmlToNodes(html, { width: 400, name: 'Test page' });
  const flat = [];
  const walk = (n, depth) => { flat.push({ type: n.type, name: n.name, x: n.x, y: n.y, w: n.width, h: n.height, fill: n.fill, stroke: n.stroke, sw: n.strokeWidth, r: n.cornerRadius, effect: n.effect, content: n.content, size: n.fontSize, weight: n.fontWeight, growth: n.textGrowth, depth }); (n.children ?? []).forEach(c => walk(c, depth + 1)); };
  walk(r.node, 0);
  return { flat, count: r.count, warnings: r.warnings, looks: [m.looksLikeHtml(html), m.looksLikeHtml('<svg viewBox="0 0 1 1"><path d="M0 0"/></svg>'), m.looksLikeHtml('just some text'), m.looksLikeHtml('<div class="a"><p>Hi there</p></div>')] };
}, pageHtml);
const F = imported.flat;
const card = F.find(n => n.name === '.card'), h1 = F.find(n => n.content === 'Hello import'), para = F.find(n => /^This paragraph/.test(n.content ?? '')), btn = F.find(n => n.name === '.btn'), btnText = F.find(n => n.content === 'Buy now'), pic = F.find(n => n.fill?.type === 'image'), paths = F.filter(n => n.type === 'path');
ok('HTML becomes a frame of layers with the page\'s boxes and paint',
  F[0].type === 'frame' && F[0].w === 400 && F[0].fill === '#101820' && !!card && card.x === 40 && card.y === 30 && card.w === 344 && card.fill === '#FFFFFF' && card.stroke === '#FF0000' && card.sw === 2 && card.r === 16 && card.effect?.blur === 20 && card.effect?.offset?.y === 8,
  JSON.stringify(card));
ok('text keeps its font, size and colour; long text wraps at the same width', !!h1 && h1.size === 24 && h1.weight === '700' && h1.fill === '#112233' && !!para && para.growth === 'fixed-width' && para.size === 14 && para.fill === '#445566', JSON.stringify({ h1, para }));
ok('a gradient button, a picture and an inline SVG come across', !!btn && btn.fill?.type === 'gradient' && btn.fill.rotation === 270 && btn.fill.colors?.[0]?.color === '#0000FF' && btn.r === 8 && !!btnText && btnText.fill === '#FFFFFF' && !!pic && pic.w === 60 && pic.h === 40 && paths.length >= 1, JSON.stringify({ btn, pic: pic && { w: pic.w, h: pic.h }, paths: paths.length }));
ok('hidden elements and scripts are left out', !F.some(n => n.content === 'hidden') && !F.some(n => /scripts must not run/.test(n.content ?? '')), `${imported.count} layers; warnings ${JSON.stringify(imported.warnings)}`);
ok('pasted markup is recognised as HTML (and SVG or plain text is not)', JSON.stringify(imported.looks) === '[true,false,false,true]', JSON.stringify(imported.looks));
const topBefore = await ev(() => window.__penStore.getState().doc.children.length);
const viaAgent = await ev(html => window.__penAgent('importHtml', { html, width: 400, name: 'Imported card' }).catch(e => ({ error: String(e) })), pageHtml);
await frames();
const placedPage = await ev(id => { const d = window.__penStore.getState().doc; const n = d.children.find(c => c.id === id); const others = d.children.filter(c => c.id !== id && typeof c.x === 'number'); return n && { count: d.children.length, name: n.name, x: n.x, right: Math.max(...others.map(c => c.x + (typeof c.width === 'number' ? c.width : 0))), kids: n.children.length }; }, viaAgent.id);
ok('import_html adds one frame to the right of the design', !viaAgent.error && placedPage?.count === topBefore + 1 && placedPage.name === 'Imported card' && placedPage.x >= placedPage.right + 100 && placedPage.kids >= 1 && viaAgent.layers >= 6, JSON.stringify({ viaAgent, placedPage }));

// ---------- Figma import ----------
// Needs sample files that are not in the repository (other people's work): dev/fixtures/figma/structure.fig,
// stacks_wrap.fig and frame-with-r-g-b-rect.clipboard.html (see tests/README.md for where they come from).
const figDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', 'fixtures', 'figma');
if (!fs.existsSync(path.join(figDir, 'structure.fig'))) {
  console.log('SKIP Figma import (no sample files in dev/fixtures/figma)');
} else {
  const b64 = name => fs.readFileSync(path.join(figDir, name)).toString('base64');
  const flatten = `(nodes => { const out = []; const walk = (n, d) => { out.push({ id: n.id, type: n.type, name: n.name, layout: n.layout, w: n.width, h: n.height, fill: n.fill, content: n.content, d }); (n.children ?? []).forEach(c => walk(c, d + 1)); }; nodes.forEach(n => walk(n, 0)); return out; })`;
  const before = await ev(() => { const d = window.__penStore.getState().doc; return { count: d.children.length, right: Math.max(...d.children.filter(c => typeof c.x === 'number').map(c => c.x + (typeof c.width === 'number' ? c.width : 0))) }; });
  const fig = await ev(async (data, flatten) => {
    const m = await import('/src/editor/ops.ts');
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    try {
      const info = await m.figmaPages(bytes);
      const r = await m.importFigma({ bytes });
      const d = window.__penStore.getState().doc;
      const added = d.children.filter(c => r.ids.includes(c.id));
      return { info, r: { ...r, ids: r.ids.length }, first: r.ids[0], minX: Math.min(...added.map(c => c.x)), flat: eval(flatten)(added), summary: m.figmaSummary(r) };
    } catch (e) {
      return { error: String(e) };
    }
  }, b64('structure.fig'), flatten);
  await frames();
  const FF = fig.flat ?? [];
  ok('a .fig file becomes layers beside the design: frames, text and vector paths',
    !fig.error && fig.r.ids >= 1 && fig.minX >= before.right + 100 && FF.some(n => n.type === 'frame') && FF.some(n => n.type === 'text' && n.content) && FF.some(n => n.type === 'path' || n.type === 'rectangle' || n.type === 'ellipse') && fig.r.layers === FF.length,
    fig.error ?? `${fig.summary} | pages ${JSON.stringify(fig.info.pages)} | types ${[...new Set(FF.map(n => n.type))].join(',')}`);
  const figRect = fig.first ? await rect(fig.first) : null;
  ok('the imported layers are drawn', !!figRect && figRect.w > 0 && figRect.h > 0, JSON.stringify(figRect));
  if (shots && fig.first) {
    const shot = await ev(ids => window.__penAgent('screenshot', { id: ids, max_size: 1000 }).catch(e => ({ error: String(e) })), fig.first);
    if (shot?.dataUrl) fs.writeFileSync(`${shots}/v1_figma.png`, Buffer.from(shot.dataUrl.slice(shot.dataUrl.indexOf(',') + 1), 'base64'));
  }

  const wrap = await ev(async (data, flatten) => {
    const m = await import('/src/import/figma/index.ts');
    const r = await m.importFigFile(Uint8Array.from(atob(data), c => c.charCodeAt(0)));
    return { flat: eval(flatten)(r.nodes), warnings: r.warnings, isFig: m.isFigFile(Uint8Array.from(atob(data), c => c.charCodeAt(0))), notFig: m.isFigFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) };
  }, b64('stacks_wrap.fig'), flatten);
  ok('auto layout comes across as layout frames; other files are refused', wrap.isFig && !wrap.notFig && wrap.flat.some(n => n.layout === 'horizontal' || n.layout === 'vertical'), `${wrap.flat.length} layers, layouts ${[...new Set(wrap.flat.map(n => n.layout).filter(Boolean))].join(',')}; ${wrap.warnings.join('; ')}`);

  // The dialog: choose a file, see its pages, import the chosen one.
  await ev(() => window.__penStore.setState({ modal: 'importFigma' }));
  await page.waitForSelector('[data-fig-import]');
  const [chooser] = await Promise.all([page.waitForFileChooser(), page.evaluate(() => [...document.querySelectorAll('.modal button')].find(b => /Choose file/.test(b.textContent)).click())]);
  await chooser.accept([path.join(figDir, 'structure.fig')]);
  await page.waitForFunction(() => /structure\.fig/.test(document.querySelector('[data-fig-name]')?.textContent ?? ''), { timeout: 15000 });
  const dialog = await ev(() => ({ pages: document.querySelector('.modal')?.textContent ?? '', enabled: !document.querySelector('[data-fig-import]').disabled, count: window.__penStore.getState().doc.children.length }));
  await page.click('[data-fig-import]');
  await page.waitForFunction(() => window.__penStore.getState().modal === null, { timeout: 30000 });
  const afterDialog = await ev(() => ({ count: window.__penStore.getState().doc.children.length, selected: window.__penStore.getState().selection.length, toast: document.querySelector('.toast')?.textContent ?? '' }));
  ok('the Figma dialog lists the pages and imports the chosen one', /Page/.test(dialog.pages) && /layer/.test(dialog.pages) && dialog.enabled && afterDialog.count > dialog.count && afterDialog.selected >= 1, JSON.stringify({ afterDialog, was: dialog.count }));

  // Paste: Figma puts its layers in the clipboard's HTML.
  const clip = fs.readFileSync(path.join(figDir, 'frame-with-r-g-b-rect.clipboard.html'), 'utf8');
  const cdp = await browser.target().createCDPSession();
  await cdp.send('Browser.grantPermissions', { origin: new URL(url).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await page.bringToFront();
  const pasted = await ev(async (html, flatten) => {
    const m = await import('/src/editor/ops.ts');
    const s = window.__penStore.getState();
    s.select([]);
    const before = s.doc.children.map(c => c.id);
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([''], { type: 'text/plain' }) })]);
    } catch (e) {
      return { error: 'clipboard write: ' + e };
    }
    await m.paste();
    const d = window.__penStore.getState().doc;
    const added = d.children.filter(c => !before.includes(c.id));
    const c = m.clientToWorld(innerWidth / 2, innerHeight / 2);
    return { flat: eval(flatten)(added), top: added.map(n => ({ x: n.x, y: n.y, w: n.width, h: n.height })), centre: c, toast: document.querySelector('.toast')?.textContent ?? '' };
  }, clip, flatten);
  const pf = pasted.flat ?? [];
  const pt = pasted.top?.[0];
  ok('layers copied in Figma paste as layers in the middle of the view',
    !pasted.error && pf.length >= 4 && pf[0].type === 'frame' && pf.filter(n => n.type === 'rectangle').length === 3 && !!pt && Math.abs(pt.x + pt.w / 2 - pasted.centre.x) < 2 && Math.abs(pt.y + pt.h / 2 - pasted.centre.y) < 2,
    pasted.error ?? JSON.stringify({ types: pf.map(n => n.type), fills: pf.map(n => n.fill), top: pt, centre: pasted.centre, toast: pasted.toast }));

  // What the MCP tool does: it converts the file itself and hands the layers over.
  const handed = await ev(async () => {
    const before = window.__penStore.getState().doc.children.length;
    const r = await window.__penAgent('insertImported', { source: 'import_figma', nodes: [{ type: 'frame', id: 'same', name: 'Handed over', x: 5, y: 7, width: 100, height: 50, fill: '#FF00FF', children: [{ type: 'text', id: 'same', content: 'Hi' }] }, { type: 'rectangle', id: 'same', x: 205, y: 7, width: 20, height: 20 }] }).catch(e => ({ error: String(e) }));
    const d = window.__penStore.getState().doc;
    const added = d.children.filter(c => r.ids?.includes(c.id));
    const ids = new Set(); const walk = n => { ids.add(n.id); (n.children ?? []).forEach(walk); }; d.children.forEach(walk);
    let total = 0; const cnt = n => { total++; (n.children ?? []).forEach(cnt); }; d.children.forEach(cnt);
    return { r, grew: d.children.length - before, gap: added[1]?.x - added[0]?.x, sameY: added[1]?.y === added[0]?.y, unique: ids.size === total };
  });
  ok('layers handed over by import_figma keep their places relative to each other and get ids of their own', !handed.r.error && handed.grew === 2 && handed.gap === 200 && handed.sameY && handed.unique, JSON.stringify(handed));
}

ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
