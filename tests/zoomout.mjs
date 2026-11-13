// Graphics memory while zooming OUT from a high zoom: the canvas layer keeps the detail level it was drawn at until
// zooming pauses, so a long zoom-out briefly asks for a huge drawn area. Reports GPU process memory at the start,
// its peak during the gesture, and after it settles. Usage: node zoomout.mjs <url> [fromZoom=8] [toZoom=0.06] [steps=40]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, from = '8', to = '0.06', steps = '40'] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000 }));
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
const bcdp = await browser.target().createCDPSession();
const sleep = ms => new Promise(r => setTimeout(r, ms));
import { execFile } from 'node:child_process';
function gpuMB() {
  // Asynchronous: a blocking call here would stall this script and show up as fake slow frames.
  return bcdp.send('SystemInfo.getProcessInfo').then(
    ({ processInfo }) =>
      new Promise(res => {
        const ids = processInfo.filter(p => p.type === 'GPU').map(p => p.id).join(',');
        execFile('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${ids} -ErrorAction SilentlyContinue | Measure-Object PrivateMemorySize64 -Sum).Sum; exit 0`], (e, out) => res(Math.round(+String(out) / 1048576)));
      }),
  );
}
for (const f of (process.env.FLAGS ?? '').split(',').filter(Boolean)) await page.evaluateOnNewDocument(f => localStorage.setItem(f, '1'), f);
async function gpuDump() {
  const events = [];
  const onData = e => events.push(...e.value);
  bcdp.on('Tracing.dataCollected', onData);
  await bcdp.send('Tracing.start', { traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], memoryDumpConfig: { triggers: [] } }, transferMode: 'ReportEvents' });
  await bcdp.send('Tracing.requestMemoryDump', { levelOfDetail: 'detailed' });
  const done = new Promise(r => bcdp.once('Tracing.tracingComplete', r));
  await bcdp.send('Tracing.end');
  await done;
  bcdp.off('Tracing.dataCollected', onData);
  const want = ['gpu/transfer_cache', 'gpu/shared_images', 'skia/gpu_resources', 'cc/image_memory', 'cc/tile_memory', 'gpu/gr_shader_cache', 'gpu/discardable_cache'];
  const tot = {};
  for (const e of events) {
    if (e.ph !== 'v' || !e.args?.dumps?.allocators) continue;
    for (const [name, a] of Object.entries(e.args.dumps.allocators)) {
      const size = a.attrs?.size;
      if (size && want.includes(name)) tot[name] = (tot[name] ?? 0) + parseInt(size.value, 16);
    }
  }
  return Object.entries(tot).map(([k, v]) => `${k.split('/')[1]} ${Math.round(v / 1048576)}`).join(', ');
}
await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await sleep(5000);
// Zoom about the centre of the design, like wheel-zooming with the pointer in the middle.
const zoomTo = z =>
  page.evaluate(z => {
    const st = window.__penStore;
    const c = document.getElementById('pen-canvas').getBoundingClientRect();
    const v = st.getState().view;
    const wx = (c.width / 2 - v.x) / v.zoom, wy = (c.height / 2 - v.y) / v.zoom;
    st.setState({ view: { zoom: z, x: c.width / 2 - wx * z, y: c.height / 2 - wy * z } });
  }, z);
await zoomTo(+from);
await sleep(4000);
const start = await gpuMB();
let peak = start;
let stop = false;
const watcher = (async () => { while (!stop) { peak = Math.max(peak, await gpuMB()); await sleep(120); } })();
// The gesture runs inside the page, one zoom step per animation frame, timing each frame there.
const r = await page.evaluate(
  (from, to, steps) =>
    new Promise(res => {
      const st = window.__penStore;
      const c = document.getElementById('pen-canvas').getBoundingClientRect();
      const v0 = st.getState().view;
      const wx = (c.width / 2 - v0.x) / v0.zoom, wy = (c.height / 2 - v0.y) / v0.zoom;
      const times = [];
      let i = 0, last = performance.now();
      const t0 = last;
      const tick = now => {
        times.push(now - last);
        last = now;
        if (i++ >= steps) {
          // Two more frames so the last step's drawing is counted.
          return requestAnimationFrame(n2 => requestAnimationFrame(n3 => { times.push(n3 - now); res({ times, total: n3 - t0 }); }));
        }
        const z = from * Math.pow(to / from, i / steps);
        st.setState({ view: { zoom: z, x: c.width / 2 - wx * z, y: c.height / 2 - wy * z } });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }),
  +from,
  +to,
  +steps,
);
const frameTimes = r.times.slice(1).map(t => Math.round(t));
const gesture = Math.round(r.total);
await sleep(1500);
const after1 = await gpuMB();
if (process.env.DUMP) console.log(`   in use right after [${process.env.FLAGS ?? 'new build'}]: ${await gpuDump()}`);
await sleep(6000);
stop = true;
await watcher;
const after8 = await gpuMB();
frameTimes.sort((a, b) => a - b);
console.log(`zoom ${from} -> ${to} in ${steps} steps: GPU ${start}MB at start, peak ${peak}MB, ${after1}MB 1.5s after, ${after8}MB 7.5s after; gesture took ${gesture}ms; frames: median ${frameTimes[frameTimes.length >> 1]}ms, slowest ${frameTimes[frameTimes.length - 1]}ms, over 50ms: ${frameTimes.filter(t => t > 50).length}`);
await browser.close();
