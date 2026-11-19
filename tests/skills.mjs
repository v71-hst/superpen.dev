// Design skills: the built MCP server lists them, serves each one whole (by name or alias), refuses unknown names,
// and offers them as prompts. No browser or dev server needed.
// Usage: npm run build:mcp, then: node skills.mjs [path to mcp.cjs, default ../dist/mcp.cjs]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = process.argv[2] ?? path.join(here, '..', 'dist', 'mcp.cjs');
const NAMES = ['un-ai', 'interface', 'layout', 'typography', 'colors', 'ui', 'writing', 'transitions', 'transitions-dev', 'accessibility', 'polish', 'interface-review'];

const p = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
const waiters = new Map();
p.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  }
});
let id = 0;
const call = (method, params) =>
  new Promise(res => {
    const n = ++id;
    waiters.set(n, res);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
const tool = async (name, args) => (await call('tools/call', { name, arguments: args })).result;

let pass = 0;
let fail = 0;
const ok = (name, cond, info = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
};

const init = await call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'skills-test', version: '1' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
ok('the server tells chats to load skills before designing', /list_design_skills/.test(init.result.instructions) && /get_design_skill/.test(init.result.instructions));

const tools = (await call('tools/list', {})).result.tools.map(t => t.name);
ok('tools list_design_skills and get_design_skill exist', tools.includes('list_design_skills') && tools.includes('get_design_skill'));

const index = (await tool('list_design_skills', {})).content[0].text;
ok('the index names all 12 skills with when to use each', NAMES.every(n => new RegExp(`^- ${n} \\(.+\\): use when \\S`, 'm').test(index)), `${index.length} chars`);
ok('the index says which skills to load for which task', /Which to load/.test(index) && /Game UI/.test(index));

const sizes = [];
let whole = true;
for (const n of NAMES) {
  const t = (await tool('get_design_skill', { names: [n] })).content[0].text;
  sizes.push(`${n} ${t.length}`);
  // Every skill has the same parts, so an agent always finds the rules, the editor specifics and the checklist.
  if (!(t.startsWith('# ') && /^> Use when: /m.test(t) && /^## The idea$/m.test(t) && /^## In Superpencil$/m.test(t) && /^## Check before you finish$/m.test(t) && /^## Common mistakes/m.test(t) && t.length > 4000)) {
    whole = false;
    console.log('  incomplete:', n);
  }
}
ok('each skill comes whole: idea, rules, editor specifics, checklist, mistakes', whole, sizes.join(', '));

const several = (await tool('get_design_skill', { names: ['Un AI', 'a11y', 'Better Colours', 'nope'] })).content[0].text;
ok('several at once, by alias, with unknown names reported', several.startsWith('# Un-AI') && /^# Better accessibility$/m.test(several) && /^# Better colors$/m.test(several) && /Not found: nope/.test(several));

const bad = await tool('get_design_skill', { names: ['nope'] });
ok('only unknown names is an error that lists the skills', bad.isError === true && /un-ai, interface, layout/.test(bad.content[0].text));

// Text that refers to tools must name tools the server really has.
const all = (await tool('get_design_skill', { names: NAMES })).content[0].text;
const mentioned = [...new Set([...all.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(m => m[1]))].filter(n => !/^(fill_container|fit_content|mesh_gradient|background_blur|space_between|space_around|max_size)$/.test(n));
const missing = mentioned.filter(n => !tools.includes(n));
ok('every tool a skill mentions exists', mentioned.length > 8 && !missing.length, missing.length ? `missing: ${missing.join(', ')}` : `${mentioned.length} tools mentioned`);

const prompts = (await call('prompts/list', {})).result.prompts.map(q => q.name);
ok('each skill is also a prompt', NAMES.every(n => prompts.includes(n)));
const pr = (await call('prompts/get', { name: 'polish', arguments: { target: 'the Shop frame' } })).result.messages[0].content.text;
ok('a prompt carries the target and the skill text', /the Shop frame/.test(pr) && /^# Polish$/m.test(pr));
const rv = (await call('prompts/get', { name: 'interface-review', arguments: {} })).result.messages[0].content.text;
ok('the review prompt does not change the design unless asked', /only if I ask you to fix/.test(rv) && /what I have selected/.test(rv));

console.log(`\n${pass}/${pass + fail} passed`);
p.kill();
process.exit(fail ? 1 : 0);
