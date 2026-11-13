import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';
import { launchOptions } from './browser.mjs';
const browser = await puppeteer.launch(launchOptions({ headless: true }));
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 400, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(process.argv[2]).href);
await new Promise(r => setTimeout(r, 500));
await page.screenshot({ path: process.argv[3], omitBackground: true });
await browser.close();

