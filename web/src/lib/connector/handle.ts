/**
 * Public weather connector. REST and MCP both call the fast-lane tools.
 * No model client is imported here.
 */

import { clientIp } from '../chat/identity';
import { PUBLIC_TOOL_NAMES, publicToolSpecs, runTool, type PublishedChart, type ToolContext } from '../chat/tools';
import { coarsePoint, type ConnectorUsage, type LimitVerdict } from './limits';
import { CONNECTOR_ATTRIBUTION, cacheHeaders, runCacheSeconds } from './meta';
import { openApiDocument } from './openapi';
import { isTestTraffic } from '../usage/test-traffic';

const CLOSED: ToolContext = { archive: false, async queueArchive() { return false; } };
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18']);
const NEWEST_PROTOCOL = '2025-06-18';
const INSTRUCTIONS = 'Read-only published weather. Tools: sample_field (mslp hPa, rain mm, wind kt, temp C), point_profile (Open-Meteo, non-commercial, CC BY 4.0), aerodrome_weather, run_info, find_place. Missing values are null. ECMWF CC BY 4.0. Open-Meteo CC BY 4.0. aviationweather.gov.';

export interface ConnectorDeps {
  chart: PublishedChart;
  now: Date;
  limit(ip: string): Promise<LimitVerdict>;
  log(event: ConnectorUsage): Promise<void>;
}

type Mode = 'json' | 'sse';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function runStamp(chart: PublishedChart): string | null {
  return chart.manifest.run || null;
}

function generated(chart: PublishedChart): string | null {
  return chart.manifest.generated || null;
}

function send(mode: Mode, body: unknown, status = 200, cache = 'no-store', extra?: Record<string, string>): Response {
  const headers = new Headers(extra);
  headers.set('cache-control', cache);
  if (mode === 'sse') {
    headers.set('content-type', 'text/event-stream');
    return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status, headers });
  }
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function cached(body: unknown, seconds: number): Response {
  return send('json', body, 200, cacheHeaders(seconds)['cache-control'], {
    'vercel-cdn-cache-control': cacheHeaders(seconds)['vercel-cdn-cache-control'],
  });
}

function age(deps: ConnectorDeps): number {
  return runCacheSeconds(deps.chart.manifest.run, deps.now.getTime());
}

const emptyReading = {
  units: null,
  validTime: null,
  runId: null as string | null,
  provenance: null,
  attribution: CONNECTOR_ATTRIBUTION,
};

function rpcError(id: string | number | null, code: number, message: string) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, data: emptyReading },
  };
}

async function gate(request: Request, deps: ConnectorDeps, kind: 'api' | 'mcp', mode: Mode = 'json'): Promise<Response | null> {
  let verdict: LimitVerdict;
  try {
    verdict = await deps.limit(clientIp(request));
  } catch {
    verdict = 'minute';
  }
  if (verdict === 'ok') return null;
  const retry = verdict === 'day' ? '3600' : '60';
  if (kind === 'mcp') return send(mode, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'slow', data: emptyReading } }, 429, 'no-store', { 'retry-after': retry });
  return send('json', { error: 'slow', ...emptyReading }, 429, 'no-store', { 'retry-after': retry });
}

async function note(request: Request, deps: ConnectorDeps, event: ConnectorUsage): Promise<void> {
  if (isTestTraffic(request)) return;
  try { await deps.log(event); } catch { /* the reading still returns */ }
}

function bad(chart: PublishedChart): Response {
  return send('json', { error: 'missing argument', ...emptyReading, runId: runStamp(chart) }, 400);
}

function utcStamp(raw: string | null): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(text)) return null;
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function reading(result: unknown): { value: number | null; from: number | null; units: string | null } {
  const row = isRecord(result) ? result : {};
  return {
    value: typeof row.value === 'number' && Number.isFinite(row.value) ? row.value : null,
    from: typeof row.from === 'number' && Number.isFinite(row.from) ? row.from : null,
    units: typeof row.units === 'string' ? row.units : null,
  };
}

function profileView(result: unknown): { surface: unknown; levels: unknown; provenance: unknown } {
  const row = isRecord(result) ? result : {};
  if (typeof row.error === 'string') return { surface: null, levels: null, provenance: null };
  return {
    surface: row.surface ?? null,
    levels: row.levels ?? null,
    provenance: isRecord(row.provenance) ? row.provenance : null,
  };
}

function withReading(chart: PublishedChart, result: unknown, validTime: string | null, provenance: Record<string, unknown>): Record<string, unknown> {
  const row = isRecord(result) ? result : { value: null };
  return {
    ...row,
    units: 'units' in row ? row.units ?? null : null,
    validTime,
    runId: runStamp(chart),
    provenance,
    attribution: CONNECTOR_ATTRIBUTION,
  };
}

function provenanceFor(name: string, output: unknown, chart: PublishedChart): Record<string, unknown> {
  const row = isRecord(output) ? output : {};
  if (isRecord(row.provenance)) return row.provenance;
  const base = { runId: runStamp(chart), generated: generated(chart) };
  if (name === 'aerodrome_weather') return { source: 'aviationweather.gov', ...base };
  if (name === 'find_place') return { source: 'Isobar places', ...base };
  return { source: 'ECMWF', licence: 'CC BY 4.0', ...base };
}

function argsPoint(args: Record<string, unknown>): { lat: number; lon: number } | undefined {
  if (typeof args.lat !== 'number' || typeof args.lon !== 'number') return undefined;
  return { lat: args.lat, lon: args.lon };
}

function locate(result: unknown, fallback?: { lat: number; lon: number }): { lat: number | null; lon: number | null } {
  if (fallback) return coarsePoint(fallback.lat, fallback.lon);
  const row = isRecord(result) ? result : {};
  if (typeof row.lat === 'number' && typeof row.lon === 'number') return coarsePoint(row.lat, row.lon);
  if (Array.isArray(row.matches) && isRecord(row.matches[0])) {
    const match = row.matches[0];
    if (typeof match.lat === 'number' && typeof match.lon === 'number') return coarsePoint(match.lat, match.lon);
  }
  return { lat: null, lon: null };
}

export function publicOrigin(request: Request): string {
  const url = new URL(request.url);
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? url.host).split(',')[0].trim();
  const proto = (request.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')).split(',')[0].trim() || 'https';
  if (!host) return 'https://isobar.md';
  return `${proto}://${host}`;
}

export async function handlePoint(request: Request, deps: ConnectorDeps): Promise<Response> {
  const limited = await gate(request, deps, 'api');
  if (limited) return limited;
  const params = new URL(request.url).searchParams;
  const lat = numberParam(params.get('lat'));
  const lon = numberParam(params.get('lon'));
  const timeUtc = utcStamp(params.get('time'));
  if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180 || !timeUtc) return bad(deps.chart);
  const input = { lat, lon, timeUtc };
  const [mslp, rain, wind, temp, profile] = await Promise.all([
    runTool('sample_field', { var: 'mslp', ...input }, deps.chart, CLOSED),
    runTool('sample_field', { var: 'rain', ...input }, deps.chart, CLOSED),
    runTool('sample_field', { var: 'wind', ...input }, deps.chart, CLOSED),
    runTool('sample_field', { var: 'temp', ...input }, deps.chart, CLOSED),
    runTool('point_profile', input, deps.chart, CLOSED),
  ]);
  const pressure = reading(mslp);
  const rainReading = reading(rain);
  const windReading = reading(wind);
  const tempReading = reading(temp);
  const viewed = profileView(profile);
  const id = runStamp(deps.chart);
  const body = {
    lat,
    lon,
    time: timeUtc,
    validTime: timeUtc,
    runId: id,
    units: {
      mslp: pressure.units ?? 'hPa',
      rain: rainReading.units ?? 'mm',
      wind: windReading.units ?? 'kt',
      windFrom: 'deg',
      temp: tempReading.units ?? 'C',
    },
    mslp: pressure.value,
    rain: rainReading.value,
    wind: windReading.value,
    windFrom: windReading.from,
    temp: tempReading.value,
    profile: viewed,
    provenance: {
      fields: 'ECMWF',
      profile: 'Open-Meteo',
      licence: 'CC BY 4.0',
      runId: id,
      generated: generated(deps.chart),
      profileRun: isRecord(viewed.provenance) && typeof viewed.provenance.run === 'string' ? viewed.provenance.run : null,
    },
    attribution: CONNECTOR_ATTRIBUTION,
  };
  await note(request, deps, { kind: 'api', tool: 'point_profile', ...coarsePoint(lat, lon) });
  return cached(body, age(deps));
}

function numberParam(raw: string | null): number | null {
  if (raw == null || !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export async function handleAerodrome(request: Request, icao: string, deps: ConnectorDeps): Promise<Response> {
  const limited = await gate(request, deps, 'api');
  if (limited) return limited;
  const code = icao.trim().toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return bad(deps.chart);
  const result = await runTool('aerodrome_weather', { icao: code }, deps.chart, CLOSED);
  const row = isRecord(result) ? result : {};
  const id = runStamp(deps.chart);
  const body = {
    icao: code,
    name: typeof row.name === 'string' ? row.name : null,
    lat: typeof row.lat === 'number' ? row.lat : null,
    lon: typeof row.lon === 'number' ? row.lon : null,
    metar: row.metar ?? null,
    taf: row.taf ?? null,
    units: null,
    validTime: null,
    runId: id,
    provenance: { source: 'aviationweather.gov', runId: id, generated: generated(deps.chart) },
    attribution: CONNECTOR_ATTRIBUTION,
  };
  await note(request, deps, { kind: 'api', tool: 'aerodrome_weather', ...locate(result) });
  return cached(body, age(deps));
}

export async function handlePlace(request: Request, deps: ConnectorDeps): Promise<Response> {
  const limited = await gate(request, deps, 'api');
  if (limited) return limited;
  const query = new URL(request.url).searchParams.get('q');
  if (query == null || !query.trim() || query.trim().length > 80) return bad(deps.chart);
  const name = query.trim();
  const result = await runTool('find_place', { name }, deps.chart, CLOSED);
  const row = isRecord(result) ? result : {};
  const id = runStamp(deps.chart);
  const body = {
    query: name,
    matches: Array.isArray(row.matches) ? row.matches : [],
    units: null,
    validTime: null,
    runId: id,
    provenance: { source: 'Isobar places', runId: id, generated: generated(deps.chart) },
    attribution: CONNECTOR_ATTRIBUTION,
  };
  await note(request, deps, { kind: 'api', tool: 'find_place', ...locate(result) });
  return cached(body, age(deps));
}

export async function handleRun(request: Request, deps: ConnectorDeps): Promise<Response> {
  const limited = await gate(request, deps, 'api');
  if (limited) return limited;
  const result = await runTool('run_info', {}, deps.chart, CLOSED);
  const row = isRecord(result) ? result : {};
  const id = runStamp(deps.chart);
  const body = {
    ...row,
    units: null,
    validTime: typeof row.timeUtc === 'string' ? row.timeUtc : id,
    runId: id,
    provenance: { source: 'ECMWF', licence: 'CC BY 4.0', runId: id, generated: generated(deps.chart) },
    attribution: CONNECTOR_ATTRIBUTION,
  };
  await note(request, deps, { kind: 'api', tool: 'run_info', lat: null, lon: null });
  return cached(body, age(deps));
}

export async function handleOpenApi(request: Request, deps: ConnectorDeps): Promise<Response> {
  const limited = await gate(request, deps, 'api');
  if (limited) return limited;
  await note(request, deps, { kind: 'api', tool: 'openapi', lat: null, lon: null });
  return cached(openApiDocument(publicOrigin(request)), age(deps));
}

function acceptMode(request: Request): Mode | 'none' {
  const header = request.headers.get('accept');
  if (!header) return 'json';
  const types = header.split(',').map((part) => part.split(';')[0].trim().toLowerCase());
  if (types.includes('application/json') || types.includes('*/*')) return 'json';
  if (types.includes('text/event-stream')) return 'sse';
  return 'none';
}

function originBlocked(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return true; }
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').split(',')[0].trim();
  if (host && parsed.host === host) return false;
  if (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1') return false;
  if (origin === 'https://isobar.md') return false;
  return true;
}

function mcpTools() {
  return publicToolSpecs().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.input_schema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: tool.name === 'point_profile',
    },
  }));
}

function toolResult(payload: Record<string, unknown>, isError: boolean) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError,
  };
}

function rpcId(value: unknown): string | number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || value === null) return value;
  return undefined;
}

export async function handleMcp(request: Request, deps: ConnectorDeps): Promise<Response> {
  if (request.method !== 'POST') {
    const limited = await gate(request, deps, 'mcp');
    if (limited) return limited;
    return new Response(null, { status: 405, headers: { allow: 'POST', 'cache-control': 'no-store' } });
  }
  const mode = acceptMode(request);
  if (mode === 'none') return send('json', rpcError(null, -32000, 'not acceptable'), 406);
  const limited = await gate(request, deps, 'mcp', mode);
  if (limited) return limited;
  if (originBlocked(request)) return send(mode, rpcError(null, -32000, 'origin'), 403);
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return send(mode, rpcError(null, -32600, 'content type'), 415);
  let message: unknown;
  try { message = await request.json(); } catch { return send(mode, rpcError(null, -32700, 'parse error'), 400); }
  if (!isRecord(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return send(mode, rpcError(null, -32600, 'invalid request'), 400);
  }
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  if (!hasId) return new Response(null, { status: 202, headers: { 'cache-control': 'no-store' } });
  const id = rpcId(message.id);
  if (id === undefined) return send(mode, rpcError(null, -32600, 'invalid request'), 400);
  const headerVersion = request.headers.get('mcp-protocol-version');
  if (message.method !== 'initialize' && headerVersion && !PROTOCOL_VERSIONS.has(headerVersion)) {
    return send(mode, rpcError(id, -32600, 'protocol'), 400);
  }
  if (message.method === 'ping') return send(mode, { jsonrpc: '2.0', id, result: {} });
  if (message.method === 'initialize') {
    const params = isRecord(message.params) ? message.params : {};
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = PROTOCOL_VERSIONS.has(requested) ? requested : NEWEST_PROTOCOL;
    await note(request, deps, { kind: 'mcp', tool: 'initialize', lat: null, lon: null });
    return send(mode, {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'isobar', title: 'Isobar weather', version: '1' },
        instructions: INSTRUCTIONS,
        attribution: CONNECTOR_ATTRIBUTION,
      },
    });
  }
  if (message.method === 'tools/list') {
    await note(request, deps, { kind: 'mcp', tool: 'tools/list', lat: null, lon: null });
    return send(mode, { jsonrpc: '2.0', id, result: { tools: mcpTools(), attribution: CONNECTOR_ATTRIBUTION } });
  }
  if (message.method === 'tools/call') {
    const params = isRecord(message.params) ? message.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = (PUBLIC_TOOL_NAMES as readonly string[]).includes(name);
    if (!known) {
      const payload = withReading(deps.chart, { error: 'unknown tool' }, null, provenanceFor(name, {}, deps.chart));
      await note(request, deps, { kind: 'mcp', tool: name.slice(0, 80) || 'unknown', lat: null, lon: null });
      return send(mode, { jsonrpc: '2.0', id, result: toolResult(payload, true) });
    }
    const output = await runTool(name, args, deps.chart, CLOSED);
    const failed = isRecord(output) && typeof output.error === 'string';
    const validTime = isRecord(output) && typeof output.timeUtc === 'string' ? output.timeUtc : null;
    const payload = withReading(deps.chart, output, validTime, provenanceFor(name, output, deps.chart));
    const where = locate(output, name === 'sample_field' || name === 'point_profile' ? argsPoint(args) : undefined);
    await note(request, deps, { kind: 'mcp', tool: name, ...where });
    return send(mode, { jsonrpc: '2.0', id, result: toolResult(payload, failed) });
  }
  return send(mode, rpcError(id, -32601, 'method not found'));
}
