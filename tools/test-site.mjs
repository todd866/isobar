#!/usr/bin/env node
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertViewport } from './viewport-fit.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = fileURLToPath(new URL('../site/', import.meta.url));
const outputDir = process.env.ISOBAR_SITE_QA || join(tmpdir(), 'isobar-site-qa');
mkdirSync(outputDir, {recursive:true});
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const suppliedURL = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6);
const animationFixture = process.env.ISOBAR_ANIMATION_MP4 || '';
const viewports = [{ name: 'laptop', width: 1280, height: 720 }, { name: 'short-laptop', width: 1024, height: 600 }, { name: 'phone', width: 390, height: 844 }, { name: 'landscape-phone', width: 844, height: 390 }];

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }
function startServer() {
  if (suppliedURL) return { url: suppliedURL, close: async () => {} };
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    if (animationFixture && /^\/data\/animation-(pressure|temperature|rain|wind)\.mp4$/.test(path)) {
      const size = statSync(animationFixture).size;
      const range = request.headers.range;
      const match = typeof range === 'string' ? range.match(/^bytes=(\d+)-(\d*)$/) : null;
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
      if (start >= size || end < start) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
      response.writeHead(match ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1, ...(match ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
      createReadStream(animationFixture, { start, end }).pipe(response); return;
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    const target = resolve(root,file);
    if(!target.startsWith(resolve(root)+sep)){response.writeHead(403);response.end();return;}
    try {
      if (target.endsWith('.mp4')) {
        const size = statSync(target).size;
        const range = request.headers.range;
        const match = typeof range === 'string' ? range.match(/^bytes=(\d+)-(\d*)$/) : null;
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (start >= size || end < start) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
        response.writeHead(match ? 206 : 200, {
          'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': end - start + 1,
          ...(match ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
        });
        createReadStream(target, { start, end }).pipe(response);
        return;
      }
      const { readFile } = await import('node:fs/promises');
      const body = await readFile(target);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
      response.writeHead(200, { 'content-type': types[target.slice(target.lastIndexOf('.'))] || 'application/octet-stream' }); response.end(body);
    } catch { response.writeHead(404); response.end('not found'); }
  });
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((done) => server.close(done)) })); });
}

async function waitReady(page) {
  await page.waitForFunction(() => document.querySelector('#map-image')?.classList.contains('ready') || document.querySelector('#retry')?.hidden === false, null, { timeout: 10000 });
  assert(await page.locator('#map-image').evaluate((image) => image.naturalWidth > 0), 'map image did not decode');
}
async function errorsFor(page, action) {
  const errors = []; const consoleErrors = [];
  const onPageError = (error) => errors.push(error.message);
  const onConsole = (message) => {
    if (message.type() !== 'error') return;
    const location = message.location()?.url || '';
    if (location.endsWith('/favicon.ico')) return;
    consoleErrors.push(message.text());
  };
  page.on('pageerror', onPageError); page.on('console', onConsole);
  try { await action(); } finally { page.off('pageerror', onPageError); page.off('console', onConsole); }
  assert(!errors.length, `page errors: ${errors.join('; ')}`); assert(!consoleErrors.length, `console errors: ${consoleErrors.join('; ')}`);
}
async function visibleMap(page) { return page.locator('#map-image').evaluate((image) => image.classList.contains('ready') && image.naturalWidth > 0 && image.getBoundingClientRect().width > 0); }
async function useStaticForecast(page, baseURL) {
  const manifest = await (await fetch(new URL('./data/current.json', baseURL))).json();
  delete manifest.animations; delete manifest.animation;
  await page.route('**/data/current.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
}
async function canvasHasInk(page, kind = 'temperature') { return page.locator('#chart').evaluate((canvas, requestedKind) => { const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data; let ink = 0; for (let i = 0; i < pixels.length; i += 4) { const red = pixels[i], green = pixels[i + 1], blue = pixels[i + 2], alpha = pixels[i + 3]; const matches = requestedKind === 'rain' ? red < 110 && green > 100 && blue > 100 : red > 150 && green < 160 && blue < 100; if (alpha > 0 && matches) ink += 1; } return ink > 20; }, kind); }
async function screenshot(page, name) { await page.screenshot({ path: `${outputDir}/${name}.png` }); }

async function assertMovieURL(source, baseURL, layer) {
  const url = new URL(source, new URL('./data/', baseURL));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-1' }, signal: controller.signal });
    assert(response.ok || response.status === 206, `${layer} movie is unavailable (${response.status} ${url})`);
    const contentType = response.headers.get('content-type') || '';
    assert(contentType.includes('video/mp4'), `${layer} movie returned ${JSON.stringify(contentType)} instead of video/mp4`);
    if (response.body) {
      const reader = response.body.getReader();
      await reader.read();
      await reader.cancel();
    }
  } catch (error) {
    if (error?.name === 'AbortError') fail(`${layer} movie URL probe timed out (${url})`);
    throw error;
  } finally { clearTimeout(timer); }
}

async function decodeMovieMetadata(browser, baseURL, advertised) {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  try {
    const results = {};
    for (const layer of ['pressure', 'temperature', 'rain', 'wind']) {
      const movie = advertised?.[layer];
      assert(movie && typeof movie.src === 'string' && movie.src, `manifest is missing the ${layer} movie`);
      await assertMovieURL(movie.src, baseURL, layer);
      results[layer] = await page.evaluate(async ({ source, name }) => {
        const video = document.createElement('video');
        video.preload = 'auto'; video.muted = true; video.playsInline = true;
        video.src = source; document.body.append(video);
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error(`${name} movie metadata timed out`)), 30000);
          video.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
          video.addEventListener('error', () => { clearTimeout(timeout); reject(new Error(`${name} movie failed to decode`)); }, { once: true });
          video.load();
        });
        const metadata = { duration: video.duration, width: video.videoWidth, height: video.videoHeight, readyState: video.readyState };
        video.remove();
        return metadata;
      }, { source: new URL(movie.src, new URL('./data/', baseURL)).href, name: layer });
      assert(Number.isFinite(results[layer].duration) && results[layer].duration > 1, `${layer} movie has invalid duration`);
      assert(results[layer].width > 0 && results[layer].height > 0, `${layer} movie has no decoded dimensions`);
      assert(results[layer].readyState >= 2, `${layer} movie did not decode a frame`);
      if (process.env.ISOBAR_RELEASE_QA === '1') {
        assert(Math.abs(results[layer].duration - 120) < 1.5, `${layer} movie is ${results[layer].duration.toFixed(2)}s; release requires ~120s`);
        assert(Number(movie.fps) === 60, `${layer} manifest advertises ${movie.fps}fps; release requires 60fps`);
      }
    }
    return results;
  } finally { await page.close(); }
}

async function testAnimation(browser, baseURL) {
  const original = await (await fetch(new URL('./data/current.json', baseURL))).json();
  const advertised = original.animations || (original.animation ? { pressure: original.animation } : null);
  if (!animationFixture && !advertised?.pressure) return;
  const actualMetadata = advertised ? await decodeMovieMetadata(browser, baseURL, advertised) : null;
  if (animationFixture) {
    assert(statSync(animationFixture).size > 0, 'animation fixture is empty');
  } else {
    assert(actualMetadata, 'manifest advertises animation data without decodable movies');
  }
  const fixtureMetadata = animationFixture && existsSync(animationFixture.replace(/\.mp4$/, '.json')) ? JSON.parse(readFileSync(animationFixture.replace(/\.mp4$/, '.json'))) : {};
  const fps = fixtureMetadata.fps || advertised?.pressure?.fps || 30;
  const durationSeconds = fixtureMetadata.durationSeconds || advertised?.pressure?.durationSeconds || 30;
  const actualMovieSources = Object.fromEntries(['pressure', 'temperature', 'rain', 'wind'].map((layer) => [layer, advertised?.[layer]?.src]));
  const animations = Object.fromEntries(['pressure', 'temperature', 'rain', 'wind'].map((layer) => [layer, {
    ...(animationFixture ? {} : advertised[layer]),
    src: `animation-${layer}.mp4`, durationSeconds, fps, validFrom: original.frames[0].time,
    validTo: original.frames.at(-1).time, forecastRun: original.runAt, layer
  }]));
  const fulfillMovie = (route) => {
    if (animationFixture) return route.continue();
    const layer = route.request().url().match(/animation-(pressure|temperature|rain|wind)\.mp4$/)?.[1];
    const source = layer && actualMovieSources[layer];
    assert(source, `no real source for ${layer || 'unknown'} movie alias`);
    return route.continue({ url: new URL(source, new URL('./data/', baseURL)).href });
  };
  const manifestBody = JSON.stringify({ ...original, animations });
  const setupManifest = (page) => page.route('**/data/current.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: manifestBody }));

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    const forecastFrom = Date.parse(original.frames[0].time), forecastTo = Date.parse(original.frames.at(-1).time);
    const forecastMidpoint = forecastFrom + (forecastTo - forecastFrom) / 2;
    await page.addInitScript((fixed) => { Date.now = () => fixed; }, forecastMidpoint);
    const movieRequests = [];
    await setupManifest(page);
    await page.route('**/data/animation-*.mp4', (route) => { movieRequests.push(route.request().url()); return fulfillMovie(route); });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(page);
    await page.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && !document.querySelector('#map-video')?.paused);
    const before = await page.locator('#map-video').evaluate((video) => video.currentTime);
    const ambient = await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, rate: video.playbackRate, duration: video.duration }));
    assert(Math.abs(ambient.rate - Math.max(.25, Math.min(1, ambient.duration / 120))) < .01, `ambient playback rate was ${ambient.rate}, expected duration-scaled slow playback`);
    const nowFraction = await page.evaluate(({ from, to }) => Math.max(0, Math.min(1, (Date.now() - from) / (to - from))), { from: forecastFrom, to: forecastTo });
    assert(Math.abs(before / (ambient.duration - 1 / fps) - nowFraction) < .12, 'ambient playback did not start at the current forecast time');
    const sliderBefore = Number(await page.locator('#time').inputValue());
    await page.waitForTimeout(500);
    const after = await page.locator('#map-video').evaluate((video) => video.currentTime);
    const labelAfter = await page.locator('#time-label').textContent();
    const sliderAfter = Number(await page.locator('#time').inputValue());
    assert(after > before + .05, 'animation did not advance');
    assert(sliderAfter > sliderBefore, 'timeline slider did not advance with movie');
    assert(labelAfter, 'forecast time label was not rendered');
    await screenshot(page, 'actual-playing');

    await page.click('#play-toggle');
    const paused = await page.locator('#map-video').evaluate((video) => video.currentTime);
    await page.waitForTimeout(250);
    assert(Math.abs((await page.locator('#map-video').evaluate((video) => video.currentTime)) - paused) < .05, 'pause did not freeze the movie');
    await page.click('#play-toggle'); await page.waitForTimeout(250);
    assert(await page.locator('#map-video').evaluate((video, start) => video.currentTime > start + .05, paused), 'resume reset or failed to advance the movie');
    await page.click('#play-toggle');

    await page.locator('#time').evaluate((input) => { input.value = '2.37'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(({ from, to, fps }) => {
      const video = document.querySelector('#map-video');
      const input = document.querySelector('#time');
      if (!video || !input || !Number.isFinite(video.duration) || video.readyState < 2) return false;
      const rawDate = from + Number(input.value) / Number(input.max) * (to - from);
      const snappedDate = Math.max(from, Math.min(to, Math.round(rawDate / 3600000) * 3600000));
      const expected = (snappedDate - from) / (to - from) * (video.duration - 1 / fps);
      return Math.abs(video.currentTime - expected) < .5;
    }, { from: forecastFrom, to: forecastTo, fps }, { timeout: 3000 }).catch(async () => { throw new Error(`fractional scrub did not seek to the requested forecast hour: ${JSON.stringify(await page.evaluate(() => ({ current: document.querySelector('#map-video')?.currentTime, value: document.querySelector('#time')?.value, step: document.querySelector('#time')?.step, ready: document.querySelector('#map-video')?.readyState })))}`); });
    const seek = await page.locator('#map-video').evaluate((video, { expectedFraction, fps, from, to }) => {
      const rawDate = from + expectedFraction * (to - from);
      const snappedDate = Math.max(from, Math.min(to, Math.round(rawDate / 3600000) * 3600000));
      return {
      current: video.currentTime, duration: video.duration - 1/fps, expected: (snappedDate - from) / (to - from) * (video.duration - 1/fps),
      snappedDate,
      label: document.querySelector('#time-label')?.textContent || ''
      };
    }, { expectedFraction: 2.37 / Number(await page.locator('#time').getAttribute('max')), fps, from: Date.parse(original.frames[0].time), to: Date.parse(original.frames.at(-1).time) });
    assert(Math.abs(seek.current - seek.expected) < .1, `fractional scrub mapped to ${seek.current.toFixed(3)}s, expected ${seek.expected.toFixed(3)}s`);
    assert(seek.snappedDate % 3600000 === 0, 'slider selection did not snap to a whole forecast hour');
    const expectedLabel = await page.evaluate(({ snappedDate }) => new Intl.DateTimeFormat(undefined, {
      weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Perth'
    }).format(new Date(snappedDate)), { snappedDate: seek.snappedDate });
    assert(seek.label === expectedLabel, `forecast label ${JSON.stringify(seek.label)} does not match ${JSON.stringify(expectedLabel)}`);
    let preservedTime = seek.current;
    await page.waitForTimeout(250);
    assert(Math.abs((await page.locator('#map-video').evaluate((video) => video.currentTime)) - preservedTime) < .05, 'slider selection did not hold the chosen hour');

    const timelineHour = async (key, delta, label) => {
      const before = await page.locator('#time').evaluate((input, { from, to }) => {
        const maximum = Math.max(1, Number(input.max));
        const raw = from + Number(input.value) / maximum * (to - from);
        return Math.round(raw / 3600000);
      }, { from: forecastFrom, to: forecastTo });
      await page.locator('#time').press(key);
      await page.waitForFunction(({ from, to, before, delta, fps }) => {
        const input = document.querySelector('#time');
        const video = document.querySelector('#map-video');
        if (!input || !video || !Number.isFinite(video.duration) || video.readyState < 2) return false;
        const maximum = Math.max(1, Number(input.max));
        const raw = from + Number(input.value) / maximum * (to - from);
        const expectedDate = (before + delta) * 3600000;
        const movieSpan = Math.max(.001, video.duration - 1 / fps);
        const actualDate = from + video.currentTime / movieSpan * (to - from);
        return Math.round(raw / 3600000) === before + delta && Math.abs(actualDate - expectedDate) < 120000 && video.paused;
      }, { from: forecastFrom, to: forecastTo, before, delta, fps }, { timeout: 3000 }).catch(async () => {
        throw new Error(`${label} did not advance one forecast hour while remaining paused: ${JSON.stringify(await page.locator('#time').evaluate((input) => ({ value: input.value, max: input.max })))} ${JSON.stringify(await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, duration: video.duration, paused: video.paused })) )}`);
      });
      const after = await page.locator('#time').evaluate((input, { from, to }) => {
        const maximum = Math.max(1, Number(input.max));
        const raw = from + Number(input.value) / maximum * (to - from);
        return Math.round(raw / 3600000);
      }, { from: forecastFrom, to: forecastTo });
      assert(after - before === delta, `${label} moved from forecast hour ${before} to ${after}`);
      assert(await page.locator('#map-video').evaluate((video) => video.paused), `${label} resumed playback`);
    };
    await timelineHour('ArrowRight', 1, 'ArrowRight');
    await timelineHour('ArrowUp', 1, 'ArrowUp');
    await timelineHour('ArrowLeft', -1, 'ArrowLeft');
    await timelineHour('ArrowDown', -1, 'ArrowDown');

    const rapidBefore = await page.locator('#time').evaluate((input, { from, to }) => {
      const maximum = Math.max(1, Number(input.max));
      return Math.round((from + Number(input.value) / maximum * (to - from)) / 3600000);
    }, { from: forecastFrom, to: forecastTo });
    await page.locator('#time').press('ArrowRight');
    await page.locator('#time').press('ArrowRight');
    await page.locator('#time').press('ArrowRight');
    await page.waitForFunction(({ from, to, expectedHour, fps }) => {
      const input = document.querySelector('#time');
      const video = document.querySelector('#map-video');
      if (!input || !video || !Number.isFinite(video.duration) || video.readyState < 2) return false;
      const maximum = Math.max(1, Number(input.max));
      const raw = from + Number(input.value) / maximum * (to - from);
      const movieSpan = Math.max(.001, video.duration - 1 / fps);
      const actualDate = from + video.currentTime / movieSpan * (to - from);
      return Math.round(raw / 3600000) === expectedHour && Math.abs(actualDate - expectedHour * 3600000) < 120000 && video.paused;
    }, { from: forecastFrom, to: forecastTo, expectedHour: rapidBefore + 3, fps }, { timeout: 3000 }).catch(async () => {
      throw new Error(`rapid ArrowRight presses did not accumulate three forecast hours: ${JSON.stringify(await page.locator('#time').evaluate((input) => ({ value: input.value, max: input.max })))} ${JSON.stringify(await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, duration: video.duration, paused: video.paused })) )}`);
    });

    await page.locator('#time').fill('0');
    await page.waitForFunction(() => {
      const input = document.querySelector('#time');
      const video = document.querySelector('#map-video');
      return input && video && Number(input.value) === 0 && video.currentTime < .02 && video.paused;
    });
    await page.locator('#time').press('ArrowLeft');
    await page.waitForFunction(() => {
      const input = document.querySelector('#time');
      const video = document.querySelector('#map-video');
      return input && video && Number(input.value) <= .0001 && video.currentTime < .02 && video.paused;
    });
    assert(await page.locator('#time').evaluate((input) => Number(input.value) === 0), 'ArrowLeft moved before the first forecast hour');
    assert(await page.locator('#map-video').evaluate((video) => video.paused), 'ArrowLeft at the first frame resumed playback');

    await page.locator('#map-frame').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && !document.querySelector('#map-video')?.paused);
    const reset = await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, rate: video.playbackRate, duration: video.duration }));
    assert(Math.abs(reset.rate - Math.max(.25, Math.min(1, reset.duration / 120))) < .01, 'map reset did not resume ambient rate');
    assert(Math.abs(reset.current / (reset.duration - 1 / fps) - nowFraction) < .12, 'map reset did not return to current forecast time');
    await page.click('#play-toggle');
    preservedTime = await page.locator('#map-video').evaluate((video) => video.currentTime);

    // Sample when playback starts, before the browser test's own round trips
    // can advance the movie. Compare each switch with the last paused frame.
    const nextPlaybackStart = async () => {
      await page.evaluate(() => {
        window.__isobarPlaybackStart = null;
        document.addEventListener('play', (event) => {
          if (event.target instanceof HTMLVideoElement) window.__isobarPlaybackStart = event.target.currentTime;
        }, { capture: true, once: true });
      });
    };
    const playbackStart = async () => {
      await page.waitForFunction(() => Number.isFinite(window.__isobarPlaybackStart));
      return page.evaluate(() => window.__isobarPlaybackStart);
    };

    await page.click('#layers-button'); await page.locator('[name="map-overlay"][value="wind"]').check();
    await nextPlaybackStart();
    await page.click('#play-toggle'); await page.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && document.querySelector('#map-video')?.dataset.source?.endsWith('animation-wind.mp4'));
    const windTime = await playbackStart();
    assert(Math.abs(windTime - preservedTime) < .3, `layer switch lost forecast position (${windTime} vs ${preservedTime})`);
    await page.click('#play-toggle');
    preservedTime = await page.locator('#map-video').evaluate((video) => video.currentTime);
    const pressureRequests = movieRequests.filter((url) => url.endsWith('animation-pressure.mp4')).length;
    await page.click('#layers-button'); await page.locator('[name="map-overlay"][value="none"]').check();
    await page.route('**/*', (route) => route.abort());
    await nextPlaybackStart();
    await page.click('#play-toggle'); await page.waitForFunction(() => document.querySelector('#map-video')?.dataset.source?.endsWith('animation-pressure.mp4'));
    const returnedTime = await playbackStart();
    assert(Math.abs(returnedTime - preservedTime) < .3, `returning to pressure lost forecast position (${returnedTime} vs ${preservedTime})`);
    assert(movieRequests.filter((url) => url.endsWith('animation-pressure.mp4')).length === pressureRequests, 'returning to a prepared layer fetched the movie again');
    assert(await page.locator('#play-toggle').isEnabled(), 'keyed movie was not prepared');
    await page.click('#play-toggle');
    await page.locator('#time').evaluate((input) => { input.value = input.max; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(() => document.querySelector('#map-video').currentTime > document.querySelector('#map-video').duration - .1);
    const finalFraction = await page.locator('#time').evaluate(input => Number(input.value) / Number(input.max));
    assert(finalFraction > .9999, 'last-frame seek did not reach the end of the forecast');
    const finalMovieTime = await page.locator('#map-video').evaluate(video => video.currentTime);
    assert(Math.abs(finalMovieTime - (seek.duration)) < .02, 'last-frame seek missed the encoded endpoint');
    await page.locator('#time').press('ArrowRight');
    await page.waitForFunction(() => {
      const input = document.querySelector('#time');
      const video = document.querySelector('#map-video');
      return input && video && Number(input.value) >= Number(input.max) - .0001 && video.paused;
    });
    assert(await page.locator('#time').evaluate((input) => Number(input.value) / Number(input.max) > .9999), 'ArrowRight moved past the final forecast hour');
    assert(await page.locator('#map-video').evaluate((video) => video.paused), 'ArrowRight at the final frame resumed playback');
    await page.click('#play-toggle');
    await page.waitForFunction(() => document.querySelector('#map-video').currentTime < 1 && document.querySelector('#play-toggle').textContent === 'Pause');
    assert(await page.locator('#play-toggle').textContent() === 'Pause', 'Play at the end did not restart the movie');
  } finally { await page.close(); }

  const retryPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    let attempts = 0;
    await setupManifest(retryPage);
    await retryPage.route('**/data/animation-*.mp4', (route) => { attempts += 1; return attempts === 1 ? route.abort() : fulfillMovie(route); });
    await retryPage.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(retryPage);
    await retryPage.click('#play-toggle'); await retryPage.waitForTimeout(300);
    assert(await retryPage.locator('#play-toggle').isEnabled(), 'failed movie permanently disabled retry');
    await retryPage.click('#play-toggle'); await retryPage.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2, null, { timeout: 3000 });
    assert(attempts >= 2, 'movie retry did not issue a second request');
  } finally { await retryPage.close(); }

  const reducedPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await reducedPage.emulateMedia({ reducedMotion: 'reduce' });
    await setupManifest(reducedPage);
    let reducedMovieRequests = 0;
    await reducedPage.route('**/data/animation-*.mp4', (route) => { reducedMovieRequests += 1; return fulfillMovie(route); });
    await reducedPage.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(reducedPage); await reducedPage.waitForTimeout(300);
    assert(await reducedPage.locator('#play-toggle').textContent() === 'Play', 'reduced-motion mode started playing automatically');
    assert(reducedMovieRequests === 0, 'reduced-motion mode fetched an animation before explicit Play');
  } finally { await reducedPage.close(); }

  const resetRacePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await setupManifest(resetRacePage);
    await resetRacePage.route('**/data/animation-pressure.mp4', async (route) => { await new Promise((resolve) => setTimeout(resolve, 600)); await fulfillMovie(route); });
    await resetRacePage.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(resetRacePage);
    await resetRacePage.locator('#map-frame').focus(); await resetRacePage.keyboard.press('Enter');
    const raceSliderValue = 4.2;
    await resetRacePage.locator('#time').fill(String(raceSliderValue));
    await resetRacePage.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && document.querySelector('#play-toggle')?.textContent === 'Play', null, { timeout: 5000 });
    const raceState = await resetRacePage.locator('#map-video').evaluate((video) => ({ current: video.currentTime, duration: video.duration, rate: video.playbackRate }));
    const raceRaw = Date.parse(original.frames[0].time) + raceSliderValue / Number(await resetRacePage.locator('#time').getAttribute('max')) * (Date.parse(original.frames.at(-1).time) - Date.parse(original.frames[0].time));
    const raceSnapped = Math.max(Date.parse(original.frames[0].time), Math.min(Date.parse(original.frames.at(-1).time), Math.round(raceRaw / 3600000) * 3600000));
    assert(Math.abs(raceState.current - (raceSnapped - Date.parse(original.frames[0].time)) / (Date.parse(original.frames.at(-1).time) - Date.parse(original.frames[0].time)) * (raceState.duration - 1 / fps)) < .2, 'stale reset completion replaced the latest slider selection');
    assert(Math.abs(raceState.rate - Math.max(.25, Math.min(1, raceState.duration / 120))) < .01, 'slider race left the animation at an inconsistent playback rate');
    await resetRacePage.click('#play-toggle'); await resetRacePage.waitForFunction(() => document.querySelector('#play-toggle')?.textContent === 'Pause', null, { timeout: 5000 });
    assert(await resetRacePage.locator('#play-toggle').textContent() === 'Pause', `Play remained blocked after the delayed reset and slider race (${JSON.stringify(await resetRacePage.evaluate(() => ({ button: document.querySelector('#play-toggle')?.textContent, paused: document.querySelector('#map-video')?.paused, ready: document.querySelector('#map-video')?.readyState, source: document.querySelector('#map-video')?.dataset.source })))} )`);
  } finally { await resetRacePage.close(); }

  const racePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await setupManifest(racePage);
    await racePage.route('**/data/animation-*.mp4', async (route) => {
      if (route.request().url().endsWith('animation-pressure.mp4')) await new Promise((resolve) => setTimeout(resolve, 600));
      await fulfillMovie(route);
    });
    await racePage.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(racePage);
    await racePage.click('#play-toggle');
    await racePage.click('#layers-button'); await racePage.locator('[name="map-overlay"][value="wind"]').check(); await racePage.click('#play-toggle');
    await racePage.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && document.querySelector('#map-video')?.dataset.source?.endsWith('animation-wind.mp4'), null, { timeout: 3000 });
    await racePage.waitForTimeout(800);
    assert(await racePage.locator('#map-video').getAttribute('data-source').then((src) => src.endsWith('animation-wind.mp4')), 'stale pressure metadata replaced the selected wind movie');
  } finally { await racePage.close(); }
}

async function testViewport(browser, baseURL, viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  try {
    await errorsFor(page, async () => { await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(page); });
    const report = await assertViewport(page, { primary: [{ selector: '#map-frame', label: 'map', minWidth: 260, minHeight: 90 }], controls: [{ selector: '#time', minWidth: 100, minHeight: 18 }, { selector: '#layers-button', minWidth: 44, minHeight: 28 }], screenshotPath: `${outputDir}/${viewport.name}-closed.png` });
    assert(!report.failures?.length, `${viewport.name}: viewport failures`);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${viewport.name}: horizontal overflow`);
    await page.click('[data-layer="temperature"]'); await page.waitForTimeout(100); assert(await page.locator('#detail-panel').isVisible(), `${viewport.name}: detail panel did not open`); assert(await canvasHasInk(page), `${viewport.name}: detail chart is empty`); await assertViewport(page,{primary:[{selector:'#map-frame',minHeight:90,minWidth:260},{selector:'#detail-panel',minHeight:100}],controls:[{selector:'#time',minHeight:18}],screenshotPath:`${outputDir}/${viewport.name}-temperature.png`}); await page.click('[data-layer="temperature"]'); assert(await page.locator('#detail-panel').isHidden(), `${viewport.name}: detail panel did not close`);
    await page.click('#layers-button'); assert(await page.locator('#layers-menu').isVisible(), `${viewport.name}: layers menu did not open`); await page.keyboard.press('Escape'); assert(await page.locator('#layers-menu').isHidden(), `${viewport.name}: Escape did not close layers`); assert(await page.locator('#layers-button').evaluate((button) => document.activeElement === button), `${viewport.name}: focus did not return to layers button`);
    await screenshot(page, `${viewport.name}-final`);
    return report;
  } finally { await page.close(); }
}

async function testDownload(browser, baseURL) {
  const release = { url: 'https://github.com/todd866/isobar/releases/download/v1.8.1/Isobar-1.8.1-macOS-arm64.dmg', label: 'Apple silicon (M1 or newer) · macOS 15+' };
  for (const viewport of [...viewports, { name: 'phone-large-text', width: 390, height: 844, largeText: true }]) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
    try {
      await page.route('**/data/current.json', route => route.fulfill({ status: 503, body: 'offline' }));
      await page.route('**/release.json', async route => {
        await new Promise(resolve => setTimeout(resolve, 150));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(release) });
      });
      await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
      if (viewport.largeText) await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await page.click('#download-link');
      await page.waitForFunction(() => !document.querySelector('#dialog-download').hidden);
      assert(await page.locator('#dialog-download').getAttribute('href') === release.url, 'download must work while forecast is unavailable');
      assert((await page.locator('#download-copy').textContent()).includes('M1'), 'supported Macs must be clear');
      assert(await page.locator('#install-steps li').count() === 3, 'installation needs three visible steps');
      if (!viewport.largeText && viewport.height > 400) {
        await assertViewport(page, { primary: [{ selector: '#download', minWidth: 260, minHeight: 220 }], controls: [{ selector: '#dialog-download', minHeight: 36 }, { selector: '.dialog-close', minHeight: 44 }], screenshotPath: `${outputDir}/download-${viewport.name}.png` });
      } else {
        // The small landscape/text-enlarged dialog deliberately scrolls.
        assert(await page.locator('#download').evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height <= innerHeight), 'download dialog must fit horizontally and scroll vertically');
        await page.locator('#dialog-download').scrollIntoViewIfNeeded();
        assert(await page.locator('#dialog-download').isVisible(), 'download stays reachable with large text');
        await screenshot(page, `download-${viewport.name}`);
      }
      await page.keyboard.press('Escape');
      assert(!await page.locator('#download').evaluate(el => el.open), 'Escape closes download');
      assert(await page.locator('#download-link').evaluate(el => el === document.activeElement), 'download focus returns to opener');
    } finally { await page.close(); }
  }
  for (const releaseState of [{ status: 'preparing' }, { url: 'javascript:alert(1)', label: 'Download' }]) {
    const page = await browser.newPage();
    try {
      await page.route('**/data/current.json', route => route.fulfill({ status: 503, body: 'offline' }));
      await page.route('**/release.json', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(releaseState) }));
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      await page.click('#download-link');
      assert(await page.locator('#dialog-download').isHidden(), 'unpublished or invalid release must not advertise a download');
      assert(await page.locator('#install-steps').isHidden(), 'preparing state must not show installation steps');
    } finally { await page.close(); }
  }
  // Old weather snapshots must not resurrect a withdrawn download, regardless
  // of which request completes first. A missing release pointer may fall back.
  for (const scenario of [
    { status: 200, delay: 250, weatherDelay: 0, shown: false },
    { status: 200, delay: 0, weatherDelay: 250, shown: false },
    { status: 200, delay: 0, weatherDelay: 0, body: '{', shown: false },
    { status: 404, delay: 0, weatherDelay: 0, shown: true },
  ]) {
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    try {
      const manifest = { frames: [{ time: '2026-09-28T00:00:00Z', maps: { pressure: 'download-test.svg' } }], release };
      await page.route('**/data/current.json', async route => {
        await new Promise(resolve => setTimeout(resolve, scenario.weatherDelay));
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
      });
      await page.route('**/data/download-test.svg', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="skyblue"/></svg>' }));
      await page.route('**/release.json', async route => {
        await new Promise(resolve => setTimeout(resolve, scenario.delay));
        await route.fulfill({ status: scenario.status, contentType: 'application/json', body: scenario.body ?? '{"status":"preparing"}' });
      });
      await page.goto(baseURL, { waitUntil: 'networkidle' });
      await page.click('#download-link');
      assert(await page.locator('#dialog-download').isVisible() === scenario.shown, 'standalone release state takes precedence over old forecast metadata');
    } finally { await page.close(); }
  }
}

async function run() {
  const errors=[];
  const server = await startServer(); let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome)?{executablePath:chrome}:{}) });
    browser.on('page', page=>page.on('pageerror', error=>errors.push(error.message)));
    await testDownload(browser, server.url);
    if (process.argv.includes('--download-only')) {
      assert(!errors.length, `download page errors: ${errors.join('; ')}`);
      console.log('download harness passed: laptop/phone, large text, delayed release, unavailable forecast, preparing state and focus');
      return;
    }
    for (const viewport of viewports) await testViewport(browser, server.url, viewport);
    await testAnimation(browser, server.url);
    const largePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await largePage.emulateMedia({ reducedMotion: 'reduce' });
      await largePage.goto(server.url, { waitUntil: 'domcontentloaded' }); await waitReady(largePage);
      await largePage.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await assertViewport(largePage, { documentY: 'allow', primary: [{ selector: '#map-frame', label: 'map', minWidth: 260, minHeight: 90 }], controls: [{ selector: '#layers-button', minWidth: 44, minHeight: 28 }], screenshotPath: `${outputDir}/phone-200-percent.png` });
      assert(await largePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '200% text caused horizontal overflow');
      await largePage.locator('.detail-tabs').scrollIntoViewIfNeeded(); await assertViewport(largePage,{documentY:'allow',primary:[{selector:'.detail-tabs',minHeight:30}],screenshotPath:`${outputDir}/phone-200-percent-controls.png`});
      assert(await largePage.evaluate(()=>document.querySelector('.sources').getBoundingClientRect().top >= document.querySelector('.detail-tabs').getBoundingClientRect().bottom),'footer overlaps enlarged controls');
    } finally { await largePage.close(); }
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await useStaticForecast(page, server.url);
      const requests = []; page.on('request', (request) => { if (request.url().includes('.png')) requests.push(request.url()); });
      await page.goto(server.url, { waitUntil: 'domcontentloaded' }); await waitReady(page);
      await page.waitForLoadState('networkidle'); // This case has only the bounded PNG set.
      const before = requests.length;
      await page.locator('#time').fill('1'); await page.waitForTimeout(250); assert(await visibleMap(page), 'prepared timeline navigation lost the map');
      assert(requests.length <= before + 1, 'timeline navigation exceeded prepared request bound');
      await page.route('**/*', (route) => route.abort()); await page.locator('#time').fill('0'); await page.waitForTimeout(200); assert(await visibleMap(page), 'offline prepared navigation failed'); await page.unroute('**/*');
    } finally { await page.close(); }
    const retryPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await retryPage.emulateMedia({ reducedMotion: 'reduce' });
      await useStaticForecast(retryPage, server.url);
      let failed = false; await retryPage.route('**/*-pressure.png', (route) => { if (!failed) { failed = true; return route.abort(); } return route.continue(); }); await retryPage.goto(server.url, { waitUntil: 'domcontentloaded' }); await retryPage.waitForSelector('#retry:not([hidden])'); await retryPage.click('#retry'); await waitReady(retryPage); assert(await visibleMap(retryPage), 'retry did not recover a failed map');
    } finally { await retryPage.close(); }
    const racePage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await racePage.emulateMedia({ reducedMotion: 'reduce' });
      await useStaticForecast(racePage, server.url);
      const raceManifest = await (await fetch(new URL('./data/current.json', server.url))).json();
      const rainIndex = raceManifest.frames.findIndex((frame) => typeof frame.maps?.rain === 'string');
      assert(rainIndex >= 0, 'race fixture has no frame with a rain map');
      await racePage.goto(server.url, { waitUntil: 'domcontentloaded' }); await waitReady(racePage); await racePage.locator('#time').fill(String(rainIndex)); await racePage.waitForFunction(() => document.querySelector('#map-image')?.src.endsWith('-pressure.png')); await racePage.click('#layers-button'); await racePage.route('**/*-temperature.png', async (route) => { await new Promise((resolve) => setTimeout(resolve, 300)); await route.continue(); }); await racePage.route('**/*-rain.png', (route) => route.continue());
      await racePage.waitForFunction(() => document.querySelector('#map-image')?.src.endsWith('-pressure.png'));
      await racePage.locator('[name="map-overlay"][value="temperature"]').check(); await racePage.locator('[name="map-overlay"][value="rain"]').check(); await racePage.waitForTimeout(500); assert((await racePage.locator('#map-title').textContent()).startsWith('Rain ·'), 'rapid overlay selection lost the last choice'); await racePage.waitForFunction(()=>document.querySelector('#map-image').src.endsWith('-rain.png')); await racePage.waitForTimeout(400); assert((await racePage.locator('#map-image').getAttribute('src')).endsWith('-rain.png'),'old layer replaced the latest choice');
    } finally { await racePage.close(); }
    const missingRainPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await missingRainPage.emulateMedia({ reducedMotion: 'reduce' });
      const manifestResponse = await fetch(new URL('./data/current.json', server.url));
      const manifest = await manifestResponse.json();
      delete manifest.animations; delete manifest.animation;
      const missingRainIndex = manifest.frames.findIndex((frame) => typeof frame.maps?.rain === 'string');
      assert(missingRainIndex >= 0, 'missing-rain fixture has no available rain frame to preserve');
      const noRainIndex = manifest.frames.findIndex((frame) => typeof frame.maps?.rain !== 'string');
      if (noRainIndex < 0) {
        manifest.frames[0].maps = { ...manifest.frames[0].maps };
        delete manifest.frames[0].maps.rain;
      }
      const missingIndex = noRainIndex >= 0 ? noRainIndex : 0;
      const availableRainIndex = noRainIndex >= 0 ? missingRainIndex : manifest.frames.findIndex((frame, index) => index !== missingIndex && typeof frame.maps?.rain === 'string');
      assert(availableRainIndex >= 0, 'missing-rain fixture has no second frame with a rain map');
      await missingRainPage.route('**/data/current.json', (route) => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(manifest)
      }));
      await missingRainPage.goto(server.url, { waitUntil: 'domcontentloaded' });
      await waitReady(missingRainPage);
      await missingRainPage.locator('#time').fill(String(missingIndex));
      await missingRainPage.click('[data-layer="rain"]');
      await missingRainPage.waitForFunction(() => document.querySelector('#map-note')?.textContent === '24h rain unavailable');
      assert(await missingRainPage.locator('#detail-panel').isVisible(), 'missing-rain detail chart did not open');
      assert(await canvasHasInk(missingRainPage, 'rain'), 'missing-rain detail chart is empty');
      assert((await missingRainPage.locator('#map-title').textContent()).startsWith('Pressure ·'), 'missing-rain map did not fall back to pressure');
      assert(await missingRainPage.locator('#map-image').getAttribute('src').then((src) => src.endsWith('-pressure.png')), 'missing-rain fallback is not the pressure asset');
      assert(await missingRainPage.getByText('24h rain unavailable').isVisible(), 'missing-rain status is not visible');
      assert(await missingRainPage.locator('#retry').isHidden(), 'missing-rain state incorrectly offers retry');
      await missingRainPage.locator('#time').fill(String(availableRainIndex));
      await missingRainPage.waitForFunction(() => document.querySelector('#map-image')?.src.endsWith('-rain.png'));
      assert((await missingRainPage.locator('#map-title').textContent()).startsWith('Rain ·'), 'available rain frame did not restore rain map');
    } finally { await missingRainPage.close(); }
    assert(!errors.length, `Runtime errors: ${errors.join('; ')}`);
    console.log(`site harness passed: ${viewports.length} viewports, interactions, retry, offline navigation, and overlay race`);
  } finally { if (browser) await browser.close(); await server.close(); }
}
run().catch((error) => { console.error(`site harness failed: ${error.stack || error}`); process.exitCode = 1; });
