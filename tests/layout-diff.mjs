// Stage 2 of the Skia rework (docs/SKIA_REWORK.md): src/layout/layout.ts against the DOM renderer. Every top-level
// frame is rendered live at zoom 1 and every node's box (world-space, axis-aligned, rotation included) is compared
// with the computed layout. Text sizes come from the browser itself (a probe copy of the text element measured at the
// width the layout asks for), so this checks layout logic alone; a second table reports how close the canvas-based
// src/layout/measureText.ts gets to those browser sizes. Tolerance 0.5 design px.
// Usage: node layout-diff.mjs <url> [more urls]   (dev server: the test imports /src modules)
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const urls = process.argv.slice(2);
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 600000 }));
let failed = false;

for (const url of urls) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 }).catch(() => {});
  await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
  await new Promise(r => setTimeout(r, 2000));
  const r = await page.evaluate(async () => {
    const L = await import('/src/layout/layout.ts');
    const M = await import('/src/layout/measureText.ts');
    const { currentTree } = await import('/src/editor/tree.ts');
    const { ensureRendered } = await import('/src/editor/culling.ts');
    const st = window.__penStore;
    const doc = st.getState().doc;
    const tree = currentTree();
    const frames = n => new Promise(res => { let k = n; const f = () => (--k <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f); });
    await document.fonts.ready;

    // Probe: a copy of the text element, absolutely positioned in a box maxWidth wide, outside the world so no
    // transform applies.
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:0;visibility:hidden;pointer-events:none;contain:layout';
    document.body.appendChild(host);
    const probeCache = new Map();
    let missingText = 0;
    const domMeasure = (n, maxWidth) => {
      const ck = n.key + '|' + maxWidth;
      if (probeCache.has(ck)) return probeCache.get(ck);
      const el = document.querySelector(`#pen-world [data-k="${CSS.escape(n.key)}"]`);
      let out = { w: 0, h: 0 };
      if (el) {
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:0;top:0;width:${maxWidth === null ? 100000 : maxWidth}px;height:0`;
        const probe = el.cloneNode(true);
        probe.style.position = 'absolute';
        probe.style.left = '0px';
        probe.style.top = '0px';
        probe.style.transform = 'none';
        probe.style.width = '';
        probe.style.height = '';
        probe.style.minWidth = '';
        probe.style.minHeight = '';
        probe.style.flex = '';
        probe.style.alignSelf = '';
        box.appendChild(probe);
        host.appendChild(box);
        // Width: shrink-to-fit (the longest line). Height: laid out at exactly maxWidth, where overflow-wrap may
        // break a word longer than the line (shrink-to-fit would widen to the word instead).
        const w = probe.getBoundingClientRect().width;
        if (maxWidth !== null) probe.style.width = `${maxWidth}px`;
        out = { w, h: probe.getBoundingClientRect().height };
        box.remove();
      } else missingText++;
      probeCache.set(ck, out);
      return out;
    };
    const canvasMeasure = M.canvasMeasureText(doc);

    const roots = tree.roots.filter(n => n.props.enabled !== false);
    const offenders = [];
    let checked = 0;
    let noDom = 0;
    const textStats = [];
    for (const root of roots) {
      ensureRendered([root.key], 20000);
      st.getState().setView({ x: 200 - (root.props.x ?? 0), y: 100 - (root.props.y ?? 0), zoom: 1 });
      await frames(3);
      const world = document.getElementById('pen-world').getBoundingClientRect();
      const lay = L.layoutTree(root, domMeasure, { doc });
      const visit = ln => {
        const el = document.querySelector(`#pen-world [data-k="${CSS.escape(ln.key)}"]`);
        if (!el) noDom++;
        else {
          checked++;
          const d = el.getBoundingClientRect();
          const a = L.worldBounds(ln);
          const dom = { x: d.x - world.x, y: d.y - world.y, w: d.width, h: d.height };
          const diff = Math.max(Math.abs(a.x - dom.x), Math.abs(a.y - dom.y), Math.abs(a.w - dom.w), Math.abs(a.h - dom.h));
          if (diff > 0.5) {
            const p = ln.node.props;
            offenders.push({ key: ln.key, type: ln.node.type, name: p.name ?? (typeof p.content === 'string' ? p.content.slice(0, 20) : ''), diff: Math.round(diff * 100) / 100, layout: [a.x, a.y, a.w, a.h].map(v => Math.round(v * 10) / 10), dom: [dom.x, dom.y, dom.w, dom.h].map(v => Math.round(v * 10) / 10) });
          }
          if (ln.node.type === 'text' && ln.textWidth !== undefined) {
            const b = domMeasure(ln.node, ln.textWidth);
            const c = canvasMeasure(ln.node, ln.textWidth);
            textStats.push([Math.abs(b.w - c.w), Math.abs(b.h - c.h), ln.key, String(ln.node.props.content ?? '').slice(0, 30), ln.textWidth, [b.w, b.h, c.w, c.h].map(v => Math.round(v * 10) / 10)]);
          }
        }
        ln.children.forEach(visit);
      };
      visit(lay);
    }
    host.remove();
    // layoutAll timing with the canvas measurer (pure computation, no DOM).
    const t0 = performance.now();
    const all = L.layoutAll(tree.roots, canvasMeasure, { doc });
    const ms = performance.now() - t0;
    const t1 = performance.now();
    L.layoutAll(tree.roots, canvasMeasure, { doc });
    const cachedMs = performance.now() - t1;
    offenders.sort((a, b) => b.diff - a.diff);
    const q = (arr, f) => { const s = arr.map(f).sort((a, b) => a - b); return s.length ? { mean: Math.round((s.reduce((x, y) => x + y, 0) / s.length) * 100) / 100, p90: Math.round(s[Math.floor(s.length * 0.9)] * 100) / 100, max: Math.round(s[s.length - 1] * 100) / 100, within1px: Math.round((s.filter(v => v <= 1).length / s.length) * 1000) / 10 + '%' } : null; };
    const byType = {};
    for (const o of offenders) byType[o.type] = (byType[o.type] ?? 0) + 1;
    return { roots: roots.length, nodes: all.size, checked, noDom, missingText, offenders: offenders.length, byType, worst: offenders.slice(0, 12), layoutAllMs: Math.round(ms), layoutAllCachedMs: Math.round(cachedMs * 10) / 10, canvasMeasure: { texts: textStats.length, width: q(textStats, t => t[0]), height: q(textStats, t => t[1]), worst: textStats.filter(t => Math.max(t[0], t[1]) > 1).sort((a, b) => Math.max(b[0], b[1]) - Math.max(a[0], a[1])).slice(0, 5).map(t => `${t[2]} "${t[3]}" at ${t[4] === null ? 'no wrap' : Math.round(t[4] * 10) / 10 + 'px'}: browser ${t[5][0]}×${t[5][1]}, canvas ${t[5][2]}×${t[5][3]}`) } };
  });
  const file = new URL(url).searchParams.get('file');
  console.log(`== ${file}: ${r.roots} top-level frames, ${r.nodes} laid out, ${r.checked} compared with the DOM (${r.noDom} without a DOM element)`);
  console.log(`${r.offenders === 0 ? 'PASS' : 'FAIL'} layout matches the DOM within 0.5px — ${r.offenders} offenders ${JSON.stringify(r.byType)}`);
  for (const o of r.worst) console.log(`   ${o.diff}px ${o.type} ${o.key} "${o.name}" layout ${JSON.stringify(o.layout)} dom ${JSON.stringify(o.dom)}`);
  console.log(`   layoutAll (canvas text measure): ${r.layoutAllMs} ms, again with the cache ${r.layoutAllCachedMs} ms`);
  console.log(`   canvas measureText vs browser, ${r.canvasMeasure.texts} texts: width ${JSON.stringify(r.canvasMeasure.width)} height ${JSON.stringify(r.canvasMeasure.height)}`);
  for (const t of r.canvasMeasure.worst) console.log(`     ${t}`);
  if (r.offenders) failed = true;
  await page.close();
}
await browser.close();
process.exitCode = failed ? 1 : 0;
