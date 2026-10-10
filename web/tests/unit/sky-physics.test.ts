import { describe, expect, it } from 'vitest';
import {
  FT_PER_M, coverSegments, isothermHeights, modelLayers, parseReport, profileAt, reportGroups, skyState, solarPosition, surfaceParcel,
  type Profile, type ProfileLevel, type ProfileSeries,
} from '../../src/lib/sky/physics';
import { synthProfile } from '../../src/lib/sky/synthetic';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 8, 3);

function series(times: number[], levels: ProfileLevel[][]): ProfileSeries {
  const hPas = levels[0].map((level) => level.hPa);
  return {
    icao: 'TEST', run: 'r', lat: -32, lon: 116, elevationFt: 67, coastKm: null, time: times,
    levels: hPas.map((hPa, li) => ({
      hPa,
      z: levels.map((set) => set[li].zM),
      t: levels.map((set) => set[li].tC),
      rh: levels.map((set) => set[li].rh),
      ws: levels.map((set) => set[li].windKt),
      wd: levels.map((set) => set[li].windFrom),
      cc: levels.map((set) => set[li].cloudPct),
      w: levels.map((set) => set[li].wMs),
    })),
  };
}

const dry = (shift = 0) => synthProfile({ surfaceT: 20 + shift, rh: () => 40 }).levels;

describe('profileAt', () => {
  it('interpolates between samples 3 h apart, wind as a vector', () => {
    const a = dry(0).map((l) => ({ ...l, windKt: 10, windFrom: 350 }));
    const b = dry(6).map((l) => ({ ...l, windKt: 10, windFrom: 10 }));
    const p = profileAt(series([T0, T0 + 3 * HOUR], [a, b]), T0 + 1.5 * HOUR) as Profile;
    expect(p.samples).toEqual([T0, T0 + 3 * HOUR]);
    expect(p.levels[0].tC).toBeCloseTo((a[0].tC as number) + 3, 5);
    expect(Math.min(p.levels[0].windFrom as number, 360 - (p.levels[0].windFrom as number))).toBeLessThan(0.5);
    expect(p.levels[0].windKt).toBeCloseTo(10 * Math.cos(10 * Math.PI / 180), 3);
  });
  it('uses the nearest sample within 3 h across a wider gap, else none', () => {
    const s = series([T0, T0 + 6 * HOUR], [dry(0), dry(6)]);
    expect(profileAt(s, T0 + 2 * HOUR)?.samples).toEqual([T0]);
    expect(profileAt(s, T0 + 4 * HOUR)?.samples).toEqual([T0 + 6 * HOUR]);
    expect(profileAt(s, T0 - 2.9 * HOUR)?.samples).toEqual([T0]);
    expect(profileAt(s, T0 - 3.1 * HOUR)).toBeNull();
    expect(profileAt(s, T0 + 9.5 * HOUR)).toBeNull();
    expect(profileAt(null, T0)).toBeNull();
  });
  it('keeps a missing value missing', () => {
    const a = dry(0);
    const b = dry(0).map((l, i) => (i === 3 ? { ...l, rh: null } : l));
    const p = profileAt(series([T0, T0 + 3 * HOUR], [a, b]), T0 + HOUR) as Profile;
    expect(p.levels[3].rh).toBeNull();
  });
});

describe('reports', () => {
  it('parses clouds, weather, visibility and temperature', () => {
    const r = parseReport('METAR YPPH 080330Z 24018KT 4000 +TSRA BR FEW010 BKN025CB 17/15 Q1011');
    expect(r.layers).toEqual([{ cover: 'FEW', baseFtAgl: 1000, type: null }, { cover: 'BKN', baseFtAgl: 2500, type: 'CB' }]);
    expect(r.visM).toBe(4000);
    expect(r.tC).toBe(17);
    expect(r.tdC).toBe(15);
    expect(r.weather.map((w) => w.token)).toEqual(['+TSRA', 'BR']);
    expect(parseReport('TAF YSSY 0803/0906 17012KT CAVOK').noCloud).toBe('CAVOK');
  });
  it('picks the METAR near now and the TAF later', () => {
    const metar = { raw: 'METAR YPPH 080330Z 24018KT 9999 BKN042 17/08 Q1011', timeMs: T0 + 0.5 * HOUR };
    const taf = [{ role: 'prevailing' as const, kind: 'FM', body: '24014KT 9999 -SHRA SCT015' }, { role: 'additional' as const, kind: 'INTER', body: '5000 SHRA BKN015' }];
    expect(reportGroups(metar, taf, T0 + HOUR, T0 + HOUR).source).toBe('METAR');
    const later = reportGroups(metar, taf, T0 + 12 * HOUR, T0 + HOUR);
    expect(later.source).toBe('TAF');
    expect(later.groups.map((g) => g.change)).toEqual([null, 'INTER']);
    expect(reportGroups(null, null, T0, T0).source).toBe('none');
  });
});

describe('thermodynamics', () => {
  it('puts the LCL at 125 m per °C of spread and finds CAPE in an unstable column', () => {
    const p = synthProfile({ surfaceT: 30, lapse: 7.5, rh: (z) => (z < 3000 ? 70 : 40) });
    const parcel = surfaceParcel(p.levels, 0, 30, 20)!;
    expect(parcel.lclFt).toBeCloseTo(1250 * FT_PER_M, 0);
    expect(parcel.capeJkg).toBeGreaterThan(500);
    expect(parcel.elFt).toBeGreaterThan(25000);
    const stable = surfaceParcel(synthProfile({ surfaceT: 15, lapse: 4, rh: () => 50 }).levels, 0, 15, 5)!;
    expect(stable.capeJkg).toBe(0);
    expect(stable.elFt).toBeNull();
  });
  it('finds the freezing level within one pressure level of the profile 0 °C', () => {
    const p = synthProfile({ surfaceT: 18, lapse: 6.5, rh: () => 50 });
    const [fz] = isothermHeights(p.levels, 0, 0);
    expect(fz).toBeCloseTo(18 / 6.5 * 1000, -2);
    const below = p.levels.filter((l) => (l.tC as number) > 0).pop()!;
    const above = p.levels.find((l) => (l.tC as number) < 0)!;
    expect(fz).toBeGreaterThan(below.zM);
    expect(fz).toBeLessThan(above.zM);
  });
  it('detects model layer cloud from RH and gives it cover from the model', () => {
    const p = synthProfile({ surfaceT: 15, rh: (z) => (z > 9000 && z < 11000 ? 95 : 30), cloud: (z) => (z > 9000 && z < 11000 ? 60 : 0) });
    const layers = modelLayers(p.levels, 0);
    expect(layers).toHaveLength(1);
    expect(layers[0].baseFt / FT_PER_M).toBeGreaterThan(7500);
    expect(layers[0].topFt / FT_PER_M).toBeLessThan(12500);
    expect(layers[0].oktas).toBe(5);
  });
});

const base = { icao: 'YPPH', elevationFt: 67, lat: -31.94, lon: 115.97, timeMs: T0 };

describe('skyState', () => {
  it('converts the METAR base AGL to AMSL and fills its top from the model', () => {
    const p = synthProfile({ surfaceT: 17, lapse: 6, rh: (z) => (z > 1200 && z < 2300 ? 92 : 45), cloud: (z) => (z > 1200 && z < 2300 ? 70 : 0) });
    const s = skyState({ ...base, source: 'METAR', groups: [{ body: 'METAR YPPH 080330Z 24018KT 9999 BKN042 17/08 Q1011', change: null }], profile: p });
    const layer = s.layers[0];
    expect(layer.baseFtAmsl).toBe(4267);
    expect(layer.cover).toBe('BKN');
    expect(layer.oktas).toBe(6);
    expect(layer.topFtAmsl).toBeGreaterThan(5500);
    // The approved local layer lapse rule identifies this 6 K/km layer as Cu.
    expect(layer.type).toBe('cumulus');
    expect(layer.topFtAmsl).toBeLessThan(8000);
    expect(s.freezingFt).toBeGreaterThan(8000);
  });
  it('draws reported cloud but no model cloud, no freezing level and unknown tops without a profile', () => {
    const s = skyState({ ...base, source: 'METAR', groups: [{ body: 'METAR YPPH 080330Z 24018KT 9999 SCT030 17/08 Q1011', change: null }], profile: null });
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0].topFtAmsl).toBeNull();
    expect(s.freezingFt).toBeNull();
    expect(s.winds).toEqual([]);
    expect(s.notes).toContain('No model profile at this time');
  });
  it('makes a CB with thunder, showers to the ground and a top at the equilibrium level', () => {
    const p = synthProfile({ surfaceT: 30, lapse: 7.5, rh: (z) => (z < 3000 ? 75 : 50) });
    const s = skyState({ ...base, source: 'METAR', groups: [{ body: 'METAR YPPH 080330Z 24018G35KT 3000 +TSRA SCT030CB 30/22 Q1006', change: null }], profile: p });
    const cb = s.layers.find((l) => l.type === 'cumulonimbus')!;
    expect(cb.thunder).toBe(true);
    expect(cb.precip).toBe('showers');
    expect(cb.heavy).toBe(true);
    expect(cb.precipBottomFtAmsl).toBe(67);
    expect(cb.topFtAmsl).toBeCloseTo(s.parcel!.elFt!, 0);
    expect(s.parcel!.capeJkg).toBeGreaterThan(500);
  });
  it('keeps a cloud genus unknown without in-layer evidence and identifies a stable shallow sheet', () => {
    const mixed = synthProfile({ surfaceT: 24, lapse: 9.5, lapseTop: 1200, rh: () => 50 });
    const cu = skyState({ ...base, source: 'METAR', groups: [{ body: 'METAR X 24010KT 9999 SCT035 24/10', change: null }], profile: mixed });
    expect(cu.layers[0].type).toBe('unknown');
    expect(cu.layers[0].topFtAmsl).toBeNull();
    const stable = synthProfile({ surfaceT: 12, lapse: 2, rh: (z) => z < 900 ? 97 : 30 });
    const st = skyState({ ...base, source: 'METAR', groups: [{ body: 'METAR X 00000KT 3000 DZ BR OVC004 12/11', change: null }], profile: stable });
    const stratus = st.layers.find((l) => l.type === 'stratus')!;
    expect(stratus.precip).toBe('drizzle');
    expect(st.obscuration?.kind).toBe('BR');
    expect(st.layers.some((l) => l.type === 'fog')).toBe(true);
  });
  it('adds model cloud above the ceilometer and suppresses low model cloud under CAVOK', () => {
    const p = synthProfile({ surfaceT: 20, rh: (z) => (z > 9500 && z < 10500 ? 85 : z < 1000 ? 95 : 30), cloud: (z) => (z > 9500 && z < 10500 ? 50 : z < 1000 ? 80 : 0) });
    const s = skyState({ ...base, source: 'TAF', groups: [{ body: '17012KT CAVOK', change: null }], profile: p });
    expect(s.layers.map((l) => l.type)).toEqual(['cirrus']);
    expect(s.layers[0].source).toBe('model');
    const bare = skyState({ ...base, source: 'none', groups: [], profile: p });
    expect(bare.layers.length).toBe(2);
  });
  it('trails virga from deep mid-level cloud over a dry layer', () => {
    const p = synthProfile({ surfaceT: 25, rh: (z) => (z > 3500 && z < 6500 ? 95 : 25), cloud: (z) => (z > 3500 && z < 6500 ? 90 : 0) });
    const s = skyState({ ...base, source: 'none', groups: [], profile: p });
    const as = s.layers.find((l) => l.precip === 'virga')!;
    expect(as.precip).toBe('virga');
    expect(as.precipBottomFtAmsl!).toBeLessThan(as.baseFtAmsl);
    expect(as.precipBottomFtAmsl!).toBeGreaterThan(67);
  });
  it('shades icing where cloud lies between 0 and −20 °C and marks TAF temporary states', () => {
    const p = synthProfile({ surfaceT: 10, lapse: 6.5, rh: (z) => (z > 900 && z < 5000 ? 95 : 40), cloud: (z) => (z > 900 && z < 5000 ? 90 : 0) });
    const s = skyState({ ...base, source: 'TAF', groups: [{ body: '24014KT 9999 BKN035', change: null }, { body: '5000 SHRA BKN015', change: 'INTER' }], profile: p });
    expect(s.icing.length).toBe(1);
    expect(s.icing[0].baseFt).toBeCloseTo(s.freezingFt!, 0);
    const inter = s.layers.find((l) => l.secondary)!;
    expect(inter.change).toBe('INTER');
    expect(inter.precip).toBe('showers');
  });
});

describe('sun and determinism', () => {
  it('puts the sun near 64° at Perth local noon in early October and below the horizon at midnight', () => {
    const noon = solarPosition(-31.94, 115.97, Date.UTC(2026, 9, 8, 4, 10));
    expect(noon.elevationDeg).toBeGreaterThan(62);
    expect(noon.elevationDeg).toBeLessThan(66);
    expect(Math.abs(noon.azimuthDeg - 0) < 10 || Math.abs(noon.azimuthDeg - 360) < 10).toBe(true);
    const morning = solarPosition(-31.94, 115.97, Date.UTC(2026, 9, 8, 0, 0));
    expect(morning.azimuthDeg).toBeGreaterThan(60);
    expect(morning.azimuthDeg).toBeLessThan(110);
    expect(solarPosition(-31.94, 115.97, Date.UTC(2026, 9, 8, 16)).elevationDeg).toBeLessThan(-30);
  });
  it('places the same gaps for the same seed and covers oktas/8 of the width', () => {
    const a = coverSegments(6, 42, 5);
    expect(coverSegments(6, 42, 5)).toEqual(a);
    expect(coverSegments(6, 43, 5)).not.toEqual(a);
    const total = a.reduce((sum, [x0, x1]) => sum + x1 - x0, 0);
    expect(total).toBeCloseTo(0.75, 6);
    expect(a[0][0]).toBeGreaterThanOrEqual(0);
    expect(a[a.length - 1][1]).toBeLessThanOrEqual(1 + 1e-9);
    expect(coverSegments(8, 1, 3)).toEqual([[0, 1]]);
  });
});
