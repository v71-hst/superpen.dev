// Reference-tracing tools and drawing fixes, with this script acting as the MCP agent: analyze_image, zoom crops,
// compare_to_reference, screenshot background/sizes, ai_pen_draw match_aspect, reference_ids under an AI Pen box,
// and zero-width (perfectly vertical) imported paths being drawn.
// Usage: node imagetools.mjs <url of a copy of features.pen> <screenshot dir>   (uses dev/fixtures/datapad-ref.png + datapad.svg, which are not in the repo)
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
const [, , url, shotDir] = process.argv;
const fx = new URL('../dev/fixtures/', import.meta.url);
const refUrl = 'data:image/png;base64,' + fs.readFileSync(new URL('datapad-ref.png', fx)).toString('base64');
const svg = fs.readFileSync(new URL('datapad.svg', fx), 'utf8');
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pen-world [data-k]');
await new Promise(r => setTimeout(r, 1500));
const A = (m, p) => page.evaluate((m, p) => window.__penAgent(m, p), m, p);
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const save = (name, dataUrl) => fs.writeFileSync(`${shotDir}/${name}`, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
const done = () => page.waitForFunction(() => window.__penStore.getState().aiPenPasses.length === 0, { timeout: 30000 });

// analyze_image on a file
const an = await A('analyzeImage', { image: refUrl, probes: { rows: [346], rings: [{ cx: 323, cy: 492, r: 104 }] }, zoom: { x: 215, y: 660, w: 215, h: 34 } });
ok('size and background', /size 640×1138/.test(an.text) && /background #00243E/.test(an.text), an.text.split('\n').slice(0, 2).join(' | '));
ok('finds the right-hand ticks as bars', /\[530,119\]-\[579,128\] 50×10 .* bar/.test(an.text));
ok('ring probe finds the outer arcs', / 2[5-7](\.5)?°-12[01](\.5)?° #F/.test(an.text), an.text.split('\n').find(l => l.startsWith('ring')));
ok('row probe reads the dashes', /row y=346: .*x149-160/.test(an.text), (an.text.split('\n').find(l => l.startsWith('row')) ?? '').slice(0, 120));
ok('zoom crop returned', typeof an.zoom === 'string' && an.zoom.startsWith('data:image/png'));
save('it_zoom.png', an.zoom);

// match_aspect + zero-width lines: draw the datapad from its own pixel coordinates
const d1 = await A('aiPenDraw', { x: 1200, y: 0, width: 574, height: 929, name: 'Datapad test', prompt: 'datapad', svg, match_aspect: true, done: true });
const fr = await page.evaluate(id => window.__penStore.getState().doc.children.find(n => n.id === id), d1.frame_id);
ok('match_aspect keeps width, takes viewBox proportions', fr.width === 574 && Math.abs(fr.height - 1020.69) < 0.1, `${fr.width}×${fr.height}`);
await done();
const vert = await page.evaluate(id => {
  const f = window.__penStore.getState().doc.children.find(n => n.id === id);
  const n = f.children.find(c => c.name === 'trunk-lower');
  const el = n && document.querySelector(`[data-k="${n.id}"] svg`);
  return el ? { w: el.getBoundingClientRect().width, nodeW: n.width } : null;
}, d1.frame_id);
ok('vertical line path gets a paintable svg', !!vert && vert.w >= 1, JSON.stringify(vert));

// compare_to_reference
const cmp = await A('compareReference', { id: d1.frame_id, image: refUrl });
const score = parseFloat(cmp.text.match(/match ([\d.]+)%/)?.[1] ?? '0');
ok('compare scores the faithful remake highly', score > 99, cmp.text.split('\n')[0]);
save('it_compare.png', cmp.dataUrl);
// the lower trunk (a perfectly vertical line) must actually be painted: sample the render where it is
const trunk = await page.evaluate(async (id, ref) => {
  const r = await window.__penAgent('analyzeImage', { id, scale: 640 / 574, probes: { rows: [1000] } });
  return r.text.split('\n').find(l => l.startsWith('row'));
}, d1.frame_id, refUrl);
ok('vertical trunk line is drawn', /x7[0-2]-7[6-8] #F/.test(trunk ?? ''), trunk?.slice(0, 140));
// a broken drawing scores low and the worst areas point at the damage
const bad = await A('aiPenDraw', { frame_id: d1.frame_id, clear: true, svg: svg.replace(/<path id="ring-outer-left"[^>]*\/>/, ''), done: true });
await done();
const cmp2 = await A('compareReference', { id: bad.frame_id, image: refUrl });
const score2 = parseFloat(cmp2.text.match(/match ([\d.]+)%/)?.[1] ?? '0');
ok('a missing part costs a clear drop in score', score - score2 > 0.5, `${score} -> ${score2}`);
ok('missing part shows up in the worst areas', /ref x192-256 y(341|455|512)/.test(cmp2.text) || /ref x(192|256)/.test(cmp2.text), cmp2.text.split('\n').slice(0, 3).join(' | '));

// screenshot background and icon sizes
const icon = await A('aiPenDraw', { x: 1900, y: 0, width: 128, height: 128, prompt: 'icon', svg: '<path d="M20 64 H108 M64 20 V108" stroke="#fff" stroke-width="10" stroke-linecap="round" fill="none"/>', done: true });
await done();
const plain = await A('screenshot', { id: icon.frame_id });
const dark = await A('screenshot', { id: icon.frame_id, background: 'dark' });
const sizes = await A('screenshot', { id: icon.frame_id, sizes: [128, 32, 16] });
save('it_dark.png', dark.dataUrl);
save('it_sizes.png', sizes.dataUrl);
ok('background option', dark.dataUrl !== plain.dataUrl && dark.width === plain.width, `${dark.width}×${dark.height}`);
ok('icon sizes preview', sizes.width > 128 + 32 + 16 && sizes.height >= 128, `${sizes.width}×${sizes.height}`);
const plus = await A('analyzeImage', { id: icon.frame_id });
ok('icon cross: both strokes drawn (one shape spanning both axes)', /\[1[4-6],1[4-6]\]-\[11[1-3],11[1-3]\]/.test(plus.text), plus.text.split('\n').filter(l => l.startsWith('  [')).join(' | '));

// reference_ids: an image layer under an AI Pen box
await A('applyOps', { operations: [{ op: 'insert', parent: null, node: { type: 'rectangle', id: 'refimg', name: 'Reference', x: 2200, y: 0, width: 160, height: 284, fill: { type: 'image', url: refUrl, mode: 'stretch' } } }] });
await page.evaluate(() => {
  window.__penStore.setState(s => ({ aiPenRequests: [...s.aiPenRequests, { id: 'ptest', prompt: 'trace this', status: 'waiting', t: Date.now(), box: { x: 2180, y: -20, wx: 2180, wy: -20, width: 220, height: 330, parent: null } }] }));
});
const reqs = (await A('aiPenRequests', {})).requests;
ok('request lists the image layer under its box', reqs.some(r => r.request_id === 'ptest' && r.reference_ids?.includes('refimg')), JSON.stringify(reqs.map(r => r.reference_ids)));
const an2 = await A('analyzeImage', { id: 'refimg', scale: 4 });
ok('analyze an image layer by id', /size 640×1136|size 640×1138/.test(an2.text) || /size 6\d\d×11\d\d/.test(an2.text), an2.text.split('\n')[0]);

await browser.close();
