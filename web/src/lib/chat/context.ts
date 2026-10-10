/** The on-screen context stored with a message. The release identity wins over the client. */

import { parseUnitSpec, unitsContextPhrase } from '../units';
import type { ChatContext } from './types';

const MAX_CONTEXT_CHARS = 24_000;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function finite(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export interface ReleaseIdentity {
  runId: string | null;
  dataSha256: string | null;
}

/** Run id from the published manifest; data hash from isobar-release.json. */
export function releaseIdentity(release: unknown, manifestRun: string | null): ReleaseIdentity {
  const row = record(release);
  const hashed = row && typeof row.data_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(row.data_sha256) ? row.data_sha256 : null;
  const stamped = row && typeof row.run === 'string' ? row.run : null;
  return { runId: stamped || manifestRun, dataSha256: hashed };
}

/**
 * Keep the fields the panel was showing. Drop a profile that does not fit.
 * `runId` and `dataSha256` always come from the published release, not the body.
 */
export function captureContext(input: unknown, release: ReleaseIdentity): ChatContext | null {
  const row = record(input) ?? {};
  if (JSON.stringify(row).length > MAX_CONTEXT_CHARS) return null;
  const placeRow = record(row.place);
  const cameraRow = record(row.camera);
  const pointRow = record(row.point);
  const flyRow = record(row.fly);
  const lat = pointRow ? finite(pointRow.lat, -90, 90) : null;
  const lon = pointRow ? finite(pointRow.lon, -180, 180) : null;
  let profile: unknown = pointRow ? pointRow.profile ?? null : null;
  if (profile != null && JSON.stringify(profile).length > 4_000) profile = null;
  const cameraLat = cameraRow ? finite(cameraRow.lat, -90, 90) : null;
  const cameraLon = cameraRow ? finite(cameraRow.lon, -180, 180) : null;
  const zoom = cameraRow ? finite(cameraRow.zoom, 0, 180) : null;
  return {
    place: placeRow && text(placeRow.name, 80) ? {
      id: text(placeRow.id, 40) ?? '',
      name: text(placeRow.name, 80) ?? '',
      zone: text(placeRow.zone, 64) ?? 'UTC',
    } : null,
    timeUtc: text(row.timeUtc, 40),
    timeLocal: text(row.timeLocal, 80),
    lens: text(row.lens, 32),
    camera: cameraLat != null && cameraLon != null && zoom != null ? { lat: cameraLat, lon: cameraLon, zoom } : null,
    point: lat != null && lon != null ? { lat, lon, name: pointRow ? text(pointRow.name, 80) : null, profile } : null,
    fly: flyRow && text(flyRow.icao, 8) ? {
      icao: (text(flyRow.icao, 8) ?? '').toUpperCase(),
      metar: text(flyRow.metar, 2_000),
      taf: text(flyRow.taf, 4_000),
    } : null,
    units: parseUnitSpec(row.units),
    runId: release.runId,
    dataSha256: release.dataSha256,
    level: ['curious', 'drone', 'student', 'commercial', 'airline', 'defence'].includes(text(row.level, 16) ?? '') ? text(row.level, 16) : null,
    cardId: text(row.cardId, 120),
    rules: row.rules === 'aus' || row.rules === 'us' || row.rules === 'easa' || row.rules === 'ca' ? row.rules : null,
  };
}

export function contextLine(context: ChatContext): string {
  const bits = [
    context.place ? `Place: ${context.place.name} (${context.place.zone})` : null,
    context.timeUtc ? `Map time UTC: ${context.timeUtc}` : null,
    context.timeLocal ? `Map time local: ${context.timeLocal}` : null,
    context.lens ? `Lens: ${context.lens}` : null,
    context.camera ? `Camera: ${context.camera.lat.toFixed(3)}, ${context.camera.lon.toFixed(3)}, zoom ${context.camera.zoom}` : null,
    context.point ? `Tapped point: ${context.point.name ?? ''} ${context.point.lat}, ${context.point.lon}` : null,
    context.point?.profile ? `Point profile: ${JSON.stringify(context.point.profile)}` : null,
    context.fly ? `Fly: ${context.fly.icao}` : null,
    context.units ? unitsContextPhrase(context.units) : null,
    context.fly?.metar ? `METAR: ${context.fly.metar}` : null,
    context.fly?.taf ? `TAF: ${context.fly.taf}` : null,
    context.level ? `Level: ${context.level}` : null,
    context.cardId ? `Card: ${context.cardId}` : null,
    context.rules ? `Rules: ${context.rules}` : null,
    context.runId ? `Run: ${context.runId}` : null,
    context.dataSha256 ? `Data: ${context.dataSha256}` : null,
  ].filter(Boolean);
  return bits.join('\n');
}
