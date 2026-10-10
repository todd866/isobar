import { describe, expect, it } from 'vitest';
import fixture from './fixtures/openmeteo-point.json';
import { marineAt, parseMarine } from '../../src/lib/point/marine';
import { parseOpenMeteo, pointProfileAt, pointSurfaceAt } from '../../src/lib/point/openmeteo';
import { readout } from '../../src/lib/sky/scene';
import {
  airRows, columnOrder, drawSounding, heightFraction, plotY, pointSheetHeight, seaRows, sectionLine, soundingFrame, soundingReadout, surfaceLabel,
} from '../../src/lib/point/sounding';
import { modelGroundLabel, sectionTrack, elevationsAlong } from '../../src/lib/point/terrain-section';
import { formatGround } from '../../src/lib/point/ground';
import { FT_PER_M } from '../../src/lib/sky/physics';
import { pilotWind } from '../../src/lib/point/wind';

const time = Date.UTC(2026, 9, 8, 3);

describe('sounding order, wind and sea', () => {
  it('reads pilot wind as direction then speed, with 360 for north and Calm under 1 kt', () => {
    expect(pilotWind(234, 12.4)).toBe('230/12');
    expect(pilotWind(225, 12.5)).toBe('230/13');
    expect(pilotWind(4, 8)).toBe('360/8');
    expect(pilotWind(355, 15)).toBe('360/15');
    expect(pilotWind(0, 10)).toBe('360/10');
    expect(pilotWind(86, 9.6)).toBe('090/10');
    expect(pilotWind(220, 0.4)).toBe('Calm');
    expect(pilotWind(220, 0)).toBe('Calm');
    expect(pilotWind(null, 12)).toBeNull();
    expect(pilotWind(220, null)).toBeNull();
    expect(readout('METAR', [{ change: null, body: '22013G25KT' }]).wind).toBe('220/13G25');
    expect(readout('METAR', [{ change: null, body: '00000KT' }]).wind).toBe('Calm');
    expect(readout('METAR', [{ change: null, body: 'VRB05KT' }]).wind).toBe('VRB/5');
  });

  it('lists the highest level first and the surface last', () => {
    const model = parseOpenMeteo(fixture);
    const profile = pointProfileAt(model, time)!;
    const surface = pointSurfaceAt(model, time);
    const rows = airRows(profile.levels, surface, model.elevationM);
    expect(rows.map((row) => row.id)).toEqual(['200', '250', '300', '400', '500', '600', '700', '850', '925', '1000', 'surface']);
    expect(rows.map((row) => row.label)).toEqual(['FL390', 'FL340', 'FL300', 'FL240', 'FL180', 'FL140', '9,900 ft', '4,900 ft', '2,700 ft', '500 ft', 'SFC 27 m / 89 ft']);
    expect(rows[0].feet).toBeGreaterThan(rows[1].feet!);
    expect(rows.find((row) => row.id === '1000')?.title).toBe('1000 hPa · 502 ft AMSL');
    expect(rows.find((row) => row.id === '1000')?.wind).toBe('230/16');
    expect(rows.at(-1)?.wind).toBe('220/13');
    expect(soundingReadout(rows.at(-1)!)).toBe('SFC 27 m / 89 ft · +19°C (ISA+4) · 220/13');
    expect(heightFraction(rows.at(-1)!.feet!, rows.at(-1)!.feet!)).toBe(0);
    expect(heightFraction(42000, rows.at(-1)!.feet!)).toBe(1);
    expect(columnOrder(rows, [])).toEqual(rows.map((row) => row.id));
  });

  it('puts marine rows under the surface only when a field is present', () => {
    const ocean = marineAt(parseMarine({
      hourly: {
        time: ['2026-10-08T00:00', '2026-10-08T03:00'],
        sea_surface_temperature: [18.2, 18.4],
        ocean_current_velocity: [2.4, 2.8],
        ocean_current_direction: [85, 92],
        wave_height: [1.5, 1.7],
        swell_wave_height: [1.1, 1.2],
        swell_wave_period: [11, 12],
        swell_wave_direction: [210, 215],
      },
    }), time)!;
    const sea = seaRows(ocean);
    expect(sea.map((row) => row.id)).toEqual(['current', 'sst', 'wave', 'swell']);
    expect(sea.map((row) => row.text)).toEqual(['to 090/1.5', '18°C', '1.7 m', '1.2 m · 12 s · 220°']);
    expect(sea[0].title).toBe('Surface current, flows to');
    const land = marineAt(parseMarine({
      hourly: {
        time: ['2026-10-08T03:00'],
        sea_surface_temperature: [null], ocean_current_velocity: [null], ocean_current_direction: [null],
        wave_height: [null], swell_wave_height: [null], swell_wave_period: [null], swell_wave_direction: [null],
      },
    }), time);
    expect(seaRows(land)).toEqual([]);
    expect(seaRows(marineAt(parseMarine({
      hourly: { time: ['2026-10-08T03:00'], wave_height: [0], sea_surface_temperature: [null], ocean_current_velocity: [null], ocean_current_direction: [null], swell_wave_height: [null], swell_wave_period: [null], swell_wave_direction: [null] },
    }), time))[0]).toMatchObject({ id: 'wave', text: '0.0 m' });
  });

  it('hides a Tibetan plateau under the ground and leaves a sea-level column unchanged', () => {
    const model = parseOpenMeteo(fixture);
    const profile = pointProfileAt(model, time)!;
    const surface = pointSurfaceAt(model, time);
    const tibet = 4520;
    const rows = airRows(profile.levels, surface, tibet);
    expect(rows.map((row) => row.id)).toEqual(['200', '250', '300', '400', '500', 'surface']);
    expect(rows.slice(0, -1).every((row) => row.feet! >= tibet * FT_PER_M - 1)).toBe(true);
    expect(rows.at(-1)?.label).toBe(surfaceLabel(tibet));
    expect(rows.at(-1)?.label).toBe('SFC 4,520 m / 14,829 ft');
    expect(rows.at(-1)?.feet).toBeCloseTo(tibet * FT_PER_M, 3);
    expect(rows.at(-1)?.dew).toBeCloseTo(11, 0);
    expect(formatGround(tibet)).toBe('4,520 m / 14,829 ft');
    const frame = soundingFrame(rows, tibet);
    expect(frame.bottomFt).toBe(0);
    expect(frame.groundFt).toBeCloseTo(tibet * FT_PER_M, 3);
    const sea = airRows(profile.levels, surface, model.elevationM);
    expect(sea.map((row) => row.id)).toEqual(['200', '250', '300', '400', '500', '600', '700', '850', '925', '1000', 'surface']);
    expect(sea.map((row) => row.label)).toEqual(['FL390', 'FL340', 'FL300', 'FL240', 'FL180', 'FL140', '9,900 ft', '4,900 ft', '2,700 ft', '500 ft', 'SFC 27 m / 89 ft']);
    expect(soundingReadout(sea.at(-1)!)).toBe('SFC 27 m / 89 ft · +19°C (ISA+4) · 220/13');
    const coast = soundingFrame(sea, model.elevationM);
    expect(coast.bottomFt).toBe(0);
    expect(coast.groundFt).toBeCloseTo(27 * FT_PER_M, 3);
    const unknown = soundingFrame(airRows(profile.levels, surface, null), null);
    expect(unknown.groundFt).toBeNull();
    expect(unknown.bottomFt).toBeGreaterThan(400);
  });

  it('keeps model levels above the smoothed ground and draws the real mountain above that line', () => {
    const model = parseOpenMeteo(fixture);
    const profile = pointProfileAt(model, time)!;
    const surface = pointSurfaceAt(model, time);
    const rows = airRows(profile.levels, surface, 8849, undefined, 5400);
    expect(rows.map((row) => row.id)).not.toContain('600');
    expect(rows.map((row) => row.id)).toContain('500');
    expect(rows.map((row) => row.id)).toContain('400');
    expect(rows.at(-1)?.label).toBe('SFC 8,849 m / 29,032 ft');
    expect(rows.at(-1)?.feet).toBeCloseTo(8849 * FT_PER_M, 3);
    expect(rows.slice(0, -1).every((row) => row.feet! >= 5400 * FT_PER_M - 1)).toBe(true);
    const lat = 27.9881;
    const lon = 86.925;
    const kmPerDeg = 111.195 * Math.cos((lat * Math.PI) / 180);
    const section = elevationsAlong(sectionTrack(lat, lon), (sampleLon) => {
      const km = (sampleLon - lon) * kmPerDeg;
      return 8849 * Math.exp(-(km * km) / (2 * 8 * 8));
    });
    const line = sectionLine(section, 360, 420, 0);
    expect(line[50].y).toBeLessThan(line[0].y - 40);
    expect(line[50].x).toBeCloseTo(sectionLine([{ distanceKm: 0, metres: 8849 }, { distanceKm: 25, metres: 0 }], 360, 420, 0)[0].x, 0);
    const texts: string[] = [];
    const ys: number[] = [];
    const grad = { addColorStop() {} };
    const ctx = {
      fillStyle: '' as unknown,
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 1,
      lineJoin: 'miter',
      font: '',
      textAlign: 'left' as CanvasTextAlign,
      clearRect() {},
      createLinearGradient() { return grad; },
      fillRect() {},
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo(_x: number, y: number) { if (ctx.strokeStyle === '#c45c26') ys.push(y); },
      lineTo(_x: number, y: number) { if (ctx.strokeStyle === '#c45c26') ys.push(y); },
      stroke() {},
      fill() {},
      closePath() {},
      setLineDash() {},
      fillText(text: string) { texts.push(text); },
    };
    const frame = soundingFrame(rows, 8849);
    drawSounding(ctx as unknown as CanvasRenderingContext2D, {
      width: 360, height: 420, rows, layers: [], freezingFt: null, bottomFt: frame.bottomFt, groundFt: frame.groundFt,
      section, modelGroundM: 5400, emphasis: 'temp', dark: false, ink: '#174e66', muted: '#5c6b76',
    }, () => {});
    expect(texts).toContain(modelGroundLabel(5400));
    expect(Math.min(...ys)).toBeLessThan(line[50].y);
  });

  it('starts the temperature and dew-point traces at the ground, not at sea level', () => {
    const model = parseOpenMeteo(fixture);
    const profile = pointProfileAt(model, time)!;
    const surface = pointSurfaceAt(model, time);
    const tibet = 4520;
    const rows = airRows(profile.levels, surface, tibet);
    const frame = soundingFrame(rows, tibet);
    const height = 420;
    const width = 360;
    const groundY = plotY(heightFraction(frame.groundFt!, frame.bottomFt), height);
    const seaY = plotY(heightFraction(0, frame.bottomFt), height);
    expect(groundY).toBeLessThan(seaY - 40);
    const moves: { y: number; stroke: string }[] = [];
    const fills: { y: number; h: number; fill: string }[] = [];
    const grad = { addColorStop() { /* recorded by fillRect */ } };
    const ctx = {
      fillStyle: '' as unknown,
      strokeStyle: '',
      globalAlpha: 1,
      lineWidth: 1,
      lineJoin: 'miter',
      font: '',
      textAlign: 'left' as CanvasTextAlign,
      clearRect() {},
      createLinearGradient() { return grad; },
      fillRect(_x: number, y: number, _w: number, h: number) {
        fills.push({ y, h, fill: typeof ctx.fillStyle === 'string' ? ctx.fillStyle : 'gradient' });
      },
      save() {},
      restore() {},
      beginPath() {},
      rect() {},
      clip() {},
      moveTo(_x: number, y: number) { moves.push({ y, stroke: ctx.strokeStyle }); },
      lineTo() {},
      stroke() {},
      fill() {},
      closePath() {},
      setLineDash() {},
      fillText() {},
    };
    drawSounding(ctx as unknown as CanvasRenderingContext2D, {
      width, height, rows, layers: [], freezingFt: 25000, bottomFt: frame.bottomFt, groundFt: frame.groundFt,
      emphasis: 'temp', dark: false, ink: '#174e66', muted: '#5c6b76', temp: 'C',
    }, () => {});
    const ground = fills.find((fill) => fill.fill === 'gradient' && fill.y > 20);
    expect(ground?.y).toBeCloseTo(groundY, 0);
    expect((ground?.y ?? 0) + (ground?.h ?? 0)).toBeCloseTo(height, 0);
    const temp = moves.filter((move) => move.stroke === '#c45c26');
    const dew = moves.filter((move) => move.stroke === '#1f7a4d');
    expect(temp[0]?.y).toBeCloseTo(groundY, 0);
    expect(dew[0]?.y).toBeCloseTo(groundY, 0);
    expect(temp.every((move) => move.y <= groundY + 0.5)).toBe(true);
    expect(dew.every((move) => move.y <= groundY + 0.5)).toBe(true);
    expect(moves.some((move) => move.stroke === '#1a7f9a' && move.y < groundY)).toBe(true);
  });

  it('sizes the phone sheet from the slider to the lens bar, keeping a map strip for the point', () => {
    // A 390x844 phone: map panel 208–553, time slider ends at 200.
    const height = pointSheetHeight(208, 553, 200, 844);
    expect(553 - 208 - height).toBeGreaterThanOrEqual(120);
    expect(height).toBeGreaterThanOrEqual(160);
    // Never taller than the room under the slider.
    expect(pointSheetHeight(208, 300, 200, 844)).toBeLessThanOrEqual(100);
    expect(pointSheetHeight(208, 208, 200, 844)).toBe(0);
  });
});
