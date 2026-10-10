'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ComponentType } from 'react';
import { PersonGlyph, useAccount } from './Account';

type Icon = ComponentType<{ className?: string }>;

const ITEMS: { href: string; label: string; icon: Icon }[] = [
  { href: '/', label: 'Map', icon: MapIcon },
  { href: '/historical', label: 'Historical', icon: HistoricalIcon },
  { href: '/e6b', label: 'E6-B', icon: E6BIcon },
  { href: '/train', label: 'Train', icon: TrainIcon },
  { href: '/download', label: 'Download', icon: DownloadIcon },
];

function active(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

function Item({
  href,
  label,
  icon: Icon,
  current,
  compact,
}: {
  href: string;
  label: string;
  icon: Icon;
  current: boolean;
  compact?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={current ? 'page' : undefined}
      aria-label={label}
      className={compact
        ? `tab-item relative flex min-w-0 flex-col items-center gap-1 rounded-lg p-2 ${current ? 'text-[var(--md-on-secondary-container)]' : 'text-[var(--md-on-surface-variant)]'}`
        : `relative flex w-full flex-col items-center gap-1 rounded-lg px-1 py-3 ${current ? 'bg-[var(--md-primary-container)] text-[var(--md-on-primary-container)] shadow-[inset_0_1px_0_rgba(255,255,255,0.38)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}
    >
      {current && (compact
        ? <span aria-hidden="true" className="absolute -top-2 h-1 w-8 rounded-full bg-[var(--md-tertiary)]" />
        : <span aria-hidden="true" className="absolute bottom-3 left-1 top-3 w-1 rounded-full bg-[var(--md-tertiary)]" />)}
      {compact ? (
        <span className={`rounded-full p-1.5 ${current ? 'bg-[var(--md-secondary-container)]' : ''}`}>
          <Icon className="h-6 w-6" />
        </span>
      ) : <Icon className="h-6 w-6" />}
      <span className="text-center text-[11px] font-medium leading-tight">{label}</span>
    </Link>
  );
}

export function Navigation() {
  const pathname = usePathname() || '/';
  return (
    <>
      <nav aria-label="Main navigation" className="rail-safe fixed left-0 top-0 z-50 hidden h-full flex-col items-center overflow-y-auto border-r border-[var(--md-outline-soft)] bg-[var(--md-surface-container-low)]/95 py-6 shadow-[0_0_24px_rgba(21,35,46,0.06)] backdrop-blur md:flex">
        <Link href="/" aria-label="Home" className="mb-4 rounded-lg p-2 hover:bg-[var(--md-surface-container-high)]">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-[var(--md-primary)] text-lg font-bold text-[var(--md-on-primary)] shadow-[inset_0_-3px_0_rgba(0,0,0,0.16),0_8px_18px_rgba(33,77,115,0.18)]">Is</span>
        </Link>
        <div className="flex w-full flex-1 flex-col items-center gap-2 px-2">
          {ITEMS.map((item) => (
            <Item key={item.href} {...item} current={active(pathname, item.href)} />
          ))}
          <div className="mt-auto w-full"><AccountItem /></div>
        </div>
      </nav>
      <nav aria-label="Main navigation" className="tabbar fixed bottom-0 left-0 right-0 z-50 flex items-center justify-start overflow-x-auto border-t border-[var(--md-outline-soft)] bg-[var(--md-surface)]/95 shadow-[0_-10px_28px_rgba(21,35,46,0.08)] backdrop-blur md:hidden">
        {ITEMS.map((item) => (
          <Item key={item.href} {...item} compact current={active(pathname, item.href)} />
        ))}
        <AccountItem compact />
      </nav>
    </>
  );
}

/** The person control: outline signed out, filled signed in. Opens the account sheet. */
function AccountItem({ compact }: { compact?: boolean }) {
  const { user, open, setOpen } = useAccount();
  const label = user ? 'Account' : 'Sign in';
  return (
    <button
      type="button"
      aria-label={user ? `Account: ${user.email ?? ''}` : 'Sign in'}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={user?.email ?? 'Sign in'}
      data-account-button={user ? 'in' : 'out'}
      onClick={() => setOpen(!open)}
      className={compact
        ? `tab-item relative flex min-w-0 flex-col items-center gap-1 rounded-lg p-2 ${open ? 'text-[var(--md-on-secondary-container)]' : 'text-[var(--md-on-surface-variant)]'}`
        : `relative flex w-full flex-col items-center gap-1 rounded-lg px-1 py-3 ${open ? 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)]' : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'}`}
    >
      {compact
        ? <span className={`rounded-full p-1.5 ${open ? 'bg-[var(--md-secondary-container)]' : ''}`}><PersonGlyph filled={!!user} className={`h-6 w-6 ${user ? 'text-[var(--md-primary)]' : ''}`} /></span>
        : <PersonGlyph filled={!!user} className={`h-6 w-6 ${user ? 'text-[var(--md-primary)]' : ''}`} />}
      <span className="text-center text-[11px] font-medium leading-tight">{label}</span>
    </button>
  );
}

function MapIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 7c4-2 12-2 16 0M4 12c4-2 12-2 16 0M4 17c4-2 12-2 16 0" />
    </svg>
  );
}

function E6BIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5.5" />
      <path d="M12 3v3M12 12l3.5-3.5" />
    </svg>
  );
}

function TrainIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="4" width="18" height="14" rx="2" />
      <path d="M7 8h10M7 12h6" />
    </svg>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 4v10M8 10l4 4 4-4" />
      <path d="M5 19h14" />
    </svg>
  );
}

function HistoricalIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M4 6h16M4 12h16M4 18h16" /><path d="M8 4v4M15 10v4M11 16v4" />
    </svg>
  );
}
