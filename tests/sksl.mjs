// Design shaders translated to SkSL (src/skia/sksl.ts) against the WebGL engine (src/render/shaders.ts) that ran them
// before: each shader of a folder is run both ways at the same size with the same inputs (a gradient as @content,
// @backdrop and pencil:object inputs, an ellipse as the @sdf outline), and the pixels compared. Animated shaders (they
// read the time) are only checked to compile. A shader that can't be translated says so: it keeps the WebGL engine.
// Usage: node sksl.mjs <url of the dev server with a design in the shaders' folder> <shader file names...>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url, ...names] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 300000 }));
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__penStore?.getState().file && window.__penSkia, { timeout: 120000 });
await page.waitForFunction(async () => !!(await import('/src/skia/scene.ts')).sceneGpu(), { timeout: 60000 });
let fails = 0;
for (const name of names) {
  const r = await page.evaluate(async name => {
    const sh = await import('/src/render/shaders.ts');
    const sk = await import('/src/skia/sksl.ts');
    const ck = await (await import('/src/skia/kit.ts')).loadKit();
    const gpu = (await import('/src/skia/scene.ts')).sceneGpu();
    const resolve = (await import('/src/editor/fileio.ts')).makeUrlResolver(window.__penStore.getState().file.path);
    const src = await (await fetch(resolve('./' + name))).text();
    const info = sh.parseShader(src);
    const W = 200, H = 150;
    const content = document.createElement('canvas');
    content.width = W;
    content.height = H;
    const g = content.getContext('2d');
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#2563EB');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.5)');
    grad.addColorStop(1, '#F97316');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, H);
    const values = Object.fromEntries(info.filter(u => u.type === 'sampler2D' && sh.isUserUniform(u)).map(u => [u.name, 'pencil:object']));
    const shape = { kind: 'ellipse' };
    const cfg = { passes: [{ url: './' + name, uniforms: values }], width: W, height: H, margin: 0, shape, content: async () => content, backdrop: async () => content, resolveUrl: resolve, scale: 1 };
    const canvas = document.createElement('canvas');
    const runner = new sh.ShaderRunner(canvas, true);
    await runner.update(cfg);
    const animated = info.some(u => u.time || u.mouse);
    const e = sk.effectFor(ck, src);
    if (!e) return { name, result: sk.translate(src) ? 'Skia rejected it (WebGL engine keeps it)' : 'not translated (WebGL engine keeps it)', webglError: runner.error };
    if (runner.error) return { name, result: 'webgl error', webglError: runner.error };
    if (animated) return { name, result: 'animated: compiles' };
    const mask = sh.shapeMask(shape, W, H, W, H);
    const sdf = sh.sdfFromAlpha(mask, W, H, 1);
    const sdfImg = sk.sdfImage(ck, sdf);
    const contentImg = ck.MakeImageFromCanvasImageSource(content);
    const img = sk.runSksl(ck, gpu, [{ effect: e.effect, t: e.t, values }], { w: W, h: H, margin: 0, scale: 1, time: 0 }, (i, u) => (u.sdf ? { image: sdfImg, filter: 'nearest', upt: 1 } : u.content || u.backdrop || sh.isObjectRef(values[u.name]) ? { image: contentImg } : null));
    const a = canvas.getContext('2d').getImageData(0, 0, W, H).data;
    const b = img.readPixels(0, 0, { width: W, height: H, colorType: ck.ColorType.RGBA_8888, alphaType: ck.AlphaType.Unpremul, colorSpace: ck.ColorSpace.SRGB });
    let same = 0, worst = 0;
    for (let i = 0; i < W * H; i++) {
      let d = 0;
      for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a[i * 4 + c] - b[i * 4 + c]));
      if (a[i * 4 + 3] === 0 && b[i * 4 + 3] === 0) d = 0;
      worst = Math.max(worst, d);
      if (d <= 6) same++;
    }
    img.delete();
    sdfImg?.delete();
    contentImg.delete();
    runner.dispose();
    return { name, result: 'compared', match: Math.round((same / (W * H)) * 10000) / 100, worst };
  }, name);
  const ok = r.result === 'animated: compiles' || (r.result === 'compared' && r.match >= 99) || /keeps it/.test(r.result);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.result}${r.match !== undefined ? ` — ${r.match}% of pixels within 6/255 (worst ${r.worst})` : ''}${r.webglError ? ` [WebGL: ${String(r.webglError).slice(0, 80)}]` : ''}`);
}
console.log(JSON.stringify(await page.evaluate(async () => (await import('/src/skia/sksl.ts')).skslStats())));
await browser.close();
process.exitCode = fails ? 1 : 0;
