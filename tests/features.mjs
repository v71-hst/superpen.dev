// End-to-end checks for states, prototype, snapping, gap handles, comments, review mode, lint, find/replace,
// mixed multi-select and the Roblox export.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#pen-world [data-k]');
await new Promise(r => setTimeout(r, 1500));
const results = [];
const check = (name, ok, info = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const ev = (fn, ...a) => page.evaluate(fn, ...a);
const frames = () => ev(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
await ev(() => window.__penStore.getState().setView({ x: 100, y: 100, zoom: 1 }));
await frames();
const bg = k => ev(k => { const el = document.querySelector(`#pen-world [data-k="${k}"]`); return el && (getComputedStyle(el).backgroundImage.match(/rgb\([^)]+\)/)?.[0] ?? getComputedStyle(el).backgroundColor); }, k);
const rect = k => ev(k => { const r = document.querySelector(`#pen-world [data-k="${k}"]`).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, k);

// --- states
check('instance default color', (await bg('inst')) === 'rgb(51, 102, 255)', await bg('inst'));
await ev(() => window.__penStore.getState().edit(d => { d.children[0].children[1].state = 'hover'; }));
await frames();
check('instance hover state applies', (await bg('inst')) === 'rgb(255, 0, 0)', await bg('inst'));
await ev(() => window.__penStore.getState().edit(d => { delete d.children[0].children[1].state; }));
await ev(() => window.__penStore.setState({ stateView: { comp: 'btn', state: 'hover' } }));
await frames();
check('component previews its state', (await bg('btn')) === 'rgb(255, 0, 0)', await bg('btn'));
await ev(() => { window.__penStore.getState().select(['lbl']); });
await frames();
// Edit the label through the panel path (applyProps) while the state is shown.
await ev(async () => { const m = await import('/src/editor/store.ts'); window.__penStore.getState().edit(d => m.applyProps(d, 'lbl', { content: 'Hovered!' })); });
const st = await ev(() => { const b = window.__penStore.getState().doc.children[0].children[0]; return { states: b.states, base: b.children[0].content }; });
check('edits while a state is shown go to the state', st.states.hover.descendants?.lbl?.content === 'Hovered!' && st.base === 'Click me', JSON.stringify(st));
await ev(() => window.__penStore.setState({ stateView: null, selection: [] }));

// --- snapping: drag boxB so its left edge lands within a few px of boxA's left edge
await frames();
const a = await rect('boxA');
const b = await rect('boxB');
await page.mouse.move(b.x + 30, b.y + 30);
await page.mouse.down();
await page.mouse.move(b.x + 20, b.y + 20, { steps: 3 });
await page.mouse.move(a.x + 60 + 2 + 30, b.y + 10, { steps: 6 });
const guides = await ev(() => document.querySelectorAll('.space-guide').length);
await page.mouse.up();
await frames();
const bx = await ev(() => window.__penStore.getState().doc.children[0].children.find(n => n.id === 'boxB').x);
check('drag snaps to sibling edge', bx === 260, `boxB.x=${bx}, guides shown: ${guides}`);

// --- gap handle
await ev(() => window.__penStore.getState().select(['row']));
await frames();
await new Promise(r => setTimeout(r, 100));
const handles = await ev(() => [...document.querySelectorAll('.gap-handle')].map(h => { const r = h.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }));
check('gap handles shown for auto-layout frame', handles.length === 2, `${handles.length} handles`);
if (handles[0]) {
  await page.mouse.move(handles[0].x, handles[0].y);
  await page.mouse.down();
  await page.mouse.move(handles[0].x + 8, handles[0].y, { steps: 4 });
  await page.mouse.up();
  const gap = await ev(() => window.__penStore.getState().doc.children[0].children.find(n => n.id === 'row').gap);
  check('dragging a gap handle changes gap', gap === 18, `gap=${gap}`);
}

// --- mixed multi-select panel
await ev(() => window.__penStore.getState().select(['boxA', 'tiny']));
await frames();
const sections = await ev(() => [...document.querySelectorAll('.right-panel .section-head > span:first-child')].map(s => s.textContent));
check('mixed selection shows fill + typography', sections.includes('Typography') && sections.some(s => s.startsWith('Fill')), sections.join(', '));
await ev(async () => { const m = await import('/src/editor/store.ts'); });

// --- prototype + present hover states
await ev(() => window.__penStore.setState({ selection: [], presenting: 0 }));
await new Promise(r => setTimeout(r, 400));
const pinst = await ev(() => { const r = document.querySelector('.present [data-k="inst"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.move(pinst.x, pinst.y);
await new Promise(r => setTimeout(r, 150));
const hoverBg = await ev(() => { const s = getComputedStyle(document.querySelector('.present [data-k="inst"]')); return s.backgroundImage.match(/rgb\([^)]+\)/)?.[0] ?? s.backgroundColor; });
check('present: hover state plays automatically', hoverBg === 'rgb(255, 0, 0)', hoverBg);
await page.mouse.click(pinst.x, pinst.y);
await new Promise(r => setTimeout(r, 400));
const p1 = await ev(() => window.__penStore.getState().presenting);
check('present: clicking a link navigates', p1 === 1, `presenting=${p1}`);
const back = await ev(() => { const r = document.querySelector('.present [data-k="back"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.click(back.x, back.y);
await new Promise(r => setTimeout(r, 300));
check('present: back link returns', (await ev(() => window.__penStore.getState().presenting)) === 0);
await ev(() => window.__penStore.setState({ presenting: null }));
await frames();

// --- comments
await ev(() => window.__penStore.setState({ tool: 'comment' }));
const ar = await rect('boxA');
await page.mouse.click(ar.x + 10, ar.y + 10);
await frames();
await page.keyboard.type('Make this blue');
await page.keyboard.press('Enter');
await frames();
const cm = await ev(() => window.__penStore.getState().doc.comments);
check('comment created on node with message', cm?.length === 1 && cm[0].node === 'boxA' && cm[0].messages[0]?.text === 'Make this blue', JSON.stringify(cm));
const notes = (await ev(() => window.__penAgent('summary', {}))).notes;
check('agent is told about open comments', notes.some(n => /open comment/.test(n)), JSON.stringify(notes));
const list = await ev(() => window.__penAgent('comments', {}));
await ev(id => window.__penAgent('replyComment', { id, text: 'Done, made it blue.', resolve: true, name: 'test-chat' }), list[0].id);
const cm2 = await ev(() => window.__penStore.getState().doc.comments[0]);
check('agent reply + resolve', cm2.resolved === true && cm2.messages[1].author === 'agent', JSON.stringify(cm2.messages));
await ev(() => window.__penStore.setState({ openComment: null }));

// --- review mode
await ev(() => window.__penStore.setState({ reviewMode: true }));
const before = await ev(() => window.__penStore.getState().doc.children[0].children.find(n => n.id === 'boxA').fill);
const ap = await ev(() => window.__penAgent('applyOps', { operations: [{ op: 'update', id: 'boxA', props: { fill: '#00FF00' } }] }));
await frames();
const pend = await ev(() => { const p = window.__penStore.getState().pending; return p && { batches: p.batches, touched: p.touched }; });
const banner = await ev(() => document.querySelector('.canvas-banner.review')?.textContent ?? '');
check('review: agent edit is pending with banner', !!pend && /Claude/.test(banner) && ap.notes.some(n => /Review mode/.test(n)), JSON.stringify({ pend, banner, ap }));
await ev(() => [...document.querySelectorAll('.canvas-banner.review button')].find(b => /Reject/.test(b.textContent)).click());
await frames();
const after = await ev(() => window.__penStore.getState().doc.children[0].children.find(n => n.id === 'boxA').fill);
check('review: reject restores', after === before && !(await ev(() => window.__penStore.getState().pending)), `${before} -> ${after}`);
await ev(() => window.__penAgent('applyOps', { operations: [{ op: 'update', id: 'boxA', props: { fill: '#00FF00' } }] }));
await ev(() => [...document.querySelectorAll('.canvas-banner.review button')].find(b => /Accept/.test(b.textContent)).click());
const acc = await ev(() => window.__penStore.getState().doc.children[0].children.find(n => n.id === 'boxA').fill);
check('review: accept keeps', acc === '#00FF00', acc);
await ev(() => window.__penStore.setState({ reviewMode: false }));

// --- lint
await ev(() => window.__penStore.getState().edit(d => { d.children[0].children.find(n => n.id === 'row').children[0].fill = '#3366FF'; }));
const lint = await ev(() => window.__penAgent('lint', {}));
const rules = [...new Set(lint.map(i => i.rule))];
check('lint finds variable/tiny/contrast', ['use-variable', 'tiny-text', 'contrast'].every(r => rules.includes(r)), rules.join(','));

// --- find & replace
await ev(() => window.__penStore.setState({ modal: 'find', selection: [] }));
await frames();
await page.type('.find-modal input', 'Back');
await page.type('.find-modal .find-row:nth-child(2) input', 'Go back');
await ev(() => [...document.querySelectorAll('.find-modal button')].find(b => /Replace all/.test(b.textContent)).click());
const txt = await ev(() => window.__penStore.getState().doc.children[1].children[0].content);
check('find & replace text', txt === 'Go back', txt);
await ev(() => window.__penStore.setState({ modal: null }));

// --- roblox
const rb = await ev(() => window.__penAgent('exportRoblox', { id: 'home' }));
const opens = (rb.code.match(/make\(/g) || []).length;
check('roblox export produces code', /return function\(parent\)/.test(rb.code) && opens > 8 && /UICorner/.test(rb.code) && /TextLabel/.test(rb.code), `${opens} make() calls, ${rb.warnings.length} warnings`);
console.log(results.join('\n'));
console.log('page errors:', errors.length, errors.slice(0, 3));
console.log('---- roblox sample ----\n' + rb.code.split('\n').slice(0, 40).join('\n'));
await browser.close();
