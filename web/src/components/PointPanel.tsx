'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { loadMarine, marineAt, marineCacheKey, type MarineSeries } from '@/lib/point/marine';
import { loadPointProfile, pointCacheKey, pointProfileAt, pointSurfaceAt, type PointModel } from '@/lib/point/openmeteo';
import { forecastRunLabel, forecastRunTitle } from '@/lib/point/provenance';
import { collectorPointModel, pointSky, type MapPoint } from '@/lib/point/section';
import { formatGround } from '@/lib/point/ground';
import { airRows, pointSheetHeight, seaRows, soundingFrame, soundingReadout, type SoundingEmphasis } from '@/lib/point/sounding';
import { modelGroundFromPressure, resolveModelGroundM, type SectionSample } from '@/lib/point/terrain-section';
import type { AtmosphereSlice } from '@/lib/atmosphere-slice';
import { profileAt } from '@/lib/sky/physics';
import { loadSky } from './FlyPanel';
import { Sounding } from './Sounding';
import { POINT_SIDE_QUERY, useMapSheet } from './MapSheet';
import { useUnits } from './UnitsControl';
import { PressNote, usePressNote, type Lens } from './MapChrome';
import { StarIcon } from './PlaceField';
import styles from './PointPanel.module.css';

export function PointPanel({ reconstructedModel=null, archiveOnly=false, point, name, detail, isPlace, onMakePlace, validMs, lens, terrainM, section, sectionGeometry, sectionExpedition = false, orographyM, mslpHpa, onClose, anchorRef, panelRef, collectorIcao }: {
  reconstructedModel?: PointModel | null;
  archiveOnly?: boolean;
  point: MapPoint; name: string; detail: string; isPlace: boolean; onMakePlace: () => 'set' | 'restored' | 'same'; validMs: number; lens: Lens;
  /** Offline ground: export orography, else the loaded DEM. Null until one exists. */
  terrainM: number | null;
  /** DEM track through the selected section. Null while terrain is unavailable. */
  section?: SectionSample[] | null;
  sectionGeometry?: AtmosphereSlice | null;
  sectionExpedition?: boolean;
  /** Model orography from the chart export, when that field exists. */
  orographyM?: number | null;
  /** Chart mean sea-level pressure at the spot, for the model-ground fallback. */
  mslpHpa?: number | null;
  collectorIcao?: string;
  onClose: () => void; anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
}) {
  const { desktop, anchor } = useMapSheet(anchorRef, POINT_SIDE_QUERY);
  const { units } = useUnits();
  const closeRef = useRef<HTMLButtonElement>(null);
  const placeNote = usePressNote();
  const closeAction = useRef(onClose);
  closeAction.current = onClose;
  const key = `${pointCacheKey(point.lat, point.lon, validMs)}|${collectorIcao ?? ''}`;
  const marineKey = marineCacheKey(point.lat, point.lon, validMs);
  const day = Math.floor(validMs / 86_400_000);
  const currentTime = useRef(validMs);
  currentTime.current = validMs;
  const [result, setResult] = useState<{ key: string; model: PointModel | null }>({ key: '', model: null });
  const [marine, setMarine] = useState<{ key: string; series: MarineSeries | null }>({ key: '', series: null });
  const [activeId, setActiveId] = useState('surface');
  const [retry, setRetry] = useState(0);
  const collectorExpired = result.key === key && !!result.model && result.model.series.icao !== 'POINT'
    && !pointProfileAt(result.model, validMs)?.levels.length;
  useEffect(() => {
    if(archiveOnly){setResult({key,model:reconstructedModel});setMarine({key:marineKey,series:null});return;}
    const controller = new AbortController();
    const load = async () => {
      if (collectorIcao) {
        const file = await loadSky();
        if (controller.signal.aborted) return null;
        const series = file?.profiles.find((item) => item.icao === collectorIcao);
        if (series && profileAt(series, currentTime.current)?.levels.length) return collectorPointModel(series);
      }
      return loadPointProfile(point.lat, point.lon, { mapTimeMs: currentTime.current, signal: controller.signal });
    };
    setActiveId('surface');
    void load()
      .then((model) => { if (!controller.signal.aborted) setResult({ key, model }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ key, model: null }); });
    void loadMarine(point.lat, point.lon, { mapTimeMs: currentTime.current, signal: controller.signal })
      .then((series) => { if (!controller.signal.aborted) setMarine({ key: marineKey, series }); })
      .catch(() => { if (!controller.signal.aborted) setMarine({ key: marineKey, series: null }); });
    return () => controller.abort();
  }, [reconstructedModel,archiveOnly,point.lat, point.lon, day, key, marineKey, collectorIcao, collectorExpired, retry]);
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) closeAction.current(); };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);

  const model = result.key === key ? result.model : null;
  const profile = useMemo(() => pointProfileAt(model, validMs), [model, validMs]);
  const surface = useMemo(() => pointSurfaceAt(model, validMs), [model, validMs]);
  const elevation = terrainM;
  const modelGroundM = resolveModelGroundM(orographyM ?? null, modelGroundFromPressure(surface?.surfacePressureHpa ?? null, mslpHpa ?? null));
  const state = useMemo(() => profile && model ? pointSky(point, profile, surface, elevation, modelGroundM) : null, [point, profile, surface, model, elevation, modelGroundM]);
  const rows = useMemo(() => profile ? airRows(profile.levels, surface, elevation, units, modelGroundM) : [], [profile, surface, elevation, units, modelGroundM]);
  const sea = useMemo(() => seaRows(marine.key === marineKey ? marineAt(marine.series, validMs) : null, units), [marine, marineKey, validMs, units]);
  const emphasis: SoundingEmphasis = lens === 'temp' ? 'temp' : lens === 'rain' ? 'cloud' : 'wind';
  const active = rows.find((row) => row.id === activeId) ?? rows.find((row) => row.id === 'surface') ?? null;
  const viewport = typeof window === 'undefined' ? 800 : window.innerHeight;
  const baseHeight = anchor ? pointSheetHeight(anchor.top, anchor.bottom, anchor.ceiling, viewport) : 0;
  // A 3D cut needs a usable map area above the phone sheet, including its sweep.
  const height = sectionGeometry && !desktop && anchor
    ? Math.min(baseHeight, Math.max(220, anchor.bottom - Math.max(anchor.top, anchor.ceiling) - 220))
    : baseHeight;
  const loading = result.key !== key;
  const compact = !profile || !state;
  const identity = model ? { source: model.provenance.source, model: model.provenance.model, run: model.provenance.run, cycle: model.provenance.cycle } : null;
  const frame = soundingFrame(rows, elevation);
  const groundText = elevation == null ? null : formatGround(elevation);
  return (
    <aside ref={panelRef} aria-label="Point section" data-point-panel data-point-layout={desktop ? (compact ? 'compact' : 'side') : 'sheet'} data-point-state={loading ? 'loading' : compact ? 'unavailable' : 'ready'} data-point-emphasis={lens} data-point-location={`${point.lat},${point.lon}`}
      className={`${styles.panel} ${desktop ? styles.side : styles.sheet} ${compact ? styles.compact : ''}`}
      style={!desktop ? (anchor && height > 0 ? { left: anchor.left, width: anchor.width, ...(compact ? { bottom: viewport - anchor.bottom, maxHeight: height } : { top: anchor.bottom - height, height }) } : { visibility: 'hidden' }) : undefined}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <div className={styles.heading}>
        <span className={styles.identity} data-point-source title={identity ? `${forecastRunLabel(identity)} · ${forecastRunTitle(identity)}` : undefined}>
          <strong data-point-title>{name}</strong>
          <span className={styles.datum}>
            {detail ? <span className={styles.coords} data-point-coords>{detail}</span> : null}
            {groundText ? <span className={styles.elevation} data-point-elevation>{groundText}</span> : null}
          </span>
        </span>

        <span className={styles.mark}>
          <button type="button" data-set-place aria-pressed={isPlace} aria-label="Set as my place" onClick={() => { const outcome = onMakePlace(); placeNote.show(outcome === 'restored' ? 'Restored' : outcome === 'same' ? 'Your place' : 'Set as my place'); }}>
            <StarIcon filled={isPlace} />
          </button>
          <PressNote text={placeNote.note} />
        </span>
        <button ref={closeRef} type="button" aria-label="Close point" onClick={onClose}>×</button>
      </div>
      {profile && state ? (
        <>
          <Sounding rows={rows} sea={sea} layers={state.layers} icing={state.icing} freezingFt={state.freezingFt} bottomFt={frame.bottomFt} groundFt={frame.groundFt} section={section} sectionGeometry={sectionGeometry} sectionExpedition={sectionExpedition} sectionTimeMs={validMs} modelGroundM={modelGroundM} emphasis={emphasis} activeId={active?.id ?? 'surface'} onActive={setActiveId} temp={units.temp} />
          <p className={styles.readout} data-readout>{active ? soundingReadout(active, units) : ''}</p>
        </>
      ) : <div className={styles.status}><span role="status">{loading ? 'Loading profile…' : 'Profile unavailable'}</span>{!loading && !archiveOnly ? <button type="button" onClick={() => { setResult({ key: '', model: null }); setRetry(n => n + 1); }}>Retry</button> : null}</div>}
    </aside>
  );
}
