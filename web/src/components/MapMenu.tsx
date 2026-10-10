'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LEARN_KEY, readLearn } from '../../../training/src/learn-profile.ts';
import { LEVEL_LABEL } from '../../../training/src/levels.ts';
import { useAccount } from './Account';
import { ThemeToggle } from './ThemeToggle';
import { TimesControl } from './TimesControl';
import { UnitsControl } from './UnitsControl';
import { ATTRIBUTION } from './Attribution';

/** The level already chosen on this device, or Choose, which opens the picker. */
function LearnLevelValue() {
  const [label, setLabel] = useState('Choose');
  useEffect(() => {
    try {
      const record = readLearn(JSON.parse(localStorage.getItem(LEARN_KEY) ?? 'null'));
      setLabel(record ? LEVEL_LABEL[record.level] : 'Choose');
    } catch { setLabel('Choose'); }
  }, []);
  return <Link href="/train?level=1" data-learn-level={label} aria-label={`Level, ${label}`}>{label}</Link>;
}

/** Secondary destinations and settings. The map has no training navigation rail. */
export function MapMenu({ run, wind, onOpen, phone, graticule, onGraticule }: {
  phone: boolean;
  wind?: ReactNode;
  run: ReactNode;
  onOpen: () => void;
  graticule: boolean;
  onGraticule: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const { user, open: accountOpen, setOpen: openAccount } = useAccount();
  const [sources, setSources] = useState(false);
  useEffect(() => { if (!open) setSources(false); }, [open]);
  const previousAccount = useRef(accountOpen);
  useEffect(() => {
    if (previousAccount.current && !accountOpen) button.current?.focus({ preventScroll: true });
    previousAccount.current = accountOpen;
  }, [accountOpen]);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); button.current?.focus(); }
    };
    window.addEventListener('pointerdown', pointer);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('pointerdown', pointer); window.removeEventListener('keydown', key); };
  }, [open]);
  return <div className="map-menu-root" ref={root}>
    <button ref={button} type="button" className="map-menu-button" aria-label="Menu" aria-expanded={open} aria-controls="map-menu" onClick={() => {
      if (!open) onOpen();
      else setSources(false);
      setOpen(!open);
    }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg></button>
    <div id="map-menu" data-map-menu hidden={!open} className="map-menu" onClick={(event) => {
      if ((event.target as HTMLElement).closest('a, [role="menuitem"]')) setOpen(false);
    }}>
      <div className="map-menu-setting map-menu-learn">
        <Link href="/train">Learn</Link>
        <LearnLevelValue />
      </div>
      <Link href="/e6b">E6-B</Link>
      <Link href="/historical">Historical</Link>
      <button type="button" data-account-button={user ? 'in' : 'out'} aria-label={user ? `Account: ${user.email ?? ''}` : 'Sign in'} aria-haspopup="dialog" onClick={() => { setOpen(false); openAccount(true); }}>{user ? 'Account' : 'Sign in'}</button>
      <div className="map-menu-setting"><span>Units</span><UnitsControl /></div>
      <div className="map-menu-setting"><span>Theme</span><ThemeToggle /></div>
      <div className="map-menu-setting"><span>Times</span><TimesControl /></div>
      <div className="map-menu-run">{run}</div>
      {phone ? wind : null}
      <button type="button" aria-label="Latitude and longitude" aria-pressed={graticule} data-graticule={graticule ? 'on' : 'off'} onClick={onGraticule}>
        Lat long<span aria-hidden="true" className="ml-auto">{graticule ? '✓' : ''}</span>
      </button>
      <Link href="/download" title="Download the Mac app">Mac app</Link>
      <Link href="/privacy" title="Chats and use are stored">Privacy</Link>
      <details open={sources} onToggle={(event) => setSources((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>Data sources</summary>
        {open && sources ? <p>{ATTRIBUTION}</p> : null}
      </details>
    </div>
  </div>;
}
