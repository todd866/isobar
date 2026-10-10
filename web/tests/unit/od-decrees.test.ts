import { describe, expect, it } from 'vitest';
import { AERODROMES } from '../../src/lib/od/aerodromes';
import { DECREES, editionVariant } from '../../src/lib/od/decrees';
import { draftDossier } from '../../src/lib/od/generator';
import type { Dossier, Edition } from '../../src/lib/od/model';
import type { WeatherReport } from '../../src/lib/od/model';

const T0 = Date.parse('2026-10-09T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const profile = (station: string) => ({ icao: station, run: iso(T0), lat: -32, lon: 116, elevationFt: 100, coastKm: null, time: [T0, T0 + 3 * 3600_000, T0 + 6 * 3600_000], levels: [
  { hPa: 1000, z: [0, 0, 0], t: [18, 18, 18], rh: [50, 50, 50], ws: [10, 10, 10], wd: [240, 240, 240], cc: [0, 0, 0], w: [0, 0, 0] },
  { hPa: 850, z: [1500, 1500, 1500], t: [4, 4, 4], rh: [40, 40, 40], ws: [20, 20, 20], wd: [250, 250, 250], cc: [0, 0, 0], w: [0, 0, 0] },
  { hPa: 700, z: [3000, 3000, 3000], t: [-8, -8, -8], rh: [30, 30, 30], ws: [25, 25, 25], wd: [260, 260, 260], cc: [0, 0, 0], w: [0, 0, 0] },
] });
const weather = (station: 'YPPH' | 'YSSY', raw = 'CAVOK'): WeatherReport => ({
  station, source: '/data/aviation.json', capturedAt: iso(T0),
  metar: { raw: `METAR ${station} 090000Z 24010KT ${raw} 18/10 Q1013`, time: iso(T0) },
  taf: { raw: `TAF ${station} 090000Z 0900/1000 24010KT ${raw}`, issue: iso(T0), from: iso(T0), to: iso(T0 + 24 * 3600_000) }, profile: profile(station),
});

function authored(id: string, edition: Edition): Dossier {
  const d = draftDossier({ edition, aircraft: id === 'vfr' ? 'club-single' : 'a727', departure: AERODROMES[0], destination: AERODROMES[1], departureWeather: weather('YPPH'), destinationWeather: weather('YSSY'), arrivalUtc: iso(T0 + 6 * 3600_000), difficulty: 1, seed: 971, decreeId: id, shift: DECREES.length });
  const alternate = { aerodrome: structuredClone(AERODROMES[0]), weather: weather('YPPH'), distanceNm: 100, runway: { ...AERODROMES[0].runways[0], state: 'dry' as const, contaminationMm: 0, inspected: true }, minima: { ceilingFt: 800, visibilityM: 4000 } };
  d.alternatives = [alternate]; d.plan.alternateId = alternate.aerodrome.id; d.plan.fuelKg = id === 'vfr' ? 150 : 15_000;
  if (id === 'destination-alternate') d.destinationWeather.taf!.raw = 'TAF YSSY 090000Z 0900/1000 24010KT 2000 BKN005';
  if (id === 'forecast-groups') d.destinationWeather.taf!.raw = 'TAF YSSY 090000Z 0900/1000 24010KT CAVOK TEMPO 0906/0910 1000 BKN002';
  if (id === 'thunderstorms') {
    d.destinationWeather.taf!.raw = 'TAF YSSY 090000Z 0900/1000 24010KT CAVOK TEMPO 0906/0910 9999 TSRA BKN020';
    d.plan.holdingMinutes = 60;
  }
  if (id === 'duty') {
    d.operation = 'airline'; d.documents.duty.scheme = edition === 'aus' ? 'au-basic' : 'us-117';
    d.documents.duty.startUtc = iso(T0); d.documents.duty.startLocalHour = 8;
    d.documents.duty.endUtc = iso(T0 + 7 * 3600_000);
  }
  if (id === 'vfr') { d.plan.rules = 'VFR'; d.plan.cruiseLevel = 65; }
  if (id === 'icing' || id === 'mel') {
    const defect = id === 'icing' ? 'antiIce' : 'autopilot';
    d.documents.technicalLog.defects = [defect]; d.documents.maintenanceRelease.endorsedDefects = [defect];
  }
  return d;
}

function badCase(d: Dossier, id: string): void {
  switch (id) {
    case 'forecast-coverage': d.destinationWeather.taf!.from = iso(T0 + 12 * 3600_000); d.destinationWeather.taf!.to = iso(T0 + 13 * 3600_000); break;
    case 'destination-alternate': d.plan.alternateId = null; d.destinationWeather.taf = { ...d.destinationWeather.taf!, raw: 'TAF YSSY 090000Z 0900/1000 24010KT 2000 BKN005' }; break;
    case 'forecast-groups': d.destinationWeather.taf!.raw = 'TAF YSSY 090000Z 0900/1000 24010KT CAVOK TEMPO 0906/0910 1000 TSRA BKN002'; d.plan.alternateId = null; d.plan.holdingMinutes = 0; break;
    case 'crosswind': d.departureWeather.metar!.raw = 'METAR YPPH 090000Z 19010G50KT CAVOK 18/10 Q1013'; break;
    case 'icing': d.documents.technicalLog.defects = ['antiIce']; d.plan.cloudExposure = true; d.plan.cruiseLevel = 350; break;
    case 'thunderstorms': d.destinationWeather.taf!.raw = 'TAF YSSY 090000Z 0900/1000 24010KT 9999 TSRA BKN020'; d.plan.holdingMinutes = 0; break;
    case 'fuel': d.plan.fuelKg = 0; break;
    case 'duty': d.documents.duty.endUtc = iso(Date.parse(d.documents.duty.startUtc) + 20 * 3600_000); break;
    case 'takeoff-distance': d.plan.departureRunway.lengthM = 1; break;
    case 'landing-distance': d.plan.arrivalRunway.lengthM = 1; break;
    case 'contaminated-runway': d.plan.departureRunway.state = 'contaminated'; d.plan.departureRunway.contaminationMm = 4; break;
    case 'density-altitude': d.plan.plannedDensityAltitudeFt += 1000; break;
    case 'mel': d.documents.technicalLog.defects = ['autopilot']; d.documents.technicalLog.placarded = false; break;
    case 'licence-medical': d.documents.crew[0].medical.validUntil = iso(T0 - 1); break;
    case 'passenger-recency': d.documents.crew[0].landings = []; break;
    case 'maintenance-release': d.documents.maintenanceRelease.signed = false; break;
    case 'notams': d.documents.notams = [{ id: 'N1', aerodromeId: d.departure.id, from: iso(T0 - 3600_000), to: iso(T0 + 12 * 3600_000), runwayId: d.plan.departureRunway.id, closed: true, acknowledged: true }]; break;
    case 'vfr': d.plan.rules = 'VFR'; d.plan.cruiseLevel = 90; d.plan.cloudClearance.belowFt = 0; d.plan.cloudClearance.aboveFt = 0; d.plan.cloudClearance.horizontalM = 0; break;
    case 'manifest': d.documents.passengerManifest.paid = true; break;
    default: throw new Error(`No authored negative case for ${id}`);
  }
}

describe('authored decree checks', () => {
  for (const edition of ['aus', 'us'] as const) for (const rule of DECREES) {
    it(`${edition} ${rule.id}: authored positive and negative`, () => {
      const clean = authored(rule.id, edition);
      expect(editionVariant(rule, edition).check(clean).status).toBe('pass');
      badCase(clean, rule.id);
      expect(editionVariant(rule, edition).check(clean).status).toBe('fail');
    });
  }
  it('covers the complete edition catalogue', () => {
    expect(DECREES.length).toBe(19);
    expect(new Set(DECREES.map(d => d.id)).size).toBe(DECREES.length);
  });
});
