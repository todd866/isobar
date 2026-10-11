import { defineConfig, devices, type Project } from '@playwright/test';

const port = Number(process.env.ISOBAR_E2E_PORT ?? 4173);
const baseURL = `http://127.0.0.1:${port}`;
// This macOS WebKit runtime stalls after HTTP 200 on numeric loopback; the
// same pages load normally through localhost. Keep browser identity explicit.
const webkitURL = `http://localhost:${port}`;
const webkitFiles = [/mobile-shell\.spec\.ts$/, /e6b-iphone\.spec\.ts$/, /map-enlarged-text\.spec\.ts$/];

// Headless on the Mac's GPU (Metal via ANGLE). SwiftShader mis-composites the
// WebGL plate under overlapping panels and is far slower than any real browser.
// ISOBAR_E2E_SOFTWARE=1 falls back to the CPU rasteriser.
const chromium: Project['use'] = {
  ...devices['Desktop Chrome'],
  launchOptions: process.env.ISOBAR_E2E_SINGLE_PROCESS === '1' ? {
    executablePath: process.env.CHROME_PATH,
    args: ['--single-process', '--no-zygote', '--disable-gpu', '--in-process-gpu'],
  } : process.env.ISOBAR_E2E_SOFTWARE ? {} : { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] },
};

// Frame-interval budgets (perf, E6-B drags, terrain pan/zoom). They run after
// the rest of the suite, alone, and may retry once. The budgets stay put.
const frameTime = [/perf\.spec\.ts$/, /e6b-smooth\.spec\.ts$/, /terrain\.spec\.ts$/];

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL,
    headless: true,
    actionTimeout: 15_000,
    screenshot: 'off',
    video: 'off',
    // Scope test traffic marking to our server; global headers break third-party CORS.
    storageState: { cookies: [{ name: 'isobar-test', value: '1', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] },
  },
  webServer: process.env.ISOBAR_E2E_FILES === '1' ? undefined : {
    command: `ISOBAR_ALLOW_TEST_GEO=1 npm run start -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', testIgnore: [...frameTime, /e6b-iphone\.spec\.ts$/], use: chromium },
    { name: 'webkit-phone', testMatch: webkitFiles, dependencies: ['chromium'], workers: 1,
      use: { ...devices['iPhone 13'], browserName: 'webkit', baseURL: webkitURL,
        storageState: { cookies: [{ name: 'isobar-test', value: '1', domain: 'localhost', path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' }], origins: [] } } },
    { name: 'frame-time', testMatch: frameTime, dependencies: ['chromium'], workers: 1, retries: 1, use: chromium },
    {
      name: 'canvas-lakes',
      testMatch: /lakes\.spec\.ts$/,
      use: {
        ...chromium,
        launchOptions: {
          ...(chromium.launchOptions ?? {}),
          args: [...(chromium.launchOptions?.args ?? []), '--disable-webgl', '--disable-webgl2'],
        },
      },
    },
  ],
});
