'use client';

/**
 * The Fly lens: one instrument row, the sky section and the TAF as one
 * timeline, with the raw METAR/TAF behind a single disclosure. A collector
 * sky series is used when the aerodrome has one; otherwise the section is
 * the Open-Meteo profile at the aerodrome.
 *
 * Phone: a bottom sheet over the map with two detents. Peek is the
 * instrument row and a sky thumbnail; expanded adds the sky section as the
 * hero. Desktop: the same content in the 400 px side panel.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { tafGroups } from '../../../training/src/taf.ts';
import type { AviationAirport } from '@/lib/chart-store';
import { distanceBearing } from '@/lib/metar-view';
import { formatCeilingFeet, formatVisibilityMetres, feetToMetres, type DisplayUnits } from '@/lib/units';
import { useUnits } from './UnitsControl';
import { loadPointProfile, pointCacheKey } from '@/lib/point/openmeteo';
import { forecastRunLabel, forecastRunTitle } from '@/lib/point/provenance';
import type { ProfileSeries } from '@/lib/sky/physics';
import { parseReport, type SkyState } from '@/lib/sky/physics';
import { SkyAnimator } from '@/lib/sky/render';
import { readout, reportAt, sceneFor, type SkyFile } from '@/lib/sky/scene';
import { skySeries } from '@/lib/sky/series';
import { formatClock, zonedStamp } from '@/lib/time-label';
import { useMapSheet } from './MapSheet';
import type { SkyOptions } from '@/lib/sky/render';

/* ---------- data ---------- */

let skyFile: Promise<SkyFile | null> | null = null;
export function loadSky(): Promise<SkyFile | null> {
  skyFile ??= fetch('/data/sky.json').then((response) => (response.ok ? response.json() as Promise<SkyFile> : null)).catch(() => null);
  return skyFile;
}

function useSkySeries(airport: AviationAirport | null, validMs: number): ProfileSeries | null | undefined {
  const [collector, setCollector] = useState<ProfileSeries | null | undefined>(undefined);
  const [liveSeries, setLiveSeries] = useState<{ key: string; series: ProfileSeries | null }>({ key: '', series: null });
  const icao = airport?.icao ?? null;
  const lat = airport?.lat;
  const lon = airport?.lon;
  const day = Math.floor(validMs / 86_400_000);
  const timeRef = useRef(validMs);
  timeRef.current = validMs;
  useEffect(() => {
    let live = true;
    setCollector(undefined);
    void loadSky().then((file: SkyFile | null) => {
      if (live) setCollector(file?.profiles.find((profile) => profile.icao === icao) ?? null);
    });
    return () => { live = false; };
  }, [icao]);
  useEffect(() => {
    if (collector !== null || lat == null || lon == null || !icao) return;
    const controller = new AbortController();
    const when = timeRef.current;
    const key = `${icao}:${pointCacheKey(lat, lon, when)}`;
    void loadPointProfile(lat, lon, { mapTimeMs: when, signal: controller.signal })
      .then((model) => { if (!controller.signal.aborted) setLiveSeries({ key, series: skySeries(null, model, { icao, lat, lon }) }); })
      .catch(() => { if (!controller.signal.aborted) setLiveSeries({ key, series: null }); });
    return () => controller.abort();
  }, [icao, lat, lon, collector, day]);
  if (!airport || lat == null || lon == null) return null;
  if (collector === undefined) return undefined;
  if (collector) return collector;
  const key = `${icao}:${pointCacheKey(lat, lon, validMs)}`;
  return liveSeries.key === key ? liveSeries.series : undefined;
}

function useDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.classList.contains('dark'));
    update();
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

/* ---------- the sky canvas ---------- */

export function SkyCanvas({ state, seed, coastKm, height, compact, label, mode, groundKnown }: { state: SkyState; seed: string; coastKm: number | null; height: number; compact?: boolean; label: string; mode?: SkyOptions['mode']; groundKnown?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animatorRef = useRef<SkyAnimator | null>(null);
  const [width, setWidth] = useState(0);
  const dark = useDark();
  const { units } = useUnits();
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const animator = new SkyAnimator(canvas);
    animatorRef.current = animator;
    (canvas as HTMLCanvasElement & { skyStats?: unknown }).skyStats = animator.stats;
    const observer = new ResizeObserver(() => setWidth(Math.round(canvas.getBoundingClientRect().width)));
    observer.observe(canvas);
    return () => { observer.disconnect(); animator.dispose(); animatorRef.current = null; };
  }, []);
  useEffect(() => {
    if (!animatorRef.current || width < 10) return;
    const canvas = canvasRef.current as (HTMLCanvasElement & { skyState?: SkyState }) | null;
    if (canvas) canvas.skyState = state;
    animatorRef.current.show(state, { width, height, dpr: Math.min(3, window.devicePixelRatio || 1), dark, seed, coastKm, compact, mode, groundKnown, units });
  }, [state, width, height, dark, seed, coastKm, compact, mode, groundKnown, units]);
  return <canvas ref={canvasRef} role="img" aria-label={label} className="block w-full" style={{ height }} data-sky-canvas={mode === 'column' ? 'column' : compact ? 'thumb' : 'section'} />;
}

function describe(state: SkyState, units: DisplayUnits): string {
  const fmt = (ft: number) => units.height === 'm'
    ? `${Math.round(feetToMetres(ft)).toLocaleString('en-AU')} m`
    : `${Math.round(ft / 100) * 100} ft`;
  const parts = state.layers.map((layer) => `${layer.cover} ${layer.type} base ${fmt(layer.baseFtAmsl)}${layer.topFtAmsl != null ? ` top ${fmt(layer.topFtAmsl)}` : ''}${layer.precip !== 'none' ? `, ${layer.precip}` : ''}`);
  if (state.freezingFt != null) parts.push(`freezing level ${fmt(state.freezingFt)}`);
  if (state.winds.length) {
    const wind = [...state.winds].sort((a, b) => a.ftAmsl - b.ftAmsl)[0];
    parts.push(`wind ${Math.round(wind.fromDeg)}°/${Math.round(wind.kt)} kt`);
  }
  const datum = units.height === 'm' ? 'metres AMSL' : 'feet AMSL';
  return `Sky section ${state.icao}, west to east 40 NM, ${datum}: ${parts.join('; ') || 'no cloud'}`;
}

/* ---------- the TAF timeline ---------- */

function hourLabel(ms: number, zone: string): string {
  return zonedStamp(ms, zone).hour;
}

function groupSummary(body: string, units: DisplayUnits): string {
  const report = parseReport(body);
  const parts: string[] = [];
  for (const item of report.weather) parts.push(item.token);
  const clouds = report.layers.map((layer) => `${layer.cover}${String(layer.baseFtAgl / 100).padStart(3, '0')}${layer.type ?? ''}`);
  if (report.noCloud) parts.push(report.noCloud);
  parts.push(...clouds);
  if (report.visM != null && report.visM < 9999 && report.noCloud !== 'CAVOK') {
    parts.unshift(units.visibility === 'km'
      ? (report.visM >= 5000 ? `${report.visM / 1000}km` : `${report.visM}m`)
      : (formatVisibilityMetres(report.visM, units) ?? ''));
  }
  return parts.join(' ') || body.split(/\s+/).slice(0, 2).join(' ');
}

function severity(body: string): 0 | 1 | 2 {
  const report = parseReport(body);
  if (report.weather.some((w) => w.descriptor === 'TS' || w.intensity === '+') || report.layers.some((l) => l.type === 'CB')) return 2;
  const ceiling = report.layers.filter((l) => l.cover === 'BKN' || l.cover === 'OVC' || l.cover === 'VV').map((l) => l.baseFtAgl);
  if ((report.visM != null && report.visM < 5000) || (ceiling.length && Math.min(...ceiling) < 1500)) return 1;
  return 0;
}

const TONE = ['bg-[var(--md-surface-container-highest)]', 'bg-[#e8a33d]/35', 'bg-[#c0392b]/30'];

function TafTimeline({ taf, validMs, zone }: { taf: NonNullable<AviationAirport['taf']>; validMs: number; zone: string }) {
  const { units } = useUnits();
  const groups = tafGroups({ raw: taf.raw, issue: taf.issue, from: taf.from, to: taf.to });
  const from = taf.from ? Date.parse(taf.from) : NaN;
  const to = taf.to ? Date.parse(taf.to) : NaN;
  if (!groups || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  const x = (ms: number) => `${Math.max(0, Math.min(1, (ms - from) / (to - from))) * 100}%`;
  const width = (a: number, b: number) => `${Math.max(0, (Math.min(b, to) - Math.max(a, from)) / (to - from)) * 100}%`;
  const prevailing = groups.filter((g) => g.kind === 'base' || g.kind === 'FM' || g.kind === 'BECMG');
  const temporary = groups.filter((g) => g.kind === 'TEMPO' || g.kind === 'INTER' || g.kind === 'PROB30' || g.kind === 'PROB40');
  // Prevailing segments run from their effective time to the next one.
  const effective = prevailing.map((g) => (g.kind === 'BECMG' ? g.end : g.start));
  const ticks: number[] = [];
  for (let t = Math.ceil(from / 10_800_000) * 10_800_000; t < to; t += 10_800_000) ticks.push(t);
  const inPlay = validMs >= from && validMs < to;
  return (
    <div className="relative select-none" data-taf-timeline aria-label="TAF timeline" role="group">
      <div className="relative h-[22px] overflow-hidden rounded-[4px]">
        {prevailing.map((group, index) => {
          const start = effective[index];
          const end = effective[index + 1] ?? to;
          return (
            <div key={index} title={`${group.marker || 'TAF'} ${group.body}`} className={`absolute inset-y-0 flex items-center overflow-hidden border-r border-[var(--md-surface)] px-1 text-[11px] font-medium whitespace-nowrap tabular-nums ${TONE[severity(group.body)]}`} style={{ left: x(start), width: width(start, end) }}>
              {groupSummary(group.body, units)}
            </div>
          );
        })}
      </div>
      {temporary.length ? (
        <div className="relative mt-[2px] h-[16px]">
          {temporary.map((group, index) => (
            <div key={index} title={`${group.marker} ${group.body}`} className={`absolute inset-y-0 flex items-center overflow-hidden rounded-[3px] px-1 text-[10px] whitespace-nowrap ${TONE[Math.max(1, severity(group.body))]}`} style={{ left: x(group.start), width: width(group.start, group.end), backgroundImage: 'repeating-linear-gradient(135deg, transparent 0 4px, rgba(127,127,127,.18) 4px 6px)' }}>
              {group.kind} {groupSummary(group.body, units)}
            </div>
          ))}
        </div>
      ) : null}
      <div className="relative h-[13px] text-[10px] leading-[13px] text-[var(--md-on-surface-variant)] tabular-nums">
        {ticks.map((t) => <span key={t} className="absolute -translate-x-1/2" style={{ left: x(t) }}>{hourLabel(t, zone)}</span>)}
      </div>
      {inPlay ? <div className="pointer-events-none absolute -top-[2px] bottom-[11px] w-[2px] -translate-x-1/2 rounded bg-[var(--md-primary)]" style={{ left: x(validMs) }} data-taf-playhead /> : null}
    </div>
  );
}

/* ---------- the instrument row ---------- */

function localTime(ms: number, zone: string): string {
  return Number.isFinite(ms) ? formatClock(ms, zone, false) : '';
}

function Readout({ airport, where, validMs, nowMs, zone, trailing }: { airport: AviationAirport; where: string; validMs: number; nowMs: number; zone: string; trailing?: ReactNode }) {
  const { units } = useUnits();
  const { source, groups } = reportAt(airport, validMs, nowMs);
  const reading = readout(source, groups, units);
  const hazard = reading.hazards[0];
  const cloud = reading.ceilingFt != null ? `CIG ${formatCeilingFeet(reading.ceilingFt, units)}` : reading.cloud;
  return (
    <div className="@container flex h-[36px] min-w-0 items-center gap-2.5 overflow-hidden text-[14px] font-medium whitespace-nowrap tabular-nums" data-fly-readout>
      <span className="shrink-0 text-[16px] font-semibold tracking-wide" title={where}>{airport.icao}</span>
      <span className="shrink-0 text-[11px] font-semibold text-[var(--md-on-surface-variant)]" title={source === 'METAR' ? 'Observed' : source === 'TAF' ? 'Forecast' : 'No report at this time'}>{source === 'none' ? '—' : source}</span>
      {hazard ? <span className={`min-w-0 truncate ${hazard.severe ? 'font-semibold text-[#c0392b]' : 'font-semibold text-[var(--md-warning)]'}`} title="Weather in force">{hazard.text}</span> : null}
      {cloud ? <span className="shrink-0 @max-[330px]:hidden" title={reading.ceilingFt != null ? (units.height === 'm' ? 'Ceiling, m above the aerodrome' : 'Ceiling, ft above the aerodrome') : 'Lowest cloud'}>{cloud}</span> : null}
      {reading.vis ? <span className="shrink-0 @max-[400px]:hidden" title="Visibility">{reading.vis}</span> : null}
      {reading.wind ? <span className="shrink-0" title="Wind, ° true / kt">{reading.wind}</span> : null}
      {source === 'METAR' && airport.metar?.time ? <span className="shrink-0 text-[12px] text-[var(--md-on-surface-variant)] @max-[400px]:hidden" title="Observation time">{localTime(Date.parse(airport.metar.time), zone)}</span> : null}
      <span className="ml-auto flex shrink-0 items-center">{trailing}</span>
    </div>
  );
}

/* ---------- raw text ---------- */

function RawReports({ airport, validMs, nowMs, zone }: { airport: AviationAirport; validMs: number; nowMs: number; zone: string }) {
  const [open, setOpen] = useState(false);
  const metarMs = airport.metar?.time ? Date.parse(airport.metar.time) : NaN;
  const age = Number.isFinite(metarMs) ? Math.round((nowMs - metarMs) / 60000) : null;
  const taf = airport.taf;
  const tafLines = taf ? taf.raw.split(/\s+(?=(?:FM\d|TEMPO|INTER|BECMG|PROB\d{2}))/).filter(Boolean) : [];
  const inForce = reportAt(airport, validMs, nowMs).groups;
  const marked = (line: string) => inForce.some((group) => group.change ? line.startsWith(group.change.slice(0, 4)) && line.includes(group.body.split(' ')[0]) : line.endsWith(group.body) || line.includes(group.body));
  return (
    <div data-raw-reports>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex h-8 w-full items-center gap-2 text-left text-[12px] text-[var(--md-on-surface-variant)] tabular-nums hover:text-[var(--md-on-surface)]">
        <span aria-hidden="true" className={`inline-block transition-transform ${open ? 'rotate-90' : ''}`}>▸</span>
        <span className="font-semibold">METAR</span>
        <span className={age != null && age > 90 ? 'text-[var(--md-warning)]' : ''}>{Number.isFinite(metarMs) ? `${localTime(metarMs, zone)} · ${age != null && age < 90 ? `${age} m` : `${Math.round((age ?? 0) / 60)} h`}` : '—'}</span>
        <span className="font-semibold">TAF</span>
        <span>{taf?.from && taf.to ? `${zonedStamp(Date.parse(taf.from), zone).day} ${localTime(Date.parse(taf.from), zone)}–${zonedStamp(Date.parse(taf.to), zone).day} ${localTime(Date.parse(taf.to), zone)}` : '—'}</span>
      </button>
      {open ? (
        <pre className="overflow-x-auto px-1 pb-1 font-mono text-[12px] leading-[1.45] whitespace-pre-wrap">
          {airport.metar ? <div>{airport.metar.raw}</div> : null}
          {tafLines.map((line, index) => (
            <div key={index} className={marked(line) ? 'bg-[var(--md-primary)]/15' : ''}>{index === 0 ? line : `  ${line}`}</div>
          ))}
        </pre>
      ) : null}
    </div>
  );
}

/* ---------- the panel ---------- */

const PEEK_PX = 46;
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const };

export function FlyPanel({
  airport,
  place,
  zone,
  validMs,
  nowMs,
  onClose,
  anchorRef,
}: {
  airport: AviationAirport | null;
  place: { lat: number; lon: number } | null;
  zone: string;
  validMs: number;
  nowMs: number;
  onClose: () => void;
  /** The map panel the phone sheet sits on. */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const { desktop, anchor } = useMapSheet(anchorRef);
  const { units } = useUnits();
  const [detent, setDetent] = useState<'peek' | 'full'>('peek');
  const series = useSkySeries(airport, validMs);
  const drag = useRef<{ y: number; moved: boolean } | null>(null);

  const state = useMemo(() => (airport && series !== undefined ? sceneFor(airport, series, validMs, nowMs) : null), [airport, series, validMs, nowMs]);

  const close = (
    <button type="button" aria-label="Close Fly" onClick={onClose} className="grid h-8 w-8 place-items-center rounded-md text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]">
      <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path {...stroke} d="M6 6l12 12M18 6 6 18" /></svg>
    </button>
  );

  if (!airport) {
    return (
      <aside className={desktop
        ? 'flex w-[400px] shrink-0 items-center justify-between gap-2 border-l border-[var(--md-outline-soft)] bg-[var(--md-surface)] p-3 text-sm'
        : 'absolute inset-x-0 bottom-0 z-10 flex items-center justify-between gap-2 bg-[var(--md-surface)] p-3 text-sm'} aria-label="Aerodrome" data-fly-panel data-fly-sheet={desktop ? undefined : 'peek'}>
        <span>No aerodrome report in this export.</span>
        {close}
      </aside>
    );
  }

  const near = place ? distanceBearing(place.lat, place.lon, airport.lat, airport.lon) : null;
  const where = near && near.km >= 1 ? `${airport.name} · ${Math.round(near.km)} km ${near.bearing}` : airport.name;
  const seed = `${airport.icao}|${series?.run ?? 'none'}`;
  const coastKm = series?.coastKm ?? null;
  const fullHeight = anchor ? Math.max(PEEK_PX, Math.min(anchor.bottom - anchor.ceiling, 520)) : PEEK_PX;
  // Phone: the sky takes what the sheet has left after the row, the TAF timeline and the disclosure.
  const skyHeight = desktop ? 270 : Math.round(Math.max(130, Math.min(330, fullHeight - PEEK_PX - (airport.taf ? 58 : 18) - 32 - 20)));
  const runLabel = series ? forecastRunLabel({ source: series.source, model: series.model, run: series.run, cycle: series.runKnown !== false }) : null;
  const section = state ? (
    <div className="relative">
      {series && runLabel ? <span data-sky-run title={forecastRunTitle({ source: series.source, model: series.model, run: series.run, cycle: series.runKnown !== false })} className="pointer-events-none absolute top-1 left-2 z-[1] rounded bg-[var(--md-surface)]/85 px-1 text-[11px] font-semibold tabular-nums text-[var(--md-on-surface)]">{runLabel}</span> : null}
      <SkyCanvas state={state} seed={seed} coastKm={coastKm} height={skyHeight} label={describe(state, units)} />
    </div>
  ) : <div style={{ height: skyHeight }} />;
  const body = (
    <>
      <div className="overflow-hidden rounded-lg">{section}</div>
      {airport.taf ? <TafTimeline taf={airport.taf} validMs={validMs} zone={zone} /> : <div className="text-[12px] text-[var(--md-on-surface-variant)]">No TAF</div>}
      <RawReports airport={airport} validMs={validMs} nowMs={nowMs} zone={zone} />
    </>
  );

  if (desktop) {
    // Capped at half the viewport so a 200%-zoom reflow (640px CSS) keeps a usable map beside the panel.
    return (
      <aside className="flex min-h-0 w-[min(400px,50vw)] shrink-0 flex-col gap-2 overflow-y-auto border-l border-[var(--md-outline-soft)] p-3" aria-label="Aerodrome" data-fly-panel>
        <Readout airport={airport} where={where} validMs={validMs} nowMs={nowMs} zone={zone} trailing={close} />
        {body}
      </aside>
    );
  }

  const height = detent === 'full' ? fullHeight : PEEK_PX;
  const toggle = () => setDetent((value) => (value === 'peek' ? 'full' : 'peek'));
  return (
    <aside
      aria-label="Aerodrome"
      data-fly-panel
      data-fly-sheet={detent}
      className="fixed z-30 flex flex-col overflow-hidden rounded-t-[14px] border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)] shadow-[0_-6px_18px_rgba(0,0,0,0.12)] transition-[height] duration-200 ease-out"
      style={anchor ? { left: anchor.left, width: anchor.width, top: anchor.bottom - height, height } : { left: 0, right: 0, bottom: 0, height }}
    >
      <button
        type="button"
        aria-label={detent === 'peek' ? 'Expand Fly' : 'Collapse Fly'}
        aria-expanded={detent === 'full'}
        data-sheet-grabber
        className="relative flex h-[9px] w-full shrink-0 touch-none items-start justify-center pt-[4px] before:absolute before:inset-x-0 before:top-0 before:h-6 before:content-['']"
        onClick={() => { if (!drag.current?.moved) toggle(); drag.current = null; }}
        onPointerDown={(event) => { drag.current = { y: event.clientY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          const dy = event.clientY - start.y;
          if (Math.abs(dy) > 24) {
            start.moved = true;
            setDetent(dy < 0 ? 'full' : 'peek');
          }
        }}
      >
        <span className="h-[4px] w-9 rounded-full bg-[var(--md-outline)]" />
      </button>
      <div className="min-w-0 shrink-0 px-3">
        <Readout
          airport={airport}
          where={where}
          validMs={validMs}
          nowMs={nowMs}
          zone={zone}
          trailing={<>
            {detent === 'peek' && state ? <button type="button" aria-label="Show sky section" onClick={() => setDetent('full')} className="block w-[72px] overflow-hidden rounded-[4px] @max-[440px]:hidden"><SkyCanvas state={state} seed={seed} coastKm={coastKm} height={30} compact label={describe(state, units)} /></button> : null}
            {close}
          </>}
        />
      </div>
      {detent === 'full' ? <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pt-1 pb-2">{body}</div> : null}
    </aside>
  );
}
