// The indexes of a document and of its layer tree are brought up to date after an edit instead of being built again
// (src/model/doc.ts docIndex, src/model/resolve.ts patchTreeIndex), and locate() follows a path into the edit copy
// instead of searching it. This checks them against the plain versions over thousands of random edits: property
// changes, layers added, removed, moved and reordered, components made and unmade, repeated ids, undo.
// No browser. Usage: node docindex.mjs [edits=3000] [seed=1]
import { build } from 'esbuild';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const [, , editsArg = '3000', seedArg = '1'] = process.argv;
const entry = path.join(os.tmpdir(), `superpen-docindex-entry-${process.pid}.ts`);
const out = path.join(os.tmpdir(), `superpen-docindex-${process.pid}.mjs`);
const src = p => JSON.stringify(path.join(here, '..', 'src', 'model', p).replace(/\\/g, '/'));
fs.writeFileSync(entry, `export * from ${src('doc.ts')};\nexport { TreeBuilder, indexTree, patchTreeIndex } from ${src('resolve.ts')};\nexport { produce, setAutoFreeze } from 'immer';\n`);
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', target: 'es2022', outfile: out, logLevel: 'error', nodePaths: [path.join(here, '..', 'node_modules')] });
const m = await import(pathToFileURL(out).href);
fs.rmSync(entry, { force: true });
fs.rmSync(out, { force: true });
const { produce, setAutoFreeze, docIndex, buildDocIndex, locate, TreeBuilder, indexTree, patchTreeIndex } = m;
setAutoFreeze(false); // as the editor runs it

// A small repeatable random source.
let seed = Number(seedArg) >>> 0 || 1;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const pick = list => list[Math.floor(rnd() * list.length)];
let nextId = 0;
const newNode = depth => {
  const n = { type: depth < 3 && rnd() < 0.5 ? 'frame' : 'rectangle', id: 'n' + nextId++, x: Math.round(rnd() * 100), width: 50, height: 50 };
  if (n.type === 'frame') {
    n.layout = 'none';
    n.children = [];
    const kids = Math.floor(rnd() * 4);
    for (let i = 0; i < kids; i++) n.children.push(newNode(depth + 1));
    if (rnd() < 0.08) n.reusable = true;
  }
  return n;
};
let doc = { version: '2.21', children: Array.from({ length: 40 }, () => newNode(0)) };

const all = d => {
  const list = [];
  const walk = (nodes, parent) => nodes?.forEach((n, i) => { if (n && typeof n === 'object') { list.push({ n, parent, i }); walk(n.children, n); } });
  walk(d.children, null);
  return list;
};
const slowLocate = (d, id) => {
  const walk = (nodes, parent) => {
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.id === id) return { node: n, siblings: nodes, index: i, parent };
      if (n.children) { const r = walk(n.children, n); if (r) return r; }
    }
    return null;
  };
  return walk(d.children, null);
};

let fails = 0;
const fail = (what, info) => { if (fails++ < 8) console.log(`FAIL ${what} — ${info}`); };
const sameMap = (a, b, eq = (x, y) => x === y) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && eq(v, b.get(k)));
const checkDocIndex = (got, d, step) => {
  const want = buildDocIndex(d);
  if (!sameMap(got.byId, want.byId)) fail('byId', `step ${step}`);
  if (!sameMap(got.parentOf, want.parentOf)) fail('parentOf', `step ${step}`);
  if (!sameMap(got.at, want.at, (x, y) => x.parent === y.parent && x.index === y.index)) fail('at', `step ${step}`);
  if (got.components.length !== want.components.length || got.components.some((c, i) => c !== want.components[i])) fail('components', `step ${step}`);
  if (got.repeats !== want.repeats) fail('repeats', `step ${step}`);
};

const builder = new TreeBuilder();
let roots = builder.build(doc, {});
let treeIdx = indexTree(roots);
const history = [doc];
let patchedDoc = 0, patchedTree = 0, wholeTree = 0, locates = 0, componentListsKept = true;
docIndex(doc);

const edits = Number(editsArg);
for (let step = 0; step < edits; step++) {
  const before = doc;
  const kind = rnd();
  let next;
  if (kind < 0.04 && history.length > 3) {
    next = history[history.length - 1 - Math.floor(rnd() * 3) - 1]; // undo a few steps
  } else {
    next = produce(doc, d => {
      const list = all(before);
      const target = pick(list);
      // locate() inside the edit must agree with a plain search, before and after this edit changes things.
      const check = id => {
        locates++;
        const a = locate(d, id), b = slowLocate(d, id);
        if (!!a !== !!b || (a && (a.node !== b.node || a.index !== b.index || a.parent !== b.parent || a.siblings !== b.siblings))) fail('locate', `step ${step} id ${id}`);
      };
      if (target) check(target.n.id);
      check('no-such-id');
      const t = target ? locate(d, target.n.id) : null;
      const seen = new Set();
      const twice = list.filter(e => (seen.has(e.n.id) ? true : (seen.add(e.n.id), false)));
      if (twice.length && rnd() < 0.5) {
        // Mend a broken file: give the repeated ids new ones, so the shortcuts are tried again afterwards.
        for (const e of twice) { const l = slowLocate(d, e.n.id); if (l) l.node.id = 'n' + nextId++; }
      } else if (!t || kind < 0.55) {
        if (t) t.node.x = (t.node.x ?? 0) + 1; // the usual edit: one property
      } else if (kind < 0.70) {
        (t.node.children ?? d.children).push(newNode(2)); // add
      } else if (kind < 0.76) {
        t.siblings.splice(t.index, 1); // remove
      } else if (kind < 0.83) {
        const [moved] = t.siblings.splice(t.index, 1); // move somewhere else
        const dest = pick(all(d).filter(e => e.n.children && e.n !== moved));
        (dest ? dest.n.children : d.children).push(moved);
      } else if (kind < 0.9) {
        if (t.siblings.length > 1) t.siblings.reverse(); // reorder
      } else if (kind < 0.96) {
        if (t.node.reusable) delete t.node.reusable; else t.node.reusable = true; // component made / unmade
      } else if (kind < 0.975) {
        t.siblings.push({ type: 'rectangle', id: t.node.id, width: 1, height: 1 }); // a repeated id (broken file)
      } else {
        t.node.x = 5;
        if (t.parent) t.parent.gap = (t.parent.gap ?? 0) + 1; // two layers in one edit
      }
      const again = pick(all(before));
      if (again) check(again.n.id);
      if (target) check(target.n.id);
    });
  }
  if (next === doc) continue;
  // As the editor does: the tree builder brings its index up to date from the document it had before.
  const wasCached = docIndex(before);
  const comps = wasCached.components;
  const compsCopy = comps.slice();
  const newRoots = builder.build(next, {});
  const idx = docIndex(next);
  if (idx === wasCached) patchedDoc++;
  if (comps.some((c, i) => c !== compsCopy[i]) || comps.length !== compsCopy.length) componentListsKept = false;
  checkDocIndex(idx, next, step);
  checkDocIndex(docIndex(before), before, step + ' (the earlier version, asked for again)');
  docIndex(next); // (cached)
  let ti = null;
  if (!treeIdx.repeats && patchTreeIndex(treeIdx, roots, newRoots)) { ti = treeIdx; patchedTree++; } else { ti = indexTree(newRoots); wholeTree++; }
  const wantTree = indexTree(newRoots);
  if (!sameMap(ti.byKey, wantTree.byKey) || !sameMap(ti.parent, wantTree.parent)) fail('tree index', `step ${step}`);
  roots = newRoots;
  treeIdx = ti;
  doc = next;
  history.push(doc);
  if (history.length > 12) history.shift();
}

const ok = (name, cond, info = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`); if (!cond) process.exitCode = 1; };
ok('document index brought up to date equals one built whole, after every edit', fails === 0, `${edits} random edits, ${all(doc).length} layers at the end; ${patchedDoc} brought up to date, the rest built whole`);
ok('the shortcut is really taken for ordinary edits', patchedDoc > edits * 0.4 && patchedTree > edits * 0.4, `document ${patchedDoc}, tree ${patchedTree} (built whole ${wholeTree})`);
ok('locate() in an edit agrees with a plain search', fails === 0 && locates > edits, `${locates} lookups`);
ok('a list of components that was handed out is never changed in place', componentListsKept);
