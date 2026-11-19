// Which browser the tests drive: Edge on Windows by default, or any Chromium-based browser named in PEN_BROWSER
// (on Linux, e.g. `npx @puppeteer/browsers install chrome@stable` and point PEN_BROWSER at the binary it prints).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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

// WINDOWS ACCOUNT LOCKOUT (2026-11-19). A Chromium browser (Edge, Chrome) that starts with a new, empty profile checks
// whether the Windows account has a blank password by trying to sign in as the user with an empty one. That attempt
// fails and Windows counts it as a failed sign-in. Every test launch used to get a new profile, so ten launches inside
// ten minutes locked the user's Windows account ("The referenced account is currently locked out"): they could not
// unlock their PC until the lockout ran out. Security log: event 4625 from msedge.exe, logon type 2, Advapi.
//
// The browser skips the check when its profile says the password was already checked and has not changed since.
// So: NEVER start a test browser on a profile that did not come from newProfile(). Checked by lockout.mjs.
const SEED = { password_manager: { os_password_blank: false, os_password_last_changed: '99999999999999999' } };

/** A new, empty browser profile that will not try to sign in to Windows. `keep` leaves removing it to the caller. */
export function newProfile(prefix = 'superpen-test-', keep = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify(SEED));
  if (!keep) {
    process.on('exit', () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* still in use: the system's temp cleanup takes it */
      }
    });
  }
  return dir;
}

/** Failed sign-ins Windows currently counts against this account (null when it cannot be read, or not on Windows). */
export function failedSignIns() {
  if (process.platform !== 'win32') return null;
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', `([ADSI]"WinNT://./$env:USERNAME,user").BadPasswordAttempts.Value`], { encoding: 'utf8', timeout: 15000 });
    const n = parseInt(out.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Second line of defence: if failed sign-ins are piling up anyway, stop before the account gets locked (Windows locks
// it at 10 by default). Checked once per test process.
const GUARD_LIMIT = 4;
let guarded = false;
export function guardSignIns() {
  if (guarded || process.env.PEN_NO_SIGNIN_GUARD) return;
  guarded = true;
  const n = failedSignIns();
  if (n !== null && n >= GUARD_LIMIT) {
    throw new Error(
      `Not starting a test browser: Windows counts ${n} failed sign-ins against this account right now, and at 10 it locks the account. ` +
        `Something is making failed sign-ins (see the note in tests/browser.mjs). Wait 10 minutes and find out what before running tests again.`,
    );
  }
}

/** Options for puppeteer.launch: the browser above, a safe profile, plus what a Linux container needs to start it. */
export function launchOptions(opts = {}) {
  guardSignIns();
  // Linux containers have no GPU: software WebGL (SwiftShader) so shaders and the Skia renderer can run at all.
  const extra = process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : [];
  return { executablePath: BROWSER, userDataDir: newProfile(), ...opts, args: [...(opts.args ?? []), ...extra] };
}
