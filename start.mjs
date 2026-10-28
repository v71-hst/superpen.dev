// Launches the editor: `node start.mjs [folder-or-.pen-file]`
import { createServer } from 'vite';
import path from 'node:path';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const arg = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, 'examples');
let workspace = arg;
let openFile = '';
if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
  workspace = path.dirname(arg);
  openFile = path.basename(arg);
}
process.env.PEN_WORKSPACE = workspace;

const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), root: here });
await server.listen();
const base = server.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5178/';
const url = openFile ? `${base}?file=${encodeURIComponent(openFile)}` : base;
console.log(`\n  pen editor running at ${url}\n  workspace: ${workspace}\n`);
if (!process.env.PEN_NO_OPEN) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd);
}
