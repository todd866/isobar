'use client';

import { useEffect, useState } from 'react';
import { setPref } from '@/lib/account/local';

export function ThemeToggle() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    setDark(root.classList.contains('dark'));
    // A synced theme from another device changes the class.
    const observer = new MutationObserver(() => setDark(root.classList.contains('dark')));
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  function apply(next: boolean) {
    document.documentElement.classList.toggle('dark', next);
    setPref('theme', next ? 'dark' : 'light');
    setDark(next);
  }

  return (
    <button
      type="button"
      aria-label={dark ? 'Light' : 'Dark'}
      aria-pressed={dark}
      title={dark ? 'Light' : 'Dark'}
      onClick={() => apply(!dark)}
      className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]"
    >
      {dark ? (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z" />
        </svg>
      )}
    </button>
  );
}
