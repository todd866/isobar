/*
 * Offline before/after map comparison renderer.
 *
 * This intentionally records the production overlay into SVG rather than
 * opening a browser. Outputs are comparison evidence, not browser screenshots:
 * no DEM is available offline, so terrain styling is absent and called out in
 * the generated README/JSON.
 *
 * Run from web/:
 *   node --import tsx scripts/render-global-generalise.ts
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { contourPressure } from '../src/lib/contour';
import { drawOverlay, DAY_INK, NIGHT_INK } from '../src/lib/overlay';
import { globalEquirectangular, type Camera, type Lambert } from '../src/lib/lambert';
import { parseCoast, type Coast } from '../src/lib/coast';
import { readManifest } from '../src/lib/manifest';
import { decodeFrameBytes } from '../src/lib/frame-codec';
import { decodeUint16 } from '../src/lib/quantise';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, '..', 'build', 'global-generalise');
const WIDTH = 1280;
const HEIGHT = 640;
const BASELINE_COMMIT = '8326a7c';

/** Minimal Canvas2D recorder covering drawOverlay's production API surface. */
class SvgCanvas {
  readonly canvas = { width: WIDTH, height: HEIGHT };
  globalAlpha = 1;
  fillStyle: string | CanvasGradient | CanvasPattern = '#000';
  strokeStyle: string | CanvasGradient | CanvasPattern = '#000';
  lineWidth = 1;
  lineCap: CanvasLineCap = 'butt';
  lineJoin: CanvasLineJoin = 'miter';
  font = '10px sans-serif';
  textAlign: CanvasTextAlign = 'start';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  private commands: string[] = [];
  private current: string[] = [];
  private dash: number[] = [];
  private stack: object[] = [];

  setTransform() {}
  clearRect() { this.commands = []; }
  save() { this.stack.push({ alpha: this.globalAlpha, fill: this.fillStyle, stroke: this.strokeStyle, width: this.lineWidth, dash: this.dash.slice() }); }
  restore() {
    const state = this.stack.pop() as { alpha: number; fill: string | CanvasGradient | CanvasPattern; stroke: string | CanvasGradient | CanvasPattern; width: number; dash: number[] } | undefined;
    if (!state) return;
    this.globalAlpha = state.alpha; this.fillStyle = state.fill; this.strokeStyle = state.stroke; this.lineWidth = state.width; this.dash = state.dash;
  }
  beginPath() { this.current = []; }
  moveTo(x: number, y: number) { this.current.push(`M${n(x)} ${n(y)}`); }
  lineTo(x: number, y: number) { this.current.push(`L${n(x)} ${n(y)}`); }
  closePath() { this.current.push('Z'); }
  fill(rule?: CanvasFillRule) { this.emit('path', this.current.join(' '), { fill: color(this.fillStyle), stroke: 'none', rule: rule === 'evenodd' ? 'evenodd' : 'nonzero' }); }
  stroke() { this.emit('path', this.current.join(' '), { fill: 'none', stroke: color(this.strokeStyle) }); }
  fillRect(x: number, y: number, w: number, h: number) { this.emit('rect', '', { x, y, w, h, fill: color(this.fillStyle) }); }
  arc(x: number, y: number, radius: number) { this.current.push(`M${n(x + radius)} ${n(y)} A${n(radius)} ${n(radius)} 0 1 0 ${n(x - radius)} ${n(y)} A${n(radius)} ${n(radius)} 0 1 0 ${n(x + radius)} ${n(y)}`); }
  drawImage() {}
  setLineDash(value: number[]) { this.dash = value.slice(); }
  measureText(text: string) { return { width: text.length * (/^\d/.test(text) ? 7.2 : 7) } as TextMetrics; }
  strokeText(text: string, x: number, y: number) { this.emit('text', text, { x, y, fill: 'none', stroke: color(this.strokeStyle), font: this.font }); }
  fillText(text: string, x: number, y: number) { this.emit('text', text, { x, y, fill: color(this.fillStyle), stroke: 'none', font: this.font }); }
  private emit(kind: string, body: string, attrs: Record<string, unknown>) {
    const common = `opacity="${n(this.globalAlpha)}" stroke-width="${n(this.lineWidth)}" stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"${this.dash.length ? ` stroke-dasharray="${this.dash.join(' ')}"` : ''}`;
    if (kind === 'path') this.commands.push(`<path d="${body}" ${common} fill-rule="${attrs.rule ?? 'nonzero'}" fill="${attrs.fill}" stroke="${attrs.stroke}"/>`);
    else if (kind === 'rect') this.commands.push(`<rect x="${n(attrs.x as number)}" y="${n(attrs.y as number)}" width="${n(attrs.w as number)}" height="${n(attrs.h as number)}" fill="${attrs.fill}" ${common}/>`);
    else this.commands.push(`<text x="${n(attrs.x as number)}" y="${n(attrs.y as number)}" text-anchor="${this.textAlign === 'center' ? 'middle' : 'start'}" dominant-baseline="middle" style="font:${escapeXml(String(attrs.font))}" fill="${attrs.fill}" stroke="${attrs.stroke}" ${common}>${escapeXml(body)}</text>`);
  }
  svg(dark: boolean): string {
    const background = dark ? '#232f3e' : '#e9eff4';
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}"><rect width="100%" height="100%" fill="${background}"/>${this.commands.join('')}</svg>`;
  }
}

function n(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Non-finite renderer coordinate/style');
  return value.toFixed(2);
}
function color(value: unknown): string { return typeof value === 'string' ? value : '#000'; }
function escapeXml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

/** The baseline's rasterLand/landGrid adapter, rasterised by libvips. This is
 * coastline coverage, not a fabricated elevation mask. Preserve the old
 * pressure-noise heuristic's real input when comparing centre selection. */
async function baselineLand(coast: Coast, manifest: ReturnType<typeof readManifest>): Promise<Uint8Array> {
  const width = 4096, height = 2048;
  const paths: string[] = [];
  for (const ring of coast.rings) {
    for (let i = 0; i < ring.lon.length; i++) {
      const move = i === 0 || Math.abs(ring.lon[i] - ring.lon[i - 1]) > 180;
      paths.push(`${move ? 'M' : 'L'}${(ring.lon[i] + 180) / 360 * width} ${(90 - ring.lat[i]) / 180 * height}`);
    }
    paths.push('Z');
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="black"/><path d="${paths.join(' ')}" fill="white" fill-rule="evenodd"/></svg>`;
  const pixels = await sharp(Buffer.from(svg)).removeAlpha().greyscale().raw().toBuffer();
  const { nx, ny, west, north, step } = manifest;
  const land = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const x = Math.floor((west + i * step + 180) / 360 * width);
    const y = Math.floor((north - j * step + 90) / 180 * height);
    if (x >= 0 && x < width && y >= 0 && y < height) land[j * nx + i] = pixels[(height - 1 - y) * width + x] > 127 ? 1 : 0;
  }
  return land;
}

/** One fixed projection and the actual viewport aspect for both revisions. */
function cameraFor(scene: string): { geo: Lambert; camera: Camera } {
  const views: Record<string, [number, number, number]> = {
    world: [0, 0, 90], asia: [100, 35, 32], andes: [-72, -20, 42], australia: [134, -27, 19],
  };
  const [lon, lat, halfHeight] = views[scene];
  return { geo: globalEquirectangular(), camera: { centerX: lon, centerY: lat, halfWidth: halfHeight * WIDTH / HEIGHT, halfHeight } };
}

type ContourResult = ReturnType<typeof contourPressure>;

async function render(scene: string, dark: boolean, after: boolean, coast: Coast, beforeContour: ContourResult, afterContour: ContourResult, baselineOverlay: typeof drawOverlay): Promise<string> {
  const { geo, camera } = cameraFor(scene);
  const ctx = new SvgCanvas();
  if (after) {
    drawOverlay(ctx as unknown as CanvasRenderingContext2D, WIDTH, HEIGHT, 1, geo, camera, coast, afterContour.lines, afterContour.centres, true, undefined, dark ? NIGHT_INK : DAY_INK);
  } else baselineOverlay(ctx as unknown as CanvasRenderingContext2D, WIDTH, HEIGHT, 1, geo, camera, coast, beforeContour.lines, beforeContour.centres, true, undefined, dark ? NIGHT_INK : DAY_INK);
  // Diagnostic caption is outside the product renderer; no browser screenshot claim.
  ctx.fillStyle = dark ? '#232f3e' : '#e9eff4';
  ctx.fillRect(0, HEIGHT - 22, WIDTH, 22);
  ctx.fillStyle = dark ? '#f3ecd8' : '#10202c';
  ctx.font = '500 11px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`${scene} · ${after ? 'after' : 'before 8326a7c'} · offline renderer · DEM/wind/traffic absent`, 10, HEIGHT - 11);
  const svg = ctx.svg(dark);
  const name = `${scene}-${dark ? 'dark' : 'light'}-${after ? 'after' : 'before'}`;
  writeFileSync(path.join(OUT, `${name}.svg`), svg);
  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, `${name}.png`));
  return name;
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const baselineDir = path.join(OUT, 'baseline-source'); mkdirSync(baselineDir, { recursive: true });
  // Read each input once so a concurrent export cannot change the provenance
  // between decode, rendering and hashing.
  const manifestBytes = readFileSync(path.join(ROOT, 'public/data/manifest.json'));
  const manifest = readManifest(JSON.parse(manifestBytes.toString('utf8')));
  const run = manifest.run;
  const spec = manifest.variables.mslp;
  if (!spec.frames?.[0]) throw new Error('Comparison requires a per-frame MSLP export');
  const framePath = path.join(ROOT, 'public/data', spec.frames[0]);
  const frameBytes = readFileSync(framePath);
  const mslp = decodeUint16(await decodeFrameBytes(frameBytes, spec.encoding), spec);
  if (mslp.length !== manifest.nx * manifest.ny) throw new Error('MSLP frame geometry mismatch');
  const coastBytes = readFileSync(path.join(ROOT, 'public/coast/world.bin'));
  const coast = parseCoast(coastBytes);
  const baselineFiles = ['overlay.ts', 'contour.ts', 'field-color.ts', 'lambert.ts', 'coast.ts', 'coastal.ts', 'units.ts', 'units-regions.ts'];
  for (const file of baselineFiles) writeFileSync(path.join(baselineDir, file), execFileSync('git', ['show', `${BASELINE_COMMIT}:web/src/lib/${file}`]));
  const baseline = await import(`file://${path.join(baselineDir, 'overlay.ts')}`) as { drawOverlay: typeof drawOverlay };
  const baselineContour = await import(`file://${path.join(baselineDir, 'contour.ts')}`) as { contourPressure: typeof contourPressure };
  const { nx, ny, west, north, step } = manifest;
  const beforeContour = baselineContour.contourPressure(mslp, nx, ny, west, north, step, -step, 4, await baselineLand(coast, manifest));
  const afterContour = contourPressure(mslp, nx, ny, west, north, step, -step, 4);
  const outputs: string[] = [];
  for (const scene of ['world', 'asia', 'andes', 'australia']) for (const dark of [false, true]) for (const after of [false, true]) outputs.push(await render(scene, dark, after, coast, beforeContour, afterContour, baseline.drawOverlay));
  const comparisons: string[] = [];
  for (const scene of ['world', 'asia', 'andes', 'australia']) {
    const layers = ['light', 'dark'].flatMap((theme, row) => ['before', 'after'].map((version, column) => ({
      input: path.join(OUT, `${scene}-${theme}-${version}.png`), left: column * WIDTH, top: row * HEIGHT,
    })));
    const name = `${scene}-comparison.png`;
    await sharp({ create: { width: WIDTH * 2, height: HEIGHT * 2, channels: 4, background: '#ffffff' } })
      .composite(layers).png().toFile(path.join(OUT, name));
    comparisons.push(name);
  }
  const afterFiles = ['src/lib/contour.ts', 'src/lib/overlay.ts', 'src/lib/map-generalise.ts', 'src/lib/lambert.ts', 'src/lib/field-color.ts', 'src/lib/units.ts', 'scripts/render-global-generalise.ts'];
  const afterSourceHashes = Object.fromEntries(afterFiles.map((file) => [file, createHash('sha256').update(readFileSync(path.join(ROOT, file))).digest('hex')]));
  const summary = { renderer: 'offline SVG Canvas2D recorder + sharp rasterization', recorder: { canvas2d: 'path/text/style subset used by production drawOverlay', measureText: 'bounded character-width approximation; not browser font metrics' }, baselineCommit: BASELINE_COMMIT, afterSourceHashes, run, frame: spec.frames[0], frameSha256: createHash('sha256').update(frameBytes).digest('hex'), manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), coastSha256: createHash('sha256').update(coastBytes).digest('hex'), cameras: Object.fromEntries(['world', 'asia', 'andes', 'australia'].map((scene) => [scene, cameraFor(scene)])), sourceGrid: { nx, ny, stepDeg: step }, renderGrid: { nx, ny, stepDeg: step, method: 'full published frame' }, scenes: ['world', 'asia', 'andes', 'australia'], themes: ['light', 'dark'], outputs, comparisons, baselineLand: 'rasterLand/landGrid algorithm with the real coastline, rasterised by libvips', terrain: { included: false, reason: 'DEM tiles are absent offline; no terrain was fabricated.' }, traffic: { included: false, reason: 'Traffic comparison omitted from this recorder; verify production density dots in browser.' }, browserEvidence: false, caveat: 'These PNGs are offline renderer comparisons, not browser screenshots; verify DEM appearance, browser compositing, terrain, wind and traffic in a live browser.' };
  writeFileSync(path.join(OUT, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(path.join(OUT, 'README.md'), `# Global generalisation offline comparisons\n\nGenerated by web/scripts/render-global-generalise.ts using the full published ${spec.frames[0]} MSLP frame for run ${run} and real coastline. Before and after both call production drawOverlay/contourPressure; baseline source is extracted from commit ${BASELINE_COMMIT}.\n\nThese are offline SVG-recorder comparisons rasterized with sharp, not browser screenshots. Text width uses a bounded character-width approximation rather than browser font metrics. The baseline receives its real coastline land mask (rasterLand/landGrid logic rasterised by libvips), preserving its former pressure-noise heuristic. Comparison sheets have before on the left, after on the right, light above dark. Terrain is deliberately absent because DEM tiles are not available without network access. Wind and traffic are omitted from this recorder. Every view uses one equirectangular projection and a camera matching the 1280×640 viewport aspect. Verify terrain, browser compositing, wind and traffic in a live browser.\n`);
}

await main();
