// Snapshot memory retention measured with NO debugger attached (a debugger keeps copies of what a page loads, which
// inflates the numbers): Edge is started plain, the page runs the test itself and reports over HTTP, and memory is
// read from Windows. Usage: node svgretain2.mjs [count=120] [payloadKB=1500] [mode=data|subset]
import http from 'node:http';
import { BROWSER } from './browser.mjs';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
const [, , count = '120', kb = '1500', mode = 'data', waitS = '20'] = process.argv;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pen-retain-'));
const html = `<!doctype html><meta charset="utf-8"><body><script>
const q = new URLSearchParams(location.search);
const count = +q.get('count'), kb = +q.get('kb'), mode = q.get('mode');
const report = s => fetch('/report?' + s).catch(() => {});
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function run() {
  await sleep(1500);
  if (window.gc) gc();
  await report('stage=ready');
  await sleep(1500);
  let readable = true;
  for (let i = 0; i < count; i++) {
    const pad = '/*' + i + 'Zm9udGRhdGE'.repeat((kb * 1024) / 11) + '*/';
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="width:300px;height:200px;background:#246"><style>' + pad + '</style><p style="color:#fff">snapshot ' + i + '</p></div></foreignObject></svg>';
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 300; c.height = 200;
    c.getContext('2d').drawImage(img, 0, 0);
    try { c.toDataURL(); } catch { readable = false; }
  }
  await sleep(500);
  if (window.gc) { gc(); await sleep(500); gc(); }
  await report('stage=done&readable=' + readable + '&gc=' + !!window.gc);
}
run();
</script>`;
let stage = '';
let info = '';
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/report')) {
    const q = new URL(req.url, 'http://x').searchParams;
    stage = q.get('stage');
    info = req.url;
    res.end('ok');
  } else {
    res.setHeader('content-type', 'text/html');
    res.end(html);
  }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const edge = spawn(BROWSER, ['--headless=new', '--no-first-run', '--disable-extensions', `--user-data-dir=${profile}`, '--js-flags=--expose-gc', `http://127.0.0.1:${port}/?count=${count}&kb=${kb}&mode=${mode}`], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rendererMB() {
  const tag = path.basename(profile);
  const out = execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.CommandLine -like '*--type=renderer*' } | ForEach-Object { (Get-Process -Id $_.ProcessId).PrivateMemorySize64 } | Measure-Object -Sum | ForEach-Object Sum`]).toString();
  return Math.round(+out / 1048576);
}
const until = async s => { const t0 = Date.now(); while (stage !== s && Date.now() - t0 < 300000) await sleep(200); };
await until('ready');
const before = rendererMB();
await until('done');
await sleep(2000);
const after = rendererMB();
console.log(`no debugger, ${count} snapshots of ${kb} KB: renderer ${before} -> ${after} MB, retained ${after - before} MB (${((after - before) / +count).toFixed(2)} MB/snapshot) [${info.replace('/report?', '')}]`);
for (let t = 0; t < +waitS; t += 20) {
  await sleep(20000);
  console.log(`   ${t + 20}s later: retained ${rendererMB() - before} MB`);
}
edge.kill();
server.close();
try { execFileSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]); } catch {}
await sleep(500);
fs.rmSync(profile, { recursive: true, force: true });
