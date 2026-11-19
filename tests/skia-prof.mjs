// Where the Skia renderer spends its time on a big file: runs the editor's own benchmark cold (nothing recorded yet,
// what the first zoom-out after opening feels like) and warm, and prints the Skia counters from diagnose after each
// (pictures recorded and how long that took, far-zoom copies rasterised, whole pictures replayed while zoomed out).
// Frame times only mean something on a machine with a GPU; the counters are comparable anywhere.
// Usage: PEN_PROD=1 node start.mjs <folder>, then: node skia-prof.mjs <url> [renderer=full] [perf=0|1] [runs=2]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, renderer = 'full', perf = '0', runs = '2'] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000, args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.evaluateOnNewDocument(p => localStorage.setItem('pen.perfMode', p), perf);
await page.goto(`${url}${url.includes('?') ? '&' : '?'}renderer=${renderer}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await page.waitForFunction(() => window.__penStore && window.__penAgent, { timeout: 60000 });

const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
console.log(`graphics: ${gpu}`);

// Every section on the canvas (in memory only), so the whole file is drawn.
const shown = await page.evaluate(() => {
  const st = window.__penStore.getState();
  const hidden = (st.doc.sections ?? []).filter(x => x.hidden).length;
  if (hidden) st.edit(d => d.sections.forEach(x => delete x.hidden));
  return hidden;
});
await sleep(4000);

const skia = async () => {
  const d = await page.evaluate(() => window.__penAgent('diagnose', {}));
  const s = d.renderer?.skia ?? {};
  return {
    active: d.renderer?.active,
    failure: d.renderer?.failure ?? undefined,
    pictures: s.pictures && { eligible: s.pictures.eligible, recorded: s.pictures.recorded, recordings: s.pictures.recordings, pictureMB: s.pictures.pictureMB, recordMs: s.pictures.recordMs, slowestRecordMs: s.pictures.slowestRecordMs, reasons: s.pictures.reasons },
    copies: s.pictureImages,
    scene: s.overview && { farReplays: s.overview.farReplays, placeholders: s.overview.placeholders, slowestDrawMs: s.overview.slowestDrawMs },
    decodedMB: s.images?.decodedMB,
    gpu: s.gpu,
    live: s.liveObjects?.total,
    lod: { bitmaps: d.lod?.bitmaps, queued: d.lod?.queued },
  };
};

console.log(`renderer ${renderer}, performance mode ${perf === '1' ? 'on' : 'off'}, ${shown} hidden sections shown`);
console.log('after opening:', JSON.stringify(await skia()));
for (let i = 0; i < +runs; i++) {
  const b = await page.evaluate(() => window.__penAgent('benchmark', {}));
  console.log(`-- run ${i + 1} (${i ? 'warm' : 'cold'}): ${b.design.topLevelFrames} frames, ${b.totalSeconds}s, js heap ${b.jsHeapMB} MB`);
  for (const p of b.phases) console.log(`   ${p.phase.padEnd(15)} median ${String(p.medianMs).padStart(5)}  p95 ${String(p.p95Ms).padStart(6)}  worst ${String(p.worstMs).padStart(7)}  >33ms ${String(p.over33ms).padStart(3)}  elements ${p.domElements}`);
  console.log('   skia:', JSON.stringify(await skia()));
  await sleep(1500);
}
await browser.close();
