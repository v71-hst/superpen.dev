// A design in a background tab: agent screenshots must still come back (a background tab gets no animation frames,
// which used to leave them hanging until the tab was shown), and in performance mode the tab lets go of its frames
// after a while and gets them back when shown. Usage: node hiddentab.mjs <url of a .pen with frames>
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const [, , url] = process.argv;
const browser = await puppeteer.launch(launchOptions({ headless: true, protocolTimeout: 120000 }));
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
await page.evaluateOnNewDocument(() => localStorage.setItem('pen.perfMode', '1'));
await page.goto(url, { waitUntil: 'networkidle2', timeout: 180000 });
await page.waitForSelector('#pen-world [data-k]', { timeout: 180000 });
await sleep(4000);
const key = await page.evaluate(() => window.__penStore.getState().doc.children.find(n => n.type === 'frame').id);
const count = () => page.evaluate(() => document.querySelectorAll('#pen-world > [data-k]').length);
const shownBefore = await count();
// Put another tab in front.
const other = await browser.newPage();
await other.goto('about:blank');
await other.bringToFront();
await sleep(1000);
const state = await page.evaluate(
  () =>
    new Promise(res => {
      let frames = 0;
      const id = requestAnimationFrame(() => frames++);
      setTimeout(() => { cancelAnimationFrame(id); res({ hidden: document.hidden, frames }); }, 1500);
    }),
);
ok('the editor tab is in the background and gets no animation frames', state.hidden && state.frames === 0, JSON.stringify(state));
const t0 = Date.now();
const shot = await Promise.race([page.evaluate(key => window.__penAgent('screenshot', { id: key }).then(r => ({ w: r.width, h: r.height, bytes: r.dataUrl.length })), key), sleep(20000).then(() => null)]);
ok('screenshot of a background tab comes back', !!shot && shot.bytes > 2000, shot ? `${shot.w}×${shot.h} in ${Date.now() - t0}ms` : 'no answer in 20s');
const layout = await Promise.race([page.evaluate(key => window.__penAgent('checkLayout', { id: key }).then(r => r.length), key), sleep(20000).then(() => null)]);
ok('check_layout of a background tab comes back', layout !== null, `${layout} issue(s)`);
// Performance mode: after 20s in the background the frames are let go.
await sleep(22000);
const asleep = await page.evaluate(() => ({ asleep: window.__penStore.getState().asleep, perf: window.__penStore.getState().perfMode }));
const shownAsleep = await count();
ok('performance mode: a background tab lets go of its frames', asleep.asleep && shownAsleep < shownBefore, `asleep ${asleep.asleep}; top-level frames drawn ${shownBefore} -> ${shownAsleep}`);
const shot2 = await Promise.race([page.evaluate(key => window.__penAgent('screenshot', { id: key }).then(r => r.dataUrl.length), key), sleep(20000).then(() => null)]);
ok('and a screenshot still works while it sleeps', !!shot2 && shot2 > 2000, `${shot2} bytes`);
await page.bringToFront();
await sleep(1500);
ok('shown again: the frames are back', (await count()) === shownBefore && !(await page.evaluate(() => window.__penStore.getState().asleep)), `${await count()} drawn`);
await browser.close();
