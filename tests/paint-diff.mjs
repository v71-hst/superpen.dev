// Stage 3 of the Skia rework (docs/SKIA_REWORK.md): renders every top-level frame of a design both ways, the DOM
// renderer (the reference, via the screenshot tool) and the Skia painter, and scores them with compare() from
// src/editor/imageTools.ts (it ignores one pixel of anti-aliasing). Boxes for Skia come from the rendered DOM by
// default (`layout=dom`: checks painting alone) or from the layout engine (`layout=engine`). Writes a side-by-side
// image per frame for a person to look at.
// Usage: node paint-diff.mjs <url of a .pen> <out dir> [threshold %=95] [layout=dom|engine] [max frames=40]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { launchOptions } from './browser.mjs';
const [, , url, outDir = 'paint-diff', thresholdArg = '95', layoutArg = 'layout=dom', maxArg = '40'] = process.argv;
const threshold = Number(thresholdArg);
const engine = layoutArg === 'layout=engine';
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000, args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] }));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
// Not networkidle: pages with shaders or many fonts may never go quiet. Then give the DOM renderer time to load its
// picture fills, or the first reference screenshots miss them.
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await page.waitForFunction(() => window.__penSkia && window.__penAgent, { timeout: 60000 });
await new Promise(r => setTimeout(r, 8000));
const keys = await page.evaluate(n => window.__penStore.getState().doc.children.filter(c => c.enabled !== false && c.type !== 'note' && c.type !== 'prompt' && c.type !== 'context').slice(0, n).map(c => c.id), Number(maxArg));
const rows = [];
for (const key of keys) {
  const r = await page.evaluate(
    async (key, engine) => {
      const s = window.__penStore.getState();
      const f = s.doc.children.find(c => c.id === key);
      s.setView({ x: 40 - (f.x ?? 0), y: 40 - (f.y ?? 0), zoom: 1 });
      await new Promise(r => setTimeout(r, 1500));
      const ref = await window.__penAgent('screenshot', { id: key, scale: 1, max_size: 4000 });
      let skia;
      try {
        const layout = engine ? root => window.__penSkia.engineLayout(root) : undefined;
        skia = await window.__penSkia.renderFrameForTest(key, { scale: ref.width / Math.max(1, document.querySelector(`#pen-world [data-k="${CSS.escape(key)}"]`).offsetWidth), layout });
      } catch (e) {
        return { key, error: String(e) };
      }
      const tools = await import('/src/editor/imageTools.ts');
      const [a, b] = await Promise.all([tools.loadImageData(ref.dataUrl), tools.loadImageData(skia.dataUrl)]);
      const cmp = tools.compare(a, b);
      const match = Number(cmp.text.match(/match ([\d.]+)%/)?.[1] ?? 0);
      return { key, name: f.name ?? key, match, reason: skia.reason, size: [ref.width, ref.height], skiaSize: [skia.width, skia.height], image: cmp.dataUrl, worst: cmp.text.split('\n').slice(1, 4).join(' | ') };
    },
    key,
    engine,
  );
  if (r.error) {
    rows.push(r);
    console.log(`ERROR ${key}: ${r.error}`);
    continue;
  }
  fs.writeFileSync(path.join(outDir, `${key}.png`), Buffer.from(r.image.split(',')[1], 'base64'));
  rows.push(r);
  const ok = r.match >= threshold;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${r.key} "${r.name}" — ${r.match}% match${r.reason ? `; would stay DOM: ${r.reason}` : ''}${ok ? '' : ` | ${r.worst}`}`);
}
const scored = rows.filter(r => !r.error);
const avg = scored.reduce((s, r) => s + r.match, 0) / Math.max(1, scored.length);
console.log(`\n${scored.length} frames, average ${avg.toFixed(2)}% match, ${scored.filter(r => r.match >= threshold).length} at or above ${threshold}%, ${rows.length - scored.length} errors; side-by-side images in ${outDir}`);
await browser.close();
