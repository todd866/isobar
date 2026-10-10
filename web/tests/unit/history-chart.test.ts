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
    expect((await loadHistoricalChart({event:'dday'})).initialMs).toBe(Date.parse('1944-06-06T06:00Z'));
    expect(result.chart.manifest.attribution[0]?.source).toBe('fixture');
    fetcher.mockRestore();
  });

  it('opens Everest on the summit date and honours another available day', async () => {
    const frames = Array.from({length:48}, (_,i)=>({...weather.frames[i%24],time:`1953-05-${i<24?'28':'29'}T${String(i%24).padStart(2,'0')}:00Z`}));
    const archive={...weather,event:{id:'everest-1953'},frames,times:frames.map(f=>f.time)};
    const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
      const url=String(input);
      if(url.endsWith('/history/catalog.json'))return new Response(JSON.stringify({schema_version:1,collections:[{id:'everest-1953',title:'Everest',manifest:'/history/everest-test.json',days:['1953-05-28','1953-05-29'].map(date=>({date,complete:true}))}]}));
      if(url.endsWith('/history/everest-test.json'))return new Response(JSON.stringify(archive));
      if(url.endsWith('/history/world-coast.bin'))return new Response(new Uint8Array());
      throw new Error(`Unexpected request ${url}`);
    });
    try {
      expect((await loadHistoricalChart({event:'everest-1953'})).day.date).toBe('1953-05-29');
      expect((await loadHistoricalChart({event:'everest-1953',date:'1953-05-28'})).day.date).toBe('1953-05-28');
    } finally {fetcher.mockRestore();}
  });

  it('rejects invalid hours and oversized archives', async () => {
    expect(() => historicalToChart({ ...weather, frames: Array.from({ length: 169 }, (_, index) => weather.frames[index % 24]!) }, { rings: [] })).toThrow('too many frames');
    await expect(loadHistoricalChart({ hour: 24 })).rejects.toThrow('0–23');
  });
});

it('opens Katrina at landfall and keeps the cyclone through the last available hour',async()=>{
 const frames=Array.from({length:48},(_,i)=>({...weather.frames[i%24],time:`2005-08-${i<24?'28':'29'}T${String(i%24).padStart(2,'0')}:00Z`}));
 const archive={...weather,event:{id:'katrina-2005'},times:frames.map(f=>f.time),frames,cyclone:{method:'compact-vortex-v1',rmwKm:55,profile:{exponent:1.75,blendStartKm:370,blendEndKm:600},source:'https://www.nhc.noaa.gov/data/tcr/AL122005_Katrina.pdf',track:[{time:'2005-08-28T00:00Z',lat:24.8,lon:-85.9,windKt:100,pressureHpa:941},{time:'2005-08-30T00:00Z',lat:32.6,lon:-89.1,windKt:50,pressureHpa:961}]}};
 const fetcher=vi.spyOn(globalThis,'fetch').mockImplementation(async input=>{
  const url=String(input);
  if(url.endsWith('/history/catalog.json'))return new Response(JSON.stringify({collections:[{id:'katrina-2005',title:'Katrina',manifest:'/history/katrina-test.json',days:['2005-08-28','2005-08-29'].map(date=>({date,complete:true}))}]}));
  if(url.endsWith('/history/katrina-test.json'))return new Response(JSON.stringify(archive));
  if(url.endsWith('/history/world-coast.bin'))return new Response(new Uint8Array());
  throw Error(`unexpected request ${url}`);
 });
 try{
  const result=await loadHistoricalChart({event:'katrina-2005'});
  expect(result.initialMs).toBe(Date.parse('2005-08-29T11:00Z'));
  expect(result.chart.cyclone?.profile?.blendEndKm).toBe(600);
  const end=await loadHistoricalChart({event:'katrina-2005',date:'2005-08-29',hour:23});
  expect(end.initialMs).toBe(Date.parse('2005-08-29T23:00Z'));
  expect(end.chart.cyclone?.track.at(-1)?.time).toBe('2005-08-30T00:00Z');
 }finally{fetcher.mockRestore();}
});
