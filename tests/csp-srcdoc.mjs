// HTML import lays markup out in a sandboxed srcdoc iframe. This checks that the content security policy of the
// VS Code webview (extension/extension.ts, the list below must match it) lets such an iframe load and be styled.
// Usage: node csp-srcdoc.mjs
import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const csp = [
  `default-src 'none'`,
  `img-src 'self' https: data: blob:`,
  `media-src 'self' https: data: blob:`,
  `font-src 'self' https://fonts.gstatic.com https://unpkg.com data:`,
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com`,
  `script-src 'self' 'unsafe-eval' 'nonce-test'`,
  `connect-src 'self' https: data: blob:`,
  `frame-src https: http:`,
  `worker-src blob:`,
].join('; ');
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
const blocked = [];
page.on('console', m => /Content Security Policy|Refused/.test(m.text()) && blocked.push(m.text().slice(0, 160)));
await page.setContent(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body></body></html>`);
const r = await page.evaluate(
  () =>
    new Promise(res => {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-same-origin');
      f.style.cssText = 'position:fixed;left:0;top:0;width:400px;height:300px;visibility:hidden';
      f.onload = () => {
        const d = f.contentDocument;
        const el = d?.querySelector('.box');
        const cs = el && d.defaultView.getComputedStyle(el);
        res({ loaded: !!el, width: el?.getBoundingClientRect().width, color: cs?.backgroundColor, ran: d?.body.dataset.ran ?? null });
      };
      f.srcdoc = '<style>.box{width:120px;height:40px;background:rgb(255,0,0)}</style><div class="box">x</div><script>document.body.dataset.ran = "yes"</scr' + 'ipt>';
      document.body.appendChild(f);
      setTimeout(() => res({ loaded: false, timeout: true }), 5000);
    }),
);
const ok = (name, cond, info = '') => console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
ok('a sandboxed srcdoc iframe loads under the webview policy', r.loaded, JSON.stringify(r));
ok('its inline styles apply and can be measured', r.width === 120 && r.color === 'rgb(255, 0, 0)');
ok('scripts in it do not run', r.ran === null);
if (blocked.length) console.log('blocked:', blocked.join(' | '));
await browser.close();
process.exit(r.loaded && r.width === 120 && r.ran === null ? 0 : 1);
