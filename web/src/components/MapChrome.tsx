'use client';

import { forecastFreshness } from '@/lib/forecast-freshness';

/**
 * Floating place/actions, lens column and a single day scrubber/transport bar.
 * The Fly panel is FlyPanel.tsx.
 */

import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FieldId } from '@/lib/field-color';
import { TRAFFIC_GLYPH_PATH } from '@/lib/traffic';
import { readingTitle, type ForecastIdentity } from '@/lib/point/provenance';
import { compass, type DaySummary, type NowReading, type SkyIcon } from '@/lib/points';
import { type UvCategory } from '@/lib/point/uv';
import { SPEEDS, isSpeed, speedLabel, type Speed } from '@/lib/playback';
import { clockParts, clockZone, zuluLabel } from '@/lib/time-label';
import { formatTempC } from '@/lib/units';
import { dayRainLabel } from '@/lib/day-label';
import { MapMenu } from './MapMenu';
import { useTimes } from './TimesControl';
import { useUnits } from './UnitsControl';

/* ---------- icons ---------- */

type IconProps = { className?: string };
const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function Cloud({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M7 17h10a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.2A3 3 0 0 0 7 17z" /></svg>;
}
function CloudRain({ className, heavy }: IconProps & { heavy?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path {...stroke} d="M7 14h10a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.6 1.2A3 3 0 0 0 7 14z" />
      <path {...stroke} d={heavy ? 'M8.5 16.5l-1 3M11.5 16.5l-1 3M14.5 16.5l-1 3M17 16.5l-1 3' : 'M9.5 16.5l-.7 2M13 16.5l-.7 2M16 16.5l-.7 2'} />
    </svg>
  );
}
function Sun({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><circle {...stroke} cx="12" cy="12" r="3.5" /><path {...stroke} d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" /></svg>;
}
function Partly({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M9.5 6.5a3.5 3.5 0 0 1 5.4 2.2M9 3.5v1.2M4.8 5.3l.9.9M3.5 9.5h1.2" /><path {...stroke} d="M8 18.5h9a3 3 0 0 0 .3-6 4.3 4.3 0 0 0-8.3 1A2.5 2.5 0 0 0 8 18.5z" /></svg>;
}
export function SkyGlyph({ icon, className }: { icon: SkyIcon | null; className?: string }) {
  if (icon === 'rain') return <CloudRain className={className} heavy />;
  if (icon === 'drizzle') return <CloudRain className={className} />;
  if (icon === 'sun') return <Sun className={className} />;
  if (icon === 'partly') return <Partly className={className} />;
  if (icon === 'cloud') return <Cloud className={className} />;
  return <span className={className} />;
}
function Thermo({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M10 14.5V5a2 2 0 0 1 4 0v9.5a3.5 3.5 0 1 1-4 0z" /><path {...stroke} d="M12 9v7" /></svg>;
}
function SurfIcon({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M3 8c2-1.5 3.5-1.5 5 0s3.5 1.5 5 0 3.5-1.5 5 0M3 12.5c2-1.5 3.5-1.5 5 0s3.5 1.5 5 0 3.5-1.5 5 0M3 17c2-1.5 3.5-1.5 5 0s3.5 1.5 5 0 3.5-1.5 5 0" /></svg>;
}
function Plane({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path fill="currentColor" d="M21 12.8v-1.6l-8-4.7V3.2a1.2 1.2 0 0 0-2.4 0v3.3l-7.6 4.7v1.6l7.6-2.3v4.9L8.5 16.9v1.4l3.3-1 3.3 1v-1.4l-2.1-1.5v-4.9z" transform="rotate(90 12 12)" /></svg>;
}
function UpDown({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} strokeWidth={1.8} d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4" /></svg>;
}

/** A name that appears beside a control for a moment after it is pressed. */
export function usePressNote() {
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return {
    note,
    show(text: string) {
      setNote(text);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setNote(null), 1400);
    },
  };
}

export function PressNote({ text }: { text: string | null }) {
  if (!text) return null;
  return <span className="press-note" role="status" aria-label={text}>{text}</span>;
}

/** Place-local time, the zone name, and a small Zulu time. UTC-only drops the second copy. */
export function ClockFace({
  ms,
  zone,
  zulu = false,
  weekday = true,
  timeState,
  interactive = false,
  compact = false,
  placeLocal = false,
}: {
  ms: number;
  zone: string;
  zulu?: boolean;
  weekday?: boolean;
  timeState?: { live: boolean; label: string } | null;
  interactive?: boolean;
  compact?: boolean;
  placeLocal?: boolean;
}) {
  const { mode, setMode } = useTimes();
  const note = usePressNote();
  const shown = placeLocal ? zone : clockZone(mode, zone);
  const parts = clockParts(ms, shown);
  const zuluText = zulu && (placeLocal || mode !== 'utc') ? zuluLabel(ms) : null;
  const cycle = () => {
    const next = mode === 'place' ? 'utc' : mode === 'utc' ? 'device' : 'place';
    setMode(next);
    note.show(next === 'place' ? 'Place local' : next === 'utc' ? 'UTC only' : 'My local');
  };
  return (
    <span
      className={`map-clock${interactive ? ' map-clock-interactive' : ''}`}
      data-clock={mode}
      data-clock-zone={shown}
      onClick={interactive ? cycle : undefined}
    >
      {compact ? <span className="map-clock-compact">{parts.time}</span> : <>
      {timeState ? <span data-map-time-state={timeState.live ? 'now' : 'forecast'} className="map-time-state">{timeState.label}</span> : null}
      <span data-clock-local>
        {weekday ? <span className="map-clock-weekday">{parts.weekday} </span> : null}
        {parts.time} {parts.abbrev}
      </span>
      {zuluText ? <span data-clock-zulu className="map-clock-zulu">{zuluText}</span> : null}
      </>}
      {interactive ? <PressNote text={note.note} /> : null}
    </span>
  );
}

/** Wind arrow, pointing downwind. */
export function UvFigure({
  index,
  category,
  protection,
}: {
  index: number;
  category: UvCategory;
  protection: string | null;
}) {
  const line = protection ?? undefined;
  return (
    <span data-uv={category} className="uv-figure" title={line} aria-label={line ? `UV ${index}, ${line}` : `UV ${index}`}>
      UV {index}
    </span>
  );
}

export function WindArrow({ from, className }: { from: number | null; className?: string }) {
  if (from == null) return null;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path transform={`rotate(${from} 12 12)`} fill="currentColor" d="M12 21 7.5 9.5h3.2V3h2.6v6.5h3.2z" />
    </svg>
  );
}

/* ---------- header ---------- */

export function MapHeader({
  leading,
  historical = false,
  place,
  placeName,
  reading,
  forecast,
  runMs,
  nowMs,
  zone,
  phoneWind,
  uv,
  phone,
  onMenuOpen,
  onMenuChange,
  graticule,
  onGraticule,
}: {
  leading?: ReactNode;
  historical?: boolean;
  /** The place search. One control, in this row. */
  place: ReactNode;
  placeName: string;
  reading: NowReading | null;
  /** Open-Meteo identity when the reading is not the collector point. */
  forecast?: (ForecastIdentity & { valid: string | null }) | null;
  runMs: number;
  nowMs: number;
  zone: string;
  phoneWind?: ReactNode;
  phone: boolean;
  onMenuOpen: () => void;
  onMenuChange?: (open: boolean) => void;
  /** Hourly UV beside the temperature, only while that hour rounds to 3 or more. */
  uv?: { index: number; category: UvCategory; protection: string | null } | null;
  graticule: boolean;
  onGraticule: () => void;
}) {
  const { units } = useUnits();
  const ageH = Math.max(0, Math.floor((nowMs - runMs) / 3_600_000));
  const runHour = new Date(runMs).getUTCHours();
  const freshness = historical ? null : forecastFreshness(runMs, nowMs, zone);
  const stale = freshness !== null;
  const runText = `${String(runHour).padStart(2, '0')}Z`;
  const runDetail = `ECMWF forecast run, issued ${runText}, ${ageH} h ago`;
  const wind = reading?.windKt != null && reading.windFrom != null
    ? `${compass(reading.windFrom)} ${Math.round(reading.windKt)} kt`
    : null;
  const forecastTitle = forecast ? readingTitle(forecast, forecast.valid) : 'Model 2 m temperature';
  return (
    <header className="map-header relative z-20 flex h-12 shrink-0 items-center gap-2 px-3 md:gap-3 md:px-4">
      <div className="map-header-place">
      {leading}
      {place}
      {!historical ? <span
        className="map-reading flex min-w-0 items-center gap-1.5 whitespace-nowrap text-[15px] font-semibold tabular-nums"
        data-reading
        data-forecast-source={forecast?.source}
        data-forecast-run={forecast?.run}
        data-forecast-valid={forecast?.valid ?? undefined}
      >
        <span title={wind ? `${forecastTitle} · ${wind}` : forecastTitle}>{reading?.tempC == null ? '—' : formatTempC(reading.tempC, units)}</span>
        {uv ? <UvFigure index={uv.index} category={uv.category} protection={uv.protection} /> : null}
        <WindArrow from={reading?.windFrom ?? null} className="header-wind h-4 w-4" />
        <span data-wind-words className="header-wind-words font-medium">{phone && reading?.windKt != null ? `${Math.round(reading.windKt)} kt` : wind}</span>
      </span> : null}
      {runMs > 0 && stale ? <span
        data-run-chip
        data-run-stale={stale ? 'true' : 'false'}
        title={runDetail}
        aria-label={runDetail}
        className={`run-chip inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-medium tabular-nums ${stale ? 'text-[var(--md-warning)]' : 'text-[var(--md-on-surface-variant)]'}`}
      ><span className="run-chip-value">{freshness}</span></span> : null}
      </div>
      <div className="map-header-actions">
      <Link href="/train" data-learn-link className="map-header-learn ml-auto hidden h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-[15px] font-semibold text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] md:flex">
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 9.5 12 5l9.5 4.5L12 14z" /><path d="M6.5 11.5v4.2c1.4 1.4 3.3 2.1 5.5 2.1s4.1-.7 5.5-2.1v-4.2M21.5 9.5v5" /></svg>
        Learn
      </Link>
      <MapMenu graticule={graticule} onGraticule={onGraticule} wind={phoneWind} phone={phone} onOpen={onMenuOpen} onOpenChange={onMenuChange} run={<span title={runMs > 0 ? runDetail : undefined} aria-label={runMs > 0 ? runDetail : undefined}>Forecast details</span>} />
      </div>
    </header>
  );
}

/* ---------- bottom transport ---------- */

export function Transport({
  held = false,
  playing,
  onToggle,
  speed,
  onSpeed,
  onNow,
  nowLabel = 'Now',
}: {
  held?: boolean;
  playing: boolean;
  onToggle: () => void;
  speed: Speed;
  onSpeed: (speed: Speed) => void;
  onNow: () => void;
  nowLabel?: string;
}) {
  const playback = usePressNote();
  const speedNote = usePressNote();
  return (
    <div className="map-transport flex items-center gap-2">
      <span className="relative inline-grid">
      <button
        type="button"
        disabled={held}
        title={held ? 'Time held while the chart explains this feature' : undefined}
        data-playback-toggle
        aria-label={held ? 'Time held' : playing ? 'Pause' : 'Play'}
        aria-pressed={playing}
        onClick={() => { playback.show(playing ? 'Paused' : 'Playing'); onToggle(); }}
        className="grid h-9 w-9 place-items-center rounded-md text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]"
      >
        {playing
          ? <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true"><path fill="currentColor" d="M7 5h3.2v14H7zM13.8 5H17v14h-3.2z" /></svg>
          : <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true"><path fill="currentColor" d="M7 4.5v15l12.5-7.5z" /></svg>}
      </button>
      <PressNote text={playback.note} />
      </span>
      <label className="relative flex items-center">
        <span className="sr-only">Speed</span>
        <select
          id="playback-speed"
          style={{ width: undefined, ['--speed-label-ch' as string]: speedLabel(speed).length }}
          title="Real time, or forecast minutes per second"
          value={speed}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (!isSpeed(value)) return;
            speedNote.show(`Speed ${speedLabel(value)}`);
            onSpeed(value);
          }}
          className="h-9 appearance-none rounded-md bg-[var(--md-surface-container-high)] pr-7 pl-3 text-[15px] font-medium tabular-nums"
        >
          {SPEEDS.map((item) => <option key={item} value={item}>{speedLabel(item)}</option>)}
        </select>
        <UpDown className="pointer-events-none absolute right-1.5 h-4 w-4" />
        <PressNote text={speedNote.note} />
      </label>
      {<button type="button" onClick={onNow} data-time-reset className="flex h-9 items-center gap-1 rounded-md px-2 text-[15px] font-semibold text-[var(--md-primary)] hover:bg-[var(--md-surface-container-high)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path fill="currentColor" d="M5 5h2.2v14H5zM12 12l7.5-6v12zM7.5 12 12 8.4v7.2z" /></svg>
        {nowLabel}
      </button>}
    </div>
  );
}

export function Timeline({
  startMs,
  endMs,
  days,
  todayKey,
  forecastStartMs,
  forecastEndMs,
  validMs,
  zone,
  valueText,
  timeState,
  aviation = false,
  span,
  minute,
  onPointer,
}: {
  startMs: number;
  endMs: number;
  days: DaySummary[];
  todayKey: string;
  forecastStartMs: number;
  forecastEndMs: number;
  validMs: number;
  zone: string;
  valueText: string;
  timeState?: { live: boolean; label: string };
  aviation?: boolean;
  span: number;
  minute: number;
  onPointer: {
    onKeyDown: React.KeyboardEventHandler<HTMLDivElement>;
    onPointerDown: React.PointerEventHandler<HTMLDivElement>;
    onPointerMove: React.PointerEventHandler<HTMLDivElement>;
    onPointerUp: React.PointerEventHandler<HTMLDivElement>;
    onPointerCancel: React.PointerEventHandler<HTMLDivElement>;
    onPointerLeave: React.PointerEventHandler<HTMLDivElement>;
  };
}) {
  const { units } = useUnits();
  const at = (ms: number) => Math.min(1, Math.max(0, (ms - startMs) / Math.max(1, endMs - startMs)));
  const head = at(validMs);
  const track = useRef<HTMLDivElement>(null);
  const clock = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(false);
  const [clockPosition, setClockPosition] = useState<{left: number; top: number}>();
  useLayoutEffect(() => {
    const node = track.current;
    if (!node) return;
    const measure = () => {
      const segments = [...node.querySelectorAll<HTMLElement>('.forecast-day')];
      // Keep even a partial day's three-letter name inside its proportional
      // segment. Exceptionally short endpoints can scroll with the same track.
      const minimum = Math.max(0, ...segments.map(day => {
        const name = day.querySelector<HTMLElement>('[data-day-option="3"]')!;
        const style = getComputedStyle(day);
        const inset = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) + 2;
        return (name.getBoundingClientRect().width + inset) / (parseFloat(day.style.width) / 100);
      }));
      node.style.minWidth = `max(var(--day-track-min, 0px), ${Math.ceil(minimum)}px)`;
      for (const day of segments) {
        const style = getComputedStyle(day);
        const available = day.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const options = [...day.querySelectorAll<HTMLElement>('[data-day-option]')];
        const selected = options.findIndex(option => option.getBoundingClientRect().width <= available);
        day.dataset.detail = String(selected < 0 ? 3 : selected);
      }
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    for (const label of node.querySelectorAll('[data-day-option]')) observer.observe(label);
    measure();
    return () => observer.disconnect();
  }, [days, units, startMs, endMs]);
  useLayoutEffect(() => {
    if (!active || !track.current || !clock.current) return;
    const rect = track.current.getBoundingClientRect();
    const width = clock.current.getBoundingClientRect().width;
    setClockPosition({left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width * head - width / 2)), top: rect.top - clock.current.offsetHeight - 10});
  }, [active, head, valueText]);
  return (
    <>
    <div className="forecast-days">
    <div
      ref={track}
      className="timeline relative h-9 select-none"
      tabIndex={0}
      role="slider"
      aria-label="Forecast time"
      aria-valuemin={0}
      aria-valuemax={Math.round(span)}
      aria-valuenow={Math.round(minute)}
      aria-valuetext={valueText}
      data-timeline
      data-valid-ms={String(Math.round(validMs))}
      {...onPointer}
      onPointerEnter={event => { if (event.pointerType === 'mouse') setActive(true); }}
      onPointerDown={event => { setActive(true); onPointer.onPointerDown(event); }}
      onPointerUp={event => { if(event.pointerType !== 'mouse') setActive(false); onPointer.onPointerUp(event); }}
      onPointerCancel={event => { setActive(false); onPointer.onPointerCancel(event); }}
      onPointerLeave={event => { setActive(false); onPointer.onPointerLeave(event); }}
    >
      <div className="forecast-segments" role="list" aria-label="Forecast days">
        {days.filter(day => day.dayEnd > startMs && day.dayStart < endMs).map(day => {
          const rain = dayRainLabel(day.rain);
          const weekday = day.historical ? new Date(`${day.key}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }) : day.weekday;
          const detail = [day.key, day.event?.detail,
            !day.historical ? `High ${formatTempC(day.hi, units) ?? 'unavailable'}, low ${formatTempC(day.lo, units) ?? 'unavailable'}` : null,
            !day.historical ? (rain === null ? 'Rain unavailable' : rain ? `${rain} mm rain` : null) : null,
            day.windKt != null ? `${day.windFrom != null ? compass(day.windFrom) + ' ' : ''}${Math.round(day.windKt)} kt` : null,
            day.uv != null ? `UV ${day.uv}` : null, day.protection].filter(Boolean).join(' · ');
          return <span key={day.key} role="listitem" className="forecast-day" data-detail="3" data-today={day.key === todayKey} title={detail} aria-label={detail} style={{ width: `${100 * (at(day.dayEnd) - at(day.dayStart))}%` }}>
            {[0, 1, 2, 3].map(level => <span key={level} className="day-label-option" data-day-option={level} aria-hidden="true">
              <span className="day-name">{weekday}</span>
              {!day.historical && level < 3 ? <>
                {level < 2 ? <SkyGlyph icon={day.icon} className="sky-glyph" /> : null}
                <span className="day-values">{day.hi == null ? '—' : formatTempC(day.hi, units)}/{day.lo == null ? '—' : formatTempC(day.lo, units)}</span>
                {level === 0 && rain ? <span className="day-rain">{rain}</span> : null}
              </> : null}
            </span>)}
          </span>;
        })}
      </div>
      <div className="timeline-scrub-hit" aria-hidden="true" />
      <div data-timeline-track className="timeline-track absolute inset-0">
        <div className="absolute inset-x-0 top-[var(--track)] h-[3px] rounded-full bg-[var(--md-surface-container-highest)]" />
        <div className="absolute top-[var(--track)] h-[3px] bg-[var(--md-outline)]/60" style={{ left: `${at(forecastStartMs) * 100}%`, width: `${(at(forecastEndMs) - at(forecastStartMs)) * 100}%` }} />
        <div className="absolute top-[var(--track)] h-[3px] rounded-full bg-[var(--md-primary)]" style={{ left: `${at(forecastStartMs) * 100}%`, width: `${Math.max(0, head - at(forecastStartMs)) * 100}%` }} />
        <div className="absolute top-[calc(var(--track)-5px)] h-[13px] w-[13px] -translate-x-1/2 rounded-full bg-[var(--md-primary)] shadow" style={{ left: `${head * 100}%` }} />
      </div>
    </div>
    </div>
    <div className="map-clock-slot" style={{visibility: active ? 'hidden' : undefined}}>
      <div className="map-selected-time" data-timeline-label data-active="false" title={valueText} aria-label={valueText}>
        <ClockFace ms={validMs} zone={zone} placeLocal zulu={aviation} compact />
      </div>
    </div>
    {active ? createPortal(<div ref={clock} className="map-selected-time map-clock-floating" data-timeline-label data-active="true" style={clockPosition} aria-label={valueText}>
      <ClockFace ms={validMs} zone={zone} placeLocal zulu={aviation} timeState={timeState} />
    </div>, document.body) : null}
    </>
  );
}

/* ---------- lens column ---------- */

export type Lens = 'pressure' | 'rain' | 'wind' | 'temp' | 'kite' | 'surf' | 'fly';

function PressureIcon({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M12 5.5c4.4 0 7.5 2.9 7.5 6.5s-3.1 6.5-7.5 6.5S4.5 15.6 4.5 12 7.6 5.5 12 5.5z" /><path {...stroke} d="M12 9.2c2 0 3.4 1.2 3.4 2.8s-1.4 2.8-3.4 2.8-3.4-1.2-3.4-2.8 1.4-2.8 3.4-2.8z" /></svg>;
}
function WindIcon({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M3 9h11a2.5 2.5 0 1 0-2.5-2.5M3 13h15a2.5 2.5 0 1 1-2.5 2.5M3 17h7" /></svg>;
}
function KiteIcon({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M14 3l5 5-7 7-5-5zM12 15c-1 2-3 2.5-4 4.5M9.5 17.5l-1.3-.6M8.6 19.6l-1.4-.2" /></svg>;
}
function BarbIcon({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M5 19 16 6M16 6l3.5 3M13.5 9l3.5 3" /><circle cx="5" cy="19" r="1.3" fill="currentColor" /></svg>;
}
export function SatelliteIcon({ className }: IconProps) {
  return <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path {...stroke} d="M4 15.5a8 8 0 0 1 16 0" /><path {...stroke} d="M12 15.5V19M10 19h4" /><circle cx="12" cy="10.5" r="1.2" fill="currentColor" /></svg>;
}
export function TrafficIcon({ className }: IconProps) {
  return <svg viewBox="-12 -12 24 24" className={className} aria-hidden="true"><path fill="currentColor" d={TRAFFIC_GLYPH_PATH} /></svg>;
}

/**
 * One lens at a time. A floating labelled column, with named icons on phones.
 */
export function LensBar({
  lens,
  onLens,
  windBarbs,
  windAvailable,
  onWindBarbs,
  satellite,
  onSatellite,
  traffic,
  onTraffic,
  flyEnabled = true,
  availableLenses,
  satelliteAvailable = true,
  section = false,
  onSection,
  sectionAvailable = false,
  compact = false,
  phone = false,
}: {
  lens: Lens;
  onLens: (lens: Lens) => void;
  windBarbs: boolean;
  windAvailable: boolean;
  onWindBarbs: (value: boolean) => void;
  satellite: boolean;
  onSatellite: (value: boolean) => void;
  traffic: boolean;
  onTraffic: (value: boolean) => void;
  /** False when no aerodrome report is within 50 km. */
  flyEnabled?: boolean;
  availableLenses?: readonly Lens[];
  satelliteAvailable?: boolean;
  section?: boolean;
  onSection?: () => void;
  sectionAvailable?: boolean;
  /** Enlarged text uses an icon-backed native picker to keep every lens reachable. */
  compact?: boolean;
  /** Phones carry Satellite/Traffic in the compact map-tools cluster instead; render one control per viewport. */
  phone?: boolean;
}) {
  const nav = useRef<HTMLElement>(null);
  // A press names what it did beside the control, then fades (owner rule: no tooltips needed).
  const [pressed, setPressed] = useState<{ text: string; key: number } | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = (text: string) => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    setPressed({ text, key: Date.now() });
    pressTimer.current = setTimeout(() => setPressed(null), 1800);
  };
  useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);
  useEffect(() => {
    const strip = nav.current;
    if (!strip) return;
    const reveal = () => {
      const selected = strip.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!selected) return;
      // Scroll this strip only, never the document or map, including after rotation.
      const left = selected.offsetLeft, right = left + selected.offsetWidth;
      if (left < strip.scrollLeft) strip.scrollLeft = left;
      else if (right > strip.scrollLeft + strip.clientWidth - 18) strip.scrollLeft = right - strip.clientWidth + 18;
    };
    reveal();
    const observer = new ResizeObserver(reveal); observer.observe(strip);
    const group = strip.querySelector('[role="radiogroup"]');
    if (group) observer.observe(group);
    return () => observer.disconnect();
  }, [lens]);
  const items: { id: Lens; label: string; title: string; icon: ReactNode; enabled: boolean }[] = [
    { id: 'pressure', label: 'Pressure', title: 'Pressure: isobars only', icon: <PressureIcon className="h-5 w-5" />, enabled: true },
    { id: 'rain', label: 'Rain', title: 'Rain: 24 h total', icon: <CloudRain className="h-5 w-5" />, enabled: true },
    { id: 'wind', label: 'Wind', title: 'Wind: 10 m speed', icon: <WindIcon className="h-5 w-5" />, enabled: true },
    { id: 'temp', label: 'Temp', title: 'Temp: 2 m temperature', icon: <Thermo className="h-5 w-5" />, enabled: true },
    { id: 'kite', label: 'Kite', title: 'Kite: daylight wind and shore direction', icon: <KiteIcon className="h-5 w-5" />, enabled: true },
    { id: 'surf', label: 'Surf', title: 'Surf: swell and coastal wind', icon: <SurfIcon className="h-5 w-5" />, enabled: true },
    { id: 'fly', label: 'Fly', title: flyEnabled ? 'Fly: METAR and TAF' : 'None', icon: <Plane className="h-5 w-5" />, enabled: flyEnabled },
  ];
  return (
    <>
    {compact ? <label className="map-lens-picker">
      <span className="sr-only">Weather lens</span>
      <span className="map-lens-picker-icon" aria-hidden="true">{items.find(item => item.id === lens)?.icon}</span>
      <select aria-label="Weather lens" title={items.find(item => item.id === lens)?.label} value={lens} onChange={(event) => { onLens(event.target.value as Lens); flash(items.find(item => item.id === event.target.value)?.label ?? 'Lens'); }}>
        {items.filter(item => !availableLenses || availableLenses.includes(item.id)).map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.label}</option>)}
      </select>
    </label> : null}
    <nav ref={nav} aria-label="Map lens" className="flex h-12 min-w-0 flex-1 items-center gap-2" data-lens-bar>
      <div role="radiogroup" aria-label="Lens" className="flex min-w-0 flex-1 items-center rounded-lg bg-[var(--md-surface-container)] p-0.5 md:flex-none">
        {items.filter(item => !availableLenses || availableLenses.includes(item.id)).map((item) => {
          const selected = lens === item.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={item.label}
              title={item.title}
              disabled={!item.enabled}
              data-lens={item.id}
              onClick={() => onLens(item.id)}
              className={`flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-1 text-[14px] font-medium whitespace-nowrap sm:px-2 md:flex-none md:px-3 ${selected ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] ring-1 ring-inset ring-[var(--md-primary)]/30' : item.enabled ? 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-highest)]' : 'text-[var(--md-on-surface-variant)]'}`}
            >
              <span className="lens-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
    {<div className="map-lens-extras" style={{ position: 'relative' }}>
      {pressed ? <span key={pressed.key} role="status" data-press-label className="map-press-label">{pressed.text}</span> : null}
      {!phone && windAvailable && ['wind', 'kite', 'surf', 'fly'].includes(lens) ? (
        <button
          type="button"
          aria-pressed={windBarbs}
          aria-label="Wind barbs"
          onClick={() => { flash(windBarbs ? 'Wind barbs off' : 'Wind barbs on · 10 m wind, barb = 10 kt'); onWindBarbs(!windBarbs); }}
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${windBarbs ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'}`}
        >
          <BarbIcon className="h-5 w-5" />
        </button>
      ) : null}
      {satelliteAvailable && (['pressure', 'rain', 'temp'].includes(lens)) ? <button
        type="button"
        aria-pressed={satellite}
        aria-label="Satellite"
        onClick={() => { flash(satellite ? 'Satellite off' : 'Satellite on'); onSatellite(!satellite); }}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${satellite ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'}`}
      >
        <SatelliteIcon className="h-5 w-5" /><span>Sat</span>
      </button> : null}
      {!phone && lens === 'fly' ? <button
        type="button"
        aria-pressed={traffic}
        aria-label="Traffic"
        onClick={() => { flash(traffic ? 'Traffic off' : 'Traffic on'); onTraffic(!traffic); }}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${traffic ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'}`}
      >
        <TrafficIcon className="h-5 w-5" />
      </button> : null}
      {!phone && lens === 'fly' && sectionAvailable ? <button type="button" aria-label="Section" aria-pressed={section} onClick={() => { flash(section ? 'Section off' : 'Section on · side view along the line'); onSection?.(); }} className={`grid h-9 w-9 shrink-0 place-items-center rounded-md text-[16px] ${section ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'}`}>↟</button> : null}
    </div>}
    </>
  );
}
