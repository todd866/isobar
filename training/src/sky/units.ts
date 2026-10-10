/** The three units used by a sky picture; web DisplayUnits is structurally compatible. */
export interface DisplayUnits { height: 'ft' | 'm'; temp: 'C' | 'F'; visibility: 'km' | 'sm' }
export const AUS_UNITS: DisplayUnits = { height: 'ft', temp: 'C', visibility: 'km' };
export const feetToMetres = (ft: number) => ft * 0.3048;
export const unitKey = (u: DisplayUnits) => `${u.height}/${u.temp}/${u.visibility}`;
const METRES_PER_STATUTE_MILE = 1609.344;
const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
export function formatTempC(c: number, u: DisplayUnits, _opts?: { unit: boolean }): string {
  return `${Math.round(u.temp === 'F' ? c * 9 / 5 + 32 : c)}°${u.temp}`;
}
export function formatVisibilityMetres(metres: number | null | undefined, units: DisplayUnits): string | null {
  if (!finite(metres)) return null;
  if (units.visibility === 'sm') {
    if (metres >= 9999) return `${(9999 / METRES_PER_STATUTE_MILE).toFixed(1)}+ SM`;
    const sm = metres / METRES_PER_STATUTE_MILE;
    return sm >= 10 ? `${Math.round(sm)} SM` : `${sm.toFixed(1)} SM`;
  }
  if (metres >= 9999) return '10+ km';
  return metres >= 5000 ? `${metres / 1000} km` : `${metres.toLocaleString('en-AU')} m`;
}
