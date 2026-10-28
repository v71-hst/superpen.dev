// Script nodes: JavaScript files that generate child nodes. Scripts run in a sandboxed Web Worker with a time limit
// and a deterministic Math.random; results are cached by file content, inputs and size.
import type { PenNode } from '../model/types';

export type ScriptInput = { name: string; type: string; default?: any; options?: string[]; min?: number; max?: number };
export type ScriptHeader = { schema?: string; inputs: ScriptInput[] };
export type ScriptState = { status: 'pending' } | { status: 'ok'; nodes: PenNode[] } | { status: 'error'; message: string };

const TIMEOUT_MS = 3000;

// ---------- asset text loading (shared with shaders) ----------

const textCache = new Map<string, Promise<string>>();
let assetEpoch = 0;
const listeners = new Set<() => void>();

export function loadText(url: string): Promise<string> {
  let p = textCache.get(url);
  if (!p) {
    p = fetch(url, { cache: 'no-store' }).then(r => (r.ok ? r.text() : Promise.reject(new Error(`could not load ${url} (${r.status})`))));
    textCache.set(url, p);
    p.catch(() => setTimeout(() => textCache.delete(url), 2000));
  }
  return p;
}

/** Called when script/shader files change on disk: drop cached text and re-run everything. */
export function invalidateAssets() {
  textCache.clear();
  results.clear();
  assetEpoch++;
  for (const l of listeners) l();
}

export function onAssetsChanged(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAssetEpoch() {
  return assetEpoch;
}

// ---------- header parsing ----------

function parseValue(type: string, raw: string | undefined): any {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (type === 'number') return Number(s);
  if (type === 'boolean') return s === 'true';
  if (/^".*"$|^'.*'$/.test(s)) return s.slice(1, -1);
  return s;
}

export function parseScriptHeader(code: string): ScriptHeader {
  const m = code.match(/\/\*\*([\s\S]*?)\*\//);
  const out: ScriptHeader = { inputs: [] };
  if (!m) return out;
  for (const line of m[1].split('\n')) {
    const l = line.replace(/^\s*\*?\s?/, '').trim();
    const schema = l.match(/^@schema\s+([\d.]+)/);
    if (schema) out.schema = schema[1];
    const inp = l.match(/^@input\s+(\w+)\s*:\s*(\w+)\s*(\(([^)]*)\))?\s*(?:=\s*(.*))?$/);
    if (!inp) continue;
    const [, name, type, , args, def] = inp;
    const input: ScriptInput = { name, type };
    if (type === 'enum') input.options = (args ?? '').split(',').map(x => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    else if (args) {
      for (const kv of args.split(',')) {
        const [k, v] = kv.split('=').map(x => x.trim());
        if (k === 'min') input.min = Number(v);
        if (k === 'max') input.max = Number(v);
      }
    }
    input.default = parseValue(type, def);
    out.inputs.push(input);
  }
  return out;
}

// ---------- worker sandbox ----------

const WORKER_SRC = `
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
self.onmessage = (e) => {
  const { id, code, pencil, seed } = e.data;
  try {
    const M = Object.create(Math);
    M.random = mulberry32(seed);
    const fn = new Function('pencil', 'Math', '"use strict";\\n' + code);
    const out = fn(Object.freeze(pencil), M);
    if (!Array.isArray(out)) throw new Error('script must return an array of nodes (got ' + (out === null ? 'null' : typeof out) + ')');
    self.postMessage({ id, nodes: JSON.parse(JSON.stringify(out)) });
  } catch (err) {
    self.postMessage({ id, error: (err && err.message) || String(err) });
  }
};`;

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (n: PenNode[]) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
// Scripts run one at a time so a runaway script can be killed without affecting others.
let chain: Promise<unknown> = Promise.resolve();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' })));
    worker.onmessage = e => {
      const p = pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.nodes);
    };
  }
  return worker;
}

function runInWorker(code: string, pencil: any, seed: number): Promise<PenNode[]> {
  const job = () =>
    new Promise<PenNode[]>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        worker?.terminate();
        worker = null;
        reject(new Error(`script timed out after ${TIMEOUT_MS / 1000}s (infinite loop?)`));
      }, TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      getWorker().postMessage({ id, code, pencil, seed });
    });
  const p = chain.then(job, job);
  chain = p.catch(() => undefined);
  return p;
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// ---------- results cache ----------

const results = new Map<string, ScriptState>();
let notify: (() => void) | null = null;
let notifyTimer: ReturnType<typeof setTimeout> | undefined;

/** Registers the callback that rebuilds the tree when script output arrives (batched). */
export function setScriptNotifier(fn: () => void) {
  notify = fn;
}

function changed() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => notify?.(), 30);
}

export type ScriptRequest = { key: string; url: string; inputs: Record<string, any>; width: number; height: number };

function cacheKey(r: ScriptRequest) {
  return `${r.url}|${r.width}|${r.height}|${JSON.stringify(r.inputs)}|${r.key}`;
}

/** Synchronous lookup used while building the render tree; starts the script if it hasn't run yet. */
export function scriptOutput(r: ScriptRequest): ScriptState {
  const k = cacheKey(r);
  const hit = results.get(k);
  if (hit) return hit;
  results.set(k, { status: 'pending' });
  (async () => {
    try {
      const code = await loadText(r.url);
      const header = parseScriptHeader(code);
      if (!header.schema) throw new Error('missing /** @schema 2.11 */ header');
      const input: Record<string, any> = {};
      for (const i of header.inputs) input[i.name] = i.default;
      Object.assign(input, r.inputs);
      for (const i of header.inputs) {
        if (i.type === 'number') input[i.name] = Math.min(i.max ?? Infinity, Math.max(i.min ?? -Infinity, Number(input[i.name] ?? 0)));
      }
      const nodes = await runInWorker(code, { width: r.width, height: r.height, input }, hash(r.key));
      results.set(k, { status: 'ok', nodes: nodes.filter(n => n && typeof n === 'object' && typeof n.type === 'string') });
    } catch (e) {
      results.set(k, { status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    changed();
  })();
  return results.get(k)!;
}

export async function scriptHeaderFor(url: string): Promise<ScriptHeader> {
  return parseScriptHeader(await loadText(url));
}

export const SCRIPT_TEMPLATE = `/**
 * @schema 2.11
 * @input count: number(min=1, max=200) = 12
 * @input color: color = #3B82F6
 * @input radius: number = 6
 */
// Scripts get pencil.width, pencil.height and pencil.input.<name>, and return an array of .pen nodes.
const n = Math.floor(pencil.input.count);
const w = pencil.width / n;
const nodes = [];
for (let i = 0; i < n; i++) {
  const h = pencil.height * (0.2 + 0.8 * Math.random());
  nodes.push({
    type: "rectangle",
    name: "Bar " + (i + 1),
    x: i * w + 2,
    y: pencil.height - h,
    width: Math.max(1, w - 4),
    height: h,
    cornerRadius: pencil.input.radius,
    fill: pencil.input.color,
  });
}
return nodes;
`;
