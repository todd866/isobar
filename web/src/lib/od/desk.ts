/** Desk adapters. Published weather is frozen for a sitting; no synthetic fallback. */
import type { Person } from '../../../../training/src/ability';
import { AERODROMES } from './aerodromes';
import { DECREES, ruleStrand } from './decrees';
import { generateDossier } from './generator';
import { schedulerTarget } from './learn';
import { crosswindKt } from './manual';
import type { Dossier, WeatherReport } from './model';
import type { ProfileSeries } from '../sky/physics';
import { weatherFromPublished } from './weather';

export const DESK_ART = ['desk', 'paper', 'emblem', 'stamps', 'captain', 'inspector', 'firstofficer',
  'window-rain', 'window-fog', 'window-snow', 'window-storm', 'window-clear'].map(name => `/od/${name}.webp`);
export type WindowWeather = 'rain' | 'fog' | 'snow' | 'storm' | 'clear' | 'unknown';
export function windowWeather(raw: string | null | undefined): WindowWeather {
  if (!raw?.trim()) return 'unknown';
  const tokens = raw.split(/\s+/).filter(t => /^[+-]?(?:VC)?(?:MI|BC|PR|DR|BL|SH|FZ)?(?:TS|RA|DZ|SN|SG|PL|GR|GS|FG|BR|HZ)+$/.test(t));
  if (tokens.some(t => t.includes('TS'))) return 'storm';
  if (tokens.some(t => /SN|SG|PL/.test(t))) return 'snow';
  if (tokens.some(t => /FG|BR/.test(t))) return 'fog';
  if (tokens.some(t => /RA|DZ/.test(t))) return 'rain';
  return 'clear';
}
export function windReading(heading: number, direction: number, speed: number) {
  if (![heading, direction, speed].every(Number.isFinite) || heading < 0 || heading > 360 || direction < 0 || direction > 360 || speed < 0 || speed > 200) return null;
  const angle = (direction - heading) * Math.PI / 180;
  return { crosswind: crosswindKt(heading, direction, speed), headwind: speed * Math.cos(angle) };
}
export const utc = (value: string | number) => new Date(value).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
export const clock = (value: string | number) => new Date(value).toISOString().slice(11, 16) + 'Z';

async function json(url: string, signal: AbortSignal): Promise<unknown> {
  try { const res = await fetch(url, { signal }); return res.ok ? await res.json() : null; }
  catch (error) { if (signal.aborted) throw error; return null; }
}
export async function loadDeskWeather(signal: AbortSignal): Promise<WeatherReport[]> {
  const capturedAt = new Date().toISOString();
  const [aviation, sky] = await Promise.all([json('/data/aviation.json', signal), json('/data/sky.json', signal)]);
  const profiles = (sky as { profiles?: ProfileSeries[] } | null)?.profiles;
  const reports: WeatherReport[] = [];
  // Two requests at once, at most six stations; collector reports win.
  for (let i = 0; i < AERODROMES.length; i += 2) {
    const batch = await Promise.all(AERODROMES.slice(i, i + 2).map(async ({ station }) => {
      const profile = Array.isArray(profiles) ? profiles.find(p => p.icao === station) : null;
      const existing = weatherFromPublished({ station, aviation, profile, capturedAt });
      if (existing?.metar && existing.taf) return existing;
      const apiReport = await json(`/api/aviation?icao=${station}`, signal);
      return weatherFromPublished({ station, apiReport, profile, capturedAt }) ?? existing;
    }));
    reports.push(...batch.filter((r): r is WeatherReport => r !== null));
  }
  return reports;
}
/** Introduce today's decree first, then revisit the least-established active
 * concept. Every candidate is bounded; unsuitable weather stays unavailable. */
export function nextDossier(reports: WeatherReport[], person: Person, shift: number, position: number, seed: number): Dossier | null {
  const active = DECREES.slice(0, shift);
  const target = active.at(-1)!;
  const candidates = position === 0 ? [target, ...active.filter(d => d !== target)] : [...active].sort((a, b) => {
    const score = (id: string) => { const c = person.concepts[id]; return c ? (c.correct + 1) / (c.exposure + 2) : 0; };
    return score(a.conceptId) - score(b.conceptId);
  });
  for (const rule of candidates) {
    const target = schedulerTarget(person, ruleStrand(rule, person.rules!), () => 0.5, { position, consecutiveFailures: person.consecutiveFailures, lowCommitment: false });
    // Learn may ask below its current ability to warm up. The dossier bank has
    // a finite authored range; keep evidence at the difficulty actually served.
    const difficulty = Math.max(-4, Math.min(4, target.difficulty));
    const generated = generateDossier({ ...target, difficulty, seed, reports, decreeId: rule.id, shift,
      ...(rule.id === 'vfr' ? {} : { aircraft: 'a727' as const }) });
    if (generated.kind === 'ready') return generated.dossier;
  }
  return null;
}
