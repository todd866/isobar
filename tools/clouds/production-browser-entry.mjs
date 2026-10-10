import { drawSkySync, SkyAnimator, stateKey } from './training/src/sky/render.ts';
import { drawSounding } from './web/src/lib/point/sounding.ts';
import { configureCloudAtlas, prepareCloudSprites, paintCloudSprite } from './training/src/sky/painted.ts';

const scenes = __SCENES__;
configureCloudAtlas(new URL(location.href).searchParams.has('external') ? '/atlas.webp' : __ATLAS__);
const canvas = document.querySelector('#sky');
const note = document.querySelector('#note');
const summary = document.querySelector('#summary');
const details = document.querySelector('#result');
const runButton = document.querySelector('#run');
const sceneSelect = document.querySelector('#scene');
const themeSelect = document.querySelector('#theme');
let visible = 0;
let visibleDark = false;
let visibleReady = false;

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const percentile = (values, p) => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] ?? 0; };
const timing = (values) => ({ samples: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95), maxMs: Math.max(...values) });
const readback = (ctx) => ctx.getImageData(0, 0, 1, 1);

function skySize() {
  const width = Math.max(1, Math.round(canvas.getBoundingClientRect().width));
  const height = Math.max(1, Math.round(canvas.getBoundingClientRect().height));
  return { width, height, dpr: Math.min(3, window.devicePixelRatio || 1) };
}
function opts(scene, dark, size = skySize()) { return { ...size, dark, seed: scene.id, coastKm: null }; }

async function paintVisible() {
  window.__VISIBLE_READY = false;
  canvas.style.height = `${Math.max(120, Math.min(236, innerHeight - document.querySelector('#bar').offsetHeight - 12))}px`;
  await prepareCloudSprites();
  const scene = scenes[visible]; const size = skySize();
  canvas.width = Math.round(size.width * size.dpr); canvas.height = Math.round(size.height * size.dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
  const scratch = { clouds: document.createElement('canvas'), layer: document.createElement('canvas') };
  scratch.clouds.width = canvas.width; scratch.clouds.height = canvas.height; scratch.layer.width = canvas.width; scratch.layer.height = canvas.height;
  drawSkySync(ctx, scene, opts(scene, visibleDark, size), scratch); visibleReady = true; window.__VISIBLE_READY = true;
  note.textContent = `${scene.title} · ${visibleDark ? 'dark' : 'light'} · ${size.width}×${size.height}`;
}

async function cold(scene, dark, size) {
  const values = [], submission = [];
  for (let i = 0; i < 40; i += 1) {
    const target = document.createElement('canvas'); target.width = Math.round(size.width * size.dpr); target.height = Math.round(size.height * size.dpr);
    const ctx = target.getContext('2d'); ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    const scratch = { clouds: document.createElement('canvas'), layer: document.createElement('canvas') };
    scratch.clouds.width = target.width; scratch.clouds.height = target.height; scratch.layer.width = target.width; scratch.layer.height = target.height;
    const t0 = performance.now(); drawSkySync(ctx, scene, opts(scene, dark, size), scratch); submission.push(performance.now() - t0); readback(ctx); values.push(performance.now() - t0);
    if (i % 2 === 1) await frame();
  }
  return { ...timing(values), submission: timing(submission) };
}

async function warm(scene, other, dark, size) {
  const target = document.createElement('canvas'); const animator = new SkyAnimator(target); const a = opts(scene, dark, size); const b = opts(other, dark, size);
  animator.showNow(scene, a); animator.showNow(other, b); animator.showNow(scene, a);
  const ctx = target.getContext('2d'); const values = [];
  for (let i = 0; i < 60; i += 1) {
    const next = i % 2 ? other : scene; const nextOpts = i % 2 ? b : a; const t0 = performance.now();
    animator.show(next, nextOpts); await frame(); readback(ctx); values.push(performance.now() - t0);
  }
  await frame(); const frames = animator.stats.frames.slice();
  const output = { presentationLatency: timing(values), ...timing(frames), frameCount: frames.length, frameP50Ms: frames.length ? percentile(frames, .5) : 0, frameP95Ms: frames.length ? percentile(frames, .95) : 0, builds: animator.stats.builds.length };
  animator.dispose(); return output;
}

async function point(scene, dark, size) {
  const target = document.createElement('canvas'), clouds = document.createElement('canvas');
  target.width = Math.round(size.width * size.dpr); target.height = Math.round(size.height * size.dpr);
  const ctx = target.getContext('2d'); ctx.setTransform(size.dpr,0,0,size.dpr,0,0);
  const samples = [], submission = [];
  for (let i=0;i<40;i++) {
    const t=performance.now();
    drawSounding(ctx,{width:size.width,height:size.height,rows:[],layers:scene.layers,icing:scene.icing,
      freezingFt:scene.freezingFt,bottomFt:0,groundFt:0,emphasis:'cloud',dark,ink:'#174e66',muted:'#567b91',
      cloudPainter:{canvas:clouds,dpr:size.dpr,paintCloudSprite}},()=>{});
    submission.push(performance.now()-t);readback(ctx);samples.push(performance.now()-t);
    if(i%2) await frame();
  }
  return {...timing(samples),submission:timing(submission)};
}

async function runBenchmark() {
  runButton.disabled = true; summary.textContent = 'Running…'; details.textContent = '';
  await prepareCloudSprites(); const size = skySize(); const rows = [];
  for (const dark of [false, true]) for (let i = 0; i < scenes.length; i += 1) {
    note.textContent = `Benchmark ${i + 1}/${scenes.length} · ${scenes[i].title}`;
    rows.push({ scene: scenes[i].id, theme: dark ? 'dark' : 'light', render: size, pointCloudField: await point(scenes[i],dark,size), cold: await cold(scenes[i], dark, size), warm: await warm(scenes[i], scenes[(i + 1) % scenes.length], dark, size), key: stateKey(scenes[i], opts(scenes[i], dark, size)) });
    await frame();
  }
  const payload = { scope: 'Actual browser and device recorded below. Headless desktop phone viewports are emulation, never physical-phone certification. Cold includes full draw + forced readback; warm measures animator callback CPU submission, excluding GPU completion. presentationLatency includes waiting for vsync.', viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 }, render: size, userAgent: navigator.userAgent, atlas: new URL(location.href).searchParams.has('external') ? 'one-local-request' : 'inline-data-url', rows };
  window.__BENCHMARK_RESULT = payload; summary.textContent = rows.map((r) => `${r.scene} ${r.theme}: full ${r.cold.p95Ms.toFixed(2)}ms · cached ${r.warm.p95Ms.toFixed(2)}ms`).join(' | '); details.textContent = JSON.stringify(payload, null, 2); runButton.disabled = false; note.textContent = 'Benchmark complete'; return payload;
}

sceneSelect.addEventListener('change', () => { visible = Number(sceneSelect.value); void paintVisible(); });
themeSelect.addEventListener('change', () => { visibleDark = themeSelect.value === 'dark'; document.documentElement.dataset.theme = themeSelect.value; void paintVisible(); });
window.addEventListener('resize', () => { if (visibleReady) void paintVisible(); });
document.querySelector('#copy').addEventListener('click', async () => { await navigator.clipboard.writeText(details.textContent); note.textContent = 'JSON copied'; });
document.querySelector('#download').addEventListener('click', () => { const blob = new Blob([details.textContent], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'browser-timing.json'; a.click(); URL.revokeObjectURL(a.href); });
runButton.addEventListener('click', () => { void runBenchmark().catch(error => { note.textContent = error.message; runButton.disabled = false; }); });
window.runBenchmark = runBenchmark; window.__PRODUCTION_READY = true;
void paintVisible();
