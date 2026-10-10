import type { BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { trainingFixture } from '../fixtures/training';

/** Serve the built /train page without sockets in restricted local QA. */
export async function installTrainingFiles(context: BrowserContext) {
  const assets = new Map<string, Buffer>();
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const fixture = trainingFixture.get(url.pathname);
    if (fixture) { await route.fulfill(fixture); return; }
    const file = url.pathname.startsWith('/_next/static/') ? `.next/${url.pathname.slice(7)}`
      : url.pathname.startsWith('/data/') ? `public${url.pathname}`
      : `.next/server/app${url.pathname === '/' ? '/index' : url.pathname.replace(/\/$/, '')}${url.searchParams.has('_rsc') ? '.rsc' : '.html'}`;
    if (file.includes('..')) { await route.abort(); return; }
    try {
      if (!assets.has(file)) assets.set(file, readFileSync(file));
      const ext = path.extname(file);
      const contentType = ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.rsc': 'text/x-component' } as Record<string, string>)[ext] ?? 'application/octet-stream';
      await route.fulfill({ body: assets.get(file)!, contentType });
    } catch { await route.fulfill({ status: 404, body: '' }); }
  });
}
