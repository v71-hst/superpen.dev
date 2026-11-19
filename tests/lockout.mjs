// Guard against locking the Windows account (see the note in browser.mjs): starts the test browser a few times the
// way every test does and checks that Windows counts no new failed sign-ins, and that no script starts a browser on
// a profile of its own. Windows only. It starts 3 browsers, so even if the protection were broken it adds 3 failed
// sign-ins, well under the 10 that lock an account.
// Usage: node lockout.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { failedSignIns, launchOptions } from './browser.mjs';

const ok = (name, cond, info = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
  if (!cond) process.exitCode = 1;
};

// Every script must get its browser profile from browser.mjs.
const here = path.dirname(fileURLToPath(import.meta.url));
const offenders = [];
for (const f of fs.readdirSync(here).filter(f => f.endsWith('.mjs') && f !== 'browser.mjs' && f !== 'lockout.mjs')) {
  const src = fs.readFileSync(path.join(here, f), 'utf8');
  if (/puppeteer\.launch\(/.test(src) && !/puppeteer\.launch\(\s*launchOptions\(/.test(src)) offenders.push(`${f}: puppeteer.launch without launchOptions`);
  if (/puppeteer\.launch\((?!\s*launchOptions\()/.test(src)) offenders.push(`${f}: a puppeteer.launch call without launchOptions`);
  if (/user-data-dir|userDataDir/.test(src) && !/newProfile\(/.test(src)) offenders.push(`${f}: its own browser profile (use newProfile)`);
  if (/mkdtempSync\([^)]*\)/.test(src) && /spawn\(BROWSER/.test(src) && !/newProfile\(/.test(src)) offenders.push(`${f}: starts the browser on a folder it made itself`);
}
ok('every script takes its browser profile from browser.mjs', offenders.length === 0, [...new Set(offenders)].join('; '));

const before = failedSignIns();
if (before === null) {
  console.log('SKIP failed sign-ins cannot be read here (not Windows, or no access)');
} else {
  for (let i = 0; i < 3; i++) {
    const browser = await puppeteer.launch(launchOptions({ headless: true }));
    const page = await browser.newPage();
    await page.setContent('<p>hello</p>');
    await new Promise(r => setTimeout(r, 4000)); // the check used to happen within 1–3 s of starting
    await browser.close();
  }
  const after = failedSignIns();
  ok('starting test browsers makes no failed Windows sign-ins', after !== null && after <= before, `counter ${before} -> ${after} after 3 launches`);
}
