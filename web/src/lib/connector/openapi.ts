import { AERODROME_PATH, PLACE_PATH, POINT_PATH, RUN_PATH } from './paths';
import { CONNECTOR_ATTRIBUTION } from './meta';

const attribution = {
  type: 'array',
  minItems: 3,
  items: {
    type: 'object',
    required: ['source', 'licence'],
    additionalProperties: false,
    properties: {
      source: { type: 'string' },
      licence: { type: 'string' },
    },
  },
} as const;

const reading = {
  units: { type: ['object', 'null'], description: 'Units for the numbers in this response, or null when it has none.' },
  validTime: { type: ['string', 'null'], format: 'date-time', description: 'Valid time of the reading, UTC, or null.' },
  runId: { type: ['string', 'null'], description: 'Published chart run.' },
  provenance: { description: 'Where the numbers came from, or null.' },
  attribution: { description: 'ECMWF CC BY 4.0, Open-Meteo CC BY 4.0, aviationweather.gov.' },
};

function nullableNumber(description: string) {
  return { type: ['number', 'null'], description };
}

const pointExample = {
  lat: -31.95,
  lon: 115.86,
  time: '2026-10-08T06:00:00.000Z',
  validTime: '2026-10-08T06:00:00.000Z',
  runId: '2026-10-08T00:00:00Z',
  units: { mslp: 'hPa', rain: 'mm', wind: 'kt', windFrom: 'deg', temp: 'C' },
  mslp: 1016.2,
  rain: null,
  wind: 14,
  windFrom: 230,
  temp: 18.4,
  profile: {
    surface: {
      temperature2mC: 18.4,
      dewPoint2mC: 11.2,
      windSpeed10mKt: 14,
      windDirection10m: 230,
      cloudCoverPct: 40,
      precipitationMm: null,
      surfacePressureHpa: 1016.2,
    },
    levels: null,
    provenance: { source: 'Open-Meteo', model: 'ecmwf_ifs025', run: '2026-10-08T00:00:00Z', cycle: true },
  },
  provenance: {
    fields: 'ECMWF',
    profile: 'Open-Meteo',
    licence: 'CC BY 4.0',
    runId: '2026-10-08T00:00:00Z',
    generated: '2026-10-08T05:10:00Z',
    profileRun: '2026-10-08T00:00:00Z',
  },
  attribution: CONNECTOR_ATTRIBUTION,
};

const errorExample = {
  error: 'missing argument',
  units: null,
  validTime: null,
  runId: '2026-10-08T00:00:00Z',
  provenance: null,
  attribution: CONNECTOR_ATTRIBUTION,
};

function jsonResponse(description: string, schema: string, example: unknown, summary: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schema}` },
        examples: { sample: { summary, value: example } },
      },
    },
  };
}

function operation(operationId: string, summary: string, description: string, parameters: unknown[], schema: string, example: unknown, exampleSummary: string) {
  return {
    operationId,
    summary,
    description,
    security: [] as [],
    'x-openai-isConsequential': false as const,
    parameters,
    responses: {
      '200': jsonResponse(summary, schema, example, exampleSummary),
      '400': jsonResponse('Latitude, longitude, time, name or ICAO was not usable.', 'ErrorBody', errorExample, 'Missing argument'),
      '429': jsonResponse('More than 30 calls in a minute or 2,000 in a day from this address.', 'ErrorBody', { ...errorExample, error: 'slow' }, 'Slow down'),
    },
  };
}

/** OpenAPI 3.1 for a ChatGPT custom GPT Action. operationIds are the action names. */
export function openApiDocument(origin: string) {
  const server = (origin || 'https://isobar.md').replace(/\/$/, '');
  return {
    openapi: '3.1.0' as const,
    info: {
      title: 'Isobar weather',
      version: '1.0.0',
      summary: 'Read-only weather for a personal assistant.',
      description: 'Published ECMWF fields, an Open-Meteo point profile, and aerodrome reports. Open-Meteo is non-commercial (CC BY 4.0). Missing values are null. No account.',
    },
    servers: [{ url: server }],
    paths: {
      [POINT_PATH]: {
        get: operation(
          'getWeatherPoint',
          'Weather at a point',
          'MSLP (hPa), rain (mm), wind (kt and direction), temperature (C), and the Open-Meteo profile. Open-Meteo is non-commercial. Missing values are null.',
          [
            { name: 'lat', in: 'query', required: true, description: 'Latitude, degrees north.', schema: { type: 'number', minimum: -90, maximum: 90 }, example: -31.95 },
            { name: 'lon', in: 'query', required: true, description: 'Longitude, degrees east.', schema: { type: 'number', minimum: -180, maximum: 180 }, example: 115.86 },
            { name: 'time', in: 'query', required: true, description: 'UTC time with a timezone.', schema: { type: 'string', format: 'date-time' }, example: '2026-10-08T06:00:00Z' },
          ],
          'PointWeather',
          pointExample,
          'Perth. Rain is null because that hour was not published.',
        ),
      },
      [AERODROME_PATH]: {
        get: operation(
          'getAerodromeWeather',
          'Aerodrome METAR and TAF',
          'METAR and TAF for a four-letter ICAO id from the published aviation file. Missing reports are null.',
          [
            { name: 'icao', in: 'path', required: true, description: 'ICAO aerodrome id.', schema: { type: 'string', pattern: '^[A-Za-z]{4}$' }, example: 'YPPH' },
          ],
          'AerodromeWeather',
          {
            icao: 'YPPH',
            name: 'Perth',
            lat: -31.95,
            lon: 115.97,
            metar: { raw: 'METAR YPPH 080300Z 22013KT' },
            taf: null,
            units: null,
            validTime: null,
            runId: '2026-10-08T00:00:00Z',
            provenance: { source: 'aviationweather.gov', runId: '2026-10-08T00:00:00Z', generated: '2026-10-08T05:10:00Z' },
            attribution: CONNECTOR_ATTRIBUTION,
          },
          'Perth. TAF is null when the file has none.',
        ),
      },
      [PLACE_PATH]: {
        get: operation(
          'findPlace',
          'Find a place',
          'Up to eight catalogue matches for a name: latitude and longitude.',
          [
            { name: 'q', in: 'query', required: true, description: 'Place name.', schema: { type: 'string', minLength: 1, maxLength: 80 }, example: 'Perth' },
          ],
          'PlaceMatches',
          {
            query: 'Perth',
            matches: [{ name: 'Perth', lat: -31.95, lon: 115.97, region: 'WA' }],
            units: null,
            validTime: null,
            runId: '2026-10-08T00:00:00Z',
            provenance: { source: 'Isobar places', runId: '2026-10-08T00:00:00Z', generated: '2026-10-08T05:10:00Z' },
            attribution: CONNECTOR_ATTRIBUTION,
          },
          'Perth.',
        ),
      },
      [RUN_PATH]: {
        get: operation(
          'getRun',
          'Published run',
          'Run id, issued time, forecast-hour offsets and places. hours is the whole published ladder.',
          [],
          'RunInfo',
          {
            runId: '2026-10-08T00:00:00Z',
            timeUtc: '2026-10-08T00:00:00Z',
            hours: [0, 3, 6, 9, 12],
            places: [{ name: 'Perth', lat: -31.95, lon: 115.97, icao: 'YPPH' }],
            generated: '2026-10-08T05:10:00Z',
            units: null,
            validTime: '2026-10-08T00:00:00Z',
            provenance: { source: 'ECMWF', licence: 'CC BY 4.0', runId: '2026-10-08T00:00:00Z', generated: '2026-10-08T05:10:00Z' },
            attribution: CONNECTOR_ATTRIBUTION,
          },
          'Illustrative prefix. The live hours array is the whole run.',
        ),
      },
    },
    components: {
      schemas: {
        PointWeather: {
          type: 'object',
          additionalProperties: false,
          required: ['lat', 'lon', 'time', 'validTime', 'runId', 'units', 'mslp', 'rain', 'wind', 'windFrom', 'temp', 'profile', 'provenance', 'attribution'],
          properties: {
            lat: { type: 'number' },
            lon: { type: 'number' },
            time: { type: 'string', format: 'date-time' },
            validTime: reading.validTime,
            runId: reading.runId,
            units: {
              type: 'object',
              additionalProperties: false,
              required: ['mslp', 'rain', 'wind', 'windFrom', 'temp'],
              properties: {
                mslp: { type: 'string' },
                rain: { type: 'string' },
                wind: { type: 'string' },
                windFrom: { type: 'string' },
                temp: { type: 'string' },
              },
            },
            mslp: nullableNumber('Mean sea level pressure.'),
            rain: nullableNumber('Rain, millimetres. Null when that hour is missing.'),
            wind: nullableNumber('Wind speed, knots.'),
            windFrom: nullableNumber('Wind direction, degrees true, where it comes from.'),
            temp: nullableNumber('Temperature, Celsius.'),
            profile: {
              type: 'object',
              required: ['surface', 'levels', 'provenance'],
              properties: {
                surface: { type: ['object', 'null'] },
                levels: { type: ['array', 'null'] },
                provenance: { type: ['object', 'null'] },
              },
            },
            provenance: { type: 'object' },
            attribution,
          },
        },
        AerodromeWeather: {
          type: 'object',
          additionalProperties: false,
          required: ['icao', 'name', 'lat', 'lon', 'metar', 'taf', 'units', 'validTime', 'runId', 'provenance', 'attribution'],
          properties: {
            icao: { type: 'string' },
            name: { type: ['string', 'null'] },
            lat: nullableNumber('Aerodrome latitude.'),
            lon: nullableNumber('Aerodrome longitude.'),
            metar: { type: ['object', 'null'] },
            taf: { type: ['object', 'null'] },
            units: reading.units,
            validTime: reading.validTime,
            runId: reading.runId,
            provenance: { type: 'object' },
            attribution,
          },
        },
        PlaceMatches: {
          type: 'object',
          additionalProperties: false,
          required: ['query', 'matches', 'units', 'validTime', 'runId', 'provenance', 'attribution'],
          properties: {
            query: { type: 'string' },
            matches: {
              type: 'array',
              items: {
                type: 'object',
                required: ['name', 'lat', 'lon', 'region'],
                properties: {
                  name: { type: 'string' },
                  lat: { type: 'number' },
                  lon: { type: 'number' },
                  region: { type: 'string' },
                },
              },
            },
            units: reading.units,
            validTime: reading.validTime,
            runId: reading.runId,
            provenance: { type: 'object' },
            attribution,
          },
        },
        RunInfo: {
          type: 'object',
          required: ['runId', 'timeUtc', 'hours', 'places', 'generated', 'units', 'validTime', 'provenance', 'attribution'],
          properties: {
            runId: reading.runId,
            timeUtc: { type: 'string' },
            hours: { type: 'array', items: { type: 'number' }, description: 'Forecast offsets in hours. The live array is the whole run.' },
            places: { type: 'array' },
            generated: { type: ['string', 'null'] },
            units: reading.units,
            validTime: reading.validTime,
            provenance: { type: 'object' },
            attribution,
          },
        },
        ErrorBody: {
          type: 'object',
          required: ['error', 'units', 'validTime', 'runId', 'provenance', 'attribution'],
          properties: {
            error: { type: 'string' },
            units: reading.units,
            validTime: reading.validTime,
            runId: reading.runId,
            provenance: { type: ['object', 'null'] },
            attribution,
          },
        },
      },
    },
  };
}
