'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Coast } from '@/lib/coast';
import { nearestCoast, shoreDirection, kiteBandState, shownKnots, validKiteBand, type KiteBand } from '@/lib/coastal';
import { loadCoastalWind, loadCoastalMarine, type CoastalForecast, type CoastalHour } from '@/lib/coastal-forecast';
import { COASTAL_PEEK_ROWS, bestCoastalWindow, bestLabel, coastalClock, coastalRows, coastalSheetHeight, coastalWhen } from '@/lib/coastal-outlook';
import type { MapPoint } from '@/lib/point/section';
import { useMapSheet } from './MapSheet';
import { PressNote, usePressNote, WindArrow } from './MapChrome';
import { StarIcon } from './PlaceField';
import shared from './PointPanel.module.css';
import styles from './CoastalPanel.module.css';

const number = (value: number | null, digits = 0) => value == null ? '—' : digits === 0 ? String(shownKnots(value)) : value.toFixed(digits);
function Swell({ height, period, from, secondary = false }: { height: number | null; period: number | null; from: number | null; secondary?: boolean }) {
  return <span className={styles.swell} role="cell" title={`${secondary ? 'Secondary' : 'Primary'} swell: ${number(height, 1)} m · ${number(period)} s · from ${number(from)}°`}>
    <span>{number(height, 1)}/{number(period)}s</span><WindArrow from={from} className={styles.arrow} />
  </span>;
}
function Shore({ from, normal, kite }: { from: number | null; normal: number | null; kite: boolean }) {
  const dir = shoreDirection(from, normal);
  const off = dir === 'offshore' || dir === 'cross-off';
  const label = kite ? dir : dir === 'cross-on' || dir === 'cross-off' || dir === 'cross' ? 'cross' : dir === 'offshore' ? 'off' : dir === 'onshore' ? 'on' : null;
  return <span data-shore={dir ?? 'missing'} data-hazard={kite && off ? 'true' : undefined}
    className={kite && off ? styles.hazard : !kite && off ? styles.clean : undefined}
    title={off ? kite ? `${dir}: wind carries kites out to sea` : `${dir}: clean offshore wind` : dir ?? 'Shore direction unavailable'}>
    {kite && off ? '⚠ ' : !kite && off ? '✓ ' : ''}{label ?? '—'}
  </span>;
}

export function CoastalPanel({ lens, point, name, detail, isPlace, onMakePlace, coast, nowMs, zone: placeZone, clockZone = null, band, onBand, onClose, anchorRef, panelRef }: {
  lens: 'kite' | 'surf'; point: MapPoint; name: string; detail: string; isPlace: boolean; onMakePlace: () => 'set' | 'restored' | 'same'; coast: Coast; nowMs: number; zone: string;
  /** UTC or device zone; null uses place local. */
  clockZone?: string | null;
  band: KiteBand; onBand: (band: KiteBand) => void; onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>; panelRef: RefObject<HTMLElement | null>;
}) {
  const { desktop, anchor } = useMapSheet(anchorRef);
  const placeNote = usePressNote();
  const spot = useMemo(() => nearestCoast(coast, point), [coast, point.lat, point.lon]);
  const lat = lens === 'surf' && spot ? spot.lat : point.lat;
  const lon = lens === 'surf' && spot ? spot.lon : point.lon;
  const key = `${lat},${lon}:${spot?.lat},${spot?.lon}:${Math.floor(nowMs / 86_400_000)}`;
  const currentTime = useRef(nowMs); currentTime.current = nowMs;
  const [result, setResult] = useState<{ key: string; wind: CoastalForecast | null; marine: CoastalForecast | null; windDone: boolean; marineDone: boolean }>({ key: '', wind: null, marine: null, windDone: false, marineDone: false });
  const [retry, setRetry] = useState(0);
  const [sources, setSources] = useState(false);
  const [draft, setDraft] = useState({ min: String(band.min), max: String(band.max) });
  const closeRef = useRef<HTMLButtonElement>(null);
  const closeAction = useRef(onClose); closeAction.current = onClose;
  const drag = useRef<{ y: number; moved: boolean } | null>(null);
  const [detent, setDetent] = useState<'peek' | 'full'>('peek');
  const [peekPx, setPeekPx] = useState(174);
  useEffect(() => { setDraft({ min: String(band.min), max: String(band.max) }); }, [band.min, band.max]);
  useEffect(() => {
    if (!spot) return;
    const controller = new AbortController();
    const options = { nowMs: currentTime.current, signal: controller.signal };
    setResult({ key, wind: null, marine: null, windDone: false, marineDone: false });
    const apply = (kind: 'wind' | 'marine', value: CoastalForecast | null) => {
      if (!controller.signal.aborted) setResult((old) => old.key !== key ? old : { ...old, [kind]: value, [`${kind}Done`]: true });
    };
    void loadCoastalWind(lat, lon, options).then((v) => apply('wind', v), () => apply('wind', null));
    // Two bounded public forecasts prepare switching between Kite and Surf.
    void loadCoastalMarine(spot.lat, spot.lon, options).then((v) => apply('marine', v), () => apply('marine', null));
    return () => controller.abort();
  }, [key, lat, lon, spot, retry]);
  useEffect(() => { setDetent('peek'); }, [lens]);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) closeAction.current(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);
  const active = result.key === key ? result : null;
  const zone = clockZone || active?.wind?.zone || active?.marine?.zone || placeZone;
  const rows = useMemo(() => coastalRows(active?.wind ?? null, active?.marine ?? null, nowMs), [active, nowMs]);
  const shown = rows.filter((row) => lens === 'kite' ? row.daylight === true : Number(coastalClock(row.time, zone).hour) % 3 === 0);
  const secondary = lens === 'surf' && shown.some((row) => row.secondaryHeightM != null || row.secondaryPeriodS != null || row.secondaryFrom != null);
  const normal = spot?.seawardDeg ?? null;
  const best = bestCoastalWindow(rows, lens, band, normal);
  const failed = !!active && (lens === 'kite' ? active.windDone && !active.wind : active.marineDone && !active.marine);
  const partial = lens === 'surf' && !!active?.marine && active.windDone && !active.wind;
  const done = lens === 'kite' ? active?.windDone : active?.marineDone;
  const viewport = typeof window === 'undefined' ? 800 : window.innerHeight;
  const height = !desktop && anchor ? coastalSheetHeight(detent, anchor.top, anchor.bottom, anchor.ceiling, viewport, peekPx) : 0;
  useLayoutEffect(() => {
    if (desktop) return;
    const panel = panelRef.current;
    if (!panel) return;
    const measure = () => {
      const px = (selector: string) => panel.querySelector<HTMLElement>(selector)?.offsetHeight ?? 0;
      const row = px('[data-coastal-row]') || 28;
      const table = px('[data-coastal-columns]');
      const status = table ? 0 : px('[data-coastal-status]');
      const border = panel.offsetHeight - panel.clientHeight;
      const next = Math.ceil(px('[data-sheet-grabber]') + px('[data-coastal-head]') + px('[data-coastal-best-row]') + (table ? table + row * COASTAL_PEEK_ROWS : status) + border);
      setPeekPx((old) => old === next || next < 1 ? old : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    for (const selector of ['[data-coastal-head]', '[data-coastal-best-row]', '[data-coastal-columns]', '[data-coastal-row]']) {
      const node = panel.querySelector(selector);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [desktop, panelRef, shown.length, lens, sources, failed]);
  const commit = () => {
    const next = { min: draft.min.trim() ? Number(draft.min) : NaN, max: draft.max.trim() ? Number(draft.max) : NaN };
    if (validKiteBand(next)) onBand(next);
    else setDraft({ min: String(band.min), max: String(band.max) });
  };
  const timeCell = (row: CoastalHour) => {
    return <time role="cell" dateTime={new Date(row.time).toISOString()} title={new Date(row.time).toLocaleString('en-AU', { timeZone: zone, timeZoneName: 'short' })}>{coastalWhen(row.time, zone)}</time>;
  };
  const lensName = lens === 'kite' ? 'Kite' : 'Surf';
  const toggle = () => setDetent((value) => (value === 'peek' ? 'full' : 'peek'));
  return <aside ref={panelRef} aria-label={`${lensName} forecast`} data-coastal-panel={lens}
    data-point-layout={desktop ? 'side' : 'sheet'} data-coastal-sheet={desktop ? undefined : detent} data-coastal-location={`${lat},${lon}`}
    className={`${shared.panel} ${desktop ? shared.side : `${shared.sheet} ${styles.phone}`} ${styles.panel}`}
    style={!desktop ? anchor && height > 0 ? { left: anchor.left, width: anchor.width, top: anchor.bottom - height, height } : { visibility: 'hidden' } : undefined}>
    {desktop ? null : <button type="button" className={styles.grabber} data-sheet-grabber aria-expanded={detent === 'full'}
      aria-label={detent === 'peek' ? `Expand ${lensName}` : `Collapse ${lensName}`}
      onClick={() => { if (!drag.current?.moved) toggle(); drag.current = null; }}
      onPointerDown={(event) => { drag.current = { y: event.clientY, moved: false }; event.currentTarget.setPointerCapture(event.pointerId); }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        const dy = event.clientY - start.y;
        if (Math.abs(dy) > 24) { start.moved = true; setDetent(dy < 0 ? 'full' : 'peek'); }
      }}>
      <span />
    </button>}
    <div className={styles.heading} data-coastal-head>
      <span className={styles.identity}>
        <strong data-point-title title={spot ? `${name} · coast ${spot.distanceKm.toFixed(1)} km · ${spot.lat.toFixed(2)}, ${spot.lon.toFixed(2)}` : name}>{name}{lens === 'surf' && spot ? ' · coast' : ''}</strong>
        {detail ? <span className={styles.coords} data-point-coords>{detail}</span> : null}
      </span>
      {lens === 'kite' ? <div className={styles.band} title="Kite band in knots: amber below, green inside, red above">
        <input aria-label="Kite minimum knots" type="number" min="0" max={band.max - 1} step="1" value={draft.min} onChange={(e) => setDraft({ ...draft, min: e.target.value })} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
        <span>–</span><input aria-label="Kite maximum knots" type="number" min={band.min + 1} max="100" step="1" value={draft.max} onChange={(e) => setDraft({ ...draft, max: e.target.value })} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /><span>kt</span>
      </div> : null}
      <span className={styles.mark}>
        <button type="button" className={styles.markButton} data-set-place aria-pressed={isPlace} aria-label="Set as my place" onClick={() => { const outcome = onMakePlace(); placeNote.show(outcome === 'restored' ? 'Restored' : outcome === 'same' ? 'Your place' : 'Set as my place'); }}>
          <StarIcon filled={isPlace} />
        </button>
        <PressNote text={placeNote.note} />
      </span>
      <button type="button" className={styles.info} aria-label="Coastal data sources" aria-expanded={sources} onClick={() => setSources((v) => !v)}>ⓘ</button>
      <button ref={closeRef} type="button" aria-label={`Close ${lens}`} title={`Close ${lens}`} onClick={onClose}>×</button>
    </div>
    {sources ? <div className={styles.sources} role="note" onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setSources(false); } }}>
      <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a> · <a href="https://open-meteo.com/en/docs/marine-weather-api" target="_blank" rel="noreferrer">Marine</a> (CC BY 4.0). Natural Earth coastline and lake shores (public domain). Latest point forecast; independent of the chart run. Shore directions use the generalized coastline and lake shores.
    </div> : null}
    {!spot ? <p className={styles.status} data-coastal-status>no coast within 50 km</p> : <>
      <div className={styles.best} data-coastal-best-row title={lens === 'kite' ? 'Longest daylight window: wind in band, gusts no higher than the upper limit, no offshore component' : 'Longest daylight window: swell ≥10 s, wind offshore or ≤8 kt'}>
        <span data-coastal-best>{bestLabel(best, zone, lens, band)}</span>
        {failed || partial ? <button type="button" aria-label="Retry forecast" title="Forecast unavailable · retry" onClick={() => setRetry((v) => v + 1)}>⟳</button> : null}
      </div>
      {!done ? <p className={styles.status} data-coastal-status role="status">…</p> : failed ? <p className={styles.status} data-coastal-status role="status">Forecast unavailable</p> : !shown.length ? <p className={styles.status} data-coastal-status>No daylight forecast</p> :
        <div className={styles.scroll} data-coastal-scroll tabIndex={0} aria-label="Forecast rows">
          <div role="table" aria-label={`${lens} forecast rows`} className={lens === 'kite' ? styles.kite : styles.surf} data-secondary={secondary}>
            <div role="row" className={styles.columns} data-coastal-columns><span role="columnheader" title={zone}>local</span>{lens === 'kite' ? <><span role="columnheader">wind / gust kt</span><span role="columnheader">shore</span></> : <><span role="columnheader" title="Significant wave height, metres">wave</span><span role="columnheader" title="Primary swell: metres / seconds; down-wave arrow">swell m/s</span>{secondary ? <span role="columnheader" title="Secondary swell: metres / seconds">② m/s</span> : null}<span role="columnheader">wind kt</span><span role="columnheader" title="Sea surface temperature, Celsius">sea °C</span></>}</div>
            {shown.map((row) => <div role="row" key={row.time} data-coastal-row data-hour={row.time} data-daylight={row.daylight ?? 'missing'} className={styles.row}>
              {timeCell(row)}
              {lens === 'kite' ? <>
                <span role="cell" className={styles.wind} title={`Wind from ${number(row.windFrom)}°`}><WindArrow from={row.windFrom} className={styles.arrow} /><span data-band={kiteBandState(row.windKt, band)}>{number(row.windKt)}</span><span>/</span><span data-band={kiteBandState(row.gustKt, band)}>{number(row.gustKt)}</span></span>
                <span role="cell"><Shore from={row.windFrom} normal={normal} kite /></span>
              </> : <>
                <span role="cell" title="Significant wave height, metres">{number(row.waveHeightM, 1)}</span>
                <Swell height={row.swellHeightM} period={row.swellPeriodS} from={row.swellFrom} />
                {secondary ? <Swell secondary height={row.secondaryHeightM} period={row.secondaryPeriodS} from={row.secondaryFrom} /> : null}
                <span role="cell" className={styles.surfWind} title={`Wind ${number(row.windKt)} kt from ${number(row.windFrom)}°`}><span className={styles.wind}><WindArrow from={row.windFrom} className={styles.arrow} />{number(row.windKt)}</span><Shore from={row.windFrom} normal={normal} kite={false} /></span>
                <span role="cell" title="Sea surface temperature, Celsius">{number(row.seaTempC)}</span>
              </>}
            </div>)}
          </div>
        </div>}
    </>}
  </aside>;
}
