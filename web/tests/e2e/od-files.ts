import type { BrowserContext } from '@playwright/test';
import { odDeskFixture, builtFileFor, readBuiltFile } from '../fixtures/od-desk';
import path from 'node:path';

/** Serve the built /decide page and all desk dependencies without a server or network. */
export async function installOdFiles(context: BrowserContext) {
  const cache = new Map<string, Buffer>();
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/session') { await route.fulfill({ json: null }); return; }
    if (url.pathname === '/api/usage') { await route.fulfill({ status: 204, body: '' }); return; }
    const fixture = odDeskFixture.get(url.pathname);
    if (fixture) { await route.fulfill(fixture); return; }
    if (url.pathname.startsWith('/api/aviation')) { await route.fulfill({ status: 404, body: '' }); return; }
    let file: string;
    try { file = builtFileFor(url.pathname, url.search); } catch { await route.abort(); return; }
    if (file.includes('..') || !path.isAbsolute(file)) { await route.abort(); return; }
    try {
      if (!cache.has(file)) cache.set(file, readBuiltFile(file));
      const ext = path.extname(file);
      const contentType = ({
        '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json',
        '.rsc': 'text/x-component', '.webp': 'image/webp', '.png': 'image/png', '.svg': 'image/svg+xml',
      } as Record<string, string>)[ext] ?? 'application/octet-stream';
      await route.fulfill({ body: cache.get(file)!, contentType });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
}
