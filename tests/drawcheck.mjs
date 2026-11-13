// check_drawing: stroke ends just off the line they meet are found (with the fix point), exact joints are not flagged,
// close-ups come back, and compare_to_reference returns close-ups of its worst areas.
// Usage: node drawcheck.mjs <url of a copy of features.pen> <screenshot dir>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
const [, , url, shotDir] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pen-world [data-k]');
await new Promise(r => setTimeout(r, 1500));
const A = (m, p) => page.evaluate((m, p) => window.__penAgent(m, p), m, p);
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const save = (name, dataUrl) => dataUrl && fs.writeFileSync(`${shotDir}/${name}`, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
const done = () => page.waitForFunction(() => window.__penStore.getState().aiPenPasses.length === 0, { timeout: 20000 });
const icon = (inner, tx) => `<g transform="translate(${tx} 4) scale(1.4545)">${inner}</g>`;
const draw = async (name, inner) => {
  const d = await A('aiPenDraw', { x: 4000, y: 4000 + Math.random() * 1000, width: 40, height: 40, prompt: name, done: true, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><g fill="none" stroke="#3C505F" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon(inner, 2.05)}</g></svg>` });
  await done();
  return d.frame_id;
};

// Graduation cap whose band stops short of the cap edge: the band ends' caps show beside the edge (visible bumps).
const grad = await draw('grad', '<path d="M1.9 6.8L12 1.9l7.1 4.9L12 11.6z"/><path d="M5.3 10.4v8.1a3.5 3.5 0 0 0 3.5 3.5h4.7a3.5 3.5 0 0 0 3.5-3.5V10.4"/><path d="M19.1 6.8V19"/>');
const g = await A('checkDrawing', { id: grad });
ok('graduation cap: band ends stopping short of the cap edge are found', g.issues.length >= 2, g.text.split('\n').slice(0, 3).join(' | '));
save('dc_grad.png', g.closeups);
// Pencil as first drawn: the ferrule line misses the outline by about a unit at one end.
const pen = await draw('pencil', '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><path d="M14 6l3.5 3.5"/>');
const p = await A('checkDrawing', { id: pen });
ok('pencil: ferrule line end off the outline is found', p.issues.length >= 1, p.text.split('\n').slice(0, 2).join(' | '));
save('dc_pencil.png', p.closeups);
// Exact joints: an arrow (head meets shaft at the tip) and a camera (tab ends on the body line).
const arrow = await draw('arrow', '<path d="M2.5 12h19M16.5 7l5 5-5 5"/>');
const a = await A('checkDrawing', { id: arrow });
ok('arrow: exact joint not flagged', a.issues.length === 0, a.text);
const cam = await draw('camera', '<rect x="2.5" y="6.5" width="19" height="14.5" rx="3"/><path d="M8 6.5l1.5-3h5L16 6.5"/><circle cx="12" cy="13.5" r="3.5"/>');
const c = await A('checkDrawing', { id: cam });
ok('camera: tab ends on the body line not flagged', c.issues.length === 0, c.text.slice(0, 200));
// Fixing per the report clears it: move the pencil line's ends to the suggested points.
const fixed = await draw('pencil fixed', '<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/><path d="M14 6l3 3"/>');
const f = await A('checkDrawing', { id: fixed });
ok('pencil with the line ending on the outline is clean', f.issues.length === 0, f.text.slice(0, 200));
// Requested regions return close-ups even with no issues.
const r = await A('checkDrawing', { id: arrow, regions: [{ x: 28, y: 8, w: 8, h: 8 }] });
ok('regions give close-ups', typeof r.closeups === 'string', r.text.slice(0, 80));
save('dc_region.png', r.closeups);
// compare_to_reference close-ups (the grad cap against the camera, just to have differences)
const shot = await A('screenshot', { id: grad, scale: 4 });
const cmp = await A('compareReference', { id: cam, image: shot.dataUrl });
ok('compare returns close-ups of the worst areas', typeof cmp.closeups === 'string');
save('dc_compare_closeups.png', cmp.closeups);
await browser.close();
