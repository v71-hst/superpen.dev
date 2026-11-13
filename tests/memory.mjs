// Real memory use of the editor on a big file, with NO debugger attached. (A debugger keeps copies of everything a
// page loads, e.g. every snapshot's markup, which inflates memory by hundreds of MB; puppeteer always attaches one.)
// Edge is started plain, the page runs the scenario itself (loaded through ?penHarness=, available in dev and
// PEN_PROD=1 builds only) and after each step this script reads the processes' memory from Windows.
// Usage: PEN_PROD=1 node start.mjs <folder>, then: node memory.mjs <url> [perf=0|1] [label] [showAll=1]
import http from 'node:http';
import { BROWSER } from './browser.mjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const [, , url, perf = '0', label = perf === '1' ? 'performance mode' : 'normal', showAll = '1'] = process.argv;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pen-mem-'));
const tag = path.basename(profile);

// ---- runs inside the page ----
const scenario = `
const cfg = __CFG__;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const st = window.__penStore;
async function report(step, extra = {}) {
  if (window.gc) { gc(); await sleep(300); gc(); }
  await sleep(2500);
  const w = document.getElementById('pen-world');
  const kids = [...(w?.children ?? [])].filter(e => e.dataset.k);
  const d = {
    step, zoom: +st.getState().view.zoom.toFixed(3),
    live: kids.filter(e => !('bitmap' in e.dataset) && !('placeholder' in e.dataset)).length,
    bitmap: kids.filter(e => 'bitmap' in e.dataset).length,
    placeholder: kids.filter(e => 'placeholder' in e.dataset).length,
    dom: document.getElementsByTagName('*').length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    ...extra,
  };
  await fetch(cfg.report + '?d=' + encodeURIComponent(JSON.stringify(d)));
}
async function settle(maxMs = 180000) {
  const t0 = performance.now();
  let quiet = 0;
  while (performance.now() - t0 < maxMs && quiet < 4) {
    await sleep(700);
    const r = await window.__penAgent('diagnose', {});
    quiet = r.lod.queued + r.lod.levelQueue + (r.lod.working ? 1 : 0) ? 0 : quiet + 1;
  }
  return Math.round(performance.now() - t0);
}
const setView = (zoom, cx, cy) => {
  const c = document.getElementById('pen-canvas').getBoundingClientRect();
  st.setState({ view: { zoom, x: c.width / 2 - cx * zoom, y: c.height / 2 - cy * zoom } });
};
const pan = (dx, dy, steps) => new Promise(res => {
  const times = [];
  let i = 0, last = performance.now();
  const tick = now => {
    times.push(now - last); last = now;
    if (i++ >= steps) return res({ avgMs: +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1), worstMs: +Math.max(...times).toFixed(1), over50: times.filter(t => t > 50).length });
    const v = st.getState().view;
    st.setState({ view: { ...v, x: v.x + dx, y: v.y + dy } });
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
(async () => {
  // Performance mode is read at startup: set it and reload once if it isn't what this run wants.
  if ((localStorage.getItem('pen.perfMode') ?? '') !== cfg.perf) { localStorage.setItem('pen.perfMode', cfg.perf); location.reload(); return; }
  while (!document.querySelector('#pen-world [data-k]')) await sleep(100);
  let hidden = 0;
  if (cfg.showAll) {
    hidden = (st.getState().doc.sections ?? []).filter(x => x.hidden).length;
    if (hidden) st.getState().edit(d => d.sections.forEach(x => delete x.hidden));
  }
  // Peak while the first snapshots are made, then the settled state.
  for (const t of [6, 14, 24]) {
    await sleep(t === 6 ? 6000 : t === 14 ? 8000 : 10000);
    await fetch(cfg.report + '?peek=' + encodeURIComponent('while drawing snapshots, ' + t + 's in'));
  }
  const settled = await settle();
  await report('opened, fit to screen', { roots: st.getState().doc.children.length, hiddenSectionsShown: hidden, settleMs: settled + 24000, perfMode: st.getState().perfMode ?? null });
  const k = st.getState().doc.children.filter(n => typeof n.x === 'number' && typeof n.width === 'number');
  const mid = k[Math.floor(k.length / 2)];
  const cx = mid.x + mid.width / 2, cy = mid.y + mid.height / 2;
  setView(1, cx, cy); await settle(30000);
  await report('zoomed to 100%');
  const p1 = await pan(-40, -25, 120); await settle(20000);
  await report('after panning at 100%', { pan: p1 });
  setView(0.5, cx, cy); await settle(30000);
  const p2 = await pan(30, 20, 120);
  await report('zoomed to 50%, panned', { pan: p2 });
  setView(0.12, cx, cy); await settle(60000);
  await report('zoomed out to 12%');
  await sleep(45000);
  await report('same, 45s idle');
  await fetch(cfg.report + '?end=1');
})();
`;

function mem() {
  // Private bytes of this Edge instance's processes, by type.
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }; "$t $((Get-Process -Id $_.ProcessId).PrivateMemorySize64)" }`]).toString();
  const by = {};
  for (const l of out.trim().split(/\r?\n/)) {
    const [t, b] = l.trim().split(' ');
    by[t] = (by[t] ?? 0) + +b;
  }
  const mb = v => Math.round((v ?? 0) / 1048576);
  return { rendererMB: mb(by.renderer), gpuMB: mb(by['gpu-process']), totalMB: mb(Object.values(by).reduce((a, b) => a + b, 0)) };
}

let finish;
const ended = new Promise(r => (finish = r));
const server = http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/scenario.js') {
    res.setHeader('content-type', 'text/javascript');
    return res.end(scenario.replace('__CFG__', JSON.stringify({ report: `http://127.0.0.1:${server.address().port}/report`, perf, showAll: showAll === '1' })));
  }
  if (u.searchParams.has('end')) finish();
  else if (u.searchParams.has('peek')) console.log(JSON.stringify({ step: u.searchParams.get('peek'), ...mem() }));
  else if (u.searchParams.has('d')) console.log(JSON.stringify({ ...JSON.parse(u.searchParams.get('d')), ...mem() }));
  res.end('ok');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const target = new URL(url);
target.searchParams.set('penHarness', `http://127.0.0.1:${server.address().port}/scenario.js`);
console.log(`== ${label} (no debugger attached)`);
const edge = spawn(BROWSER, ['--headless=new', '--no-first-run', '--disable-extensions', '--window-size=1920,1080', `--user-data-dir=${profile}`, '--js-flags=--expose-gc', '--enable-precise-memory-info', target.href], { stdio: 'ignore' });
await Promise.race([ended, new Promise(r => setTimeout(r, 15 * 60000))]);
edge.kill();
server.close();
try {
  execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);
} catch {}
await new Promise(r => setTimeout(r, 800));
fs.rmSync(profile, { recursive: true, force: true });
