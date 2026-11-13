import puppeteer from 'puppeteer-core';
import { launchOptions } from './browser.mjs';
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 400)));
page.on('console', m => m.type() === 'error' && console.log('[console]', m.text().slice(0, 400)));
await page.goto(process.argv[2], { waitUntil: 'networkidle2' });
await new Promise(r => setTimeout(r, 4000));
await browser.close();
