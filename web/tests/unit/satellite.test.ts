import { legendLabel } from '../../src/lib/satellite-layer';
import { describe, expect, it } from 'vitest';
import {
  GIBS_LAYERS,
  gibsTileUrl,
  layerForLongitude,
  modelCloudAlpha,
  satelliteGate,
  tilesCovering,
} from '../../src/lib/satellite';

const NOW = Date.parse('2026-10-08T13:37:00Z');

describe('satellite time gating', () => {
  it('at now, requests the latest published picture (about 50 min old) and labels its time', () => {
    const atNow = satelliteGate(NOW, NOW, false);
    expect(atNow.request).toBe(true);
    expect(atNow.timeIso).toBe('2026-10-08T12:40:00Z');
    expect(atNow.observedIso).toBe('2026-10-08T12:40:00Z');
    expect(atNow.legend).toBe('Satellite');
    expect(atNow.modelAlpha).toBe(0);
    expect(legendLabel(atNow)).toBe('Satellite 12:40Z');

    const ahead = satelliteGate(NOW + 24 * 3600 * 1000, NOW, true);
    expect(ahead.request).toBe(false);
    expect(ahead.timeIso).toBeNull();
    expect(ahead.satelliteAlpha).toBe(0);
    expect(ahead.modelAlpha).toBeGreaterThan(0.5);
    expect(ahead.legend).toBe('model');
  });

  it('keeps the latest picture while the map drifts ahead, fading into model cloud over six hours', () => {
    const soon = satelliteGate(NOW + 30 * 60 * 1000, NOW, true);
    expect(soon.request).toBe(true);
    expect(soon.satelliteAlpha).toBeGreaterThan(0.8);
    expect(soon.legend).toBe('Satellite');
    expect(soon.timeIso).toBe('2026-10-08T12:40:00Z');
    const later = satelliteGate(NOW + 5 * 3600 * 1000, NOW, true);
    expect(later.satelliteAlpha).toBeLessThan(0.2);
    expect(later.modelAlpha).toBeGreaterThan(later.satelliteAlpha);
    expect(later.legend).toBe('model');
  });

  it('does not invent satellite or model cloud outside the observed window', () => {
    const old = satelliteGate(NOW - 8 * 3600 * 1000, NOW, true);
    expect(old.request).toBe(false);
    expect(old.modelAlpha).toBe(0);
    expect(old.legend).toBeNull();
    const recent = satelliteGate(NOW - 2 * 3600 * 1000, NOW, true);
    expect(recent.request).toBe(true);
    expect(recent.legend).toBe('Satellite');
    expect(recent.modelAlpha).toBe(0);
    const bareForecast = satelliteGate(NOW + 6 * 3600 * 1000, NOW, false);
    expect(bareForecast.request).toBe(false);
    expect(bareForecast.legend).toBeNull();
  });

  it('builds Himawari tiles for Australia and leaves the Meteosat gap empty', () => {
    expect(GIBS_LAYERS.map((layer) => layer.stepMinutes)).toEqual([10, 10, 10]);
    expect(layerForLongitude(115.9)?.id).toBe('Himawari_AHI_Band13_Clean_Infrared');
    expect(layerForLongitude(151.2)?.id).toBe('Himawari_AHI_Band13_Clean_Infrared');
    expect(layerForLongitude(-74)?.id).toBe('GOES-East_ABI_Band13_Clean_Infrared');
    expect(layerForLongitude(-155)?.id).toBe('GOES-West_ABI_Band13_Clean_Infrared');
    expect(layerForLongitude(10)).toBeNull();

    const url = gibsTileUrl('Himawari_AHI_Band13_Clean_Infrared', '2026-10-08T13:30:00Z', 4, 6, 18);
    expect(url).toBe('https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/Himawari_AHI_Band13_Clean_Infrared/default/2026-10-08T13:30:00Z/2km/4/6/18.png');

    const tiles = tilesCovering({ west: 110, east: 155, south: -45, north: -10 }, '2026-10-08T13:30:00Z');
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.every((tile) => tile.layerId === 'Himawari_AHI_Band13_Clean_Infrared')).toBe(true);
    expect(tiles.every((tile) => tile.url.includes('/2km/'))).toBe(true);
    expect(modelCloudAlpha(0)).toBe(0);
    expect(modelCloudAlpha(Number.NaN)).toBe(0);
    expect(modelCloudAlpha(100)).toBeGreaterThan(0.4);
  });
});
