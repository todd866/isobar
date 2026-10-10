'use client';

import type { ReactNode } from 'react';
import { ThemeToggle } from './ThemeToggle';
import { UnitsControl } from './UnitsControl';

export function PageBar({ children, className = 'flex' }: { children: ReactNode; className?: string }) {
  return (
    <header className={`${className} h-14 shrink-0 items-center gap-2 border-b border-[var(--md-outline-soft)] px-4`}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      <UnitsControl />
      <ThemeToggle />
    </header>
  );
}
