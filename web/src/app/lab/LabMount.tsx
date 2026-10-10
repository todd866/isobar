'use client';

import { useEffect, useRef } from 'react';
import { labPreview, mountLab } from '../../../../training/src/instruments/lab.ts';

/** The teaching instruments (wind triangle, altimetry, interpolation, balance, profile, E6-B).
 * The instrument sizes itself to this box, so the box has a definite height. */
export function LabMount() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const params = new URLSearchParams(location.search);
    const preview = labPreview(params);
    const lab = mountLab(node, {
      instrument: preview.labInstrument,
      mode: preview.labMode,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    });
    const observer = new MutationObserver(() => lab.setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => {
      observer.disconnect();
      lab.destroy();
    };
  }, []);
  return <div ref={host} className="min-h-0 w-full min-w-0 flex-1" />;
}
