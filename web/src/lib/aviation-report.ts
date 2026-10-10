/**
 * aviationweather.gov's data API does not send Access-Control-Allow-Origin, so
 * the browser asks /api/aviation and this module turns the JSON into a report.
 * A missing METAR or TAF stays missing.
 */

export interface AerodromeReport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
  metar: { raw: string; time: string | null } | null;
  taf: { raw: string; issue: string | null; from: string | null; to: string | null } | null;
}

function asIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString().replace(/\.000Z$/, 'Z') : null;
  }
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.000Z$/, 'Z') : null;
}

function firstRow(body: unknown): Record<string, unknown> | null {
  const row = Array.isArray(body) ? body[0] : null;
  return row && typeof row === 'object' ? row as Record<string, unknown> : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parseAerodromeReports(icao: string, metarBody: unknown, tafBody: unknown): AerodromeReport | null {
  const code = icao.toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return null;
  const metarRow = firstRow(metarBody);
  const tafRow = firstRow(tafBody);
  const metarRaw = typeof metarRow?.rawOb === 'string' ? metarRow.rawOb.trim() : '';
  const tafRaw = typeof tafRow?.rawTAF === 'string' ? tafRow.rawTAF.trim() : '';
  const metar = metarRaw ? { raw: metarRaw, time: asIso(metarRow?.reportTime) ?? asIso(metarRow?.obsTime) } : null;
  const taf = tafRaw ? {
    raw: tafRaw,
    issue: asIso(tafRow?.issueTime),
    from: asIso(tafRow?.validTimeFrom),
    to: asIso(tafRow?.validTimeTo),
  } : null;
  if (!metar && !taf) return null;
  const source = metarRow ?? tafRow ?? {};
  // Reports belong only to the station asked for.
  if (typeof source.icaoId === 'string' && source.icaoId.toUpperCase() !== code) return null;
  const lat = num(source.lat);
  const lon = num(source.lon);
  if (lat == null || lon == null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : code;
  return { icao: code, name, lat, lon, metar, taf };
}

export async function loadAerodromeReport(icao: string, init: { signal?: AbortSignal; fetcher?: typeof fetch } = {}): Promise<AerodromeReport | null> {
  const code = icao.toUpperCase();
  if (!/^[A-Z]{4}$/.test(code)) return null;
  const fetcher = init.fetcher ?? fetch;
  try {
    const response = await fetcher(`/api/aviation?icao=${code}`, { signal: init.signal });
    if (!response.ok) return null;
    const body = await response.json() as Partial<AerodromeReport> | null;
    if (!body || typeof body !== 'object') return null;
    if (!body.metar && !body.taf) return null;
    if (typeof body.lat !== 'number' || typeof body.lon !== 'number' || typeof body.icao !== 'string') return null;
    return {
      icao: body.icao.toUpperCase(),
      name: typeof body.name === 'string' && body.name ? body.name : body.icao.toUpperCase(),
      lat: body.lat,
      lon: body.lon,
      metar: body.metar?.raw ? { raw: body.metar.raw, time: body.metar.time ?? null } : null,
      taf: body.taf?.raw ? { raw: body.taf.raw, issue: body.taf.issue ?? null, from: body.taf.from ?? null, to: body.taf.to ?? null } : null,
    };
  } catch {
    return null;
  }
}
