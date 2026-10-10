/** Phase-1 genus rules. Missing evidence stays unknown; depth alone never implies CB. */
export type Genus = 'cumulus' | 'towering-cumulus' | 'cumulonimbus' | 'stratus' | 'nimbostratus' | 'cirrus' | 'unknown';
export interface RuleLayer { baseFt?: number | null; topFt?: number | null; cover?: string | null; reportedType?: string | null; precipitating?: boolean }
export interface RuleProfile { levels: { heightFt: number; tempC: number | null }[]; capeJkg?: number | null }
const COVER: Record<string, number> = { FEW: 1.5 / 8, SCT: 3.5 / 8, BKN: 6 / 8, OVC: 1 };
export function coverageFraction(cover: unknown): number | null {
  if (typeof cover !== 'string') return null;
  const key = cover.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(COVER, key) ? COVER[key] : null;
}
export function coverageSegments(cover: unknown, seed = 1): { start: number; end: number }[] {
  const fraction = coverageFraction(cover);
  if (fraction == null) return [];
  if (fraction === 1) return [{ start: 0, end: 1 }];
  const rawSeed = Number.isFinite(seed) ? seed : 1;
  const phase = ((rawSeed * 0.754877666 + 0.1234567) % 1 + 1) % 1;
  const count = fraction <= 0.25 ? 1 : 2;
  const spare = 1 - fraction;
  if (count === 1) return [{ start: spare * phase, end: spare * phase + fraction }];
  const gap = spare * (0.35 + 0.3 * phase);
  const offset = (1 - fraction - gap) * phase;
  const left = { start: offset, end: offset + fraction * (0.35 + 0.3 * phase) };
  return [left, { start: left.end + gap, end: offset + fraction + gap }];
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
function explicitGenus(value: unknown): Genus | null {
  if (typeof value !== 'string') return null;
  const type = value.trim().toUpperCase();
  if (['CB', 'TS', 'CUMULONIMBUS'].includes(type)) return 'cumulonimbus';
  if (['TCU', 'TOWERING-CUMULUS'].includes(type)) return 'towering-cumulus';
  if (['CU', 'CUMULUS'].includes(type)) return 'cumulus';
  if (['NS', 'NIMBOSTRATUS'].includes(type)) return 'nimbostratus';
  if (['ST', 'STRATUS'].includes(type)) return 'stratus';
  if (['CI', 'CIRRUS'].includes(type)) return 'cirrus';
  return null;
}
function layerLapse(layer: RuleLayer, profile: RuleProfile | null): number | null {
  if (!profile || !Array.isArray(profile.levels) || !finite(layer.baseFt) || !finite(layer.topFt)) return null;
  const levels = profile.levels.filter(l => finite(l?.heightFt) && finite(l?.tempC) && l.heightFt >= layer.baseFt! && l.heightFt <= layer.topFt!).sort((a,b) => a.heightFt - b.heightFt);
  if (levels.length < 2 || levels.at(-1)!.heightFt === levels[0].heightFt) return null;
  return (levels[0].tempC! - levels.at(-1)!.tempC!) / ((levels.at(-1)!.heightFt - levels[0].heightFt) / 3280.84);
}
export function classifyLayer(layer: RuleLayer | null, profile: RuleProfile | null = null): { genus: Genus; evidence: string; depthFt: number | null } {
  const input = layer && typeof layer === 'object' ? layer : {};
  const baseFt = finite(input.baseFt) ? input.baseFt : null;
  const topFt = finite(input.topFt) ? input.topFt : null;
  const depthFt = baseFt != null && topFt != null && topFt >= baseFt ? topFt - baseFt : null;
  const explicit = explicitGenus(input.reportedType);
  if (explicit) return { genus: explicit, evidence: 'reported type', depthFt };
  const cover = typeof input.cover === 'string' ? input.cover.trim().toUpperCase() : null;
  if (baseFt != null && topFt != null && baseFt >= 20000 && depthFt != null && depthFt > 0 && depthFt <= 6000 && (cover === 'FEW' || cover === 'SCT' || cover == null)) return { genus: 'cirrus', evidence: 'high thin layer', depthFt };
  const lapse = layerLapse(input, profile);
  const unstable = lapse != null ? lapse >= 5.5 : (finite(profile?.capeJkg) && profile.capeJkg >= 100);
  const stable = lapse != null && lapse < 5.5;
  if (unstable && depthFt != null && depthFt >= 8000) return { genus: 'towering-cumulus', evidence: 'unstable profile and deep layer', depthFt };
  if (unstable && ['FEW','SCT','BKN'].includes(cover ?? '')) return { genus: 'cumulus', evidence: 'unstable profile', depthFt };
  if ((input.precipitating === true && ['BKN','OVC'].includes(cover ?? '') && depthFt != null && depthFt >= 5000) || (stable && input.precipitating === true && cover === 'BKN' && depthFt != null && depthFt >= 3000)) return { genus: 'nimbostratus', evidence: stable ? 'deep stable rain deck' : 'deep rain deck', depthFt };
  if (stable && ['BKN','OVC'].includes(cover ?? '')) return { genus: 'stratus', evidence: 'stable sheet', depthFt };
  return { genus: 'unknown', evidence: 'insufficient evidence', depthFt };
}
export function precipitationBands(layer: RuleLayer | null, freezingFt: number | null, groundFt = 0): { baseFt: number; topFt: number; phase: string }[] {
  if (!layer || layer.precipitating !== true || !finite(layer.baseFt) || !finite(groundFt) || layer.baseFt <= groundFt) return [];
  if (layer.topFt != null && (!finite(layer.topFt) || layer.topFt <= layer.baseFt)) return [];
  if (!finite(freezingFt)) return [{ baseFt: groundFt, topFt: layer.baseFt, phase: 'unknown' }];
  const bands = [];
  if (freezingFt > groundFt) bands.push({ baseFt: groundFt, topFt: Math.min(freezingFt, layer.baseFt), phase: 'rain' });
  if (freezingFt < layer.baseFt) bands.push({ baseFt: Math.max(freezingFt, groundFt), topFt: layer.baseFt, phase: 'snow' });
  return bands.filter(b => b.topFt > b.baseFt);
}
