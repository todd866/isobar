/** Headless Chromium for layout tests and preview shots. Never opens a window. */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function chromePath() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    const shells = readdirSync(cache).filter((name) => name.startsWith('chromium_headless_shell-')).sort().reverse();
    for (const shell of shells) {
      for (const arch of ['chrome-headless-shell-mac-arm64', 'chrome-mac', 'chrome-headless-shell-mac-x64']) {
        const bin = join(cache, shell, arch, 'chrome-headless-shell');
        if (existsSync(bin)) return bin;
      }
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  for (const bin of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (existsSync(bin)) return bin;
  return null;
}

export async function launch() {
  const path = chromePath();
  if (!path) return null;
  const { chromium } = await import('playwright-core');
  // A sandboxed macOS runner may forbid Chromium's Mach rendezvous service.
  // This opt-in keeps local fixture rendering in a single headless process.
  const args = process.env.TRAINING_SINGLE_PROCESS === '1'
    ? ['--single-process', '--no-zygote', '--disable-gpu', '--in-process-gpu'] : [];
  const browser = await chromium.launch({ headless: true, executablePath: path, args });
  if (args.length) {
    // Single-process Chromium cannot dispose and recreate incognito contexts.
    // Fixture pages share one local context, kept until the browser closes.
    const context = await browser.newContext({ deviceScaleFactor: 2 });
    browser.newPage = async (options = {}) => {
      const page = await context.newPage();
      if (options.viewport) await page.setViewportSize(options.viewport);
      return page;
    };
  }
  return browser;
}
