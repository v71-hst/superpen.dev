// AI Pen end to end, with this script acting as the MCP agent: canvas request -> agent notes -> ai_pen_draw passes
// (replayed with the AI Pen cursor) -> change request from the right panel -> cancel, plus markup sanitising.
// Usage: node aipen.mjs <url of a .pen whose first top-level frame is F1> <screenshot dir>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, shotDir] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1500, height: 950 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pen-world [data-k]');
await new Promise(r => setTimeout(r, 1500));
const st = () => page.evaluate(() => { const s = window.__penStore.getState(); return { tool: s.tool, draft: s.aiPenDraft, requests: s.aiPenRequests, passes: s.aiPenPasses.length }; });
const A = (m, p) => page.evaluate((m, p) => window.__penAgent(m, p), m, p);
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);

await page.mouse.click(750, 600);
await page.keyboard.down('Shift'); await page.keyboard.press('KeyP'); await page.keyboard.up('Shift');
ok('Shift+P selects AI Pen', (await st()).tool === 'aipen');
await page.mouse.move(520, 220); await page.mouse.down(); await page.mouse.move(700, 380, { steps: 5 }); await page.mouse.move(820, 520, { steps: 5 }); await page.mouse.up();
await page.type('.aipen-prompt textarea', 'heraldic shield with a crown, white line art');
await page.keyboard.press('Enter');
let s = await st();
ok('request created', s.requests.length === 1 && s.requests[0].status === 'waiting', JSON.stringify(s.requests[0]?.box));
ok('waiting card shown', !!(await page.$('.aipen-box.waiting')));
await page.screenshot({ path: shotDir + '/pen_waiting.png' });

const sum = await A('summary', {});
ok('agent told about it in notes', sum.notes.some(n => /AI Pen: the user is waiting/.test(n)), sum.notes[0]);
const reqs = (await A('aiPenRequests', {})).requests;
ok('ai_pen_requests lists it', reqs.length === 1 && reqs[0].kind === 'draw', JSON.stringify(reqs[0]));
const rid = reqs[0].request_id;
const [W, H] = [reqs[0].box.width, reqs[0].box.height];

const pass1 = `<path id="shield" d="M ${W*0.2} ${H*0.3} L ${W*0.8} ${H*0.3} L ${W*0.8} ${H*0.58} C ${W*0.8} ${H*0.78} ${W*0.5} ${H*0.94} ${W*0.5} ${H*0.94} C ${W*0.5} ${H*0.94} ${W*0.2} ${H*0.78} ${W*0.2} ${H*0.58} Z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/>`;
const r1 = await A('aiPenDraw', { request_id: rid, svg: pass1 });
ok('pass 1 creates frame in the box', !!r1.frame_id && r1.added === 1, JSON.stringify(r1));
await new Promise(r => setTimeout(r, 300));
ok('cursor visible while tracing', !!(await page.$('.aipen-cursor')));
ok('real shape hidden until traced', await page.evaluate(() => [...document.querySelectorAll('.aipen-layer style')].some(x => /visibility:hidden/.test(x.textContent))));
await page.screenshot({ path: shotDir + '/pen_tracing.png' });
await page.waitForFunction(() => window.__penStore.getState().aiPenPasses.length === 0, { timeout: 10000 });
const pass2 = `<path id="crown" d="M ${W*0.32} ${H*0.24} L ${W*0.32} ${H*0.08} L ${W*0.41} ${H*0.16} L ${W*0.5} ${H*0.05} L ${W*0.59} ${H*0.16} L ${W*0.68} ${H*0.08} L ${W*0.68} ${H*0.24} Z" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/><circle id="gem" cx="${W*0.5}" cy="${H*0.55}" r="${W*0.08}" fill="#ffd84d"/><script>window.__pwned=1</script><rect id="evil" onload="window.__pwned=2" x="0" y="0" width="1" height="1" fill="none"/>`;
const r2 = await A('aiPenDraw', { frame_id: r1.frame_id, request_id: rid, svg: pass2, done: true });
ok('pass 2 adds to the same frame and finishes the request', r2.frame_id === r1.frame_id && (await st()).requests.length === 0, JSON.stringify(r2));
await page.waitForFunction(() => window.__penStore.getState().aiPenPasses.length === 0, { timeout: 10000 });
await new Promise(r => setTimeout(r, 400));
ok('script and event handlers stripped', await page.evaluate(() => !window.__pwned));
const frame = await page.evaluate(id => { const find = (list) => { for (const n of list ?? []) { if (n.id === id) return n; const hit = find(n.children); if (hit) return hit; } return null; }; const f = find(window.__penStore.getState().doc.children); return { x: f.x, y: f.y, w: f.width, h: f.height, kids: f.children.length, meta: f.aiPen }; }, r1.frame_id);
ok('frame holds both passes, positioned in the box', frame.kids >= 3, JSON.stringify(frame));
ok('no hidden shapes left after replay', await page.evaluate(() => !document.querySelector('.aipen-layer style')));
await page.screenshot({ path: shotDir + '/pen_done.png' });

// change request from the right panel
await page.evaluate(id => { window.__penStore.getState().select([id]); window.__penStore.setState({ rightOpen: true }); }, r1.frame_id);
await new Promise(r => setTimeout(r, 400));
const input = await page.$('.right-panel input[placeholder^="Ask your AI"]');
ok('right panel AI Pen section', !!input);
await input.type('thicker lines');
await page.keyboard.press('Enter');
const cr = (await A('aiPenRequests', {})).requests;
ok('change request reaches the agent', cr.length === 1 && cr[0].kind === 'change' && cr[0].frame_id === r1.frame_id && cr[0].original_prompt?.startsWith('heraldic'), JSON.stringify(cr[0]));
await page.screenshot({ path: shotDir + '/pen_change.png' });
const r3 = await A('aiPenDraw', { request_id: cr[0].request_id, clear: true, svg: pass1.replace('stroke-width="5"', 'stroke-width="12"'), done: true });
const kids = await page.evaluate(id => { const find = list => { for (const n of list ?? []) { if (n.id === id) return n; const hit = find(n.children); if (hit) return hit; } return null; }; return find(window.__penStore.getState().doc.children).children.length; }, r1.frame_id);
ok('change redraws the same frame', r3.frame_id === r1.frame_id && kids === 1 && (await st()).requests.length === 0, `kids ${kids}`);

// cancel
await page.evaluate(() => { const s = window.__penStore.getState(); window.__penStore.setState({ aiPenRequests: [{ id: 'pX', prompt: 'test', box: { x: 0, y: 0, wx: 0, wy: 0, width: 100, height: 100, parent: null }, status: 'waiting', t: Date.now() }] }); });
await new Promise(r => setTimeout(r, 200));
await page.evaluate(() => document.querySelector('.aipen-box.waiting button').click());
ok('cancel removes request', (await st()).requests.length === 0);
await browser.close();
