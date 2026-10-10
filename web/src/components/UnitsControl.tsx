'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { KEYS, setPref, SYNCED } from '@/lib/account/local';
import { regionAt } from '@/lib/units-regions';
import {
  AUS_UNITS, dwellRegion, resolveUnits, unitKey, unitsTooltip,
  type DisplayUnits, type DwellState, type UnitMode,
} from '@/lib/units';

interface UnitsApi {
  mode: UnitMode;
  units: DisplayUnits;
  setMode: (mode: UnitMode) => void;
  noteView: (lat: number | null, lon: number | null) => void;
}

const UnitsContext = createContext<UnitsApi | null>(null);

function sameUnits(a: DisplayUnits, b: DisplayUnits): boolean {
  return a.mode === b.mode && a.id === b.id && unitKey(a) === unitKey(b);
}

function storedMode(): UnitMode | null {
  try {
    const value = localStorage.getItem(KEYS.units);
    return value === 'aus' || value === 'us' || value === 'local' ? value : null;
  } catch {
    return null;
  }
}

export function UnitsProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<UnitMode>('aus');
  const [units, setUnits] = useState<DisplayUnits>(AUS_UNITS);
  const modeRef = useRef(mode);
  const viewRef = useRef<{ lat: number | null; lon: number | null }>({ lat: null, lon: null });
  const dwellRef = useRef<DwellState>({ regionId: 'icao', pendingId: null, pendingAt: null });
  const settledRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const armedFor = useRef<string | null>(null);
  modeRef.current = mode;

  const publish = useCallback((next: DisplayUnits) => {
    setUnits((current) => sameUnits(current, next) ? current : next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    armedFor.current = null;
  }, []);

  const arm = useCallback((state: DwellState) => {
    const token = state.pendingId != null && state.pendingAt != null ? `${state.pendingId}:${state.pendingAt}` : null;
    if (token === armedFor.current) return;
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    armedFor.current = token;
    if (!token || state.pendingAt == null) return;
    // Monotonic clock: pinning the wall clock (the forecast hour) must not freeze the dwell.
    const wait = Math.max(0, 1000 - (performance.now() - state.pendingAt));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      armedFor.current = null;
      if (modeRef.current !== 'local') return;
      const view = viewRef.current;
      if (view.lat == null || view.lon == null) return;
      const regionId = regionAt(view.lat, view.lon).id;
      const next = dwellRegion(dwellRef.current, regionId, performance.now());
      const committed = next.regionId !== dwellRef.current.regionId;
      dwellRef.current = next;
      if (committed) publish(resolveUnits('local', view.lat, view.lon));
      arm(next);
    }, wait);
  }, [publish]);

  const noteView = useCallback((lat: number | null, lon: number | null) => {
    viewRef.current = { lat, lon };
    if (modeRef.current !== 'local') return;
    if (lat == null || lon == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const regionId = regionAt(lat, lon).id;
    if (!settledRef.current) {
      settledRef.current = true;
      dwellRef.current = { regionId, pendingId: null, pendingAt: null };
      clearTimer();
      publish(resolveUnits('local', lat, lon));
      return;
    }
    const next = dwellRegion(dwellRef.current, regionId, performance.now());
    const committed = next.regionId !== dwellRef.current.regionId;
    dwellRef.current = next;
    if (committed) publish(resolveUnits('local', lat, lon));
    arm(next);
  }, [arm, clearTimer, publish]);

  const applyMode = useCallback((next: UnitMode, persist: boolean) => {
    modeRef.current = next;
    setModeState(next);
    if (persist) setPref('units', next);
    clearTimer();
    if (next !== 'local') {
      publish(resolveUnits(next, null, null));
      return;
    }
    settledRef.current = false;
    const view = viewRef.current;
    if (view.lat != null && view.lon != null) noteView(view.lat, view.lon);
  }, [clearTimer, noteView, publish]);

  useEffect(() => {
    const stored = storedMode();
    if (stored && stored !== 'aus') applyMode(stored, false);
    const onSynced = () => {
      const value = storedMode();
      if (value && value !== modeRef.current) applyMode(value, false);
    };
    window.addEventListener(SYNCED, onSynced);
    return () => {
      window.removeEventListener(SYNCED, onSynced);
      clearTimer();
    };
  }, [applyMode, clearTimer]);

  return (
    <UnitsContext.Provider value={{ mode, units, setMode: (next) => applyMode(next, true), noteView }}>
      {children}
    </UnitsContext.Provider>
  );
}

const FALLBACK: UnitsApi = {
  mode: 'aus',
  units: AUS_UNITS,
  setMode: () => {},
  noteView: () => {},
};

export function useUnits(): UnitsApi {
  return useContext(UnitsContext) ?? FALLBACK;
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4" />
    </svg>
  );
}

/** Current unit preset. The menu is the control; the tooltip is one line. */
export function UnitsControl() {
  const { mode, units, setMode } = useUnits();
  return (
    <label className="relative flex shrink-0 items-center">
      <span className="sr-only">Units</span>
      <select
        data-units={mode}
        data-units-region={units.id}
        data-pressure-unit={units.pressure}
        data-temp-unit={units.temp}
        data-height-unit={units.height}
        data-vis-unit={units.visibility}
        data-rain-unit={units.rain}
        data-flight-level={units.flightLevel}
        aria-label={units.label}
        title={unitsTooltip(units)}
        value={mode}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'aus' || value === 'us' || value === 'local') setMode(value);
        }}
        className="h-9 appearance-none rounded-md bg-transparent pr-6 pl-1 text-[13px] font-semibold tracking-wide text-[var(--md-on-surface)] tabular-nums hover:bg-[var(--md-surface-container-high)]"
      >
        <option value="aus">AUS</option>
        <option value="us">US</option>
        <option value="local">LOCAL</option>
      </select>
      <Chevron className="pointer-events-none absolute right-0.5 h-4 w-4 text-[var(--md-on-surface-variant)]" />
    </label>
  );
}
