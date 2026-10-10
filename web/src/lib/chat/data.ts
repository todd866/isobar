/** Published files the fast lane may read. No network except the point-profile helper. */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { unshuffleUint16 } from '../frame-codec';
import { readManifest, type ChartManifest } from '../manifest';
import { decodeUint16 } from '../quantise';
import { loadPointProfile, pointProfileAt, pointSurfaceAt } from '../point/openmeteo';
import type { PlaceRow } from '../places';
import { releaseIdentity, type ReleaseIdentity } from './context';
import type { PublishedChart } from './tools';

const BLANK: ChartManifest = {
  schema: 2, contract: 'isobar-web', run: '', generated: '', forecastHours: [0], uniformStepHours: null,
  nx: 2, ny: 2, west: 0, east: 1, north: 0, south: -1, step: 1, wrapsLongitude: false, dtype: 'uint16',
  variables: {}, places: [], aviation: 'aviation.json', points: null, attribution: [],
};

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** Cached Open-Meteo profile. A failed lookup stays null, not zero. */
export async function publishedPointProfile(lat: number, lon: number, timeUtc: string): Promise<unknown> {
  const at = Date.parse(timeUtc);
  const when = Number.isFinite(at) ? at : Date.now();
  try {
    const model = await loadPointProfile(lat, lon, { mapTimeMs: when });
    return {
      lat, lon, timeUtc, missing: false,
      surface: pointSurfaceAt(model, when),
      levels: pointProfileAt(model, when)?.levels ?? null,
      provenance: model.provenance,
    };
  } catch {
    return { lat, lon, timeUtc, missing: true, surface: null, levels: null, provenance: null };
  }
}

/** The browser's decodeFrameBytes, synchronously: gunzip if gzipped, then unshuffle the byte planes. */
function frameBytes(bytes: Uint8Array, encoding: 'raw' | 'shuffle-gzip'): Uint8Array {
  if (encoding === 'raw') return bytes;
  const planes = bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes)) : bytes;
  return unshuffleUint16(planes);
}

export function chartFromDir(dir: string, placesFile: string, releaseFile: string, profile: PublishedChart['profile'] = publishedPointProfile): { chart: PublishedChart; release: ReleaseIdentity } {
  const manifestJson = readJson(join(dir, 'manifest.json'));
  let manifest = BLANK;
  try { if (manifestJson) manifest = readManifest(manifestJson); } catch { manifest = BLANK; }
  const frames = new Map<string, Float32Array | null>();
  const chart: PublishedChart = {
    manifest,
    frame(variable, index) {
      const key = `${variable}:${index}`;
      if (frames.has(key)) return frames.get(key) ?? null;
      const spec = manifest.variables[variable];
      const rel = spec?.frames?.[index];
      let decoded: Float32Array | null = null;
      if (spec && rel && !rel.includes('..')) {
        try { decoded = decodeUint16(frameBytes(readFileSync(join(dir, rel)), spec.encoding), spec); } catch { decoded = null; }
      }
      frames.set(key, decoded);
      return decoded;
    },
    points: readJson(join(dir, 'points.json')),
    aviation: readJson(join(dir, 'aviation.json')) as PublishedChart['aviation'],
    sky: readJson(join(dir, 'sky.json')),
    places: Array.isArray(readJson(placesFile)) ? readJson(placesFile) as PlaceRow[] : [],
    profile,
  };
  return { chart, release: releaseIdentity(readJson(releaseFile), manifest.run || null) };
}

const globalChart = globalThis as unknown as { isobarChatChart?: { chart: PublishedChart; release: ReleaseIdentity } };

export function publishedChart(): { chart: PublishedChart; release: ReleaseIdentity } {
  if (!globalChart.isobarChatChart) {
    const web = join(process.cwd());
    globalChart.isobarChatChart = chartFromDir(
      join(web, 'public', 'data'),
      join(web, 'public', 'places', 'world-places.json'),
      join(web, 'public', 'isobar-release.json'),
    );
  }
  return globalChart.isobarChatChart;
}
