'use client';

/**
 * The map page's instrument chrome, after the macOS popover: one header row,
 * the top deck (transport left, day tiles with the timeline under them right)
 * and the lens row. The Fly panel is FlyPanel.tsx.
 */

import Link from 'next/link';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { FieldId } from '@/lib/field-color';
import { TRAFFIC_GLYPH_PATH } from '@/lib/traffic';
import { readingTitle, type ForecastIdentity } from '@/lib/point/provenance';
import { compass, rainLabel, type DaySummary, type NowReading, type SkyIcon } from '@/lib/points';
import { uvFigure, type UvCategory } from '@/lib/point/uv';
import { SPEEDS, isSpeed, speedLabel, type Speed } from '@/lib/playback';
import { clockParts, clockZone, zuluLabel } from '@/lib/time-label';
import { formatRainAmount, formatRainMm, formatTempC } from '@/lib/units';
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
}: {
  ms: number;
  zone: string;
  zulu?: boolean;
  weekday?: boolean;
  timeState?: { live: boolean; label: string } | null;
}) {
  const { mode } = useTimes();
  const shown = clockZone(mode, zone);
  const parts = clockParts(ms, shown);
  const zuluText = zulu && mode !== 'utc' ? zuluLabel(ms) : null;
  return (
    <span className="map-clock" data-clock={mode} data-clock-zone={shown}>
      {timeState ? <span data-map-time-state={timeState.live ? 'now' : 'forecast'} className="map-time-state">{timeState.label}</span> : null}
      <span data-clock-local>
        {weekday ? <span className="map-clock-weekday">{parts.weekday} </span> : null}
        {parts.time} {parts.abbrev}
      </span>
      {zuluText ? <span data-clock-zulu className="map-clock-zulu">{zuluText}</span> : null}
    </span>
  );
}

export function ChromeToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-chrome-toggle
      aria-expanded={!collapsed}
      aria-label={collapsed ? 'Show daily forecast' : 'Hide daily forecast'}
      onClick={onToggle}
      className="map-chrome-toggle"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d={collapsed ? 'M6 9.5 12 15.5l6-6' : 'M6 14.5 12 8.5l6 6'} />
      </svg>
    </button>
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
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" style={{ transform: `rotate(${from}deg)` }}>
      <path fill="currentColor" d="M12 21 7.5 9.5h3.2V3h2.6v6.5h3.2z" />
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
  validMs,
  zone,
  runMs,
  nowMs,
  phoneWind,
  phone,
  onMenuOpen,
  uv,
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
  /** Playhead instant. The face is this place's zone, plus Zulu. */
  validMs: number | null;
  zone: string;
  runMs: number;
  nowMs: number;
  phoneWind?: ReactNode;
  phone: boolean;
  onMenuOpen: () => void;
  /** Hourly UV beside the temperature, only while that hour rounds to 3 or more. */
  uv?: { index: number; category: UvCategory; protection: string | null } | null;
  graticule: boolean;
  onGraticule: () => void;
}) {
  const { units } = useUnits();
  const header = useRef<HTMLElement>(null);
  const [compactWind, setCompactWind] = useState(false);
  useLayoutEffect(() => {
    const node = header.current;
    if (!node) return;
    const measure = () => {
      const place = node.querySelector<HTMLElement>('[data-place-cluster]') ?? node.querySelector<HTMLElement>('[data-place-field]');
      const reading = node.querySelector<HTMLElement>('[data-reading]');
      const wind = node.querySelector<HTMLElement>('[data-wind-words]');
      if (!place || !reading || !wind) return;
      const learn = node.querySelector<HTMLElement>('.map-header-learn');
      const menu = node.querySelector<HTMLElement>('.map-menu-button');
      const clock = node.querySelector<HTMLElement>('.when-long');
      const learnWidth = learn && getComputedStyle(learn).display !== 'none' ? learn.offsetWidth : 0;
      const clockWidth = clock && getComputedStyle(clock).display !== 'none' ? clock.offsetWidth + 8 : 0;
      const available = node.clientWidth - 24 - (menu?.offsetWidth ?? 40) - learnWidth - clockWidth - 16;
      const temperature = reading.firstElementChild as HTMLElement | null;
      const uvNode = reading.querySelector<HTMLElement>('[data-uv]');
      const needed = place.offsetWidth + (temperature?.offsetWidth ?? 0) + (uvNode?.offsetWidth ?? 0) + 16 + wind.scrollWidth + 12;
      setCompactWind(needed > available);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [placeName, reading?.tempC, reading?.windKt, reading?.windFrom, units, uv?.index, validMs, zone]);
  const ageH = Math.max(0, Math.floor((nowMs - runMs) / 3_600_000));
  const runHour = new Date(runMs).getUTCHours();
  const stale = ageH > 18;
  const runText = `${String(runHour).padStart(2, '0')}Z`;
  const runDetail = `ECMWF forecast run, issued ${runText}, ${ageH} h ago`;
  const wind = reading?.windKt != null && reading.windFrom != null
    ? `${compass(reading.windFrom)} ${Math.round(reading.windKt)} kt`
    : null;
  const forecastTitle = forecast ? readingTitle(forecast, forecast.valid) : 'Model 2 m temperature';
  return (
    <header ref={header} data-compact-wind={compactWind} className="map-header relative z-20 flex h-12 shrink-0 items-center gap-2 px-3 md:gap-3 md:px-4">
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
        <span data-wind-words className="header-wind-words font-medium">{wind}</span>
        <span className="when-long max-md:hidden">
          {wind ? <span aria-hidden="true"> · </span> : null}
          {validMs != null ? <ClockFace ms={validMs} zone={zone} zulu /> : '—'}
        </span>
      </span> : null}
      <Link href="/train" data-learn-link className="map-header-learn ml-auto hidden h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-[15px] font-semibold text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] md:flex">
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 9.5 12 5l9.5 4.5L12 14z" /><path d="M6.5 11.5v4.2c1.4 1.4 3.3 2.1 5.5 2.1s4.1-.7 5.5-2.1v-4.2M21.5 9.5v5" /></svg>
        Learn
      </Link>
      <MapMenu graticule={graticule} onGraticule={onGraticule} wind={phoneWind} phone={phone} onOpen={onMenuOpen} run={runMs > 0 ? <span title={runDetail} aria-label={runDetail} className={`inline-flex items-center gap-1 ${stale ? 'text-[var(--md-warning)]' : ''}`}>{stale ? <span className="stale-run" aria-hidden="true" /> : null}run {runText} · {ageH} h old</span> : 'Run unavailable'} />
    </header>
  );
}

/* ---------- top deck ---------- */

export function Transport({
  held = false,
  playing,
  onToggle,
  speed,
  onSpeed,
  onNow,
  nowLabel = 'Now',
  compact = false,
}: {
  held?: boolean;
  playing: boolean;
  onToggle: () => void;
  speed: Speed;
  onSpeed: (speed: Speed) => void;
  onNow: () => void;
  nowLabel?: string;
  /** Collapsed row: play and speed. Now stays on the expanded deck. */
  compact?: boolean;
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
      {compact ? null : <button type="button" onClick={onNow} className="flex h-9 items-center gap-1 rounded-md px-2 text-[15px] font-semibold text-[var(--md-primary)] hover:bg-[var(--md-surface-container-high)]">
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path fill="currentColor" d="M5 5h2.2v14H5zM12 12l7.5-6v12zM7.5 12 12 8.4v7.2z" /></svg>
        {nowLabel}
      </button>}
    </div>
  );
}

function tempColour(c: number): string {
  // Cool slate-blue under 12°, warm terracotta over 26°, the popover's bar.
  const t = Math.min(1, Math.max(0, (c - 12) / 14));
  const a = [122, 163, 196];
  const b = [214, 134, 96];
  const mix = a.map((value, index) => Math.round(value + (b[index] - value) * t));
  return `rgb(${mix.join(',')})`;
}

export function DayTiles({
  days,
  todayKey,
  selectedKey,
  nowTemp,
  onDay,
}: {
  days: DaySummary[];
  todayKey: string;
  selectedKey: string | null;
  nowTemp: number | null;
  onDay: (day: DaySummary) => void;
}) {
  const { units } = useUnits();
  const dayList = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = dayList.current;
    const reading = node?.querySelector('.day-values > span');
    if (!node || !reading) return;
    const measure = () => { node.dataset.simple = String(parseFloat(getComputedStyle(reading).fontSize) > 20); };
    const observer = new ResizeObserver(measure);
    observer.observe(reading);
    measure();
    return () => observer.disconnect();
  }, [days.length]);
  const his = days.map((day) => day.hi).filter((value): value is number => value != null);
  const los = days.map((day) => day.lo).filter((value): value is number => value != null);
  const min = los.length ? Math.min(...los) : 0;
  const max = his.length ? Math.max(...his) : 1;
  const span = Math.max(1, max - min);
  return (
    <div ref={dayList} className="forecast-days grid min-w-0 gap-1" style={{ gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(max-content, 1fr))` }} role="list" aria-label="Forecast days">
      {days.map((day) => {
        const rain = units.rain === 'in' ? formatRainMm(day.rain, units) : rainLabel(day.rain);
        const rainUnit = units.rain === 'in' ? ' in' : ' mm';
        const rainTitle = day.rain == null ? '' : units.rain === 'in' ? ` · ${formatRainAmount(day.rain, units)} in` : ` · ${day.rain.toFixed(1)} mm`;
        const today = day.key === todayKey;
        const selected = day.key === selectedKey;
        const uv = uvFigure(day.uv ?? null);
        const windTitle = day.windKt != null ? ` · ${day.windFrom != null ? `${compass(day.windFrom)} ` : ''}${Math.round(day.windKt)} kt` : '';
        const uvTitle = uv ? ` · UV ${uv.index}` : '';
        return (
          <button
            key={day.key}
            type="button"
            role="listitem"
            aria-pressed={selected}
            title={`${day.key}${day.event?` · ${day.event.detail}`:''}${rainTitle}${windTitle}${uvTitle}${day.protection ? ` · ${day.protection}` : ''}`}
            onClick={() => onDay(day)}
            className={`flex min-w-0 flex-col items-center rounded-lg px-0.5 pt-1 pb-1.5 md:px-1 ${selected ? 'bg-[var(--md-primary-container)]/60' : 'hover:bg-[var(--md-surface-container-high)]'}`}
          >
            <span className="text-[13px] font-medium text-[var(--md-on-surface-variant)]">{today ? 'Today' : day.weekday}</span>
            {day.historical ? <span className="day-values max-w-full px-1 py-2 text-[13px] font-medium"><span className="block truncate">{day.event?.title ?? '—'}</span></span> : <>
            <span className="day-sky flex max-w-full items-center justify-center gap-0.5">
              <SkyGlyph icon={day.icon} className="sky-glyph h-5 w-5 shrink-0 text-[var(--md-on-surface)]" />
              {uv ? <UvFigure index={uv.index} category={uv.category} protection={day.protection ?? null} /> : null}
            </span>
            {/* Intrinsic widths let enlarged text scroll the day strip without overlapping readings. */}
            <span className="day-values text-[15px] font-medium tabular-nums">
              <span className="whitespace-nowrap">{day.hi == null ? '—' : formatTempC(day.hi, units)}</span>
              <span className="day-lo whitespace-nowrap">{day.lo == null ? '' : formatTempC(day.lo, units)}</span>
              <span className={`day-rain whitespace-nowrap font-semibold text-[var(--md-primary)] ${rain ? '' : 'day-rain-empty'}`}>{rain || '0'}<span className="day-rain-unit">{rainUnit}</span></span>
            </span>
            {day.windKt != null ? (
              <span className="max-w-full truncate text-[12px] leading-4 font-semibold tabular-nums">{day.windFrom != null ? `${compass(day.windFrom)} ` : ''}{Math.round(day.windKt)} kt</span>
            ) : null}
            <span className="day-range relative mt-1 h-1 w-full rounded-full bg-[var(--md-surface-container-highest)]" title="temperature range, low to high" aria-label="temperature range, low to high">
              {day.hi != null && day.lo != null ? (
                <span
                  className="absolute top-0 h-1 rounded-full"
                  style={{
                    left: `${((day.lo - min) / span) * 100}%`,
                    width: `${Math.max(4, ((day.hi - day.lo) / span) * 100)}%`,
                    background: `linear-gradient(90deg, ${tempColour(day.lo)}, ${tempColour(day.hi)})`,
                  }}
                />
              ) : null}
              {today && nowTemp != null ? (
                <span
                  className="absolute -top-0.5 h-2 w-2 -translate-x-1/2 rounded-full border border-[var(--md-surface)] bg-[var(--md-on-surface)]"
                  title="now"
                  aria-label="now"
                  style={{ left: `${Math.min(100, Math.max(0, ((nowTemp - min) / span) * 100))}%` }}
                />
              ) : null}
            </span>
            </>}
          </button>
        );
      })}
    </div>
  );
}

export function Timeline({
  startMs,
  endMs,
  dayMarks,
  forecastStartMs,
  forecastEndMs,
  validMs,
  zone,
  bare = false,
  valueText,
  timeState,
  span,
  minute,
  onPointer,
}: {
  startMs: number;
  endMs: number;
  dayMarks: number[];
  forecastStartMs: number;
  forecastEndMs: number;
  validMs: number;
  zone: string;
  /** Track only. The collapsed row puts the clock beside the slider. */
  bare?: boolean;
  valueText: string;
  timeState?: { live: boolean; label: string };
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
  const at = (ms: number) => Math.min(1, Math.max(0, (ms - startMs) / Math.max(1, endMs - startMs)));
  const head = at(validMs);
  const edge = head < 0.18 ? '0' : head > 0.82 ? '-100%' : '-50%';
  return (
    <div
      className="timeline relative h-9 touch-none select-none"
      tabIndex={0}
      role="slider"
      aria-label="Forecast time"
      aria-valuemin={0}
      aria-valuemax={Math.round(span)}
      aria-valuenow={Math.round(minute)}
      aria-valuetext={valueText}
      data-timeline
      data-bare={bare ? 'true' : 'false'}
      data-valid-ms={String(Math.round(validMs))}
      {...onPointer}
    >
      {bare ? null : (
        <div
          data-timeline-label
          className="absolute top-0 whitespace-nowrap text-[13px] font-semibold tabular-nums"
          style={{ left: `${head * 100}%`, transform: `translateX(${edge})` }}
        >
          <ClockFace ms={validMs} zone={zone} zulu timeState={timeState} />
        </div>
      )}
      <div data-timeline-track className="timeline-track absolute inset-0">
        <div className="absolute inset-x-0 top-[var(--track)] h-[3px] rounded-full bg-[var(--md-surface-container-highest)]" />
        <div className="absolute top-[var(--track)] h-[3px] bg-[var(--md-outline)]/60" style={{ left: `${at(forecastStartMs) * 100}%`, width: `${(at(forecastEndMs) - at(forecastStartMs)) * 100}%` }} />
        <div className="absolute top-[var(--track)] h-[3px] rounded-full bg-[var(--md-primary)]" style={{ left: `${at(forecastStartMs) * 100}%`, width: `${Math.max(0, head - at(forecastStartMs)) * 100}%` }} />
        {dayMarks.map((ms) => (
          <div key={ms} className="absolute top-[calc(var(--track)-7px)] h-[10px] w-px bg-[var(--md-on-surface)]" style={{ left: `${at(ms) * 100}%` }} />
        ))}
        <div className="absolute top-[calc(var(--track)-5px)] h-[13px] w-[13px] -translate-x-1/2 rounded-full bg-[var(--md-primary)] shadow" style={{ left: `${head * 100}%` }} />
      </div>
    </div>
  );
}

const loupeStroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** One desktop row; on phones the slider and clock reflow below transport. */
export function CompactForecast({
  placeName,
  onPlace,
  reading,
  transport,
  timeline,
  validMs,
  zone,
  timeState,
  toggle,
}: {
  placeName: string;
  onPlace: () => void;
  reading: NowReading | null;
  transport: ReactNode;
  timeline: ReactNode;
  validMs: number | null;
  zone: string;
  timeState?: { live: boolean; label: string } | null;
  toggle: ReactNode;
}) {
  const { units } = useUnits();
  const temp = reading?.tempC == null ? '—' : formatTempC(reading.tempC, units);
  return (
    <div className="map-compact" data-compact-bar>
      <button type="button" data-expand-place className="map-compact-place" onClick={onPlace}>
        <svg className="map-compact-loupe" viewBox="0 0 24 24" aria-hidden="true"><circle {...loupeStroke} cx="10" cy="10" r="6" /><path {...loupeStroke} d="m15 15 5 5" /></svg>
        <span>{placeName || 'Place'}</span>
      </button>
      <span className="map-compact-temp tabular-nums" data-compact-temp>{temp}</span>
      {transport}
      <div className="min-w-0 flex-1">{timeline}</div>
      {validMs != null ? <ClockFace ms={validMs} zone={zone} zulu timeState={timeState} /> : null}
      {toggle}
    </div>
  );
}

/* ---------- lens row ---------- */

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
 * The Mac app's single lens row: one lens at a time. A segmented control with
 * labelled segments at every width; phones scroll the selected lens into view.
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
    {phone ? null : <div className="map-lens-extras" style={{ position: 'relative' }}>
      {pressed ? <span key={pressed.key} role="status" data-press-label className="map-press-label">{pressed.text}</span> : null}
      {windAvailable && ['wind', 'kite', 'surf', 'fly'].includes(lens) ? (
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
        <SatelliteIcon className="h-5 w-5" />
      </button> : null}
      {lens === 'fly' ? <button
        type="button"
        aria-pressed={traffic}
        aria-label="Traffic"
        onClick={() => { flash(traffic ? 'Traffic off' : 'Traffic on'); onTraffic(!traffic); }}
        className={`grid h-9 w-9 shrink-0 place-items-center rounded-md ${traffic ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'}`}
      >
        <TrafficIcon className="h-5 w-5" />
      </button> : null}
      {lens === 'fly' && sectionAvailable ? <button type="button" aria-label="Section" aria-pressed={section} onClick={() => { flash(section ? 'Section off' : 'Section on · side view along the line'); onSection?.(); }} className={`grid h-9 w-9 shrink-0 place-items-center rounded-md text-[16px] ${section ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : 'text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]'}`}>↟</button> : null}
    </div>}
    </>
  );
}
