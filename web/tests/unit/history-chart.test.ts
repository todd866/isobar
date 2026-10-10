import { describe, expect, it, vi } from 'vitest';
import { chartFrame, decodeFrame } from '../../src/lib/chart-store';
import { historicalToChart, loadHistoricalChart } from '../../src/lib/history-chart';
import { normalizeWeather, type HistoricalWeather } from '../../src/lib/history';

const times = Array.from({ length: 24 }, (_, hour) => `1944-06-06T${String(hour).padStart(2, '0')}:00Z`);
const weather: HistoricalWeather = normalizeWeather({ schema_version: 1, product: 'isobar-historical-weather', units: { pressure_msl: 'hPa', u: 'knots', v: 'knots', temperature: '°C' }, grid: { latitudes: [2, 1], longitudes: [10, 11], nx: 2, ny: 2, step_degrees: 1 }, times, frames: times.map((time, index) => ({ time, pressure_msl: [1000 + index, 1001, 1002, 1003], u: [-5, 0, 5, 10], v: [0, 4, 0, 3], temperature: [10, 11, 12, 13] })), provenance: { source: 'fixture', license: 'CC-BY' } })!;

describe('historical shared chart adapter', () => {
  it('packs pressure and signed wind components without inventing fields', () => {
    const chart = historicalToChart(weather, { rings: [] });
    expect(chart.manifest.forecastHours).toHaveLength(24);
    expect(decodeFrame(chartFrame(chart, 'mslp', 0), chart.manifest.variables.mslp)[0]).toBeCloseTo(1000, 1);
    expect(decodeFrame(chartFrame(chart, 'u10', 0), chart.manifest.variables.u10)[0]).toBeCloseTo(-5, 1);
    expect(decodeFrame(chartFrame(chart, 'wind', 0), chart.manifest.variables.wind)[0]).toBeCloseTo(5, 1);
    expect(chart.aviation).toBeNull();
    expect(chart.points).toBeNull();
  });

  it('loads the default D-Day collection and selected hour without live fallback', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith('/history/catalog.json')) return new Response(JSON.stringify({ schema_version: 1, collections: [{ id: 'dday', title: 'D-Day', manifest: '/history/dday.json', days: [{ date: '1944-06-06', complete: true }] }] }));
      if (url.endsWith('/history/dday.json')) return new Response(JSON.stringify({ product: 'isobar-historical-weather', ...weather }));
      if (url.endsWith('/history/world-coast.bin')) return new Response(new Uint8Array());
      throw new Error(`unexpected live URL ${url}`);
    });
    const result = await loadHistoricalChart({ date: '1944-06-06', hour: 5 });
    expect(result.initialMs).toBe(Date.parse('1944-06-06T05:00Z'));
    expect(result.collection.id).toBe('dday');
    expect(result.chart.manifest.attribution[0]?.source).toBe('fixture');
    fetcher.mockRestore();
  });

  it('rejects invalid hours and oversized archives', async () => {
    expect(() => historicalToChart({ ...weather, frames: Array.from({ length: 169 }, (_, index) => weather.frames[index % 24]!) }, { rings: [] })).toThrow('too many frames');
    await expect(loadHistoricalChart({ hour: 24 })).rejects.toThrow('0–23');
  });
});
