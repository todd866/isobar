'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function AboutBack() {
  const router = useRouter();
  const back = () => { if (window.history.length > 1) router.back(); else router.push('/'); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); back(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  return <button type="button" aria-label="Back" onClick={back} className="min-h-9 min-w-9 text-xl">←</button>;
}
