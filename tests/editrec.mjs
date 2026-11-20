// Edit cost on a big board: changes one layer deep inside the largest top-level frame again and again (its colour),
// with that frame on screen, and reports how long re-recording the frame's picture takes per edit (frameStats
// recordMs) and the frame times. Usage: node editrec.mjs <url> [edits=40]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, editsArg] = process.argv;
const PROFILE = !!process.env.PROFILE;
const edits = Number(editsArg ?? 40);
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000 }));
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__penStore?.getState().doc && window.__penSkia, { timeout: 120000 });
const pick = await page.evaluate(() => {
  const st = window.__penStore.getState();
  const count = n => 1 + (n.children ?? []).reduce((s, c) => s + count(c), 0);
  const top = [...st.doc.children].filter(n => n.type === 'frame').sort((a, b) => count(b) - count(a))[0];
  // A leaf in the middle of the frame, a few levels down.
  let n = top, path = [];
  while ((n.children ?? []).length) { const i = Math.floor(n.children.length / 2); path.push(i); n = n.children[i]; }
  return { top: top.id, nodes: count(top), x: top.x ?? 0, y: top.y ?? 0, w: top.width, h: top.height, path, leaf: n.id, type: n.type, depth: path.length, children: top.children.length };
});
console.log('frame', JSON.stringify(pick));
await page.evaluate(p => {
  const w = typeof p.w === 'number' ? p.w : 1000, h = typeof p.h === 'number' ? p.h : 1000;
  const zoom = Math.min(1300 / w, 900 / h, 1);
  window.__penStore.getState().setView({ zoom, x: 50 - p.x * zoom, y: 50 - p.y * zoom });
}, pick);
const idle = async () => page.evaluate(() => new Promise(res => { let last = -1, same = 0; const t = () => { const r = window.__penSkia.frameStats().recordings; same = r === last ? same + 1 : 0; last = r; same > 30 ? res() : setTimeout(t, 50); }; t(); }));
await new Promise(r => setTimeout(r, 8000));
await idle();
const before = await page.evaluate(() => window.__penSkia.frameStats());
const cdp = PROFILE ? await page.createCDPSession() : null;
if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
const times = await page.evaluate(async (p, edits) => {
  const st = window.__penStore;
  const find = (n, id) => n.id === id ? n : (n.children ?? []).reduce((f, c) => f ?? find(c, id), null);
  const out = [];
  for (let i = 0; i < edits; i++) {
    const r0 = window.__penSkia.frameStats();
    const t0 = performance.now();
    st.getState().edit(d => { const n = d.children.map(c => find(c, p.leaf)).find(Boolean); n.fill = i % 2 ? '#ff3366' : '#33aaff'; });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r1 = window.__penSkia.frameStats();
    out.push({ frameMs: performance.now() - t0, recMs: r1.recordMs - r0.recordMs, recs: r1.recordings - r0.recordings });
  }
  return out;
}, pick, edits);
if (cdp) {
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map(), byId = new Map(profile.nodes.map(n => [n.id, n]));
  const dt = profile.timeDeltas; const counts = new Map();
  profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) ?? 0) + (dt[i] ?? 0)));
  for (const [id, us] of counts) { const n = byId.get(id); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`; self.set(k, (self.get(k) ?? 0) + us); }
  const tot = [...self.values()].reduce((a, b) => a + b, 0);
  console.log('top self time (ms, per edit):');
  for (const [k, us] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(us / 1000 / edits).toFixed(2).padStart(7)}  ${k}`);
  console.log(`  total ${(tot / 1000 / edits).toFixed(1)} ms per edit`);
}
// The picture made from reused layer pictures must look exactly like the frame recorded afresh: after the edits, after
// moving the frame, and after an edit in another layer.
let fails = 0;
const check = async label => {
  await new Promise(r => setTimeout(r, 1500));
  const r = await page.evaluate(k => window.__penSkia.compareRecordedForTest(k), pick.top);
  const ok = !r.error && r.differ === 0;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: on screen = recorded afresh — ${JSON.stringify(r)}`);
};
await check('after the edits');
await page.evaluate(p => window.__penStore.getState().edit(d => { const n = d.children.find(c => c.id === p.top); n.x = (n.x ?? 0) + 37; n.y = (n.y ?? 0) + 11; }), pick);
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
await check('after moving the frame');
await page.evaluate(p => window.__penStore.getState().edit(d => {
  const top = d.children.find(c => c.id === p.top);
  const other = top.children[(p.path[0] + 1) % top.children.length];
  let n = other; while ((n.children ?? []).length) n = n.children[0];
  n.opacity = 0.5;
}), pick);
await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
await check('after an edit in another layer');
const st = await page.evaluate(() => window.__penSkia.frameStats());
console.log(`layers kept ${st.layers}, reused ${st.layerHits}, recorded ${st.layerRecords}`);
const med = a => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const rec = times.filter(t => t.recs > 0);
console.log(`edits ${edits}: re-recorded after ${rec.length}; record time per edit median ${med(rec.map(t => t.recMs))} ms (recordMs is whole ms, summed), edit to second frame median ${med(times.map(t => t.frameMs)).toFixed(1)} ms`);
const after = await page.evaluate(() => window.__penSkia.frameStats());
console.log(`recordings ${after.recordings - before.recordings}, recordMs ${after.recordMs - before.recordMs} total → ${((after.recordMs - before.recordMs) / Math.max(1, after.recordings - before.recordings)).toFixed(2)} ms per recording`);
await browser.close();
process.exit(fails ? 1 : 0);
