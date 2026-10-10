/**
 * Display pieces for the Fly panel: the METAR row and the TAF sky cards.
 * Only what is written in the report is shown; nothing is inferred.
 * Temperatures in the report are °C; QNH is hPa (Q) or inHg (A). Display converts.
 */

import { AUS_UNITS, cToF, formatPressureHpa, formatVisibilityMetres, feetToMetres, type DisplayUnits } from './units';

export interface CloudLayer {
  cover: 'FEW' | 'SCT' | 'BKN' | 'OVC' | 'VV';
  baseFt: number;
  type: 'CB' | 'TCU' | null;
}

export interface Hazard {
  text: string;
  /** Thunderstorm, CB, fog, heavy precipitation, squall, funnel cloud, ash. */
  severe: boolean;
}

const WEATHER = /^(\+|-|VC)?(MI|PR|BC|DR|BL|SH|TS|FZ)?((DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)+)?$/;

function weatherTokens(tokens: string[]): string[] {
  return tokens.filter((token) => token.length >= 2 && token !== 'NSW' && WEATHER.test(token)
    && /(TS|DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PO|SQ|FC|SS|DS)/.test(token));
}

export function cloudLayers(text: string): CloudLayer[] {
  const layers: CloudLayer[] = [];
  for (const match of text.matchAll(/\b(FEW|SCT|BKN|OVC|VV)(\d{3})(CB|TCU)?\b/g)) {
    layers.push({ cover: match[1] as CloudLayer['cover'], baseFt: Number(match[2]) * 100, type: (match[3] as 'CB' | 'TCU' | undefined) ?? null });
  }
  return layers;
}

/** Lowest BKN/OVC/VV layer, in feet. Null when there is no ceiling. */
export function ceilingFt(layers: CloudLayer[]): number | null {
  const bases = layers.filter((layer) => layer.cover === 'BKN' || layer.cover === 'OVC' || layer.cover === 'VV').map((layer) => layer.baseFt);
  return bases.length ? Math.min(...bases) : null;
}

/** Reported weather that leads the row, worst first: "VCTS", "CB 3,500", "-SHRA". */
export function hazards(text: string, units: DisplayUnits = AUS_UNITS): Hazard[] {
  const tokens = text.split(/\s+/);
  const out: Hazard[] = weatherTokens(tokens).map((token) => ({
    text: token,
    severe: /TS|FG|SQ|FC|VA|GR|DS|SS/.test(token) || token.startsWith('+'),
  }));
  for (const layer of cloudLayers(text)) {
    if (layer.type) {
      const base = units.height === 'm' ? Math.round(feetToMetres(layer.baseFt)) : layer.baseFt;
      out.push({ text: `${layer.type} ${base.toLocaleString('en-AU')}${units.height === 'm' ? ' m' : ''}`, severe: layer.type === 'CB' });
    }
  }
  return out.sort((a, b) => Number(b.severe) - Number(a.severe));
}

export interface MetarRow {
  hazards: Hazard[];
  clouds: string[];
  visibility: string | null;
  wind: string | null;
  tempDew: string | null;
  qnh: string | null;
}

function tempDew(token: string, units: DisplayUnits): string {
  const shown = (group: string) => {
    const negative = group.startsWith('M') || group.startsWith('-');
    const celsius = Number(group.replace('M', '').replace('-', '')) * (negative ? -1 : 1);
    if (!Number.isFinite(celsius)) return group.replace(/M/g, '-');
    if (units.temp === 'C') return String(celsius);
    return String(Math.round(cToF(celsius)));
  };
  const [temp, dew] = token.split('/');
  if (!temp || !dew) return token.replace(/M/g, '-');
  const text = `${shown(temp)}/${shown(dew)}`;
  return units.temp === 'F' ? `${text}°F` : text;
}

export function metarRow(raw: string, units: DisplayUnits = AUS_UNITS): MetarRow {
  const body = raw.replace(/\s+(RMK|TEMPO|BECMG|NOSIG)\b.*$/, '');
  const tokens = body.split(/\s+/);
  const windToken = tokens.find((token) => /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/.test(token));
  let wind: string | null = null;
  if (windToken) {
    const match = windToken.match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/);
    if (match) wind = `${match[1]}/${match[2]}${match[3] ? `G${match[3]}` : ''}`;
  }
  let visibility: string | null = null;
  if (tokens.includes('CAVOK')) visibility = 'CAVOK';
  else {
    const vis = tokens.find((token, index) => index > 2 && /^\d{4}$/.test(token));
    if (vis) visibility = formatVisibilityMetres(Number(vis), units);
  }
  const clouds = cloudLayers(body).filter((layer) => !layer.type).map((layer) => `${layer.cover}${String(layer.baseFt / 100).padStart(3, '0')}`);
  const td = tokens.find((token) => /^M?\d{2}\/M?\d{2}$/.test(token));
  const qToken = tokens.find((token) => /^Q\d{4}$/.test(token));
  const aToken = tokens.find((token) => /^A\d{4}$/.test(token));
  const qnhHpa = qToken ? Number(qToken.slice(1)) : aToken ? Number(aToken.slice(1)) / 100 / 0.02953 : null;
  return {
    hazards: hazards(body, units),
    clouds,
    visibility,
    wind,
    tempDew: td ? tempDew(td, units) : null,
    qnh: qnhHpa == null ? null : units.pressure === 'hPa' && qToken ? qToken.slice(1) : formatPressureHpa(qnhHpa, units),
  };
}

/** Great-circle distance in km and the 8-point bearing from a to b. */
export function distanceBearing(aLat: number, aLon: number, bLat: number, bLon: number): { km: number; bearing: string } {
  const r = Math.PI / 180;
  const dLat = (bLat - aLat) * r;
  const dLon = (bLon - aLon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  const km = 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  const y = Math.sin(dLon) * Math.cos(bLat * r);
  const x = Math.cos(aLat * r) * Math.sin(bLat * r) - Math.sin(aLat * r) * Math.cos(bLat * r) * Math.cos(dLon);
  const deg = ((Math.atan2(y, x) / r) + 360) % 360;
  const bearing = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
  return { km, bearing };
}
