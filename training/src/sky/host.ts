/**
 * The Mac app's sky section page (sky.html): the web renderer, fed by the
 * app. The app builds one point's feed natively (the pressure-level profile,
 * the elevation and, at an aerodrome, METAR/TAF) and moves the time with the
 * map's playhead. The app keeps one call in flight, so each call draws at once; the
 * animator builds new pictures across frames and caches them, so scrubbing
 * only crossfades.
 *
 *   window.isobarSky.feed({ lat, lon, name, elevationFt, coastKm, profile, report, nowMs, timeMs })
 *   window.isobarSky.time(ms)
 *   window.isobarSky.theme(dark)
 *
 * After each new picture, window.skyState holds what was drawn and the app is
 * told through the `sky` message handler.
 */
import { profileAt, skyState, type ProfileSeries, type SkyState } from './physics.ts';
import { SkyAnimator, stateKey, yForFt, type SkyOptions } from './render.ts';
import { reportAt, type SkyAirport } from './scene.ts';

/**
 * One point's feed: any place, not only an aerodrome. The profile is the
 * pressure-level series (ECMWF upper air today; any per-point source later);
 * the report (METAR/TAF) is optional and only an aerodrome has one.
 */
export interface SkyFeed {
  lat: number;
  lon: number;
  /** Shown on the ground line and used as the picture's seed, e.g. "YPPH". */
  name: string;
  /** Ground elevation, ft AMSL (AIP for an aerodrome). */
  elevationFt: number;
  /** Signed distance to the coast along the W–E section, km; null inland or unknown. */
  coastKm: number | null;
  profile: ProfileSeries | null;
  report: { metar: SkyAirport['metar']; taf: SkyAirport['taf'] } | null;
  nowMs: number;
  timeMs?: number;
}

export interface SkySummary {
  icao: string;
  timeMs: number;
  source: SkyState['source'];
  hasProfile: boolean;
  elevationFt: number;
  freezingFt: number | null;
  notes: string[];
  width: number;
  height: number;
  /** Each layer as drawn; baseY is the base's height on the canvas, CSS px from the top. */
  layers: { type: string; cover: string; baseFtAmsl: number; topFtAmsl: number | null; precip: string; source: string; secondary: boolean; baseY: number }[];
  pictures: number;
}

declare global {
  interface Window {
    isobarSky: { feed: (feed: SkyFeed) => void; time: (ms: number) => void; theme: (dark: boolean) => void; pictures: () => number; flush: () => void };
    skyState: SkySummary | null;
    __SKY_THEME?: string;
    __SKY_READY?: boolean;
    webkit?: { messageHandlers?: { sky?: { postMessage: (body: unknown) => void } } };
  }
}

const canvas = document.getElementById('sky') as HTMLCanvasElement;
const note = document.getElementById('note') as HTMLElement;
const animator = new SkyAnimator(canvas);
let feed: SkyFeed | null = null;
let timeMs = NaN;
let dark = window.__SKY_THEME === 'dark';
let frame = 0;
let shownKey = '';
let last: { state: SkyState; options: SkyOptions } | null = null;

function applyTheme() {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(render);
}

function render() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  if (!feed) return;
  const width = Math.max(1, Math.round(window.innerWidth));
  const height = Math.max(1, Math.round(window.innerHeight));
  const t = Number.isFinite(timeMs) ? timeMs : feed.nowMs;
  const report = feed.report
    ? reportAt({ icao: feed.name, lat: feed.lat, lon: feed.lon, metar: feed.report.metar, taf: feed.report.taf }, t, feed.nowMs)
    : { source: 'none' as const, groups: [] };
  const state = skyState({
    icao: feed.name,
    elevationFt: feed.elevationFt,
    lat: feed.lat,
    lon: feed.lon,
    timeMs: t,
    source: report.source,
    groups: report.groups,
    profile: profileAt(feed.profile, t),
  });
  const options: SkyOptions = {
    width,
    height,
    dpr: Math.min(3, window.devicePixelRatio || 1),
    dark,
    seed: `${feed.name}|${feed.profile?.run ?? ''}`,
    coastKm: feed.coastKm,
    compact: height < 80,
  };
  animator.show(state, options);
  last = { state, options };
  const key = stateKey(state, options);
  if (key === shownKey) return;
  shownKey = key;
  note.textContent = state.notes[0] ?? '';
  note.hidden = !state.notes.length || height < 80;
  const summary: SkySummary = {
    icao: state.icao,
    timeMs: state.timeMs,
    source: state.source,
    hasProfile: state.hasProfile,
    elevationFt: state.elevationFt,
    freezingFt: state.freezingFt,
    notes: state.notes,
    width,
    height,
    layers: state.layers.map((layer) => ({
      type: layer.type,
      cover: layer.cover,
      baseFtAmsl: layer.baseFtAmsl,
      topFtAmsl: layer.topFtAmsl,
      precip: layer.precip,
      source: layer.source,
      secondary: layer.secondary,
      baseY: yForFt(layer.baseFtAmsl, height),
    })),
    pictures: animator.stats.builds.length,
  };
  window.skyState = summary;
  window.webkit?.messageHandlers?.sky?.postMessage(summary);
}

window.skyState = null;
window.isobarSky = {
  feed(next) {
    feed = next;
    if (next.timeMs != null && Number.isFinite(next.timeMs)) timeMs = next.timeMs;
    shownKey = '';
    render();
  },
  time(ms) {
    if (!Number.isFinite(ms) || ms === timeMs) return;
    timeMs = ms;
    render();
  },
  // Draw the current state now, without waiting for animation frames (an
  // occluded or offscreen window gets none): captures and tests.
  flush() {
    render();
    if (last) animator.showNow(last.state, last.options);
  },
  pictures: () => animator.stats.builds.length,
  theme(next) {
    if (next === dark) return;
    dark = next;
    applyTheme();
    shownKey = '';
    render();
  },
};
applyTheme();
new ResizeObserver(() => { shownKey = ''; schedule(); }).observe(document.body);
window.__SKY_READY = true;
window.webkit?.messageHandlers?.sky?.postMessage({ ready: true });
