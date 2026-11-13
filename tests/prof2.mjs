// CPU-profiles panning and hovering, printing the top self-time functions.
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await new Promise(r => setTimeout(r, +(process.argv[4] || 2500)));
const cdp = await page.createCDPSession();
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
for (const phase of (process.argv[3] || 'pan,hover').split(',')) {
  await cdp.send('Profiler.start');
  await page.mouse.move(900, 500);
  for (let i = 0; i < 30; i++) {
    if (phase === 'pan') await page.mouse.wheel({ deltaY: 60, deltaX: 40 });
    else if (phase === 'idle') {}
    else if (phase === 'zoomout' || phase === 'zoomin') { await page.keyboard.down('Control'); await page.mouse.wheel({ deltaY: phase === 'zoomout' ? 60 : -60 }); await page.keyboard.up('Control'); }
    else await page.mouse.move(500 + i * 12, 300 + (i % 7) * 40);
    await new Promise(r => setTimeout(r, 16));
  }
  await new Promise(r => setTimeout(r, 300));
  const { profile } = await cdp.send('Profiler.stop');
  const self = new Map();
  const dt = profile.timeDeltas;
  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const counts = new Map();
  profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) || 0) + (dt[i] || 0)));
  for (const [id, us] of counts) {
    const n = byId.get(id);
    const cf = n.callFrame;
    const key = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber}`;
    self.set(key, (self.get(key) || 0) + us);
  }
  const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 18);
  console.log(`--- ${phase}`);
  for (const [k, us] of top) console.log((us / 1000).toFixed(0).padStart(6) + 'ms ', k);
}
await browser.close();

