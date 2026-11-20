// Stage 4 of the Skia rework (docs/SKIA_REWORK.md): with pen.renderer=full, frames Skia can draw have no DOM inside
// them and still behave like the DOM renderer: same pixels, same boxes for every lookup, clicks and hover reach their
// layers, text editing works (the frame goes DOM while edited), edits re-record the picture, agent screenshots work,
// far zoom draws rasterised copies, and losing the graphics context for good falls back with every frame visible.
// Usage: node full.mjs <url of a make-big.mjs file> [shot dir]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { launchOptions } from './browser.mjs';
const [, , url, shots] = process.argv;
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
const errors = [];

async function open(mode) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  page.on('pageerror', e => errors.push(`${mode}: ${String(e).slice(0, 200)}`));
  // Not networkidle: opened fitted to a 320-frame file, full mode keeps recording frame pictures for a while.
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}renderer=${mode}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
  await page.waitForFunction(() => window.__penStore && window.__penSkia, { timeout: 60000 });
  return page;
}

// The first screen's first list item title: Screen > List > Item > Text > title.
const setup = () => {
  const s = window.__penStore.getState();
  const f = s.doc.children[0];
  const list = f.children.find(c => c.name === 'List');
  const title = list.children[0].children[1].children[0];
  s.setView({ x: 300 - f.x, y: 20 - f.y, zoom: 1 });
  return { frame: f.id, title: title.id, list: list.id };
};
const rectOf = async key => {
  const m = await import('/src/editor/measure.ts');
  const r = m.nodeScreenRect(key);
  return r && { x: r.x, y: r.y, w: r.width, h: r.height };
};

// --- reference: the DOM renderer
const dom = await open('dom');
const ids = await dom.evaluate(setup);
// The DOM renderer loads picture fills progressively (zoom-sized copies): give them time so the reference is complete.
await sleep(10000);
const domRect = await dom.evaluate(rectOf, ids.title);
const domShot = await dom.screenshot({ encoding: 'base64' });
await dom.close();

// --- full
const page = await open('full');
await page.evaluate(setup);
const ready = await page.evaluate(async () => {
  for (let i = 0; i < 300; i++) {
    const st = window.__penSkia.skiaStatus();
    if (st.surface === 'ready' && st.pictures.eligible > 0 && !st.fonts.loading && !st.images.loading) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
});
await sleep(1500);
const st = await page.evaluate(k => ({ skia: window.__penSkia.skiaStatus().pictures, picture: !!document.querySelector(`[data-k="${k}"][data-picture]`), inside: document.querySelectorAll('#pen-world [data-picture] *').length, world: document.querySelectorAll('#pen-world *').length }), ids.frame);
ok('full: frames are drawn from Skia pictures', ready && st.picture && st.skia.eligible > 0, JSON.stringify(st.skia));
ok('no DOM inside Skia-drawn frames', st.inside === 0, `${st.world} elements in #pen-world`);

const fullShot = await page.screenshot({ encoding: 'base64' });
const cmp = await page.evaluate(async (a, b) => {
  const t = await import('/src/editor/imageTools.ts');
  const [x, y] = await Promise.all([t.loadImageData('data:image/png;base64,' + a), t.loadImageData('data:image/png;base64,' + b)]);
  const c = t.compare(x, y);
  return { match: Number(c.text.match(/match ([\d.]+)%/)?.[1] ?? 0), image: c.dataUrl };
}, domShot, fullShot);
if (shots) fs.writeFileSync(`${shots}/full-vs-dom.png`, Buffer.from(cmp.image.split(',')[1], 'base64'));
ok('looks like the DOM renderer (same view, page pixels)', cmp.match >= 97, `${cmp.match}% match`);

const fullRect = await page.evaluate(rectOf, ids.title);
const off = domRect && fullRect ? Math.max(Math.abs(domRect.x - fullRect.x), Math.abs(domRect.y - fullRect.y), Math.abs(domRect.w - fullRect.w), Math.abs(domRect.h - fullRect.h)) : Infinity;
ok('a layer inside reports the same box as in the DOM renderer', off <= 0.6, `${JSON.stringify(domRect)} vs ${JSON.stringify(fullRect)}`);

// Hover and clicks reach the layers through the layout tree.
const cx = fullRect.x + fullRect.w / 2, cy = fullRect.y + fullRect.h / 2;
await page.mouse.move(cx, cy);
await sleep(200);
const hover = await page.evaluate(() => window.__penStore.getState().hover);
ok('hover finds a layer inside the frame', !!hover && hover !== ids.frame, hover);
await page.keyboard.down('Control');
await page.mouse.click(cx, cy);
await page.keyboard.up('Control');
await sleep(200);
const sel = await page.evaluate(() => window.__penStore.getState().selection);
ok('Ctrl+click deep-selects the text layer', sel.length === 1 && sel[0] === ids.title, JSON.stringify(sel));

// Text editing: the frame stays with Skia (without the text) and the text is edited in a box over it (ui/
// TextEditOverlay.tsx). (Enter edits the selected text layer; puppeteer's synthetic double-click doesn't start editing.)
await page.keyboard.press('Enter');
await sleep(400);
const editing = await page.evaluate(k => ({ key: window.__penStore.getState().editingKey, picture: !!document.querySelector(`[data-k="${k}"][data-picture]`), editor: !!document.querySelector('[data-editing]') }), ids.frame);
ok('editing a text layer works (its frame stays with Skia, the editor is over it)', editing.key === ids.title && editing.picture && editing.editor, JSON.stringify(editing));
await page.keyboard.press('End');
await page.keyboard.type(' OK');
await page.keyboard.press('Escape');
await sleep(800);
const after = await page.evaluate((k, f) => {
  const find = (ns, id) => { for (const n of ns || []) { if (n.id === id) return n; const r = find(n.children, id); if (r) return r; } };
  return { content: find(window.__penStore.getState().doc.children, k).content, editing: window.__penStore.getState().editingKey, picture: !!document.querySelector(`[data-k="${f}"][data-picture]`) };
}, ids.title, ids.frame);
ok('the edit is saved and the frame is still drawn by Skia', after.content.endsWith(' OK') && !after.editing && after.picture, JSON.stringify(after));

// An edit re-records the frame's picture and shows on screen.
const before = await page.evaluate(() => window.__penSkia.skiaStatus().pictures.recordings);
await page.evaluate(list => window.__penStore.getState().edit(d => { const find = (ns) => { for (const n of ns || []) { if (n.id === list) return n; const r = find(n.children); if (r) return r; } }; find(d.children).children[0].fill = '#FF0000'; }), ids.list);
await sleep(600);
const red = await page.evaluate(async (k) => {
  const m = await import('/src/editor/measure.ts');
  const r = m.nodeScreenRect(k);
  return { x: r.x + 6, y: r.y + 6, rec: window.__penSkia.skiaStatus().pictures.recordings };
}, (await page.evaluate(list => window.__penStore.getState().doc.children[0].children.find(c => c.id === list).children[0].id, ids.list)));
const px = await page.screenshot({ clip: { x: red.x, y: red.y, width: 1, height: 1 }, encoding: 'base64' });
const rgb = await page.evaluate(async b => { const t = await import('/src/editor/imageTools.ts'); const d = await t.loadImageData('data:image/png;base64,' + b); return [...d.data.slice(0, 3)]; }, px);
ok('an edit re-records the picture and shows', red.rec > before && rgb[0] > 200 && rgb[1] < 60 && rgb[2] < 60, `recordings ${before} -> ${red.rec}, pixel ${rgb}`);

// Agent screenshot of a layer in a Skia-drawn frame.
const shot = await page.evaluate(k => window.__penAgent('screenshot', { id: k }).then(r => r.dataUrl.length), ids.list);
ok('agent screenshot of a layer in a Skia frame', shot > 2000, `${shot} bytes`);

// Far zoom: rasterised copies, frames visible.
await page.evaluate(() => window.__penStore.getState().setView({ x: 20, y: 20, zoom: 0.06 }));
await sleep(4000);
const far = await page.evaluate(() => window.__penSkia.skiaStatus().pictureImages);
const farShot = await page.screenshot({ encoding: 'base64' });
const filled = await page.evaluate(async b => {
  const t = await import('/src/editor/imageTools.ts');
  const d = await t.loadImageData('data:image/png;base64,' + b);
  const bg = [...d.data.slice((d.width * 450 + 1380) * 4, (d.width * 450 + 1380) * 4 + 3)];
  let differ = 0, n = 0;
  for (let y = 40; y < 500; y += 20) for (let x = 60; x < 600; x += 20) { n++; const i = (y * d.width + x) * 4; if (Math.abs(d.data[i] - bg[0]) + Math.abs(d.data[i + 1] - bg[1]) + Math.abs(d.data[i + 2] - bg[2]) > 12) differ++; }
  return { differ, n };
}, farShot);
if (shots) fs.writeFileSync(`${shots}/full-far.png`, Buffer.from(farShot, 'base64'));
ok('far zoom draws rasterised copies of the pictures', far.images > 0 && filled.differ > filled.n * 0.3, `${JSON.stringify(far)}; ${filled.differ}/${filled.n} samples painted`);

// Lost for good: falls back to the DOM renderer, every frame still there.
await page.evaluate(() => window.__penStore.getState().setView({ x: 300, y: 20, zoom: 1 }));
await sleep(500);
await page.evaluate(() => { const c = document.getElementById('pen-skia'); (c.getContext('webgl2') || c.getContext('webgl')).getExtension('WEBGL_lose_context').loseContext(); });
await sleep(7000);
const fb = await page.evaluate(() => ({ active: window.__penSkia.activeRenderer(), pictures: document.querySelectorAll('[data-picture]').length, frames: document.querySelectorAll('#pen-world > [data-k]').length, live: window.__penSkia.skiaStatus().liveObjects.total }));
ok('context lost for good: DOM renderer takes over, frames drawn', fb.active === 'dom' && fb.pictures === 0 && fb.frames > 0, JSON.stringify(fb));
ok('and every CanvasKit object is freed', fb.live === 0, `${fb.live} live`);
ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
