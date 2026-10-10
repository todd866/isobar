import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/openmeteo-point.json';
import type { ChartManifest } from '../../src/lib/manifest';
import { chartFromDir, publishedPointProfile } from '../../src/lib/chat/data';
import { PUBLIC_TOOL_NAMES, type PublishedChart } from '../../src/lib/chat/tools';
import {
  handleAerodrome, handleMcp, handleOpenApi, handlePlace, handlePoint, handleRun, type ConnectorDeps,
} from '../../src/lib/connector/handle';
import { CONNECTOR_LIMITS, connectorEvent, createLimiter, type ConnectorUsage } from '../../src/lib/connector/limits';
import { CONNECTOR_ATTRIBUTION, runCacheSeconds } from '../../src/lib/connector/meta';
import { openApiDocument } from '../../src/lib/connector/openapi';
import { clearPointCache } from '../../src/lib/point/openmeteo';
import { CONNECTOR_EVENT_KINDS, USAGE_KINDS, sanitizeBatch } from '../../src/lib/usage/events';

const manifest: ChartManifest = {
  schema: 2, contract: 'isobar-web', run: '2026-10-08T00:00:00Z', generated: '2026-10-08T05:10:00Z',
  forecastHours: [0, 3], uniformStepHours: 3, nx: 3, ny: 3, west: 115, east: 117, north: -31, south: -33,
  step: 1, wrapsLongitude: false, dtype: 'uint16',
  variables: { mslp: { file: null, frames: ['a', 'b'], encoding: 'raw', units: 'hPa', scale: 0.1, offset: 900, fill: 65535 } },
  places: [{ id: 'perth', name: 'Perth', zone: 'Australia/Perth', lat: -31.95, lon: 115.97, icao: 'YPPH' }],
  aviation: 'aviation.json', points: null, attribution: [],
};

const NOW = new Date('2026-10-08T02:00:00Z');
const IP = '203.0.113.10';

function chart(): PublishedChart {
  const frame = new Float32Array(9);
  frame[4] = 1013.25;
  return {
    manifest,
    frame: (variable, index) => variable === 'mslp' && index === 0 ? frame : null,
    points: null,
    aviation: { airports: [{ icao: 'YPPH', name: 'Perth', lat: -31.95, lon: 115.97, metar: { raw: 'METAR YPPH 080300Z 22013KT' }, taf: null }] },
    sky: null,
    places: [['Perth', -31.95, 115.97, 2, 'WA'], ['Sydney', -33.87, 151.21, 1, 'NSW']],
    profile: async () => ({
      surface: { temperature2mC: 18, dewPoint2mC: null, windSpeed10mKt: null, windDirection10m: null, cloudCoverPct: null, precipitationMm: null, surfacePressureHpa: 1013.2 },
      levels: null,
      provenance: { source: 'Open-Meteo', model: 'ecmwf_ifs025', run: '2026-10-08T00:00:00Z', cycle: true },
    }),
  };
}

function deps(limit: ConnectorDeps['limit'] = async () => 'ok', log: ConnectorUsage[] = []): ConnectorDeps {
  return { chart: chart(), now: NOW, limit, log: async (event) => { log.push(event); } };
}

function get(path: string, ip = IP): Request {
  return new Request(`https://isobar.md${path}`, { headers: { 'x-forwarded-for': ip } });
}

function mcp(body: unknown, ip = IP, headers: Record<string, string> = {}): Request {
  return new Request('https://isobar.md/api/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': ip,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearPointCache();
});

describe('public weather connector', () => {
  it('keeps rate limiting for marked checks while dropping API and MCP usage rows', async () => {
    const log: ConnectorUsage[] = [];
    let limited = 0;
    const marked = (url: string, init?: RequestInit) => new Request(url, { ...init, headers: { ...(init?.headers ?? {}), 'isobar-test': '1', 'x-forwarded-for': IP } });
    const used = deps(async () => { limited++; return 'ok'; }, log);
    const point = await handlePoint(marked('https://isobar.md/api/v1/weather/point?lat=-32&lon=116&time=2026-10-08T00:00:00Z'), used);
    expect(point.status).toBe(200);
    const started = await handleMcp(marked('https://isobar.md/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(init) }), used);
    expect(started.status).toBe(200);
    expect(limited).toBe(2);
    expect(log).toEqual([]);
  });

  it('returns fixture weather with units, run, provenance and attribution, and nulls for gaps', async () => {
    const log: ConnectorUsage[] = [];
    const point = await handlePoint(get('/api/v1/weather/point?lat=-32&lon=116&time=2026-10-08T00:00:00Z'), deps(async () => 'ok', log));
    expect(point.status).toBe(200);
    expect(point.headers.get('cache-control')).toBe('public, max-age=60, s-maxage=21600');
    expect(point.headers.get('vercel-cdn-cache-control')).toBe('public, s-maxage=21600');
    const body = await point.json() as Record<string, unknown>;
    expect(body.mslp).toBe(1013.3);
    expect(body.rain).toBeNull();
    expect(body.wind).toBeNull();
    expect(body.windFrom).toBeNull();
    expect(body.temp).toBeNull();
    expect(body.units).toMatchObject({ mslp: 'hPa', rain: 'mm', wind: 'kt', windFrom: 'deg', temp: 'C' });
    expect(body.validTime).toBe('2026-10-08T00:00:00.000Z');
    expect(body.runId).toBe('2026-10-08T00:00:00Z');
    expect(body.provenance).toMatchObject({ fields: 'ECMWF', profile: 'Open-Meteo', licence: 'CC BY 4.0', profileRun: '2026-10-08T00:00:00Z' });
    expect(body.attribution).toEqual(CONNECTOR_ATTRIBUTION);
    expect((body.profile as { surface: { temperature2mC: number } }).surface.temperature2mC).toBe(18);
    expect(log).toEqual([{ kind: 'api', tool: 'point_profile', lat: -32, lon: 116 }]);
    expect(JSON.stringify(log)).not.toContain(IP);

    const gap = await handlePoint(get('/api/v1/weather/point?lat=-32&lon=116&time=2026-10-08T03:00:00Z'), deps());
    expect((await gap.json() as { mslp: number | null }).mslp).toBeNull();
    const outside = await handlePoint(get('/api/v1/weather/point?lat=0&lon=0&time=2026-10-08T00:00:00Z'), deps());
    expect((await outside.json() as { mslp: unknown }).mslp).toBeNull();
    expect((await handlePoint(get('/api/v1/weather/point?lat=-32&lon=116&time=2026-10-08T00:00:00'), deps())).status).toBe(400);
    const bad = await (await handlePoint(get('/api/v1/weather/point?lat=99&lon=116&time=2026-10-08T00:00:00Z'), deps())).json() as { mslp?: number; attribution: unknown; units: null };
    expect(bad.mslp).toBeUndefined();
    expect(bad.units).toBeNull();
    expect(bad.attribution).toEqual(CONNECTOR_ATTRIBUTION);
  });

  it('serves an aerodrome, a place and the run from the same tools', async () => {
    const log: ConnectorUsage[] = [];
    const used = deps(async () => 'ok', log);
    const perth = await (await handleAerodrome(get('/api/v1/weather/aerodrome/YPPH'), 'ypph', used)).json() as { icao: string; metar: { raw: string }; taf: null; attribution: unknown };
    expect(perth.icao).toBe('YPPH');
    expect(perth.metar.raw).toContain('YPPH');
    expect(perth.taf).toBeNull();
    expect(perth.attribution).toEqual(CONNECTOR_ATTRIBUTION);
    const missing = await (await handleAerodrome(get('/api/v1/weather/aerodrome/YSSY'), 'yssy', used)).json() as { name: null; metar: null; taf: null; lat: null };
    expect(missing).toMatchObject({ name: null, metar: null, taf: null, lat: null });
    expect((await handleAerodrome(get('/api/v1/weather/aerodrome/YPP'), 'YPP', used)).status).toBe(400);

    const places = await (await handlePlace(get('/api/v1/weather/place?q=Perth'), used)).json() as { matches: { name: string }[]; units: null; validTime: null };
    expect(places.matches[0].name).toBe('Perth');
    expect(places.units).toBeNull();
    expect(places.validTime).toBeNull();
    expect((await handlePlace(get('/api/v1/weather/place?q=zzz'), used)).status).toBe(200);
    expect((await (await handlePlace(get('/api/v1/weather/place?q=zzz'), used)).json() as { matches: unknown[] }).matches).toEqual([]);
    expect((await handlePlace(get('/api/v1/weather/place'), used)).status).toBe(400);

    const run = await (await handleRun(get('/api/v1/run'), used)).json() as { runId: string; hours: number[]; validTime: string; attribution: unknown };
    expect(run.runId).toBe(manifest.run);
    expect(run.hours).toEqual([0, 3]);
    expect(run.validTime).toBe(manifest.run);
    expect(run.attribution).toEqual(CONNECTOR_ATTRIBUTION);
    expect(JSON.stringify(log)).not.toContain('Perth');
    expect(JSON.stringify(log)).not.toContain(IP);
    expect(log.map((event) => event.tool)).toEqual(['aerodrome_weather', 'aerodrome_weather', 'find_place', 'find_place', 'find_place', 'run_info']);
    expect(log[0]).toMatchObject({ lat: -32, lon: 116 });
    expect(log[2]).toMatchObject({ kind: 'api', tool: 'find_place', lat: -32, lon: 116 });
  });

  it('publishes an OpenAPI 3.1 document for a custom GPT action', async () => {
    const doc = openApiDocument('https://isobar.md/');
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0].url).toBe('https://isobar.md');
    expect(doc.info.description).toMatch(/non-commercial/i);
    const ids = Object.values(doc.paths).map((item) => item.get.operationId);
    expect(ids).toEqual(['getWeatherPoint', 'getAerodromeWeather', 'findPlace', 'getRun']);
    for (const item of Object.values(doc.paths)) {
      expect(item.get.description.length).toBeGreaterThan(0);
      expect(item.get.description.length).toBeLessThan(300);
      expect(item.get['x-openai-isConsequential']).toBe(false);
      const example = item.get.responses['200'].content['application/json'].examples.sample.value as { attribution: unknown };
      expect(example.attribution).toEqual(CONNECTOR_ATTRIBUTION);
    }
    const pointExample = doc.paths['/api/v1/weather/point'].get.responses['200'].content['application/json'].examples.sample.value as { rain: unknown };
    expect(pointExample.rain).toBeNull();
    const served = await handleOpenApi(get('/api/v1/openapi.json', '203.0.113.40'), deps());
    expect(served.status).toBe(200);
    expect((await served.json() as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('speaks stateless MCP initialize, tools/list and tools/call', async () => {
    const log: ConnectorUsage[] = [];
    const used = deps(async () => 'ok', log);
    const started = await handleMcp(mcp(init, '203.0.113.50', { 'mcp-session-id': 'ignore-me' }), used);
    expect(started.status).toBe(200);
    expect(started.headers.get('mcp-session-id')).toBeNull();
    expect(started.headers.get('cache-control')).toBe('no-store');
    const hello = await started.json() as { result: { protocolVersion: string; serverInfo: { name: string }; instructions: string; attribution: unknown } };
    expect(hello.result.protocolVersion).toBe('2025-03-26');
    expect(hello.result.serverInfo.name).toBe('isobar');
    expect(hello.result.instructions).toMatch(/Open-Meteo/);
    expect(hello.result.attribution).toEqual(CONNECTOR_ATTRIBUTION);

    const newest = await handleMcp(mcp({ ...init, params: { ...init.params, protocolVersion: '2099-01-01' } }, '203.0.113.51'), used);
    expect((await newest.json() as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-06-18');

    const listed = await handleMcp(mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, '203.0.113.52'), used);
    const tools = (await listed.json() as { result: { tools: { name: string; description: string; inputSchema: { type: string } }[] } }).result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([...PUBLIC_TOOL_NAMES]);
    expect(tools.every((tool) => tool.description.length > 20 && tool.inputSchema.type === 'object')).toBe(true);
    expect(tools.some((tool) => tool.name === 'request_archive_analysis')).toBe(false);

    const called = await handleMcp(mcp({
      jsonrpc: '2.0', id: 'field', method: 'tools/call',
      params: { name: 'sample_field', arguments: { var: 'mslp', lat: -31.95, lon: 115.86, timeUtc: '2026-10-08T00:00:00Z' } },
    }, '203.0.113.53'), used);
    const toolBody = await called.json() as { result: { isError: boolean; structuredContent: { value: number; units: string; attribution: unknown; runId: string } } };
    expect(toolBody.result.isError).toBe(false);
    expect(toolBody.result.structuredContent.value).toBe(1013.3);
    expect(toolBody.result.structuredContent.units).toBe('hPa');
    expect(toolBody.result.structuredContent.runId).toBe(manifest.run);
    expect(toolBody.result.structuredContent.attribution).toEqual(CONNECTOR_ATTRIBUTION);

    const banned = await handleMcp(mcp({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'request_archive_analysis', arguments: { question: 'why' } },
    }, '203.0.113.54'), used);
    const denied = await banned.json() as { result: { isError: boolean; structuredContent: { error: string } } };
    expect(denied.result.isError).toBe(true);
    expect(denied.result.structuredContent.error).toBe('unknown tool');

    const noted = await handleMcp(mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, '203.0.113.55'), used);
    expect(noted.status).toBe(202);
    expect((await handleMcp(new Request('https://isobar.md/api/mcp', { method: 'GET', headers: { 'x-forwarded-for': '203.0.113.56' } }), used)).status).toBe(405);
    const stream = await handleMcp(mcp(init, '203.0.113.57', { accept: 'text/event-stream' }), used);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(await stream.text()).toContain('"protocolVersion":"2025-03-26"');
    expect((await handleMcp(mcp(init, '203.0.113.58', { origin: 'https://evil.example' }), used)).status).toBe(403);
    expect((await handleMcp(mcp(init, '203.0.113.59', { origin: 'https://isobar.md' }), used)).status).toBe(200);
    expect(JSON.stringify(log)).not.toContain('203.0.113');
    expect(log.find((event) => event.tool === 'sample_field')).toMatchObject({ kind: 'mcp', lat: -32, lon: 116 });
  });

  it('does not call a paid model from any connector endpoint', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('no network')));
    vi.stubGlobal('fetch', fetchMock);
    const used = deps();
    await handlePoint(get('/api/v1/weather/point?lat=-32&lon=116&time=2026-10-08T00:00:00Z'), used);
    await handleAerodrome(get('/api/v1/weather/aerodrome/YPPH'), 'YPPH', used);
    await handlePlace(get('/api/v1/weather/place?q=Perth'), used);
    await handleRun(get('/api/v1/run'), used);
    await handleOpenApi(get('/api/v1/openapi.json'), used);
    await handleMcp(mcp(init), used);
    await handleMcp(mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), used);
    await handleMcp(mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'point_profile', arguments: { lat: -32, lon: 116, timeUtc: '2026-10-08T00:00:00Z' } } }), used);
    expect(fetchMock).not.toHaveBeenCalled();

    const banned = /api\.anthropic\.com|api\.openai\.com|ANTHROPIC_API_KEY|OPENAI_API|completeAnthropic|chat\/anthropic/;
    const files = [
      ...walk('src/lib/connector'),
      ...walk('src/app/api/v1'),
      ...walk('src/app/api/mcp'),
      ...walk('src/app/connect'),
      'src/lib/chat/data.ts',
    ];
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
  });

  it('caches the Open-Meteo profile and does not call a model host', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(fixture), { status: 200, headers: { 'content-type': 'application/json' } }));
    });
    const first = await publishedPointProfile(-31.95, 115.86, '2026-10-08T06:00:00Z') as { missing: boolean; provenance: { source?: string } | null };
    const second = await publishedPointProfile(-31.95, 115.86, '2026-10-08T09:00:00Z') as { missing: boolean };
    expect(first.missing).toBe(false);
    expect(first.provenance?.source).toBe('Open-Meteo');
    expect(second.missing).toBe(false);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('https://api.open-meteo.com/');
    expect(urls.join(' ')).not.toMatch(/anthropic|openai/i);
    const loaded = chartFromDir(join('src', 'missing-chart-dir'), join('src', 'missing-places.json'), join('src', 'missing-release.json'));
    expect(loaded.chart.profile).toBe(publishedPointProfile);
  });

  it('limits an address to 30 a minute and 2,000 a day, shared by REST and MCP', async () => {
    expect(CONNECTOR_LIMITS.connectorIp).toEqual({ max: 30, windowMs: 60_000 });
    expect(CONNECTOR_LIMITS.connectorIpDay).toEqual({ max: 2_000, windowMs: 24 * 60 * 60_000 });
    expect(runCacheSeconds('2026-10-08T00:00:00Z', Date.parse('2026-10-08T02:00:00Z'))).toBe(6 * 60 * 60);
    expect(runCacheSeconds('2026-10-08T00:00:00Z', Date.parse('2026-10-08T13:00:00Z'))).toBe(60);
    expect(runCacheSeconds('', Date.now())).toBe(60);

    let now = 0;
    const minute = createLimiter(() => now);
    for (let n = 0; n < 30; n += 1) expect(await minute('198.51.100.5')).toBe('ok');
    expect(await minute('198.51.100.5')).toBe('minute');
    expect(await minute('198.51.100.6')).toBe('ok');
    now += 60_000;
    expect(await minute('198.51.100.5')).toBe('ok');

    now = 0;
    const day = createLimiter(() => now);
    for (let n = 0; n < 2000; n += 1) {
      if (n > 0 && n % 30 === 0) now += 60_000;
      expect(await day('198.51.100.4')).toBe('ok');
    }
    expect(await day('198.51.100.4')).toBe('day');

    const shared = createLimiter();
    const log: ConnectorUsage[] = [];
    const used = deps(shared, log);
    for (let n = 0; n < 30; n += 1) expect((await handleRun(get('/api/v1/run', '198.51.100.7'), used)).status).toBe(200);
    const blocked = await handleMcp(mcp(init, '198.51.100.7'), used);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBe('60');
    expect(blocked.headers.get('cache-control')).toContain('no-store');
    expect(log).toHaveLength(30);
    expect((await handleRun(get('/api/v1/run', '198.51.100.8'), used)).status).toBe(200);

    const slow = await handlePoint(get('/api/v1/weather/point?lat=-32&lon=116&time=2026-10-08T00:00:00Z'), deps(async () => 'day'));
    expect(slow.status).toBe(429);
    expect(slow.headers.get('retry-after')).toBe('3600');
    expect((await handleRun(get('/api/v1/run'), deps(async () => { throw new Error('db down'); }))).status).toBe(429);
    const loud: ConnectorDeps = { chart: chart(), now: NOW, limit: async () => 'ok', log: async () => { throw new Error('db down'); } };
    expect((await handleRun(get('/api/v1/run', '198.51.100.9'), loud)).status).toBe(200);
  });

  it('stores connector usage coarsely and rejects those kinds from the browser beacon', () => {
    expect(connectorEvent({ kind: 'mcp', tool: 'sample_field', lat: -31.95, lon: 115.86 })).toEqual({
      kind: 'mcp',
      payload: { tool: 'sample_field', lat: -32, lon: 116, caller: 'anonymous' },
    });
    expect(connectorEvent({ kind: 'api', tool: 'point_profile', lat: 91, lon: 10 }).payload).toMatchObject({ lat: null, lon: null, caller: 'anonymous' });
    expect(Object.keys(connectorEvent({ kind: 'api', tool: 'run_info', lat: null, lon: null }).payload).sort()).toEqual(['caller', 'lat', 'lon', 'tool']);
    for (const kind of CONNECTOR_EVENT_KINDS) expect(USAGE_KINDS).not.toContain(kind);
    expect(sanitizeBatch({ events: [{ kind: 'api', at: new Date().toISOString(), payload: { tool: 'run_info' } }] }, new Date())).toBeNull();
    expect(sanitizeBatch({ events: [{ kind: 'mcp', at: new Date().toISOString(), payload: { tool: 'run_info' } }] }, new Date())).toBeNull();
  });
});
