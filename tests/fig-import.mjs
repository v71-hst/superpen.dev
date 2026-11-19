// Figma import check: converts .fig files (or saved Figma clipboard HTML) with src/import/figma and verifies the result.
//
//   node tests/fig-import.mjs [--out <folder>] [--page <name>] [--all-pages] [--sections frames] <file.fig | file.html> [more files]
//
// For each file it prints the pages, node counts by type, the number of images and the warnings, checks the
// invariants below, and writes <out>/<file name>/<file name>.spen (plus images/) to open in the editor.
// The default output folder is <temp>/superpen-fig-import. Exit code 1 when an invariant fails or a file cannot be read.
// No dev server or browser is needed; the module is bundled with esbuild the way the webview gets it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const files = [];
let outRoot = path.join(os.tmpdir(), 'superpen-fig-import');
let page;
let allPages = false;
let sections;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outRoot = path.resolve(args[++i]);
  else if (args[i] === '--page') page = args[++i];
  else if (args[i] === '--all-pages') allPages = true;
  else if (args[i] === '--sections') sections = args[++i];
  else files.push(args[i]);
}
if (!files.length) {
  console.error('usage: node tests/fig-import.mjs [--out <folder>] [--page <name>] [--all-pages] [--sections frames] <file.fig | clipboard.html> [more files]');
  process.exit(2);
}

// Bundle for the browser: this fails if the module (or a dependency) reaches for a Node API.
const bundle = path.join(os.tmpdir(), `superpen-fig-import-${process.pid}.mjs`);
const built = await build({
  entryPoints: [path.join(here, '..', 'src', 'import', 'figma', 'index.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  outfile: bundle,
  metafile: true,
  logLevel: 'error',
});
const bundleBytes = Object.values(built.metafile.outputs)[0].bytes;
const mod = await import(pathToFileURL(bundle).href);
fs.rmSync(bundle, { force: true });
console.log(`bundle: ${(bundleBytes / 1024).toFixed(1)} KB minified (module + fflate + fzstd)`);

const SIZE = /^(fill_container|fit_content)(\(-?\d+(\.\d+)?\))?$/;

/** Returns a list of problems with an import result (empty when it is sound). */
function check(result) {
  const problems = [];
  const bad = msg => {
    if (problems.length < 40) problems.push(msg);
    else if (problems.length === 40) problems.push('… more');
  };
  const ids = new Set();
  const reusable = new Set();
  const refs = [];
  const imagePaths = new Set(result.images.map(i => './' + i.path));
  const counts = {};
  let imageFills = 0;

  const numbers = (v, where) => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) bad(`${where}: number is not finite`);
    } else if (Array.isArray(v)) v.forEach((x, i) => numbers(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) if (k !== 'children') numbers(v[k], `${where}.${k}`);
  };
  const paints = (v, where) => {
    for (const f of Array.isArray(v) ? v : v === undefined ? [] : [v]) {
      if (typeof f === 'string') {
        if (!/^#[0-9A-F]{6}([0-9A-F]{2})?$/.test(f)) bad(`${where}: bad colour ${f}`);
      } else if (!f || typeof f !== 'object') bad(`${where}: bad paint`);
      else if (f.type === 'image') {
        imageFills++;
        if (!imagePaths.has(f.url)) bad(`${where}: image fill ${f.url} has no image`);
      } else if (f.type === 'gradient') {
        if (!Array.isArray(f.colors) || !f.colors.length) bad(`${where}: gradient without colours`);
        if (!['linear', 'radial', 'angular'].includes(f.gradientType)) bad(`${where}: gradient type ${f.gradientType}`);
      } else if (f.type !== 'color') bad(`${where}: paint type ${f.type}`);
    }
  };
  const walk = (n, parent) => {
    const where = `${n.type} ${n.id}`;
    counts[n.type] = (counts[n.type] ?? 0) + 1;
    if (typeof n.id !== 'string' || !n.id) bad(`${where}: no id`);
    else if (n.id.includes('/')) bad(`${where}: id contains "/"`);
    else if (ids.has(n.id)) bad(`${where}: duplicate id`);
    ids.add(n.id);
    numbers(n, where);
    paints(n.fill, `${where} fill`);
    paints(n.stroke, `${where} stroke`);
    for (const k of ['width', 'height']) {
      const v = n[k];
      if (v !== undefined && typeof v !== 'number' && !(typeof v === 'string' && SIZE.test(v))) bad(`${where}: ${k} is ${JSON.stringify(v)}`);
      if (typeof v === 'number' && v < 0) bad(`${where}: negative ${k}`);
    }
    if (n.reusable === true) reusable.add(n.id);
    if (n.type === 'ref') refs.push(n);
    if (n.type === 'frame' && !['none', 'vertical', 'horizontal'].includes(n.layout)) bad(`${where}: frame without an explicit layout`);
    if (n.type === 'text') {
      if (typeof n.content !== 'string') bad(`${where}: text without content`);
      if (!(typeof n.fontSize === 'number' && n.fontSize > 0)) bad(`${where}: text without a font size`);
      if (typeof n.fontFamily !== 'string' || !n.fontFamily) bad(`${where}: text without a font family`);
      if (!/^\d+$/.test(n.fontWeight ?? '')) bad(`${where}: font weight ${JSON.stringify(n.fontWeight)}`);
      if (!['auto', 'fixed-width', 'fixed-width-height'].includes(n.textGrowth)) bad(`${where}: textGrowth ${n.textGrowth}`);
    }
    if (n.type === 'path') {
      if (typeof n.geometry !== 'string') bad(`${where}: path without geometry`);
      else if (n.geometry && !/^M[-\d]/.test(n.geometry)) bad(`${where}: geometry does not start with a move`);
      if (!Array.isArray(n.viewBox) || n.viewBox.length !== 4) bad(`${where}: path without a viewBox`);
    }
    if ((n.type === 'frame' || n.type === 'group') && !Array.isArray(n.children)) bad(`${where}: container without children`);
    if (parent && parent.type === 'frame' && parent.layout !== 'none' && n.layoutPosition !== 'absolute' && (n.x !== undefined || n.y !== undefined)) bad(`${where}: x/y on a child that auto layout places`);
    for (const c of n.children ?? []) walk(c, n);
  };
  for (const n of result.nodes) {
    if (typeof n.x !== 'number' || typeof n.y !== 'number') bad(`${n.type} ${n.id}: top-level node without x/y`);
    walk(n, null);
  }
  for (const r of refs) if (!reusable.has(r.ref)) bad(`ref ${r.id}: component ${r.ref} does not exist`);
  const top = new Set(result.nodes.map(n => n.id));
  for (const s of result.sections) for (const id of s.frames) if (!top.has(id)) bad(`section ${s.name}: ${id} is not a top-level node`);
  for (const i of result.images) if (!i.bytes || !i.bytes.length) bad(`image ${i.path} is empty`);
  return { problems, counts, total: ids.size, imageFills };
}

const safeName = s => s.replace(/[^\w.-]+/g, '_').slice(0, 80);
let failed = false;

for (const file of files) {
  const name = path.basename(file);
  console.log(`\n== ${name} (${(fs.statSync(file).size / 1024).toFixed(0)} KB)`);
  const outDir = path.join(outRoot, safeName(name.replace(/\.(fig|html)$/i, '')));
  try {
    const isHtml = /\.html?$/i.test(file);
    const input = isHtml ? fs.readFileSync(file, 'utf8') : new Uint8Array(fs.readFileSync(file));
    if (!isHtml && !mod.isFigFile(input)) throw new Error('isFigFile() says this is not a .fig file');
    if (isHtml && !mod.figmaClipboard(input)) throw new Error('figmaClipboard() says this is not a Figma copy');
    const run = async pg => {
      const t0 = performance.now();
      const opts = { sections };
      if (pg !== undefined) opts.page = pg;
      const result = isHtml ? await mod.importFigmaClipboard(input, opts) : await mod.importFigFile(input, opts);
      return { result, ms: performance.now() - t0 };
    };
    const first = await run(page);
    const runs = [first];
    if (allPages && !isHtml) {
      for (let i = 0; i < first.result.pages.length; i++) {
        if (first.result.pages[i].name === first.result.page || !first.result.pages[i].frames) continue;
        runs.push(await run(i));
      }
    }
    if (!isHtml) console.log(`pages: ${first.result.pages.map(p => `${JSON.stringify(p.name)} (${p.frames})`).join(', ')}`);
    fs.mkdirSync(outDir, { recursive: true });
    for (const { result, ms } of runs) {
      const c = check(result);
      const label = isHtml ? 'clipboard' : `page ${JSON.stringify(result.page)}`;
      console.log(`${label}: ${result.nodes.length} top-level, ${c.total} nodes in ${ms.toFixed(0)} ms`);
      console.log(`  types: ${Object.entries(c.counts).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ') || '(none)'}`);
      console.log(`  images: ${result.images.length} files (${(result.images.reduce((s, i) => s + i.bytes.length, 0) / 1024).toFixed(0)} KB) used by ${c.imageFills} fills; sections: ${result.sections.length}`);
      for (const w of result.warnings) console.log(`  warning: ${w}`);
      if (c.problems.length) {
        failed = true;
        for (const p of c.problems) console.log(`  FAIL ${p}`);
      } else {
        console.log('  invariants: OK');
      }
      const base = safeName(name.replace(/\.(fig|html)$/i, '')) + (runs.length > 1 ? '.' + safeName(result.page ?? 'page') : '');
      const doc = { version: '2.21', children: result.nodes };
      if (result.sections.length) doc.sections = result.sections.map((s, i) => ({ id: `sec${i + 1}`, name: s.name, frames: s.frames }));
      fs.writeFileSync(path.join(outDir, base + '.spen'), JSON.stringify(doc));
      for (const img of result.images) {
        const p = path.join(outDir, img.path);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, img.bytes);
      }
      console.log(`  wrote ${path.join(outDir, base + '.spen')}`);
    }
  } catch (e) {
    failed = true;
    console.log(`  FAIL ${e?.stack ?? e}`);
  }
}
process.exit(failed ? 1 : 0);
