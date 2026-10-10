'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Navigation } from './Navigation';
import { AccountProvider } from './Account';
import { TimesProvider } from './TimesControl';
import { UnitsProvider } from './UnitsControl';

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const desk = pathname === '/decide' || pathname === '/earth';
  const training = pathname === '/train' || pathname === '/e6b' || pathname === '/historical' || pathname === '/history';
  const isMap = pathname === '/' || pathname === '/history' || pathname === '/historical';
  return (
    <AccountProvider>
      <UnitsProvider>
        <TimesProvider>
          <a href="#main-content" className="fixed left-3 top-3 z-[100] -translate-y-20 rounded-md bg-[var(--md-primary)] px-4 py-2 font-medium text-[var(--md-on-primary)] focus:translate-y-0">
            Skip to main content
          </a>
          {!isMap && !desk ? <Navigation /> : null}
          <div data-map-shell={isMap ? 'true' : undefined} className={`flex flex-col ${isMap ? 'map-shell' : desk ? '' : 'pb-tabbar pl-rail'} ${training || desk ? 'h-[100dvh] min-h-0' : 'min-h-[100svh]'}`}>
            <main id="main-content" tabIndex={-1} className="flex min-h-0 flex-1 flex-col">
              {children}
            </main>
          </div>
        </TimesProvider>
      </UnitsProvider>
    </AccountProvider>
  );
}
