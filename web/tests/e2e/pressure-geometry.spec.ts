import { expect, test } from '@playwright/test';
import { build } from 'esbuild';

let script: string;

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import { createGlChart } from './src/lib/gl-chart';
        import { globalEquirectangular } from './src/lib/lambert';
        const view = (nx, ny) => ({
          centerX: 0, centerY: 0, halfWidth: 180, halfHeight: 90,
          lambert: globalEquirectangular(), west: -180, north: 90,
          dlon: 360 / nx, dlat: -180 / (ny - 1), nx, ny, blend: 0,
          field: 'none', scale: 1, offset: 0, fill: 65535,
          pressure: true, pressureSpan: 24, pressureDpr: 1, wrapsLongitude: true,
        });
        const plate = (chart, nextView) => {
          chart.requestPlate();
          chart.draw(nextView);
          const shot = chart.takePlate();
          if (!shot) throw new Error('plate unavailable');
          return { width: shot.width, height: shot.height, data: Array.from(shot.data) };
        };
        const make = (width, height, values, nx, ny) => {
          const canvas = document.createElement('canvas');
          document.body.appendChild(canvas);
          const chart = createGlChart(canvas);
          if (!chart) throw new Error('WebGL2 unavailable');
          chart.resize(width, height);
          chart.setFrames(new Uint16Array(nx * ny), new Uint16Array(nx * ny), nx, ny);
          chart.setPressure(values, nx, ny);
          return { chart, view: view(nx, ny) };
        };
        const row = (shot, y) => shot.data.slice(y * shot.width * 4, (y + 1) * shot.width * 4);
        const darkColumns = (shot, y) => {
          const pixels = row(shot, y), out = [];
          for (let x = 0; x < shot.width; x++) {
            const i = x * 4;
            if (pixels[i] < 225 && pixels[i + 1] < 235 && pixels[i + 2] < 240) out.push(x);
          }
          return out;
        };
        const diff = (a, b) => {
          let count = 0;
          for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) count++;
          return count;
        };
        globalThis.PressureGeometry = {
          renderRamp(delta, shallow, blend) {
            const nx = 720, ny = 361, width = 720, height = 360;
            const values = new Float32Array(nx * ny * 2);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
              const base = (shallow ? 1007.8 : 1000) + (i / (nx - 1)) * (shallow ? 0.4 : 32);
              const k = (j * nx + i) * 2;
              values[k] = base; values[k + 1] = base + delta;
            }
            const made = make(width, height, values, nx, ny);
            const next = { ...made.view, blend };
            const shot = plate(made.chart, next);
            made.chart.destroy();
            return { dark: darkColumns(shot, Math.floor(height / 2)), width, height };
          },
          renderConstant() {
            const nx = 720, ny = 361, width = 720, height = 360;
            const values = new Float32Array(nx * ny * 2);
            values.fill(1012);
            const made = make(width, height, values, nx, ny);
            const shot = plate(made.chart, made.view);
            let totalDark=0;
            for(let y=0;y<height;y++)totalDark+=darkColumns(shot,y).length;
            made.chart.destroy();
            return { totalDark, dark: darkColumns(shot, Math.floor(height / 2)) };
          },
          renderMissingBlock() {
            const nx = 720, ny = 361, width = 720, height = 360;
            const values = new Float32Array(nx * ny * 2);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
              const base = 1000 + (i / (nx - 1)) * 32;
              const k = (j * nx + i) * 2;
              values[k] = base; values[k + 1] = base;
              if (i >= 330 && i < 390 && j >= 145 && j < 215) values[k] = values[k + 1] = NaN;
            }
            const made = make(width, height, values, nx, ny);
            const shot = plate(made.chart, made.view);
            made.chart.destroy();
            return { dark: darkColumns(shot, Math.floor(height / 2)), width, height };
          },
          async restore() {
            const nx = 720, ny = 361, width = 640, height = 320;
            const values = new Float32Array(nx * ny * 2);
            for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
              const k = (j * nx + i) * 2;
              values[k] = 1000 + i * 0.03 + j * 0.01;
              values[k + 1] = values[k] + 1;
            }
            const made = make(width, height, values, nx, ny);
            const before = plate(made.chart, made.view);
            const gl = document.querySelector('canvas').getContext('webgl2');
            const loss = gl && gl.getExtension('WEBGL_lose_context');
            if (!loss) return { supported: false };
            loss.loseContext();
            const lostAt = performance.now();
            while (made.chart.contextState() !== 'lost' && performance.now()-lostAt < 3000) await new Promise(r => setTimeout(r, 20));
            if(made.chart.contextState() !== 'lost')throw Error('Context did not actually become lost');
            loss.restoreContext();
            const started = performance.now();
            while (made.chart.contextState() !== 'ready' && performance.now() - started < 3000) await new Promise(r => setTimeout(r, 20));
            const after = plate(made.chart, made.view);
            return { supported: true, state: made.chart.contextState(), changed: diff(before, after), pixels: before.data.length };
          },
        };
      `,
      resolveDir: process.cwd(),
      sourcefile: 'pressure-geometry-browser.ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'PressureGeometryBundle',
    platform: 'browser',
  });
  script = result.outputFiles[0].text;
});

test.describe('pressure geometry', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 720, height: 360 });
    await page.goto('about:blank');
    await page.addScriptTag({ content: script });
  });

  test('keeps a moving linear contour at its analytic pixel position', async ({ page }) => {
    const rows = await page.evaluate(() => [0, .25, .5, .75].map(blend => ({ blend, ...((window as any).PressureGeometry.renderRamp(2, false, blend)) })));
    for (const row of rows) {
      const expected = ((1008 - (1000 + 2 * row.blend)) / 32) * row.width;
      const nearest = Math.min(...row.dark.map((x: number) => Math.abs(x - expected)));
      expect(nearest, `blend ${row.blend}`).toBeLessThanOrEqual(1.5);
    }
  });

  test('keeps a very shallow pressure ramp visible at fractional times', async ({ page }) => {
    const rows = await page.evaluate(() => [0, .5, 1].map(blend => (window as any).PressureGeometry.renderRamp(.1, true, blend)));
    for (const row of rows) expect(row.dark.length, 'shallow ramp contour').toBeGreaterThan(0);
  });

  test('does not fill a constant plateau or create horizontal seam artifacts', async ({ page }) => {
    const result = await page.evaluate(() => (window as any).PressureGeometry.renderConstant());
    expect(result.dark).toHaveLength(0);
    expect(result.totalDark).toBe(0);
  });

  test('leaves a missing block without inventing pressure ink', async ({ page }) => {
    const result = await page.evaluate(() => (window as any).PressureGeometry.renderMissingBlock());
    const y = Math.floor(result.height / 2);
    const left = (330 / 720) * result.width;
    const right = (390 / 720) * result.width;
    const inside = result.dark.filter((x: number) => x >= left && x < right);
    expect(inside).toHaveLength(0);
  });

  test('replays pressure pixels after WebGL context restoration', async ({ page }) => {
    const result = await page.evaluate(() => (window as any).PressureGeometry.restore());
    test.skip(!result.supported, 'WEBGL_lose_context unavailable');
    expect(result.state).toBe('ready');
    expect(result.changed).toBe(0);
    expect(result.pixels).toBeGreaterThan(0);
  });
});
