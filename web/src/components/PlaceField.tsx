'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AirportRow } from '@/lib/airports';
import { placeChoices, searchPlaces, type CatalogPlace, type ManifestPlace } from '@/lib/place-catalog';
import type { PlaceRow } from '@/lib/places';
import { PressNote, usePressNote } from './MapChrome';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const SEARCH_PROMPT = 'Search a place or airport';

export function StarIcon({ filled }: { filled?: boolean }) {
  return filled
    ? <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path fill="currentColor" d="m12 3.2 2.4 5.6 6 .5-4.6 3.9 1.4 5.8L12 16.2 6.8 19l1.4-5.8L3.6 9.3l6-.5z" /></svg>
    : <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" d="m12 3.8 2.2 5.1 5.5.5-4.2 3.6 1.3 5.3L12 15.6 7.2 18.3l1.3-5.3L4.3 9.4l5.5-.5z" /></svg>;
}

function LocateIcon() {
  return <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><circle {...stroke} cx="12" cy="12" r="3" /><path {...stroke} d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>;
}

/** Whole words that fit the cell. A clipped proper name is worse than a shorter one; the full name stays on the control. */
function FittedName({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const words = text.split(' ');
      let next = text;
      el.textContent = next;
      while (words.length > 1 && el.scrollWidth > el.clientWidth + 1) {
        words.pop();
        while (words.length > 1 && /^[-–—]$/.test(words[words.length - 1] ?? '')) words.pop();
        next = words.join(' ');
        el.textContent = next;
      }
      setShown((current) => (current === next ? current : next));
    };
    fit();
    const parent = el.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(fit);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [text]);
  return (
    <span ref={ref} className="block min-w-0 overflow-hidden text-[15px] font-medium whitespace-nowrap [text-overflow:clip]">
      {shown}
    </span>
  );
}

function Mark({ place, selected }: { place: CatalogPlace; selected: boolean }) {
  if (selected) {
    return <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path {...stroke} strokeWidth={2} d="M5 12.5 9.2 17 19 7" /></svg>;
  }
  if (place.kind === 'airport') {
    return <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true"><path fill="currentColor" d="M21 12.8v-1.6l-8-4.7V3.2a1.2 1.2 0 0 0-2.4 0v3.3l-7.6 4.7v1.6l7.6-2.3v4.9L8.5 16.9v1.4l3.3-1 3.3 1v-1.4l-2.1-1.5v-4.9z" transform="rotate(90 12 12)" /></svg>;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />;
}

/**
 * Header place control: a search field, a locate button beside it, and a star
 * for the saved list. Saved places stay first in the menu.
 */
export function PlaceField({
  selected,
  savedIds,
  saved,
  manifest,
  towns,
  airports,
  denied,
  hint,
  located,
  onSelect,
  onLocate,
  onToggleSaved,
}: {
  selected: CatalogPlace | null;
  savedIds: readonly string[];
  saved: boolean;
  manifest: readonly ManifestPlace[];
  towns: readonly PlaceRow[];
  airports: readonly AirportRow[];
  denied: boolean;
  hint: boolean;
  /** Increments after a successful locate, so the button can name what happened. */
  located: number;
  onSelect: (place: CatalogPlace) => void;
  onLocate: () => void;
  onToggleSaved: () => void;
}) {
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const locateNote = usePressNote();
  const saveNote = usePressNote();
  const showLocated = useRef(locateNote.show);
  showLocated.current = locateNote.show;
  useEffect(() => { if (located) showLocated.current('Located'); }, [located]);
  const results = query.trim().length >= 2
    ? searchPlaces(query, towns, airports, manifest)
    : placeChoices(savedIds, manifest, towns, airports);
  const shown = Math.min(active, Math.max(0, results.length - 1));
  const wide = results.reduce<CatalogPlace | null>((best, place) => (best && best.name.length >= place.name.length ? best : place), null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onPointer);
    return () => window.removeEventListener('pointerdown', onPointer);
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  function choose(place: CatalogPlace) {
    onSelect(place);
    setQuery('');
    setOpen(false);
  }

  function reveal() {
    if (open) return;
    setQuery('');
    setActive(0);
    setOpen(true);
  }

  const label = open ? (query || SEARCH_PROMPT) : (selected?.name || 'Place');
  const buttonClass = 'grid h-9 w-9 shrink-0 place-items-center rounded-md border border-[var(--md-outline-soft)] bg-[var(--md-surface-container)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)]';

  return (
    <div data-place-cluster className="relative flex min-w-0 flex-col">
      <div ref={root} className="flex min-w-0 items-center gap-1">
        <div data-place-field data-place-open={open} className="place-field relative inline-grid min-w-0">
          <span data-place-sizing className="invisible col-start-1 row-start-1 px-[26px] text-[15px] leading-9 font-semibold whitespace-pre" aria-hidden="true">{label}</span>
          <input
            ref={inputRef}
            role="combobox"
            aria-label="Place"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[shown] ? `${listId}-${results[shown].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
            size={1}
            data-place={selected?.id ?? ''}
            placeholder={open ? SEARCH_PROMPT : ''}
            value={open ? query : (selected?.name ?? '')}
            onFocus={reveal}
            onClick={reveal}
            onChange={(event) => { setQuery(event.target.value); setOpen(true); setActive(0); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive((index) => Math.min(results.length - 1, index + 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((index) => Math.max(0, index - 1)); }
              else if (event.key === 'Enter' && open && results[shown]) { event.preventDefault(); choose(results[shown]); }
              else if (event.key === 'Escape') { setQuery(''); setOpen(false); }
            }}
            className="col-start-1 row-start-1 h-9 w-full min-w-0 rounded-md border border-[var(--md-outline-soft)] bg-[var(--md-surface-container)] pr-2 pl-[26px] text-[15px] font-semibold text-[var(--md-on-surface)] [text-overflow:clip] outline-none"
          />
          {!open ? <span className="place-name" aria-hidden="true">{selected?.name || 'Place'}</span> : null}
          <svg className="place-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle {...stroke} cx="10" cy="10" r="6" /><path {...stroke} d="m15 15 5 5" /></svg>
          {open ? (
            <div className="absolute top-10 left-0 z-30 min-w-72 overflow-hidden rounded-lg border border-[var(--md-outline-soft)] bg-[var(--md-surface)] shadow-[0_8px_24px_rgba(0,0,0,0.16)]" data-place-menu style={{ width: 'max-content', maxWidth: 'calc(100vw - 1.5rem)' }}>
              {wide ? (
                <div className="pointer-events-none h-0 w-max overflow-hidden px-2" aria-hidden>
                  <span className="inline-block w-5" />
                  <span className="ml-2 text-[15px] font-medium whitespace-nowrap">{wide.name}</span>
                  <span className="ml-2 text-[13px] font-semibold whitespace-nowrap">{wide.datum}</span>
                </div>
              ) : null}
              <ul id={listId} role="listbox" aria-label="Results">
                {results.map((place, index) => {
                  const current = place.id === selected?.id;
                  return (
                    <li key={place.id} role="presentation">
                      <button
                        type="button"
                        id={`${listId}-${place.id}`}
                        role="option"
                        aria-selected={current}
                        data-place-option={place.id}
                        title={place.datum ? `${place.name} ${place.datum}` : place.name}
                        aria-label={place.datum ? `${place.name} ${place.datum}` : place.name}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(place)}
                        className={`grid h-9 w-full min-w-0 grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2 px-2 text-left ${index === shown ? 'bg-[var(--md-surface-container-high)]' : ''} ${current ? 'text-[var(--md-primary)]' : ''}`}
                      >
                        <span className="grid place-items-center"><Mark place={place} selected={current} /></span>
                        <FittedName text={place.name} />
                        <span className="text-[13px] font-semibold tabular-nums whitespace-nowrap text-[var(--md-on-surface-variant)]">{place.datum}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </div>
        <span className="relative">
          <button
            type="button"
            data-locate
            aria-label="Use my location"
            onClick={onLocate}
            className={buttonClass}
          >
            <LocateIcon />
          </button>
          {denied ? <span data-locate-note className="place-note">Location off</span> : <PressNote text={locateNote.note} />}
        </span>
        <span className="relative">
          <button
            type="button"
            data-save-place
            aria-label="Save place"
            aria-pressed={saved}
            disabled={!selected}
            onClick={() => { saveNote.show(saved ? 'Unsaved' : 'Saved'); onToggleSaved(); }}
            className={`${buttonClass} ${saved ? 'bg-[var(--md-primary)] text-[var(--md-on-primary)]' : ''}`}
          >
            <StarIcon filled={saved} />
          </button>
          <PressNote text={saveNote.note} />
        </span>
      </div>
      {hint && !open ? <p data-place-hint className="place-hint">Not here? Search or ⌖</p> : null}
    </div>
  );
}
