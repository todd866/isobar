/**
 * Browser side of the sky section preview (scripts/sky-preview.ts): renders
 * real aerodromes and a synthetic gallery into canvases, and benchmarks
 * scrubbing frame times.
 */
import { skyState, type ProfileSeries, type SkyState } from '../src/lib/sky/physics';
import { SkyAnimator, type SkyOptions } from '../src/lib/sky/render';
import { sceneFor, type SkyAirport } from '../src/lib/sky/scene';
import { synthProfile } from '../src/lib/sky/synthetic';

declare global {
  interface Window {
    SKY_DATA: { sky: { profiles: ProfileSeries[] }; aviation: { airports: SkyAirport[] }; nowMs: number };
    renderCase: (spec: CaseSpec, size: { width: number; height: number; dark: boolean }) => string;
    scrubBench: (spec: { icao: string; width: number; height: number; dark: boolean; frames: number }) => Promise<{ p50: number; p95: number; max: number; raf95: number; builds: number; buildP95: number; frames: number }>;
  }
}

type CaseSpec = { kind: 'real'; icao: string; offsetH: number } | { kind: 'synthetic'; name: string };

const PERTH = { icao: 'YPPH', elevationFt: 67, lat: -31.94, lon: 115.97 };
// 01:30 UTC = 09:30 Perth: morning sun from the east.
const MORNING = Date.UTC(2026, 9, 8, 1, 30);
const AFTERNOON = Date.UTC(2026, 9, 8, 7, 0);

const SYNTHETIC: Record<string, () => SkyState> = {
  'cb-ts': () => skyState({
    ...PERTH, timeMs: AFTERNOON, source: 'METAR',
    groups: [{ body: 'METAR YPPH 080700Z 27025G40KT 2000 +TSRA SCT025CB FEW035TCU 26/21 Q1004', change: null }],
    profile: synthProfile({ surfaceT: 30, lapse: 7.4, rh: (z) => (z < 3500 ? 78 : z < 7000 ? 55 : 40), wind: (z) => [10 + z / 250, 280] }),
  }),
  'stratus-dz-br': () => skyState({
    ...PERTH, timeMs: MORNING, source: 'METAR',
    groups: [{ body: 'METAR YPPH 080130Z 18005KT 3000 DZ BR OVC006 13/12 Q1022', change: null }],
    profile: synthProfile({ surfaceT: 13, lapse: 1.5, lapseTop: 1500, rh: (z) => (z < 800 ? 98 : 35), wind: (z) => [5 + z / 600, 180] }),
  }),
  'cumulus-fair': () => skyState({
    ...PERTH, timeMs: MORNING + 3 * 3_600_000, source: 'METAR',
    groups: [{ body: 'METAR YPPH 080430Z 22012KT 9999 SCT040 24/10 Q1016', change: null }],
    profile: synthProfile({ surfaceT: 24, lapse: 9.5, lapseTop: 1400, rh: (z) => (z < 1400 ? 55 : z < 2200 ? 82 : 30), wind: (z) => [12 + z / 500, 250] }),
  }),
  'cirrus-only': () => skyState({
    ...PERTH, timeMs: AFTERNOON + 3_600_000 * 3.2, source: 'TAF',
    groups: [{ body: '27010KT CAVOK', change: null }],
    profile: synthProfile({ surfaceT: 22, rh: (z) => (z > 9000 && z < 10800 ? 88 : 25), cloud: (z) => (z > 9000 && z < 10800 ? 55 : 0), wind: (z) => [10 + z / 120, 290] }),
  }),
  fog: () => skyState({
    ...PERTH, timeMs: Date.UTC(2026, 9, 7, 23, 30), source: 'METAR',
    groups: [{ body: 'METAR YPPH 072230Z 00000KT 0200 FG VV001 08/08 Q1025', change: null }],
    profile: synthProfile({ surfaceT: 8, lapse: -3, lapseTop: 300, rh: (z) => (z < 300 ? 100 : 40), wind: () => [3, 90] }),
  }),
  'ac-as-virga': () => skyState({
    ...PERTH, timeMs: AFTERNOON - 3_600_000 * 2, source: 'none', groups: [],
    profile: synthProfile({ surfaceT: 27, rh: (z) => (z > 3800 && z < 6400 ? 95 : z > 3000 && z < 3800 ? 70 : 25), cloud: (z) => (z > 3800 && z < 6400 ? 90 : 0), wind: (z) => [15 + z / 300, 300] }),
  }),
  'sc-night': () => skyState({
    ...PERTH, timeMs: Date.UTC(2026, 9, 8, 15), source: 'METAR',
    groups: [{ body: 'METAR YPPH 081500Z 24010KT 9999 BKN030 14/09 Q1018', change: null }],
    profile: synthProfile({ surfaceT: 14, lapse: 5, rh: (z) => (z > 800 && z < 1500 ? 92 : 50), cloud: (z) => (z > 800 && z < 1500 ? 80 : 0) }),
  }),
};

function stateFor(spec: CaseSpec): { state: SkyState; seed: string; coastKm: number | null } {
  const data = window.SKY_DATA;
  if (spec.kind === 'synthetic') return { state: SYNTHETIC[spec.name](), seed: `synthetic|${spec.name}`, coastKm: -19 };
  const airport = data.aviation.airports.find((a) => a.icao === spec.icao)!;
  const series = data.sky.profiles.find((p) => p.icao === spec.icao) ?? null;
  const t = data.nowMs + spec.offsetH * 3_600_000;
  return { state: sceneFor(airport, series, t, data.nowMs), seed: `${spec.icao}|${series?.run ?? ''}`, coastKm: series?.coastKm ?? null };
}

window.renderCase = (spec, size) => {
  const { state, seed, coastKm } = stateFor(spec);
  document.body.innerHTML = '';
  document.body.style.background = size.dark ? '#111418' : '#f6f7f9';
  const canvas = document.createElement('canvas');
  canvas.id = 'sky';
  canvas.style.width = `${size.width}px`;
  canvas.style.height = `${size.height}px`;
  canvas.style.display = 'block';
  document.body.append(canvas);
  const options: SkyOptions = { width: size.width, height: size.height, dpr: window.devicePixelRatio || 1, dark: size.dark, seed, coastKm };
  new SkyAnimator(canvas).showNow(state, options);
  return JSON.stringify({ source: state.source, layers: state.layers.map((l) => `${l.type} ${l.cover} ${Math.round(l.baseFtAmsl)}-${l.topFtAmsl == null ? '?' : Math.round(l.topFtAmsl)} ${l.precip}`), fz: state.freezingFt, sun: state.sun.elevationDeg });
};

window.scrubBench = async ({ icao, width, height, dark, frames }) => {
  const data = window.SKY_DATA;
  const airport = data.aviation.airports.find((a) => a.icao === icao)!;
  const series = data.sky.profiles.find((p) => p.icao === icao) ?? null;
  document.body.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  document.body.append(canvas);
  const animator = new SkyAnimator(canvas);
  const dpr = window.devicePixelRatio || 1;
  const work: number[] = [];
  const intervals: number[] = [];
  let last = 0;
  await new Promise<void>((resolve) => {
    let i = 0;
    const loop = (now: number) => {
      const t0 = performance.now();
      // Scrub 0 → 24 h and back, 12 forecast minutes per frame.
      const phase = (i * 12) % (48 * 60);
      const minute = phase <= 24 * 60 ? phase : 48 * 60 - phase;
      const state = sceneFor(airport, series, data.nowMs + minute * 60_000, data.nowMs);
      animator.show(state, { width, height, dpr, dark, seed: `${icao}|${series?.run ?? ''}`, coastKm: series?.coastKm ?? null });
      work.push(performance.now() - t0);
      if (last) intervals.push(now - last);
      last = now;
      if (++i < frames) requestAnimationFrame(loop); else resolve();
    };
    requestAnimationFrame(loop);
  });
  // The animator's own frame work (incremental builds + crossfade) runs in its rAF callback.
  const animatorFrames = animator.stats.frames.slice(-frames);
  const combined = work.map((w, index) => w + (animatorFrames[index] ?? 0));
  const pct = (list: number[], p: number) => { const s = [...list].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
  animator.dispose();
  return {
    p50: pct(combined, 0.5), p95: pct(combined, 0.95), max: Math.max(...combined), raf95: pct(intervals, 0.95),
    builds: animator.stats.builds.length, buildP95: pct(animator.stats.builds, 0.95), frames: combined.length,
  };
};
