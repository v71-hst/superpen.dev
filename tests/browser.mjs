// Which browser the tests drive: Edge on Windows by default, or any Chromium-based browser named in PEN_BROWSER
// (on Linux, e.g. `npx @puppeteer/browsers install chrome@stable` and point PEN_BROWSER at the binary it prints).
import fs from 'node:fs';

const CANDIDATES = [
  process.env.PEN_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export const BROWSER = CANDIDATES.find(p => p && fs.existsSync(p));
if (!BROWSER) throw new Error('No browser found for the tests. Set PEN_BROWSER to a Chrome, Chromium or Edge executable.');

/** Options for puppeteer.launch: the browser above, plus what a Linux container needs to start it. */
export function launchOptions(opts = {}) {
  const extra = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [];
  return { executablePath: BROWSER, ...opts, args: [...(opts.args ?? []), ...extra] };
}
