'use client';

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { ClockMode } from '@/lib/time-label';

/** Per browser. Not an account setting: a new visitor, and a new browser, start on place local. */
export const TIMES_KEY = 'isobar.times';

interface TimesApi {
  mode: ClockMode;
  setMode: (mode: ClockMode) => void;
}

const TimesContext = createContext<TimesApi | null>(null);

function storedMode(): ClockMode | null {
  try {
    const value = localStorage.getItem(TIMES_KEY);
    return value === 'place' || value === 'utc' || value === 'device' ? value : null;
  } catch {
    return null;
  }
}

export function TimesProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ClockMode>('place');
  const apply = useCallback((next: ClockMode, persist: boolean) => {
    setModeState(next);
    if (!persist) return;
    try {
      if (next === 'place') localStorage.removeItem(TIMES_KEY);
      else localStorage.setItem(TIMES_KEY, next);
    } catch { /* this visit still holds the choice */ }
  }, []);
  useEffect(() => {
    const stored = storedMode();
    if (stored && stored !== 'place') apply(stored, false);
  }, [apply]);
  return (
    <TimesContext.Provider value={{ mode, setMode: (next) => apply(next, true) }}>
      {children}
    </TimesContext.Provider>
  );
}

const FALLBACK: TimesApi = { mode: 'place', setMode: () => {} };

export function useTimes(): TimesApi {
  return useContext(TimesContext) ?? FALLBACK;
}

function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4" />
    </svg>
  );
}

/** Menu row: place local, UTC only, or this device's zone. */
export function TimesControl() {
  const { mode, setMode } = useTimes();
  return (
    <label className="relative flex shrink-0 items-center">
      <span className="sr-only">Times</span>
      <select
        data-times={mode}
        aria-label="Times"
        title="Times: place local, UTC only, or my local"
        value={mode}
        onChange={(event) => {
          const value = event.target.value;
          if (value === 'place' || value === 'utc' || value === 'device') setMode(value);
        }}
        className="h-9 appearance-none rounded-md bg-transparent pr-6 pl-1 text-[13px] font-semibold text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]"
      >
        <option value="place">place local</option>
        <option value="utc">UTC only</option>
        <option value="device">my local</option>
      </select>
      <Chevron className="pointer-events-none absolute right-0.5 h-4 w-4 text-[var(--md-on-surface-variant)]" />
    </label>
  );
}
