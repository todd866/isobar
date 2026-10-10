import type { Page, Route } from '@playwright/test';

/**
 * Recorded METAR/TAF for e2e. Live Bureau text changes every hour; a showery
 * day drops "Thunderstorm" from YPPH and the teaching journey fails. The
 * window is anchored to the clock at request time so the chart's "now" is
 * inside the TAF and the METAR is fresh.
 */

interface Airport {
  icao?: string;
  metar?: unknown;
  taf?: unknown;
  [key: string]: unknown;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function dayHour(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}`;
}

function dayHourMinute(ms: number): string {
  const date = new Date(ms);
  return `${dayHour(ms)}${String(date.getUTCMinutes()).padStart(2, '0')}`;
}

function stampAirport(airport: Airport, now: number): Airport {
  const icao = typeof airport.icao === 'string' ? airport.icao : 'YPPH';
  const issue = now - 30 * 60_000;
  // Wide enough that the chart frame nearest now is inside the TAF, whatever
  // the model hour is. The reports themselves are recorded, not today's.
  const from = now - 12 * 3_600_000;
  const to = now + 36 * 3_600_000;
  return {
    ...airport,
    icao,
    metar: {
      raw: `METAR ${icao} ${dayHourMinute(now)}Z 24015G25KT 8000 TSRA FEW030CB 18/12 Q1012`,
      time: iso(now),
    },
    taf: {
      raw: `TAF ${icao} ${dayHourMinute(issue)}Z ${dayHour(from)}/${dayHour(to)} 26018G28KT 9999 TSRA SCT030CB`,
      issue: iso(issue),
      from: iso(from),
      to: iso(to),
    },
  };
}

async function fulfill(route: Route) {
  const now = Date.now();
  let body: { airports?: Airport[]; sigmets?: unknown[] } = { airports: [], sigmets: [] };
  try {
    const response = await route.fetch();
    const parsed = await response.json() as { airports?: Airport[]; sigmets?: unknown[] };
    if (parsed && typeof parsed === 'object') body = parsed;
  } catch {
    /* the recorded aerodromes below still satisfy the assertions */
  }
  const airports = Array.isArray(body.airports) ? body.airports.map((airport) => stampAirport(airport, now)) : [];
  if (!airports.some((airport) => airport.icao === 'YPPH')) {
    airports.push(stampAirport({ icao: 'YPPH', name: 'Perth', zone: 'Australia/Perth', lat: -31.9403, lon: 115.9672 }, now));
  }
  if (!airports.some((airport) => airport.icao === 'YSSY')) {
    airports.push(stampAirport({ icao: 'YSSY', name: 'Sydney', zone: 'Australia/Sydney', lat: -33.9461, lon: 151.1772 }, now));
  }
  airports.sort((a, b) => (a.icao === 'YPPH' ? -1 : b.icao === 'YPPH' ? 1 : 0));
  await route.fulfill({ json: { ...body, airports } });
}

/** Serve the recorded aerodrome reports for this page. Call before navigation. */
export async function installWeatherFixture(page: Page) {
  await page.route('**/data/aviation.json', fulfill);
}
