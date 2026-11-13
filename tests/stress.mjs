// Randomized stress test of the viewport + agent operations with invariant checks after every action.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, stepsArg = '400', seedArg = '1'] = process.argv;
let seed = Number(seedArg);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = a => a[Math.floor(rnd() * a.length)];

const browser = await puppeteer.launch(launchOptions({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 300)));
page.on('console', m => { if (m.type() === 'error' && !/404/.test(m.text())) errors.push('[console] ' + m.text().slice(0, 300)); });
if (process.env.PERF) await page.evaluateOnNewDocument(() => localStorage.setItem('pen.perfMode', '1'));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await new Promise(r => setTimeout(r, 5000));
await page.evaluate(() => {
  // Record every view change with a stack, to explain unexpected moves.
  window.__vlog = [];
  let prev = window.__penStore.getState().view;
  window.__penStore.subscribe(s => {
    if (s.view !== prev) {
      window.__vlog.push({ from: prev, to: s.view, stack: new Error().stack.split('\n').slice(2, 7).map(l => l.trim().replace(/\(http[^)]*\/src\//, '(').replace(/\?t=\d+/, '').slice(0, 90)).join(' < ') });
      prev = s.view;
    }
  });
});
const view = () => page.evaluate(() => ({ ...window.__penStore.getState().view }));
const ui = () => page.evaluate(() => ({ scrolled: [document.getElementById('pen-canvas').scrollLeft, document.getElementById('pen-canvas').scrollTop, document.documentElement.scrollTop, document.body.scrollTop].some(v => v !== 0), toolbar: !!document.querySelector('.toolbar'), canvas: !!document.getElementById('pen-world'), roots: document.getElementById('pen-world')?.children.length ?? 0, crashed: !!document.querySelector('.home-card h1') }));
const clearLog = () => page.evaluate(() => (window.__vlog = []));
const vlog = () => page.evaluate(() => window.__vlog);
const agent = (method, params) => page.evaluate(async (m, p) => { try { return { ok: await window.__penAgent(m, p) } } catch (e) { return { err: String(e).slice(0, 160) } } }, method, params);
const roots = () => page.evaluate(() => window.__penStore.getState().doc.children.map(c => c.id));

const issues = [];
const report = (step, kind, detail) => { issues.push({ step, kind, detail }); };
let inserted = 0;
const steps = Number(stepsArg);
const counts = {};

for (let step = 1; step <= steps; step++) {
  const action = pick(['zoom', 'zoom', 'zoom', 'pan', 'pan', 'drag', 'click', 'dblclick', 'agentInsert', 'agentDelete', 'agentMove', 'agentDup', 'agentSelect', 'toggleLeft', 'idle', 'fitKey', 'escape']);
  counts[action] = (counts[action] || 0) + 1;
  const x = 420 + Math.round(rnd() * 900);
  const y = 80 + Math.round(rnd() * 820);
  if (process.env.TRACE && step >= Number(process.env.TRACE) - 4 && step <= Number(process.env.TRACE)) console.log('step', step, action, x, y, JSON.stringify(await page.evaluate((x, y) => { const s = window.__penStore.getState(); const el = document.elementFromPoint(x, y); return { tool: s.tool, editing: s.editingKey, active: document.activeElement?.tagName + '.' + (document.activeElement?.className || ''), at: el?.tagName + ' ' + (el?.dataset?.k || '') + ' ' + String(el?.className?.baseVal ?? el?.className ?? '').slice(0, 30), sel: s.selection.slice(0, 2), modal: s.modal }; }, x, y)));
  await clearLog();
  const before = await view();
  let expect = 'none'; // 'none' = view must not change; 'any'; 'zoomAt'; 'pan'
  let detail = {};
  try {
    switch (action) {
      case 'zoom': {
        const dy = (rnd() < 0.5 ? -1 : 1) * (20 + Math.round(rnd() * 160));
        await page.mouse.move(x, y);
        await page.keyboard.down('Control');
        await page.mouse.wheel({ deltaY: dy });
        await page.keyboard.up('Control');
        expect = 'zoomAt';
        detail = { x, y, dy };
        break;
      }
      case 'pan': {
        const dx = Math.round((rnd() - 0.5) * 300), dy = Math.round((rnd() - 0.5) * 300);
        await page.mouse.move(x, y);
        await page.mouse.wheel({ deltaX: dx, deltaY: dy });
        expect = 'pan';
        detail = { dx: -dx, dy: -dy };
        break;
      }
      case 'drag': {
        const dx = Math.round((rnd() - 0.5) * 400), dy = Math.round((rnd() - 0.5) * 400);
        await page.keyboard.down('Space');
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + dx, y + dy, { steps: 6 });
        await page.mouse.up();
        await page.keyboard.up('Space');
        // A drag that starts on a panel/toolbar must not pan.
        const onUi = await page.evaluate((x, y) => !!document.elementFromPoint(x, y)?.closest('.island, .menu, .popover'), x, y);
        expect = onUi ? 'none' : 'pan';
        detail = { dx, dy, onUi };
        break;
      }
      case 'click':
        await page.mouse.click(x, y);
        expect = 'none';
        break;
      case 'dblclick':
        await page.mouse.click(x, y, { clickCount: 2 });
        await page.keyboard.press('Escape');
        expect = 'none';
        break;
      case 'agentInsert': {
        const id = 'stress' + ++inserted;
        const r = await agent('applyOps', { operations: [{ op: 'insert', parent: null, node: { type: 'frame', id, name: 'Stress ' + inserted, x: Math.round((-before.x + 300 + rnd() * 900) / before.zoom), y: Math.round((-before.y + 100 + rnd() * 600) / before.zoom), width: 300, height: 200, layout: 'vertical', padding: 16, fill: '#223', children: [{ type: 'text', content: 'stress ' + inserted, fill: '#fff' }, { type: 'ellipse', width: 40, height: 40, fill: '#f0f' }] } }] });
        if (r.err) report(step, 'agent-error', r.err);
        expect = 'none';
        break;
      }
      case 'agentDelete': {
        const ids = (await roots()).filter(i => i.startsWith('stress'));
        if (ids.length) {
          const r = await agent('applyOps', { operations: [{ op: 'delete', id: pick(ids) }] });
          if (r.err) report(step, 'agent-error', r.err);
        }
        expect = 'none';
        break;
      }
      case 'agentMove': {
        const ids = await roots();
        const r = await agent('applyOps', { operations: [{ op: 'update', id: pick(ids), props: { x: Math.round(rnd() * 3000 - 500), y: Math.round(rnd() * 2000) } }] });
        if (r.err) report(step, 'agent-error', r.err);
        expect = 'none';
        break;
      }
      case 'agentDup': {
        const ids = await roots();
        const r = await agent('applyOps', { operations: [{ op: 'duplicate', id: pick(ids), props: { x: Math.round(rnd() * 4000), y: Math.round(rnd() * 3000) } }] });
        if (r.ok?.[0]?.id) {
          // Rename so later deletes can clean it up.
          await agent('applyOps', { operations: [{ op: 'update', id: r.ok[0].id, props: { name: 'stress dup' } }] });
        }
        expect = 'none';
        break;
      }
      case 'agentSelect': {
        const ids = await roots();
        await agent('setSelection', { ids: [pick(ids)], zoom: false });
        expect = 'none';
        break;
      }
      case 'toggleLeft':
        await page.evaluate(() => window.__penStore.setState(s => ({ leftOpen: !s.leftOpen })));
        expect = 'none';
        break;
      case 'idle':
        await new Promise(r => setTimeout(r, 1300));
        expect = 'none';
        break;
      case 'fitKey':
        await page.keyboard.down('Shift');
        await page.keyboard.press('Digit1');
        await page.keyboard.up('Shift');
        expect = 'any';
        break;
      case 'escape':
        await page.keyboard.press('Escape');
        expect = 'none';
        break;
    }
  } catch (e) {
    report(step, 'harness', String(e).slice(0, 200));
  }
  await new Promise(r => setTimeout(r, 40 + Math.round(rnd() * 160)));
  const after = await view();
  const u = await ui();
  if (!u.toolbar || !u.canvas || u.crashed) report(step, 'ui-lost', { action, ...u });
  if (u.scrolled) report(step, 'container-scrolled', { action });
  if (![after.x, after.y, after.zoom].every(Number.isFinite)) report(step, 'nan-view', after);
  const moved = Math.abs(after.x - before.x) > 0.5 || Math.abs(after.y - before.y) > 0.5 || Math.abs(after.zoom - before.zoom) > 1e-9;
  if (expect === 'none' && moved) report(step, 'unexpected-move', { action, before, after, log: (await vlog()).slice(0, 3) });
  if (expect === 'zoomAt') {
    // The world point under the cursor must stay under the cursor.
    const c = await page.evaluate(() => document.getElementById('pen-canvas').getBoundingClientRect().toJSON());
    const wx0 = (detail.x - c.left - before.x) / before.zoom, wy0 = (detail.y - c.top - before.y) / before.zoom;
    const sx1 = c.left + after.x + wx0 * after.zoom, sy1 = c.top + after.y + wy0 * after.zoom;
    if (Math.abs(sx1 - detail.x) > 1.5 || Math.abs(sy1 - detail.y) > 1.5) report(step, 'zoom-jump', { detail, before, after, drift: [Math.round(sx1 - detail.x), Math.round(sy1 - detail.y)], log: (await vlog()).slice(0, 4) });
  }
  if (expect === 'pan') {
    const ddx = after.x - before.x, ddy = after.y - before.y;
    if (Math.abs(ddx - detail.dx) > 1.5 || Math.abs(ddy - detail.dy) > 1.5 || Math.abs(after.zoom - before.zoom) > 1e-9) report(step, 'pan-mismatch', { action, want: detail, got: [Math.round(ddx), Math.round(ddy)], log: (await vlog()).slice(0, 4) });
  }
}
console.log('actions:', JSON.stringify(counts));
const dlog = await page.evaluate(() => window.__penAgent('diagnose', {}).then(d => d.log.filter(l => /unexpected place/.test(l))));
console.log('unexpected-warnings:', dlog.length, dlog.slice(0, 2).map(l => l.slice(0, 250)));
console.log('page errors:', errors.length);
for (const e of [...new Set(errors)].slice(0, 10)) console.log('  -', e);
const byKind = {};
for (const i of issues) (byKind[i.kind] ||= []).push(i);
console.log('issues:', Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, v.length])));
for (const [k, v] of Object.entries(byKind)) for (const i of v.slice(0, 4)) console.log(`  [${k}] step ${i.step}:`, JSON.stringify(i.detail).slice(0, 900));
await browser.close();




