#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { assertViewport } from './viewport-fit.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const root = fileURLToPath(new URL('../site/', import.meta.url));
let siteRoot = root;
const outputDir = process.env.ISOBAR_SITE_QA || join(tmpdir(), 'isobar-site-qa');
mkdirSync(outputDir, {recursive:true});
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const suppliedURL = process.argv.find((arg) => arg.startsWith('--url='))?.slice(6);
const animationFixture = process.env.ISOBAR_ANIMATION_MP4 || '';
const viewports = [{ name: 'laptop', width: 1280, height: 720 }, { name: 'short-laptop', width: 1024, height: 600 }, { name: 'phone', width: 390, height: 844 }, { name: 'landscape-phone', width: 844, height: 390 }];
const FIXTURE_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function fail(message) { throw new Error(message); }
function hourSeriesOf(manifest) {
  const places = manifest?.places || [];
  return (places.find((place) => place.name === 'Perth') || places[0])?.hours || manifest?.points?.hours || [];
}
function sliderValueFor(isoTime, hours) {
  const from = Date.parse(hours[0].time);
  const to = Date.parse(hours[hours.length - 1].time);
  const max = Math.max(1, hours.length - 1);
  return (Date.parse(isoTime) - from) / Math.max(1, to - from) * max;
}
function degreeText(value) {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}°`;
}
function buildFixtureSite() {
  const dir = join(tmpdir(), `isobar-site-fixture-${process.pid}`);
  const data = join(dir, 'data');
  const framesDir = join(data, 'frames-test');
  mkdirSync(framesDir, { recursive: true });
  for (const name of ['index.html', 'style.css', 'app.js', 'sw.js', 'release.json']) {
    if (existsSync(join(root, name))) copyFileSync(join(root, name), join(dir, name));
  }
  const movie = join(framesDir, 'pressure.mp4');
  const encoded = spawnSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x8eb4c8:s=640x360:r=24:d=24', '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-g', '24', '-movflags', '+faststart', movie], { stdio: 'ignore' });
  if (encoded.status !== 0) fail('ffmpeg could not build the fixture pressure movie');
  for (const layer of ['temperature', 'rain', 'wind']) copyFileSync(movie, join(framesDir, `${layer}.mp4`));
  const start = Date.parse('2026-10-01T00:00:00Z');
  const frames = [];
  for (let index = 0; index < 9; index += 1) {
    const time = new Date(start + index * 12 * 3600000).toISOString();
    for (const layer of ['pressure', 'temperature', 'wind']) writeFileSync(join(framesDir, `${index}-${layer}.png`), FIXTURE_PNG);
    const maps = { pressure: `frames-test/${index}-pressure.png`, temperature: `frames-test/${index}-temperature.png`, wind: `frames-test/${index}-wind.png` };
    if (index !== 0) {
      writeFileSync(join(framesDir, `${index}-rain.png`), FIXTURE_PNG);
      maps.rain = `frames-test/${index}-rain.png`;
    }
    frames.push({ time, maps });
  }
  const dates = Array.from({ length: 7 }, (_, day) => new Date(start + day * 86400000).toISOString().slice(0, 10));
  const sydneyMax = [28.9, 24.5, 22.4, 22.5, 21.8, 25.4, 17.1];
  const sydneyMin = [13.5, 17.4, 15.7, 13.4, 13.9, 16.2, 13.0];
  const sydneyRain = [0, 5.6, 10.3, 0.2, 0, 0, 3.0];
  const sydneyCode = [3, 80, 95, 51, 3, 3, 51];
  const places = [
    ['cottesloe', 'Perth', 'Australia/Perth', true],
    ['yssy', 'Sydney', 'Australia/Sydney', false],
    ['safety-bay', 'Safety Bay', 'Australia/Perth', true],
    ['rottnest', 'Rottnest', 'Australia/Perth', false],
    ['perth-airport', 'Perth Airport', 'Australia/Perth', false],
    ['garden-island', 'Garden Island', 'Australia/Perth', false],
  ].map(([id, name, timezone, waves], placeIndex) => ({
    id, name, timezone, latitude: id === 'yssy' ? -33.946 : -31.995, longitude: id === 'yssy' ? 151.177 : 115.752,
    hours: Array.from({ length: 168 }, (_, hour) => ({
      time: new Date(start + hour * 3600000).toISOString(),
      temp: (id === 'yssy' ? 22 : 18) + Math.sin(hour / 9) * 4,
      rain: hour % 19 === 0 ? 1.4 : 0,
      windKt: 8 + (hour % 6),
      gustKt: 14 + (hour % 6),
      windFrom: 210,
      waveHeight: waves ? 1.3 : null,
      swellPeriod: waves ? 11 : null,
      swellFrom: waves ? 230 : null,
      weatherCode: sydneyCode[hour % 7],
    })),
    daily: dates.map((time, day) => ({
      time,
      tempMax: id === 'yssy' ? sydneyMax[day] : 24.2 - placeIndex + day * .3,
      tempMin: id === 'yssy' ? sydneyMin[day] : 12 + day * .2,
      rain: id === 'yssy' ? sydneyRain[day] : day === 2 ? 1.1 : 0,
      weatherCode: id === 'yssy' ? sydneyCode[day] : 3,
      windMax: 16,
      gustMax: 22,
      windFrom: 200,
    })),
  }));
  const animation = (layer) => ({ src: `frames-test/${layer}.mp4`, layer, durationSeconds: 24, fps: 24, validFrom: frames[0].time, validTo: frames.at(-1).time, forecastRun: frames[0].time });
  const manifest = {
    schemaVersion: 2,
    updatedAt: frames[0].time,
    runAt: frames[0].time,
    source: 'ECMWF',
    frames,
    places,
    points: { place: 'Perth', id: 'cottesloe', timezone: 'Australia/Perth', hours: places[0].hours, daily: places[0].daily },
    animations: Object.fromEntries(['pressure', 'temperature', 'rain', 'wind'].map((layer) => [layer, animation(layer)])),
    units: { temp: '°C', rain: 'mm / preceding hour', windKt: 'kt' },
    attribution: [{ label: 'ECMWF · CC BY 4.0', url: 'https://www.ecmwf.int/en/forecasts/datasets/open-data' }],
  };
  writeFileSync(join(data, 'current.json'), JSON.stringify(manifest));
  return dir;
}
function argumentValue(name) {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} needs a value`);
  return value;
}
async function prepareSite() {
  const requested = argumentValue('--site');
  if (requested) {
    siteRoot = resolve(requested);
    if (!existsSync(join(siteRoot, 'data/current.json'))) fail(`--site has no data/current.json (${siteRoot})`);
    return;
  }
  if (process.env.ISOBAR_SITE_ROOT) { siteRoot = process.env.ISOBAR_SITE_ROOT; return; }
  if (existsSync(join(root, 'data/current.json')) && process.env.ISOBAR_SITE_FIXTURE !== '1') return;
  siteRoot = buildFixtureSite();
}
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
      response.writeHead(match ? 206 : 200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000', 'content-length': end - start + 1, ...(match ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
      createReadStream(animationFixture, { start, end }).pipe(response); return;
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    const target = resolve(siteRoot, file);
    if(!target.startsWith(resolve(siteRoot)+sep)){response.writeHead(403);response.end();return;}
    try {
      if (target.endsWith('.mp4')) {
        const size = statSync(target).size;
        const range = request.headers.range;
        const match = typeof range === 'string' ? range.match(/^bytes=(\d+)-(\d*)$/) : null;
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
        if (start >= size || end < start) { response.writeHead(416, { 'Content-Range': `bytes */${size}` }); response.end(); return; }
        response.writeHead(match ? 206 : 200, {
          'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000', 'content-length': end - start + 1,
          ...(match ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
        });
        createReadStream(target, { start, end }).pipe(response);
        return;
      }
      const { readFile } = await import('node:fs/promises');
      const body = await readFile(target);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };
      response.writeHead(200, { 'content-type': types[target.slice(target.lastIndexOf('.'))] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' }); response.end(body);
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
        assert(results[layer].duration >= 20 && results[layer].duration <= 30.5, `${layer} movie is ${results[layer].duration.toFixed(2)}s; release requires 20 to 30s`);
        const advertisedFps = Number(movie.fps);
        assert(advertisedFps >= 12 && advertisedFps <= 30, `${layer} manifest advertises ${movie.fps}fps; release requires at most 30fps`);
      }
    }
    return results;
  } finally { await page.close(); }
}

async function testAnimation(browser, baseURL) {
  const original = await (await fetch(new URL('./data/current.json', baseURL))).json();
  const advertised = original.animations || (original.animation ? { pressure: original.animation } : null);
  const hours = hourSeriesOf(original);
  assert(hours.length > 48, 'hourly cursor is missing');
  assert(advertised?.pressure?.src, 'pressure movie is missing');
  const hourFrom = Date.parse(hours[0].time);
  const hourTo = Date.parse(hours[hours.length - 1].time);
  const forecastFrom = Date.parse(original.frames[0].time);
  const forecastTo = Date.parse(original.frames.at(-1).time);
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
    await page.addInitScript(() => { try { localStorage.removeItem('isobar.place'); } catch { /* A remembered place must not change this Perth timeline. */ } });
    const forecastMidpoint = forecastFrom + (forecastTo - forecastFrom) / 2;
    await page.addInitScript((fixed) => { Date.now = () => fixed; }, forecastMidpoint);
    const movieRequests = [];
    await setupManifest(page);
    await page.route('**/data/animation-*.mp4', (route) => { movieRequests.push(route.request().url()); return fulfillMovie(route); });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(page);
    await page.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && !document.querySelector('#map-video')?.paused);
    const before = await page.locator('#map-video').evaluate((video) => video.currentTime);
    const ambient = await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, rate: video.playbackRate, duration: video.duration }));
    assert(Math.abs(ambient.rate - 1) < .01, `ambient playback rate was ${ambient.rate}, expected 1x`);
    const nowFraction = await page.evaluate(({ from, to }) => Math.max(0, Math.min(1, (Date.now() - from) / (to - from))), { from: forecastFrom, to: forecastTo });
    assert(Math.abs(before / (ambient.duration - 1 / fps) - nowFraction) < .12, 'ambient playback did not start at the current forecast time');
    const sliderBefore = Number(await page.locator('#time').inputValue());
    await page.waitForTimeout(500);
    const after = await page.locator('#map-video').evaluate((video) => video.currentTime);
    const labelAfter = await page.locator('#time-label').textContent();
    const sliderAfter = Number(await page.locator('#time').inputValue());
    assert(after > before + .05, 'animation did not advance');
    assert(sliderAfter > sliderBefore, 'timeline slider did not advance with movie');
    assert(labelAfter && labelAfter !== '—', 'hourly cursor was not rendered');
    await screenshot(page, 'actual-playing');
    const playingSource = await page.locator('#map-video').getAttribute('data-source');
    await page.click('[data-layer="rain"]');
    await page.waitForTimeout(200);
    assert(await page.locator('#detail-panel').isVisible(), 'rain lens did not open over the map');
    assert(await page.locator('#map-video').evaluate((video) => !video.paused), 'rain lens paused the pressure movie');
    assert(await page.locator('#map-video').getAttribute('data-source') === playingSource, 'rain lens replaced the pressure movie');
    await page.click('[data-layer="temperature"]');
    assert(await page.locator('#map-video').evaluate((video, source) => !video.paused && video.dataset.source === source, playingSource), 'temperature lens replaced the pressure movie');
    await page.click('[data-layer="wind"]');
    assert(await page.locator('#map-video').evaluate((video) => !video.paused), 'kite lens paused the pressure movie');
    await page.click('[data-layer="surf"]');
    assert(await page.locator('#map-video').evaluate((video) => !video.paused), 'surf lens paused the pressure movie');
    await page.click('[data-layer="surf"]');

    await page.click('#play-toggle');
    const paused = await page.locator('#map-video').evaluate((video) => video.currentTime);
    await page.waitForTimeout(250);
    assert(Math.abs((await page.locator('#map-video').evaluate((video) => video.currentTime)) - paused) < .05, 'pause did not freeze the movie');
    await page.click('#play-toggle'); await page.waitForTimeout(250);
    assert(await page.locator('#map-video').evaluate((video, start) => video.currentTime > start + .05, paused), 'resume reset or failed to advance the movie');
    await page.click('#play-toggle');

    await page.locator('#time').evaluate((input) => { input.value = '2.37'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.waitForFunction(({ hourFrom, hourTo, movieFrom, movieTo, fps }) => {
      const video = document.querySelector('#map-video');
      const input = document.querySelector('#time');
      if (!video || !input || !Number.isFinite(video.duration) || video.readyState < 2) return false;
      const rawDate = hourFrom + Number(input.value) / Number(input.max) * (hourTo - hourFrom);
      const snappedDate = Math.max(hourFrom, Math.min(hourTo, Math.round(rawDate / 3600000) * 3600000));
      const movieSpan = video.duration - 1 / fps;
      const clamped = Math.max(movieFrom, Math.min(movieTo, snappedDate));
      const expected = (clamped - movieFrom) / (movieTo - movieFrom) * movieSpan;
      return Math.abs(video.currentTime - expected) < .5;
    }, { hourFrom, hourTo, movieFrom: forecastFrom, movieTo: forecastTo, fps }, { timeout: 3000 }).catch(async () => { throw new Error(`fractional scrub did not seek to the requested forecast hour: ${JSON.stringify(await page.evaluate(() => ({ current: document.querySelector('#map-video')?.currentTime, value: document.querySelector('#time')?.value, step: document.querySelector('#time')?.step, ready: document.querySelector('#map-video')?.readyState })))}`); });
    const seek = await page.locator('#map-video').evaluate((video, { value, fps, hourFrom, hourTo, movieFrom, movieTo }) => {
      const rawDate = hourFrom + Number(value) / Number(video.ownerDocument.querySelector('#time').max) * (hourTo - hourFrom);
      const snappedDate = Math.max(hourFrom, Math.min(hourTo, Math.round(rawDate / 3600000) * 3600000));
      const movieSpan = video.duration - 1 / fps;
      const clamped = Math.max(movieFrom, Math.min(movieTo, snappedDate));
      return {
      current: video.currentTime, duration: movieSpan, expected: (clamped - movieFrom) / (movieTo - movieFrom) * movieSpan,
      snappedDate,
      label: document.querySelector('#time-label')?.textContent || ''
      };
    }, { value: 2.37, fps, hourFrom, hourTo, movieFrom: forecastFrom, movieTo: forecastTo });
    assert(Math.abs(seek.current - seek.expected) < .1, `fractional scrub mapped to ${seek.current.toFixed(3)}s, expected ${seek.expected.toFixed(3)}s`);
    assert(seek.snappedDate % 3600000 === 0, 'slider selection did not snap to a whole forecast hour');
    const expectedLabel = await page.evaluate(({ snappedDate }) => new Intl.DateTimeFormat(undefined, {
      weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Australia/Perth', timeZoneName: 'short'
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
      }, { from: hourFrom, to: hourTo });
      await page.locator('#time').press(key);
      await page.waitForFunction(({ hourFrom, hourTo, movieFrom, movieTo, before, delta, fps }) => {
        const input = document.querySelector('#time');
        const video = document.querySelector('#map-video');
        if (!input || !video || !Number.isFinite(video.duration) || video.readyState < 2) return false;
        const maximum = Math.max(1, Number(input.max));
        const raw = hourFrom + Number(input.value) / maximum * (hourTo - hourFrom);
        const expectedDate = (before + delta) * 3600000;
        const movieSpan = Math.max(.001, video.duration - 1 / fps);
        const clamped = Math.max(movieFrom, Math.min(movieTo, expectedDate));
        const actualDate = movieFrom + video.currentTime / movieSpan * (movieTo - movieFrom);
        return Math.round(raw / 3600000) === before + delta && Math.abs(actualDate - clamped) < 120000 && video.paused;
      }, { hourFrom, hourTo, movieFrom: forecastFrom, movieTo: forecastTo, before, delta, fps }, { timeout: 3000 }).catch(async () => {
        throw new Error(`${label} did not advance one forecast hour while remaining paused: ${JSON.stringify(await page.locator('#time').evaluate((input) => ({ value: input.value, max: input.max })))} ${JSON.stringify(await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, duration: video.duration, paused: video.paused })) )}`);
      });
      const after = await page.locator('#time').evaluate((input, { from, to }) => {
        const maximum = Math.max(1, Number(input.max));
        const raw = from + Number(input.value) / maximum * (to - from);
        return Math.round(raw / 3600000);
      }, { from: hourFrom, to: hourTo });
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
    }, { from: hourFrom, to: hourTo });
    await page.locator('#time').press('ArrowRight');
    await page.locator('#time').press('ArrowRight');
    await page.locator('#time').press('ArrowRight');
    await page.waitForFunction(({ hourFrom, hourTo, movieFrom, movieTo, expectedHour, fps }) => {
      const input = document.querySelector('#time');
      const video = document.querySelector('#map-video');
      if (!input || !video || !Number.isFinite(video.duration) || video.readyState < 2) return false;
      const maximum = Math.max(1, Number(input.max));
      const raw = hourFrom + Number(input.value) / maximum * (hourTo - hourFrom);
      const movieSpan = Math.max(.001, video.duration - 1 / fps);
      const expectedDate = expectedHour * 3600000;
      const clamped = Math.max(movieFrom, Math.min(movieTo, expectedDate));
      const actualDate = movieFrom + video.currentTime / movieSpan * (movieTo - movieFrom);
      return Math.round(raw / 3600000) === expectedHour && Math.abs(actualDate - clamped) < 120000 && video.paused;
    }, { hourFrom, hourTo, movieFrom: forecastFrom, movieTo: forecastTo, expectedHour: rapidBefore + 3, fps }, { timeout: 3000 }).catch(async () => {
      throw new Error(`rapid ArrowRight presses did not accumulate three forecast hours: ${JSON.stringify(await page.locator('#time').evaluate((input) => ({ value: input.value, max: input.max })))} ${JSON.stringify(await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, duration: video.duration, paused: video.paused })) )}`);
    });

    await page.locator('#time').fill('0');
    await page.waitForFunction(({ hourFrom, movieFrom, movieTo, fps }) => {
      const input = document.querySelector('#time');
      const video = document.querySelector('#map-video');
      if (!input || !video || video.readyState < 2) return false;
      const span = Math.max(.001, video.duration - 1 / fps);
      const clamped = Math.max(movieFrom, Math.min(movieTo, hourFrom));
      const expected = (clamped - movieFrom) / Math.max(1, movieTo - movieFrom) * span;
      return Number(input.value) === 0 && Math.abs(video.currentTime - expected) < .05 && video.paused;
    }, { hourFrom, movieFrom: forecastFrom, movieTo: forecastTo, fps });
    await page.locator('#time').press('ArrowLeft');
    await page.waitForFunction(({ hourFrom, movieFrom, movieTo, fps }) => {
      const input = document.querySelector('#time');
      const video = document.querySelector('#map-video');
      if (!input || !video || video.readyState < 2) return false;
      const span = Math.max(.001, video.duration - 1 / fps);
      const clamped = Math.max(movieFrom, Math.min(movieTo, hourFrom));
      const expected = (clamped - movieFrom) / Math.max(1, movieTo - movieFrom) * span;
      return Number(input.value) <= .0001 && Math.abs(video.currentTime - expected) < .05 && video.paused;
    }, { hourFrom, movieFrom: forecastFrom, movieTo: forecastTo, fps });
    assert(await page.locator('#time').evaluate((input) => Number(input.value) === 0), 'ArrowLeft moved before the first forecast hour');
    assert(await page.locator('#map-video').evaluate((video) => video.paused), 'ArrowLeft at the first frame resumed playback');

    await page.locator('#map-frame').focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && !document.querySelector('#map-video')?.paused);
    const reset = await page.locator('#map-video').evaluate((video) => ({ current: video.currentTime, rate: video.playbackRate, duration: video.duration }));
    assert(Math.abs(reset.rate - 1) < .01, 'map reset did not resume 1x playback');
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

    await page.click('#layers-button'); await page.locator('[name="map-overlay"][value="wind"]').check(); await page.keyboard.press('Escape');
    await nextPlaybackStart();
    await page.click('#play-toggle'); await page.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && document.querySelector('#map-video')?.dataset.source?.endsWith('animation-wind.mp4'));
    const windTime = await playbackStart();
    assert(Math.abs(windTime - preservedTime) < .3, `layer switch lost forecast position (${windTime} vs ${preservedTime})`);
    await page.click('#play-toggle');
    preservedTime = await page.locator('#map-video').evaluate((video) => video.currentTime);
    const pressureRequests = movieRequests.filter((url) => url.endsWith('animation-pressure.mp4')).length;
    await page.click('#layers-button'); await page.locator('[name="map-overlay"][value="none"]').check(); await page.keyboard.press('Escape');
    await page.route('**/*', (route) => route.abort());
    await nextPlaybackStart();
    await page.click('#play-toggle'); await page.waitForFunction(() => document.querySelector('#map-video')?.dataset.source?.endsWith('animation-pressure.mp4'));
    const returnedTime = await playbackStart();
    assert(Math.abs(returnedTime - preservedTime) < .3, `returning to pressure lost forecast position (${returnedTime} vs ${preservedTime})`);
    assert(movieRequests.filter((url) => url.endsWith('animation-pressure.mp4')).length === pressureRequests, 'returning to a prepared layer fetched the movie again');
    await page.unroute('**/*');
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
    const raceRaw = hourFrom + raceSliderValue / Number(await resetRacePage.locator('#time').getAttribute('max')) * (hourTo - hourFrom);
    const raceSnapped = Math.max(hourFrom, Math.min(hourTo, Math.round(raceRaw / 3600000) * 3600000));
    const raceClamped = Math.max(forecastFrom, Math.min(forecastTo, raceSnapped));
    assert(Math.abs(raceState.current - (raceClamped - forecastFrom) / (forecastTo - forecastFrom) * (raceState.duration - 1 / fps)) < .2, 'stale reset completion replaced the latest slider selection');
    assert(Math.abs(raceState.rate - 1) < .01, 'slider race left the animation at an inconsistent playback rate');
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
    await racePage.click('#layers-button'); await racePage.locator('[name="map-overlay"][value="wind"]').check(); await racePage.keyboard.press('Escape'); await racePage.click('#play-toggle');
    await racePage.waitForFunction(() => document.querySelector('#map-video')?.readyState >= 2 && document.querySelector('#map-video')?.dataset.source?.endsWith('animation-wind.mp4'), null, { timeout: 3000 });
    await racePage.waitForTimeout(800);
    assert(await racePage.locator('#map-video').getAttribute('data-source').then((src) => src.endsWith('animation-wind.mp4')), 'stale pressure metadata replaced the selected wind movie');
  } finally { await racePage.close(); }
}

async function testViewport(browser, baseURL, viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  try {
    await errorsFor(page, async () => { await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); await waitReady(page); });
    const report = await assertViewport(page, { primary: [{ selector: '#map-frame', label: 'map', minWidth: 260, minHeight: 90 }], controls: [{ selector: '#time', minWidth: 100, minHeight: 44 }, { selector: '#layers-button', minWidth: 44, minHeight: 44 }, { selector: '#play-toggle', minWidth: 44, minHeight: 44 }], screenshotPath: `${outputDir}/${viewport.name}-closed.png` });
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

async function testPlaces(browser, baseURL) {
  const manifest = await (await fetch(new URL('./data/current.json', baseURL))).json();
  const perth = (manifest.places || []).find((place) => place.name === 'Perth');
  const sydney = (manifest.places || []).find((place) => place.name === 'Sydney');
  assert(perth?.timezone === 'Australia/Perth' && sydney?.timezone === 'Australia/Sydney', 'Perth and Sydney need their IANA zones');
  assert(perth.daily?.length >= 7 && sydney.daily?.length >= 7, 'both places need a 7-day summary');
  assert(perth.hours.length > 48 && sydney.hours.length > 48, 'hourly series still stops at 48 hours');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'light' });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitReady(page);
    assert(await page.locator('#day-strip li').count() >= 7, '7-day strip is missing');
    assert(await page.locator('#time-label').textContent() !== '—', 'hourly cursor is missing');
    assert((await page.locator('#day-strip').textContent()).includes(degreeText(perth.daily[0].tempMax)), 'Perth strip does not show the daily maximum');
    const targets = await page.evaluate(() => [...document.querySelectorAll('.place, .detail-tab, #play-toggle, #layers-button, #time')].map((el) => {
      const box = el.getBoundingClientRect();
      return { name: el.textContent.trim() || el.id, width: box.width, height: box.height };
    }).filter((item) => item.width < 44 || item.height < 44));
    assert(!targets.length, `controls under 44px: ${JSON.stringify(targets)}`);
    await page.getByRole('button', { name: 'Sydney', exact: true }).click();
    await page.waitForFunction((max) => document.querySelector('#current-temp')?.textContent && document.querySelector('#day-strip')?.textContent?.includes(max), degreeText(sydney.daily[0].tempMax));
    assert(await page.evaluate(() => { try { return localStorage.getItem('isobar.place'); } catch { return null; } }) === sydney.id, 'Sydney choice was not remembered');
    assert((await page.locator('#time-label').textContent())?.length > 2, 'Sydney hourly cursor is missing');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitReady(page);
    assert(await page.getByRole('button', { name: 'Sydney', exact: true }).getAttribute('aria-pressed') === 'true', 'remembered place was not restored');
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert(csp?.includes("default-src 'self'") && !csp.includes('unsafe-inline'), 'CSP is not strict');
    const source = await (await fetch(new URL('./app.js', baseURL))).text();
    assert(!source.includes('innerHTML'), 'page script uses innerHTML');
    assert(!await page.locator('#map-frame').evaluate((frame) => frame.contains(document.querySelector('#retry'))), 'Retry is inside the map button');
  } finally { await page.close(); }

  const dark = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await dark.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    await dark.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitReady(dark);
    const contrast = await dark.evaluate(() => {
      const parse = (color) => color.match(/\d+/g).slice(0, 3).map(Number);
      const channel = (value) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      const lum = (rgb) => 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
      const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
      const body = getComputedStyle(document.body);
      const label = getComputedStyle(document.querySelector('.day-name'));
      const background = parse(body.backgroundColor);
      return { dark: lum(background) < 0.25, contrast: ratio(parse(label.color), background) };
    });
    assert(contrast.dark, 'dark color scheme did not change the page background');
    assert(contrast.contrast >= 4.5, `dark label contrast is ${contrast.contrast.toFixed(2)}`);
  } finally { await dark.close(); }

  const locked = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await locked.emulateMedia({ reducedMotion: 'reduce' });
    await locked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } }); });
    await locked.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitReady(locked);
    assert(await locked.getByRole('button', { name: 'Perth', exact: true }).getAttribute('aria-pressed') === 'true', 'locked storage prevented the default place');
  } finally { await locked.close(); }

  const timeoutPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await timeoutPage.emulateMedia({ reducedMotion: 'reduce' });
    let calls = 0;
    await timeoutPage.route('**/data/current.json', async (route) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 12000));
        try { await route.fulfill({ status: 200, contentType: 'application/json', body: '{"frames":[]}' }); } catch { /* The timed-out request is already aborted. */ }
        return;
      }
      await route.continue();
    });
    await timeoutPage.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await timeoutPage.waitForSelector('#retry:not([hidden])', { timeout: 12000 });
    assert(await timeoutPage.locator('#updated').textContent() === 'Forecast unavailable', 'a timed-out forecast did not offer a status');
    await timeoutPage.click('#retry');
    await waitReady(timeoutPage);
    await timeoutPage.waitForTimeout(4000);
    assert(await visibleMap(timeoutPage), 'a late forecast response replaced the recovered map');
    assert(calls >= 2, 'Retry did not request the forecast again');
  } finally { await timeoutPage.close(); }
}

const MOVIE_BUDGET = 10 * 1000 * 1000;

function movieFile(manifest, layer) {
  const src = manifest.animations?.[layer]?.src;
  assert(typeof src === 'string' && src && !src.startsWith('/') && !src.includes('..'), `${layer} movie is missing`);
  const file = resolve(siteRoot, 'data', src);
  assert(file.startsWith(resolve(siteRoot, 'data') + sep), `${layer} movie escapes site data`);
  assert(existsSync(file), `${layer} movie is not on disk (${src})`);
  const bytes = statSync(file).size;
  assert(bytes > 0 && bytes <= MOVIE_BUDGET, `${layer} movie is ${bytes} bytes; budget is 10 MB`);
  return { src, bytes };
}

function snappedHour(hours, value) {
  const from = Date.parse(hours[0].time);
  const to = Date.parse(hours[hours.length - 1].time);
  const max = Math.max(1, hours.length - 1);
  const raw = from + Number(value) / max * Math.max(1, to - from);
  const snapped = Math.max(from, Math.min(to, Math.round(raw / 3600000) * 3600000));
  let best = null, distance = Infinity;
  for (const point of hours) {
    if (!Number.isFinite(Date.parse(point.time))) continue;
    const candidate = Math.abs(Date.parse(point.time) - snapped);
    if (candidate < distance) { distance = candidate; best = point; }
  }
  return distance <= 45 * 60 * 1000 ? { snapped, point: best } : { snapped, point: null };
}

async function throttlePlayback(page) {
  const client = await page.context().newCDPSession(page);
  await client.send('Network.enable');
  await client.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 40,
    downloadThroughput: 10_000_000 / 8,
    uploadThroughput: 2_000_000 / 8,
  });
  return client;
}

async function testStreamedPlayback(browser, baseURL) {
  const manifest = await (await fetch(new URL('./data/current.json', baseURL))).json();
  const hours = hourSeriesOf(manifest);
  assert(hours.length > 48, 'hourly cursor is missing');
  const movies = {};
  for (const layer of ['pressure', 'temperature', 'rain', 'wind']) {
    movies[layer] = movieFile(manifest, layer);
    console.log(`${layer} movie ${(movies[layer].bytes / 1_000_000).toFixed(2)} MB`);
  }
  const source = await (await fetch(new URL('./app.js', baseURL))).text();
  assert(!source.includes('createObjectURL') && !source.includes('response.blob'), 'playback buffers the movie into a blob');
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'allow' });
  const page = await context.newPage();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(() => { try { localStorage.removeItem('isobar.place'); } catch { /* Perth is the default when storage is empty. */ } });
    await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await waitReady(page);
    assert(await page.locator('#map-image').evaluate((image) => !image.hidden && image.classList.contains('ready')), 'static map was not shown before Play');
    assert(await page.locator('#map-video').evaluate((video) => video.hidden && video.paused), 'video replaced the static map before Play');
    assert(await page.locator('#play-toggle').textContent() === 'Play', 'playback started before Play');
    await screenshot(page, 'static-before-play');
    await throttlePlayback(page);
    await page.evaluate(() => {
      window.__isobarPlay = { click: 0, playing: 0, origin: null };
      document.querySelector('#map-video').addEventListener('playing', () => {
        const mark = window.__isobarPlay;
        if (mark.playing) return;
        mark.playing = performance.now();
        mark.origin = document.querySelector('#map-video').currentTime;
      });
    });
    await page.evaluate(() => { window.__isobarPlay.click = performance.now(); });
    const started = Date.now();
    await page.click('#play-toggle');
    await page.waitForFunction(() => {
      const video = document.querySelector('#map-video');
      const mark = window.__isobarPlay;
      const src = video?.currentSrc || video?.src || '';
      return video && mark?.playing && Number.isFinite(mark.origin) && !video.hidden && !video.paused && video.currentTime > mark.origin + 1 && !src.startsWith('blob:');
    }, null, { timeout: 5000 }).catch(async () => {
      throw new Error(`Play did not advance within 5s: ${JSON.stringify(await page.evaluate(() => ({ current: document.querySelector('#map-video')?.currentTime, paused: document.querySelector('#map-video')?.paused, ready: document.querySelector('#map-video')?.readyState, hidden: document.querySelector('#map-video')?.hidden, src: document.querySelector('#map-video')?.currentSrc, button: document.querySelector('#play-toggle')?.textContent, play: window.__isobarPlay })))}`);
    });
    const elapsed = Date.now() - started;
    const timing = await page.evaluate(() => window.__isobarPlay);
    const timeToPlay = timing.playing - timing.click;
    console.log(`throttled play: started in ${Math.round(timeToPlay)} ms, advanced 1s by ${elapsed} ms`);
    assert(timeToPlay > 0 && timeToPlay < 3000, `play started in ${Math.round(timeToPlay)} ms; expected within 3s`);
    const playedSrc = await page.locator('#map-video').evaluate((video) => video.currentSrc || video.src);
    assert(playedSrc.includes(movies.pressure.src), 'play did not use the generation URL');
    await screenshot(page, 'throttled-playing');
    const playingSource = await page.locator('#map-video').getAttribute('data-source');
    for (const layer of ['rain', 'temperature', 'wind', 'surf']) {
      await page.click(`[data-layer="${layer}"]`);
      await page.waitForTimeout(200);
      const state = await page.locator('#map-video').evaluate((video) => ({ paused: video.paused, hidden: video.hidden, source: video.dataset.source }));
      assert(!state.paused && !state.hidden && state.source === playingSource, `${layer} lens stopped playback`);
    }
    const beforePlace = await page.locator('#map-video').evaluate((video) => video.currentTime);
    await page.getByRole('button', { name: 'Sydney', exact: true }).click();
    await page.waitForTimeout(400);
    assert(await page.locator('#map-video').evaluate((video, start) => !video.paused && video.currentTime > start, beforePlace), 'switching place stopped playback');
    await page.getByRole('button', { name: 'Perth', exact: true }).click();
    await page.waitForTimeout(200);
    assert(await page.locator('#map-video').evaluate((video) => !video.paused), 'returning to Perth stopped playback');
    await page.click('#play-toggle');
    await page.waitForFunction(() => document.querySelector('#play-toggle')?.textContent === 'Play' && document.querySelector('#map-video')?.paused);
    const pausedAt = await page.locator('#map-video').evaluate((video) => video.currentTime);
    await page.waitForTimeout(400);
    assert(Math.abs((await page.locator('#map-video').evaluate((video) => video.currentTime)) - pausedAt) < 0.05, 'pause did not freeze the movie');
    await page.click('[data-layer="temperature"]');
    await page.waitForFunction(() => document.querySelector('#detail-reading')?.textContent?.includes('°'));
    const beforeLabel = await page.locator('#time-label').textContent();
    const index = Math.max(1, Math.round((hours.length - 1) * 0.75));
    const target = snappedHour(hours, index);
    assert(target.point && Number.isFinite(target.point.temp), 'scrub target has no temperature');
    const expectedReading = `${Number(target.point.temp).toFixed(0)} °C`;
    await page.locator('#time').evaluate((input, value) => { input.value = String(value); input.dispatchEvent(new Event('input', { bubbles: true })); }, index);
    const movie = manifest.animations.pressure;
    const movieFrom = Date.parse(movie.validFrom);
    const movieTo = Date.parse(movie.validTo);
    await page.waitForFunction(({ movieFrom, movieTo, snapped, fps, duration }) => {
      const video = document.querySelector('#map-video');
      if (!video || !Number.isFinite(video.duration) || video.readyState < 2) return false;
      const span = Math.max(0.001, (Number.isFinite(duration) ? duration : video.duration) - 1 / fps);
      const expected = (Math.max(movieFrom, Math.min(movieTo, snapped)) - movieFrom) / Math.max(1, movieTo - movieFrom) * span;
      return Math.abs(video.currentTime - expected) < 0.5;
    }, { movieFrom, movieTo, snapped: target.snapped, fps: movie.fps, duration: movie.durationSeconds }, { timeout: 8000 }).catch(async () => {
      throw new Error(`scrub did not seek the streamed video: ${JSON.stringify(await page.evaluate(() => ({ current: document.querySelector('#map-video')?.currentTime, duration: document.querySelector('#map-video')?.duration, label: document.querySelector('#time-label')?.textContent, reading: document.querySelector('#detail-reading')?.textContent })))}`);
    });
    const afterLabel = await page.locator('#time-label').textContent();
    const afterReading = await page.locator('#detail-reading').textContent();
    assert(afterLabel && afterLabel !== beforeLabel, 'scrub did not update the time');
    assert(afterReading === expectedReading, `scrub reading ${JSON.stringify(afterReading)} expected ${JSON.stringify(expectedReading)}`);
    await screenshot(page, 'throttled-scrub');
  } finally { await context.close(); }

  const offline = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'allow' });
  const shell = await offline.newPage();
  try {
    await shell.emulateMedia({ reducedMotion: 'reduce' });
    await shell.goto(baseURL, { waitUntil: 'domcontentloaded' });
    await shell.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10000 });
    await offline.setOffline(true);
    await shell.reload({ waitUntil: 'domcontentloaded' });
    assert((await shell.locator('.wordmark').textContent()) === 'isobar', 'offline reload lost the shell');
    assert(await shell.locator('#play-toggle').isVisible(), 'offline reload lost Play');
    assert(await shell.locator('#map-frame').isVisible(), 'offline reload lost the map frame');
    await screenshot(shell, 'offline-shell');
  } finally { await offline.close(); }
}

async function run() {
  await prepareSite();
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
    await testPlaces(browser, server.url);
    for (const viewport of viewports) await testViewport(browser, server.url, viewport);
    await testAnimation(browser, server.url);
    await testStreamedPlayback(browser, server.url);
    const largePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
    try {
      await largePage.emulateMedia({ reducedMotion: 'reduce' });
      await largePage.goto(server.url, { waitUntil: 'domcontentloaded' }); await waitReady(largePage);
      await largePage.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
      await assertViewport(largePage, { documentY: 'allow', primary: [{ selector: '#map-frame', label: 'map', minWidth: 260, minHeight: 90 }], controls: [{ selector: '#layers-button', minWidth: 44, minHeight: 44 }], screenshotPath: `${outputDir}/phone-200-percent.png` });
      const wide = await largePage.evaluate(() => {
        if (document.documentElement.scrollWidth <= innerWidth) return null;
        const bad = [];
        document.querySelectorAll('body *').forEach((el) => {
          const box = el.getBoundingClientRect();
          if (box.right > innerWidth + 1 || box.left < -1) bad.push(`${el.id || el.className || el.tagName}:${Math.round(box.left)}-${Math.round(box.right)}`);
        });
        return `${document.documentElement.scrollWidth}px in ${innerWidth}px (${bad.slice(0, 12).join(', ')})`;
      });
      assert(!wide, `200% text caused horizontal overflow: ${wide}`);
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
      const rainFrame = raceManifest.frames.find((frame) => typeof frame.maps?.rain === 'string');
      assert(rainFrame, 'race fixture has no frame with a rain map');
      const rainValue = sliderValueFor(rainFrame.time, hourSeriesOf(raceManifest));
      await racePage.goto(server.url, { waitUntil: 'domcontentloaded' }); await waitReady(racePage); await racePage.locator('#time').fill(String(rainValue)); await racePage.waitForFunction(() => document.querySelector('#map-image')?.src.endsWith('-pressure.png')); await racePage.click('#layers-button'); await racePage.route('**/*-temperature.png', async (route) => { await new Promise((resolve) => setTimeout(resolve, 300)); await route.continue(); }); await racePage.route('**/*-rain.png', (route) => route.continue());
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
      const missingHours = hourSeriesOf(manifest);
      await missingRainPage.goto(server.url, { waitUntil: 'domcontentloaded' });
      await waitReady(missingRainPage);
      await missingRainPage.locator('#time').fill(String(sliderValueFor(manifest.frames[missingIndex].time, missingHours)));
      const pressureBeforeLens = await missingRainPage.locator('#map-image').getAttribute('src');
      await missingRainPage.click('[data-layer="rain"]');
      assert(await missingRainPage.locator('#detail-panel').isVisible(), 'missing-rain detail chart did not open');
      assert(await canvasHasInk(missingRainPage, 'rain'), 'missing-rain detail chart is empty');
      assert(await missingRainPage.locator('#map-image').getAttribute('src') === pressureBeforeLens, 'rain lens replaced the pressure map');
      assert((await missingRainPage.locator('#map-title').textContent()).startsWith('Pressure ·'), 'rain lens replaced the pressure title');
      await missingRainPage.click('#layers-button');
      await missingRainPage.locator('[name="map-overlay"][value="rain"]').check();
      await missingRainPage.keyboard.press('Escape');
      await missingRainPage.waitForFunction(() => document.querySelector('#map-note')?.textContent === '24h rain unavailable');
      assert((await missingRainPage.locator('#map-title').textContent()).startsWith('Pressure ·'), 'missing-rain map did not fall back to pressure');
      assert(await missingRainPage.locator('#map-image').getAttribute('src').then((src) => src.endsWith('-pressure.png')), 'missing-rain fallback is not the pressure asset');
      assert(await missingRainPage.getByText('24h rain unavailable').isVisible(), 'missing-rain status is not visible');
      assert(await missingRainPage.locator('#retry').isHidden(), 'missing-rain state incorrectly offers retry');
      await missingRainPage.locator('#time').fill(String(sliderValueFor(manifest.frames[availableRainIndex].time, missingHours)));
      await missingRainPage.waitForFunction(() => document.querySelector('#map-image')?.src.endsWith('-rain.png'));
      assert((await missingRainPage.locator('#map-title').textContent()).startsWith('Rain ·'), 'available rain frame did not restore rain map');
    } finally { await missingRainPage.close(); }
    assert(!errors.length, `Runtime errors: ${errors.join('; ')}`);
    console.log(`site harness passed: ${viewports.length} viewports, 7-day places, lenses, throttled playback, offline shell, timeout, dark mode, and overlay race`);
  } finally { if (browser) await browser.close(); await server.close(); }
}
run().catch((error) => { console.error(`site harness failed: ${error.stack || error}`); process.exitCode = 1; });
