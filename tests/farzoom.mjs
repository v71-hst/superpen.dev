// What zooming and panning cost far zoomed out, where every top-level frame is on screen (the "10 fps at 2%" report,
// docs/SKIA_REWORK.md 2026-11-20): at each zoom (default 2% and 9%) it measures, while idle, while stepping the zoom
// with Ctrl+wheel and while panning, the page's frame times, how many times Skia drew, React-driven DOM changes under
// #pen-world, long tasks, and the Skia counters (pictures recorded, far-zoom copies made and evicted, placeholder
// draws, frames handed to the DOM renderer). PROFILE=idle,zoom,pan (or 1 = zoom) adds the top self-time functions of those phases.
// Frame times only mean something on a machine with a GPU; counts and profiles are comparable anywhere.
// Usage: PEN_PROD=1 node start.mjs <folder>, then: node farzoom.mjs <url> [renderer=full] [perf=0|1] [zooms=0.02,0.09]
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, renderer = 'full', perf = '0', zoomsArg = '0.02,0.09'] = process.argv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000 }));
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 1000 });
const cdp = await page.createCDPSession();
if (process.env.PEN_CPU_SLOW) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.PEN_CPU_SLOW) });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.evaluateOnNewDocument(p => localStorage.setItem('pen.perfMode', p), perf);
// HIDE_LABELS=1 (experiment): frame labels not displayed, to see what their layout and paint cost.
if (process.env.HIDE_LABELS) await page.evaluateOnNewDocument(() => document.addEventListener('DOMContentLoaded', () => { const s = document.createElement('style'); s.textContent = '.frame-label{display:none!important}'; document.head.appendChild(s); }));
await page.goto(`${url}${url.includes('?') ? '&' : '?'}renderer=${renderer}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction(() => window.__penStore && window.__penAgent && document.querySelector('#pen-world [data-k]'), { timeout: 180000 });

// Counters in the page: frames, DOM changes under the world, long tasks.
await page.evaluate(() => {
  const w = (window.__fz = { frames: [], mutations: 0, longMs: 0, longTasks: 0, on: false });
  const tick = t => {
    if (w.on) w.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  new MutationObserver(list => {
    if (w.on) w.mutations += list.length;
  }).observe(document.getElementById('pen-world'), { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    new PerformanceObserver(l => {
      if (!w.on) return;
      for (const e of l.getEntries()) {
        w.longTasks++;
        w.longMs += e.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch {}
});

const counters = () =>
  page.evaluate(async () => {
    const d = await window.__penAgent('diagnose', {});
    const s = d.renderer?.skia ?? {};
    return {
      draws: s.draws ?? 0,
      drawMs: s.drawMs ?? 0,
      sceneMs: s.sceneMs ?? 0,
      recordings: s.pictures?.recordings ?? 0,
      recordMs: s.pictures?.recordMs ?? 0,
      eligible: s.pictures?.eligible ?? 0,
      frames: s.pictures?.frames ?? 0,
      reasons: s.pictures?.reasons ?? {},
      rasterised: s.pictureImages?.rasterised ?? 0,
      rasterMs: s.pictureImages?.rasterMs ?? 0,
      pictureEvictions: s.pictureImages?.evictions ?? 0,
      copiesMB: s.pictureImages?.MB ?? 0,
      budgetMB: s.pictureImages?.budgetMB ?? 0,
      placeholders: s.overview?.placeholders ?? 0,
      programSteps: s.overview?.programSteps ?? 0,
      farReplays: s.overview?.farReplays ?? 0,
      framesDrawn: s.overview?.framesDrawn ?? 0,
      domFrames: document.querySelectorAll('#pen-world > [data-k]:not([data-skia])').length,
      labels: document.querySelectorAll('[data-label-k]').length,
    };
  });

// Waits until Skia stops drawing altogether: nothing left to record or rasterise, and the close-up warm-up (scene.ts
// takeProgramStep, one redraw per step) finished (or 180 s).
async function settle() {
  let last = '';
  for (let i = 0; i < 180; i++) {
    const c = await counters();
    const now = `${c.recordings}|${c.rasterised}|${c.placeholders}|${c.programSteps}|${c.draws}`;
    if (now === last) return c;
    last = now;
    await sleep(1000);
  }
  return counters();
}

function frameStats(ts) {
  const d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
  if (!d.length) return { frames: 0 };
  const at = q => Math.round(d[Math.min(d.length - 1, Math.floor(q * d.length))] * 10) / 10;
  const span = ts[ts.length - 1] - ts[0];
  return { frames: d.length, fps: Math.round((d.length / span) * 1000 * 10) / 10, medianMs: at(0.5), p95Ms: at(0.95), worstMs: Math.round(d[d.length - 1]) };
}

const profiled = (process.env.PROFILE === '1' ? 'zoom' : process.env.PROFILE ?? '').split(',');
async function printProfile() {
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const k = `${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`    top self time (of ${Math.round(total)} ms):`);
  for (const [k, ms] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`      ${String(Math.round(ms)).padStart(6)} ms  ${k}`);
  }

async function phase(name, act) {
  const before = await counters();
  if (profiled.includes(name)) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  }
  await page.evaluate(() => Object.assign(window.__fz, { frames: [], mutations: 0, longMs: 0, longTasks: 0, on: true }));
  const t0 = Date.now();
  await act();
  const wall = Date.now() - t0;
  const fz = await page.evaluate(() => {
  window.__fz.on = false;
  return { frames: window.__fz.frames, mutations: window.__fz.mutations, longTasks: window.__fz.longTasks, longMs: Math.round(window.__fz.longMs) };
  });
  const after = await counters();
  const delta = Object.fromEntries(['draws', 'drawMs', 'sceneMs', 'recordings', 'recordMs', 'rasterised', 'rasterMs', 'pictureEvictions', 'placeholders', 'farReplays'].map(k => [k, Math.round(after[k] - before[k])]));
  if (profiled.includes(name)) await printProfile();
  console.log(`  ${name.padEnd(6)} ${wall} ms | page ${JSON.stringify(frameStats(fz.frames))} | DOM changes ${fz.mutations}, long tasks ${fz.longTasks} (${fz.longMs} ms) | skia ${JSON.stringify(delta)}`);
  return after;
}

const settled = await settle();
console.log(`renderer ${renderer}, perf ${perf}${process.env.PEN_CPU_SLOW ? `, CPU ${process.env.PEN_CPU_SLOW}x slower` : ''}; ${settled.frames} frames, ${settled.eligible} Skia-eligible, reasons ${JSON.stringify(settled.reasons)}`);
const bounds = await page.evaluate(() => {
  const roots = window.__penStore.getState().doc.children.filter(n => n.enabled !== false);
  const xs = roots.map(n => n.x ?? 0), ys = roots.map(n => n.y ?? 0);
  const x1 = Math.max(...roots.map(n => (n.x ?? 0) + (typeof n.width === 'number' ? n.width : 0)));
  const y1 = Math.max(...roots.map(n => (n.y ?? 0) + (typeof n.height === 'number' ? n.height : 0)));
  return { cx: (Math.min(...xs) + x1) / 2, cy: (Math.min(...ys) + y1) / 2 };
});

for (const zoom of zoomsArg.split(',').map(Number)) {
  await page.evaluate(({ zoom, cx, cy }) => window.__penStore.getState().setView({ zoom, x: 700 - cx * zoom, y: 500 - cy * zoom }), { zoom, ...bounds });
  const c = await settle();
  console.log(`zoom ${zoom * 100}%: ${c.framesDrawn} frames drawn by Skia, ${c.domFrames} on the page-element renderer, ${c.labels} frame labels; copies ${c.copiesMB}/${c.budgetMB} MB`);
  await phase('idle', () => sleep(3000));
  await page.mouse.move(700, 500);
  await phase('zoom', async () => {
    await page.keyboard.down('Control');
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel({ deltaY: i % 10 < 5 ? -40 : 40 });
      await sleep(16);
    }
    await page.keyboard.up('Control');
    await sleep(500);
  });
  await phase('pan', async () => {
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel({ deltaX: i % 10 < 5 ? 60 : -60, deltaY: i % 10 < 5 ? 30 : -30 });
      await sleep(16);
    }
    await sleep(500);
  });
}
await browser.close();
